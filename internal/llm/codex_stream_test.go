// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestCodexStreamReconstructsOrderedOutput(t *testing.T) {
	state := newCodexStream()
	events := []string{
		`{"type":"response.created","response":{"id":"r1"}}`,
		`{"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"f1","call_id":"c1","name":"file_read","arguments":"","status":"in_progress"}}`,
		`{"type":"response.function_call_arguments.delta","item_id":"f1","delta":"{\"path\":"}`,
		`{"type":"response.function_call_arguments.delta","item_id":"f1","delta":"\"a.go\"}"}`,
		`{"type":"response.function_call_arguments.done","item_id":"f1","arguments":"{\"path\":\"a.go\"}"}`,
		`{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs1","encrypted_content":"partial","summary":[]}}`,
		`{"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs1","encrypted_content":"complete","summary":[]}}`,
		`{"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"m1","role":"assistant","phase":"commentary","content":[]}}`,
		`{"type":"response.output_text.delta","item_id":"m1","content_index":0,"delta":"Checking"}`,
		`{"type":"response.output_text.done","item_id":"m1","content_index":0,"text":"Checking files."}`,
		`{"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}`,
	}
	for i, event := range events {
		done, err := state.add([]byte(event))
		if err != nil || done != (i == len(events)-1) {
			t.Fatalf("event %d: done=%v err=%v", i, done, err)
		}
	}
	resp, err := state.response("test-model")
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Output) != 3 || resp.Output[0].Type != "reasoning" || resp.Output[1].Type != "message" || resp.Output[2].Type != "function_call" {
		t.Fatalf("output order: %+v", resp.Output)
	}
	chat := mapCodexResponse(resp)
	if chat.VisibleContent() != "" || chat.ReasoningContent() != "Checking files." {
		t.Fatalf("commentary reached final content: %+v", chat.Choices)
	}
	if chat.ToolCalls()[0].ID != "c1" || chat.ToolCalls()[0].Function.Arguments != `{"path":"a.go"}` || chat.Model != "test-model" || chat.Usage.TotalTokens != 12 {
		t.Fatalf("reconstruction: %+v", chat)
	}
	encoded, _ := json.Marshal(chat.Native())
	if !strings.Contains(string(encoded), "complete") || strings.Contains(string(encoded), "partial") || !strings.Contains(string(encoded), "commentary") {
		t.Fatalf("native replay lost final reasoning/phase: %s", encoded)
	}
}

func TestCodexStreamTextRefusalAndEmptyToolArguments(t *testing.T) {
	for _, tc := range []struct {
		name            string
		events          []string
		text, arguments string
	}{
		{"text without added", []string{
			`{"type":"response.output_text.delta","item_id":"m","content_index":1,"delta":"second"}`,
			`{"type":"response.output_text.delta","item_id":"m","content_index":0,"delta":"first "}`,
		}, "first second", ""},
		{"refusal", []string{
			`{"type":"response.refusal.delta","item_id":"m","delta":"Cannot"}`,
			`{"type":"response.refusal.done","item_id":"m","refusal":"Cannot answer."}`,
		}, "Cannot answer.", ""},
		{"empty tool", []string{`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"f","call_id":"c","name":"approve_all_comments","arguments":""}}`}, "", "{}"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newCodexStream()
			for _, event := range append(tc.events, `{"type":"response.completed","response":{"output":null}}`) {
				if _, err := s.add([]byte(event)); err != nil {
					t.Fatal(err)
				}
			}
			r, err := s.response("m")
			if err != nil {
				t.Fatal(err)
			}
			chat := mapCodexResponse(r)
			if chat.VisibleContent() != tc.text {
				t.Fatalf("content = %s", chat.VisibleContent())
			}
			if tc.arguments != "" && chat.ToolCalls()[0].Function.Arguments != tc.arguments {
				t.Fatalf("arguments = %s", chat.ToolCalls()[0].Function.Arguments)
			}
		})
	}
}

func TestCodexStreamRejectsCorruption(t *testing.T) {
	for name, events := range map[string][]string{
		"bad JSON":                {`{`},
		"no identity":             {`{"type":"response.output_item.done","item":{"type":"message"}}`},
		"negative index":          {`{"type":"response.output_item.done","output_index":-1,"item":{"id":"a"}}`},
		"conflicting identity":    {`{"type":"response.output_item.done","item_id":"b","item":{"id":"a"}}`},
		"index reassigned":        {`{"type":"response.output_item.added","output_index":0,"item":{"id":"a"}}`, `{"type":"response.output_item.done","output_index":0,"item":{"id":"b"}}`},
		"id moved":                {`{"type":"response.output_item.added","output_index":0,"item":{"id":"a"}}`, `{"type":"response.output_item.done","output_index":1,"item":{"id":"a"}}`},
		"different items collide": {`{"type":"response.output_item.added","output_index":0,"item":{"id":"a"}}`, `{"type":"response.output_item.added","output_index":1,"item":{"id":"b"}}`, `{"type":"response.output_item.done","output_index":1,"item":{"id":"a"}}`},
		"call id changed":         {`{"type":"response.output_item.added","item":{"id":"a","call_id":"c1"}}`, `{"type":"response.output_item.done","item":{"id":"a","call_id":"c2"}}`},
		"non-completed status":    {`{"type":"response.completed","response":{"status":"incomplete"}}`},
		"invalid output":          {`{"type":"response.completed","response":{"output":{}}}`},
		"empty output":            {`{"type":"response.completed"}`},
		"no terminal":             {`{"type":"response.created"}`},
		"unfinished reasoning":    {`{"type":"response.output_item.added","item":{"id":"r","type":"reasoning","encrypted_content":"partial"}}`, `{"type":"response.completed","response":{}}`},
		"duplicate calls":         {`{"type":"response.completed","response":{"output":[{"id":"a","type":"function_call","call_id":"c","name":"f","arguments":"{}"},{"id":"b","type":"function_call","call_id":"c","name":"g","arguments":"{}"}]}}`},
		"broken args":             {`{"type":"response.output_item.added","item":{"id":"a","type":"function_call","call_id":"c","name":"f","arguments":"{broken"}}`, `{"type":"response.completed","response":{}}`},
		"null args":               {`{"type":"response.output_item.added","item":{"id":"a","type":"function_call","call_id":"c","name":"f","arguments":"null"}}`, `{"type":"response.completed","response":{}}`},
	} {
		t.Run(name, func(t *testing.T) {
			s := newCodexStream()
			var err error
			for _, event := range events {
				if _, err = s.add([]byte(event)); err != nil {
					break
				}
			}
			if err == nil {
				_, err = s.response("m")
			}
			if err == nil {
				t.Fatal("corrupt stream accepted")
			}
		})
	}
}

func TestCodexCompletedArgumentsUseHarnessRepair(t *testing.T) {
	for _, arguments := range []string{`null`, `{"comments":[]} trailing text`, `{invalid`} {
		t.Run(arguments, func(t *testing.T) {
			state := newCodexStream()
			raw, _ := json.Marshal(map[string]any{"type": "response.completed", "response": map[string]any{"output": []any{map[string]any{"id": "f", "type": "function_call", "call_id": "c", "name": "code_comment", "arguments": arguments}}}})
			if _, err := state.add(raw); err != nil {
				t.Fatal(err)
			}
			resp, err := state.response("m")
			if err != nil {
				t.Fatal(err)
			}
			if got := mapCodexResponse(resp).ToolCalls()[0].Function.Arguments; got != arguments {
				t.Fatalf("arguments changed before harness validation: %q", got)
			}
		})
	}
}

func TestCodexStreamExtendsInitialMessageContent(t *testing.T) {
	for _, finished := range []bool{false, true} {
		t.Run(fmt.Sprint(finished), func(t *testing.T) {
			s := newCodexStream()
			events := []string{
				`{"type":"response.output_item.added","output_index":0,"item":{"id":"m","type":"message","role":"assistant","content":[{"type":"output_text","text":"Initial ","annotations":[]},{"type":"output_text","text":" Neighbor."}]}}`,
				`{"type":"response.output_text.delta","item_id":"m","content_index":0,"delta":"delta."}`,
			}
			if finished {
				events = append(events, `{"type":"response.output_item.done","output_index":0,"item":{"id":"m","type":"message","role":"assistant","content":[{"type":"output_text","text":"Authoritative final."}]}}`)
			}
			for _, event := range append(events, `{"type":"response.completed","response":{"output":null}}`) {
				if _, err := s.add([]byte(event)); err != nil {
					t.Fatal(err)
				}
			}
			resp, err := s.response("m")
			if err != nil {
				t.Fatal(err)
			}
			want := "Initial delta. Neighbor."
			if finished {
				want = "Authoritative final."
			}
			if got := mapCodexResponse(resp).VisibleContent(); got != want {
				t.Fatalf("content = %q, want %q", got, want)
			}
		})
	}
	if _, err := newCodexStream().add([]byte(`{"type":"response.output_text.delta","item_id":"m","content_index":-1,"delta":"invalid"}`)); err == nil {
		t.Fatal("negative content index accepted")
	}
}
