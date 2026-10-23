# Organization CI and shared webhook dispatch

This service supports two ingress paths into one persistent review queue:

- GitHub webhooks forwarded by n8n through `POST /v2/github_event`.
- Organization workflows submitting snapshots through `POST /v2/ci_submit`, querying durable acceptance through `/v2/ci_status`, and tracked by n8n through `/v2/ci_tick`.

The organization workflow waits only for durable acceptance, with a total client budget of 90 seconds. Background tracking runs independently, typically every 30 seconds. A successful workflow means dispatch succeeded, not that the review passed. Making `ocr-review` a required status is a separate administrator choice.

## Routing and reuse

n8n chooses `agent` or `direct`; repository rulesets do not choose the route. The deployed routing policy sends all eligible repositories to the Agent first. Configure `agentFallback: true` on applicable repository or organization policies to permit default-profile review when the Agent does not acknowledge a task.

Both entrances share snapshot admission keyed by repository, PR number, head SHA, base SHA and base branch. Existing non-preview tasks are reused, including completed or failed tasks; a failed result is not silently rerun. Explicit administrator retries remain separate operations.

CI receipts immediately attach to an existing matching task and record `reused_existing`. They also check again after an Agent acknowledgement failure before scheduling fallback. Existing result settings and review artifacts are preserved. A pending receipt cannot attach to preview, cancelled, superseded, or mismatched snapshots.

The webhook keeps its existing event, draft and target-branch checks. Organization CI snapshots use the workflow/ruleset scope and may include draft PRs. The current CI identity validator is restricted to the `lexmount` organization; this is a deployment-specific restriction, not a generic multi-organization gateway.

## Credentials and deployment

The dispatcher credential authenticates backend calls. The separate organization CI credential is sent as `X-OCR-CI-Token: Bearer <secret>`. Keep token files, GitHub credentials, model provider configuration, execution payloads and state outside the source repository. n8n must avoid retaining sensitive request headers in execution history.

Enable `infrastructure.orgCI.enabled` only after configuring its `tokenFile`. Enable `agentReady` after verifying the Agent's scoped MCP connection. The tracker has a total deadline and an independent stale-heartbeat watchdog, so a lost n8n tracker cannot leave a receipt pending forever.

Before a server switch, drain work, back up configuration and state, retain the previous release, and merge task identities before enabling both entrances. Rollback must preserve post-cutover task identities; restoring a stale snapshot can cause duplicate reviews. A legacy MCP address can remain as a compatibility proxy to the new executor.

Completed Agent feedback is pruned using the existing `retentionDays` policy. Pending and failed feedback remains available for reconciliation.
