// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const { createGitHub } = require("./github.js");
const { ReviewService } = require("./service.js");
const { feedbackTick } = require("./agent-session.js");

function equal(a, b) {
  const left = Buffer.from(a || ""), right = Buffer.from(b || "");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createServer(service, { apiToken, webhookSecret } = {}) {
  const infrastructure = require("./transport.js").createInfrastructureHandler(service, apiToken);
  return http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    };
    try {
      if (await infrastructure(req, res)) return;
      if (req.url === "/healthz" && req.method === "GET") {
        const degraded = service.pollError || service.statusError || !service.lastPoll;
        return send(degraded ? 503 : 200, { status: degraded ? "degraded" : "ok",
          lastPoll: service.lastPoll, active: service.active?.job.id || null,
          activeJobs: [...service.workers.entries()].map(([slot, { job }]) => ({
            id: job.id, repository: job.repository, number: job.number, head: job.head, slot, startedAt: job.startedAt,
          })),
          running: service.workers.size, prConcurrency: service.config.prConcurrency,
          queued: service.state.data.jobs.filter((job) => job.state === "queued").length });
      }
      const webhook = req.url === "/webhooks/github" && req.method === "POST";
      if (webhook ? !webhookSecret : !apiToken || !equal(req.headers.authorization, `Bearer ${apiToken}`)) {
        return send(401, { error: "Unauthorized" });
      }
      if (req.url === "/v1/jobs" && req.method === "GET") return send(200, service.state.data.jobs.slice(-100).reverse());
      if (req.method !== "POST" || !["/webhooks/github", "/v1/reviews"].includes(req.url)) return send(404, { error: "Not found" });
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) return send(413, { error: "Payload too large" });
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (webhook) {
        const expected = "sha256=" + crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
        if (!equal(req.headers["x-hub-signature-256"], expected)) return send(401, { error: "Invalid signature" });
      }
      let payload;
      try { payload = JSON.parse(body.toString("utf8")); } catch { return send(400, { error: "Invalid JSON" }); }
      let job;
      if (webhook) {
        if (req.headers["x-github-event"] === "ping") return send(200, { ok: true });
        if (req.headers["x-github-event"] !== "pull_request" ||
            !["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft", "closed", "edited"].includes(payload.action)) {
          return send(202, { ignored: true });
        }
        if (!service.repo(payload.repository?.full_name)) return send(202, { ignored: true });
        if (service.config.infrastructure?.externalDispatch) return send(409, { error: "Use the authorized v2 dispatch interface" });
        job = await service.observe(payload.repository.full_name, payload.pull_request?.number);
      } else {
        if (!service.repo(payload.repository) || !Number.isSafeInteger(payload.pull_number) || payload.pull_number < 1) {
          return send(400, { error: "Repository or PR is not allowed" });
        }
        if (service.config.infrastructure?.externalDispatch) return send(409, { error: "Use v2 with exact head/base and review options" });
        job = await service.observe(payload.repository, payload.pull_number, { force: true });
      }
      return send(202, { queued: Boolean(job), job: job?.id || null });
    } catch (error) {
      service.log("request_failed", { error: error.message });
      if (!res.headersSent) send(502, { error: "Request failed; check service logs" });
      if (error.persistence) process.exit(1);
    }
  });
}

async function main() {
  const configFile = process.argv[2] || process.env.OCR_SERVICE_CONFIG;
  if (!configFile) throw new Error("Usage: node services/github-review/server.js /path/to/config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const github = createGitHub({ githubAuth: config.githubAuth, tokenFile: config.githubTokenFile, token: process.env.OCR_GITHUB_TOKEN });
  await github.getToken();
  const service = new ReviewService({ config, github });
  const secret = (file, value) => file ? fs.readFileSync(file, "utf8").trim() : value;
  const server = createServer(service, {
    apiToken: secret(config.apiTokenFile, process.env.OCR_SERVICE_API_TOKEN),
    webhookSecret: secret(config.webhookSecretFile, process.env.OCR_WEBHOOK_SECRET),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(service.config.port, service.config.listen, resolve);
  });
  let infrastructureServer;
  if (config.infrastructure?.enabled && config.infrastructure.listen && config.infrastructure.port) {
    infrastructureServer = createServer(service, {
      apiToken: secret(config.apiTokenFile, process.env.OCR_SERVICE_API_TOKEN),
    });
    await new Promise((resolve, reject) => {
      infrastructureServer.once("error", reject);
      infrastructureServer.listen(config.infrastructure.port, config.infrastructure.listen, resolve);
    });
    service.log("infrastructure_listening", { address: infrastructureServer.address() });
  }
  service.log("listening", { address: server.address(), repositories: config.repositories.map((repo) => repo.name) });
  const safe = (fn) => () => Promise.resolve().then(fn).catch((error) => {
    service.log("loop_failed", { error: error.message });
    if (error.persistence) process.exit(1);
  });
  await service.poll();
  service.cleanup();
  const poller = setInterval(safe(() => service.poll()), service.config.pollSeconds * 1000);
  const worker = setInterval(safe(() => service.tick()), 1000);
  const deliveries = setInterval(safe(() => service.githubEvents?.tick()), 1000);
  const feedback = setInterval(safe(() => feedbackTick(service)), 1000);
  const ciWatchdog = setInterval(safe(() => service.orgCI?.watchdog()), 30000);
  const cleaner = setInterval(safe(() => service.cleanup()), 3600000);
  const stop = () => {
    service.stop(); clearInterval(poller); clearInterval(worker); clearInterval(cleaner); clearInterval(deliveries); clearInterval(feedback); clearInterval(ciWatchdog);
    server.close(); server.closeIdleConnections();
    infrastructureServer?.close(); infrastructureServer?.closeIdleConnections();
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
module.exports = { createServer, main };
