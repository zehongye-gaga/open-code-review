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

test("summary updates the first inline batch without creating another review", async () => {
  const h = fixture(); h.runId = 123;
  h.reviews.push({ id: 10, user: { login: "ocr[bot]" }, commit_id: h.metadata.head, body: "<!-- ocr-review-run:123-1 -->", html_url: "https://example.test/inline" });
  h.reviews.push({ id: 11, user: { login: "ocr[bot]" }, commit_id: h.metadata.head, body: "<!-- ocr-review-run:123-1 -->" });
  h.github.rest.pulls.updateReview = async ({ review_id, body }) => {
    const r = h.reviews.find(r => r.id === review_id); r.body = body; return { data: r };
  };
  const first = await publishRoundSummary(h); const again = await publishRoundSummary(h);
  assert.equal(first.id, 10); assert.equal(again.id, 10); assert.equal(h.reviews.length, 2);
  assert.match(h.reviews[0].body, /ocr-review-run:123-1/);
  assert.match(h.reviews[0].body, /ocr-round:v1/);
  assert.doesNotMatch(h.reviews[1].body, /ocr-round:v1/);
});

test("empty-body fallback review is identified by its own inline comment marker", async () => {
  const h = fixture(); h.runId = 123; h.result.comments = [{ severity: "medium" }];
  h.reviews.push({ id: 10, user: { login: "ocr[bot]" }, commit_id: h.metadata.head, body: "", html_url: "https://example.test/inline" });
  h.github.rest.pulls.listReviewComments = async () => ({ data: [{ user: { login: "ocr[bot]" }, body: "<!-- ocr-123-1-abcd -->", pull_request_review_id: 10 }] });
  h.github.rest.pulls.updateReview = async ({ review_id, body }) => { assert.equal(review_id, 10); h.reviews[0].body = body; return { data: h.reviews[0] }; };
  assert.equal((await publishRoundSummary(h)).id, 10); assert.equal(h.reviews.length, 1);
});

test("a recovered review supersedes a skipped summary and remains deduplicated", async () => {
  const h = fixture(); await publishRoundSummary({ ...h, skipped: true });
  await publishRoundSummary(h); await publishRoundSummary(h);
  assert.equal(h.reviews.length, 2);
  assert.match(h.reviews[0].body, /Review skipped/);
  assert.match(h.reviews[1].body, /Re-review complete/);
});
