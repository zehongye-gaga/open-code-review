# Dynamic audit repository scope

Status: implementing; source migration and verified rollout authorized, organization Rulesets unchanged.

The collector already reads checkpoints and writes audit data through ReviewHub PostgreSQL. Add an explicit repositorySource=reviewhub mode which reads the versioned read-only repository view at the start of each collection cycle. Staged and paused configurations remain in audit scope; enabled is unknown until the desired version is applied. Static configuration retains execution/source settings and matching aliases, but no longer controls membership in this mode.

Validate the entire snapshot before reading source changes or publishing. Preserve stable repository IDs, prior aliases, history and checkpoints. A missing view, permission error, malformed snapshot or read failure must stop the cycle without publishing an empty scope. Keep the default configuration mode for controlled rollout after the existing list has been imported.

Inventory found shared static membership in collector analytics, metadata, normalization and Policy log discovery; switch their common input together. OCR admission and default reconciliation already resolve dynamic configuration. Explicit reconciliation subsets and active service locations require live verification. User states four current services: collector, alerts, durable OCR scheduler and ReviewHub audit service. Legacy OCR-host alert/dashboard/collector processes are retired; do not redeploy them based on historical docs.

Validate unit/PG tests and the actual Policy HTTP -> OCR SQLite/scheduler -> collector -> ReviewHub API chain, including a new repository absent from static config, pause/history, aliases, query failure and restart. ReviewHub owns the SQL view migration and platform contract. No organization Ruleset change or unrelated PR merge.
