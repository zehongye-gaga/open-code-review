// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/alibaba/open-code-review/internal/config/rules"
	"github.com/alibaba/open-code-review/internal/model"
	"github.com/spf13/cobra"
)

func TestExcludePathsFile(t *testing.T) {
	paths := []string{"patches/@deepseek-ai+dsh+0.2.2-alpha.2.patch", "a,b.go", "a[1].go", "a{b,c}.go",
		"literal*.go", "literal?.go", "space name.go", "line\nname.go", "back\\slash.go", "\u4e2d\u6587.go", "a,b.go"}
	file := filepath.Join(t.TempDir(), "paths.json")
	data, err := json.Marshal(paths)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0o600); err != nil {
		t.Fatal(err)
	}
	var opts reviewOptions
	cmd := &cobra.Command{}
	registerReviewFlags(cmd, &opts)
	if err := cmd.ParseFlags([]string{"--exclude-paths-file", file}); err != nil {
		t.Fatal(err)
	}
	cc := &commonContext{FileFilter: &rules.FileFilter{Exclude: []string{"*.lock"}}}
	if err := applyCLIExcludePathsFile(cc, opts.excludePathsFile); err != nil {
		t.Fatal(err)
	}
	if len(cc.FileFilter.ExcludePaths) != len(paths)-1 {
		t.Fatal("duplicate literal paths must not create duplicate entries")
	}
	for _, path := range append(paths, "package.lock") {
		if !cc.FileFilter.IsUserExcluded(path) {
			t.Errorf("path %q was not excluded", path)
		}
	}
	for _, path := range []string{"a.go", "b.go", "a1.go", "ab.go", "literal-other.go", "A,B.go", "prefix/a,b.go"} {
		if cc.FileFilter.IsUserExcluded(path) {
			t.Errorf("literal exclusion incorrectly matched %q", path)
		}
	}
}

func TestExcludePathsFileErrors(t *testing.T) {
	for _, data := range []string{"", "null", "{}", `[1]`, `[null]`, `[""]`, `["bad\u0000path"]`, `[] trailing`} {
		t.Run(data, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "paths.json")
			if err := os.WriteFile(file, []byte(data), 0o600); err != nil {
				t.Fatal(err)
			}
			cc := &commonContext{}
			if err := applyCLIExcludePathsFile(cc, file); err == nil {
				t.Fatal("invalid exclusions must fail instead of silently reviewing a different scope")
			}
			if cc.FileFilter != nil {
				t.Fatal("invalid input changed the filter")
			}
		})
	}
	cc := &commonContext{}
	if err := applyCLIExcludePathsFile(cc, ""); err != nil || cc.FileFilter != nil {
		t.Fatal("an absent option must leave filtering unchanged")
	}
	if err := applyCLIExcludePathsFile(cc, filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing exclusion file was accepted")
	}
	file := filepath.Join(t.TempDir(), "empty.json")
	if err := os.WriteFile(file, []byte("[]"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := applyCLIExcludePathsFile(cc, file); err != nil {
		t.Fatal(err)
	}
}

func TestReviewPreviewWithLiteralExclusions(t *testing.T) {
	freshOCRHome(t)
	dir := initTestGitRepo(t)
	gitCommitFile(t, dir, "base.go", "package p\n", "Base")
	files := []string{"settled[1].go", "settled1.go", "flagged.go", "a,b.go"}
	for _, file := range files {
		if err := os.WriteFile(filepath.Join(dir, file), []byte("package p\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(t.TempDir(), "exclusions.json")
	if err := os.WriteFile(file, []byte(`["settled[1].go","a,b.go"]`), 0o600); err != nil {
		t.Fatal(err)
	}
	out := captureStdout(t, func() {
		err := executeReviewContext(context.Background(), reviewOptions{repoDir: dir, preview: true,
			outputFormat: "json", excludePathsFile: file})
		if err != nil {
			t.Fatal(err)
		}
	})
	preview := decodeSinglePreviewJSON(t, out)
	if len(preview.Entries) != 4 || preview.ReviewableCount != 2 {
		t.Fatalf("unexpected review scope: %+v", preview)
	}
	for _, entry := range preview.Entries {
		excluded := entry.Path == "settled[1].go" || entry.Path == "a,b.go"
		if entry.WillReview == excluded || (excluded && entry.ExcludeReason != model.ExcludeUserRule) {
			t.Errorf("wrong selection for %q: %+v", entry.Path, entry)
		}
	}
}
