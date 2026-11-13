// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const { GitHubAuth } = require("../github-review/github-auth.js");

async function repositoryMetadata(config, previous, now, request = fetch) {
  const auth = new GitHubAuth(config, request, Date.now, false),
    result = { ...previous },
    warnings = [];
  for (const repository of config.repositories) {
    const name = repository.name.toLowerCase(),
      saved = previous[name],
      refreshMs = saved?.access === "available" ? 3600000 : 300000;
    if (saved?.checkedAt && now - Date.parse(saved.checkedAt) < refreshMs) {
      if (saved.access !== "available")
        warnings.push(
          saved.access === "unavailable"
            ? "REPOSITORY_ACCESS_UNAVAILABLE"
            : "GITHUB_METADATA_UNVERIFIED"
        );
      continue;
    }
    try {
      let expectedId = saved?.providerId || null;
      if (expectedId && !/^[1-9]\d*$/.test(expectedId))
        throw Error("Invalid stored repository ID");
      let url = expectedId
        ? `https://api.github.com/repositories/${expectedId}`
        : `https://api.github.com/repos/${repository.githubName || repository.name}`;
      let response;
      for (let redirects = 0; redirects <= 2; redirects++) {
        response = await request(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
          headers: {
            authorization: "Bearer " + (await auth.getToken()),
            accept: "application/vnd.github+json",
            "user-agent": "reviewhub-collector",
            "x-github-api-version": "2022-11-28"
          }
        });
        if (response.status === 401) auth.cached = null;
        if (response.status !== 301) break;
        const target = new URL(response.headers.get("location"), url);
        await response.body?.cancel();
        const id = /^\/repositories\/([1-9]\d*)$/.exec(target.pathname)?.[1];
        if (
          redirects === 2 ||
          target.origin !== "https://api.github.com" ||
          target.username ||
          target.password ||
          target.search ||
          target.hash ||
          !id ||
          (expectedId && expectedId !== id)
        )
          throw Error("Invalid repository redirect");
        expectedId = id;
        url = target.href;
      }
      if (response.status === 404) {
        await response.body?.cancel();
        result[name] = {
          ...saved,
          access: "unavailable",
          checkedAt: new Date(now).toISOString()
        };
        warnings.push("REPOSITORY_ACCESS_UNAVAILABLE");
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw Error("Repository metadata unavailable");
      }
      const body = await response.json();
      if (
        !Number.isSafeInteger(body.id) ||
        body.id < 1 ||
        (expectedId && String(body.id) !== expectedId) ||
        typeof body.full_name !== "string" ||
        !/^[\w.-]+\/[\w.-]+$/.test(body.full_name) ||
        body.full_name.split("/")[0].toLowerCase() !== name.split("/")[0] ||
        typeof body.default_branch !== "string" ||
        !body.default_branch
      )
        throw Error("Invalid repository metadata");
      result[name] = {
        providerId: String(body.id),
        name: body.full_name.toLowerCase(),
        defaultBranch: body.default_branch,
        archived: body.archived === true,
        updatedAt: new Date(now).toISOString(),
        checkedAt: new Date(now).toISOString(),
        access: auth.app ? "available" : "unknown"
      };
      if (!auth.app) warnings.push("APP_ACCESS_NOT_VERIFIED");
    } catch {
      result[name] = {
        ...saved,
        access: "unknown",
        checkedAt: new Date(now).toISOString()
      };
      warnings.push("GITHUB_METADATA_UNAVAILABLE");
    }
  }
  return { metadata: result, warnings };
}
module.exports = { repositoryMetadata };
