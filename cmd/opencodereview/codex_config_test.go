// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import (
	"path/filepath"
	"testing"

	"github.com/alibaba/open-code-review/internal/llm"
)

func TestCodexProviderConfigWithoutAPIKey(t *testing.T) {
	cfg := &Config{}
	for _, kv := range [][2]string{{"providers.openai-codex.model", "gpt-5.4"}, {"provider", "openai-codex"}} {
		if err := setConfigValue(cfg, kv[0], kv[1]); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := saveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	ep, err := llm.ResolveEndpoint(path)
	if err != nil || !ep.AmbientAuth || ep.Protocol != llm.ProtocolOpenAICodex {
		t.Fatalf("endpoint = %+v: %v", ep, err)
	}
	if err := setProviderValue(cfg, "providers.openai-codex.aws_region", "us-west-2"); err == nil {
		t.Fatal("Codex provider accepted AWS-only configuration")
	}
	preset, _ := llm.LookupProvider("openai-codex")
	if err := checkAPIKeyRequirement("openai-codex", "", "", preset, true); err != nil {
		t.Fatal(err)
	}
}
