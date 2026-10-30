# SQLite audit storage

The `audit-sqlite-*` entry points below are isolated feasibility tools. The production-compatible dashboard read model is described under **Dashboard read-model deployment**. Do not point the dashboard at the experimental endpoints as a drop-in replacement: their pagination and daily-series shapes differ.

## Implemented path

A frozen copy of the retained version-2 analytics ledger seeds indexed jobs, sessions and daily/phase usage. A frozen review state seeds the current audit rows. The ledger is a bootstrap bridge, not an additional source of token consumption. Report totals are not added to session totals.

The database stores session identity, read offset and interpreted counters together. Subsequent ingestion reads only appended complete lines of already registered sessions, then commits the counters and offset in one transaction. Failed transactions are replayable. Replaced/truncated sources are rejected for reconciliation instead of resetting their counters and double counting. Missing and rejected files are included in collector diagnostics. This prototype does not discover or attribute new sessions automatically.

The query process opens a read-only SQLite connection and exposes:

- `GET /api/analytics/pr?repository=owner/repo&number=1&limit=100&offset=0`
- `GET /api/usage/daily?start=2026-10-01&end=2026-10-30&repository=owner/repo`
- `GET /api/audit?repository=owner/repo&limit=100&offset=0`
- `GET /healthz`

The server binds only to loopback. Pages are limited to 200 rows, and daily queries to 366 days. PR usage aggregation runs in SQL over indexed sessions, without loading every session into Node.js. `collectedAt` continues to identify the original seed; registered-session updates have a separate `lastSessionScan` marker and must not claim that all sources are fresh. A healthy prototype process can therefore report stale source data.

## Running the experiment

Use the tested Node.js 22.23.1 runtime with `node:sqlite` support (experimental in Node 22). Database implementation details are confined to `audit-sqlite.js`. There are no new npm dependencies. Pin and verify the SQLite runtime before production use.

Create a private local directory and a configuration file:

```json
{
  "database": "/private/trial/audit.db",
  "ledger": "/private/trial/ledger.json",
  "state": "/private/trial/state.json",
  "retentionDays": 90,
  "port": 8791,
  "maxFiles": 100,
  "maxBytes": 8388608
}
```

Run each operation in its own process:

```sh
node services/github-review/audit-sqlite-benchmark.js /private/trial/config.json
node services/github-review/audit-sqlite-collect.js /private/trial/config.json
node services/github-review/audit-sqlite-server.js /private/trial/config.json
```

The benchmark imports in batches of 100, checks daily metrics and every PR's run records against the frozen ledger, repeats upserts to verify zero changes, and runs an integrity check. Token and count comparisons are exact; floating-point time sums are compared at microsecond precision. It reports wall time, CPU time, RSS and query latency. The benchmark includes the legacy reference computation, so its peak memory is not an estimate of the standalone collector or query server.

The collector processes a bounded number of known files and bytes, saving a scan cursor. Invoke it again until `remaining` reaches zero. The next invocation starts another pass. A line larger than the ingestion batch is reported as an error; it is not silently discarded or advanced past. The database retains the preceding valid counters.

## Memory and isolation

SQLite uses WAL, full synchronous commits, an 8 MiB page-cache target per connection, disabled mmap and disk-backed temporary storage. The cache target is not a process memory cap. Limit the collector and query service separately with systemd/cgroups, bound the JS heap, and measure their combined footprint. A single collector owns writes. All database users must be on the same host/local filesystem.

Initial import currently uses a bounded whole-file JSON seed (32 MiB maximum). This is deliberately different from steady-state log ingestion; larger deployments need a streaming seed importer. An interrupted seed can be rerun with the same frozen inputs. Do not replace those inputs between retries. Queries remain unavailable until the bootstrap completion marker is committed.

Use the SQLite backup API for consistent backups; do not copy a live main database file without its transactional state. Backup/restore automation is a production migration prerequisite, not implemented by this prototype.

## Remaining gates for direct SQL ingestion

- Direct incremental task/result ingestion, discovery and safe attribution of new sessions, and file-rotation reconciliation.
- Agent parent/child usage, GitHub PR snapshots, service health and resource history import.
- Event-level audit history (current snapshot import cannot reconstruct transitions never recorded).
- Retention, daily rollovers, corrections to previous buckets, versioned schema upgrades and backup/restore drills.
- Full dashboard summary compatibility, frontend pagination, bounded query-worker queue and cancellation.
- Representative concurrent read/write, process-crash, disk-full, growing-history and long-running memory tests.

Passing the feasibility benchmark does not mean that all these gates are met or that OOM is impossible. The dashboard read model below retains the existing collectors instead of enabling this incomplete direct-ingestion path.

## Dashboard read-model deployment

The dashboard can now read a separate, atomically published SQLite read model. Set `sqlite.database` in the monitor configuration and run `monitor-sqlite-collector.js` as a separate service. The existing `monitor.js` then opens the database read-only and does not start its file collector or GitHub polling. All existing status, repository, PR detail and resource-history routes keep their response contracts; status includes `storage.engine: "sqlite"`.

The production path deliberately reuses the established Analytics/Monitor collectors for new task/session discovery, attribution, retention, Agent counters, GitHub and resources. They still maintain their JSON ledgers as restart state and a rollback bridge. This is a durable SQLite query layer, not replacement of every source ledger with native SQL ingestion. Do not run the prototype registered-session collector against this database. One production collector owns publication.

GitHub polling runs in a dedicated worker so CPU-heavy collection cannot stall HTTP callbacks and trigger network deadlines. The collector unit permits half a CPU core; the query service remains separately limited.

Each publication replaces snapshots, job records and session usage in one transaction. Removed ledger rows are removed from SQLite in that same transaction. Failed publication leaves the preceding generation readable. Health and source freshness are recomputed on each request, so a stopped collector cannot leave a permanently healthy screen. Resource series retain their actual collection window. The HTTP process never opens raw log, result, GitHub credential or source configuration files in SQLite mode.

Run collector and HTTP services under separate CPU/memory limits. Bootstrap with a private copy of the current analytics directory; never start two collectors writing the same ledger directory. Start the collector first, verify publication and only then switch the web service. Keep the old release, monitor config and original analytics directory untouched until rollback is no longer needed. Rollback stops the new collector, restores the previous config/release and restarts only the monitor.

Run `node services/github-review/monitor-sqlite-backup.js /path/to/monitor.json` daily. It uses the SQLite online backup API, verifies integrity, atomically installs the backup and retains seven daily files. Restore to a new directory while both services are stopped, verify integrity and endpoint freshness, then update the database path. A backup is a historical snapshot; the collector must publish current source state before the restored web service is healthy. Raw SQLite files, WAL files and backups are private operational data, not public artifacts.
