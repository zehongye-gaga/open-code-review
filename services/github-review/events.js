// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Infrastructure } = require("./infrastructure.js");
const { fail, validate } = require("./options.js");
const { dispatchAgent } = require("./agent-dispatch.js");
const { fallbackActor, deliveryJob } = require("./delivery.js");
const actions = new Set(["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft", "closed", "edited"]);
const input = { type: "object", additionalProperties: false, required: ["raw_body", "signature", "delivery_id", "event", "route"], properties: {
  raw_body: { type: "string", minLength: 1, maxLength: 900000 },
  signature: { type: "string", pattern: "^(sha256=[a-f0-9]{64})?$" },
  delivery_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,200}$" },
  event: { type: "string", minLength: 1, maxLength: 100 },
  route: { type: "string", enum: ["direct", "agent"] },
  fallback: { type: "boolean" },
} };
function view(event) {
  return { delivery_id: event.id, repository: event.repository, pull_number: event.number, state: event.state,
    route: event.route, agent_tools: event.agentTools, attempts: event.attempts, job_id: event.jobId || null, created_at: event.createdAt, updated_at: event.updatedAt,
    dispatch_method: event.dispatchMethod || null, child_deliveries: event.childDeliveries, reason: event.reason, fallback_reason: event.fallbackReason || null,
    fallback_at: event.fallbackAt || null, agent_acknowledged_at: event.agentAcknowledgedAt || null,
    error: event.error || null };
}
class GitHubEvents {
  constructor(service) { this.service = service; this.api = new Infrastructure(service); this.activeDispatches = new Map(); this.admissionWrites = new Map(); }
  get running() { return this.activeDispatches.size > 0; }
  async publishAdmission(event) {
    if (!event.admitted || this.admissionWrites.has(event.id) || (event.statusRetryAt || 0) > Date.now()) return;
    const state = event.state === "pending" ? "pending" : event.state === "failed" ? "error" : "success";
    if (event.admissionPublished === state) return;
    const description = state === "pending" ? "OCR accepted; waiting for review dispatch" :
      state === "error" ? "OCR dispatch failed; review did not start" : "OCR dispatch skipped; PR snapshot is no longer eligible";
    const hasOwner = () => this.service.state.data.jobs.some((job) => job.repository === event.repository &&
      job.head === event.head && !job.settings?.preview) ||
      Object.values(this.service.state.data.ciReceipts || {}).some((receipt) => receipt.repository === event.repository && receipt.head_sha === event.head);
    const write = this.service.writeCommitStatus(event.repository, event.head, state, description, undefined, () => {
      if (hasOwner() || event.state === "dispatched") return false;
      const newer = (this.service.state.data.deliveries || []).findLast((entry) => entry.admitted && entry.repository === event.repository && entry.head === event.head);
      return newer === event && (event.state === "pending" ? "pending" : event.state === "failed" ? "error" : "success") === state;
    });
    this.admissionWrites.set(event.id, write);
    try {
      await write;
      event.admissionPublished = state;
      delete event.statusError; delete event.statusRetryAt;
      this.service.state.save();
    } catch (error) {
      if (error.persistence) throw error;
      event.statusError = error.message; event.statusRetryAt = Date.now() + 10000;
      this.service.state.save(); this.service.log("delivery_status_failed", { delivery: event.id, error: error.message });
    } finally { this.admissionWrites.delete(event.id); }
  }
  fallback(event, reason) {
    if (this.service.repo(event.repository)?.agentFallback !== true) fail("Agent fallback is not allowed", 403);
    if (deliveryJob(this.service, event) || event.fallbackAt) return;
    event.fallbackAt = new Date().toISOString(); event.fallbackReason = reason; event.fallbackAttempts = 0;
    event.nextAt = 0;
    this.service.state.save();
    this.service.log("github_agent_fallback", { delivery: event.id, repository: event.repository,
      number: event.number, reason });
  }
  async defaultReview(event, actor) {
    if (event.fallbackAt && this.service.repo(event.repository)?.agentFallback !== true) fail("Agent fallback is no longer allowed", 403);
    const existing = deliveryJob(this.service, event);
    if (existing) return existing;
    if (event.fallbackAt) { event.fallbackAttempts++; this.service.state.save(); }
    const result = await this.api.call("submit_review", { repository: event.repository, pull_number: event.number,
      head_sha: event.head, base_sha: event.base, profile: this.service.repo(event.repository).defaultProfile || "standard",
      request_id: `github:${event.id}` }, event.fallbackAt ? { role: "admin", id: fallbackActor } : actor);
    return this.service.state.data.jobs.find((job) => job.id === result.job_id);
  }
  async agentReview(event, actor) {
    const existing = deliveryJob(this.service, event);
    if (existing) return existing;
    if (event.fallbackAt) return this.defaultReview(event, actor);
    try {
      return await (this.agentDispatch || dispatchAgent)(this.service, event);
    } catch (error) {
      if (error.persistence) throw error;
      const acknowledged = deliveryJob(this.service, event);
      if (acknowledged) return acknowledged;
      if (this.service.stopping || this.service.repo(event.repository)?.agentFallback !== true) throw error;
      this.fallback(event, ["TimeoutError", "AbortError"].includes(error.name) ? "agent_ack_timeout" : "agent_unacknowledged");
      return this.defaultReview(event, actor);
    }
  }
  async accept(args, actor) {
    validate(args, input);
    if (!["dispatcher", "admin"].includes(actor.role)) fail("Only a dispatcher can forward GitHub deliveries", 403);
    const config = this.service.config.infrastructure || {};
    const raw = Buffer.from(args.raw_body, "base64");
    if (raw.toString("base64") !== args.raw_body) fail("raw_body must be canonical base64");
    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); } catch { fail("Invalid GitHub JSON"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("Invalid GitHub payload");
    const repositoryName = typeof payload.repository?.full_name === "string" ? payload.repository.full_name.toLowerCase() : "";
    const unsigned = !args.signature && repositoryName &&
      ((config.unsignedWebhookRepositories || []).includes(repositoryName) ||
        (config.unsignedWebhookOrganizations || []).includes(repositoryName.split("/")[0]));
    if (unsigned) {
      this.api.authorize(repositoryName, actor);
    } else {
      if (!args.signature) fail("Missing GitHub signature", 401);
      if (!config.githubWebhookSecretFile) fail("GitHub webhook signature verification is not configured", 503);
      const secret = fs.readFileSync(config.githubWebhookSecretFile, "utf8").trim();
      if (!secret) fail("GitHub webhook signature verification is not configured", 503);
      const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(args.signature))) fail("Invalid GitHub signature", 401);
    }
    if (args.event === "ping") return { state: "ping", accepted: true };
    if (args.event !== "push" && (args.event !== "pull_request" || !actions.has(payload.action))) return { state: "ignored", reason: "unsupported_event" };
    const repository = this.api.authorize(payload.repository?.full_name, actor);
    const route = repository.requiresAgent ? "agent" : args.route;
    if (route === "agent" && !config.agentDispatch && repository.agentFallback !== true) fail("Agent dispatch is not configured", 503);
    if (args.fallback && (route !== "agent" || repository.agentFallback !== true)) fail("Agent fallback is not allowed", 403);
    const push = args.event === "push";
    if (push && (payload.deleted === true || (typeof payload.ref !== "string" || !payload.ref.startsWith("refs/heads/")))) return { state: "ignored", reason: "not_branch_update" };
    if (push && (!/^[a-f0-9]{40}$/.test(payload.after) || /^0+$/.test(payload.after) || !payload.ref.slice(11))) fail("Invalid push coordinates");
    const pull = payload.pull_request;
    if (!push && (!pull || !Number.isSafeInteger(pull.number) || pull.number < 1 ||
        !/^[a-f0-9]{40}$/.test(pull.head?.sha) || !/^[a-f0-9]{40}$/.test(pull.base?.sha) ||
        pull.base?.repo?.full_name?.toLowerCase() !== repository.name)) fail("Invalid PR coordinates");
    if (config.dispatchEnabled !== true || config.externalDispatch !== true) fail("Direct event dispatch requires completed routing cutover", 409);
    const digest = crypto.createHash("sha256").update(raw).update(args.event).update(args.route).digest("hex");
    const events = this.service.state.data.deliveries ||= [];
    const old = events.find((e) => e.id === args.delivery_id);
    if (old) {
      if (old.digest !== digest) fail("Delivery ID was reused with different content", 409);
      if (args.fallback && old.state === "pending") this.fallback(old, "ingress_ack_missing");
      return { ...view(old), deduplicated: true };
    }
    if (events.length >= 25000) fail("Delivery storage is full; contact the operator", 503);
    const record = { id: args.delivery_id, digest, repository: repository.name, number: push ? null : pull.number,
      head: push ? payload.after : pull.head.sha, base: push ? null : pull.base.sha, baseRef: push ? null : pull.base.ref, action: push ? "push" : payload.action,
      ...(push ? { ref: payload.ref, kind: "push" } : {}), actor: { id: actor.id, role: actor.role, repositories: actor.repositories },
      route, state: "pending", attempts: 0, nextAt: 0, createdAt: new Date().toISOString(),
      admitted: !push && !["closed", "converted_to_draft"].includes(payload.action) && !!this.service.eligible(repository.name, pull) };
    events.push(record);
    if (args.fallback) this.fallback(record, "ingress_ack_missing");
    this.service.state.save();
    if (!push) this.service.dispatchCheck?.watch(record.repository, record.number, record.head);
    await this.publishAdmission(record);
    return { ...view(record), accepted: true };
  }
  status(args, actor) {
    validate(args, { type: "object", properties: { delivery_id: input.properties.delivery_id }, required: ["delivery_id"] });
    const event = (this.service.state.data.deliveries || []).find((e) => e.id === args.delivery_id);
    if (!event) fail("Delivery not found", 404);
    this.api.authorize(event.repository, actor);
    return view(event);
  }
  async expandPush(event, actor) {
    const pulls = [];
    for (let page = 1; ; page++) {
      const { data } = await this.service.github.rest.pulls.listForHead({
        ...this.service.coordinates(event.repository), head: `${event.repository.split("/")[0]}:${event.ref.slice(11)}`, page, per_page: 100 });
      pulls.push(...data);
      if (data.length < 100) break;
      if (page >= 100) throw new Error("Push PR lookup exceeded page limit");
    }
    const events = this.service.state.data.deliveries;
    const children = [];
    for (const pull of pulls) {
      if (!this.service.eligible(event.repository, pull) || pull.head.sha !== event.head ||
          pull.head.ref !== event.ref.slice(11) || pull.head.repo?.full_name?.toLowerCase() !== event.repository) continue;
      const id = `push-${crypto.createHash("sha256").update(event.id).digest("hex")}-${pull.number}`;
      if (!events.some((entry) => entry.id === id) && !children.some((entry) => entry.id === id)) children.push({
        id, parentDelivery: event.id, digest: event.digest, repository: event.repository,
        number: pull.number, head: pull.head.sha, base: pull.base.sha, baseRef: pull.base.ref, action: "synchronize",
        actor: event.actor, route: event.route, state: "pending", admitted: true, attempts: 0, nextAt: 0, createdAt: new Date().toISOString() });
    }
    if (events.length + children.length > 25000) throw new Error("Delivery storage is full");
    events.push(...children);
    this.service.state.save();
    for (const child of children) this.service.dispatchCheck?.watch(child.repository, child.number, child.head);
    event.childDeliveries = events.filter((entry) => entry.parentDelivery === event.id).map((entry) => entry.id);
    event.state = event.childDeliveries.length ? "expanded" : "ignored";
    event.reason = event.childDeliveries.length ? "associated_pull_requests" : "no_eligible_pull_request";
  }
  async tick() { return require("./dispatch-control.js").dispatchTick(this.service, this); }
  async process(event, key) {
    try {
      event.attempts++; event.updatedAt = new Date().toISOString(); this.service.state.save();
      const actor = event.actor.id === "operator" ? event.actor : this.service.config.infrastructure.clients?.find((c) => c.id === event.actor.id);
      if (!actor) fail("Dispatcher credential was removed", 403);
      const repository = this.api.authorize(event.repository, actor);
      if (repository.requiresAgent) event.route = "agent";
      if (event.kind === "push") {
        await this.expandPush(event, actor);
        delete event.error;
        return;
      }
      const { data: pull } = await this.service.github.rest.pulls.get({ ...this.service.coordinates(event.repository), pull_number: event.number });
      if (pull.state !== "open" || pull.draft || !this.service.eligible(event.repository, pull)) {
        for (const job of this.service.state.data.jobs.filter((j) => j.repository === event.repository && j.number === event.number && ["queued", "running", "cancelled"].includes(j.state))) {
          await this.api.call("cancel_review", { job_id: job.id, reason: "PR is closed, draft or outside allowed branches" }, { role: "admin", id: "event-lifecycle" });
        }
        event.state = "ignored";
      } else if (["closed", "converted_to_draft"].includes(event.action) || pull.head.sha !== event.head || pull.base.sha !== event.base || event.baseRef && pull.base.ref !== event.baseRef) {
        event.state = "superseded";
      } else if (event.route === "agent") {
        if (!event.admitted) { event.admitted = true; this.service.state.save(); await this.publishAdmission(event); }
        const job = await this.agentReview(event, actor);
        event.jobId = job.id; event.state = "dispatched";
        event.dispatchMethod ||= event.fallbackAt ? "direct_fallback" : "agent";
      } else {
        if (!event.admitted) { event.admitted = true; this.service.state.save(); await this.publishAdmission(event); }
        const job = await this.defaultReview(event, actor);
        event.jobId = job.id; event.state = "dispatched"; event.dispatchMethod = "direct";
      }
      delete event.error;
    } catch (error) {
      if (error.persistence) throw error;
      this.service.log("github_delivery_failed", { delivery: event.id, error: error.message });
      const failure = require("./dispatch-control.js").dispatchFailure(error);
      event.lastDispatchError = { status: error.status || null, code: error.code || null, at: Date.now() };
      event.error = failure.reason; event.reason = failure.reason;
      if (!failure.retryable || (event.fallbackAt ? event.fallbackAttempts : event.attempts) >= 3) event.state = failure.state;
      else event.nextAt = Math.max(failure.retryAt || 0, Date.now() + Math.min(300, 2 ** (event.fallbackAt ? event.fallbackAttempts : event.attempts)) * 1000);
    } finally {
      event.updatedAt = new Date().toISOString();
      try { this.service.state.save(); await this.publishAdmission(event); } finally { this.activeDispatches.delete(key); }
    }
  }
}
module.exports = { GitHubEvents, input };
