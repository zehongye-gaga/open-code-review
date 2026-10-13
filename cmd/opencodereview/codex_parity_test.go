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
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/alibaba/open-code-review/internal/session"
)

type codexParityTransport struct {
	target *url.URL
	next   http.RoundTripper
}

func (p codexParityTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host != "chatgpt.com" || r.URL.Path != "/backend-api/codex/responses" {
		return nil, fmt.Errorf("unexpected subscription request: %s", r.URL.Redacted())
	}
	copy := r.Clone(r.Context())
	u := *r.URL
	copy.URL = &u
	copy.URL.Scheme, copy.URL.Host, copy.URL.Path = p.target.Scheme, p.target.Host, "/responses"
	return p.next.RoundTrip(copy)
}

// Both protocols receive the same model decisions; only HTTP framing differs.
type codexParityModel struct {
	t        *testing.T
	mu       sync.Mutex
	stream   bool
	stages   []string
	results  []string
	finished map[string]bool
}

func (m *codexParityModel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var req struct {
		Instructions string           `json:"instructions"`
		Input        []map[string]any `json:"input"`
		Stream       bool             `json:"stream"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		m.t.Error(err)
		return
	}
	if req.Stream != m.stream {
		m.t.Errorf("stream = %v", req.Stream)
	}
	raw, _ := json.Marshal(req.Input)
	input := string(raw)
	if strings.Contains(input, "IGNORED_SENTINEL") {
		m.t.Error("excluded file reached model context")
	}
	path := "a.go"
	for _, name := range []string{"a", "b", "c", "d"} {
		if strings.Contains(input, "Value"+strings.ToUpper(name)+"0") {
			path = name + ".go"
			break
		}
	}
	for _, item := range req.Input {
		if content, ok := item["content"].(string); ok {
			if match := regexp.MustCompile(`<current_file_path>([^<]+)</current_file_path>`).FindStringSubmatch(content); len(match) > 1 {
				path = match[1]
				break
			}
		}
	}
	var outputs []any
	textReply := func(text string) {
		outputs = append(outputs, map[string]any{"type": "message", "id": "m", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": text}}})
	}
	toolReply := func(name string, args any) {
		data, _ := json.Marshal(args)
		outputs = append(outputs, map[string]any{"type": "reasoning", "id": "rs", "encrypted_content": "opaque-state", "summary": []any{}}, map[string]any{"type": "function_call", "id": "fc", "call_id": fmt.Sprintf("call_%d", len(m.stages)), "name": name, "arguments": string(data)})
	}
	stage := ""
	switch {
	case strings.Contains(req.Instructions, groupingSystemPrompt):
		stage = "grouping"
		textReply(`[{"label":"AB","files":[0,1]},{"label":"CD","files":[2,3]}]`)
	case strings.Contains(req.Instructions, "code location assistant"):
		if match := regexp.MustCompile(`Verify ([a-d]\.go)`).FindStringSubmatch(input); len(match) > 1 {
			path = match[1]
		}
		stage = "relocation"
		textReply(fmt.Sprintf("```go\nvar Value%s0 = 1\n```", strings.ToUpper(path[:1])))
	case strings.Contains(req.Instructions, "fact-checker"):
		stage = "filter"
		toolReply("approve_all_comments", map[string]any{})
	case strings.Contains(req.Instructions, "conversation summarization"):
		stage = "compression"
		textReply("Files inspected. Continue with code_comment and task_done.")
	case strings.Contains(req.Instructions, "near-duplicate"):
		stage = "dedup"
		textReply(`{"groups":[{"members":["c-0"]},{"members":["c-1"]},{"members":["c-2"]},{"members":["c-3"]}]}`)
	case strings.Contains(req.Instructions, "project-level summary"):
		stage = "summary"
		textReply("### Top Issues\nCheck changed values across related files.")
	case strings.Contains(req.Instructions, "review planner"):
		stage = "plan"
		textReply(`{"summary":"Inspect changed values","checkpoints":[{"focus":"correctness","why":"Values cross file boundaries"}]}`)
	case strings.Contains(req.Instructions, "task planning"):
		stage = "plan"
		textReply("Summary: Inspect cross-file values.\n\nIssues\n\n1. [high] Verify related constants.")
	default:
		count := 0
		for _, item := range req.Input {
			if item["type"] == "function_call_output" {
				count++
				output, _ := item["output"].(string)
				m.results = append(m.results, output)
				if count == 1 && !strings.Contains(output, "File: ") {
					m.t.Errorf("file_read did not execute: %s", output)
				}
			}
		}
		switch {
		case m.finished[path]:
			stage = "review-round2"
			toolReply("task_done", map[string]any{"state": "DONE"})
		case count == 0:
			stage = "read"
			sibling := "b.go"
			if path == "c.go" || path == "d.go" {
				sibling = "d.go"
			}
			toolReply("file_read", map[string]any{"file_path": sibling})
		case count == 1:
			stage = "comment"
			toolReply("code_comment", map[string]any{"comments": []any{map[string]any{"path": path, "content": "Verify " + path + " cross-file compatibility of changed values.", "existing_code": "unmatched_original_snippet", "category": "bug", "severity": "high"}}})
		default:
			stage = "done"
			toolReply("task_done", map[string]any{"state": "DONE"})
			m.finished[path] = true
		}
	}
	m.stages = append(m.stages, stage)
	response := map[string]any{"id": "r", "model": "parity-model", "status": "completed", "output": outputs, "usage": map[string]any{"input_tokens": 100, "output_tokens": 10, "total_tokens": 110, "input_tokens_details": map[string]any{"cached_tokens": 25}}}
	if !m.stream {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	for i, item := range outputs {
		data, _ := json.Marshal(map[string]any{"type": "response.output_item.done", "output_index": i, "item": item})
		_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
	}
	response["output"] = nil
	data, _ := json.Marshal(map[string]any{"type": "response.completed", "response": response})
	_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
}

func codexParityRepo(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	retryTestGit(t, dir, "init")
	for value := 0; value < 2; value++ {
		for _, name := range []string{"a", "b", "c", "d"} {
			var src strings.Builder
			src.WriteString("package fixture\n\n")
			for i := 0; i < 40; i++ {
				fmt.Fprintf(&src, "var Value%s%d = %d\n", strings.ToUpper(name), i, value)
			}
			if err := os.WriteFile(filepath.Join(dir, name+".go"), []byte(src.String()), 0600); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(filepath.Join(dir, "ignored.go"), []byte(fmt.Sprintf("package fixture\nvar IGNORED_SENTINEL = %d\n", value)), 0600); err != nil {
			t.Fatal(err)
		}
		retryTestGit(t, dir, "add", ".")
		retryTestGit(t, dir, "commit", "-m", fmt.Sprint(value))
	}
	return dir
}

func TestCodexReviewAndScanMatchNativeAPIHarness(t *testing.T) {
	repo := codexParityRepo(t)
	for _, mode := range []string{"review", "scan"} {
		t.Run(mode, func(t *testing.T) {
			var baseline jsonOutput
			var expectedStages, expectedResults []string
			for _, protocol := range []string{"openai-responses", "openai-codex"} {
				t.Run(protocol, func(t *testing.T) {
					home := t.TempDir()
					t.Setenv("HOME", home)
					t.Setenv("USERPROFILE", home)
					codexHome := t.TempDir()
					t.Setenv("CODEX_HOME", codexHome)
					if err := os.WriteFile(filepath.Join(codexHome, "auth.json"), []byte(`{"auth_mode":"chatgpt","tokens":{"access_token":"test-token","account_id":"test-account"}}`), 0600); err != nil {
						t.Fatal(err)
					}
					fake := &codexParityModel{t: t, stream: protocol == "openai-codex", finished: map[string]bool{}}
					server := httptest.NewServer(fake)
					defer server.Close()
					endpoint := server.URL
					if fake.stream {
						endpoint = ""
						target, _ := url.Parse(server.URL)
						original := http.DefaultTransport
						http.DefaultTransport = codexParityTransport{target: target, next: original}
						defer func() { http.DefaultTransport = original }()
					}
					t.Setenv("OCR_LLM_PROTOCOL", protocol)
					t.Setenv("OCR_LLM_URL", endpoint)
					t.Setenv("OCR_LLM_TOKEN", "test-token")
					t.Setenv("OCR_LLM_MODEL", "parity-model")
					t.Setenv("OCR_LLM_EXTRA_HEADERS", "")
					t.Setenv("OCR_LLM_TIMEOUT", "10")
					var runErr error
					run := func(resume string) string {
						return captureStdout(t, func() {
							if mode == "review" {
								runErr = executeReviewContext(context.Background(), reviewOptions{repoDir: repo, from: "HEAD~1", to: "HEAD", outputFormat: "json", audience: "agent", concurrency: 1, concurrentTaskTimeout: 1, excludes: "ignored.go", resume: resume})
							} else {
								runErr = executeScan(scanOptions{repoDir: repo, outputFormat: "json", audience: "agent", concurrency: 1, concurrentTaskTimeout: 1, excludes: "ignored.go", resume: resume})
							}
						})
					}
					out := run("")
					if runErr != nil {
						t.Fatalf("%s: %v\n%s", mode, runErr, out)
					}
					var result jsonOutput
					if err := json.Unmarshal([]byte(out), &result); err != nil {
						t.Fatalf("decode: %v\n%s", err, out)
					}
					wantComments := 2
					if mode == "scan" {
						wantComments = 4
					}
					wantStatus := "complete"
					if mode == "scan" {
						wantStatus = "success"
					}
					if result.Status != wantStatus || len(result.Comments) != wantComments || result.Summary.FilesReviewed != 4 {
						t.Fatalf("unexpected result: %s", out)
					}
					for _, c := range result.Comments {
						if c.StartLine != 3 || c.EndLine != 3 {
							t.Fatalf("comment was not located: %+v", c)
						}
					}
					for _, stage := range []string{"plan", "read", "comment", "relocation", "done"} {
						if !containsStage(fake.stages, stage) {
							t.Errorf("missing %s: %v", stage, fake.stages)
						}
					}
					if mode == "review" {
						for _, stage := range []string{"grouping", "filter", "review-round2"} {
							if !containsStage(fake.stages, stage) {
								t.Errorf("missing %s: %v", stage, fake.stages)
							}
						}
					}
					dir, err := session.SessionsDir(repo)
					if err != nil {
						t.Fatal(err)
					}
					history, err := os.ReadFile(filepath.Join(dir, result.SessionID+".jsonl"))
					if err != nil {
						t.Fatal(err)
					}
					if !strings.Contains(string(history), "opaque-state") || !strings.Contains(string(history), "native_payload") {
						t.Fatal("native reasoning missing from persisted session")
					}
					if protocol == "openai-responses" {
						baseline = result
						expectedStages = append([]string(nil), fake.stages...)
						expectedResults = append([]string(nil), fake.results...)
					} else {
						if !reflect.DeepEqual(expectedStages, fake.stages) || !reflect.DeepEqual(expectedResults, fake.results) {
							t.Fatalf("harness diverged\nAPI: %v\nCodex: %v", expectedStages, fake.stages)
						}
						if !reflect.DeepEqual(baseline.Comments, result.Comments) || baseline.Summary.TotalTokens != result.Summary.TotalTokens || !reflect.DeepEqual(baseline.ToolCalls, result.ToolCalls) {
							t.Fatal("findings, tool execution, or token usage differs from API run")
						}
					}
					before := len(fake.stages)
					resumed := run(result.SessionID)
					if runErr != nil {
						t.Fatalf("resume: %v\n%s", runErr, resumed)
					}
					var resumeResult jsonOutput
					if err := json.Unmarshal([]byte(resumed), &resumeResult); err != nil {
						t.Fatal(err)
					}
					for _, stage := range fake.stages[before:] {
						if stage == "read" || stage == "comment" || stage == "review-round2" {
							t.Fatalf("completed item was reviewed on resume: %v", fake.stages[before:])
						}
					}
					if !reflect.DeepEqual(result.Comments, resumeResult.Comments) {
						t.Fatal("resume lost findings")
					}
				})
			}
		})
	}
}

func containsStage(stages []string, want string) bool {
	for _, stage := range stages {
		if stage == want {
			return true
		}
	}
	return false
}
