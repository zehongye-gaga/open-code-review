// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// SPDX-License-Identifier: Apache-2.0
"use strict";
window.addEventListener("DOMContentLoaded", () => {
  const copy = JSON.parse(document.getElementById("copy").textContent), t = (key) => copy[key] || key;
  const el = (id) => document.getElementById(id), text = (tag, value) => { const n = document.createElement(tag); n.textContent = value; return n; };
  const format = (value, unit = "") => value === null || value === undefined ? "—" : `${value.toFixed(1)}${unit}`;
  const stamp = (value) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  let sequence = 0;
  function chart(target, data, series, unit, fixedMax) {
    const container = el(target); container.replaceChildren();
    const legend = text("div", ""); legend.className = "resource-legend";
    for (const [key, color, label] of series) { const item = text("span", t(label)); item.style.color = color; legend.append(item); }
    container.append(legend);
    if (!data.points.length) { container.append(text("p", t("resourceNoData"))); return; }
    data = { ...data, start: Math.max(data.start, data.points[0].time - 60000) };
    const buckets = new Map(), width = Math.max(60000, (data.end - data.start) / 240);
    for (const p of data.points) {
      const index = Math.floor((p.time - data.start) / width);
      if (!buckets.has(index)) buckets.set(index, { time: p.time });
      const b = buckets.get(index);
      for (const [key] of series) if (p[key] !== null) b[key] = Math.max(b[key] ?? -Infinity, p[key]);
    }
    const points = [...buckets.values()], max = fixedMax || Math.max(1, ...points.flatMap((p) => series.map(([k]) => p[k] ?? 0)));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 720 210"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", series.map(([, , label]) => t(label)).join(" / "));
    const add = (tag, attrs, content) => { const n = document.createElementNS(svg.namespaceURI, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (content) n.textContent = content; svg.append(n); return n; };
    const x = (p) => 48 + (p.time - data.start) / (data.end - data.start) * 655, y = (v) => 170 - v / max * 150;
    for (const v of [0, max / 2, max]) { add("line", { x1:48,x2:703,y1:y(v),y2:y(v),stroke:"#293847" }); add("text",{x:42,y:y(v)+4,"text-anchor":"end",fill:"#a1b1c2","font-size":11},format(v,unit)); }
    for (const [key, color, label] of series) {
      let d = "", prior = null;
      for (const p of points) {
        if (p[key] === undefined) { prior = null; continue; }
        d += `${prior && p.time-prior.time < Math.max(180000,width*2) ? "L" : "M"}${x(p)},${y(p[key])} `;
        const dot = add("circle",{cx:x(p),cy:y(p[key]),r:2,fill:color});
        const title = document.createElementNS(svg.namespaceURI,"title"); title.textContent = `${stamp(p.time)} · ${t(label)} ${format(p[key],unit)}`; dot.append(title); prior=p;
      }
      add("path",{d,fill:"none",stroke:color,"stroke-width":2});
    }
    add("text",{x:48,y:198,fill:"#a1b1c2","font-size":11},stamp(data.start));
    add("text",{x:703,y:198,fill:"#a1b1c2","font-size":11,"text-anchor":"end"},stamp(data.end)); container.append(svg);
  }
  async function refresh() {
    const id = ++sequence;
    try {
      const response = await fetch(`/api/resources?hours=${el("resource-period").value}`, {cache:"no-store"});
      if (!response.ok) throw new Error("Resource history unavailable");
      const data = await response.json(); if (id !== sequence) return;
      el("resource-history-status").textContent = `${data.samples} ${t("resourceSamples")} · ${data.latest ? stamp(data.points[0].time) + " ~ " + stamp(data.latest) : t("resourceNoData")}${data.stale ? " · " + t("resourceStale") : ""}${data.unreadableFiles || data.malformedRows ? " · " + t("resourcePartial") : ""}`;
      chart("resource-util-chart", data, [["cpu","#80b7e8","resourceCPU"],["memory","#78d0c2","memory"],["disk","#c0cbd9","resourceDisk"]],"%");
      chart("resource-load-chart", data, [["running","#80b7e8","resourceRunning"],["queued","#f5c374","queued"],["dispatching","#c0cbd9","resourceDispatch"],["policyDispatching","#78d0c2","resourcePolicyDispatch"]],"");
      chart("resource-wait-chart", data, [["oldestWait","#f5c374","resourceOldest"],["queueP95","#80b7e8","resourceRollingP95"]],"s");
      const body=el("resource-groups");body.replaceChildren();
      for(const group of data.groups){const row=document.createElement("tr");for(const value of [group.running,group.samples,format(group.cpu.mean,"%"),format(group.cpu.max,"%"),format(group.memory.max,"%"),format(group.queue.mean),format(group.queue.max),format(group.wait.max,"s")])row.append(text("td",value));body.append(row);}
      if (!data.groups.length) {const row=text("tr","");const cell=text("td",t("resourceNoData"));cell.colSpan=8;row.append(cell);body.append(row);}
    } catch { if(id===sequence)el("resource-history-status").textContent=t("resourceUnavailable"); }
  }
  el("resource-period").addEventListener("change",refresh);
  el("refresh").addEventListener("click",refresh);
  void refresh();setInterval(refresh,60000);
});
