// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs");

function createGitea({ origin, tokenFile, fetchImpl = fetch }) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error("Gitea requires an HTTPS origin");
  origin = url.origin;
  const getToken = () => fs.readFileSync(tokenFile, "utf8").trim();
  async function request(method, route, body) {
    const response = await fetchImpl(`${origin}/api/v1${route}`, { method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { authorization: `token ${getToken()}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const headers = Object.fromEntries(response.headers.entries());
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok || data === null) {
      const error = Error(`Gitea ${method}: HTTP ${response.status}${data === null ? " invalid JSON" : ""}`);
      error.status = response.ok ? 502 : response.status;
      error.response = { data, headers, status: error.status };
      throw error;
    }
    return { data, status: response.status, headers };
  }
  const repo = p => `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}`;
  const pull = p => `${repo(p)}/pulls/${p.pull_number}`;
  const page = p => `?limit=${p.per_page || 100}&page=${p.page || 1}`;
  async function* items(route, paginated = true) {
    let next = paginated ? `${route}${route.includes("?") ? "&" : "?"}limit=100&page=1` : route;
    let seen = 0;
    const visited = new Set();
    for (let count = 0; next && count < 10000; count++) {
      const canonical = new URL(origin + "/api/v1" + next);
      canonical.searchParams.sort();
      if (visited.has(canonical.href)) throw Error("Repeated Gitea pagination cursor");
      visited.add(canonical.href);
      const { data, headers } = await request("GET", next);
      if (!Array.isArray(data)) throw Error("Invalid Gitea collection response");
      yield* data;
      seen += data.length;
      if (!paginated) return;
      const link = (headers.link || "").split(",").find(value => /rel="next"/.test(value));
      if (!link) {
        const total = headers["x-total-count"];
        if (!data.length || (/^\d+$/.test(total || "") && seen >= Number(total))) { next = null; continue; }
        const target = new URL(origin + "/api/v1" + next);
        target.searchParams.set("page", String(Number(target.searchParams.get("page")) + 1));
        next = target.pathname.slice(7) + target.search;
        continue;
      }
      const match = link.match(/<([^>]+)>/);
      if (!match || !data.length) throw Error("Invalid Gitea pagination");
      const target = new URL(match[1], origin);
      if (target.origin !== origin || target.username || target.password || !target.pathname.startsWith("/api/v1/")) throw Error("Invalid Gitea pagination origin");
      const routeNext = target.pathname.slice(7) + target.search;
      if (routeNext === next) throw Error("Repeated Gitea pagination cursor");
      next = routeNext;
    }
    if (next) throw Error("Gitea pagination limit exceeded");
  }
  const traversals = new Map();
  async function window(key, p, factory) {
    const size = p.per_page || 100, pageNumber = p.page || 1;
    key = `${key}:${size}`;
    let traversal = pageNumber > 1 && traversals.get(key);
    if (!traversal || traversal.busy || traversal.nextPage !== pageNumber || traversal.expires < Date.now()) {
      traversal = { iterator: factory(), nextPage: pageNumber, expires: Date.now() + 30000 };
      for (let i = 0; i < (pageNumber - 1) * size; i++) if ((await traversal.iterator.next()).done) return { data: [] };
      if (traversals.size >= 256) traversals.delete(traversals.keys().next().value);
      traversals.set(key, traversal);
    }
    // Claim the page before awaiting so overlapping callers start separate traversals.
    traversal.busy = true;
    traversal.nextPage = pageNumber + 1;
    const data = [];
    try {
    while (data.length < size) {
      const item = await traversal.iterator.next();
      if (item.done) { if (traversals.get(key) === traversal) traversals.delete(key); break; }
      data.push(item.value);
    }
    traversal.expires = Date.now() + 30000;
    return { data };
    } catch (error) {
      if (traversals.get(key) === traversal) traversals.delete(key);
      throw error;
    } finally { traversal.busy = false; }
  }
  const collection = (route, p, paginated = true) => window(route, p, () => items(route, paginated));
  const normalize = p => ({ ...p, draft: p.draft === true || /^\s*(?:\[WIP\]|WIP:|\[DRAFT\]|DRAFT:)/i.test(p.title || "") });
  const review = r => ({ ...r, submitted_at: r.submitted_at || r.submitted });
  const rest = {
    users: { getAuthenticated: () => request("GET", "/user") },
    pulls: {
      get: async p => { const r = await request("GET", pull(p)); return { ...r, data: normalize(r.data) }; },
      list: async p => { const r = await collection(`${repo(p)}/pulls?state=open`, p); return { ...r, data: r.data.map(normalize) }; },
      listFiles: p => collection(`${pull(p)}/files`, p),
      listReviews: async p => { const r = await collection(`${pull(p)}/reviews`, p); return { ...r, data: r.data.map(review) }; },
      listReviewComments: p => window(`${pull(p)}/all-comments`, p, async function* () {
        for await (const r of items(`${pull(p)}/reviews`)) {
          for await (const c of items(`${pull(p)}/reviews/${r.id}/comments`, false)) {
            yield { ...c, pull_request_review_id: r.id, commit_id: r.commit_id,
              original_commit_id: c.original_commit_id || r.commit_id, line: c.position, original_line: c.original_position || c.position,
              side: c.diff_side === "previous" ? "LEFT" : "RIGHT" };
          }
        }
      }),
      createReview: p => request("POST", `${pull(p)}/reviews`, { body: p.body || "", commit_id: p.commit_id,
        event: p.event === "APPROVE" ? "APPROVED" : p.event,
        comments: (p.comments || []).map(c => ({ path: c.path, body: c.body,
          old_position: c.side === "LEFT" ? c.line : 0, new_position: c.side === "LEFT" ? 0 : c.line })) }),
    },
    issues: {
      listComments: p => collection(`${repo(p)}/issues/${p.issue_number}/comments`, p, false),
      createComment: p => request("POST", `${repo(p)}/issues/${p.issue_number}/comments`, { body: p.body }),
      updateComment: p => request("PATCH", `${repo(p)}/issues/comments/${p.comment_id}`, { body: p.body }),
    },
    repos: {
      createCommitStatus: p => request("POST", `${repo(p)}/statuses/${p.sha}`, { state: p.state, context: p.context, description: p.description, target_url: p.target_url }),
      getCombinedStatusForRef: p => request("GET", `${repo(p)}/commits/${encodeURIComponent(p.ref)}/status${page(p)}`),
    },
  };
  return { rest, getToken, gitOrigin: origin, capabilities: { updateReview: false },
    graphql: async () => { throw Error("Gitea does not support GitHub review threads"); } };
}
module.exports = { createGitea };
