# ReviewHub repository membership

Set `repositorySource` to `reviewhub` in the collector configuration after ReviewHub migration `009_audit_repository_scope.sql` and the full existing repository import have been verified. The default `configuration` mode retains the old static membership for staged rollout.

The existing PG connection reads `reviewhub_audit_repository_scope_v1` once at the start of every collection cycle. Grant the collector role SELECT on this view only; it does not need access to enrollment, identity, session or credential tables. The shared `audit-repository-scope-v1.schema.json` is exported from ReviewHub contracts alongside the audit ingestion schema. Queries belong in this service's database module.

In ReviewHub mode the PG snapshot controls membership for task analytics, repository metadata, normalization and Actions discovery. Static OCR configuration still supplies source locations, credentials and matching repository aliases; static-only repositories are not silently added. A valid empty PG scope means empty membership, so compare all existing repository IDs before changing the source setting.

Staged imports, paused and archived repositories remain in audit scope. Pausing new review requests must not hide already accepted work or audit history. The `enabled` field is null until the current configuration revision is applied; a pending intent is not proof of engine state. Repository IDs supplied by the platform remain stable when GitHub metadata is temporarily unavailable.

A missing view, insufficient permissions, invalid snapshot or revision regression fails the entire cycle before consuming source changes or publishing. The last committed audit data and checkpoint remain in PG. The successful scope snapshot commits with the audit batch and cursor; restart uses the same revision checks. No new audit SQLite, JSON ledger or background membership process is introduced.

Current service topology must be queried before deployment. Do not restart retired OCR-host dashboard, alert or legacy collector services based on old setup documents. Deploy the active collector where it runs today. Organization Ruleset selection and Policy workflow configuration remain unchanged by this feature.
