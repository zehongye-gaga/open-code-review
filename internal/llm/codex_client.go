// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	openai "github.com/openai/openai-go/v3"
	openaiopt "github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/packages/param"
	"github.com/openai/openai-go/v3/responses"
)

// CodexSubscriptionClient leaves the agent loop in OCR and adapts the Codex
// OAuth/streaming transport to the same interface as API-key providers.
type CodexSubscriptionClient struct {
	cfg     ClientConfig
	sdk     openai.Client
	auth    codexCredentialSource
	initErr error
}

func validateCodexEndpoint(raw string) error {
	base := strings.TrimSuffix(strings.TrimRight(raw, "/"), "/responses")
	if base != "" && base != codexBaseURL {
		return fmt.Errorf("openai-codex uses %s; use openai-responses for a custom API endpoint", codexBaseURL)
	}
	return nil
}

func NewCodexSubscriptionClient(cfg ClientConfig) *CodexSubscriptionClient {
	err := validateCodexEndpoint(cfg.URL)
	cfg.URL = codexBaseURL + "/responses"
	cfg.APIKey = ""
	if cfg.Timeout <= 0 {
		cfg.Timeout = 5 * time.Minute
	}
	if cfg.SessionKey == "" {
		cfg.SessionKey = NewSessionKey()
	}
	// Authentication recovery owns 401, including when a custom retry list
	// requests it. Repeated refreshes can consume a single-use refresh token.
	var retryCodes []int
	for _, code := range cfg.RetryCodes {
		if code != http.StatusUnauthorized {
			retryCodes = append(retryCodes, code)
		}
	}
	cfg.RetryCodes = retryCodes
	client := httpClientWithHeaderTimeout(cfg.Timeout)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &CodexSubscriptionClient{
		cfg:     cfg,
		sdk:     newResponsesSDK(cfg, openaiopt.WithHTTPClient(client)),
		auth:    newCodexFileCredentials(),
		initErr: err,
	}
}

func (c *CodexSubscriptionClient) CompletionsWithCtx(ctx context.Context, req ChatRequest) (resp *ChatResponse, err error) {
	defer func() {
		if r := recover(); r != nil {
			finalizeRequest(ctx, c.cfg.retryCollector, errRequestPanicked)
			panic(r)
		}
		err = describeTimeout(ctx, err)
		finalizeRequest(ctx, c.cfg.retryCollector, err)
	}()
	if c.initErr != nil {
		return nil, c.initErr
	}
	model := req.Model
	if model == "" {
		model = c.cfg.Model
	}
	params := buildCodexParams(model, req)
	credentials, err := c.auth.credentials(ctx, "")
	if err != nil {
		return nil, err
	}
	resp, err = c.complete(ctx, params, credentials)
	var apiErr *openai.Error
	if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusUnauthorized {
		credentials, err = c.auth.credentials(ctx, credentials.AccessToken)
		if err != nil {
			return nil, err
		}
		return c.complete(ctx, params, credentials)
	}
	return resp, err
}

func buildCodexParams(model string, req ChatRequest) responses.ResponseNewParams {
	params := buildResponsesParams(model, req)
	params.MaxOutputTokens = param.Opt[int64]{}
	params.Temperature = param.Opt[float64]{}
	if params.Instructions.Value == "" {
		params.Instructions = openai.String("You are an expert code reviewer.")
	}
	if len(req.Tools) > 0 {
		switch req.ToolChoice {
		case "none":
			params.ToolChoice = responses.ResponseNewParamsToolChoiceUnion{OfToolChoiceMode: param.NewOpt(responses.ToolChoiceOptionsNone)}
		case "", "auto":
			params.ToolChoice = responses.ResponseNewParamsToolChoiceUnion{OfToolChoiceMode: param.NewOpt(responses.ToolChoiceOptionsAuto)}
		}
	}
	return params
}

func (c *CodexSubscriptionClient) requestOptions(ctx context.Context, credentials codexCredentials) []openaiopt.RequestOption {
	sessionKey := c.cfg.SessionKey
	if key := SessionKeyFromContext(ctx); key != "" {
		sessionKey = key
	}
	var opts []openaiopt.RequestOption
	for key, value := range expandSessionKeyInHeaders(c.cfg.ExtraHeaders, sessionKey) {
		opts = append(opts, openaiopt.WithHeader(key, value))
	}
	for key, value := range expandSessionKeyInBody(c.cfg.ExtraBody, sessionKey) {
		opts = append(opts, openaiopt.WithJSONSet(key, value))
	}
	// Apply wire constraints after extra_body so saved API-provider settings
	// cannot turn subscription requests into stored or non-streaming responses.
	for _, key := range []string{
		"max_output_tokens", "max_tokens", "max_completion_tokens", "temperature", "top_p",
		"previous_response_id", "background", "conversation", "truncation", "prompt_cache_retention",
	} {
		opts = append(opts, openaiopt.WithJSONDel(key))
	}
	opts = append(opts,
		openaiopt.WithJSONSet("store", false),
		openaiopt.WithAPIKey(credentials.AccessToken),
		openaiopt.WithHeader("Authorization", "Bearer "+credentials.AccessToken),
		openaiopt.WithHeaderDel("ChatGPT-Account-ID"),
		openaiopt.WithHeader("originator", "open-code-review"),
		openaiopt.WithHeader("User-Agent", userAgent("openai-codex")),
		openaiopt.WithHeader("session_id", sessionKey),
	)
	if credentials.AccountID != "" {
		opts = append(opts, openaiopt.WithHeader("ChatGPT-Account-ID", credentials.AccountID))
	}
	claims := readCodexClaims(credentials.AccessToken)
	residency := claims.Auth.DataResidency
	if residency == "" {
		residency = claims.Auth.ComputeResidency
	}
	if residency != "" {
		opts = append(opts, openaiopt.WithHeader("x-openai-internal-codex-residency", residency))
	}
	return opts
}

func (c *CodexSubscriptionClient) complete(ctx context.Context, params responses.ResponseNewParams, credentials codexCredentials) (*ChatResponse, error) {
	stream := c.sdk.Responses.NewStreaming(ctx, params, c.requestOptions(ctx, credentials)...)
	defer stream.Close()
	state := newCodexStream()
	for stream.Next() {
		done, err := state.add([]byte(stream.Current().RawJSON()))
		if err != nil {
			reviseAttempt(ctx, c.cfg.retryCollector, ErrorClassProvider, FailurePhaseStream)
			return nil, err
		}
		if done {
			sdkResp, err := state.response(string(params.Model))
			if err != nil {
				reviseAttempt(ctx, c.cfg.retryCollector, ErrorClassProvider, FailurePhaseStream)
				return nil, err
			}
			result := mapCodexResponse(sdkResp)
			if result.VisibleContent() == "" && len(result.ToolCalls()) == 0 {
				reviseAttempt(ctx, c.cfg.retryCollector, ErrorClassProvider, FailurePhaseStream)
				return nil, &streamIntegrityError{reason: "completed without an answer or tool calls"}
			}
			return result, nil
		}
	}
	if err := stream.Err(); err != nil {
		class, phase := classifyStreamError(err)
		reviseAttempt(ctx, c.cfg.retryCollector, class, phase)
		return nil, withProviderErrorBody(err)
	}
	err := &streamIntegrityError{reason: "ended before response.completed"}
	reviseAttempt(ctx, c.cfg.retryCollector, ErrorClassProvider, FailurePhaseStream)
	return nil, err
}

func mapCodexResponse(response *responses.Response) *ChatResponse {
	result := mapResponsesResponse(response)
	var final, commentary []string
	for _, item := range response.Output {
		if item.Type != "message" {
			continue
		}
		msg := item.AsMessage()
		var text strings.Builder
		for _, part := range msg.Content {
			if part.Type == "output_text" {
				text.WriteString(part.Text)
			} else if part.Type == "refusal" {
				text.WriteString(part.Refusal)
			}
		}
		if string(msg.Phase) == "commentary" {
			commentary = append(commentary, text.String())
		} else {
			final = append(final, text.String())
		}
	}
	message := &result.Choices[0].Message
	message.Content = nil
	if text := stripThinkTags(strings.Join(final, "")); text != "" {
		message.Content = &text
	}
	if len(commentary) > 0 {
		message.ReasoningContent = strings.TrimSpace(strings.Join(append([]string{message.ReasoningContent}, commentary...), "\n"))
	}
	return result
}
