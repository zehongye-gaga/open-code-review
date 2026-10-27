// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";
const { fail } = require("./options.js");
const fallbackActor = "event-fallback";
function matchesDelivery(job, event) {
  return job.repository === event.repository && job.number === event.number &&
    job.head === event.head && job.base === event.base && !job.settings?.preview && job.state !== "skipped";
}
function deliveryJob(service, event) {
  if (event.ciRequestId) return service.state.data.jobs.find((j) => j.ciRequestId === event.ciRequestId);
  const agentId = service.config.infrastructure?.agentDispatch?.clientId;
  return service.state.data.jobs.findLast((job) => matchesDelivery(job, event) && require("./review-policy.js").currentPolicy(service, job) &&
    (job.id === event.jobId || job.requestId === `github:${event.id}` &&
      [agentId, fallbackActor, event.actor?.id].filter(Boolean).includes(job.requestedBy) ||
      ["queued", "running", "complete", "failed"].includes(job.state)));
}
function submissionDelivery(service, args, actor) {
  const event = (service.state.data.deliveries || []).find((entry) => args.request_id === `github:${entry.id}`);
  if (!event || ![service.config.infrastructure?.agentDispatch?.clientId, fallbackActor, event.actor?.id]
    .filter(Boolean).includes(actor.id)) return null;
  if (event.repository !== args.repository.toLowerCase() || event.number !== args.pull_number ||
      event.head !== args.head_sha || event.base !== args.base_sha) fail("Delivery coordinates changed", 409);
  if (["superseded", "ignored"].includes(event.state)) fail("Delivery is no longer eligible", 409);
  return event;
}
function acknowledgeDelivery(service, event, job, actor) {
  if (!event) return;
  event.jobId = job.id;
  event.dispatchMethod ||= event.fallbackAt ? "direct_fallback" : event.route;
  if (actor.id === service.config.infrastructure?.agentDispatch?.clientId && !event.fallbackAt) {
    event.agentAcknowledgedAt ||= new Date().toISOString();
  }
  service.orgCI?.adoptPending(job);
  service.state.save();
}
module.exports = { fallbackActor, matchesDelivery, deliveryJob, submissionDelivery, acknowledgeDelivery };
