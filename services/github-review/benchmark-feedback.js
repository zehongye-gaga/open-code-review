// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { ReviewDataset } = require("./review-dataset.js");
const clean = (s) => String(s || "").replace(/(?:github_pat_|ghp_|goclaw_)[A-Za-z0-9_]+/g, "[REDACTED]").replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]").slice(0, 16000);
const fields = `id path isResolved isOutdated originalLine originalStartLine resolvedBy{login}
 comments(first:100){totalCount nodes{id databaseId url body createdAt updatedAt author{login} originalCommit{oid}}}`;
const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){state merged headRefOid reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{${fields}}}}}}`;
function overlaps(patch, start, end) {
  let oldLine = null;
  for (const line of (patch || "").split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (m) { oldLine = Number(m[1]); continue; }
    if (oldLine === null) continue;
    if (line.startsWith("-")) { if (oldLine >= start && oldLine <= end) return true; oldLine++; }
    else if (line.startsWith(" ")) oldLine++;
  }
  return false;
}
function observation(repository, number, thread, pr, comparison, jobs) {
  const root = thread.comments.nodes[0];
  const marker = /<!--\s*(ocr-\d+-\d+-[a-f0-9]+)\s*-->/.exec(root?.body || "")?.[1];
  if (!marker) return null;
  const file = comparison?.files?.find((f) => f.filename === thread.path || f.previous_filename === thread.path);
  const rangeTouched = !!file && overlaps(file.patch, thread.originalStartLine || thread.originalLine, thread.originalLine);
  const replies = thread.comments.nodes.slice(1).map((c) => ({ id: c.id, url: c.url, author: c.author?.login, body: clean(c.body), createdAt: c.createdAt }));
  const rejected = replies.some((c) => /\b(false positive|not a bug|won't fix|wontfix)\b|\u8bef\u62a5|\u4e0d\u91c7\u7eb3/i.test(c.body));
  const label = rejected ? "rejection_candidate" : thread.isResolved && rangeTouched ? "resolved_change_candidate" : thread.isResolved ? "resolved_only" : "unknown";
  return { id: thread.id, repository, number, marker, commentId: root.databaseId, commentURL: root.url,
    finding: clean(root.body), commentCreatedAt: root.createdAt, commentUpdatedAt: root.updatedAt, author: root.author?.login, originalCommit: root.originalCommit?.oid, head: pr.headRefOid,
    jobIds: jobs.filter((j) => j.head === root.originalCommit?.oid).map((j) => String(j.id)),
    path: thread.path, originalLine: thread.originalLine, originalStartLine: thread.originalStartLine,
    resolved: thread.isResolved, outdated: thread.isOutdated, resolvedBy: thread.resolvedBy?.login || null,
    resolverMatchesPublisher: !!thread.resolvedBy?.login && thread.resolvedBy.login === root.author?.login,
    resolutionTime: null, resolutionOrigin: "unknown", prState: pr.state, merged: pr.merged,
    replies, repliesComplete: thread.comments.totalCount === thread.comments.nodes.length,
    evidence: { fileChanged: !!file, originalRangeTouched: rangeTouched, patch: clean(file?.patch),
      comparisonStatus: comparison?.status || "unavailable", comparisonComplete: !!comparison && comparison.files?.length < 300 && comparison.total_commits === comparison.commits?.length,
      candidateCommits: (comparison?.fileCommits?.[thread.path] || []).filter((c) => Date.parse(c.committedAt) >= Date.parse(root.createdAt)),
      commitSearchComplete: comparison?.commitSearchComplete || false,
      scope: "original_commit_to_current_head; candidate commits are not verified fixes" },
    candidateLabel: label, verified: false, labelMethod: "rules-v1", humanOutcome: null };
}
class FeedbackCollector {
  constructor(config, directory, request = fetch) {
    this.config = config; this.directory = directory; this.request = request;
    this.auth = require("./github-auth.js").githubAuth(config, request);
    this.dataset = new ReviewDataset(path.join(directory, "benchmark"));
    this.stateFile = path.join(directory, "benchmark", "collector.json");
    try { this.state = JSON.parse(fs.readFileSync(this.stateFile)); } catch { this.state = { pulls: {} }; }
  }
  async api(route, body) {
    if (Date.now() > this.deadline || ++this.calls > 100) throw Error("Request budget reached");
    const response = await this.auth.request(`https://api.github.com${route}`, { method: body ? "POST" : "GET", redirect: "error",
      signal: AbortSignal.timeout(20000), headers: {
        "user-agent": "ocr-benchmark-observer", "content-type": "application/json", accept: "application/vnd.github+json" },
      body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw Error(`GitHub HTTP ${response.status}`);
    const value = await response.json(); if (value.errors?.length) throw Error("GitHub query incomplete"); return value;
  }
  async collect(jobs, now = Date.now()) {
    this.calls = 0; this.deadline = Date.now() + 120000; const groups = new Map();
    for (const j of jobs) if (j.result?.summaryURL && /^[\w.-]+\/[\w.-]+$/.test(j.repository) && Number.isInteger(j.number)) {
      const key = `${j.repository.toLowerCase()}#${j.number}`;
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(j);
    }
    const due = [...groups].filter(([k]) => now - (this.state.pulls[k]?.checkedAt || 0) >= (this.state.pulls[k]?.closed ? 86400000 : 900000))
      .sort(([a], [b]) => (this.state.pulls[a]?.checkedAt || 0) - (this.state.pulls[b]?.checkedAt || 0)).slice(0, 5);
    for (const [key, runs] of due) {
      try {
        const { repository, number } = runs[0], [owner, name] = repository.split("/"); let cursor = null; const seen = new Set(), comparisons = new Map(), commits = new Map();
        const records = []; let closed = false;
        do {
          if (seen.has(cursor) || seen.size >= 20) throw Error("Thread pagination incomplete"); seen.add(cursor);
          const response = await this.api("/graphql", { query, variables: { owner, name, number, cursor } });
          const pr = response.data?.repository?.pullRequest; if (!pr) throw Error("PR unavailable"); closed = pr.state !== "OPEN";
          for (const thread of pr.reviewThreads.nodes) {
            const root = thread.comments.nodes[0]; if (!/<!--\s*ocr-\d+-\d+-[a-f0-9]+\s*-->/.test(root?.body || "")) continue;
            const sha = root.originalCommit?.oid;
            if (sha && !comparisons.has(sha)) {
              const diff = await this.api(`/repos/${owner}/${name}/compare/${sha}...${pr.headRefOid}?per_page=100`);
              diff.fileCommits = {}; diff.commitSearchComplete = diff.total_commits === diff.commits?.length && diff.commits.length <= 20;
              for (const c of (diff.commits || []).slice(-20)) {
                if (!commits.has(c.sha)) commits.set(c.sha, await this.api(`/repos/${owner}/${name}/commits/${c.sha}?per_page=100`));
                const detail = commits.get(c.sha);
                if (detail.files?.length >= 100) diff.commitSearchComplete = false;
                for (const file of detail.files || []) {
                  const evidence = { sha: c.sha, url: c.html_url, committedAt: c.commit?.committer?.date };
                  for (const filePath of new Set([file.filename, file.previous_filename].filter(Boolean))) (diff.fileCommits[filePath] ||= []).push(evidence);
                }
              }
              comparisons.set(sha, diff);
            }
            records.push(observation(repository.toLowerCase(), number, thread, pr, comparisons.get(sha), runs));
          }
          const page = pr.reviewThreads.pageInfo; cursor = page.hasNextPage ? page.endCursor : null;
          if (page.hasNextPage && !cursor) throw Error("Thread cursor missing");
        } while (cursor);
        this.dataset.append("finding_feedback", records.filter(Boolean));
        this.dataset.append("pr_feedback_coverage", [{ id: key, repository: repository.toLowerCase(), number, closed, inlineFindings: records.length, summaryOnlyFindingsCollected: false }]);
        this.state.pulls[key] = { checkedAt: now, closed, findings: records.length, error: null };
      } catch (e) { this.state.pulls[key] = { ...this.state.pulls[key], checkedAt: now, error: e.message }; }
    }
    this.state.updatedAt = now; this.state.requests = this.calls;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.stateFile + ".tmp", JSON.stringify(this.state), { mode: 0o600 }); fs.renameSync(this.stateFile + ".tmp", this.stateFile);
    return this.state;
  }
}
module.exports = { FeedbackCollector, observation, overlaps };
if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.argv[2]));
  const collector = new FeedbackCollector(config, process.argv[3]);
  collector.collect(JSON.parse(fs.readFileSync(path.join(config.stateDirectory, "state.json"))).jobs)
    .then((s) => console.log(JSON.stringify({ checked: Object.keys(s.pulls).length, requests: s.requests, errors: Object.values(s.pulls).filter((p) => p.error).length })))
    .catch(() => { console.error("Benchmark collection failed"); process.exitCode = 1; });
}
