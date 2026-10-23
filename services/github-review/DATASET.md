# Review observations dataset

The monitor writes append-only, daily JSONL files under `<analytics.directory>/dataset/`.
Each record contains schema `ocr-dataset/v1`, a deterministic `eventId`, observation timestamp,
record kind, `labelStatus: unvalidated`, and selected structured data. Deduplicate exports by
`eventId`. Repeated polling does not append an unchanged observation. State transitions create
new observations. Initial observations may describe historical jobs; `observedAt` is ingestion
time, not execution time. Files are local and are not automatically uploaded or expired.

Kinds:
- `dispatch`: ingress, repository/PR/head/base, job correlation, requested and actual routing,
  fallback/reuse, model/profile/effort/budget, incremental range, attempts, coverage and timeline.
- `ocr_run`: OCR session usage, cache usage, elapsed/queue time, retries, resumed sessions,
  severity distribution and coverage. Missing source sessions remain explicitly incomplete.
- `review_result`: retained findings with path, line, severity, category and text; repository,
  PR/head/base, model and profile. Human outcome remains null until independently validated.
- `agent_usage`: latest platform-reported input/output counters per exactly bound PR session.
  These are cumulative snapshots, not additive usage events. For a repository total, take the
  latest observation per binding ID; do not sum snapshots. Counters may reflect upstream
  session lifecycle behavior and are not a billing statement. Unbound sessions are excluded.

Request payloads, authentication headers, tokens, and session access keys are not exported.
Common token patterns in finding text are redacted. Finding text is still private repository
material: review/redact an export before sending it outside the authorized environment.

The dataset is observational, not ground truth. A model finding or successful CI run does not
prove correctness. Human acceptance/rejection, fix linkage, false-positive adjudication and
post-merge outcomes require a separate labeling step. Source reports removed before collection
cannot be reconstructed. Monitor health exposes dataset write errors and Agent usage staleness.

Agent usage now follows `/v1/agent-chat/session-children` recursively, including
pagination, and sums each reachable session's own input/output counters once.
`components` contains hashed session identities, depth and counters;
`childInputTokens`, `childOutputTokens` and `childSessions` expose the child share.
Repeated polls replace cumulative observations; do not sum snapshots across time.
Traversal failures, missing counters, cycles or cross-PR attribution conflicts
retain the previous snapshot and flag an error instead of publishing partial totals.
Coverage is limited to bound PR roots and child sessions visible to the API credential;
deleted/inaccessible history or legacy unlinked tasks cannot be inferred as zero.
Native OCR worker usage remains in `ocr_run`, separate from InsightFlow sessions.
