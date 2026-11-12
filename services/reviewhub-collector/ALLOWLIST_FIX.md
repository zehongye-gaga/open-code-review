# Repository allowlist correction

Status: implemented and locally verified, 2026-11-12. Production rollout is separate.

## Goal and boundary

The collector must project only repositories explicitly listed in the existing OCR backend configuration's `repositories` array, within the collector's configured organizations. Same-organization task history, analytics ledgers and previous collector snapshots must not enroll extra repositories. The backend remains the owner of the allowlist and target branches; this change adds no second configuration surface or Gitea ingestion.

## Implementation

1. Build the visible repository projection from configured entries only. Match configured names, `githubName` and verified GitHub identities while retaining local identities and rename aliases.
2. Retain historical repository identity records as private recovery state, even while their repositories are absent from the projection. Use the existing transactional `in_scope` update to hide removed repositories without deleting audit history.
3. Cover unrelated history, rename aliases, removal, restart and re-addition with unit and PostgreSQL tests. Keep invalid configuration and failed publications from advancing the last committed snapshot.
4. Update deployment documentation with the authoritative allowlist and record actual checks below.

## Acceptance and evidence

- `npm ci --ignore-scripts` in this service completed with the existing lockfile unchanged.
- `npm test --prefix services/reviewhub-collector`: 12 tests passed. Regressions cover same-organization task/ledger/history leakage, explicit aliases, stable IDs after verified renames, mismatched verified IDs, organization boundaries, malformed aliases and duplicate configured names.
- `TEST_DATABASE_URL=postgres://reviewhub@127.0.0.1:55439/reviewhub_audit_test REVIEWHUB_MIGRATIONS_DIR=/Users/relu/Documents/ui-refactor/packages/database/migrations npm run test:integration --prefix services/reviewhub-collector`: 4 tests passed. Each creates and cleans an independent random schema. The new scenario exercises removal with rollback/retry, repeated hidden cycles, preserved rows in all four repository-scoped audit tables, restart, re-enrollment with the renamed config entry, and same-process removal/re-addition without duplicate IDs or stale normalized-cache suppression.
- `node --test services/github-review/*.test.js`: 376 tests, 375 passed and 1 existing skip.
- `make license-add`, `make check`, `make test`, `make build` and `git diff --check` passed. License addition did not change existing source headers.
- Required pre-commit review was attempted with `./dist/opencodereview review --audience agent --background 'Restrict ReviewHub collector projection to the existing backend repositories allowlist. Preserve rename identity and hidden history across removal, restart, and re-enrollment. Do not change review execution or production configuration.'`. It exited before review because no LLM endpoint was configured. Automated OCR review is unverified; the implementation and diff were manually reviewed.

The existing `PostgresStore.publish` transaction already handles `in_scope` changes and normalized-cache replacement correctly; it did not need a SQL or schema change. Private `collector_records` entries with the `repository:` prefix now retain identity history even when their repository is absent from the visible batch. This registry is only consulted while resolving a currently configured entry, never as an independent enrollment source.

Production is not changed by this PR. A later rollout should compare the visible repository identity set with the configured entries after a successful collection cycle, rather than hard-coding a repository count.

## Main-branch alignment

After collector PR #28 merged, this branch merged `origin/main` at `83bbb14` without conflicts. The main branch contains the original collector baseline `1d6e15b`; the remaining six-file diff is only this allowlist correction, its tests and documentation. The collector unit suite (12 tests), dedicated PostgreSQL integration suite (4 tests), `make check` and diff checks passed again after alignment. The required OCR review was retried and remains unavailable because no LLM endpoint is configured. No production state or unrelated branch was changed.
