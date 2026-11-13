# ReviewHub audit collector

The task service continues to own `state.db`. This independent process reads task state, native session streams and review artifacts, then publishes normalized repository, review, event, finding, usage and resource records directly to the same PostgreSQL database queried by ReviewHub. It never calls the old dashboard HTTP service, changes review configuration, starts reviews, or writes an audit SQLite/JSON ledger.

This collector does not manage any existing service. Starting it does not stop an old collector or dashboard. PostgreSQL failure affects collection only; ACK and review execution have no dependency on this process.

## Run

Requires Node >= 22.18, read access to the source files, and a PostgreSQL connection. The example paths match the existing deployment layout; verify them, the backend repository allowlist and the collector's organization boundary before use.

1. Deploy the matching ReviewHub change and run its migrations, including `004_audit.sql` and `005_client_audit.sql`.
2. In this directory run `npm ci --ignore-scripts`.
3. Copy `collector.example.json` to a deployment-owned file and set `ocrConfig`, `stateSource`, `organizations` and `analytics.sessionDirectory`. The existing backend `repositories` array is the repository allowlist; `organizations` restricts it further and does not enroll historical repositories. Organization and repository matching is case insensitive. Restart the process after changing either configuration.
4. Inject `REVIEWHUB_DATABASE_URL` and a stable `REVIEWHUB_SOURCE_ID` through a protected environment file. Do not put a connection string in the JSON config or commit it. Use TLS with certificate validation for remote PostgreSQL.
5. Run `node index.js /absolute/path/collector.json --once`, inspect the source status in ReviewHub, then run without `--once` for continuous collection. The first invocation of an empty/uninitialized task SQLite fails rather than publishing an empty successful snapshot.

`ocr-reviewhub-collector.service` is an example independent systemd unit. Use an installed Node binary accessible to its service account; do not assume `/usr/bin/node` exists. The service account needs read/traverse access to the configured task database and its WAL/SHM, runs, native sessions, backend config and existing GitHub App / Agent credential files. It does not need write access to task state. The audited production SSH account currently lacks these reads; this PR does not change its permissions or deploy the service.

The database writer needs `SELECT(version)` on `schema_migrations`, and `SELECT/INSERT/UPDATE/DELETE` on `audit_sources`, `collector_records`, `audit_repositories`, `audit_runs`, `audit_events`, `audit_findings`, `audit_usage`, `audit_resources`, `audit_client_attempts`, `audit_client_coverage`. It does not need identity/session/configuration tables or DDL. ReviewHub's API needs only `SELECT` on audit tables; existing identity/settings writes retain their existing grants. Apply role grants with the actual deployment schema. Avoid transaction-pooling proxies for this connection because its advisory lock is session scoped.

## First import and recovery

Optional `bootstrapAuditDatabase` points to the existing audit SQLite. On the first successful import only, the collector reads its retained jobs, sessions and audit events in a consistent read-only transaction. Alternatively, `bootstrapLedger` can import a retained version-2 analytics JSON ledger. Neither option writes those sources; after the first committed publication, PostgreSQL owns the collector's state. If both are supplied, audit SQLite is preferred. Omit these settings when no historical source exists; missing historical detail stays unavailable.

Task SQLite is always authoritative for current tasks. The reader captures a consistent epoch, revision and commit token and consumes changed keys/tombstones through that revision. History loss, source replacement or a divergent restored token triggers a full read-only snapshot. Reading is bounded to 64 MiB; oversized state fails with prior PG data retained. Newer native session lines use persisted offsets and the existing parser's partial-line/rotation handling. A bootstrap reads at most 64 MiB of retained row payloads.

A PostgreSQL advisory lock permits one writer per source ID. Publication, private recovery records and checkpoint commit in one transaction. Invalid batches and failed transactions never advance the cursor. Stable source/run/session identities make restarts and repeated reads idempotent. One session/day is counted once even if its file appears twice. Unchanged normalized records are not sent again during steady operation; restart safely replays a full normalized projection with conditional upserts. Records disappearing from source retention remain in PG for the 90-day audit window; current queue flags are cleared, and repositories outside the allowlist are hidden without deleting their history.

Default cycle: 300 seconds **after the previous cycle finishes**. There is no overlapping timer. Failures back off up to eight intervals (capped at one hour), preserve the last successful data and mark the source failed; reconnect resumes from the committed cursor. Verified repository metadata refreshes hourly; unverified or unavailable metadata retries after five minutes. Renames resolve only through bounded redirects to fixed repository IDs on the GitHub API origin, with ID and organization checks. Verified IDs are reused on subsequent refreshes, and configured old/new aliases converge on the same identity. UI refresh queries PostgreSQL only.

## Data meanings

- Repository membership comes only from the backend's explicit `repositories` entries within the collector's organizations. Configured `name` / `githubName`, verified GitHub IDs and saved rename aliases identify their historical records; task history and old snapshots cannot add extra members. GitHub fixed ID is attached when verified; otherwise an explicit unmatched local ID is retained. Removed repositories are hidden through `in_scope`, while their identity registry and retained audit history survive re-enrollment. Access is `unknown` on verification failure and `unavailable` on a confirmed 404. This is audit metadata, not a user permission decision. No OCR enablement is inferred from a default branch or an old run.
- Backend persisted admission is separate from client ACK, execution, verdict and publication. Historical jobs are not fabricated as ACK receipts. Optional Policy logs provide client ACK outcomes; only explicit stored reasons count as stage timeouts. Unsupported metrics remain null.
- Native input + output is the known total. Cache counters are separate, not added twice. Retry/resume sessions count once. Only exact report attribution links native usage to a run; unattributed usage remains repository/PR scoped. Finding text comes from retained validated results, never model summaries invented by the collector.
- Agent session-tree counters are PR-scoped cumulative observations (`timeBasis=observed_total`). ReviewHub labels them as current cumulative values outside date filtering; they are not distributed into daily trends or review rounds. Cache breakdown is unknown. Native day buckets use `Asia/Shanghai`; timestamps are UTC.
- Host CPU is the interval average between samples (first sample unknown); memory and task queue are observed samples. They are not attributed to a repository. Task source time and collection time are distinct. Source errors and staleness never turn missing data into zero.
- PostgreSQL `collector_records` is source-private recovery state, never a Web/API response. Keep its DB role restricted. Normalized responses contain no raw session messages, task background prompts or credentials.

## Policy ACK collection

Set `policy.enabled` to `true` only after granting the configured GitHub App **Actions: read** on the target repositories. No CI callback endpoint or new CI secret is needed. The App credential is reused by this independent process, never returned through ReviewHub. Defaults are a 90-day lookback, 80 HTTP requests and a 60-second scheduling budget per collection cycle; each request also has a 15-second timeout. An in-flight request can finish after the scheduling budget. The outer interval remains 300 seconds after completion.

The collector discovers `pull_request_target` runs named `OCR Dispatch` or `OCR Code Review`, independently of backend tasks. `policy.workflowNames` can explicitly override the names. It reads the single `OCR dispatch` job per attempt. Runs and each `run_attempt` are separate identities. Completed logs are not downloaded again; failed reads back off, and paged discovery checkpoints survive restart.

Set `policy.telemetrySince` to the actual UTC deployment time of structured client logging to avoid downloading older logs. It defaults to null for compatibility; do not invent a date for an unverified deployment. Existing pending first attempts before that date become `before_telemetry_start` records and leave the queue; their identities and existing review history remain. Already collected results are preserved. Older rerun attempts still have their actual start time checked before any log download. This change does not alter task-state or usage retention.

With a telemetry start, new-run discovery continues from the last completed scan with a five-minute overlap. Recent logs are processed first. A separate, lower-priority metadata scan detects reruns of older runs; it repeats no sooner than `policy.rescanSeconds` (default 3600, range 300–86400) after its previous pass. It only queues eligible attempts, never downloads pre-telemetry logs, shares the same request/time budget, and can span cycles. Reruns whose original run was created before the configured lookback remain outside discovery coverage. Without a telemetry start the existing full retained-window discovery behavior is preserved.

Discovery rotates across repositories, limits requests and splits time windows when GitHub's 1,000-result search cap is reached. Actions errors preserve prior client data and do not prevent the independent SQLite task projection from publishing. Scan/log progress and normalized records commit in the same PG transaction. Raw logs are bounded to 8 MiB and are not persisted. Signed log downloads never receive the GitHub API authorization header.

Only `ocr-policy-telemetry/v1` lines with matching repository, run attempt and deterministic PR snapshot identity are parsed. Final ACK timeout, individual HTTP timeout, accepted ACK, policy skip, failure, cancellation and unknown are distinct. Missing, conflicting or legacy logs do not imply timeout or success. Temporary API/download failures remain pending with backoff, distinct from successfully read logs that contain no result. Cycle logs report the request budget used, completed downloads, pending entries, pre-telemetry entries and missing results without raw logs or credentials. Backend receipt generations/reuse are correlated by snapshot, not assumed to be one-to-one with a CI run. Legacy receipts without a generation remain unnumbered. Backend admission, Agent dispatch and native execution timeouts require explicit reasons; zero is not inferred from absent history.

Roll out ReviewHub migration 005 and grants before the new Worker, then publish both Policy clients. Run a real target-repository workflow and compare its run/attempt and snapshot with PG and the API. The native execution termination reason in `services/github-review` requires a separate deployment of the original task service; updating only this collector does not add that field to historical tasks. Do not restart the task service as part of a collector-only rollout. The new code was tested locally; the production App permission, new client logs and runtime reason instrumentation have not been deployed or verified by this change.

API references: [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository) and [job logs](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run).

## Contract and tests

`audit-ingestion-v1.schema.json` is generated from ReviewHub's `packages/contracts/src/audit.ts`, not independently edited. For a contract update, build ReviewHub contracts, run `node packages/contracts/export-audit-schema.mjs`, format and copy the schema here. Deploy migration compatibility before starting the writer; startup fails clearly without the required migration.

```sh
npm test
TEST_DATABASE_URL=postgres://.../reviewhub_test \
REVIEWHUB_MIGRATIONS_DIR=/absolute/path/ReviewHub/packages/database/migrations \
npm run test:integration
```

The integration suite creates and cleans its own random schema using the actual ReviewHub SQL migrations. It covers transaction failure and retry, restart deduplication, retained history, writer exclusion and schema mismatch. The original collector regression suite remains `node --test services/github-review/*.test.js` from the repository root. Runtime dependencies are scoped to this service: `pg` is the PG writer, `ajv` + `ajv-formats` validate the shared wire contract; the existing task service gains no package dependency.

Production rollout is a separate verification: compare a selected repository/PR and native/Agent totals, exercise PG interruption and restart, confirm source freshness, then decide when old consumers can be retired. This PR does not claim that production PostgreSQL, source grants or the live comparison have been verified.
