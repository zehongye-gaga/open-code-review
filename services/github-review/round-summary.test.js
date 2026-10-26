// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { publishRoundSummary } = require("./round-summary.js");
function fixture() {
  const reviews = [], metadata = { head: "a".repeat(40), base: "b".repeat(40), range: { mode: "incremental_files" } };
  const github = { rest: { users: { getAuthenticated: async () => ({ data: { login: "ocr[bot]" } }) }, pulls: {
    listReviews: async () => ({ data: reviews }),
    get: async () => ({ data: { state: "open", head: { sha: metadata.head }, base: { sha: metadata.base } } }),
    createReview: async (args) => { const r = { ...args, id: reviews.length + 1, html_url: "https://example.test/review", user: { login: "ocr[bot]" } }; reviews.push(r); return { data: r }; },
  } } };
  return { github, metadata, reviews, owner: "o", repo: "r", prNumber: 1, result: { comments: [] }, blockSeverity: "medium",
    body: "<!-- ocr-summary -->\nExisting OpenCodeReview summary\n\n<!-- ocr-checkpoint:v1 sample -->" };
}
test("round summary is a commit-bound COMMENT, deduplicated across retries", async () => {
  const h = fixture(); await publishRoundSummary(h); await publishRoundSummary(h);
  assert.equal(h.reviews.length, 1); assert.equal(h.reviews[0].event, "COMMENT");
  assert.equal(h.reviews[0].commit_id, h.metadata.head);
  assert.match(h.reviews[0].body, /ocr-checkpoint:v1/);
  assert.doesNotMatch(h.reviews[0].body, /Existing OpenCodeReview|<details>/);
  h.metadata.head = "c".repeat(40); await publishRoundSummary(h); assert.equal(h.reviews.length, 2);
});
test("round summary preserves non-inline findings and rejects stale publication", async () => {
  const h = fixture(); h.result.comments = [{ severity: "medium" }]; h.body += "\n\n---\n\nFinding outside diff";
  await publishRoundSummary(h); assert.match(h.reviews[0].body, /Finding outside diff/); assert.match(h.reviews[0].body, /⚠️/);
  h.metadata.head = "d".repeat(40); h.github.rest.pulls.get = async () => ({ data: { state: "closed" } });
  await assert.rejects(publishRoundSummary(h), /PR changed/); assert.equal(h.reviews.length, 1);
});
