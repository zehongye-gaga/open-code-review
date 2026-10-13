// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	openaiopt "github.com/openai/openai-go/v3/option"
)

type codexCredentialsFunc func(context.Context, string) (codexCredentials, error)

func (f codexCredentialsFunc) credentials(ctx context.Context, rejected string) (codexCredentials, error) {
	return f(ctx, rejected)
}

func newCodexTestClient(t *testing.T, handler http.HandlerFunc, cfg ClientConfig, extra ...openaiopt.RequestOption) *CodexSubscriptionClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := NewCodexSubscriptionClient(cfg)
	wire := client.cfg
	wire.URL = server.URL + "/responses"
	opts := append([]openaiopt.RequestOption{openaiopt.WithMaxRetries(0)}, extra...)
	client.sdk = newResponsesSDK(wire, opts...)
	client.auth = codexCredentialsFunc(func(context.Context, string) (codexCredentials, error) {
		return codexCredentials{AccessToken: "test-access", AccountID: "acct-test"}, nil
	})
	return client
}

func writeCodexEvents(w http.ResponseWriter, events ...any) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, event := range events {
		raw, _ := json.Marshal(event)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
	}
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

func codexTerminal(body string) map[string]any {
	return map[string]any{"type": "response.completed", "response": json.RawMessage(body)}
}

func TestCodexClientWireContractAndHeaders(t *testing.T) {
	var body map[string]any
	var headers http.Header
	client := newCodexTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" {
			t.Errorf("path = %s", r.URL.Path)
		}
		headers = r.Header.Clone()
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		writeCodexEvents(w, codexTerminal(responsesOKBody))
	}, ClientConfig{
		Model: "model-default", APIKey: "must-not-use-api-key",
		ExtraHeaders: map[string]string{"Authorization": "must-not-use-header", "ChatGPT-Account-ID": "wrong-account", "X-Session": SessionKeyTemplateVar},
		ExtraBody:    map[string]any{"stream": false, "store": true, "max_output_tokens": 12, "temperature": 0.9, "top_p": 0.8, "previous_response_id": "old-response", "prompt_cache_key": SessionKeyTemplateVar},
	})
	temperature := 0.2
	resp, err := client.CompletionsWithCtx(ContextWithSessionKey(context.Background(), "session-fixed"), ChatRequest{
		Model: "model-override", Messages: []Message{NewTextMessage("system", "review carefully"), NewTextMessage("user", "review this")},
		Tools:      []ToolDef{{Type: "function", Function: FunctionDef{Name: "read_file", Parameters: map[string]any{"type": "object"}}}},
		ToolChoice: "required", MaxTokens: 123, Temperature: &temperature,
	})
	if err != nil || resp.Content() != "ok" {
		t.Fatalf("response: %v", err)
	}
	for key, want := range map[string]any{"stream": true, "store": false, "model": "model-override", "instructions": "review carefully", "tool_choice": "required", "prompt_cache_key": "session-fixed"} {
		if body[key] != want {
			t.Errorf("%s = %v, want %v", key, body[key], want)
		}
	}
	for _, key := range []string{"max_output_tokens", "max_tokens", "temperature", "top_p", "previous_response_id"} {
		if _, ok := body[key]; ok {
			t.Errorf("unsupported field %s reached the wire", key)
		}
	}
	for key, want := range map[string]string{"Authorization": "Bearer test-access", "ChatGPT-Account-ID": "acct-test", "originator": "open-code-review", "session_id": "session-fixed", "X-Session": "session-fixed"} {
		if headers.Get(key) != want {
			t.Errorf("%s = %s", key, headers.Get(key))
		}
	}
}

func TestCodexClientToolRoundTripMatchesResponsesAPI(t *testing.T) {
	first := `{"id":"r1","model":"m","status":"completed","output":[
		{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"summary"}],"encrypted_content":"opaque-reasoning"},
		{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{\"path\":\"a.go\"}"},
		{"type":"function_call","id":"fc_2","call_id":"call_2","name":"read_file","arguments":"{\"path\":\"b.go\"}"}],
		"usage":{"input_tokens":15,"output_tokens":7,"total_tokens":22,"input_tokens_details":{"cached_tokens":5}}}`
	var expectedInput, actualInput any
	makeHandler := func(stream bool, captured *any) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var request map[string]any
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			body := first
			input, _ := json.Marshal(request["input"])
			if strings.Contains(string(input), "function_call_output") {
				*captured = request["input"]
				body = responsesOKBody
			}
			if !stream {
				w.Header().Set("Content-Type", "application/json")
				_, _ = fmt.Fprint(w, body)
				return
			}
			var response map[string]any
			_ = json.Unmarshal([]byte(body), &response)
			var events []any
			for i, item := range response["output"].([]any) {
				events = append(events, map[string]any{"type": "response.output_item.done", "output_index": i, "item": item})
			}
			response["output"] = nil
			events = append(events, map[string]any{"type": "response.completed", "response": response})
			writeCodexEvents(w, events...)
		}
	}
	apiServer := httptest.NewServer(makeHandler(false, &expectedInput))
	defer apiServer.Close()
	api := NewOpenAIResponsesClient(ClientConfig{URL: apiServer.URL, Model: "m"})
	codex := newCodexTestClient(t, makeHandler(true, &actualInput), ClientConfig{Model: "m"})
	var results []*ChatResponse
	for _, client := range []LLMClient{api, codex} {
		req := ChatRequest{Messages: []Message{NewTextMessage("system", "review"), NewTextMessage("user", "inspect")}}
		resp, err := client.CompletionsWithCtx(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		results = append(results, resp)
		req.Messages = append(req.Messages, NewToolCallMessage(resp.VisibleContent(), resp.ToolCalls(), resp.Native(), resp.ReasoningContent()))
		for _, call := range resp.ToolCalls() {
			req.Messages = append(req.Messages, NewToolResultMessage(call.ID, "file contents"))
		}
		if _, err := client.CompletionsWithCtx(context.Background(), req); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(results[0].ToolCalls(), results[1].ToolCalls()) || !reflect.DeepEqual(results[0].Usage, results[1].Usage) || results[0].ReasoningContent() != results[1].ReasoningContent() {
		t.Fatal("Codex and Responses API did not produce equivalent responses")
	}
	if expectedInput == nil || !reflect.DeepEqual(expectedInput, actualInput) {
		t.Fatalf("tool/reasoning replay differs:\nAPI: %v\nCodex: %v", expectedInput, actualInput)
	}
}

func TestCodexClientRefreshes401OnceAndFinalizesOneRequest(t *testing.T) {
	for _, permanent := range []bool{false, true} {
		t.Run(fmt.Sprint(permanent), func(t *testing.T) {
			var requests, authCalls int
			collector := NewRetryCollector()
			meta := testMeta()
			client := newCodexTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				requests++
				if requests == 1 || permanent {
					w.WriteHeader(401)
					_, _ = fmt.Fprint(w, `{"error":{"message":"expired"}}`)
					return
				}
				if r.Header.Get("Authorization") != "Bearer fresh" {
					t.Error("did not use refreshed credentials")
				}
				writeCodexEvents(w, codexTerminal(responsesOKBody))
			}, ClientConfig{retryCollector: collector, RetryCodes: []int{401, 529}})
			client.auth = codexCredentialsFunc(func(ctx context.Context, rejected string) (codexCredentials, error) {
				authCalls++
				if authCalls == 1 {
					return codexCredentials{AccessToken: "expired"}, nil
				}
				if rejected != "expired" {
					t.Error("refresh did not identify rejected token")
				}
				return codexCredentials{AccessToken: "fresh"}, nil
			})
			_, err := ping(metaCtx(meta), client)
			if (err != nil) != permanent || requests != 2 || authCalls != 2 {
				t.Fatalf("requests/auth/error = %d/%d/%v", requests, authCalls, err)
			}
			report, err := collector.Freeze("run")
			if err != nil || report.TotalRequests != 1 || report.TotalRetries != 1 {
				t.Fatalf("retry report = %+v: %v", report, err)
			}
		})
	}
}

func TestCodexClientUsesExistingHTTPRetryAccounting(t *testing.T) {
	var requests atomic.Int32
	collector := NewRetryCollector()
	client := newCodexTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			w.Header().Set("retry-after-ms", "1")
			w.WriteHeader(429)
			_, _ = fmt.Fprint(w, `{"error":{"message":"slow down"}}`)
			return
		}
		writeCodexEvents(w, codexTerminal(responsesOKBody))
	}, ClientConfig{retryCollector: collector}, openaiopt.WithMaxRetries(5))
	meta := testMeta()
	if _, err := ping(metaCtx(meta), client); err != nil {
		t.Fatal(err)
	}
	attempts := attemptsFor(t, collector, meta)
	if len(attempts) != 2 || attempts[0].ErrorClass != ErrorClassRateLimited || attempts[1].Outcome != AttemptSuccess {
		t.Fatalf("attempts = %+v", attempts)
	}
	if _, err := collector.Freeze("run"); err != nil {
		t.Fatal(err)
	}
}

func TestCodexClientStreamFailuresAreNotSuccessfulReviews(t *testing.T) {
	for _, event := range []string{"response.failed", "response.incomplete", "response.cancelled", "error", "EOF", "reasoning-only", "commentary-only"} {
		t.Run(event, func(t *testing.T) {
			collector := NewRetryCollector()
			meta := testMeta()
			var requests int
			client := newCodexTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				requests++
				switch event {
				case "EOF":
					writeCodexEvents(w, map[string]any{"type": "response.output_text.delta", "item_id": "msg", "output_index": 0, "delta": "partial"})
				case "reasoning-only":
					writeCodexEvents(w, codexTerminal(`{"output":[{"type":"reasoning","summary":[],"encrypted_content":"opaque"}]}`))
				case "commentary-only":
					writeCodexEvents(w, codexTerminal(`{"output":[{"type":"message","phase":"commentary","role":"assistant","content":[{"type":"output_text","text":"thinking"}]}]}`))
				default:
					writeCodexEvents(w, map[string]any{"type": event, "response": map[string]any{"status": "failed"}, "message": "failure"})
				}
			}, ClientConfig{retryCollector: collector})
			resp, err := ping(metaCtx(meta), client)
			if err == nil || resp != nil || requests != 1 {
				t.Fatalf("partial stream accepted/replayed: %+v, %v, %d", resp, err, requests)
			}
			report, err := collector.Freeze("run")
			if err != nil || report.FailedRequests != 1 {
				t.Fatalf("report = %+v: %v", report, err)
			}
			attempts := attemptsFor(t, collector, meta)
			if len(attempts) != 1 || attempts[0].FailurePhase != FailurePhaseStream {
				t.Fatalf("attempts = %+v", attempts)
			}
		})
	}
}

func TestCodexClientCancellationAndTerminalWithoutEOF(t *testing.T) {
	for _, terminal := range []bool{false, true} {
		t.Run(fmt.Sprint(terminal), func(t *testing.T) {
			client := newCodexTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				if terminal {
					writeCodexEvents(w, codexTerminal(responsesOKBody))
				} else {
					writeCodexEvents(w, map[string]any{"type": "response.created"})
				}
				<-r.Context().Done()
			}, ClientConfig{})
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			resp, err := ping(ctx, client)
			if terminal {
				if err != nil || resp.Content() != "ok" {
					t.Fatalf("terminal response waited for EOF: %v", err)
				}
			} else if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestCodexRawLoggingRedactsAuthorization(t *testing.T) {
	writer := &recordingRawWriter{}
	holder := NewRawHolder()
	holder.Set(writer)
	client := newCodexTestClient(t, func(w http.ResponseWriter, r *http.Request) { writeCodexEvents(w, codexTerminal(responsesOKBody)) }, ClientConfig{rawHolder: holder})
	if _, err := ping(context.Background(), client); err != nil {
		t.Fatal(err)
	}
	rec := writer.one(t)
	raw, _ := json.Marshal(rec)
	if strings.Contains(string(raw), "test-access") || !strings.Contains(string(raw), "REDACTED") {
		t.Fatalf("authorization was not redacted: %s", raw)
	}
}

func TestCodexClientRejectsCredentialForwarding(t *testing.T) {
	client := NewCodexSubscriptionClient(ClientConfig{URL: "https://untrusted.invalid/responses"})
	client.auth = codexCredentialsFunc(func(context.Context, string) (codexCredentials, error) {
		t.Error("invalid endpoint read credentials")
		return codexCredentials{}, nil
	})
	if _, err := ping(context.Background(), client); err == nil {
		t.Fatal("custom endpoint accepted subscription credentials")
	}
}

func TestCodexClientOmitsUnknownAccountHeader(t *testing.T) {
	client := newCodexTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if _, ok := r.Header[http.CanonicalHeaderKey("ChatGPT-Account-ID")]; ok {
			t.Error("unknown account sent an empty or configured header")
		}
		writeCodexEvents(w, codexTerminal(responsesOKBody))
	}, ClientConfig{ExtraHeaders: map[string]string{"ChatGPT-Account-ID": "must-not-use"}})
	client.auth = codexCredentialsFunc(func(context.Context, string) (codexCredentials, error) {
		return codexCredentials{AccessToken: "opaque"}, nil
	})
	if _, err := ping(context.Background(), client); err != nil {
		t.Fatal(err)
	}
}
