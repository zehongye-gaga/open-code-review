# Gitea integration trial

Gitea runs in a separate service instance with its own SQLite database and
checkouts. GitHub remains on the existing instance. The Gitea API adapter
normalizes PRs, publishes inline comments and statuses, and uses the configured
HTTPS origin for authenticated Git fetches. The OCR execution engine is shared.

Use `gitea.config.example.json` as a starting point.

Configure `gitea.origin`, `gitea.tokenFile` and `gitea.webhookSecretFile`.
Use the same Gitea token file for `gitTokenFile`. Set `repositories` explicitly,
with `baseBranches`, and leave GitHub infrastructure dispatch disabled.
The instance polls enrolled repositories to reconcile missed events.

`POST /webhooks/gitea` requires the original request bytes and the lowercase
hex HMAC-SHA256 `X-Gitea-Signature`. A missing or invalid signature returns 401.
PR events always re-read current state via the authenticated API; stale event
payloads cannot overwrite current PR state. SQLite queue deduplication prevents
repeated delivery of a head from creating another task. Push events reconcile
open PRs. Unauthorized repositories are acknowledged without creating a task.

Import `gitea-n8n-workflow.json` into n8n and verify the target private service
address. Preserve the binary raw request body and the Gitea event/signature
headers. Publish the workflow before activating the Gitea hook. Set the hook
secret to the same value stored by the backend. Do not reuse the API token as
the hook secret. The workflow forwards backend HTTP status codes unchanged.

## Trial deployment (2026-11-05)

- Service: `ocr-gitea.service`, `10.2.46.202:8790`
- Config: `/etc/ocr-review/gitea-config.json`
- SQLite and runs: `/data/crg/ocr-review/gitea-state`
- Trial repository: `https://code.lexmount.net/infra/ocr-test`
- n8n workflow: `7Ubhd4AHkDIeAwJC`, OCR Gitea ingress
- Public ingress: `https://n8n.cross.lexmount.cn/webhook/gitea-ci`
- Repository hook: 24. Organization-wide enrollment is not enabled.

The initial deployment was an isolated working-tree trial. Production promotion
uses a release archived from the merged commit while preserving the same state.
The initial isolated HOME lacked model configuration; the model configuration
was copied before successful real review runs. GitHub production was not
restarted or replaced.

## Current limitations

Gitea does not implement GitHub GraphQL review threads. Historical thread-based
suppression and automatic thread resolution are unavailable; findings are
published rather than suppressed when thread state cannot be proven. Existing
run-marker idempotency remains in the shared publisher. Multi-line findings
are attached to their ending line because the Gitea API accepts one position.
Gitea summaries use a separate deduplicated review because submitted review
body updates are unavailable. Trial jobs are not yet included in the existing
GitHub audit dashboard. GitHub Agent routing is not enabled for this instance;
the trial uses the configured native OCR defaults.
