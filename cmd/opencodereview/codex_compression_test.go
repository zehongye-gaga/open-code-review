// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/alibaba/open-code-review/internal/config/template"
	"github.com/alibaba/open-code-review/internal/llm"
	"github.com/alibaba/open-code-review/internal/llmloop"
	"github.com/alibaba/open-code-review/internal/session"
	"github.com/alibaba/open-code-review/internal/tool"
)

type codexCompressionTool struct{}

func (codexCompressionTool) Tool() tool.Tool { return tool.FileRead }
func (codexCompressionTool) Execute(_ context.Context, args map[string]any) (string, error) {
	if args["large"] == true {
		return strings.Repeat("large file contents\n", 3000), nil
	}
	return "small file contents", nil
}

func TestCodexCompressionKeepsAPIConversationContract(t *testing.T) {
	var apiInput any
	for _, protocol := range []string{llm.ProtocolOpenAIResponses, llm.ProtocolOpenAICodex} {
		t.Run(protocol, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("USERPROFILE", home)
			t.Setenv("CODEX_HOME", home)
			if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"tokens":{"access_token":"fake"}}`), 0600); err != nil {
				t.Fatal(err)
			}
			var mainCalls, compressions int
			var finalInput any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req map[string]any
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					t.Error(err)
					return
				}
				var output []any
				if strings.Contains(fmt.Sprint(req["instructions"]), "conversation summarization") {
					compressions++
					output = []any{map[string]any{"id": "summary", "type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "Compressed context: large file inspected."}}}}
				} else {
					mainCalls++
					name, args := "file_read", `{"large":true}`
					if mainCalls == 2 {
						args = `{"large":false}`
					}
					if mainCalls >= 3 {
						name, args = "task_done", `{"state":"DONE"}`
						finalInput = req["input"]
					}
					output = []any{map[string]any{"id": fmt.Sprint("rs", mainCalls), "type": "reasoning", "summary": []any{}, "encrypted_content": fmt.Sprint("opaque-", mainCalls)}, map[string]any{"id": fmt.Sprint("fc", mainCalls), "type": "function_call", "call_id": fmt.Sprint("c", mainCalls), "name": name, "arguments": args}}
				}
				resp := map[string]any{"id": "r", "model": "test-model", "status": "completed", "output": output, "usage": map[string]any{"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}}
				if protocol == llm.ProtocolOpenAIResponses {
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(resp)
				} else {
					w.Header().Set("Content-Type", "text/event-stream")
					raw, _ := json.Marshal(map[string]any{"type": "response.completed", "response": resp})
					_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
				}
			}))
			defer server.Close()
			endpoint := server.URL
			if protocol == llm.ProtocolOpenAICodex {
				endpoint = ""
				target, _ := url.Parse(server.URL)
				old := http.DefaultTransport
				http.DefaultTransport = codexParityTransport{target: target, next: old}
				defer func() { http.DefaultTransport = old }()
			}
			client := llm.NewLLMClient(llm.ResolvedEndpoint{Protocol: protocol, URL: endpoint, Model: "test-model"}, nil, nil)
			tpl, err := template.LoadDefault()
			if err != nil {
				t.Fatal(err)
			}
			tpl.MaxTokens = 1000
			tpl.MaxToolRequestTimes = 5
			registry := tool.NewRegistry()
			registry.Register(codexCompressionTool{})
			registry.Freeze()
			sh := session.New(t.TempDir(), "", "test-model", session.SessionOptions{})
			defer sh.Finalize()
			runner := llmloop.NewRunner(llmloop.Deps{LLMClient: client, Model: "test-model", Template: *tpl, Session: sh, Tools: registry, MainToolDefs: []llm.ToolDef{{Type: "function", Function: llm.FunctionDef{Name: "file_read", Parameters: map[string]any{"type": "object"}}}, {Type: "function", Function: llm.FunctionDef{Name: "task_done", Parameters: map[string]any{"type": "object"}}}}})
			done, stop, err := runner.RunMainTask(context.Background(), []llm.Message{llm.NewTextMessage("system", "Review"), llm.NewTextMessage("user", "Inspect files")}, "file.go")
			runner.WaitBackground()
			if err != nil || !done || stop != llmloop.StopNone || mainCalls != 3 || compressions != 1 {
				t.Fatalf("done=%v stop=%v main=%d compression=%d error=%v", done, stop, mainCalls, compressions, err)
			}
			raw, _ := json.Marshal(finalInput)
			for _, part := range []string{"Compressed context", "opaque-2", "function_call_output", "small file contents"} {
				if !strings.Contains(string(raw), part) {
					t.Fatalf("post-compression history lost %s: %s", part, raw)
				}
			}
			if strings.Contains(string(raw), "opaque-1") {
				t.Fatal("compressed native turn was replayed")
			}
			if protocol == llm.ProtocolOpenAIResponses {
				apiInput = finalInput
			} else if !reflect.DeepEqual(apiInput, finalInput) {
				t.Fatal("post-compression history differs from API")
			}
		})
	}
}
