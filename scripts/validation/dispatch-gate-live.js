// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { ReviewService } = require("../../services/github-review/service.js");
const { createGitHub } = require("../../services/github-review/github.js");
const { createServer } = require("../../services/github-review/server.js");
const [configFile, stateDirectory, numberText, operation, expected, consent] = process.argv.slice(2);
if (consent !== "--live-test" || !/^[1-9][0-9]*$/.test(numberText) || !["admit","verify","fail","late"].includes(operation)) throw Error("CONFIG ISOLATED_STATE PR OPERATION EXPECTED --live-test required");
const live = JSON.parse(fs.readFileSync(configFile)), directory = path.resolve(stateDirectory);
if (directory === path.resolve(live.stateDirectory) || !path.basename(directory).startsWith("dispatch-gate-test-")) throw Error("Isolated test directory required");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const repository = "lexmount/ocr-test-public", number = Number(numberText);
const github = createGitHub({ githubAuth: live.githubAuth, tokenFile: live.githubTokenFile });
(async () => {
  const { data: pr } = await github.rest.pulls.get({ owner: "lexmount", repo: "OCR-Test-Public", pull_number: number });
  assert.match(pr.base.ref, /^test\/dispatch-gate-[ab]-/); assert.match(pr.head.ref, /^test\/dispatch-gate-/);
  const config = { ...live, stateDirectory: directory, repositories: [{ name: repository, baseBranches: ["*"] }], statusContext: "ocr-dispatch-test-review",
    infrastructure: { enabled: true, dispatchEnabled: true, externalDispatch: true, githubWebhookSecretFile: live.infrastructure.githubWebhookSecretFile,
      dispatchCheck: { enabled: true }, clients: [] } };
  const service = new ReviewService({ config, github, log() {} });
  const apiToken = crypto.randomBytes(32).toString("hex"), server = createServer(service, { apiToken });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const before = (await github.rest.repos.getCombinedStatusForRef({ owner: "lexmount", repo: "OCR-Test-Public", ref: pr.head.sha })).data.statuses.find(s => s.context === "ocr-dispatch");
    if (operation === "admit" || operation === "late") {
      const saved = path.join(directory, "original-payload.json");
      const payload = operation === "late" ? JSON.parse(fs.readFileSync(saved)) : { action: "edited", repository: pr.base.repo, pull_request: pr };
      if (!fs.existsSync(saved)) fs.writeFileSync(saved, JSON.stringify(payload));
      const raw = Buffer.from(JSON.stringify(payload)), secret = fs.readFileSync(config.infrastructure.githubWebhookSecretFile, "utf8").trim();
      const envelope = { raw_body: raw.toString("base64"), signature: "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex"), delivery_id: `dispatch-gate-${crypto.randomUUID()}`, event: "pull_request", route: "direct" };
      const send = () => fetch(`http://127.0.0.1:${server.address().port}/v2/github_event`, { method: "POST", headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" }, body: JSON.stringify(envelope) });
      const response = await send(); assert.equal(response.status, 202); await response.json();
      const repeated = await send(); assert.equal((await repeated.json()).deduplicated, true);
    } else if (operation === "fail") {
      for (const record of service.state.data.deliveries || []) if (record.number === number && record.baseRef === pr.base.ref) record.state = "failed";
      service.state.save();
    }
    service.dispatchCheck.watch(repository, number, pr.head.sha);
    await service.dispatchCheck.tick();
    assert.equal(service.state.data.jobs.length, 0);
    const status = (await github.rest.repos.getCombinedStatusForRef({ owner: "lexmount", repo: "OCR-Test-Public", ref: pr.head.sha })).data.statuses.find(s => s.context === "ocr-dispatch");
    assert.equal(status.state, expected);
    const result = { operation, number, head: pr.head.sha, base: pr.base.sha, baseRef: pr.base.ref, before: before?.state || null, after: status.state,
      statusId: status.id, author: (await github.rest.users.getAuthenticated()).data.login, jobs: 0, snapshots: Object.values(service.state.data.dispatchChecks).flatMap(e=>e.snapshots || []) };
    fs.appendFileSync(path.join(directory, "evidence.jsonl"), JSON.stringify(result) + "\n"); console.log(JSON.stringify(result));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
