// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCodexProviderResolutionAndFactory(t *testing.T) {
	for name, config := range map[string]string{
		"preset": `{"provider":"openai-codex","providers":{"openai-codex":{"model":"my-model","api_key_cmd":"exit 99"}}}`,
		"custom": `{"provider":"local-login","custom_providers":{"local-login":{"protocol":"openai-codex","model":"my-model","api_key":"ignored","api_key_cmd":"exit 99"}}}`,
		"legacy": `{"llm":{"protocol":"openai-codex","model":"my-model","auth_token_cmd":"exit 99"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, []byte(config), 0600); err != nil {
				t.Fatal(err)
			}
			ep, err := ResolveEndpointWithOptions(path, ResolveOptions{Model: "account-model"})
			if err != nil {
				t.Fatal(err)
			}
			if !ep.AmbientAuth || ep.Token != "" || ep.Model != "account-model" || ep.Protocol != ProtocolOpenAICodex {
				t.Fatalf("endpoint = %+v", ep)
			}
			if _, ok := NewLLMClient(ep, nil, nil).(*CodexSubscriptionClient); !ok {
				t.Fatal("factory did not select the Codex adapter")
			}
		})
	}
}

func TestCodexEnvironmentDoesNotRequireAPIKey(t *testing.T) {
	t.Setenv(envOCRLLMProtocol, " openai-codex ")
	t.Setenv(envOCRLLMURL, "")
	t.Setenv(envOCRLLMToken, "")
	t.Setenv(envOCRLLMModel, "account-model")
	ep, err := ResolveEndpoint(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil || !ep.AmbientAuth || ep.Model != "account-model" || ep.URL != codexBaseURL {
		t.Fatalf("endpoint = %+v: %v", ep, err)
	}
	t.Setenv(envOCRLLMURL, "https://untrusted.invalid")
	if _, err := ResolveEndpoint(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatal("custom endpoint accepted")
	}
}

func TestCodexConfigRejectsCustomEndpoints(t *testing.T) {
	for _, config := range []string{
		`{"provider":"openai-codex","providers":{"openai-codex":{"model":"m","url":"http://localhost:1234","api_key_cmd":"exit 99"}}}`,
		`{"llm":{"protocol":"openai-codex","url":"http://localhost:1234","model":"m"}}`,
	} {
		path := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, []byte(config), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := ResolveEndpoint(path); err == nil {
			t.Fatal("custom endpoint accepted")
		}
	}
	for _, url := range []string{"", codexBaseURL, codexBaseURL + "/", codexBaseURL + "/responses", codexBaseURL + "/responses/"} {
		if err := validateCodexEndpoint(url); err != nil {
			t.Errorf("valid endpoint %q: %v", url, err)
		}
	}
}

func TestCodexProtocolOverrideStillRequiresAPIKey(t *testing.T) {
	_, _, err := tryProviderConfig(configFile{Provider: "openai-codex", Providers: map[string]providerEntryConfig{"openai-codex": {Protocol: ProtocolOpenAIResponses, URL: "https://example.com", Model: "m"}}}, "")
	if err == nil {
		t.Fatal("API protocol override inherited ambient credentials")
	}
	if err := ValidateProtocol(NormalizeProtocol(" OPENAI-CODEX ")); err != nil {
		t.Fatal(err)
	}
}
