# Optional GitHub admission reconciliation

This feature is **disabled by default**. It is staged code, not a production configuration change. Existing GitHub webhooks, Policy CI, native polling, and Gitea retain their behavior when the option is absent.

When an Actions POST never reaches n8n, neither a local task table nor webhook history can reveal that missing PR by itself. The scanner reads **current open PRs from GitHub**, including pagination, and compares their repository/PR/head/base/base-ref identity against durable CI receipts, native jobs, and pending/failed admitted deliveries. It stores the latest observed snapshot per PR in `admissionSnapshots` using the existing state store (SQLite in production). Scan timing and counters are persisted in `admissionReconciliation`, so a restart does not immediately rescan everything. No second process or database writer is introduced.

## Staged configuration

Add this top-level configuration only when ready to test activation:

```json
{
  "admissionReconciliation": {
    "enabled": true,
    "mode": "observe",
    "intervalSeconds": 900,
    "graceSeconds": 300,
    "maxAdmissionsPerScan": 10,
    "repositories": ["lexmount/ocr-test-public"]
  }
}
```

`observe` records gaps without submitting work. `repair` submits missing snapshots through the existing durable OrgCI admission method, using the Agent route and its existing fallback policy. It never calls n8n, forges webhook signatures, or changes required checks. Each submission performs a fresh authenticated PR read before acceptance. The existing scheduler deduplicates jobs and handles review/resume; this scanner does not directly execute reviews.

- Default interval: 15 minutes; minimum: 5 minutes. A round is sequential, does not overlap, and rotates repository ordering. Its next due time is at least one interval after completion.
- Grace: at least 5 minutes by default from first observing a missing snapshot. Because scans run every 15 minutes, recovery normally takes about **15-30 minutes**, plus API and queue delays, rather than exactly 5 minutes.
- Up to 10 new acceptances per round by default. Excess gaps stay visible for later rounds.
- GitHub rate-limit responses delay the next round. Repository errors are logged and isolated; incomplete listing never removes unvisited snapshots. A hard 100-page ceiling bounds pathological lists.
- Only explicitly configured repositories are scanned. An optional subset must belong to that list; organization-wide discovery is not automatic. This version follows the existing `lexmount` Policy CI contract, including open draft and stacked PRs, without native-webhook base-branch restrictions.
- Matching receipts (including failed ones) and completed/failed native jobs count as already handled. The scanner does not reset retry exhaustion or rerun findings. A missed reopen may reaccept a receipt previously superseded because the PR was closed, subject to the existing reopen guards. If those guards leave it superseded, the row is marked `reopen_blocked` and does not consume the recovery budget.
- Matching pending or failed admitted webhook deliveries remain owned by their existing scheduler; historical delivery records only retain head/base SHAs, so their ownership check conservatively uses those SHAs. Preview, cancelled, and superseded native jobs do not satisfy review admission.
- Closing a PR removes its observed row after a successful full list; cancellation of existing work remains with the existing lifecycle checks.
- Persistence failures propagate as fatal errors. The scanner cannot guarantee recovery while GitHub itself is unreachable.

## Audit and limits

Logs: `ci_reconciliation_scan`, `ci_reconciliation_accepted`, and `ci_reconciliation_failed`. Rows retain first/last observation, missing-since time, canonical request ID, owner, status, and acceptance/recovery time. A committed receipt awaiting background verification is marked `verification_pending`; scan admission counts refer to durable acceptance, not a verified or completed review. Such receipts already have an owner and are not repeatedly resubmitted by the scanner. Recovered receipts record `reconciliation.source = scheduled_snapshot_scan`.

This restores **review admission**, not a failed GitHub Actions workflow run. A failed required workflow remains failed until separately retried or the ruleset uses the backend-owned admission status. Existing oncall notifications only cover terminal review failures; scanner/network failure notification is a separate alerting concern and is not silently enabled here.

Validate in `observe` mode on the test repository, then enable `repair` there and exercise lost ingress, delayed delivery, retarget, reopen, restart, and rate limiting before production rollout. Do not change the running production config merely to install this code.

## First activation without historical backfill

`initialBaseline` is an optional array of canonical `ocr-ci-<sha256>` request IDs captured by a read-only scan immediately before activation. Include all existing eligible open PR snapshots, including already owned snapshots. Capture every configured repository successfully before enabling repair. Baseline IDs are configuration, retained across restarts; they do not create synthetic receipts or successful statuses.

An unowned exact baseline snapshot is recorded as `baseline` and is never automatically admitted. A new PR, changed head, changed base SHA, or changed target branch has a different identity and follows the normal grace and recovery rules. The baseline is immutable: do not regenerate it during routine deployment or restart, because doing so would suppress newly missed events. Delayed webhook and Policy ingress remain active and may legitimately admit baseline snapshots. An unchanged historical PR reopening remains excluded by this opt-in baseline; an actual new snapshot is required for automatic recovery.
