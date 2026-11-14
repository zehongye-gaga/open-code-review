# Context ceiling recovery

Implement recovery for the native OCR prompt-size and compression stops observed in jobs 1791879630186 and 1791879630190. Keep this repository limited to context recovery and its existing collector projection. ReviewHub owns notification rules, durable delivery and Feishu formatting. The legacy OCR notification bot is unchanged.

- At most three executions in a context-recovery chain. On the first and second context failure, double the effective `--max-tokens` value and queue the same snapshot again. Do not change the aggregate token budget.
- Keep GitHub pending while retrying. Export expansion events to the existing ReviewHub Alerts Worker for private Feishu warnings. On the third unsuccessful execution, fail and export the terminal diagnostics. Never post expansion warnings to GitHub.
- Keep the original failure detail and file identities. Detect native context stops from validated artifacts; unrelated failures must not trigger expansion.
- Preserve immutable requested settings, completed-file reuse, policy checks, and the existing maximum accepted `maxTokens` value. A requested doubling that exceeds an explicit policy ceiling fails with its original cause and expansion rejection.
- Record each expansion durably. Each warning is independent of the final job state, deduplicates across restarts, and retains long error text through notification chunks.

Validation covers 200000 -> 400000 -> 800000, third-attempt failure/success, no premature GitHub failure or warning, restart recovery, policy limits, unrelated errors, original diagnostics, and the collector contract. ReviewHub tests notification delivery separately and across the two repositories. Use temporary repositories/artifacts and stub transports for regression tests.

The user authorized one PR in each repository, merging only after regression verification, followed by deployment. Recheck the production running and queued jobs immediately before switching OCR during an idle window. Keep the native binary, model, total budget, rules, GitHub App, repository permissions and Gitea review service unchanged. Deploy compatible ReviewHub contracts and notification code before enabling source events. Preserve release/configuration backups and a rollback path. Do not replay production reviews to test the change.

## Runtime configuration

`contextRetry` accepts `{ "enabled": true, "maxTokens": 1000000 }` by default. The maximum is the existing accepted service parameter bound, not a promise of model capacity; deployment must keep it within the provider's supported context. Any lower repository or infrastructure limit still applies. An exact doubling that exceeds a configured limit fails with its original diagnostic and the expansion rejection. `enabled: false` disables automatic expansion.

The initial context value follows the executed CLI option, then the native user's saved `max_tokens`, then the native default 200000. The retry-specific override does not mutate admitted settings or the aggregate token budget. Expansion is allowed only for identified context failures; unrelated provider failures or incomplete compression diagnostics retain their original cause and do not expand.

The three-execution counter is persisted before each native start, including an internal resume fallback, and survives restart. Preparation failures do not consume native executions; they retain a separate bounded allowance using the existing `maxAttempts`. Completed third-attempt reports can still be published after restart without starting native review again.

Native diagnostics read at most 64 MiB of session records in five seconds, with an 8 MiB record bound, 512 KiB diagnostic text and 256 KiB stderr excerpt. Any omission is explicit and points to intact source artifacts. The independent collector redacts credential values and bounds platform diagnostic text with an explicit source reference.

## Verification

- `make license-add`, `make check`, and `make test` passed. The native binary and Go source are unchanged.
- `OCR_POLICY_CLIENT=<existing private Policy ci_client.py> npm run test:github-actions`: 443 service tests passed, zero skipped, plus the existing action/comment/translation/plugin contracts. Launcher and version tests passed.
- Collector unit tests: 40 passed. Collector PostgreSQL integration tests: 8 passed, using an independent local test database and random schemas.
- ReviewHub cross-repository tests passed for existing audit ingestion, actual Policy ACK logs, and context retry notifications. The new path uses real task SQLite, the collector and PostgreSQL, with a stub Feishu transport and no GitHub requests.
- Private and public GitHub Policy regressions each passed 30 tests. No Policy source changed.
- Automated OCR review ran using the local `openai-codex` subscription with `gpt-6-astra`. Findings about native-start accounting, bounded preparation retries, missing compression evidence and credential redaction were fixed with regression coverage. No production credentials were used for this review.
- A separately tested deployment overlay applies only this recovery delta to the live service base `15c9c512e63245a0b124513533abfa57d5b45c20`. Its 443 service tests passed with no skips. It excludes the unrelated termination telemetry already present on repository main, and preserves the deployed native binary and its hash. The independent collector is updated separately.

Status: implementation and local regression verified; two PRs and production deployment are tracked by the release procedure. Production replay is not part of validation.
