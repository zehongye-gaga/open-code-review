#!/usr/bin/env python3

# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 alibaba/open-code-review Contributors

# SPDX-License-Identifier: Apache-2.0
"""Persist resource and review-load samples without changing review execution."""
import collections
import datetime
import json
import pathlib
import statistics
import urllib.error
import urllib.request

UTC = datetime.timezone.utc


def timestamp(value):
    if not value:
        return None
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def collect_load(state_file, health_url, now):
    result = {"available": False}
    try:
        with urllib.request.urlopen(health_url, timeout=3) as response:
            health = json.load(response)
        result.update({"available": True, "service_status": health.get("status"),
                       "running": health.get("running"), "review_limit": health.get("prConcurrency"),
                       "app_dispatching": health.get("dispatching"),
                       "dispatch_limit": health.get("dispatchConcurrency"),
                       "queued": health.get("queued"), "pending_deliveries": health.get("pendingDeliveries"),
                       "active_jobs": health.get("activeJobs", [])})
    except (OSError, ValueError):
        result["health_error"] = "health_unavailable"
    try:
        state = json.loads(pathlib.Path(state_file).read_text())
        result["policy_dispatching_receipts"] = sum(r.get("state") == "dispatching" and not r.get("jobId")
            for r in state.get("ciReceipts", {}).values())
        jobs = state.get("jobs", [])
        recent = [j for j in jobs if (timestamp(j.get("updatedAt") or j.get("createdAt")) or 0) >= now - 86400]
        def seconds(job, start, end):
            a, b = timestamp(job.get(start)), timestamp(job.get(end))
            return max(0, b - a) if a is not None and b is not None else None
        result["recent_jobs"] = [{"id": j["id"], "repository": j["repository"], "pr": j["number"],
            "state": j["state"], "attempt": j.get("attempt"), "created_at": j.get("createdAt"),
            "started_at": j.get("startedAt"), "updated_at": j.get("updatedAt"),
            "age_to_latest_start_seconds": seconds(j, "createdAt", "startedAt"),
            "latest_attempt_seconds": seconds(j, "startedAt", "updatedAt") if j["state"] in ("complete", "failed") else None,
            "recorded_429": "429" in str(j.get("error", "")),
            "recorded_timeout": "timeout" in str(j.get("error", "")).lower() or "timed out" in str(j.get("error", "")).lower()}
            for j in recent]
        result["oldest_queued_age_seconds"] = max([max(0, now - (timestamp(j.get("createdAt")) or now))
            for j in jobs if j["state"] == "queued"], default=0)
    except (OSError, ValueError, KeyError):
        result["state_error"] = "state_unavailable"
    return result


def record(directory, metrics, kernel_mib, sampled_at, interval_start, state_file, health_url, retention_days=90):
    directory = pathlib.Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    now = datetime.datetime.fromtimestamp(sampled_at, UTC)
    value = {"schema": "ocr-resource-sample/v1", "sampled_at": now.isoformat(),
             "cpu_interval_start": interval_start, "metrics": metrics, "kernel_mib": kernel_mib,
             "load": collect_load(state_file, health_url, sampled_at)}
    jobs = value["load"].pop("recent_jobs", [])
    def distribution(values):
        values = sorted(v for v in values if v is not None)
        return {"count": len(values), "p50": statistics.median(values) if values else None,
                "p95": values[max(0, (95 * len(values) + 99) // 100 - 1)] if values else None}
    value["load"]["last_24h"] = {"jobs": len(jobs),
        "failed": sum(j["state"] == "failed" for j in jobs),
        "recorded_429_jobs": sum(j["recorded_429"] for j in jobs),
        "recorded_timeout_jobs": sum(j["recorded_timeout"] for j in jobs),
        "first_attempt_queue_seconds": distribution(j["age_to_latest_start_seconds"] for j in jobs if j.get("attempt") == 1),
        "latest_attempt_seconds": distribution(j["latest_attempt_seconds"] for j in jobs)}
    file = directory / (now.strftime("%Y-%m-%d") + ".jsonl")
    with file.open("a") as output:
        output.write(json.dumps(value, separators=(",", ":")) + "\n")
    file.chmod(0o600)
    cutoff = now.date() - datetime.timedelta(days=retention_days - 1)
    for old in directory.glob("????-??-??.jsonl"):
        try:
            if datetime.date.fromisoformat(old.stem) < cutoff:
                old.unlink()
        except ValueError:
            continue
    return value


def report(directory, hours=24):
    cutoff = datetime.datetime.now(UTC).timestamp() - hours * 3600
    groups = collections.defaultdict(list)
    for file in pathlib.Path(directory).glob("*.jsonl"):
        for line in file.read_text().splitlines():
            try:
                row = json.loads(line)
                if timestamp(row["sampled_at"]) >= cutoff and row["load"].get("available"):
                    groups[row["load"]["running"]].append(row)
            except (ValueError, KeyError):
                continue
    return [{"running": count, "samples": len(rows),
             "cpu_mean": round(statistics.mean(r["metrics"]["cpu"] for r in rows), 2),
             "cpu_max": round(max(r["metrics"]["cpu"] for r in rows), 2),
             "memory_max": round(max(r["metrics"]["memory"] for r in rows), 2),
             "queue_max": max(r["load"]["queued"] for r in rows)} for count, rows in sorted(groups.items())]


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    parser.add_argument("--hours", type=int, default=24)
    args = parser.parse_args()
    print(json.dumps(report(args.directory, args.hours), indent=2))
