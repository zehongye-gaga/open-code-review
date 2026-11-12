# ReviewHub audit collector

The task service continues to own `state.db`. This independent process reads task state, native session streams and review artifacts, then publishes normalized repository, review, event, finding, usage and resource records directly to the same PostgreSQL database queried by ReviewHub. It never calls the old dashboard HTTP service, changes review configuration, starts reviews, or writes an audit SQLite/JSON ledger.

This collector does not manage any existing service. Starting it does not stop an old collector or dashboard. PostgreSQL failure affects collection only; ACK and review execution have no dependency on this process.

## Run

Requires Node >= 22.18, read access to the source files, and a PostgreSQL connection. The example paths match the existing deployment layout; verify them and the organization allowlist before use.

1. Deploy the matching ReviewHub change and run its migrations, including `004_audit.sql` and `005_client_audit.sql`.
2. In this directory run `npm ci --ignore-scripts`.
3. Copy `collector.example.json` to a deployment-owned file and set `ocrConfig`, `stateSource`, `organizations` and `analytics.sessionDirectory`. Organization matching is case insensitive. Restart the process after changing configuration.
4. Inject `REVIEWHUB_DATABASE_URL` and a stable `REVIEWHUB_SOURCE_ID` through a protected environment file. Do not put a connection string in the JSON config or commit it. Use TLS with certificate validation for remote PostgreSQL.
5. Run `node index.js /absolute/path/collector.json --once`, inspect the source status in ReviewHub, then run without `--once` for continuous collection. The first invocation of an empty/uninitialized task SQLite fails rather than publishing an empty successful snapshot.

`ocr-reviewhub-collector.service` is an example independent systemd unit. Use an installed Node binary accessible to its service account; do not assume `/usr/bin/node` exists. The service account needs read/traverse access to the configured task database and its WAL/SHM, runs, native sessions, backend config and existing GitHub App / Agent credential files. It does not need write access to task state. The audited production SSH account currently lacks these reads; this PR does not change its permissions or deploy the service.

The database writer needs `SELECT(version)` on `schema_migrations`, and `SELECT/INSERT/UPDATE/DELETE` on `audit_sources`, `collector_records`, `audit_repositories`, `audit_runs`, `audit_events`, `audit_findings`, `audit_usage`, `audit_resources`, `audit_client_attempts`, `audit_client_coverage`. It does not need identity/session/configuration tables or DDL. ReviewHub's API needs only `SELECT` on audit tables; existing identity/settings writes retain their existing grants. Apply role grants with the actual deployment schema. Avoid transaction-pooling proxies for this connection because its advisory lock is session scoped.

## First import and recovery

Optional `bootstrapAuditDatabase` points to the existing audit SQLite. On the first successful import only, the collector reads its retained jobs, sessions and audit events in a consistent read-only transaction. Alternatively, `bootstrapLedger` can import a retained version-2 analytics JSON ledger. Neither option writes those sources; after the first committed publication, PostgreSQL owns the collector's state. If both are supplied, audit SQLite is preferred. Omit these settings when no historical source exists; missing historical detail stays unavailable.

Task SQLite is always authoritative for current tasks. The reader captures a consistent epoch, revision and commit token and consumes changed keys/tombstones through that revision. History loss, source replacement or a divergent restored token triggers a full read-only snapshot. Reading is bounded to 64 MiB; oversized state fails with prior PG data retained. Newer native session lines use persisted offsets and the existing parser's partial-line/rotation handling. A bootstrap reads at most 64 MiB of retained row payloads.

A PostgreSQL advisory lock permits one writer per source ID. Publication, private recovery records and checkpoint commit in one transaction. Invalid batches and failed transactions never advance the cursor. Stable source/run/session identities make restarts and repeated reads idempotent. One session/day is counted once even if its file appears twice. Unchanged normalized records are not sent again during steady operation; restart safely replays a full normalized projection with conditional upserts. Records disappearing from source retention remain in PG for the 90-day audit window; current queue flags are cleared, and repositories outside the allowlist are hidden without deleting their history.

Default cycle: 300 seconds **after the previous cycle finishes**. There is no overlapping timer. Failures back off up to eight intervals (capped at one hour), preserve the last successful data and mark the source failed; reconnect resumes from the committed cursor. Repository metadata refreshes at most hourly. UI refresh queries PostgreSQL only.

## Data meanings

- Repository metadata comes from configured organization repositories and known historical source names. GitHub fixed ID is attached when verified; otherwise an explicit unmatched local ID is retained. A rename updates aliases on that same record. Access is `unknown` on verification failure and `unavailable` on a confirmed 404. This is audit metadata, not a user permission decision. No OCR enablement is inferred from a default branch or an old run.
- Backend persisted admission is separate from client ACK, execution, verdict and publication. Historical jobs are not fabricated as ACK receipts. Optional Policy logs provide client ACK outcomes; only explicit stored reasons count as stage timeouts. Unsupported metrics remain null.
- Native input + output is the known total. Cache counters are separate, not added twice. Retry/resume sessions count once. Only exact report attribution links native usage to a run; unattributed usage remains repository/PR scoped. Finding text comes from retained validated results, never model summaries invented by the collector.
- Agent session-tree counters are PR-scoped cumulative observations (`timeBasis=observed_total`). ReviewHub labels them as current cumulative values outside date filtering; they are not distributed into daily trends or review rounds. Cache breakdown is unknown. Native day buckets use `Asia/Shanghai`; timestamps are UTC.
- Host CPU is the interval average between samples (first sample unknown); memory and task queue are observed samples. They are not attributed to a repository. Task source time and collection time are distinct. Source errors and staleness never turn missing data into zero.
- PostgreSQL `collector_records` is source-private recovery state, never a Web/API response. Keep its DB role restricted. Normalized responses contain no raw session messages, task background prompts or credentials.

## Policy ACK collection

Set `policy.enabled` to `true` only after granting the configured GitHub App **Actions: read** on the target repositories. No CI callback endpoint or new CI secret is needed. The App credential is reused by this independent process, never returned through ReviewHub. Defaults are a 90-day lookback, 80 HTTP requests and a 60-second scheduling budget per collection cycle; each request also has a 15-second timeout. An in-flight request can finish after the scheduling budget. The outer interval remains 300 seconds after completion.

The collector discovers `pull_request_target` runs named `OCR Dispatch` or `OCR Code Review`, independently of backend tasks. `policy.workflowNames` can explicitly override the names. It reads the single `OCR dispatch` job per attempt. Runs and each `run_attempt` are separate identities. Completed logs are not downloaded again; failed reads back off, and paged discovery checkpoints survive restart. Full retained-window scans repeat to detect reruns of older runs. Reruns whose original run was created before the configured lookback are outside discovery coverage. Large backfills can take multiple cycles and delay discovery of new runs; the UI reports the completed scan boundary instead of claiming current completeness.

Discovery rotates across repositories, limits requests and splits time windows when GitHub's 1,000-result search cap is reached. Actions errors preserve prior client data and do not prevent the independent SQLite task projection from publishing. Scan/log progress and normalized records commit in the same PG transaction. Raw logs are bounded to 8 MiB and are not persisted. Signed log downloads never receive the GitHub API authorization header.

Only `ocr-policy-telemetry/v1` lines with matching repository, run attempt and deterministic PR snapshot identity are parsed. Final ACK timeout, individual HTTP timeout, accepted ACK, policy skip, failure, cancellation and unknown are distinct. Missing, conflicting or legacy logs do not imply timeout or success. Backend receipt generations/reuse are correlated by snapshot, not assumed to be one-to-one with a CI run. Legacy receipts without a generation remain unnumbered. Backend admission, Agent dispatch and native execution timeouts require explicit reasons; zero is not inferred from absent history.

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

Production rollout is a separate verification: compare a selected repository/PR and native/Agent totals, exercise connection failure and restart, confirm source freshness, then decide when old consumers can be retired. The initial live deployment is recorded below; it does not authorize retiring existing consumers.

## Live deployment, 2026-11-12

Commit `1d6e15b3facf7b7099492ddc6a05fb52aeb16d8f` was deployed to an independent release directory on the source host, using Node 22.23.1 and locked dependencies. Only the new `ocr-reviewhub-collector.service` was enabled/restarted. The task service, old collector, dashboard, their release links and original configuration were retained.

The host uses a root process with a read-only system filesystem and explicit read-only source paths, an empty capability set, `NoNewPrivileges`, private temporary files/devices, half-core CPU quota, 768 MiB memory limit and idle I/O priority. This avoids expanding the existing audit SSH account's source-file privileges. The first import peaked at 167.9 MiB; the first persistent cycle peaked at 194 MiB. The interval remains 300 seconds after each completed cycle.

The `reviewhub_collector` database role was verified to read/write only the eight audit/recovery tables and read the migration version column. Queries against users, operator sessions and platform settings were rejected; schema creation was denied. The operator explicitly approved the existing private-network PG endpoint without TLS for this rollout, so no database network/authentication configuration or service restart was needed. Credentials are stored in a deployment-owned 0600 environment file and are not included here.

At `2026-11-12T11:41:26.291Z`, the first snapshot published 30 current/historical repositories, 3,398 reviews, 13,017 events, 1,616 findings and 4,554 usage records. The next process resumed incrementally with 18 changed source rows and one real new task, producing 3,399 reviews without duplicate snapshots or missing prior records. Restarting only this Worker resumed with four changes and retained the same review count.

The ReviewHub database query layer and response schemas successfully read repository lists, paginated reviews/findings/usage, PR details and all 30 repository summaries. Global counts and native/Agent token totals matched the sum of the same-window repository queries. For `lexmount/lex-voice#296`, source task `1791879625395`, the retained source's two native sessions totaled 643,017 input + 3,267 output = 646,284 tokens, matching PG.

A separate one-shot process targeting an unreachable loopback PG port failed as expected while the task service health remained healthy with active work. The real PG service was not interrupted. The original three services retained their PIDs and zero restarts throughout these checks.

Three GitHub metadata requests failed with `fetch failed` and remain explicitly unverified; missing native usage remains unknown. This rollout does not establish personal GitHub authorization, configuration application, Policy client ACK metrics, full historical completeness, real database-outage recovery, or backup restoration. Automatic tests continue to use a separate test database, not production credentials.
