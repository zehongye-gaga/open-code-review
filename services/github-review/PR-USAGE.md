# Per-PR usage API

`POST /v2/get_pr_usage` (also exposed as the read-only MCP tool `get_pr_usage`).
Use the existing Bearer credential. Reader, dispatcher, Agent and administrator credentials retain their existing repository scopes. The request never starts a review or calls a model.

```sh
curl --fail-with-body "$OCR_API_BASE/v2/get_pr_usage" \
  -H "Authorization: Bearer $OCR_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"repository":"lexmount/mem-platform","pull_number":53,"offset":0,"limit":20}'
```

Required: `repository`, `pull_number`. Optional: `offset` (default 0), `limit` (1-100, default 20). `next_offset` is null at the last page. PR totals are independent of task pagination. An authorized PR without retained jobs returns `job_count: 0` and null usage; this does not claim that the PR does not exist.

The versioned response (`schema: ocr.pr-usage/v1`) contains:

- `native`: known input/output/total/cache tokens, summed native `execution_ms`, report count, missing token reports, jobs with pending/missing reports, and report scan availability.
- `agent`: separately collected PR routing-session token counters, observation time and `stale`. Optional server configuration `prUsage.agentUsageFile` points to the existing monitoring collector's `agent-usage.json`. No cache means unavailable, not zero.
- `jobs`: head/base SHA, target branch, state, profile/model, requested/effective budget, timestamps, `wall_ms`, finding/blocking counts, completeness, summary URL, operator retry/budget upgrade/fresh recovery counts, usage and invocation reports.
- `reports`: opaque report ID, native session ID, report status, preparation time, tokens, native elapsed milliseconds, reviewed files, resume flag and budget-exhaustion flag. No server paths, credentials, PR text or finding bodies are returned.

## Accounting contract

Native report counters are per CLI invocation, not cumulative session counters. Sum distinct report files across retries and resume invocations, even when they share a session ID; never count multiple references to the same file twice. Publication retries that reuse a report add no model usage. Prior attempts are discovered through the persisted metadata job ID and checked against the job snapshot.

Cache-read/write tokens are breakdowns, not extra tokens to add to the total. Unknown metrics are null. Partial totals sum only known metrics, and coverage fields must be checked. This endpoint reports retained native evidence, not guaranteed lifetime or provider billing totals. Purged reports, calls still running, provider failures without usage, and crash-lost reports cannot be reconstructed by this API. It does not estimate currency costs.

`execution_ms` sums native invocation duration. `wall_ms` runs from job creation to its latest terminal update (or now for queued/running jobs); it includes queues, backoff and operator pause time. `latest_started_at` is the most recent attempt, not the first one. Agent counters cover the cached PR session tree, including routing and feedback, and must not be attributed to a single commit. Native and Agent totals are deliberately not combined.
