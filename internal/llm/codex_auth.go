// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package llm

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	codexBaseURL       = "https://chatgpt.com/backend-api/codex"
	codexTokenURL      = "https://auth.openai.com/oauth/token"
	codexOAuthClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexAuthMaxBytes  = 1 << 20
)

type codexCredentials struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	AccountID    string `json:"account_id"`
	IDToken      string `json:"id_token"`
}

type codexClaims struct {
	ExpiresAt int64 `json:"exp"`
	Auth      struct {
		AccountID        string `json:"chatgpt_account_id"`
		DataResidency    string `json:"chatgpt_data_residency"`
		ComputeResidency string `json:"chatgpt_compute_residency"`
	} `json:"https://api.openai.com/auth"`
}

func readCodexClaims(token string) codexClaims {
	var claims codexClaims
	parts := strings.Split(token, ".")
	if len(parts) == 3 {
		if raw, err := base64.RawURLEncoding.DecodeString(parts[1]); err == nil {
			_ = json.Unmarshal(raw, &claims)
		}
	}
	return claims
}

func (c codexCredentials) expiring() bool {
	exp := readCodexClaims(c.AccessToken).ExpiresAt
	return exp > 0 && time.Until(time.Unix(exp, 0)) <= 2*time.Minute
}

type codexAuthDocument struct {
	fields      map[string]json.RawMessage
	tokenFields map[string]json.RawMessage
	credentials codexCredentials
}

func codexAuthPath() (string, error) {
	home := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if home == "" || home == "~" || strings.HasPrefix(home, "~/") {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("locate Codex credentials: %w", err)
		}
		if home == "" {
			home = filepath.Join(userHome, ".codex")
		} else if home == "~" {
			home = userHome
		} else {
			home = filepath.Join(userHome, strings.TrimPrefix(home, "~/"))
		}
	}
	path := filepath.Join(home, "auth.json")
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("read Codex credentials at %s: %w; run codex login with cli_auth_credentials_store=\"file\"", path, err)
	}
	return resolved, nil
}

func readCodexAuth(path string) (*codexAuthDocument, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read Codex credentials: %w", err)
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, codexAuthMaxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read Codex credentials: %w", err)
	}
	if len(raw) > codexAuthMaxBytes {
		return nil, fmt.Errorf("Codex credential file exceeds %d bytes", codexAuthMaxBytes)
	}
	doc := &codexAuthDocument{}
	raw = bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf})
	if json.Unmarshal(raw, &doc.fields) != nil || doc.fields == nil {
		return nil, fmt.Errorf("invalid Codex credential file; run codex login")
	}
	var mode string
	if v, ok := doc.fields["auth_mode"]; ok && json.Unmarshal(v, &mode) != nil {
		return nil, fmt.Errorf("invalid Codex auth_mode; run codex login")
	}
	if mode != "" && mode != "chatgpt" {
		return nil, fmt.Errorf("openai-codex requires ChatGPT subscription authentication; run codex login")
	}
	tokens := doc.fields["tokens"]
	if json.Unmarshal(tokens, &doc.tokenFields) != nil || json.Unmarshal(tokens, &doc.credentials) != nil || strings.TrimSpace(doc.credentials.AccessToken) == "" {
		return nil, fmt.Errorf("Codex OAuth access token is missing or invalid; run codex login")
	}
	if doc.credentials.AccountID == "" {
		doc.credentials.AccountID = readCodexClaims(doc.credentials.AccessToken).Auth.AccountID
		if doc.credentials.AccountID == "" {
			doc.credentials.AccountID = readCodexClaims(doc.credentials.IDToken).Auth.AccountID
		}
	}
	return doc, nil
}

// rejected is the access token that received an HTTP 401, not a cached refresh
// token: a peer may already have renewed the grant while this request was running.
type codexCredentialSource interface {
	credentials(ctx context.Context, rejected string) (codexCredentials, error)
}

type codexFileCredentials struct {
	tokenURL string
	client   *http.Client
}

func newCodexFileCredentials() *codexFileCredentials {
	client := httpClientWithHeaderTimeout(20 * time.Second)
	client.Timeout = 20 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &codexFileCredentials{tokenURL: codexTokenURL, client: client}
}

func (s *codexFileCredentials) credentials(ctx context.Context, rejected string) (codexCredentials, error) {
	if err := ctx.Err(); err != nil {
		return codexCredentials{}, err
	}
	path, err := codexAuthPath()
	if err != nil {
		return codexCredentials{}, err
	}
	doc, err := readCodexAuth(path)
	if err != nil {
		return codexCredentials{}, err
	}
	needsRefresh := func(c codexCredentials) bool {
		return c.expiring() || (rejected != "" && c.AccessToken == rejected)
	}
	if !needsRefresh(doc.credentials) {
		return doc.credentials, nil
	}
	lock, err := lockCodexAuth(ctx, path+".ocr.lock")
	if err != nil {
		return codexCredentials{}, err
	}
	defer lock.Close()
	doc, err = readCodexAuth(path)
	if err != nil {
		return codexCredentials{}, err
	}
	if !needsRefresh(doc.credentials) {
		return doc.credentials, nil
	}
	updated, refreshErr := s.refresh(ctx, doc.credentials)
	// Codex itself does not participate in OCR's file lock. Re-read on both
	// success and failure to avoid overwriting an observed rotation or account switch.
	latest, err := readCodexAuth(path)
	if err != nil {
		return codexCredentials{}, err
	}
	if latest.credentials.AccountID != doc.credentials.AccountID {
		return codexCredentials{}, fmt.Errorf("Codex account changed during token refresh; retry the review")
	}
	if latest.credentials.AccessToken != doc.credentials.AccessToken || latest.credentials.RefreshToken != doc.credentials.RefreshToken {
		if latest.credentials.expiring() {
			return codexCredentials{}, fmt.Errorf("Codex credentials changed during token refresh but are still expired; run codex login")
		}
		return latest.credentials, nil
	}
	if refreshErr != nil {
		return codexCredentials{}, refreshErr
	}
	if err := latest.save(path, updated); err != nil {
		return codexCredentials{}, fmt.Errorf("persist refreshed Codex credentials: %w", err)
	}
	return updated, nil
}

func lockCodexAuth(ctx context.Context, path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("lock Codex credentials: %w", err)
	}
	for {
		if err := ctx.Err(); err != nil {
			_ = f.Close()
			return nil, err
		}
		locked, err := tryCodexAuthLock(f)
		if err != nil {
			_ = f.Close()
			return nil, fmt.Errorf("lock Codex credentials: %w", err)
		}
		if locked {
			return f, nil
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			_ = f.Close()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (s *codexFileCredentials) refresh(ctx context.Context, old codexCredentials) (codexCredentials, error) {
	if strings.TrimSpace(old.RefreshToken) == "" {
		return codexCredentials{}, fmt.Errorf("Codex refresh token is missing; run codex login")
	}
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {old.RefreshToken}, "client_id": {codexOAuthClientID}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return codexCredentials{}, fmt.Errorf("create Codex token refresh request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent("openai-codex"))
	resp, err := s.client.Do(req)
	if err != nil {
		return codexCredentials{}, fmt.Errorf("refresh Codex credentials: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		switch resp.StatusCode {
		case http.StatusBadRequest, http.StatusUnauthorized:
			return codexCredentials{}, fmt.Errorf("Codex token refresh rejected (HTTP %d); run codex login", resp.StatusCode)
		default:
			return codexCredentials{}, fmt.Errorf("Codex token refresh failed (HTTP %d); retry later", resp.StatusCode)
		}
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, codexAuthMaxBytes+1))
	if err != nil {
		return codexCredentials{}, fmt.Errorf("read Codex token refresh response: %w", err)
	}
	var result codexCredentials
	if len(raw) > codexAuthMaxBytes || json.Unmarshal(raw, &result) != nil || strings.TrimSpace(result.AccessToken) == "" {
		return codexCredentials{}, fmt.Errorf("Codex token refresh returned an invalid response")
	}
	updated := old
	updated.AccessToken = result.AccessToken
	if result.RefreshToken != "" {
		updated.RefreshToken = result.RefreshToken
	}
	if result.IDToken != "" {
		updated.IDToken = result.IDToken
	}
	return updated, nil
}

func (d *codexAuthDocument) save(path string, credentials codexCredentials) error {
	for key, value := range map[string]string{"access_token": credentials.AccessToken, "refresh_token": credentials.RefreshToken, "id_token": credentials.IDToken} {
		if value != "" {
			d.tokenFields[key], _ = json.Marshal(value)
		}
	}
	d.fields["tokens"], _ = json.Marshal(d.tokenFields)
	d.fields["last_refresh"], _ = json.Marshal(time.Now().UTC().Format(time.RFC3339))
	raw, err := json.MarshalIndent(d.fields, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".ocr-auth-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err := f.Write(append(raw, '\n')); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
