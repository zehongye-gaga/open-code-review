// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func codexTestJWT(exp time.Time, account string) string {
	raw, _ := json.Marshal(map[string]any{"exp": exp.Unix(), "https://api.openai.com/auth": map[string]string{"chatgpt_account_id": account}})
	return "e30." + base64.RawURLEncoding.EncodeToString(raw) + ".test-signature"
}

func codexAuthFixture(token, refresh string) string {
	raw, _ := json.Marshal(map[string]any{
		"auth_mode": "chatgpt", "future_field": map[string]string{"keep": "me"},
		"tokens": map[string]string{"access_token": token, "refresh_token": refresh, "account_id": "acct-test", "id_token": "old-id", "future_token_field": "keep-token-field"},
	})
	return string(raw)
}

func writeCodexFixture(t *testing.T, raw string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	path := filepath.Join(home, "auth.json")
	if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCodexCredentialsReuseWithoutMutation(t *testing.T) {
	token := codexTestJWT(time.Now().Add(time.Hour), "acct-test")
	raw := codexAuthFixture(token, "refresh-before")
	path := writeCodexFixture(t, raw)
	source := newCodexFileCredentials()
	source.tokenURL = "https://must-not-be-called.invalid"
	got, err := source.credentials(context.Background(), "")
	if err != nil || got.AccessToken != token || got.AccountID != "acct-test" {
		t.Fatalf("credentials: %+v, %v", got, err)
	}
	after, _ := os.ReadFile(path)
	if string(after) != raw {
		t.Fatal("fresh credentials were rewritten")
	}
	if _, err := os.Stat(path + ".ocr.lock"); !os.IsNotExist(err) {
		t.Fatal("fresh credentials must not create a lock file")
	}
	got, err = source.credentials(context.Background(), "obsolete-token")
	if err != nil || got.AccessToken != token {
		t.Fatalf("did not adopt credentials rotated by a peer: %v", err)
	}
}

func TestCodexConcurrentRefreshPreservesCredentialDocument(t *testing.T) {
	old := codexTestJWT(time.Now().Add(-time.Hour), "acct-test")
	fresh := codexTestJWT(time.Now().Add(time.Hour), "acct-test")
	path := writeCodexFixture(t, codexAuthFixture(old, "refresh-before"))
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.Method != "POST" || r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "refresh-before" || r.Form.Get("client_id") != codexOAuthClientID {
			t.Error("invalid refresh request")
		}
		if !strings.HasPrefix(r.Header.Get("User-Agent"), "open-code-review/") {
			t.Error("missing OCR identity")
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": fresh, "refresh_token": "refresh-after", "id_token": "new-id"})
	}))
	defer server.Close()
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			source := newCodexFileCredentials()
			source.tokenURL = server.URL
			got, err := source.credentials(context.Background(), old)
			if err != nil || got.AccessToken != fresh {
				t.Errorf("refresh: %v", err)
			}
		}()
	}
	wg.Wait()
	if requests.Load() != 1 {
		t.Fatalf("refresh requests = %d, want 1", requests.Load())
	}
	doc, err := readCodexAuth(path)
	if err != nil {
		t.Fatal(err)
	}
	if doc.credentials.RefreshToken != "refresh-after" || doc.credentials.IDToken != "new-id" || doc.fields["future_field"] == nil || rawString(doc.tokenFields["future_token_field"]) != "keep-token-field" || doc.fields["last_refresh"] == nil {
		t.Fatal("refresh dropped credentials or unknown fields")
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0600 {
			t.Fatalf("credential permissions = %v", info.Mode())
		}
	}
	leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".ocr-auth-*.json"))
	if len(leftovers) != 0 {
		t.Fatal("temporary credentials were left on disk")
	}
}

func TestCodexRefreshAdoptsExternalRotation(t *testing.T) {
	for _, status := range []int{200, 401} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			path := writeCodexFixture(t, codexAuthFixture("old", "old-refresh"))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if err := os.WriteFile(path, []byte(codexAuthFixture("peer", "peer-refresh")), 0600); err != nil {
					t.Error(err)
				}
				w.WriteHeader(status)
				_, _ = fmt.Fprint(w, `{"access_token":"our-refresh","refresh_token":"our-new-refresh"}`)
			}))
			defer server.Close()
			source := newCodexFileCredentials()
			source.tokenURL = server.URL
			got, err := source.credentials(context.Background(), "old")
			if err != nil || got.AccessToken != "peer" {
				t.Fatalf("external rotation was lost: %+v %v", got, err)
			}
			doc, _ := readCodexAuth(path)
			if doc.credentials.RefreshToken != "peer-refresh" {
				t.Fatal("overwrote peer credentials")
			}
		})
	}
}

func TestCodexRefreshErrorsDoNotChangeCredentialsOrLeakTokens(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     int
		body, want string
	}{
		{"unauthorized", 401, "secret-refresh-token", "codex login"},
		{"revoked", 400, `{"error":"invalid_grant"}`, "codex login"},
		{"rate limited", 429, "secret-refresh-token", "retry later"},
		{"unavailable", 503, "secret-refresh-token", "retry later"},
		{"invalid JSON", 200, "secret-refresh-token", "invalid response"},
		{"empty token", 200, `{"access_token":" "}`, "invalid response"},
		{"oversized", 200, strings.Repeat("x", codexAuthMaxBytes+1), "invalid response"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := codexAuthFixture("old", "secret-refresh-token")
			path := writeCodexFixture(t, raw)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); _, _ = fmt.Fprint(w, tc.body) }))
			defer server.Close()
			source := newCodexFileCredentials()
			source.tokenURL = server.URL
			_, err := source.credentials(context.Background(), "old")
			if err == nil || !strings.Contains(err.Error(), tc.want) || strings.Contains(err.Error(), "secret-refresh-token") {
				t.Fatalf("unexpected error: %v", err)
			}
			after, _ := os.ReadFile(path)
			if string(after) != raw {
				t.Fatal("failed refresh changed credentials")
			}
		})
	}
}

func TestCodexCredentialValidation(t *testing.T) {
	for _, raw := range []string{"null", "{", `[]`, `{"auth_mode":3}`, `{"auth_mode":"apikey","OPENAI_API_KEY":"secret"}`, `{"tokens":{}}`, strings.Repeat("x", codexAuthMaxBytes+1)} {
		t.Run(fmt.Sprint(len(raw)), func(t *testing.T) {
			path := writeCodexFixture(t, raw)
			if _, err := readCodexAuth(path); err == nil {
				t.Fatal("invalid credentials accepted")
			}
		})
	}
	t.Run("missing file", func(t *testing.T) {
		t.Setenv("CODEX_HOME", t.TempDir())
		_, err := newCodexFileCredentials().credentials(context.Background(), "")
		if err == nil || !strings.Contains(err.Error(), "codex login") {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("missing refresh", func(t *testing.T) {
		writeCodexFixture(t, codexAuthFixture("old", ""))
		_, err := newCodexFileCredentials().credentials(context.Background(), "old")
		if err == nil || !strings.Contains(err.Error(), "refresh token") {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("account from ID token and BOM", func(t *testing.T) {
		raw, _ := json.Marshal(map[string]any{"tokens": codexCredentials{AccessToken: "opaque", IDToken: codexTestJWT(time.Now().Add(time.Hour), "acct-id")}})
		path := writeCodexFixture(t, "\xef\xbb\xbf"+string(raw))
		doc, err := readCodexAuth(path)
		if err != nil || doc.credentials.AccountID != "acct-id" {
			t.Fatalf("ID token fallback: %v", err)
		}
	})
}

func TestCodexAuthHomeResolution(t *testing.T) {
	home := t.TempDir()
	setTestHome(t, home)
	for _, root := range []string{"", "~", "~/.alternate"} {
		t.Run(root, func(t *testing.T) {
			t.Setenv("CODEX_HOME", root)
			dir := home
			if root == "" {
				dir = filepath.Join(home, ".codex")
			} else if root != "~" {
				dir = filepath.Join(home, ".alternate")
			}
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			want := filepath.Join(dir, "auth.json")
			if err := os.WriteFile(want, []byte("{}"), 0600); err != nil {
				t.Fatal(err)
			}
			want, _ = filepath.EvalSymlinks(want)
			got, err := codexAuthPath()
			if err != nil || got != want {
				t.Fatalf("path = %s, want %s: %v", got, want, err)
			}
		})
	}
}

func TestCodexAuthProcessLock(t *testing.T) {
	if path := os.Getenv("OCR_TEST_CODEX_LOCK"); path != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 75*time.Millisecond)
		defer cancel()
		_, err := lockCodexAuth(ctx, path)
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("cross-process lock error: %v", err)
		}
		return
	}
	path := filepath.Join(t.TempDir(), "auth.lock")
	lock, err := lockCodexAuth(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	cmd := exec.Command(os.Args[0], "-test.run=^TestCodexAuthProcessLock$")
	cmd.Env = append(os.Environ(), "OCR_TEST_CODEX_LOCK="+path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child: %s: %v", out, err)
	}
}

func TestCodexRefreshCancellationAndRedirect(t *testing.T) {
	t.Run("cancelled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := newCodexFileCredentials().credentials(ctx, "")
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("refresh cancellation", func(t *testing.T) {
		writeCodexFixture(t, codexAuthFixture("old", "refresh"))
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.Copy(io.Discard, r.Body); <-r.Context().Done() }))
		defer server.Close()
		source := newCodexFileCredentials()
		source.tokenURL = server.URL
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		_, err := source.credentials(ctx, "old")
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("redirect", func(t *testing.T) {
		var leaked atomic.Bool
		destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true) }))
		defer destination.Close()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
		}))
		defer server.Close()
		source := newCodexFileCredentials()
		source.tokenURL = server.URL
		_, err := source.refresh(context.Background(), codexCredentials{RefreshToken: "secret"})
		if err == nil || leaked.Load() {
			t.Fatal("refresh token followed a redirect")
		}
	})
}
