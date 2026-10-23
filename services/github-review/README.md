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
Keep `KillMode=mixed`: Node sends one termination signal to each OCR child so
it can flush its manifest. Sending signals to the whole control group as well
would deliver a second signal, which native OCR treats as a forced exit.

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

Queue state is atomically persisted before execution. Interrupted work is requeued
after restart. Reviews use a bounded pool of `prConcurrency` workers across
configured repositories. Each worker has its own Git checkout, index and refs;
one PR cannot change the files or fetch refs used by another. A newer head/base
does not cancel a running snapshot or its scheduled retries. Multiple pushes
coalesce into one latest waiting job. That job waits for the original snapshot
to finish or exhaust its retries; unrelated PRs can use other workers. Closing
a PR, converting it to draft, or changing it to a disallowed base still cancels
its work and removes its checkpoint.

Failed or partial reviews retry up to `maxAttempts`, with exponential backoff
starting at `retrySeconds`. The original head, base, background and review range
stay pinned. When the native report contains a verifiable session manifest,
the next attempt passes `--resume` to OCR, reusing its completed file/group
checkpoints. Retries keep their original worker checkout because native sessions
are indexed by repository path. If concurrency is reduced below that slot, the
snapshot restarts on an available worker. A changed binary, model, rules or model
configuration invalidates reuse. A missing or rejected session falls back once
to a fresh review of the snapshot, retaining the admission diagnostics. A crash
or SIGKILL before a native manifest is written cannot be resumed by OCR and
requires a fresh attempt. Publication-only failures reuse the saved complete
report without making another model call. After the retry cap, inspect the job
and request a rerun. If an optional token cap is configured, a review that
exhausts it stays incomplete and is not retried automatically with the same
budget; remove or raise the cap and request an explicit rerun. This is a
single-host service, not a distributed queue.

Completed native reviews save durable per-PR checkpoints, even if a newer push
means their results can no longer be published. These jobs end as `checkpointed`
instead of cancelled. Only a checkpoint with zero findings can narrow the next
review to `checkpoint-head..new-head`. A checkpoint with any finding requires
a full review so unresolved issues cannot disappear from the blocking status.
The service reuses OCR's checkpoint ancestry/base/config validation. Force pushes,
changed base commits or branches, changed requirements/rules/model configuration,
missing objects and explicit API reruns fall back to the full PR range. Partial,
failed and excluded-only reviews never advance the checkpoint. The local state
is authoritative; user-written PR comments cannot create a trusted checkpoint.
Incremental summaries state the exact reviewed range and refer to the previous
review. Incremental review reduces repeated work but is not a fresh full-PR
analysis; an explicit API rerun always starts a full review.

The service fetches PR commits as Git objects and checks out only the trusted
base commit. It never installs project dependencies or runs PR scripts. OCR
reads an immutable full or checkpoint range. Head/base are checked after fetch,
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
Job records expose `range`, `snapshot`, `progress` (session, range, coverage
completion and artifact directory), and a replacement job ID when pushes queue
behind a running snapshot. Logs include `review_range`, `checkpoint_saved` and
`reuse_completed_review` events. Per-PR checkpoints persist in `state.json`.
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

## Read-only monitoring dashboard

Run the independent monitor on the same Linux host as the review services:

```sh
node services/github-review/monitor.js /etc/ocr-review/monitor.json
# Equivalent npm entry point:
npm run service:monitor -- /etc/ocr-review/monitor.json
```

Copy `monitor.example.json` and adjust the OCR configuration path, volumes and
optional CR Agent state sources. Remove `cragent` when that service is not
installed. All configured state sources must be readable by the monitor user.
The GitHub token path is inherited from the OCR configuration; a token that can
read the configured repositories through GraphQL is required. Restart the
monitor after changing configuration. No dependencies need to be installed.
The supplied `ocr-monitor.service` is a systemd template with a 384 MB memory
limit, a CPU limit and a read-only filesystem except for its own analytics
directory (`StateDirectory`/`ReadWritePaths`). Adjust its user and executable
paths to the deployment. It is independent of `ocr-review.service`; starting or
restarting the monitor does not interrupt reviews.

Open `/` for the responsive dashboard. It refreshes local state every ten
seconds and current open PR heads/statuses through GitHub GraphQL every minute.
`GET /api/status` returns the same redacted snapshot; `GET /healthz` checks monitor
collection freshness. All other methods are rejected. No review, cancellation,
retry or configuration controls are exposed. The monitor reads state files
directly without constructing the mutating review `State` class.

The default listener is loopback. For direct access within a trusted private
network, bind `listen` to that host's private address and restrict port 8788 to
that network. PR titles, repository names and review metadata are visible to
anyone who can reach this listener. For public access, keep loopback binding and
use an authenticated HTTPS reverse proxy. Optional `bearerTokenFile` protects
every route for a proxy or API client that supplies the Authorization header;
the webpage does not store tokens or implement a login flow. GitHub tokens,
Codex credentials, review prompts, source snippets and raw errors are never
included in dashboard responses. PR metadata is rendered as text, never HTML.

GitHub results are matched to the current PR head. Missing OCR checks, including
historical PRs skipped by `bootstrapExisting: false`, stay explicitly unreviewed.
Code findings, execution failures, pending work and saved checkpoints have
separate labels. Local worker state is displayed separately from GitHub status.
The monitor preserves the last result on upstream failures and prominently
marks stale/unavailable sources. Root/data capacity, available system memory,
load, process uptime, cgroup memory and restart counts are collected from the
host. Service memory includes child processes and cgroup-accounted cache.

Configure `analytics.directory` as a separate writable directory and
`analytics.sessionDirectory` as the review service user's native
`$HOME/.opencodereview/sessions`. `retentionDays` defaults to 90 (7-366 allowed);
`timeZone` defaults to `Asia/Shanghai`, with calendar weeks starting Monday.
The ledger's time zone is immutable: use a new directory to change it and
backfill from available source logs. Omitting `analytics` keeps the legacy
24-hour final-report total and disables the additional panels.

Analytics incrementally reads all worker slots' native JSONL sessions, including
failed attempts and responses already returned by running reviews. It persists
only numeric aggregates, identifiers and cursors via an atomic, fsynced ledger;
prompts, source code, tool arguments, findings text and credentials are discarded.
Size the memory limit and retention for the repository's review volume; the
in-memory ledger grows with the number of retained jobs and sessions.
Retries and resumes have distinct session IDs. Publication retries reuse the
same session and do not duplicate token counts. An initial backfill processes
roughly 64 MB per collection (finishing the current file), with a visible pending
count. Each JSONL line is limited to 8 MB; skipped/malformed records and read or
persistence errors are visible, never silently presented as complete data.
Only run one monitor per ledger directory. Back up that directory for continuity.

The dashboard provides today/current-week/30-day/retained totals, daily and weekly
trends, phase token breakdowns, searchable PR totals and individual review-task
details (`GET /api/analytics/pr?repository=owner/repo&number=123`). Metrics include
input/output/cache tokens, requests/errors/tools, findings by severity, completion
rate, retries/resumes, file coverage/reuse, native runtime, initial queue wait,
and mean/P95 end-to-end duration. PR totals include closed PRs. The task ledger
survives the review service's shorter artifact retention and monitor restarts.

Metric boundaries:

- Tokens belong to the calendar day of each model response. Native OCR uses
  provider usage when available and may estimate it when absent; a failed request
  without usage cannot be billed accurately here. Cached tokens are a subset of
  input tokens, never added again. CR Agent usage is excluded.
- Completed/failed tasks, findings and end-to-end timing belong to task completion
  day. Completion rate excludes superseded tasks. Findings count the final report
  once per task, including checkpointed older heads; the same bug across commits
  can appear more than once. Latest PR findings identify the corresponding head;
  they are not a count of unresolved unique issues on GitHub.
- Native duration sums each finished session's wall time, including failed and
  resumed sessions. It does not sum internally parallel tool/LLM times. End-to-end
  duration includes queueing, preparation, retries and publishing. Historical
  first-queue wait is unknown when the first attempt was never observed.
- Backfill only covers retained source files. New service artifacts record an
  explicit repository/job/workspace identity. Older sessions use report session
  IDs or matching workspace/range/preparation timestamps; unmatched sessions stay
  in overall usage with an attribution warning. No historical numbers are invented.

These metrics are operational observations, not an invoice or subscription
allowance. The original 24-hour report card remains available for comparison;
it counts only final reports and therefore has a different scope.

## Development

```sh
node --test services/github-review/*.test.js
npm run test:github-actions
make check
```

The tests use real Git repositories and child processes, a real HTTP listener,
native OCR command contracts, mocked GitHub transport, and the shared production
comment publisher. No model credentials are needed for this suite.


### Incremental dispatch and budget recovery

Automated Agent and dispatcher submissions use incremental review. An administrator
can still explicitly request `fullReview`. A complete checkpoint with compatible
review settings, unchanged base and an ancestral head is required. Commit-specific
background text and budget changes do not invalidate that checkpoint; model, effort,
rule and base changes do. Incomplete snapshots never advance the checkpoint.

A clean checkpoint reviews the commit delta. If the checkpoint has findings, review
all PR diffs for newly changed files and previously flagged files, excluding only
unchanged files already covered by the checkpoint. Missing finding paths, unsafe
exclude patterns or unavailable Git history fall back to full coverage. The frozen
range and exclusion list are retained across retries.

Authorized budget escalation resumes the previous native session on the same
head/base, workspace and semantic configuration. Completed items and their findings
are reused; failed items are retried. A missing or incompatible native session falls
back to reviewing that frozen range. Budget ceilings and maximum attempts still
apply. The per-attempt budget is not a cumulative monetary spending limit.


### Persistent routing Agent sessions

The service stores one GoClaw session binding per repository, PR, Agent model,
endpoint and credential identity in `state.json`. Session bindings are retained
across process restarts and review-artifact cleanup. A tools-disabled bootstrap
captures the server-issued session key before any review dispatch. Subsequent
commit events reuse `session_key`; dispatch and feedback serialize per binding.
An unavailable existing session is surfaced as an error, never silently replaced.

Budget escalation and terminal attempt outcomes enter a durable feedback outbox.
The worker posts them into the bound session with `tool_choice: none` and stable
`client_message_id` values. Transport failures retry with backoff; authorization
or missing-session failures remain visible for operator reconciliation. Feedback
never calls submit/retry tools. Automated submissions also deduplicate by repository,
PR, head and base independently of profile and request ID. Explicit administrator
reruns remain available. Sent outbox entries follow artifact retention; pending and
failed entries are retained.
