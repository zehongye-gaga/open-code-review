// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const crypto = require("node:crypto");
const copy = require("./round-summary.en.json");

async function publishRoundSummary({ github, owner, repo, prNumber, body, metadata, result, blockSeverity, incomplete, skipped }) {
  const key = crypto.createHash("sha256").update(JSON.stringify([metadata.head, metadata.base])).digest("hex");
  const marker = `<!-- ocr-round:v1:${key} -->`;
  const { data: user } = await github.rest.users.getAuthenticated();
  if (!user?.login) throw new Error("Cannot identify review summary author");
  for (let page = 1; ; page++) {
    const { data: reviews } = await github.rest.pulls.listReviews({ owner, repo, pull_number: prNumber, per_page: 100, page });
    const existing = reviews.find((r) => r.user?.login === user.login && r.commit_id === metadata.head && r.body?.includes(marker));
    if (existing) return { id: existing.id, url: existing.html_url };
    if (reviews.length < 100) break;
  }
  const comments = result?.comments || [];
  const ranks = { critical: 4, high: 3, medium: 2, low: 1, none: 5 };
  const blocking = comments.filter((c) => (ranks[c.severity] || 0) >= ranks[blockSeverity]).length;
  const incremental = metadata.range && metadata.range.mode !== "full";
  const title = incomplete ? copy.incomplete : skipped ? copy.skipped : incremental ? copy.rereview : copy.review;
  const verdict = incomplete ? copy.incompleteBody : skipped ? copy.skippedBody : comments.length
    ? copy.findings.replace("{total}", comments.length).replace("{blocking}", blocking)
    : incremental ? copy.cleanIncremental : copy.clean;
  // Keep findings that could not be posted inline, warnings, and checkpoint metadata.
  const details = body.replace(/<!-- ocr-summary[^]*?-->/g, "").trim()
    .replace(/^[^\n]*OpenCodeReview[^\n]*(?:\n- [^\n]*comment\(s\)[^\n]*)*/, "")
    .replace(/\n{3,}/g, "\n\n").trim();
  const text = `${marker}\n${incomplete || blocking ? "⚠️" : skipped ? "ℹ️" : "✅"} **${title} · ${metadata.head.slice(0, 7)}**\n\n${verdict}${details ? `\n\n${details}` : ""}`;
  const { data: current } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (current.state !== "open" || current.head.sha !== metadata.head || current.base.sha !== metadata.base) throw new Error("PR changed before round summary publication");
  const { data: review } = await github.rest.pulls.createReview({ owner, repo, pull_number: prNumber,
    commit_id: metadata.head, event: "COMMENT", body: text });
  return { id: review.id, url: review.html_url };
}
module.exports = { publishRoundSummary };
