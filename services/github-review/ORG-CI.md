# Organization CI and shared webhook dispatch

This service supports two ingress paths into one persistent review queue:

- GitHub webhooks forwarded by n8n through `POST /v2/github_event`.
- Organization workflows submitting snapshots through `POST /v2/ci_submit`, querying durable acceptance through `/v2/ci_status`, and tracked by n8n through `/v2/ci_tick`.

The organization workflow waits only for durable acceptance, with a total client budget of 90 seconds. Background tracking runs independently, typically every 30 seconds. A successful workflow means dispatch succeeded, not that the review passed. Making `ocr-review` a required status is a separate administrator choice.

## Routing and reuse

n8n chooses `agent` or `direct`; repository rulesets do not choose the route. The deployed routing policy sends all eligible repositories to the Agent first. Configure `agentFallback: true` on applicable repository or organization policies to permit default-profile review when the Agent does not acknowledge a task.

Both entrances share snapshot admission keyed by repository, PR number, head SHA, base SHA and base branch. Existing non-preview tasks are reused, including completed or failed tasks; a failed result is not silently rerun. Explicit administrator retries remain separate operations.

CI receipts attach to an existing matching task after background snapshot verification and record `reused_existing`. They also check again after an Agent acknowledgement failure before scheduling fallback. Existing result settings and review artifacts are preserved. A receipt awaiting verification cannot attach to a task; verified receipts cannot attach to preview, cancelled, superseded, or mismatched snapshots.

The submit endpoint commits local acceptance before any GitHub API operation. It persists first-admission, retry and reopen intents on the receipt, returning the version-2 durable ACK without waiting for a PR query, an existing receipt lock, or a status write. The backend validates the frozen coordinates before dispatch and records bounded retries or terminal failures. This keeps the CI gate's meaning as reliable backend takeover. `admission_pending` means the request is saved but GitHub verification is still outstanding. Receipt outcome, audit rows and failure notifications expose that phase and its failures.

Webhooks, organization CI and scheduled reconciliation share the repository's `baseBranches` policy. Ordinary PRs use `base.ref`; GitHub native stacks use the API's `stack.base.ref` (the stack's target branch). A body such as "Stacked on #9" or a branch pointing to another PR does not establish native membership. The `pull_request` action `stacked` triggers verification, as do supported lifecycle events. Current GitHub metadata is fetched before dispatch; webhook or list snapshots alone cannot authorize a review. See [GitHub's stack API contract](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks).

Organization CI may still include draft PRs, but it cannot bypass `baseBranches`. An out-of-scope target receives the usual durable ACK and is then recorded as `skipped` with reason `target_branch_not_allowed`, without invoking the Agent or reviewer. The background status describes a skip, not a review verdict. Joining an allowed native stack later permits the same snapshot to be verified again; a compatible cancelled task is reused. The diff remains against the direct parent PR branch, not the stack trunk. Gitea continues to use its direct target branch. The CI identity validator remains restricted to the `lexmount` organization; this is a deployment-specific restriction, not a generic multi-organization gateway.

Authenticated CI requests for repositories outside the backend enrollment list
persist a terminal `skipped` receipt with reason `repository_not_enabled`. This
is a successful dispatch decision without an OCR job, Agent call, or review
verdict publication. Duplicate submissions and status queries reuse that receipt.
Enabling the repository allows a later submission for the same current snapshot
to start review, retaining the earlier skip decision in admission history.
Client repository scope and both CI credentials remain required. Direct review
tools continue to reject unenrolled repositories.

## Credentials and deployment

The dispatcher credential authenticates backend calls. The separate organization CI credential is sent as `X-OCR-CI-Token: Bearer <secret>`. Keep token files, GitHub credentials, model provider configuration, execution payloads and state outside the source repository. n8n must avoid retaining sensitive request headers in execution history.

Enable `infrastructure.orgCI.enabled` only after configuring its `tokenFile`. Enable `agentReady` after verifying the Agent's scoped MCP connection. The tracker has a total deadline and an independent stale-heartbeat watchdog, so a lost n8n tracker cannot leave a receipt pending forever.

Before a server switch, drain work, back up configuration and state, retain the previous release, and merge task identities before enabling both entrances. Rollback must preserve post-cutover task identities; restoring a stale snapshot can cause duplicate reviews. A legacy MCP address can remain as a compatibility proxy to the new executor.

The backend does not send review-result feedback to the dispatch Agent. Historical pending feedback is durably marked `disabled` at startup and retained for audit, along with failed feedback. Already-sent history follows the existing `retentionDays` policy. Agent dispatch sessions and task acceptance responses are unaffected.
