// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

"use strict";

window.OCRAnalytics = (() => {
  let snapshot, period = "today", count = 20, initialized = false, requestId = 0;
  const percent = (value) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;
  const integer = (value) => new Intl.NumberFormat("zh-CN").format(value || 0);
  const appendCell = (row, value, className = "") => { const cell = node("td", className, value); row.append(cell); return cell; };

  function stat(label, value, detail) {
    const card = node("div", "analytics-stat");
    card.append(node("span", "muted", label), node("strong", "", value), node("p", "", detail));
    return card;
  }

  function renderChart() {
    const data = snapshot.analytics, grain = $("trend-grain").value, metric = $("trend-metric").value;
    if (!data[grain]) return;
    const first = new Date(`${data.observedSince || "2000-01-01"}T12:00:00Z`);
    if (grain === "weekly") first.setUTCDate(first.getUTCDate() - (first.getUTCDay() + 6) % 7);
    const rows = data[grain].filter((r) => r.key >= first.toISOString().slice(0, 10)).slice(grain === "daily" ? -30 : -14);
    const value = (r) => metric === "totalTokens" ? r.usage.totalTokens : r[metric];
    const format = (n) => metric === "nativeSeconds" ? duration(n) : compact(n);
    const max = Math.max(1, ...rows.map(value)), chart = $("analytics-chart"); chart.replaceChildren();
    if (!rows.length) { chart.append(node("p", "empty-cell", t("noData"))); return; }
    for (const row of rows) {
      const column = node("div", "chart-column"), bar = node("div", "chart-bar");
      column.title = `${row.key} · ${grain === "weekly" ? t("weekStarting") : t("dailyView")}\nToken: ${integer(row.usage.totalTokens)}\n${t("findingOccurrences")}: ${row.findings}\n${t("finishedReviews")}: ${row.completed}\n${t("nativeTime")}: ${duration(row.nativeSeconds)}`;
      bar.style.height = `${Math.max(value(row) ? 2 : 0, value(row) / max * 120)}px`;
      column.append(node("span", "chart-value", format(value(row))), bar, node("span", "chart-label", row.key.slice(5)));
      chart.append(column);
    }
  }

  function renderPulls() {
    const search = $("analytics-search").value.toLowerCase().trim(), order = $("analytics-sort").value;
    const rows = snapshot.analytics.pulls.filter((p) => {
      const title = snapshot.pulls.find((pr) => pr.repository === p.repository && pr.number === p.number)?.title || "";
      return `${p.repository} ${p.number} ${title}`.toLowerCase().includes(search);
    });
    const comparators = { tokens: (a, b) => b.usage.totalTokens - a.usage.totalTokens,
      findings: (a, b) => (b.latest?.findings ?? -1) - (a.latest?.findings ?? -1), duration: (a, b) => b.nativeSeconds - a.nativeSeconds };
    if (comparators[order]) rows.sort(comparators[order]);
    const body = $("analytics-pulls"); body.replaceChildren();
    for (const p of rows.slice(0, count)) {
      const row = node("tr"), pr = appendCell(row, "");
      pr.append(link(`#${p.number}`, `https://github.com/${p.repository}/pull/${p.number}`, "pr-number"), node("span", "status-note", p.repository));
      const findings = appendCell(row, ""), latest = p.latest;
      findings.append(node("strong", latest?.findings > 0 ? "rose" : "", latest?.findings ?? "—"),
        node("span", "status-note", `${t(latest?.state || "unknown")} · ${latest?.head?.slice(0, 8) || "—"}`));
      const reviews = appendCell(row, String(p.reviews));
      reviews.append(node("span", "status-note", `${t("failed")} ${p.failed} · ${t("findingOccurrences")} ${p.findings}`));
      const tokens = appendCell(row, p.sessions ? compact(p.usage.totalTokens) : "—", "mono"); tokens.title = p.sessions ? integer(p.usage.totalTokens) : t("usageMissing");
      appendCell(row, p.sessions ? duration(p.nativeSeconds) : "—", "mono");
      appendCell(row, `${p.retries} / ${p.resumed}`, "mono");
      const actions = appendCell(row, ""), button = node("button", "button detail-button", t("viewRuns"));
      button.addEventListener("click", () => void detail(p)); actions.append(button); body.append(row);
    }
    if (!rows.length) { const cell = appendCell(node("tr"), t("noMatch"), "empty-cell"); cell.colSpan = 7; body.append(cell.parentNode); }
    set("analytics-pull-count", `${Math.min(count, rows.length)} / ${rows.length} PR`);
    $("analytics-more").hidden = count >= rows.length;
  }

  async function detail(p) {
    const id = ++requestId, dialog = $("analytics-dialog"), content = $("analytics-detail");
    set("analytics-detail-title", `${p.repository} #${p.number}`);
    content.replaceChildren(node("p", "empty-cell", t("loading"))); dialog.showModal();
    try {
      const query = new URLSearchParams({ repository: p.repository, number: String(p.number) });
      const response = await fetch(`/api/analytics/pr?${query}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("Details unavailable");
      const data = await response.json(); if (id !== requestId) return;
      content.replaceChildren();
      if (data.error) content.append(node("p", "analytics-notice", t("analyticsError")));
      const table = node("table"), head = node("thead"), header = node("tr");
      for (const label of ["runHead", "resultColumn", "findingOccurrences", "tokenBreakdown", "nativeTime", "endToEnd", "retryResume", "fileCoverage"]) header.append(node("th", "", t(label)));
      head.append(header); table.append(head); const body = node("tbody");
      for (const run of data.runs) {
        const row = node("tr"), commit = appendCell(row, run.head?.slice(0, 8) || "—", "mono");
        commit.append(node("span", "status-note", time(run.createdAt)), node("span", "status-note", run.incremental ? t("incremental") : t("fullReview")));
        appendCell(row, t(run.state)); appendCell(row, run.findings ?? "—");
        const tokens = appendCell(row, run.sessions ? compact(run.usage.totalTokens) : "—", "mono");
        tokens.title = integer(run.usage.totalTokens);
        tokens.append(node("span", "status-note", `${t("inputShort")} ${compact(run.usage.inputTokens)} · ${t("outputShort")} ${compact(run.usage.outputTokens)}`));
        if (run.partialUsage) tokens.append(node("span", "status-note amber", t("partialUsage")));
        appendCell(row, duration(run.nativeSeconds), "mono"); appendCell(row, duration(run.endToEndSeconds), "mono");
        appendCell(row, `${Math.max(0, run.attempt - 1)} / ${run.resumed}`, "mono");
        const c = run.coverage, coverage = appendCell(row, c ? `${(c.completed || 0) + (c.reused || 0)} / ${c.selected ?? "—"}` : "—", "mono");
        if (c) coverage.append(node("span", "status-note", `${t("fileReused")} ${c.reused || 0} · ${t("failed")} ${c.failed || 0}`));
        body.append(row);
      }
      table.append(body); content.append(table);
      if (!data.runs.length) content.append(node("p", "empty-cell", t("noHistory")));
    } catch { if (id === requestId) content.replaceChildren(node("p", "empty-cell amber", t("fetchError"))); }
  }

  function render(data) {
    snapshot = data;
    const analytics = data.analytics;
    $("analytics-panel").hidden = !analytics?.enabled; $("analytics-pulls-panel").hidden = !analytics?.periods;
    if (!analytics?.enabled) return;
    if (!initialized) {
      initialized = true;
      document.querySelectorAll("[data-period]").forEach((button) => button.addEventListener("click", () => {
        period = button.dataset.period; document.querySelectorAll("[data-period]").forEach((b) => b.classList.toggle("selected", b === button)); render(snapshot);
      }));
      for (const id of ["trend-grain", "trend-metric"]) $(id).addEventListener("change", renderChart);
      $("analytics-search").addEventListener("input", () => { count = 20; renderPulls(); });
      $("analytics-sort").addEventListener("change", renderPulls);
      $("analytics-more").addEventListener("click", () => { count += 20; renderPulls(); });
      $("analytics-close").addEventListener("click", () => { requestId++; $("analytics-dialog").close(); });
    }
    const warnings = [];
    if (analytics.error) warnings.push(t("analyticsError"));
    if (analytics.pendingFiles) warnings.push(`${t("analyticsBackfill")} ${analytics.pendingFiles}`);
    if (analytics.readErrors || analytics.unreadableRecords) warnings.push(`${t("analyticsReadErrors")} ${analytics.readErrors || 0} / ${analytics.unreadableRecords || 0}`);
    if (analytics.unattributedSessions) warnings.push(`${t("unattributedSessions")} ${analytics.unattributedSessions}`);
    if (analytics.unmatchedJobs) warnings.push(`${t("unmatchedJobs")} ${analytics.unmatchedJobs}`);
    if (analytics.interruptedSessions) warnings.push(`${t("interruptedSessions")} ${analytics.interruptedSessions}`);
    set("analytics-notice", warnings.join(" · ")); $("analytics-notice").hidden = !warnings.length;
    if (!analytics.periods) return;
    const p = analytics.periods[period], u = p.usage;
    set("analytics-scope", `${p.start} → ${p.end} · ${analytics.timeZone} · ${t("retention")} ${analytics.retentionDays}${t("days")} · ${t("observedSince")} ${analytics.observedSince || "—"}`);
    $("analytics-stats").replaceChildren(
      stat(t("finishedReviews"), integer(p.completed), `${p.pullRequests} PR · ${t("failed")} ${p.failed} · ${t("completionRate")} ${percent(p.completionRate)}`),
      stat(t("findingOccurrences"), integer(p.findings), `${t("withFindings")} ${p.withFindings} · ${t("clean")} ${p.clean} · ${t("highSeverity")} ${p.severities.high + p.severities.critical}`),
      stat("Token", compact(u.totalTokens), `${t("inputShort")} ${compact(u.inputTokens)} · ${t("outputShort")} ${compact(u.outputTokens)}`),
      stat(t("endToEndAverage"), duration(p.endToEnd.mean), `P95 ${duration(p.endToEnd.p95)} · ${t("queueWait")} ${duration(p.queueWait.mean)}`),
      stat(t("modelRequests"), integer(u.requests), `${t("responseCount")} ${u.responses} · ${t("error")} ${u.errors} · ${t("toolCalls")} ${u.toolCalls}`),
      stat(t("retryResume"), `${p.retries} / ${p.resumed}`, `${t("nativeSessions")} ${p.sessions} · ${t("failedAttempts")} ${p.failedSessions} · ${duration(p.nativeSeconds)}`),
    );
    const phases = $("analytics-phases"); phases.replaceChildren();
    const total = Object.values(analytics.phases).reduce((sum, value) => sum + value.totalTokens, 0);
    for (const [phase, value] of Object.entries(analytics.phases).sort(([, a], [, b]) => b.totalTokens - a.totalTokens)) {
      const block = node("div", "phase-row"), line = node("div", "resource-label"), bar = node("div", "bar"), fill = node("div", "bar-fill");
      line.append(node("span", "", t(phase)), node("span", "mono", compact(value.totalTokens)));
      fill.style.width = `${total ? value.totalTokens / total * 100 : 0}%`; bar.append(fill); block.append(line, bar); phases.append(block);
    }
    renderChart(); renderPulls();
  }
  return { render };
})();
