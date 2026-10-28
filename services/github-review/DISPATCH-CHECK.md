# Opt-in dispatch admission check (not deployed)

`infrastructure.dispatchCheck: { "enabled": true }` enables the separate `ocr-dispatch` commit status. It is disabled when omitted. The existing `ocr-review` status and organization-CI contract remain unchanged. Do not change production Rulesets before deploying and validating the publisher separately.

## Meaning

Success means the backend has a persisted admission record for the current PR's head SHA, base SHA and base ref, or a matching persisted native job. It does not mean a model has finished or findings passed. A dispatch failure without another valid admission fails the check; a review or publication failure after dispatch does not change the admission promise. No Actions runner or native model is needed to publish this status.

Signed App ingress and authenticated CI ingress register a durable watch after saving admission. The dispatcher checks GitHub's current PR coordinates and reconciles independently of review workers. Status failures retry after restart using separate persisted state. Immutable admission proofs survive job artifact retention; explicit failed admissions revoke their proof. Existing historical deliveries without a base ref cannot grant this new check a pass.

Statuses are SHA-scoped. Open sibling PRs sharing the SHA across all head branches and forks are checked together; any unaccepted or ineligible sibling blocks success conservatively. Old-head/closed entries fail and retire until a new observation. Retargeting between refs with identical SHAs is treated as a new snapshot. Out-of-order webhook payloads are never authoritative over the live PR lookup.

## Platform boundary

GitHub commit statuses cannot atomically bind success to a PR's current base branch. Immediately after a base change, the old green SHA status can remain visible until the event is received and a new status is written. GitHub status API failures can also prevent invalidation. The test deliberately records this old-green interval before the isolated backend reconciles it.

The implementation prevents stale success after successful reconciliation, not instantaneous invalidation when a user edits GitHub. It has not been tested as an enforced organization Ruleset: existing production rules are unchanged. If zero stale-green window is required, do not replace the required workflow with this SHA-based gate; evaluate a separately enforced merge-time strategy first. A webhook check cannot provide an atomic merge decision.

## Administrator handoff

1. Keep current rules in place while this feature is unmerged/undeployed. Back up both organization Rulesets and their scopes/bypass settings.
2. Deploy the publisher in an approved future rollout, enable the feature, and confirm `ocr-dispatch` is reported by **Lexmount OCR**, App ID **5475476** (`lexmount-ocr`). Do not use a PAT or select "any source".
3. Pilot in an isolated repository Ruleset. Under **Require status checks to pass before merging**, select `ocr-dispatch` and the expected App. If the App/source is not selectable, stop and resolve it; do not weaken the source restriction.
4. Test real merge blocking for missing/failed checks, successful admission, unchanged-SHA base retargets, out-of-order events, restart and sibling PRs. Explicitly assess the asynchronous invalidation window above.
5. Only after acceptance, replace the OCR **Require workflows to pass before merging** rule. Organization rule `OpenCodeReview` ID 25713328 references `lexmount/github-policy/.github/workflows/ocr-code-review.yml`; public rule `OpenCodeReview-Public Repo` ID 25846739 references `lexmount/github-policy-public/.github/workflows/codex-code-review.yml`. Preserve repository/branch targeting, bypass actors and unrelated build/test/review/linear-history requirements.
6. Leave `ocr-review` advisory if the intended policy is admission only. Requiring it would wait for the review and block on findings, which is a different policy.
7. Rollback: restore the original required OCR workflow before removing `ocr-dispatch` enforcement; trigger the workflow using a supported event. Never leave both protections absent.

## Reproduction

Run Node tests and `make check` / `make test`. `scripts/validation/dispatch-gate-live.js CONFIG ISOLATED_STATE PR OPERATION EXPECTED --live-test` only targets `lexmount/OCR-Test-Public` PRs between `test/dispatch-gate-*` branches. The state directory basename must begin `dispatch-gate-test-`. It opens a loopback-only temporary HTTP ingress, uses real GitHub reads/status writes, signs local test events, and starts no review workers. Operations are `admit`, `verify`, `late`, and `fail` (the last mutates isolated state only). Retarget the PR through GitHub between invocations. Each invocation reconstructs the service, exercising persisted recovery.
