// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("node:fs");

function createGitHub({ tokenFile, token, api = "https://api.github.com", fetchImpl = fetch }) {
  const getToken = () => {
    const value = tokenFile ? fs.readFileSync(tokenFile, "utf8").trim() : token;
    if (!value) throw new Error("A GitHub repository credential is required");
    return value;
  };
  async function request(method, route, body) {
    const response = await fetchImpl(`${api}${route}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${getToken()}`, accept: "application/vnd.github+json",
        "content-type": "application/json", "user-agent": "open-code-review-service",
        "x-github-api-version": "2022-11-28" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const headers = Object.fromEntries(response.headers.entries());
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const message = typeof data.message === "string" ? data.message.slice(0, 500) : "";
      const error = new Error(`GitHub ${method} ${route.split("?")[0]}: HTTP ${response.status} ${message}`);
      error.status = response.status;
      error.response = { headers, data };
      throw error;
    }
    return { data, headers, status: response.status };
  }
  const repoPath = (p) => `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}`;
  const pullPath = (p) => `${repoPath(p)}/pulls/${p.pull_number}`;
  const page = (p) => `?per_page=${p.per_page || 100}&page=${p.page || 1}`;
  const omit = (p, keys) => Object.fromEntries(Object.entries(p).filter(([k]) => !keys.includes(k)));
  const rest = {
    pulls: {
      get: (p) => request("GET", pullPath(p)),
      list: (p) => request("GET", `${repoPath(p)}/pulls${page(p)}&state=open&sort=updated&direction=desc`),
      listForHead: (p) => request("GET", `${repoPath(p)}/pulls${page(p)}&state=open&head=${encodeURIComponent(p.head)}`),
      listFiles: (p) => request("GET", `${pullPath(p)}/files${page(p)}`),
      listReviews: (p) => request("GET", `${pullPath(p)}/reviews${page(p)}`),
      listReviewComments: (p) => request("GET", `${pullPath(p)}/comments${page(p)}&sort=updated&direction=desc`),
      createReview: (p) => request("POST", `${pullPath(p)}/reviews`, omit(p, ["owner", "repo", "pull_number"])),
    },
    issues: {
      listComments: (p) => request("GET", `${repoPath(p)}/issues/${p.issue_number}/comments${page(p)}`),
      createComment: (p) => request("POST", `${repoPath(p)}/issues/${p.issue_number}/comments`, { body: p.body }),
      updateComment: (p) => request("PATCH", `${repoPath(p)}/issues/comments/${p.comment_id}`, { body: p.body }),
    },
    checks: { listForRef: (p) => request("GET", `${repoPath(p)}/commits/${encodeURIComponent(p.ref)}/check-runs${page(p)}`) },
    users: { getAuthenticated: () => request("GET", "/user") },
    repos: {
      getCombinedStatusForRef: (p) => request("GET", `${repoPath(p)}/commits/${encodeURIComponent(p.ref)}/status${page(p)}`),
      createCommitStatus: (p) => request("POST", `${repoPath(p)}/statuses/${p.sha}`, omit(p, ["owner", "repo", "sha"])),
    },
  };
  return { rest, getToken };
}

module.exports = { createGitHub };
