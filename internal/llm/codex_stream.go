// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/openai/openai-go/v3/responses"
)

type codexStreamEvent struct {
	Type         string                     `json:"type"`
	ItemID       string                     `json:"item_id"`
	OutputIndex  *int                       `json:"output_index"`
	ContentIndex int                        `json:"content_index"`
	Delta        string                     `json:"delta"`
	Arguments    *string                    `json:"arguments"`
	Text         string                     `json:"text"`
	Refusal      string                     `json:"refusal"`
	Item         map[string]json.RawMessage `json:"item"`
	Response     map[string]json.RawMessage `json:"response"`
}

type codexStreamItem struct {
	index     *int
	finished  bool
	fields    map[string]json.RawMessage
	arguments string
	parts     map[int]map[string]string
}

type codexStream struct {
	items    []*codexStreamItem
	byID     map[string]*codexStreamItem
	byIndex  map[int]*codexStreamItem
	terminal map[string]json.RawMessage
}

func newCodexStream() *codexStream {
	return &codexStream{byID: map[string]*codexStreamItem{}, byIndex: map[int]*codexStreamItem{}}
}

func rawString(raw json.RawMessage) string {
	var s string
	_ = json.Unmarshal(raw, &s)
	return s
}

func setCodexField(fields map[string]json.RawMessage, key string, value any) {
	fields[key], _ = json.Marshal(value)
}

func (s *codexStream) item(event codexStreamEvent) (*codexStreamItem, error) {
	id := event.ItemID
	if itemID := rawString(event.Item["id"]); id != "" && itemID != "" && itemID != id {
		return nil, &streamIntegrityError{reason: "contained conflicting output item identities"}
	}
	if id == "" {
		id = rawString(event.Item["id"])
	}
	item := s.byID[id]
	if event.OutputIndex != nil {
		if *event.OutputIndex < 0 {
			return nil, &streamIntegrityError{reason: "contained a negative output index"}
		}
		if indexed := s.byIndex[*event.OutputIndex]; indexed != nil {
			if item != nil && item != indexed {
				return nil, &streamIntegrityError{reason: "contained conflicting output item identities"}
			}
			item = indexed
		}
	}
	if item == nil {
		if id == "" && event.OutputIndex == nil {
			return nil, &streamIntegrityError{reason: "contained an output item without an identity"}
		}
		item = &codexStreamItem{fields: map[string]json.RawMessage{}, parts: map[int]map[string]string{}}
		s.items = append(s.items, item)
	}
	if event.OutputIndex != nil {
		if item.index != nil && *item.index != *event.OutputIndex {
			return nil, &streamIntegrityError{reason: "changed an output item's index"}
		}
		item.index = event.OutputIndex
		s.byIndex[*event.OutputIndex] = item
	}
	if id != "" {
		if oldID := rawString(item.fields["id"]); oldID != "" && oldID != id {
			return nil, &streamIntegrityError{reason: "contained conflicting output item identities"}
		}
		setCodexField(item.fields, "id", id)
		s.byID[id] = item
	}
	return item, nil
}

func (s *codexStream) add(raw []byte) (bool, error) {
	var event codexStreamEvent
	if err := json.Unmarshal(raw, &event); err != nil {
		return false, &streamIntegrityError{reason: "contained invalid event JSON"}
	}
	switch event.Type {
	case "response.failed", "response.incomplete", "response.cancelled", "error":
		return false, &streamIntegrityError{reason: fmt.Sprintf("did not complete (%s)", event.Type)}
	case "response.completed":
		status := rawString(event.Response["status"])
		if status != "" && status != "completed" {
			return false, &streamIntegrityError{reason: "contained a non-completed terminal response"}
		}
		if event.Response == nil {
			event.Response = map[string]json.RawMessage{}
		}
		s.terminal = event.Response
		var output []map[string]json.RawMessage
		if raw := event.Response["output"]; len(raw) > 0 && json.Unmarshal(raw, &output) != nil {
			return false, &streamIntegrityError{reason: "contained invalid terminal output"}
		}
		for i, fields := range output {
			if err := s.mergeItem(codexStreamEvent{Item: fields, OutputIndex: &i}); err != nil {
				return false, err
			}
		}
		return true, nil
	case "response.output_item.added", "response.output_item.done":
		return false, s.mergeItem(event)
	case "response.function_call_arguments.delta", "response.function_call_arguments.done":
		item, err := s.item(event)
		if err != nil {
			return false, err
		}
		if event.Arguments != nil {
			item.arguments = *event.Arguments
		} else {
			item.arguments += event.Delta
		}
		setCodexField(item.fields, "arguments", item.arguments)
	case "response.output_text.delta", "response.output_text.done", "response.refusal.delta", "response.refusal.done":
		if event.ContentIndex < 0 {
			return false, &streamIntegrityError{reason: "contained a negative content index"}
		}
		item, err := s.item(event)
		if err != nil {
			return false, err
		}
		part := item.parts[event.ContentIndex]
		if part == nil {
			part = map[string]string{"type": "output_text"}
			var content []map[string]json.RawMessage
			_ = json.Unmarshal(item.fields["content"], &content)
			if event.ContentIndex < len(content) {
				for _, key := range []string{"type", "text", "refusal"} {
					if value := rawString(content[event.ContentIndex][key]); value != "" {
						part[key] = value
					}
				}
			}
			item.parts[event.ContentIndex] = part
		}
		switch event.Type {
		case "response.output_text.delta":
			part["text"] += event.Delta
		case "response.output_text.done":
			part["text"] = event.Text
		case "response.refusal.delta":
			part["type"] = "refusal"
			part["refusal"] += event.Delta
		case "response.refusal.done":
			part["type"] = "refusal"
			part["refusal"] = event.Refusal
		}
	}
	return false, nil
}

func (s *codexStream) mergeItem(event codexStreamEvent) error {
	item, err := s.item(event)
	if err != nil {
		return err
	}
	oldCall, newCall := rawString(item.fields["call_id"]), rawString(event.Item["call_id"])
	if oldCall != "" && newCall != "" && oldCall != newCall {
		return &streamIntegrityError{reason: "contained conflicting tool call identities"}
	}
	for key, value := range event.Item {
		item.fields[key] = value
	}
	if event.Type != "response.output_item.added" {
		item.finished = true
	}
	if value, ok := event.Item["arguments"]; ok {
		item.arguments = rawString(value)
	}
	return nil
}

func (s *codexStream) response(model string) (*responses.Response, error) {
	if s.terminal == nil {
		return nil, &streamIntegrityError{reason: "ended before response.completed"}
	}
	allIndexed := true
	for _, item := range s.items {
		allIndexed = allIndexed && item.index != nil
	}
	if allIndexed {
		sort.SliceStable(s.items, func(i, j int) bool { return *s.items[i].index < *s.items[j].index })
	}
	output := make([]map[string]json.RawMessage, 0, len(s.items))
	calls := map[string]bool{}
	for _, item := range s.items {
		kind := rawString(item.fields["type"])
		if kind == "" && len(item.parts) > 0 {
			kind = "message"
			setCodexField(item.fields, "type", kind)
			setCodexField(item.fields, "role", "assistant")
		}
		switch kind {
		case "reasoning":
			if !item.finished {
				return nil, &streamIntegrityError{reason: "ended with unfinished reasoning replay data"}
			}
		case "function_call":
			id := rawString(item.fields["call_id"])
			if item.arguments == "" {
				item.arguments = "{}"
			}
			if id == "" || calls[id] || rawString(item.fields["name"]) == "" {
				return nil, &streamIntegrityError{reason: "contained an invalid or duplicate function call"}
			}
			// Completed calls use the harness's argument repair/error feedback,
			// just like API responses. Only reconstructed deltas need proof that
			// an incomplete argument fragment is not being dispatched.
			if !item.finished {
				var arguments map[string]json.RawMessage
				if json.Unmarshal([]byte(item.arguments), &arguments) != nil || arguments == nil {
					return nil, &streamIntegrityError{reason: "ended with incomplete function arguments"}
				}
			}
			calls[id] = true
			setCodexField(item.fields, "arguments", item.arguments)
		case "message":
			var content []map[string]json.RawMessage
			_ = json.Unmarshal(item.fields["content"], &content)
			if len(item.parts) > 0 && (!item.finished || len(content) == 0) {
				merged := map[int]map[string]json.RawMessage{}
				for i, part := range content {
					merged[i] = part
				}
				for i, part := range item.parts {
					if merged[i] == nil {
						merged[i] = map[string]json.RawMessage{}
					}
					for key, value := range part {
						setCodexField(merged[i], key, value)
					}
				}
				indices := make([]int, 0, len(merged))
				for i := range merged {
					indices = append(indices, i)
				}
				sort.Ints(indices)
				parts := make([]map[string]json.RawMessage, 0, len(indices))
				for _, i := range indices {
					parts = append(parts, merged[i])
				}
				setCodexField(item.fields, "content", parts)
			}
		}
		if rawString(item.fields["status"]) == "in_progress" {
			setCodexField(item.fields, "status", "completed")
		}
		output = append(output, item.fields)
	}
	if len(output) == 0 {
		return nil, &streamIntegrityError{reason: "completed without output"}
	}
	setCodexField(s.terminal, "output", output)
	setCodexField(s.terminal, "status", "completed")
	if rawString(s.terminal["model"]) == "" {
		setCodexField(s.terminal, "model", model)
	}
	raw, err := json.Marshal(s.terminal)
	if err != nil {
		return nil, err
	}
	var response responses.Response
	if err := json.Unmarshal(raw, &response); err != nil {
		return nil, fmt.Errorf("decode Codex response: %w", err)
	}
	return &response, nil
}
