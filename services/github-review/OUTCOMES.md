# Review outcome contract

`outcome.js` is the shared interpretation of a persisted job. The executor, organization-CI receipt, alert collector, Agent feedback, infrastructure API and dashboard data adapter consume it. Queue lifecycle (`job.state`) remains compatible with stored tasks; `outcome.kind` describes the actual result.

| Outcome | GitHub status | Execution alert | Recovery |
| --- | --- | --- | --- |
| queued / running / retrying | pending | No | Existing backend job owns execution |
| complete | success | No | Reuse the completed snapshot |
| blocked | failure | No by default | Code findings, not an execution failure |
| skipped | success, explicitly labelled skipped | No | Do not rerun a zero-item result |
| execution_failed | failure | Yes after retries finish | Existing execution retry policy |
| publication_failed | failure | Yes after retries finish | Reuse verified complete/skipped artifacts; retry publication |
| cancelled / superseded | failure, explicitly labelled | No | Do not resume obsolete work automatically |
| dispatch_failed | failure | Yes | Dispatch retry policy, before a backend job exists |

A normal native skip requires a valid zero-item native manifest and a published skip result. An explicitly authorized policy skip remains subject to `allowSkip`. Unknown or incomplete native evidence is not silently treated as a successful review.

## Ownership and timing

1. Ingress persists a receipt and attaches a job using the existing repository/PR/head/base identity. A second ingress reuses the job.
2. Native progress validates coverage. The executor records the phase (`preparation`, `review`, `publication`) and preserves artifacts for retries.
3. CI refresh validates that the PR snapshot is still current, then consumes the job outcome **before** applying receipt timeouts. A completed job is not converted into a failure because polling arrived late.
4. The n8n heartbeat watchdog applies while no backend job has been attached. Once attached, the backend worker/retry queue owns progress; the existing total execution deadline remains enforced.
5. n8n consumes `terminal` and `commit_status`; Policy and Ruleset need no schema changes. GitHub status publication failures remain retryable by the watchdog without starting another review.
6. Alerts use the same job outcome. Legacy completed records missing newer evidence do not generate new historical alerts. Failed ingress records cannot override a verified completed job.

GitHub Commit Status has no `skipped` value. A normal skip therefore uses `success` with `OCR skipped: no reviewable items`; this is not a claim that code was reviewed.

## Validation

Run `node --test services/github-review/*.test.js` and `make check`.

Isolated GitHub integration PR: https://github.com/lexmount/OCR-Test-Public/pull/12

The integration test uses a dedicated target branch outside production routing, separate backend state, real Git fetches and GitHub App status/Review writes, and deterministic native-result fixtures. Model failures and GitHub publication failures are injected. No model or Feishu webhook is called by these test cases. Intentional failing `ocr-state-test/*` statuses demonstrate error handling rather than production incidents.

Cases: normal skip, clean completion, blocking findings, successful publication retry, exhausted publication retry, execution failure, lost tracker with an accepted job, cancellation, and an expired execution deadline while the PR API is unavailable. Duplicate CI submissions retain one job. A publication retry retains one native execution.

## Rollout and rollback

Stage the service, alert collector and their shared outcome module together. Preserve configuration, state storage, credentials, n8n, Policy and Ruleset. Wait for an idle worker window before switching the release pointer; keep previous release pointers and a state backup. If a job arrives during the cutover check, abort the rollout and keep the old release running.

Rollback switches code pointers to the previous releases. Do not restore an old state file over newly accepted tasks. Terminal receipts created by this version remain compatible with the preceding skipped-state release.
