# Durable review control plane

The backend owns dispatch after durable admission. GitHub App deliveries and organization-CI receipts share one bounded, oldest-first dispatcher and a per-PR exclusion key. Workers own execution; a separate publication retry allowance reuses completed native artifacts. n8n only preserves the signed payload or authenticated CI coordinates, forwards a request, validates the acknowledgement, and responds. Transport timeouts never select the fallback reviewer.

## Contract and compatibility

The `ocr-ci/v1` coordinate schema remains unchanged. Receipt responses add `contract_version: 2`, `acceptance: accepted`, and `scheduler: backend`. A Policy workflow confirms durable admission independently of the eventual review verdict. The separate `ocr-review` status remains advisory unless a Ruleset explicitly requires it. Existing CI clients and the old n8n tracking loop can coexist during rollout; `ci_tick` remains a status/heartbeat compatibility endpoint but no longer owns dispatch.

The shared outcome contract covers queued, running, retrying, complete, blocked, skipped, execution_failed, publication_failed, cancelled, superseded and dispatch_failed. Only typed `PR_SNAPSHOT_CHANGED` errors mean supersession. Configuration conflicts and authorization failures remain failures. Snapshot reuse checks policy version, verdict threshold, provider/model, exclusions and rule/tool resource digests. Agent profile effort choices do not create duplicate automated jobs for an unchanged snapshot.

Explicit GitHub Actions reruns pass `retry_key = run_id:run_attempt`. A new key with attempt >= 2 may reopen a failed receipt that never acquired a job; duplicate keys cannot repeat that recovery. Superseded receipts are not revived. Failed native jobs retain the existing authorized `retry_review` operation and their original artifacts.

## Budget and session recovery

Production uses `budgetRetry.mode: unlimited` with explicit `allowUnlimitedBudget: true`. A finite Agent-selected budget that is exhausted switches directly to `budget: 0`; the original requested budget is retained. The budget override records time, requested actor, old/new budget and original session ID. It does not require an intermediate 1m/2m/4m sequence. Total execution deadlines and publication retry limits still apply.

Compatible native sessions always resume. When a session is missing/incompatible or native OCR explicitly rejects loading it, one automatic full-review recovery is allowed for the still-current snapshot. Recovery is recorded durably before starting a fresh native run. A second full-review recovery requires operator action. Transient model/network errors do not themselves authorize a fresh run. Changed PR snapshots are superseded, not restarted.

`resumeFallbacks` records the cause, old session, immutable coordinates, requested/effective budget, new session report usage, elapsed time and report directories. `extraTokens` sums observed native report totals once per new session; missing usage remains null. These are reported token counts, not a billing estimate. The Agent feedback outbox and review-result API expose the recovery records for subsequent budget-policy analysis.

## Historical reconciliation and alerts

Only old receipts with `review_incomplete_or_failed` or `n8n_tracking_stalled` and a verified completed/blocked/skipped backend job are eligible for reconciliation. The backend checks the current PR snapshot before changing the receipt. Obsolete snapshots become superseded; current snapshots consume the verified outcome. The previous state and publication are preserved in `reconciliation`. Incomplete evidence never becomes a pass.

Job failure notifications use stable job/outcome identity, independent of `startedAt` and retry attempt. Existing sent/baselined alert keys migrate to the stable identity before collection, preventing historical floods. This intentionally sends at most one failure notification per job; notification network retries remain at-least-once.

## Deployment and rollback

1. Run service tests, Policy tests and the Python-client/HTTP-backend contract test (`OCR_POLICY_CLIENT` can point to a separate Policy checkout). Run `make check` and `make test`.
2. Use `scripts/validation/control-plane-live.js CONFIG PR_JSON NEW_OUTPUT_DIRECTORY --live-test` against an isolated `OCR-Test-Public` PR targeting `test/control-plane-base-*`. It uses separate state and `ocr-control-test/*` contexts, real Git fetch/status/review APIs, deterministic native reports and injected failures. It never sends Feishu messages. Fixture cases are not model-quality validation.
3. Stage an immutable backend release and keep the old code/config pointers. Switch only after running/queued jobs and pending/active dispatches are empty. Deploy backend before Policy clients and n8n.
4. Generate the n8n candidate with `withBackendControl(exportedWorkflow)`. Preserve credential references, signed bytes and CI token forwarding. Publish only after backend admission/recovery tests pass.
5. Verify the deployed file hashes, health, an actual webhook/CI admission and final status. Record all release identifiers and test PRs.

Rollback must restore the matching old n8n polling workflow before the old backend; an old backend with the transport-only workflow cannot dispatch CI receipts. Restore code/config pointers, never overwrite current state with an old backup. Preserve all tasks accepted after cutover. Agent budget history and recovery fields are additive state fields.
