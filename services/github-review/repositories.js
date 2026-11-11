// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
"use strict";

function repositoryKey(service, name) {
  if (typeof name !== "string") return null;
  name = name.toLowerCase();
  return (service.config.repositories || []).find(repo => repo.name?.toLowerCase() === name || repo.githubName?.toLowerCase() === name)?.name.toLowerCase() || name;
}

function sameRepository(service, left, right) {
  return typeof left === "string" && typeof right === "string" && repositoryKey(service, left) === repositoryKey(service, right);
}

function sameSnapshot(service, left, right) {
  return !!left && !!right && sameRepository(service, left.repository, right.repository) &&
    ["pull_number", "head_sha", "base_sha", "base_ref"].every(key => left[key] !== undefined && left[key] === right[key]);
}

function closedReceipt(receipt) {
  return receipt?.state === "superseded" && ["pr_closed", "pr_changed_or_closed"].includes(receipt.reason);
}

function receiptOwner(service, receipt) {
  const seen = new Set();
  while (receipt?.successorReceipt && !seen.has(receipt.request_id)) {
    seen.add(receipt.request_id);
    const next = service.state.data.ciReceipts?.[receipt.successorReceipt];
    if (!sameSnapshot(service, receipt, next)) break;
    receipt = next;
  }
  return receipt;
}

function hasNewerReceipt(service, receipt) {
  return Object.values(service.state.data.ciReceipts || {}).some(other => other !== receipt && !other.successorReceipt &&
    sameRepository(service, other.repository, receipt.repository) && other.pull_number === receipt.pull_number &&
    other.sequence > receipt.sequence && other.admissionVerified !== false &&
    !(other.repository !== receipt.repository && closedReceipt(other) && sameSnapshot(service, other, receipt)));
}

module.exports = { repositoryKey, sameRepository, sameSnapshot, closedReceipt, receiptOwner, hasNewerReceipt };
