# Dynamic repository configuration

ReviewHub can publish versioned repository enrollment without rewriting this
service's JSON file or restarting it for each repository. This is an optional
GitHub external-dispatch integration; it does not change the existing SQLite
execution store or the OCR CI ACK contract.

Add a `dynamicConfiguration` object to the existing service configuration:

```json
{
  "dynamicConfiguration": {
    "organization": "lexmount",
    "snapshotUrl": "https://reviewhub.example/internal/v1/repository-configurations",
    "tokenFile": "/run/secrets/reviewhub-config-token",
    "clientIds": ["org-ci-dispatcher"]
  }
}
```

The token is a separate random credential of at least 32 characters, shared with
ReviewHub. HTTPS is required except for loopback tests. `infrastructure.enabled`
and `infrastructure.externalDispatch` must be enabled, with `orgCI.enabled=true`
and `statusContext=ocr-review`. Gitea is not supported.
Keep normal GitHub credentials, models, profiles, clients and execution settings.
An empty static `repositories` array is allowed with a dynamic source.

`clientIds` contains existing dispatcher/agent client IDs that may access
explicitly enabled dynamic repositories. Include the actual Agent client when
`orgCI.agentReady` is enabled. Static client scope is still honored. Applying an
enabled entry checks that the required clients have scope; refreshing a new
revision also checks that this service's GitHub credentials can read the exact
repository ID, visibility and default branch.

The service loads `reviewhub-config/v1` snapshots atomically, on startup and every
30 seconds. Same-version retries must have identical content. Stale revisions,
renames and removing a previously loaded ID are rejected; disable explicitly
with a newer revision. Explicit pauses override static repositories and
organization fallback. Unmanaged repositories keep their static behavior after
the first successful load. Startup without a trusted snapshot blocks new work
for the configured organization. A later refresh failure retains the last good
snapshot; restarting requires loading the durable published source again.

The main HTTP server exposes:

- `POST /configuration/refresh`: fetch the published snapshot now.
- `GET /configuration/repositories/{id}`: return `instanceId`, `observedAt` and the
  actual neutral configuration (or null).

Both require `Authorization: Bearer <configuration token>` and reject browser
Origin headers. They do not accept configuration bodies or reuse client/API
tokens. Pin the control-plane adapter to a single service instance; fleet-wide
acknowledgements are not implemented.

New admissions use the latest policy. Jobs already accepted retain their
enrollment policy and can finish after a pause while still checking repository
ID and PR head/base. Existing policy compatibility checks remain in place for
reuse and retries. A pause does not cancel a running job or revoke shared
workflow secrets.

Run `node --test services/github-review/*.test.js`, `make check` and `make test`.
The ReviewHub repository also provides `tests/helpers/enrollment-e2e.mjs`, which
uses an independent PostgreSQL database, this service's real HTTP/SQLite path,
and simulated GitHub/model results. Production rollout still requires one public
and one private test PR; local success is not evidence of a live workflow or
model run. Rollback must preserve dynamically enrolled repositories in the old
configuration before disabling this source.
