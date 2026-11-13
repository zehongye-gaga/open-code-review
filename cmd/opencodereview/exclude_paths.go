// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/alibaba/open-code-review/internal/config/rules"
)

func applyCLIExcludePathsFile(cc *commonContext, filename string) error {
	if filename == "" {
		return nil
	}
	data, err := os.ReadFile(filename)
	if err != nil {
		return fmt.Errorf("read --exclude-paths-file: %w", err)
	}
	var paths []string
	if err := json.Unmarshal(data, &paths); err != nil {
		return fmt.Errorf("parse --exclude-paths-file: %w", err)
	}
	if paths == nil {
		return fmt.Errorf("--exclude-paths-file must contain a JSON array of paths")
	}
	for i, path := range paths {
		if path == "" || strings.ContainsRune(path, '\x00') {
			return fmt.Errorf("--exclude-paths-file path %d is empty or contains NUL", i)
		}
	}
	if cc.FileFilter == nil {
		cc.FileFilter = &rules.FileFilter{}
	}
	if cc.FileFilter.ExcludePaths == nil {
		cc.FileFilter.ExcludePaths = make(map[string]struct{}, len(paths))
	}
	for _, path := range paths {
		cc.FileFilter.ExcludePaths[path] = struct{}{}
	}
	return nil
}
