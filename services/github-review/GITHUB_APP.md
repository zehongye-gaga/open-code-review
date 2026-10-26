# GitHub App authentication

Configure the same OCR configuration file used by the review service, monitor,
and benchmark collector:

```json
{
  "githubAuth": {
    "mode": "app",
    "appId": 5475476,
    "installationId": 175345965,
    "privateKeyFile": "/etc/ocr-review/github-app.pem"
  }
}
```

The private key must be readable only by the service account (mode 0600).
Installation tokens are held in process memory, never persisted. All GitHub
REST/GraphQL calls and Git fetches use the installation identity. Tokens refresh
on demand with at least 15 minutes of remaining lifetime, and proactively about
14 minutes before expiry. Concurrent refreshes coalesce. A 401 invalidates the
cached token and retries once; 403 permission errors do not fall back to PAT.
Git fetches acquire a fresh credential before execution; the default ten-minute
fetch timeout fits within the minimum token lifetime. Do not increase that timeout
past the token validity window without updating this policy.

Required App permissions: Contents read for Git, Pull requests write for reviews
and PR comments, Commit statuses write, and Metadata read. Issues read supports
issue context. Resolving review threads may additionally require Contents write;
that optional cleanup is not a reason to switch to PAT. The App's authenticated
bot login is derived from the App API, not the user-only `/user` endpoint.

For rollback, retain the old `githubTokenFile` / `gitTokenFile` and explicitly
set `githubAuth.mode` to `pat`, then restart the review and monitor services.
The benchmark collector loads configuration on each invocation. App mode ignores
both PAT files; there is no silent fallback. Remove legacy files only after the
rollback window ends. Old comments remain historical data; new reviews are posted
by the App bot.

Policy workflows, organization Rulesets and `OCR_CI_TOKEN` are unchanged:
that token authenticates CI submissions to the dispatcher, not GitHub API access.

Validation includes JWT signature and lifetime, concurrent refresh, expiry,
401/403 behavior, bot identity, PAT exclusion during Git fetch, and live private
repository reads. Tests simulate expiry rather than waiting an hour.
