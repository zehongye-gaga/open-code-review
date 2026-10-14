# GitHub review service

This is a continuously running GitHub review service maintained in the OCR
repository. Repositories being reviewed need no workflow, installed action or
review scripts. Configure their names and base branches once; the service
discovers PRs, retrieves their Git history, queues reviews and publishes inline
findings, a sticky summary and an `ocr-review` commit status.

The service invokes the installed native OCR binary. OCR still owns file
selection, rules, grouping, tools, review rounds, filtering, location resolution
and sessions. `provider` selects either the Codex subscription adapter or a
regular configured API provider; neither path delegates the review to a coding
agent. Changing authentication does not replace OCR's review harness.

## Run

Requirements: Node.js 22+, Git, and an installed OCR binary with the configured
provider. No npm dependencies or package installation are required.

```sh
node services/github-review/server.js /etc/ocr-review/config.json
# From this checkout, the equivalent entry point is:
npm run service:github-review -- /etc/ocr-review/config.json
```

Copy `config.example.json`, replace `owner/repository` and its base branch, and
create the configured private credential files. The GitHub credential needs
repository contents read, pull requests write, issues write (summary comments)
and commit statuses write. A classic PAT with access to the repositories also
works. The token file is reread on every request, so it can be rotated without
restarting. Installation-token generation for GitHub Apps is not included.

First configure the native provider under the service account's `HOME`.
`--provider` selects an existing OCR configuration entry, so sharing Codex
credentials alone is insufficient. For the example systemd layout, run as the
service account:

```sh
HOME=/var/lib/ocr-review/home ocr config set provider openai-codex
HOME=/var/lib/ocr-review/home ocr config set model gpt-6-astra
```

For `openai-codex`, point `CODEX_HOME` at the server's existing Codex ChatGPT
login. The service account needs access to `auth.json` and write access to its
directory for atomic OAuth refresh. Do not copy Codex credentials into GitHub
secrets. For another provider, use the service account's normal OCR model
configuration or `OCR_LLM_*` environment. `provider`, `model`, `budget` and the
native flags in `review.js` are the only model-execution settings added by this
service. `budget` defaults to `0`, which disables the aggregate token limit
(`--max-tokens-budget 0`). Set a positive value only to opt into a token cap.
Each review uses two native groups concurrently, a fifteen-minute
per-group timeout and a configurable whole-process timeout.
`prConcurrency` controls simultaneous PR reviews and defaults to `1`. For
example, `4` reviews up to four different PRs, each with two native groups.
Auxiliary model calls can add concurrency beyond those groups. Increase this
setting according to provider capacity; model overload can still cause retries.
`fetchTimeoutSeconds` (default 600) separately bounds each Git operation; the
initial private-repository history download can take longer than later fetches.

The `ocr-review.service` unit is a deployment template. Install the repository
at `/opt/open-code-review/service`, create a dedicated `ocr-review` user and its
writable state, `home` and `tmp` directories, and adjust paths for the host.
Set `CODEX_HOME` in `/etc/ocr-review/runtime.env` and add its credential directory
to the unit's writable paths if it is outside the service state directory.
Keep configuration and credential files outside reviewed checkouts, readable
only by the service account. `flock --no-fork` ensures only one service owns the
state while making Node the systemd main process for graceful shutdown.

```sh
systemctl daemon-reload
systemctl enable --now ocr-review.service
systemctl status ocr-review.service
journalctl -u ocr-review.service -f
curl --fail http://127.0.0.1:8787/healthz
```

## Triggering and operations

Polling runs every 30 seconds by default, including after restart. New PRs,
new head commits, changes of target branch and drafts becoming ready are detected.
Ordinary commits to the base branch do not rerun every historical PR. If the
base changes while a review is queued or running, that job is refreshed before
publication; completed reviews remain attached to their reviewed head.
Draft, closed and non-allowlisted PRs are ignored. `bootstrapExisting: true`
reviews existing open PRs on first startup. Set it to `false` during a parallel
migration to record existing heads without reviewing the backlog; later pushes,
new PRs and explicit API requests are still reviewed. This baseline is durable
and is not repeated on restart.

Optional `POST /webhooks/github` accepts GitHub `pull_request` events with
`X-Hub-Signature-256`. Configure `webhookSecretFile` (or `OCR_WEBHOOK_SECRET`)
and a reverse proxy with HTTPS for delivery. Webhooks accelerate the same queue;
polling repairs missed deliveries. They never directly trust supplied SHAs or
clone URLs: current PR metadata is fetched from GitHub. No public ingress is
needed for polling.

`GET /healthz` reports queue size, `running`, `prConcurrency`, `activeJobs`
(including PR numbers and worker slots), and the last successful poll. The
legacy `active` field contains the first active job ID or null. It returns
503 before the first successful poll or while discovery/status publication is
degraded. `GET /v1/jobs` lists the latest 100 job records. `POST /v1/reviews` with
`{"repository":"owner/repository","pull_number":123}` queues an explicit
rerun. Both `/v1` routes require `Authorization: Bearer <api-token>`, where the
token comes from `apiTokenFile` or `OCR_SERVICE_API_TOKEN`. Without an API token
those routes are disabled. The listener defaults to loopback; use an SSH tunnel
or authenticated operational proxy for remote access.

Queue state is atomically persisted before execution. Interrupted work resumes
after restart. Reviews use a bounded pool of `prConcurrency` workers across
configured repositories. Each worker has its own Git checkout, index and refs;
one PR cannot change the files or fetch refs used by another. A newer head/base
supersedes queued work and terminates an active old review. Its replacement
waits until the previous execution of the same PR exits, while unrelated PRs
can use other workers. Failed or partial
reviews retry up to `maxAttempts`, with exponential backoff starting at
`retrySeconds`. After the cap, inspect the job and request a rerun. A new commit
always gets a new job. If an optional token cap is configured, a review that
exhausts it stays incomplete and is not retried automatically with the same
budget; remove or raise the cap and request an explicit rerun. This is a
single-host service, not a distributed queue.

The service fetches PR commits as Git objects and checks out only the trusted
base commit. It never installs project dependencies or runs PR scripts. OCR
reads the immutable range `merge-base..head`. Head/base are checked after fetch,
before publication and before the final status. Publication uses OCR's existing
incremental comment deduplication and sticky summary. Superseded results cannot
set a successful status for a newer commit. GitHub has no atomic compare-and-set
for PR comments; an update during a publication request can briefly leave a
summary for the previous head until the new queued review replaces it.

The `ocr-review` status is pending when queued/running, error for incomplete
review or publication, failure for findings at/above `blockSeverity`, and success
for a complete review below that threshold. Default blocking severity is high;
`none` reports all findings without using them to fail the status. Excluded-only
changes are explicitly skipped and count as a successful, neutral result.
Out-of-diff findings successfully included in the summary do not count as
publication failures. A failed review is never reported as clean.

Metadata, original OCR JSON, stderr and exit codes live in `stateDirectory/runs`.
Completed artifacts and job records expire after `retentionDays` (default seven);
active/retry artifacts remain. OCR session history and Git object caches have
their own lifecycle and are not deleted by this retention job. Monitor the
state volume. State corruption or persistent storage failures fail closed and
restart the process rather than silently forgetting completed work.

Worker zero keeps the original `stateDirectory/repositories/<owner>/<repo>`
checkout. Other workers use
`stateDirectory/worker-repositories/<slot>/<owner>/<repo>` with independent
Git object stores. New slots download repository history on their first use;
later reviews reuse their checkout. These caches persist if concurrency is
reduced. Allow disk space for one checkout per worker and repository.

Keep an existing required review check during parallel validation. Only replace
that branch-protection requirement after validating PR creation, updates,
comments, failures and restart recovery; then retire its previous service if it
has no other repository or notification responsibilities.

## Development

```sh
node --test services/github-review/*.test.js
npm run test:github-actions
make check
```

The tests use real Git repositories and child processes, a real HTTP listener,
native OCR command contracts, mocked GitHub transport, and the shared production
comment publisher. No model credentials are needed for this suite.
