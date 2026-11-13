// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { GitHubAuth } = require("../github-review/github-auth.js");
async function boundedText(response, limit = 8 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw Error("ACTIONS_RESPONSE_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function actionsHTTP(config, request = fetch) {
  const rawRequest = request;
  const stats = { requests: 0, errors: 0, rateRemaining: null };
  request = async (...args) => {
    stats.requests++;
    try {
      const response = await rawRequest(...args);
      if (!response.ok && response.status !== 302) stats.errors++;
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining !== null && /^\d+$/.test(remaining))
        stats.rateRemaining = Number(remaining);
      return response;
    } catch (error) {
      stats.errors++;
      throw error;
    }
  };
  const auth = new GitHubAuth(config, request, Date.now, false);
  async function api(route) {
    if (!/^\/repos\/[\w.-]+\/[\w.-]+\/actions\//.test(route))
      throw Error("INVALID_ACTIONS_ROUTE");
    const response = await request("https://api.github.com" + route, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization: "Bearer " + (await auth.getToken()),
        accept: "application/vnd.github+json",
        "user-agent": "reviewhub-collector",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.status === 401) auth.cached = null;
    if (![200, 302].includes(response.status)) {
      await response.body?.cancel();
      throw Error(
        [403, 429].includes(response.status)
          ? "ACTIONS_ACCESS_OR_RATE_LIMIT"
          : "ACTIONS_HTTP_" + response.status,
      );
    }
    return response;
  }
  return {
    stats,
    async json(route) {
      const response = await api(route);
      if (response.status !== 200) throw Error("ACTIONS_UNEXPECTED_REDIRECT");
      return JSON.parse(await boundedText(response));
    },
    async log(route) {
      const response = await api(route);
      if (response.status === 200) return boundedText(response);
      const location = new URL(response.headers.get("location"));
      await response.body?.cancel();
      if (
        location.protocol !== "https:" ||
        location.username ||
        location.password ||
        location.port ||
        ![
          ".blob.core.windows.net",
          ".actions.githubusercontent.com",
          ".githubusercontent.com",
        ].some((s) => location.hostname.endsWith(s))
      )
        throw Error("ACTIONS_LOG_DESTINATION_REJECTED");
      const download = await request(location.href, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!download.ok) {
        await download.body?.cancel();
        throw Error("ACTIONS_LOG_DOWNLOAD_FAILED");
      }
      return boundedText(download);
    },
  };
}
module.exports = { actionsHTTP, boundedText };
