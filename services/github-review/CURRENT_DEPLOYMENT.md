# Current deployment (2026-10-26)

The review host is `10.2.46.202`. Repository webhook and organization workflow
entrances both reach n8n and the same backend state. n8n selects InsightFlow Agent
first with default OCR fallback; snapshot reuse avoids duplicate OCR jobs across
entrances. Native OCR remains the review engine. Policy workflows only wait for
durable acceptance (at most 90 seconds); final `ocr-review` is published separately.
GitHub App installation authentication is used throughout the backend; PAT is an
explicit operator rollback, not automatic fallback. Existing policy YAML,
Rulesets and `OCR_CI_TOKEN` do not need changes for this credential migration.

## Capacity and retry policy

The deployed policy has PR concurrency 8 and the following configuration fragment:

```json
{
  "maxAttempts": 5,
  "prConcurrency": 8,
  "infrastructure": {
    "allowUnlimitedBudget": true,
    "budgetRetry": { "enabled": true, "maxRetries": 4, "multiplier": 2, "unlimitedAfter": 2000000 },
    "limits": { "budget": 4000000, "concurrency": 8, "timeoutSeconds": 3600 }
  }
}
```

Merge this fragment with a complete service configuration; it is not a standalone
configuration. Existing unrelated infrastructure settings must be retained.
For a task initially assigned 500,000 tokens, budget retries are 1,000,000,
2,000,000 and then unlimited (`budget: 0`). Existing 4,000,000-token attempts
can also transition to unlimited on their next budget retry. Five total attempts
allow this migration; an already unlimited run cannot escalate again. The numeric
limit still bounds finite requested budgets; unlimited retries require explicit
`allowUnlimitedBudget` authorization. Timeouts remain in effect. The global attempt limit also includes other execution
failures, so unrelated failures can consume retry opportunities. Repository
limits can be stricter. Matching snapshots resume saved native sessions; changed
head/base snapshots must not reuse incompatible review evidence. Raising the cap
does not automatically restart every historical failure.

Closed PR receipts can be reaccepted on reopening at the same current snapshot;
completed tasks retain deduplication, and superseded snapshots are not revived.

## PR failure notifications

`ocr-pr-alerts.timer` invokes an independent read-only observer every minute.
It reads service state and sends Feishu text messages, without changing jobs,
CI receipts, or review verdicts. Resource alerts remain a separate service.

Example `/etc/ocr-review/pr-alerts.json`:

```json
{
  "stateFile": "/data/crg/ocr-review/state/state.json",
  "directory": "/var/lib/ocr-pr-alerts",
  "webhookFile": "/etc/ocr-review/pr-failure-webhook",
  "notifyBlocking": false
}
```

Store the webhook URL in the referenced file with mode 0600; never commit it.
Install the supplied service/timer with host-appropriate paths. The deployed
entry point is under `/data/crg/ocr-review/alerts-current/services/github-review/`.

The first collection baselines historical failures without sending them. New
terminal execution/dispatch failures are reported; completed reviews with code
findings are silent by default (`notifyBlocking: false`), with repository, PR URL, commit, Beijing time, reason, task, route,
attempt count and effective budget. Optional `notifyBlocking: true` enables code-finding alerts. Queued retries, normal closure and supersession
are silent. Job-linked CI/webhook failures deduplicate into one notification.

Delivery state is persisted in `alerts.json`. Failed deliveries back off from
one minute to 30 minutes, at most five attempts per timer invocation. Recovered
pending failures are suppressed. Feishu's application status is checked as well
as HTTP status. A network timeout after remote delivery may still cause a repeat;
notifications carry a stable event ID for identification. This is not an
exactly-once delivery guarantee. State corruption fails closed instead of resetting
the deduplication baseline. Events that occur and disappear between polls cannot
be reconstructed. This does not monitor arbitrary third-party GitHub Actions.

```sh
node services/github-review/pr-alerts.js /etc/ocr-review/pr-alerts.json --test
systemctl enable --now ocr-pr-alerts.timer
# Stop only PR notifications:
systemctl disable --now ocr-pr-alerts.timer
systemctl stop ocr-pr-alerts.service
```

GitHub App rollback is available at
`/etc/ocr-review/rollback-github-app-20261026/rollback.sh` on the host.
Review data and feedback candidates are described in [DATASET.md](DATASET.md).

Large-PR tracking: [BUDGET_CASES.md](BUDGET_CASES.md).
