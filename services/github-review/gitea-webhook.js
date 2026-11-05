// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";
const fs = require("node:fs"), crypto = require("node:crypto");
function createGiteaWebhook(service) {
  return async (req, res) => {
    if (req.url !== "/webhooks/gitea") return false;
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (!service.config.gitea || req.method !== "POST") { send(404, { error: "Not found" }); return true; }
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) { send(413, { error: "Payload too large" }); return true; } chunks.push(chunk); }
      const raw = Buffer.concat(chunks), signature = req.headers["x-gitea-signature"] || "";
      const secret = fs.readFileSync(service.config.gitea.webhookSecretFile, "utf8").trim();
      if (!secret) throw Error("Gitea webhook secret is empty");
      const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
      if (!/^[a-f0-9]{64}$/.test(signature) || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
        send(401, { error: "Invalid Gitea signature" }); return true;
      }
      const payload = JSON.parse(raw.toString("utf8")), event = req.headers["x-gitea-event"];
      const repository = payload.repository?.full_name?.toLowerCase();
      if (!service.repo(repository)) { send(202, { ignored: true, reason: "repository_not_enabled" }); return true; }
      if (event === "push") {
        // Reconcile through authenticated API reads, including all stacked PR bases.
        await service.poll();
        if (service.pollError) throw Error("Gitea reconciliation failed");
        send(202, { accepted: true }); return true;
      }
      if (!["pull_request", "pull_request_sync"].includes(event)) { send(202, { ignored: true, reason: "unsupported_event" }); return true; }
      const number = payload.pull_request?.number || payload.number;
      if (!Number.isSafeInteger(number) || number < 1) { send(400, { error: "Invalid PR number" }); return true; }
      // Always read current state: replayed close/edit events cannot cancel a newer snapshot.
      const job = await service.observe(repository, number);
      send(202, { accepted: true, job_id: job?.id || null });
    } catch (error) {
      service.log("gitea_webhook_failed", { error: error.message });
      if (error.persistence) throw error;
      send(error instanceof SyntaxError ? 400 : 502, { error: "Gitea event could not be accepted" });
    }
    return true;
  };
}
module.exports = { createGiteaWebhook };
