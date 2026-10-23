// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

const copy = JSON.parse(document.getElementById("copy").textContent);
const { needsAction, tracked, historyResult, connectionState } = globalThis.ReviewMonitorView;
const t = (key) => copy[key] || key;
const $ = (id) => document.getElementById(id);
const node = (tag, className, value) => { const n = document.createElement(tag); if (className) n.className = className; if (value !== undefined) n.textContent = value; return n; };
const set = (id, value) => { $(id).textContent = value; };
const compact = (value) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
function bytes(value) {
  if (value === null || value === undefined) return "—";
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(1)} GB`;
  return `${Math.round(value / 1048576)} MB`;
}
function duration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}${t("seconds")}`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}${t("minutes")}`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}${t("hours")}`;
  return `${(seconds / 86400).toFixed(1)}${t("days")}`;
}
function ago(value) {
  if (!value) return t("never");
  if (Date.now() - Date.parse(value) < 5000) return t("justNow");
  return `${duration(Math.max(0, (Date.now() - Date.parse(value)) / 1000))}${t("ago")}`;
}
const time = (value) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—";
let repository = new URLSearchParams(location.search).get("repository")?.toLowerCase() || "";
let refreshAgain = false;
let snapshot = null, filter = "tracked", busy = false, disconnected = false;

function link(label, url, className) {
  const n = node("a", className, label);
  try { const parsed = new URL(url); if (parsed.protocol === "https:" && parsed.hostname === "github.com") { n.href = parsed.href; n.target = "_blank"; n.rel = "noopener noreferrer"; } } catch { /* Missing links remain plain text. */ }
  return n;
}

function badge(state, label) {
  const type = ["success", "failure", "error", "pending", "missing", "failed", "running"].includes(state) ? state : "neutral";
  const symbol = { success: "✓", failure: "×", failed: "!", error: "!", pending: "◷", running: "◷", missing: "–", neutral: "·" }[type];
  return node("span", `badge ${type}`, `${symbol} ${label || t(state)}`);
}

function serviceCard(key, service) {
  const card = node("div", "service"), title = node("div", "service-name");
  title.append(node("h3", "", t(key)), badge(service.healthy ? "success" : "error", t(service.healthy ? "healthy" : "abnormal")));
  card.append(title);
  card.append(node("p", "service-desc", key === "ocr" ? `${service.model || "OCR"} · ${service.budget === 0 ? t("unlimited") : compact(service.budget)}` : `CR Agent · ${t("statusOnly")} ${service.state}`));
  const stats = node("div", "service-stats");
  for (const [label, value] of [["running", service.running], ["queued", service.queued], ["concurrency", service.concurrency]]) {
    const cell = node("span"); cell.append(node("strong", "", value ?? "—"), document.createTextNode(t(label))); stats.append(cell);
  }
  card.append(stats);
  const slots = node("div", "slots");
  for (let i = 0; i < Math.min(service.concurrency || 1, 32); i++) slots.append(node("div", `slot${i < service.running ? " filled" : ""}`));
  card.append(slots);
  const meta = node("div", "service-meta");
  meta.append(node("span", "", `${t("memory")} ${bytes(service.memoryBytes)}`), node("span", "", `${t("uptime")} ${duration(service.uptimeSeconds)}`),
    node("span", service.pollStale ? "amber" : "", `${t("poll")} ${ago(service.lastPoll)} · ${t("restarts")} ${service.restarts ?? "—"}`));
  if (key === "ocr") meta.append(node("span", "", service.blockSeverity === "low" ? t("anyFinding") : `${t("blockSeverity")} ${service.blockSeverity}`));
  if (service.sourceError) meta.append(node("span", "rose", t("sourceError")));
  for (const source of service.sources || []) if (source.stale || source.error) meta.append(node("span", "amber", `${source.name}: ${source.error ? t("sourceError") : ago(source.lastPoll)}`));
  card.append(meta); return card;
}

function resource(label, used, total, foot) {
  const block = node("div", "resource"), row = node("div", "resource-label"), ratio = total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : null;
  row.append(node("span", "", label), node("span", "mono", ratio === null ? "—" : `${ratio.toFixed(1)}%`));
  const bar = node("div", "bar"), fill = node("div", `bar-fill${ratio >= 95 ? " danger" : ratio >= 85 ? " warn" : ""}`);
  fill.style.width = `${ratio || 0}%`; bar.append(fill);
  block.append(row, bar, node("div", "resource-foot", foot)); return block;
}

function renderWork(data) {
  const list = $("work"); list.replaceChildren(); set("work-count", `${data.work.length} ${t("items")}`);
  if (!data.work.length) {
    const empty = node("div", "empty-work"), desc = node("div"); desc.append(node("p", "", t("idle")), node("span", "", t("idleHint")));
    empty.append(node("div", "empty-icon", "✓"), desc); list.append(empty); return;
  }
  for (const job of data.work) {
    const card = node("div", `work-card${job.overdue ? " overdue" : ""}`), top = node("div", "work-card-top");
    top.append(link(`${job.repository} #${job.number}`, `https://github.com/${job.repository}/pull/${job.number}`), badge(job.state === "running" ? "running" : "pending", t(job.state === "queued" && job.attempt > 0 ? "retry" : job.state)));
    const pr = data.pulls.find((p) => p.repository === job.repository && p.number === job.number);
    const relation = !pr ? "" : ` · ${t(pr.head === job.head ? "current" : "previous")}`;
    card.append(top, node("p", "work-meta", `${t(job.engine)} · ${String(job.head || "").slice(0, 8)}${relation}`),
      node("p", job.overdue ? "amber" : "", `${job.overdue ? t("timeout") : t("elapsed")} ${duration(job.elapsedSeconds)} · ${t("attempt")} ${job.attempt || 1}${job.slot !== null && job.slot !== undefined ? ` · ${t("slot")} ${job.slot}` : ""}`));
    if (job.resume || job.incremental) card.append(node("p", "", [job.resume ? t("checkpoint") : "", job.incremental ? t("incremental") : ""].filter(Boolean).join(" · ")));
    list.append(card);
  }
}

function renderPulls(data) {
  const search = $("search").value.toLowerCase().trim(), tbody = $("pulls"); tbody.replaceChildren();
  const pulls = data.pulls.filter((pr) => (filter === "all" || pr.inScope && (filter === "attention" ? needsAction(pr) : tracked(pr))) &&
    `${pr.number} ${pr.title} ${pr.repository}`.toLowerCase().includes(search));
  set("pr-count", `${t("shown")} ${pulls.length} / ${data.pulls.length}`);
  for (const pr of pulls) {
    const row = node("tr"), name = node("td"), anchor = link("", pr.url, "pr-link");
    anchor.append(node("span", "pr-number", `#${pr.number}`), document.createTextNode(pr.title));
    const meta = node("div", "pr-meta"); meta.append(node("span", "mono", pr.head?.slice(0, 8) || "—"), node("span", "", `${pr.repository} → ${pr.base}`));
    if (!pr.inScope) meta.append(node("span", "", t(pr.draft ? "draft" : "outOfScope")));
    name.append(anchor, meta); row.append(name);
    for (const key of ["ocr", "cragent"]) {
      const cell = node("td"), status = pr[key], anchor = link("", status.url || pr.url); anchor.append(badge(status.state)); cell.append(anchor);
      if (status.attempt > 1 && ["pending", "error"].includes(status.state)) cell.append(node("span", "status-note", `${t("attempt")} ${status.attempt}`));
      row.append(cell);
    }
    const updated = node("td", "muted", ago(pr.updatedAt)); updated.title = time(pr.updatedAt); row.append(updated); tbody.append(row);
  }
  if (!pulls.length) { const row = node("tr"), cell = node("td", "empty-cell", data.github.updatedAt ? t("noMatch") : t("githubLoading")); cell.colSpan = 4; row.append(cell); tbody.append(row); }
  const missing = data.pulls.filter((pr) => pr.inScope && pr.ocr.state === "missing").length;
  set("coverage", `${t("unreviewed")} ${missing} ${t("prs")}`);
}

function renderHistory(data) {
  const tbody = $("history"); tbody.replaceChildren();
  for (const job of data.history.slice(0, 35)) {
    const row = node("tr"), pr = node("td"); pr.append(link(`${job.repository} #${job.number}`, job.resultURL || `https://github.com/${job.repository}/pull/${job.number}`, "pr-number"), node("span", "mono muted", String(job.head || "").slice(0, 8)));
    const result = node("td");
    let label = t(job.state);
    if (job.state === "complete" && job.findings !== null) label = job.findings > 0 ? `${job.findings} ${t("findings")}` : t("clean");
    result.append(badge(historyResult(job), label));
    row.append(pr, node("td", "", t(job.engine)), result, node("td", "mono muted", job.usage ? compact(job.usage.totalTokens) : "—"), node("td", "muted", time(job.updatedAt))); tbody.append(row);
  }
  if (!data.history.length) { const row = node("tr"), cell = node("td", "empty-cell", t("noHistory")); cell.colSpan = 5; row.append(cell); tbody.append(row); }
}

function render() {
  const data = snapshot;
  const connection = connectionState(data, disconnected);
  if (!data?.ready) {
    set("notice", t(disconnected ? "fetchError" : "loading"));
    $("notice").className = `notice${disconnected ? " danger" : ""}`;
    set("connection", t(connection)); $("connection").className = `live${disconnected ? " rose" : ""}`;
    return;
  }
  const selector = $("repository");
  selector.replaceChildren(node("option", "", t("allRepositories")), ...(data.repositories || []).map((name) => {
    const option = node("option", "", name); option.value = name; return option;
  }));
  selector.options[0].value = ""; selector.value = repository;
  const localStale = data.stale || Date.now() - Date.parse(data.collectedAt) > 45000;
  const githubStale = data.github.stale || data.github.error || Date.now() - Date.parse(data.github.updatedAt) > 180000;
  const services = Object.values(data.services).filter(Boolean), warnings = [];
  if (disconnected) warnings.push(t("fetchError"));
  else if (localStale) warnings.push(t("localError"));
  if (services.some((service) => !service.healthy)) warnings.push(t("serviceError"));
  if (githubStale) warnings.push(t(data.github.updatedAt ? "githubError" : "githubLoading"));
  if (data.resources.volumes.some((v) => v.totalBytes && v.availableBytes / v.totalBytes < .1)) warnings.push(t("diskWarning"));
  $("notice").className = `notice${disconnected || localStale ? " danger" : warnings.length ? " warn" : ""}`;
  set("notice", warnings.join(" ") || t("normalNotice"));
  document.body.classList.toggle("offline", disconnected || localStale || githubStale);
  set("connection", t(connection));
  $("connection").className = `live${disconnected || localStale ? " rose" : ""}`;
  set("last-update", `${t("updated")} ${time(data.collectedAt)} · ${t("githubUpdated")} ${ago(data.github.updatedAt)}`);
  set("running", Object.values(data.scopedCounts || data.services).filter(Boolean).reduce((n, s) => n + s.running, 0));
  set("running-detail", services.map((s, i) => `${i === 0 ? "OCR" : "CR Agent"} ${data.scopedCounts?.[i === 0 ? "ocr" : "cragent"]?.running ?? s.running}`).join(" · "));
  set("queued", Object.values(data.scopedCounts || data.services).filter(Boolean).reduce((n, s) => n + s.queued, 0));
  const attention = data.pulls.filter((pr) => pr.inScope && needsAction(pr));
  set("findings", data.github.updatedAt ? attention.length : "—");
  set("findings-detail", `${t("failure")} ${attention.filter((pr) => [pr.ocr, pr.cragent].some((s) => s.state === "failure")).length} · ${t("error")} ${attention.filter((pr) => [pr.ocr, pr.cragent].some((s) => s.state === "error")).length}`);
  set("tokens", data.services.ocr.sourceError ? "—" : compact(data.usage.totalTokens));
  set("tokens-detail", `${data.usage.reports} ${t("reports")}${data.usage.expectedReports !== data.usage.reports ? ` · ${t("reportMissing")} ${data.usage.expectedReports - data.usage.reports}` : ""}`);
  $("services").replaceChildren(...Object.entries(data.services).filter(([, service]) => service).map(([key, service]) => serviceCard(key, { ...service, healthy: service.healthy && !localStale && !disconnected })));
  const resources = $("resources"), host = data.resources; resources.replaceChildren();
  for (const volume of host.volumes) resources.append(resource(volume.label, volume.totalBytes === null ? null : volume.totalBytes - volume.availableBytes, volume.totalBytes, `${bytes(volume.availableBytes)} ${t("available")} / ${bytes(volume.totalBytes)}`));
  resources.append(resource(t("memoryUsed"), host.memoryTotalBytes - host.memoryAvailableBytes, host.memoryTotalBytes, `${bytes(host.memoryAvailableBytes)} ${t("available")} / ${bytes(host.memoryTotalBytes)}`));
  const load = node("div", "load-row"); load.append(node("span", "", t("load")), node("span", "mono", `${host.load[0].toFixed(2)} / ${host.cpuCount} ${t("cores")}`)); resources.append(load);
  if (host.cpu) resources.append(resource(t("cpuUsage"), host.cpu.busy, 100, `${t("kernelUsage")} ${host.cpu.system.toFixed(1)}% · ${t("ioWait")} ${host.cpu.iowait.toFixed(1)}%`));
  if (host.swapTotalBytes) resources.append(resource(t("swapUsage"), host.swapTotalBytes - host.swapFreeBytes, host.swapTotalBytes, `${bytes(host.swapFreeBytes)} / ${bytes(host.swapTotalBytes)}`));
  for (const volume of host.volumes) if (volume.totalInodes) resources.append(resource(`${volume.label} ${t("inodeUsage")}`, volume.totalInodes - volume.freeInodes, volume.totalInodes, `${compact(volume.freeInodes)} ${t("available")}`));
  resources.append(node("p", "section-note", t("resourceThresholds")));
  renderAudit(data);
  renderWork(data); renderPulls(data); renderHistory(data); window.OCRAnalytics.render(data);
}

async function refresh() {
  if (busy) { refreshAgain = true; return; }
  const requestedRepository = repository;
  busy = true; $("refresh").disabled = true;
  try {
    const response = await fetch(`/api/status?${new URLSearchParams({ repository: requestedRepository })}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Snapshot unavailable");
    const next = await response.json();
    if (requestedRepository === repository) { snapshot = next; disconnected = false; }
  } catch { disconnected = true; }
  finally { busy = false; $("refresh").disabled = false; }
  if (!snapshot && disconnected) { set("notice", t("fetchError")); $("notice").className = "notice danger"; set("connection", t("disconnected")); }
  else if (snapshot?.repository === repository) render();
  if (refreshAgain) { refreshAgain = false; void refresh(); }
}

$("repository").addEventListener("change", () => {
  repository = $("repository").value;
  const url = new URL(location.href);
  if (repository) url.searchParams.set("repository", repository); else url.searchParams.delete("repository");
  history.replaceState(null, "", url);
  if ($("analytics-dialog").open) $("analytics-dialog").close();
  set("notice", t("loading"));
  void refresh();
});
$("refresh").addEventListener("click", refresh);
$("search").addEventListener("input", () => { if (snapshot?.ready) renderPulls(snapshot); });
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  filter = button.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("selected", item === button));
  if (snapshot?.ready) renderPulls(snapshot);
}));
setInterval(() => set("clock", new Date().toLocaleTimeString("zh-CN", { hour12: false })), 1000);
setInterval(refresh, 10000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
void refresh();

function renderAudit(data) {
  const usage = $("repo-usage"); usage.replaceChildren();
  const agents = new Map();
  for (const r of data.agentUsage?.sessions || []) {
    const a = agents.get(r.repository) || { total: 0, input: 0, output: 0, count: 0 };
    a.total += r.totalTokens; a.input += r.inputTokens; a.output += r.outputTokens; a.count++; agents.set(r.repository, a);
  }
  const repos = new Map((data.repositoryUsage || []).map((r) => [r.repository, r]));
  for (const repository of agents.keys()) if (!repos.has(repository)) repos.set(repository, { repository, pullRequests: 0, reviews: 0, sessions: 0 });
  for (const r of [...repos.values()].sort((a,b) => (b.totalTokens || 0) + (agents.get(b.repository)?.total || 0) - (a.totalTokens || 0) - (agents.get(a.repository)?.total || 0))) {
    const row = node("tr"), agent = agents.get(r.repository);
    for (const value of [r.repository, `${r.pullRequests} / ${r.reviews}${r.usageMissingJobs ? ` · ${r.usageMissingJobs} ${t("missingUsageJobs")}` : ""}`, agent ? compact(agent.total) : "—", r.sessions ? compact(r.totalTokens) : t("tokenUnknown"), `${compact(r.inputTokens)} / ${compact(r.outputTokens)}`]) row.append(node("td", "mono", value));
    if (agent) row.children[2].append(node("p", "muted", `${compact(agent.input)} / ${compact(agent.output)}`));
    usage.append(row);
  }
  set("agent-usage-note", `${t("agentUsageNote")} ${data.agentUsage?.collectedAt ? time(data.agentUsage.collectedAt) : t("never")}${data.agentUsage?.error || data.agentUsage?.stale ? ` · ${t("agentUsageStale")}` : ""} · ${t(data.dataset?.error ? "datasetError" : "datasetReady")}`);
  const taskReceipts = new Map();
  for (const r of data.audit || []) if (r.jobId) taskReceipts.set(r.jobId, (taskReceipts.get(r.jobId) || 0) + 1);
  const body = $("audit"), query = $("audit-search").value.toLowerCase().trim(); body.replaceChildren();
  for (const r of (data.audit || []).filter((r) => `${r.repository} #${r.number} ${r.head} ${r.jobId}`.toLowerCase().includes(query))) {
    const row = node("tr"), name = node("td"), route = node("td"), status = node("td"), stages = node("td", "audit-stages");
    name.append(link(`${r.repository} #${r.number || "—"}`, r.number ? `https://github.com/${r.repository}/pull/${r.number}` : `https://github.com/${r.repository}`), node("p", "mono muted", `${String(r.head || "").slice(0, 8)} · ${r.jobId || "—"}`));
    route.append(badge(r.actualRoute === "direct_fallback" ? "pending" : "neutral", t(r.actualRoute)), node("p", "muted", `${t("plannedRoute")}: ${t(r.requestedRoute)}${r.reused ? ` · ${t("reusedTask")}` : ""}`));
    if (taskReceipts.get(r.jobId) > 1) route.append(node("p", "shared-task", `${t("sharedTask")} · ${taskReceipts.get(r.jobId)} ${t("ingressReceipts")}`));
    if (r.profile) route.append(node("p", "mono muted", `${r.profile} · ${t("budgetLabel")} ${r.budget === 0 ? t("unlimited") : r.budget == null ? "—" : compact(r.budget)}`));
    status.append(badge(r.state === "failed" || r.blocking > 0 ? "failure" : r.state === "complete" ? "success" : ["ignored", "expanded", "superseded"].includes(r.state) ? "neutral" : "pending", t(r.state)));
    if (r.findings != null) status.append(node("p", "muted", `${r.findings} ${t("findings")} / ${r.blocking || 0} blocked`));
    if (r.fallbackReason) status.append(node("p", "muted", r.fallbackReason));
    const detail = node("details"), summary = node("summary", "", `${r.stages.length} ${t("stageCount")} · ${time(r.updatedAt)}`); detail.append(summary);
    for (const stage of r.stages) detail.append(node("div", "", `${t(stage.stage)} · ${time(stage.at)}`)); stages.append(detail);
    row.append(name, node("td", "", t(r.ingress)), route, status, stages); body.append(row);
  }
  if (!body.children.length) { const row = node("tr"), cell = node("td", "empty-cell", t("auditEmpty")); cell.colSpan = 5; row.append(cell); body.append(row); }
}
$("audit-search").addEventListener("input", () => { if (snapshot?.ready) renderAudit(snapshot); });
