import { PALETTE } from "./theme.js";

const esc = (v) =>
  String(v ?? "—").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const num = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN"));
const fixed = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
const signed = (v, d = 2) =>
  v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;
const longDate = (iso, withDay = true) =>
  iso
    ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
        ...(withDay ? { day: "numeric" } : {}),
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";
const addDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const shortIso = (iso) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const firstVisitBy = (w, end) =>
  `first visit by ${shortIso(addDays(end, -w.measurement_range_days[1]))}`;
const pctOf = (s) => (s && s.d ? `${fixed(s.pct, 1)}%` : "—");
const nOf = (s) => (s && s.d != null ? `${num(s.n)} / ${num(s.d)}` : "—");

const ciText = (ci, unit = "") =>
  ci ? `95% CI ${signedOrPlain(ci[0], unit)} to ${signedOrPlain(ci[1], unit)}` : "";
const signedOrPlain = (v, unit) =>
  unit === "%" ? `${fixed(v, 1)}%` : `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toFixed(2)}`;

const cell = (s) =>
  `<td class="num"><strong>${pctOf(s)}</strong><span class="nd">${nOf(s)}</span></td>`;

function css() {
  const t = (p) => `
    --surface:${p.surface};--plane:${p.plane};--ink:${p.ink};--ink2:${p.inkSecondary};
    --muted:${p.muted};--grid:${p.grid};--border:${p.border};--accent:${p.series[0]};--s2:${p.series[1]};--c2:${p.series[2]};--o1:${p.ordinal[0]};--o2:${p.ordinal[2]};--o3:${p.ordinal[4]};
    --warn:${p.warning};--critical:${p.critical};`;
  return `
  :root{${t(PALETTE.light)}color-scheme:light}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${t(PALETTE.dark)}color-scheme:dark}}
  :root[data-theme="dark"]{${t(PALETTE.dark)}color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:var(--plane);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
  h1{font-size:22px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 8px;padding-bottom:6px;border-bottom:2px solid var(--grid)}
  .sub{color:var(--ink2);margin:0 0 16px}
  .banner{border:1px solid var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent);padding:10px 14px;border-radius:6px;margin:12px 0 20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
  .grid--tables{grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));margin-top:12px}
  .tile{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px}
  .tile .k{color:var(--ink);font-size:13.5px;font-weight:600}
  .tile .v{font-size:26px;font-weight:650;margin:4px 0 2px;font-variant-numeric:tabular-nums}
  .tile .d{color:var(--muted);font-size:12px}
  .scroll{overflow-x:auto;background:var(--surface);border:1px solid var(--border);border-radius:8px}
  table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
  th,td{padding:7px 10px;border-bottom:1px solid var(--grid);text-align:left;vertical-align:top;white-space:nowrap}
  th{font-size:12px;color:var(--ink2);font-weight:600;background:var(--surface)}
  td.num,th.num{text-align:right}
  .nd{display:block;font-size:11px;color:var(--muted)}
  .press{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:8px;padding:12px 16px 12px 34px;margin:0}
  .press > li{margin:14px 0;line-height:1.55}
  .say{margin:0;font-size:15px}
  .say-sub{margin:2px 0 0;color:var(--ink2)}
  .how{margin:6px 0 0;font-size:12.5px;color:var(--ink2)}
  .how summary{cursor:pointer;color:var(--accent);width:max-content}
  .how ol{margin:6px 0 0;padding-left:20px}
  .how li{margin:3px 0}
  .avoid{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--critical);border-radius:8px;padding:12px 16px 12px 34px;margin:12px 0 0}
  .avoid li{margin:6px 0}
  .guide{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin:0 0 8px}
  .guide dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:6px 0 0}
  .guide dt{font-weight:600}.guide dd{margin:0;color:var(--ink2)}
  .tile .how{margin-top:8px}
  .more{margin:8px 0 0}
  .more > summary{cursor:pointer;color:var(--accent);font-size:13px;width:max-content;margin-bottom:8px}
  .mini{list-style:none;margin:8px 0 0;padding:0}
  .mini li{display:flex;justify-content:space-between;padding:2px 0;border-top:1px solid var(--grid)}
  .mini strong{color:var(--ink);font-variant-numeric:tabular-nums}
  .def{color:var(--ink2);font-size:13.5px;margin:6px 0 0}
  .flow{margin:10px 0 0;padding:12px 14px;border:1px solid var(--border);border-radius:8px;background:var(--plane);break-inside:avoid}
  .flow-h{margin:0 0 10px;font-weight:700;font-size:15px;color:var(--ink)}
  .flow-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,175px),1fr));gap:12px}
  .flow-t{margin:0 0 6px;font-size:13.5px;font-weight:700;color:var(--accent)}
  .flow ol{list-style:none;margin:0;padding:0;font-size:12.5px;color:var(--ink2)}
  .flow li{padding:5px 8px;border:1px solid var(--grid);border-radius:6px;background:var(--surface)}
  .flow li + li{margin-top:16px;position:relative}
  .flow li + li::before{content:"↓";position:absolute;top:-16px;left:14px;line-height:16px;color:var(--muted)}
  .flow li strong{color:var(--ink);font-variant-numeric:tabular-nums}
  .flow li:last-child{border-color:var(--accent)}
  .flow--row ol{display:flex;flex-wrap:wrap;gap:8px 22px}
  .flow--row li{flex:1 1 150px}
  .flow--row li + li{margin-top:0}
  .flow--row li + li::before{content:"→";top:50%;left:-17px;transform:translateY(-50%)}
  .chart{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin:12px 0 0;break-inside:avoid}
  .chart figcaption{padding-bottom:10px;border-bottom:1px solid var(--grid)}
  .chart figcaption > strong{display:block;font-size:16px;font-weight:700;color:var(--ink);line-height:1.35}
  .chart figcaption > span{display:block;margin-top:4px;color:var(--ink);font-size:13.5px;line-height:1.5}
  mark.when{display:inline-block;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--ink);font-weight:600;border-radius:4px;padding:0 6px;margin:2px 0}
  .grid--charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,460px),1fr));gap:12px}
  .grid--charts .chart{margin:0}
  .bars{list-style:none;margin:12px 0 0;padding:0}
  .bars li{display:grid;grid-template-columns:minmax(140px,230px) 1fr minmax(100px,max-content);gap:12px;align-items:center;padding:5px 0}
  .bars .bt{height:14px;background:var(--grid);border-radius:4px;overflow:hidden}
  .bars .bf{display:block;height:100%;background:var(--accent);border-radius:0 4px 4px 0}
  .bars .bv{font-variant-numeric:tabular-nums;color:var(--ink2);text-align:right}
  .bars .bv strong{color:var(--ink)}
  .dumb .dt{position:relative;height:18px}
  .dumb .dt::before{content:"";position:absolute;left:0;right:0;top:50%;border-top:1px solid var(--grid)}
  .dumb .dl{position:absolute;top:calc(50% - 1px);height:2px;background:var(--accent)}
  .dumb .d0,.dumb .d1{position:absolute;top:50%;width:11px;height:11px;border-radius:50%;transform:translate(-50%,-50%)}
  .dumb .d0{background:var(--surface);border:2px solid var(--muted)}
  .dumb .d1{background:var(--accent);box-shadow:0 0 0 2px var(--surface)}
  .dumb li.ax{padding:0}
  .dumb .ax .dt{height:16px}
  .dumb .ax .dt::before{display:none}
  .dumb .ax .dt span{position:absolute;transform:translateX(-50%);font-size:11px;color:var(--muted)}
  .st{display:flex;gap:2px;height:20px}
  .sg{display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;overflow:hidden}
  .sg:first-child{border-radius:4px 0 0 4px}.sg:last-child{border-radius:0 4px 4px 0}
  .s0{background:var(--accent);color:#fff}.s1{background:var(--grid);color:var(--ink)}.s2{background:var(--s2);color:#0b0b0b}
  .lg{display:flex;flex-wrap:wrap;gap:4px 16px;margin:10px 0 0;font-size:12.5px;color:var(--ink2)}
  .lg i{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:6px;vertical-align:-1px}
  .lg i.k0{border-radius:50%;border:2px solid var(--muted)}.lg i.k1{border-radius:50%;background:var(--accent)}
  .donut{display:grid;grid-template-columns:150px 1fr;gap:20px;align-items:center;margin:12px 0 0}
  .donut svg{width:150px;height:150px;transform:rotate(0)}
  .donut circle{fill:none;stroke-width:7}
  .donut text{text-anchor:middle;font-size:5.5px;font-weight:650;fill:var(--ink)}
  .donut text.dn{font-size:3.2px;font-weight:400;fill:var(--ink2)}
  .k-c0{stroke:var(--accent)}.k-c1{stroke:var(--s2)}.k-c2{stroke:var(--c2)}.k-na{stroke:var(--muted)}
  .k-o1{stroke:var(--o1)}.k-o2{stroke:var(--o2)}.k-o3{stroke:var(--o3)}
  @media (max-width:560px){.donut{grid-template-columns:1fr;justify-items:center}.donut .keys{width:100%}}
  .keys{list-style:none;margin:0;padding:0}
  .keys li{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;padding:4px 0;border-top:1px solid var(--grid)}
  .keys i{display:block;width:12px;height:12px;border-radius:2px}
  .keys .bv{font-variant-numeric:tabular-nums;color:var(--ink2);text-align:right}
  .keys .bv strong{color:var(--ink)}
  .t-c0{background:var(--accent)}.t-c1{background:var(--s2)}.t-c2{background:var(--c2)}.t-na{background:var(--muted)}
  .t-o1{background:var(--o1)}.t-o2{background:var(--o2)}.t-o3{background:var(--o3)}
  .cols{list-style:none;margin:14px 0 0;padding:0;display:grid;grid-auto-columns:1fr;grid-auto-flow:column;gap:8px}
  .cols li{display:grid;grid-template-rows:150px auto;text-align:center}
  .cols .cp{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;border-bottom:1px solid var(--muted)}
  .cols .cv{font-size:12px;color:var(--ink2);font-variant-numeric:tabular-nums;margin-bottom:4px;line-height:1.3}
  .cols .cv strong{display:block;color:var(--ink);font-size:13px}
  .cols .cb{width:min(100%,56px);background:var(--accent);border-radius:4px 4px 0 0}
  .cols .cl{font-size:12px;color:var(--ink2);padding-top:6px}
  .bf,.dl,.d1,.sg,.lg i,mark.when,.donut circle,.keys i,.cols .cb{print-color-adjust:exact;-webkit-print-color-adjust:exact}
  @media (max-width:560px){.bars li{grid-template-columns:1fr auto}.bars .bt,.bars .dt,.bars .st{grid-column:1 / -1;order:3}.dumb li.ax span:empty{display:none}}
  ul.caveats{padding-left:18px;margin:6px 0}ul.caveats li{margin:4px 0}
  footer{margin-top:32px;color:var(--muted);font-size:12px}
  @media print{body{background:#fff;font-size:11px}main{max-width:none;padding:0}.scroll{overflow:visible;break-inside:avoid}.tile{break-inside:avoid}table{font-size:9.5px;table-layout:auto}th,td{white-space:normal;padding:4px 5px}.grid{grid-template-columns:repeat(3,1fr)}.grid--tables{grid-template-columns:repeat(2,1fr)}h2{break-after:avoid}.grid--charts{grid-template-columns:1fr}.bars li{grid-template-columns:150px 1fr 120px}}`;
}

function how(steps) {
  return `<details class="how"><summary>How this number was counted</summary><ol>${steps.map((x) => `<li>${x}</li>`).join("")}</ol></details>`;
}

function tile(label, value, detail, steps) {
  return `<div class="tile"><div class="k">${esc(label)}</div><div class="v">${value}</div><div class="d">${detail}</div>${steps ? how(steps) : ""}</div>`;
}

function section(title, intro, steps) {
  const id = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `<h2 id="${id}">${title}</h2>${intro ? `<p class="def">${intro}</p>` : ""}${steps ? how(steps) : ""}`;
}

function windowTable(label, windows, keys, end) {
  const rows = windows
    .filter((w) => keys.includes(w.window))
    .map((w) => {
      const o = w.outcome;
      return `<tr><th scope="row">${esc(w.label)} after first visit<span class="nd">${firstVisitBy(w, end)}</span></th>
        <td class="num">${num(w.measured.n)}<span class="nd">of ${num(w.with_baseline)} (${pctOf(w.measured)})</span></td>
        <td class="num">${fixed(o.baseline_mean, 1)}% → <strong>${fixed(o.follow_mean, 1)}%</strong></td>
        <td class="num"><strong>${signed(o.change_mean)}</strong></td>
        ${cell(o.improved_05)}${cell(o.worsened_05)}${cell(o.below7_at_follow)}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table aria-label="${esc(label)}"><thead><tr><th scope="col">Second test</th><th class="num" scope="col">Patients re-tested</th>
    <th class="num" scope="col">Average HbA1c</th><th class="num" scope="col">Change (points)</th><th class="num" scope="col">Improved 0.5+</th>
    <th class="num" scope="col">Got worse 0.5+</th><th class="num" scope="col">Below 7%</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function fullWindowTable(label, windows, keys, end, open = false) {
  const rows = windows
    .filter((w) => keys.includes(w.window))
    .map((w) => {
      const o = w.outcome;
      return `<tr><th scope="row">${esc(w.label)}<span class="nd">${firstVisitBy(w, end)}</span></th><td class="num">${num(w.eligible)}</td>${cell(w.measured)}
        <td class="num">${fixed(o.baseline_mean)} / ${fixed(o.baseline_median)}</td><td class="num">${fixed(o.follow_mean)} / ${fixed(o.follow_median)}</td>
        <td class="num">${signed(o.change_mean)} / ${signed(o.change_median)}</td>
        ${cell(o.any_improvement)}${cell(o.improved_05)}${cell(o.improved_10)}${cell(o.worsened_05)}${cell(o.reached_below7)}${cell(o.maintained_below7)}</tr>`;
    })
    .join("");
  return `<details class="more"${open ? " open" : ""}><summary>Show all measures</summary><div class="scroll"><table aria-label="${esc(label)}"><thead><tr><th scope="col">Second test</th>
    <th class="num" scope="col">Eligible</th><th class="num" scope="col">Tested again</th><th class="num" scope="col">First HbA1c (average / middle)</th>
    <th class="num" scope="col">Second HbA1c (average / middle)</th><th class="num" scope="col">Change (average / middle)</th><th class="num" scope="col">Any fall</th>
    <th class="num" scope="col">Fell 0.5+</th><th class="num" scope="col">Fell 1.0+</th><th class="num" scope="col">Rose 0.5+</th>
    <th class="num" scope="col">Reached below 7% (started 7%+)</th><th class="num" scope="col">Stayed below 7% (started below 7%)</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function severityTable(window) {
  const rows = window.by_severity
    .map(
      (b) => `<tr><th scope="row">${esc(b.band)}</th><td class="num">${num(b.n)}</td>
      <td class="num">${fixed(b.baseline_mean, 1)}% → <strong>${fixed(b.follow_mean, 1)}%</strong></td>
      <td class="num"><strong>${signed(b.change_mean)}</strong></td>${cell(b.improved_05)}${cell(b.below7_at_follow)}</tr>`,
    )
    .join("");
  return `<div class="scroll"><table aria-label="Results by starting HbA1c"><thead><tr><th scope="col">HbA1c at first visit</th><th class="num" scope="col">Patients</th>
    <th class="num" scope="col">Average HbA1c</th><th class="num" scope="col">Change (points)</th><th class="num" scope="col">Improved 0.5+</th><th class="num" scope="col">Below 7%</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

const share = (n, d) => (d ? (n / d) * 100 : 0);

function flow(title, columns, note) {
  const cols = columns
    .map(
      (c) =>
        `<div>${c.title ? `<p class="flow-t">${esc(c.title)}</p>` : ""}<ol>${c.steps.map(([n, label]) => `<li>${n == null ? label : `<strong>${num(n)}</strong> ${esc(label)}`}</li>`).join("")}</ol></div>`,
    )
    .join("");
  return `<div class="flow${columns.length === 1 ? " flow--row" : ""}"><p class="flow-h">${esc(title)}</p><div class="flow-cols">${cols}</div>${note ? `<p class="def">${note}</p>` : ""}</div>`;
}

function figure(title, subtitle, body, steps, legend = "") {
  return `<figure class="chart"><figcaption><strong>${esc(title)}</strong>${subtitle ? `<span>${subtitle}</span>` : ""}</figcaption>${legend}${body}${steps ? how(steps) : ""}</figure>`;
}

function barChart(title, subtitle, rows, steps) {
  const total = rows.reduce((a, r) => a + r.n, 0);
  const items = rows
    .map((r) => {
      const d = r.d ?? total;
      const pct = share(r.n, d);
      return `<li title="${esc(r.label)}: ${num(r.n)} patients (${fixed(pct, 1)}%)"><span>${esc(r.label)}</span><span class="bt" aria-hidden="true"><span class="bf" style="width:${fixed(pct, 2)}%"></span></span><span class="bv"><strong>${num(r.n)}</strong> · ${fixed(pct, 1)}%</span></li>`;
    })
    .join("");
  return figure(title, subtitle, `<ul class="bars">${items}</ul>`, steps);
}

function dumbbellChart(title, subtitle, rows, steps, from = "First visit", to = "Later test") {
  const values = rows.flatMap((r) => [r.from, r.to]);
  const lo = Math.floor(Math.min(...values) - 0.2);
  const hi = Math.ceil(Math.max(...values) + 0.2);
  const x = (v) => fixed(((v - lo) / (hi - lo)) * 100, 2);
  const items = rows
    .map((r) => {
      const left = Math.min(r.from, r.to);
      const right = Math.max(r.from, r.to);
      return `<li title="${esc(r.label)}: ${fixed(r.from, 1)}% → ${fixed(r.to, 1)}% (${num(r.n)} patients)"><span>${esc(r.label)}<span class="nd">${esc(r.sub ?? `${num(r.n)} patients`)}</span></span><span class="dt" aria-hidden="true"><span class="dl" style="left:${x(left)}%;width:${fixed(((right - left) / (hi - lo)) * 100, 2)}%"></span><span class="d0" style="left:${x(r.from)}%"></span><span class="d1" style="left:${x(r.to)}%"></span></span><span class="bv">${fixed(r.from, 1)}% → <strong>${fixed(r.to, 1)}%</strong><span class="nd">${signed(r.change, 2)} points</span></span></li>`;
    })
    .join("");
  const ticks = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
    .map((t) => `<span style="left:${x(t)}%">${t}%</span>`)
    .join("");
  const legend = `<p class="lg"><span><i class="k0"></i>${esc(from)}</span><span><i class="k1"></i>${esc(to)}</span></p>`;
  return figure(
    title,
    subtitle,
    `<ul class="bars dumb">${items}<li class="ax" aria-hidden="true"><span></span><span class="dt">${ticks}</span><span></span></li></ul>`,
    steps,
    legend,
  );
}

function donutChart(title, subtitle, rows, steps) {
  const total = rows.reduce((a, r) => a + r.n, 0);
  const pct = (r) => share(r.n, total);
  const gap = rows.filter((r) => r.n).length > 1 ? 0.6 : 0;
  let start = 0;
  const slices = rows
    .filter((r) => r.n)
    .map((r) => {
      const size = pct(r);
      const arc = Math.max(size - gap, 0.4);
      const slice = `<circle class="k-${r.tone}" cx="21" cy="21" r="15.915" pathLength="100" stroke-dasharray="${fixed(arc, 3)} ${fixed(100 - arc, 3)}" stroke-dashoffset="${fixed(25 - start, 3)}"><title>${esc(r.label)}: ${num(r.n)} (${fixed(size, 1)}%)</title></circle>`;
      start += size;
      return slice;
    })
    .join("");
  const keys = rows
    .map(
      (r) =>
        `<li><i class="t-${r.tone}" aria-hidden="true"></i><span>${esc(r.label)}</span><span class="bv"><strong>${num(r.n)}</strong> · ${fixed(pct(r), 1)}%</span></li>`,
    )
    .join("");
  return figure(
    title,
    subtitle,
    `<div class="donut"><svg viewBox="0 0 42 42" role="img" aria-label="${esc(title)}">${slices}<text x="21" y="21">${num(total)}</text><text class="dn" x="21" y="26">patients</text></svg><ul class="keys">${keys}</ul></div>`,
    steps,
  );
}

function columnChart(title, subtitle, rows, steps, byPercent = false) {
  const value = (r) => (byPercent ? share(r.n, r.d) : r.n);
  const top = Math.max(...rows.map(value));
  const items = rows
    .map((r) => {
      const pct = share(r.n, r.d);
      const text = byPercent
        ? `<strong>${fixed(pct, 1)}%</strong>${num(r.n)} of ${num(r.d)}`
        : `<strong>${num(r.n)}</strong>${fixed(pct, 1)}%`;
      return `<li title="${esc(r.label)}: ${byPercent ? `${fixed(pct, 1)}% came back` : `${num(r.n)} patients (${fixed(pct, 1)}%)`}"><span class="cp"><span class="cv">${text}</span><span class="cb" style="height:${fixed(top ? (value(r) / top) * 100 * 0.72 : 0, 2)}%"></span></span><span class="cl">${esc(r.label)}</span></li>`;
    })
    .join("");
  return figure(title, subtitle, `<ul class="cols">${items}</ul>`, steps);
}

function stackChart(title, subtitle, parts, rows, steps) {
  const items = rows
    .map((r) => {
      const pcts = r.values.map((v) => share(v, r.total));
      const segments = pcts
        .map((pct, i) =>
          pct > 0
            ? `<span class="sg s${i}" style="width:${fixed(pct, 2)}%" title="${esc(parts[i])}: ${num(r.values[i])} (${fixed(pct, 1)}%)">${pct >= 6 ? `${fixed(pct, 0)}%` : ""}</span>`
            : "",
        )
        .join("");
      return `<li><span>${esc(r.label)}<span class="nd">${esc(r.sub ?? `${num(r.total)} patients`)}</span></span><span class="st" aria-hidden="true">${segments}</span><span class="bv">${pcts.map((p, i) => (i === 0 ? `<strong>${fixed(p, 1)}%</strong>` : `${fixed(p, 1)}%`)).join(" · ")}</span></li>`;
    })
    .join("");
  const legend = `<p class="lg">${parts.map((p, i) => `<span><i class="s${i}"></i>${esc(p)}</span>`).join("")}</p>`;
  return figure(title, subtitle, `<ul class="bars">${items}</ul>`, steps, legend);
}

function shareTable(label, head, rows) {
  return `<div class="scroll"><table aria-label="${esc(label)}"><thead><tr><th scope="col">${esc(head)}</th><th class="num" scope="col">Patients</th></tr></thead>
    <tbody>${rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th>${cell(v)}</tr>`).join("")}</tbody></table></div>`;
}

const MARKERS_SHOWN = [
  ["sbp", "Blood pressure (top number)", "mmHg", 0],
  ["dbp", "Blood pressure (bottom number)", "mmHg", 0],
  ["ldl", "LDL cholesterol", "mg/dL", 0],
  ["egfr", "Kidney function (eGFR)", "", 0],
  ["weight", "Weight (rough, see limits)", "kg", 1],
  ["bmi", "BMI (rough, see limits)", "kg/m²", 1],
];

function markerTable(markers) {
  const rows = MARKERS_SHOWN.map(([key, label, unit, d]) => {
    const cells = ["m6", "m12", "m24"]
      .map((wk) => {
        const r = markers[key][wk];
        return r.n
          ? `<td class="num">${fixed(r.baseline_mean, d)} → <strong>${fixed(r.follow_mean, d)}</strong><span class="nd">${signed(r.change_mean, 1)} · ${num(r.n)} patients</span></td>`
          : `<td class="num">—</td>`;
      })
      .join("");
    return `<tr><th scope="row">${label}${unit ? `<span class="nd">${unit}</span>` : ""}</th>${cells}</tr>`;
  }).join("");
  return `<div class="scroll"><table aria-label="Other health measures"><thead><tr><th scope="col">Measure (average)</th><th class="num" scope="col">After 6 months</th>
    <th class="num" scope="col">After 1 year</th><th class="num" scope="col">After 2 years</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function kidneyTable(k) {
  const row = (wk, label) => {
    const u = k[wk].uacr;
    return `<tr><th scope="row">${label}</th><td class="num">${num(u.measured.n)}</td>${cell(u.stage_better)}${cell(u.stage_same)}${cell(u.stage_worse)}${cell(u.albuminuric_fell_30pct)}</tr>`;
  };
  return `<div class="scroll"><table aria-label="Urine protein results"><thead><tr><th scope="col">Second test</th><th class="num" scope="col">Patients</th>
    <th class="num" scope="col">Protein level better</th><th class="num" scope="col">Same</th><th class="num" scope="col">Worse</th>
    <th class="num" scope="col">Fell by 30%+ (those with raised protein)</th></tr></thead>
    <tbody>${row("m12", "After 1 year")}${row("m24", "After 2 years")}</tbody></table></div>`;
}

function controlTable(c) {
  const a = c.among_complete;
  const row = (label, s) => `<tr><th scope="row">${label}</th>${cell(s)}</tr>`;
  return `<div class="scroll"><table aria-label="Targets met"><thead><tr><th scope="col">Target (latest result)</th><th class="num" scope="col">Patients meeting it</th></tr></thead>
    <tbody>${row("HbA1c below 7%", a.hba1c_below7)}${row("Blood pressure below 140/90", a.bp_below_140_90)}${row("Blood pressure below 130/80 (stricter)", a.bp_below_130_80)}
    ${row("LDL cholesterol below 100", a.ldl_below100)}${row("LDL cholesterol below 70 (stricter)", a.ldl_below70)}
    ${row("<strong>All three (BP below 140/90)</strong>", a.all_three_bp140)}${row("All three (BP below 130/80)", a.all_three)}</tbody></table></div>`;
}

function medicineTable(treatments) {
  const rows = treatments
    .map((t) => {
      const parts = ["m3", "m6", "m12"].map((w) => {
        const a = t.new_start[w].hba1c;
        return `<td class="num">${a.n >= 10 ? `<strong>${signed(a.change_mean)}</strong><span class="nd">${num(a.n)} patients</span>` : `—<span class="nd">${a.eligible ? "too few re-tested" : "too new"}</span>`}</td>`;
      });
      return `<tr><th scope="row">${esc(t.label)}</th><td class="num">${num(t.started_in_period)}</td><td class="num">${num(t.new_starts)}</td>${parts.join("")}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table aria-label="Medicines"><thead><tr><th scope="col">Medicine</th><th class="num" scope="col">Prescribed</th><th class="num" scope="col">Started at Gini</th>
    <th class="num" scope="col">HbA1c change after 3 months</th><th class="num" scope="col">After 6 months</th><th class="num" scope="col">After 1 year</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function retentionTable(rows) {
  const body = rows
    .filter((r) => r.enrolled >= 10)
    .map(
      (
        r,
      ) => `<tr><th scope="row">${esc(r.enrollment_year)}</th><td class="num">${num(r.enrolled)}</td>
      ${["m3", "m6", "m12", "m24"].map((k) => (r[k].visit_in_window.d ? cell(r[k].visit_in_window) : `<td class="num">—<span class="nd">too recent</span></td>`)).join("")}</tr>`,
    )
    .join("");
  return `<div class="scroll"><table aria-label="Coming back by first-visit year"><thead><tr><th scope="col">First visit in</th><th class="num" scope="col">Patients</th>
    <th class="num" scope="col">Visit around 3 months</th><th class="num" scope="col">Around 6 months</th><th class="num" scope="col">Around 1 year</th><th class="num" scope="col">Around 2 years</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function biasTable(cmp) {
  const r = (k, f) =>
    `<tr><th scope="row">${k}</th><td class="num">${f(cmp.measured)}</td><td class="num">${f(cmp.not_measured)}</td></tr>`;
  return `<div class="scroll"><table aria-label="Re-tested versus not re-tested"><thead><tr><th scope="col">At first visit</th><th class="num" scope="col">Re-tested at 1 year</th><th class="num" scope="col">Not re-tested</th></tr></thead>
    <tbody>${r("Patients", (g) => num(g.n))}${r("Average age", (g) => fixed(g.mean_age, 0))}${r("Women", (g) => pctOf(g.female))}
    ${r("Average HbA1c", (g) => `${fixed(g.mean_baseline_hba1c, 1)}%`)}${r("Visits (middle patient)", (g) => num(g.median_visits))}</tbody></table></div>`;
}

export function renderDmScorecard(
  report,
  allCount = null,
  onsetInsulin = null,
  { client = false, print = false } = {},
) {
  const f = report.funnel;
  const w = Object.fromEntries(report.hba1c.windows.map((x) => [x.window, x]));
  const lab12 = report.hba1c.lab_confirmed_only.find((x) => x.window === "m12").outcome;
  const ctl = report.latest_control.all;
  const a3 = ctl.among_complete;
  const tr = Object.fromEntries(report.treatments.map((t) => [t.key, t]));
  const eng = report.engagement;
  const st = Object.fromEntries(eng.status.map((s) => [s.status, s]));
  const m = report.meta;
  const np = Object.fromEntries(report.new_patients.windows.map((x) => [x.window, x]));
  const conf = f.confirmation;
  const sg = report.new_patients.same_patients;
  const confirmed12 = report.confirmed_only.find((x) => x.window === "m12").outcome;
  const byDate = (days) => longDate(addDays(m.period.end, -days));
  const shortDate = (days) =>
    new Date(`${addDays(m.period.end, -days)}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  const fl = allCount?.first_vs_latest_diabetes;
  const on = onsetInsulin?.onset;
  const gi = onsetInsulin?.glp1_insulin;
  const group = (title, cards) =>
    `<h3>${title}</h3><div class="grid">${cards.filter(Boolean).join("")}</div>`;
  const targetCard = (label, s, extra, steps) =>
    tile(label, pctOf(s), `${num(s.n)} of ${num(s.d)} patients.${extra}`, steps);
  const targetSteps = (count, label) => [
    `Each diabetes patient's latest HbA1c, blood pressure and LDL from the 12 months before their last visit`,
    `${num(ctl.complete.n)} patients had all three tested; all target cards use this same group`,
    `${num(count)} of them ${label}`,
  ];

  const tableFold = (html, label = "Show the table") =>
    `<details class="more"${print ? " open" : ""}><summary>${label}</summary>${html}</details>`;
  const overTime = (windows, keys) =>
    windows
      .filter((x) => keys.includes(x.window) && x.outcome.n)
      .map((x) => ({
        label: `${x.label} later`,
        sub: `${num(x.outcome.n)} patients · ${firstVisitBy(x, m.period.end)}`,
        from: x.outcome.baseline_mean,
        to: x.outcome.follow_mean,
        change: x.outcome.change_mean,
        n: x.outcome.n,
      }));
  const improvedRows = (windows, keys) =>
    windows
      .filter((x) => keys.includes(x.window) && x.outcome.n)
      .map((x) => {
        const o = x.outcome;
        return {
          label: `${x.label} later`,
          sub: `${num(o.n)} patients · ${firstVisitBy(x, m.period.end)}`,
          total: o.n,
          values: [o.improved_05.n, o.n - o.improved_05.n - o.worsened_05.n, o.worsened_05.n],
        };
      });
  const monthsOf = (days) => Math.round(days / 30);
  const windowColumns = (windows, keys, starts) =>
    windows
      .filter((x) => keys.includes(x.window))
      .map((x) => ({
        title: `${x.label}: ${num(x.outcome.n)}`,
        steps: [
          ...starts,
          [x.eligible, `joined by ${shortDate(x.measurement_range_days[1])}`],
          [x.with_baseline, "HbA1c at first visit"],
          [
            x.outcome.n,
            `re-tested at ${monthsOf(x.measurement_range_days[0])}–${monthsOf(x.measurement_range_days[1])} months`,
          ],
        ],
      }));
  const ALL_START = [[f.registry, "diabetes patients"]];
  const NEW_START = [
    [f.registry, "diabetes patients"],
    [report.new_patients.patients, "first came as new patients in 2025–26"],
  ];
  const windowFlow = (windows, keys, starts, note) =>
    flow("Where these numbers come from", windowColumns(windows, keys, starts), note);
  const when = (text) => `<mark class="when">${text}</mark>`;
  const seenText = when(`Patients seen ${shortIso(m.period.start)} – ${shortIso(m.period.end)}`);
  const allPeriod = when(
    `First visits ${shortIso(m.period.start)} – ${shortIso(m.period.end)} · tests up to ${shortIso(m.period.end)}`,
  );
  const newPeriod = when(
    `First visits ${shortIso(report.new_patients.first_new_visit)} – ${shortIso(m.period.end)} · tests up to ${shortIso(m.period.end)}`,
  );
  const IMPROVED_PARTS = ["Improved 0.5+ points", "About the same", "Got worse 0.5+ points"];
  const confirmationChart = donutChart(
    "How each diabetes patient was confirmed",
    `All ${num(f.registry)} diabetes patients, each counted once. ${seenText}`,
    [
      { label: "Takes diabetes medicine", n: conf.medicine.n, tone: "c0" },
      { label: "No medicine, but HbA1c 6.5% or more", n: conf.hba1c_only.n, tone: "c1" },
      { label: "Diagnosis written only", n: conf.unconfirmed.n, tone: "na" },
    ],
    [
      `Diabetes medicine = metformin, sulfonylurea, DPP-4, SGLT2, GLP-1, insulin, pioglitazone or acarbose`,
      `"Diagnosis written only": diabetes is in the record, but no diabetes medicine and no HbA1c of 6.5% or more`,
    ],
  );
  const cov = allCount?.hba1c_coverage;
  const coverageTable =
    cov &&
    (() => {
      const row = (label, g, strong = false) => {
        const never = g.people - g.tested;
        const pct = (n) => `${fixed(share(n, g.people), 1)}%`;
        const wrap = (t) => (strong ? `<strong>${t}</strong>` : t);
        return `<tr><th scope="row">${wrap(label)}</th><td class="num">${wrap(num(g.people))}</td><td class="num">${wrap(num(g.tested))}<span class="nd">${pct(g.tested)}</span></td><td class="num">${wrap(num(never))}<span class="nd">${pct(never)}</span></td></tr>`;
      };
      const all = {
        people: cov.diabetes.people + cov.non_diabetes.people,
        tested: cov.diabetes.tested + cov.non_diabetes.tested,
      };
      return `<figure class="chart"><figcaption><strong>HbA1c test done: all patients</strong><span>Any HbA1c recorded in Scribe up to ${shortIso(m.period.end)}. ${when(`Patients seen ${shortIso(m.period.start)} – ${shortIso(m.period.end)}`)}</span></figcaption>
<div class="scroll" style="margin-top:12px"><table aria-label="HbA1c test done, all patients"><thead><tr><th scope="col">Group</th><th class="num" scope="col">Patients</th><th class="num" scope="col">Had HbA1c</th><th class="num" scope="col">Never had HbA1c</th></tr></thead>
<tbody>${row("Diabetes patients", cov.diabetes)}${row("Patients without diabetes", cov.non_diabetes)}${row("All patients", all, true)}</tbody></table></div>
<p class="def">"Never had HbA1c" means no result in Scribe. Some of these patients were tested outside or during April 2024 – February 2025, when tests were not recorded.</p></figure>`;
    })();
  const nd = allCount?.non_diabetes;
  const ndBands = nd?.hba1c_highest;
  const nonDiabetesChart =
    ndBands &&
    donutChart(
      "Patients without diabetes: their highest HbA1c",
      `${num(nd.people)} patients, each counted once, by their highest HbA1c up to ${shortIso(m.period.end)}. ${seenText}`,
      [
        { label: "Never had an HbA1c test", n: ndBands.never_tested, tone: "na" },
        { label: "Normal (below 5.7%)", n: ndBands.normal, tone: "o1" },
        { label: "Prediabetes range (5.7–6.4%)", n: ndBands.prediabetes, tone: "o2" },
        {
          label: "6.5% or more, not confirmed",
          n: ndBands.high_once + ndBands.high_repeat_unconfirmed,
          tone: "o3",
        },
      ],
      [
        `Each patient's highest HbA1c result up to ${longDate(m.period.end)}`,
        `Results dated 1 January are left out (real test date unknown)`,
        `"Not confirmed": ${num(ndBands.high_once)} had only one result of 6.5% or more, and ${num(ndBands.high_repeat_unconfirmed)} had the same value on two dates (likely copied from an old report)`,
        `Diabetes needs two high results, so these patients are not counted as diabetes`,
      ],
    );
  const patientCards = group("Patients", [
    allCount &&
      tile(
        "All patients seen at Gini",
        num(allCount.total_seen),
        `Any condition, at least one visit in the period.`,
        [
          `${num(allCount.patients_in_scribe)} patient records in Scribe`,
          `${num(allCount.never_seen_in_period)} with no visit in the period removed`,
          `${num(allCount.duplicate_records_merged)} duplicate records of the same person merged`,
          `= ${num(allCount.total_seen)} people`,
        ],
      ),
    allCount &&
      tile(
        "Patients without diabetes",
        num(allCount.total_seen - f.registry),
        `${fixed(((allCount.total_seen - f.registry) / allCount.total_seen) * 100, 1)}% of all patients: thyroid, BP, PCOS, obesity, prediabetes and others.`,
        [
          `${num(allCount.total_seen)} all patients − ${num(f.registry)} diabetes patients = ${num(allCount.total_seen - f.registry)}`,
        ],
      ),
    tile(
      "Diabetes patients",
      num(f.registry),
      `${allCount ? `${fixed((f.registry / allCount.total_seen) * 100, 1)}% of all patients. ` : ""}${fixed(conf.medicine.pct + conf.hba1c_only.pct, 1)}% confirmed by medicine or a blood test.`,
      [
        `Diabetes is written in their record, or two HbA1c tests were 6.5% or more`,
        `Not counted: prediabetes, and diabetes only during pregnancy`,
        `Visited Gini at least once in the period (each person counted once)`,
        `${num(conf.medicine.n)} take diabetes medicine · ${num(conf.hba1c_only.n)} have a high HbA1c · ${num(conf.unconfirmed.n)} have the diagnosis only`,
      ],
    ),
    tile(
      "Came 3 or more times",
      num(f.three_plus_visits.n),
      `${pctOf(f.three_plus_visits)} of diabetes patients. ${num(f.single_visit.n)} came only once.`,
      [
        `A visit = a day the patient was seen at Gini`,
        `${num(f.three_plus_visits.n)} diabetes patients came on 3 or more different days`,
        `${num(f.single_visit.n)} came only once`,
      ],
    ),
  ]);

  const hba1cCards = group("HbA1c (blood sugar)", [
    tile(
      "Had HbA1c tested 2 or more times",
      num(f.with_two_plus_hba1c.n),
      `${pctOf(f.with_two_plus_hba1c)} of diabetes patients.`,
      [
        `HbA1c tests dated in the period, after removing values copied from old notes`,
        `Diabetes patients with tests on 2 or more different dates = ${num(f.with_two_plus_hba1c.n)}`,
      ],
    ),
    fl &&
      tile(
        "Change between first and latest HbA1c",
        `${signed(fl.change_mean)} points`,
        `${num(fl.patients)} patients · ${fixed(fl.first_mean)}% → ${fixed(fl.latest_mean)}%<ul class="mini"><li><span>Improved</span><strong>${fixed(fl.improved_05.pct, 1)}%</strong></li><li><span>About the same</span><strong>${fixed(fl.about_same.pct, 1)}%</strong></li><li><span>Got worse</span><strong>${fixed(fl.worsened_05.pct, 1)}%</strong></li></ul>`,
        [
          `${num(fl.patients)} diabetes patients with 2 or more HbA1c tests`,
          `Change = latest test − first test`,
          `Improved: fell 0.5+ points (${num(fl.improved_05.n)}). Same: within 0.5 (${num(fl.about_same.n)}). Worse: rose 0.5+ points (${num(fl.worsened_05.n)})`,
          `Below 7%: ${fixed(fl.below7_first.pct, 1)}% → ${fixed(fl.below7_latest.pct, 1)}%`,
          `Tests are about ${Math.round(fl.months_between_median)} months apart on average`,
        ],
      ),
    tile(
      "Average change after 1 year",
      `${signed(w.m12.outcome.change_mean)} points`,
      `HbA1c ${fixed(w.m12.outcome.baseline_mean, 1)}% → ${fixed(w.m12.outcome.follow_mean, 1)}% in ${num(w.m12.outcome.n)} patients tested again after about 1 year.`,
      [
        `${num(w.m12.with_baseline)} patients had an HbA1c at their first visit and enough time for a 1-year test`,
        `${num(w.m12.outcome.n)} of them came back and were tested again 9–15 months later`,
        `For each: second test − first test, then the average = ${signed(w.m12.outcome.change_mean)} points`,
        `After about 6 months: ${signed(w.m6.outcome.change_mean)} points (${num(w.m6.outcome.n)} patients)`,
      ],
    ),
    tile(
      "Improved by 0.5 points or more (1 year)",
      pctOf(w.m12.outcome.improved_05),
      `${num(w.m12.outcome.improved_05.n)} of ${num(w.m12.outcome.n)} patients tested again after about 1 year.`,
      [
        `${num(w.m12.outcome.n)} patients were tested again about 1 year after their first visit`,
        `${num(w.m12.outcome.improved_05.n)} of them had HbA1c at least 0.5 points lower than at the first visit`,
        `A fall of 0.5 points is the change doctors count as a real improvement`,
      ],
    ),
    tile(
      "Got below 7% within a year",
      pctOf(w.m12.outcome.reached_below7),
      `${num(w.m12.outcome.reached_below7.n)} of ${num(w.m12.outcome.reached_below7.d)} who started at 7% or above.<ul class="mini"><li><span>Already below 7% and stayed there</span><strong>${pctOf(w.m12.outcome.maintained_below7)}</strong></li></ul>`,
      [
        `Of the ${num(w.m12.outcome.n)} re-tested at 1 year, ${num(w.m12.outcome.reached_below7.d)} started at 7% or above`,
        `${num(w.m12.outcome.reached_below7.n)} were below 7% at the re-test`,
      ],
    ),
    tile(
      "New patients: change after 1 year",
      `${signed(np.m12.outcome.change_mean)} points`,
      `${fixed(np.m12.outcome.baseline_mean, 1)}% → ${fixed(np.m12.outcome.follow_mean, 1)}% in ${num(np.m12.outcome.n)} patients new to Gini in 2025–26.`,
      [
        `${num(report.new_patients.patients)} diabetes patients new to Gini in 2025–26`,
        `${num(np.m12.eligible)} joined by ${byDate(np.m12.measurement_range_days[1])} → ${num(np.m12.with_baseline)} had a first-visit HbA1c → ${num(np.m12.outcome.n)} re-tested about 1 year later`,
      ],
    ),
  ]);

  const targetCards = group("Targets (latest results)", [
    tile(
      "All three targets met",
      pctOf(a3.all_three_bp140),
      `HbA1c below 7%, BP below 140/90, LDL below 100 (about 1 in ${Math.round(100 / a3.all_three_bp140.pct)}).<ul class="mini"><li><span>With stricter BP 130/80</span><strong>${pctOf(a3.all_three)}</strong></li></ul>`,
      targetSteps(
        a3.all_three_bp140.n,
        `met all three (${num(a3.all_three.n)} with BP below 130/80)`,
      ),
    ),
    targetCard(
      "HbA1c below 7%",
      a3.hba1c_below7,
      "",
      targetSteps(a3.hba1c_below7.n, "had HbA1c below 7%"),
    ),
    tile(
      "Blood pressure below 140/90",
      pctOf(a3.bp_below_140_90),
      `${num(a3.bp_below_140_90.n)} of ${num(a3.bp_below_140_90.d)} patients.<ul class="mini"><li><span>Below 130/80</span><strong>${pctOf(a3.bp_below_130_80)}</strong></li></ul>`,
      targetSteps(
        a3.bp_below_140_90.n,
        `had BP below 140/90 (${num(a3.bp_below_130_80.n)} below 130/80)`,
      ),
    ),
    targetCard(
      "LDL cholesterol below 100",
      a3.ldl_below100,
      "",
      targetSteps(a3.ldl_below100.n, "had LDL below 100"),
    ),
  ]);

  const medicineCards = group("Medicines", [
    tile(
      "On GLP-1 or tirzepatide",
      num(tr.any_incretin.started_in_period),
      `${num(tr.glp1.started_in_period)} GLP-1, ${num(tr.tirzepatide.started_in_period)} tirzepatide (some had both).`,
      [
        `Prescriptions matched by brand and generic name (semaglutide, liraglutide, dulaglutide, tirzepatide…)`,
        `${num(tr.any_incretin.started_in_period)} patients with a first prescription in the period`,
      ],
    ),
    tile(
      "On weekly insulin",
      num(tr.weekly_insulin.started_in_period),
      `Started from ${longDate(tr.weekly_insulin.first_start, false)}. Too new for results.`,
      [
        `Prescriptions of insulin icodec (Awiqli); the first was on ${longDate(tr.weekly_insulin.first_start)}`,
      ],
    ),
    gi &&
      tile(
        "Stopped insulin after starting GLP-1",
        num(gi.stopped_insulin),
        `${fixed((gi.stopped_insulin / gi.on_insulin_at_glp1_start) * 100, 1)}% of ${num(gi.on_insulin_at_glp1_start)} patients who were on insulin when GLP-1 or tirzepatide was started.`,
        [
          `Diabetes patients who started GLP-1 or tirzepatide in the period while already on insulin = ${num(gi.on_insulin_at_glp1_start)}`,
          `Of them, every insulin was marked stopped after the GLP-1 start and none is still active = ${num(gi.stopped_insulin)}`,
          `Checked against visit prescriptions from 2025–26: about 1 in 10 there too`,
        ],
      ),
  ]);

  const onsetCards =
    on &&
    group("Age when diabetes started", [
      tile(
        "Diabetes started before age 40",
        num(on.under40),
        `${fixed((on.under40 / on.known) * 100, 1)}% of ${num(on.known)} patients whose age at onset is recorded.`,
        [
          `${num(on.diabetes)} diabetes patients; age at onset recorded for ${num(on.known)}`,
          `Age at onset = the "AOO" or "age of onset" the doctor wrote (${num(on.under40_written)} of the ${num(on.under40)}), else age at the visit minus years since diagnosis`,
          `Before 40: ${num(on.under40_type2)} Type 2, ${num(on.under40_type1)} Type 1 / LADA, ${num(on.under40_other)} other`,
        ],
      ),
    ]);

  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diabetes Outcomes Scorecard</title><style>${css()}h3{font-size:14px;margin:22px 0 8px;color:var(--ink);text-transform:uppercase;letter-spacing:.04em}</style></head><body><main>
<h1>Gini diabetes outcomes scorecard</h1>
<p class="sub">Gini Advanced Care Hospital, Mohali · patients seen ${longDate(m.period.start)} to ${longDate(m.period.end)} · data taken ${longDate(m.generated_at)} from Scribe · totals only, no patient names</p>
${client ? "" : `<div class="banner" role="note"><strong>Draft for clinical review.</strong> Dr Bhansali and the clinical team must approve every figure before it is used publicly. These results show what happened to patients treated at Gini. They do not prove the treatment caused it.</div>`}

<div class="guide"><strong>How to read this page</strong>
<dl>
<dt>HbA1c</dt><dd>A blood test showing average blood sugar over about 3 months. Below 7% is the usual target; 6.5% or more means diabetes.</dd>
<dt>Points</dt><dd>HbA1c going from 8.8% to 7.4% is a fall of 1.4 points.</dd>
<dt>Re-tested</dt><dd>Results come only from patients who came back for a second test. Others are left out, not counted as good or bad.</dd>
<dt>Likely true range</dt><dd>The "95% CI": the true average is very likely inside this range.</dd>
</dl></div>

<h2>${client ? "Key findings" : "Key points for the press"}</h2>
<p class="def">${print ? "The steps behind each finding are shown under it." : client ? 'Open "How this number was counted" to see the steps behind each finding.' : 'Read each point as written. Open "How this number was counted" to see the steps.'}</p>
<ol class="press">
<li><p class="say">${allCount ? `<strong>${num(allCount.total_seen)} patients</strong> were seen at Gini between ${longDate(m.period.start)} and ${longDate(m.period.end)}. <strong>${num(f.registry)}</strong> of them (${fixed((f.registry / allCount.total_seen) * 100, 1)}%) have diabetes.` : `<strong>${num(f.registry)} people with diabetes</strong> were seen at Gini between ${longDate(m.period.start)} and ${longDate(m.period.end)}.`}</p>
<p class="say-sub">${fixed(conf.medicine.pct + conf.hba1c_only.pct, 1)}% of the diabetes patients are confirmed by diabetes medicines or an HbA1c of 6.5% or more.</p>
${
  allCount
    ? flow("Where these numbers come from", [
        {
          title: "",
          steps: [
            [allCount.patients_in_scribe, "records in Scribe"],
            [allCount.records_seen_in_period, "visited in the period"],
            [allCount.total_seen, "people (duplicates merged)"],
            [f.registry, "have diabetes"],
          ],
        },
      ])
    : ""
}
${how([
  `Diabetes = a diabetes diagnosis in the record, or two HbA1c tests of 6.5% or more (prediabetes and pregnancy-only diabetes not included) = ${num(f.registry)}`,
  `Confirmed: ${num(conf.medicine.n)} on diabetes medicines + ${num(conf.hba1c_only.n)} with HbA1c 6.5%+. Diagnosis only: ${num(conf.unconfirmed.n)}`,
])}</li>
<li><p class="say"><strong>Patients new to Gini in 2025–2026</strong>: average HbA1c fell from <strong>${fixed(np.m12.outcome.baseline_mean, 1)}% to ${fixed(np.m12.outcome.follow_mean, 1)}%</strong> in one year.</p>
<p class="say-sub">Same group of new patients; the rows differ only in when the second test was done.</p>
<div class="scroll" style="margin-top:8px"><table aria-label="New patients HbA1c">
<thead><tr><th scope="col">Second test</th><th class="num" scope="col">Patients</th><th class="num" scope="col">Average HbA1c</th><th class="num" scope="col">Improved 0.5+ points</th></tr></thead>
<tbody>
<tr><th scope="row">About 3 months after first visit</th><td class="num">${num(np.m3.outcome.n)}</td><td class="num">${fixed(np.m3.outcome.baseline_mean, 1)}% → <strong>${fixed(np.m3.outcome.follow_mean, 1)}%</strong></td>${cell(np.m3.outcome.improved_05)}</tr>
<tr><th scope="row">About 1 year after first visit</th><td class="num">${num(np.m12.outcome.n)}</td><td class="num">${fixed(np.m12.outcome.baseline_mean, 1)}% → <strong>${fixed(np.m12.outcome.follow_mean, 1)}%</strong></td>${cell(np.m12.outcome.improved_05)}</tr>
<tr><th scope="row">Same patients, tested at both times</th><td class="num">${num(sg.n)}</td><td class="num">${fixed(sg.baseline_mean, 1)}% → ${fixed(sg.m3_mean, 1)}% → <strong>${fixed(sg.m12_mean, 1)}%</strong></td>${cell(sg.improved_05_at_12)}</tr>
</tbody></table></div>
${flow(
  "Where these numbers come from",
  [
    ...windowColumns(report.new_patients.windows, ["m3", "m12"], NEW_START),
    {
      title: `Same patients: ${num(sg.n)}`,
      steps: [
        [
          null,
          `<strong>${num(np.m3.outcome.n)}</strong> at 3 months + <strong>${num(np.m12.outcome.n)}</strong> at 12 months`,
        ],
        [sg.n, "tested at both"],
      ],
    },
  ],
  `${num(np.m12.outcome.n)} is lower than ${num(np.m3.outcome.n)}: many joined too recently for a 1-year test, and fewer come back after a year.`,
)}</li>
<li><p class="say"><strong>All diabetes patients</strong> re-tested one year after their first visit: average HbA1c fell from <strong>${fixed(w.m12.outcome.baseline_mean, 1)}% to ${fixed(w.m12.outcome.follow_mean, 1)}%</strong> (${num(w.m12.outcome.n)} patients).</p>
<p class="say-sub">${pctOf(w.m12.outcome.improved_05)} improved by 0.5 points or more. Of those starting at 7% or above, ${pctOf(w.m12.outcome.reached_below7)} got below 7%.</p>
${windowFlow(report.hba1c.windows, ["m12"], ALL_START)}
${how([
  `Improved 0.5+ points: ${num(w.m12.outcome.improved_05.n)} of ${num(w.m12.outcome.n)}. Got below 7%: ${num(w.m12.outcome.reached_below7.n)} of ${num(w.m12.outcome.reached_below7.d)}`,
])}</li>
<li><p class="say"><strong>${pctOf(ctl.among_complete.all_three_bp140)}</strong> of diabetes patients (about 1 in ${Math.round(100 / ctl.among_complete.all_three_bp140.pct)}) meet all three targets: HbA1c below 7%, blood pressure below 140/90 and LDL below 100.</p>
<p class="say-sub">With the stricter blood-pressure target of 130/80: ${pctOf(ctl.among_complete.all_three)} (about 1 in ${Math.round(100 / ctl.among_complete.all_three.pct)}).</p>
${flow(
  "Where these numbers come from",
  [
    {
      title: "",
      steps: [
        [f.registry, "diabetes patients"],
        [ctl.complete.n, "HbA1c, BP and LDL all tested"],
        [ctl.among_complete.all_three_bp140.n, "met all three (BP below 140/90)"],
      ],
    },
  ],
  `With BP below 130/80: ${num(ctl.among_complete.all_three.n)}.`,
)}</li>
<li><p class="say"><strong>${num(tr.any_incretin.started_in_period)}</strong> patients have been prescribed GLP-1 or tirzepatide, and <strong>${num(tr.weekly_insulin.started_in_period)}</strong> have started weekly insulin since ${longDate(tr.weekly_insulin.first_start, false)}.</p></li>
${
  on
    ? `<li><p class="say"><strong>${num(on.under40)}</strong> diabetes patients (about 1 in ${Math.round(on.known / on.under40)}) got diabetes <strong>before age 40</strong>.</p>
<p class="say-sub">Out of ${num(on.known)} patients whose age at onset is recorded.</p>
${flow(
  "Where these numbers come from",
  [
    {
      title: "",
      steps: [
        [on.diabetes, "diabetes patients"],
        [on.known, "age at onset known"],
        [on.under40, "diabetes before 40"],
      ],
    },
  ],
  `${num(on.under40_type2)} Type 2, ${num(on.under40_type1)} Type 1 / LADA, ${num(on.under40_other)} other.`,
)}</li>`
    : ""
}
${
  gi
    ? `<li><p class="say"><strong>${num(gi.stopped_insulin)}</strong> of ${num(gi.on_insulin_at_glp1_start)} patients on insulin (about 1 in ${Math.round(gi.on_insulin_at_glp1_start / gi.stopped_insulin)}) <strong>stopped insulin</strong> after starting GLP-1 or tirzepatide.</p>
${flow("Where these numbers come from", [
  {
    title: "",
    steps: [
      [gi.on_insulin_at_glp1_start, "on insulin when GLP-1 started"],
      [gi.stopped_insulin, "stopped all insulin"],
    ],
  },
])}</li>`
    : ""
}
</ol>
<p class="def"><strong>Note:</strong> HbA1c results are for patients who came back for a test. At one year, ${pctOf(w.m12.measured)} of patients who could be re-tested were re-tested.</p>
${
  client
    ? ""
    : `<ul class="avoid" aria-label="Do not say">
<li>Say "of patients re-tested", not "of our patients".</li>
<li>${num(np.m3.outcome.n)} are new patients re-tested about 3 months after their first visit, not "${num(np.m3.outcome.n)} new patients in 3 months".</li>
<li>Do not say Gini's treatment caused the change; there is no comparison group.</li>
<li>Do not say "five years of follow-up"; records start in 2022.</li>
<li>Do not quote GLP-1 weight loss, weekly-insulin results (too new), CGM (no data), complication rates as screening, or comparisons with trials or other hospitals.</li>
</ul>`
}


<h2>Summary cards</h2>
<p class="def">Open "How this number was counted" on any card to see the steps.</p>
${patientCards}<div class="grid--charts" style="margin-top:12px">${nonDiabetesChart || ""}${confirmationChart}</div>${coverageTable || ""}${onsetCards || ""}${hba1cCards}${targetCards}${medicineCards}

${section(
  "Patient groups",
  `The groups overlap: one patient can be in several. Patients who stopped coming to Gini are still counted.`,
)}
${barChart(
  "Diabetes patients: tests and visits",
  `Share of all ${num(f.registry)} diabetes patients. ${seenText} A patient can be in more than one row.`,
  [
    { label: "Had an HbA1c at their first visit", ...f.with_baseline_hba1c },
    { label: "Had HbA1c tested 2 or more times", ...f.with_two_plus_hba1c },
    { label: "Came 3+ times, over at least 6 months", ...f.three_visits_over_six_months },
    { label: "Last seen in the past 6 months", ...st.active },
    { label: "Last seen 6–12 months ago", ...st.overdue },
    { label: "Last seen more than 12 months ago", ...st.long_gap },
  ],
)}
${tableFold(
  shareTable("Patient groups", "Group", [
    ["All diabetes patients", { n: f.registry, d: f.registry, pct: 100 }],
    ["Had an HbA1c at their first visit", f.with_baseline_hba1c],
    ["Had HbA1c tested 2 or more times", f.with_two_plus_hba1c],
    ["Came 3 or more times, over at least 6 months", f.three_visits_over_six_months],
    ["Last seen in the past 6 months", st.active],
    ["Last seen 6–12 months ago", st.overdue],
    ["Last seen more than 12 months ago", st.long_gap],
  ]),
)}
<p class="def">Moved to another hospital or died: not recorded in Scribe, so these patients cannot be separated out.</p>
<h3>How many patients could be re-tested at each time</h3>
<p class="def">Each row starts from all ${num(f.registry)} diabetes patients. <strong>Can be counted + Too new to count = ${num(f.registry)}</strong>. Only patients with an HbA1c at their first visit can show a change; the last column is how many of them were re-tested.</p>
<div class="scroll" style="margin-top:8px"><table aria-label="Patients at each time point"><thead><tr><th scope="col">Re-test time</th>
<th class="num" scope="col">Can be counted<span class="nd">first visit on or before the date</span></th><th class="num" scope="col">Too new to count<span class="nd">first visit after the date</span></th><th class="num" scope="col">HbA1c at first visit</th><th class="num" scope="col">Re-tested</th></tr></thead>
<tbody>${f.windows.map((x) => `<tr><th scope="row">${esc(x.label)}<span class="nd">joined by ${shortDate(m.windows.find((y) => y.key === x.window).maxDays)}</span></th><td class="num">${num(x.eligible)}</td><td class="num">${num(x.too_recent)}</td><td class="num">${num(x.with_baseline)}</td>${cell(x.measured)}</tr>`).join("")}</tbody></table></div>

${section(
  "HbA1c over time: all diabetes patients",
  `Each row compares the first-visit HbA1c with a second test at a fixed time after it.`,
  [
    `First test = HbA1c closest to the first visit (6 months before to 2 weeks after)`,
    `Second test = HbA1c closest to 3, 6, 12, 24 or 36 months after the first visit`,
    `Only patients whose first visit was early enough for that time to have passed`,
  ],
)}
${windowFlow(report.hba1c.windows, ["m3", "m6", "m12", "m24", "m36"], ALL_START)}
${dumbbellChart(
  "Average HbA1c: first visit and later test",
  `All diabetes patients re-tested at each time. ${allPeriod} Lower is better.`,
  overTime(report.hba1c.windows, ["m3", "m6", "m12", "m24", "m36"]),
)}
${stackChart(
  "Did HbA1c improve?",
  `Share of re-tested patients at each time. ${allPeriod}`,
  IMPROVED_PARTS,
  improvedRows(report.hba1c.windows, ["m3", "m6", "m12", "m24", "m36"]),
)}
${tableFold(windowTable("HbA1c over time, all patients", report.hba1c.windows, ["m3", "m6", "m12", "m24", "m36"], m.period.end))}
${fullWindowTable("All measures, all patients", report.hba1c.windows, ["m3", "m6", "m12", "m24", "m36"], m.period.end, print)}
<p class="def">Checks: using only lab-report values, the 1-year change is ${signed(lab12.change_mean)} (${num(lab12.n)} patients); leaving out the ${num(conf.unconfirmed.n)} patients with a diagnosis only, it is ${signed(confirmed12.change_mean)}. The results hold.</p>

${section(
  "HbA1c over time: patients new to Gini (2025–2026)",
  `Their first visit was a "New Patient" visit, so the first test is their true starting point. Longer follow-up is not available yet.`,
  [
    `${num(report.new_patients.patients)} diabetes patients whose first Gini visit was a "New Patient" visit in 2025–2026`,
    `The same ${num(sg.n)} patients tested at the start, at 3 months and at 1 year: ${fixed(sg.baseline_mean, 1)}% → ${fixed(sg.m3_mean, 1)}% → ${fixed(sg.m12_mean, 1)}%`,
  ],
)}
${windowFlow(report.new_patients.windows, ["m3", "m6", "m12"], NEW_START)}
${dumbbellChart(
  "Average HbA1c: first visit and later test",
  `New patients re-tested at each time. ${newPeriod} Lower is better.`,
  overTime(report.new_patients.windows, ["m3", "m6", "m12"]),
)}
${stackChart(
  "Did HbA1c improve?",
  `Share of re-tested new patients at each time. ${newPeriod}`,
  IMPROVED_PARTS,
  improvedRows(report.new_patients.windows, ["m3", "m6", "m12"]),
)}
${tableFold(windowTable("HbA1c over time, new patients", report.new_patients.windows, ["m3", "m6", "m12"], m.period.end))}
${fullWindowTable("All measures, new patients", report.new_patients.windows, ["m3", "m6", "m12"], m.period.end, print)}

${section(
  "Results by starting HbA1c (1 year)",
  `Patients who start very high fall the most; part of this is a natural statistical effect.`,
)}
${dumbbellChart(
  "Average HbA1c after 1 year, by HbA1c at first visit",
  `${num(w.m12.outcome.n)} patients re-tested about 1 year after their first visit ${when(firstVisitBy(w.m12, m.period.end))} Lower is better.`,
  w.m12.by_severity
    .filter((b) => b.n)
    .map((b) => ({
      label: `Started ${b.band.toLowerCase()}`,
      from: b.baseline_mean,
      to: b.follow_mean,
      change: b.change_mean,
      n: b.n,
    })),
  null,
  "First visit",
  "After 1 year",
)}
${tableFold(severityTable(w.m12))}
<details class="more"${print ? " open" : ""}><summary>Show 3 months, 6 months, 2 years and 3 years</summary>
${["m3", "m6", "m24", "m36"].map((k) => `<h3>${esc(w[k].label)}</h3>${severityTable(w[k])}`).join("")}
</details>

${section("Targets (latest results)", `Each patient's latest HbA1c, blood pressure and LDL from the last year. ${num(ctl.complete.n)} patients had all three tested.`)}
${barChart(
  "Diabetes patients meeting each target",
  `Latest results of the ${num(ctl.complete.n)} patients who had HbA1c, blood pressure and LDL all tested in the 12 months before their last visit. ${seenText}`,
  [
    { label: "HbA1c below 7%", ...a3.hba1c_below7 },
    { label: "Blood pressure below 140/90", ...a3.bp_below_140_90 },
    { label: "Blood pressure below 130/80 (stricter)", ...a3.bp_below_130_80 },
    { label: "LDL cholesterol below 100", ...a3.ldl_below100 },
    { label: "LDL cholesterol below 70 (stricter)", ...a3.ldl_below70 },
    { label: "All three (BP below 140/90)", ...a3.all_three_bp140 },
    { label: "All three (BP below 130/80)", ...a3.all_three },
  ],
)}
${tableFold(controlTable(ctl))}
<details class="more"${print ? " open" : ""}><summary>Show change over time</summary>
<p class="def">Patients with HbA1c, blood pressure and LDL tested both at their first visit and again later. Uses the stricter BP target 130/80.</p>
<div class="scroll"><table aria-label="All three targets over time"><thead><tr><th scope="col">Second test</th><th class="num" scope="col">Patients</th>
<th class="num" scope="col">All three met at first visit</th><th class="num" scope="col">All three met at second test</th></tr></thead><tbody>
${report.combined_control_change.map((r) => `<tr><th scope="row">${r.window === "m6" ? "6 months" : "1 year"}</th><td class="num">${num(r.complete_pairs)}</td>${cell(r.all_three_at_baseline)}${cell(r.all_three_at_follow_up)}</tr>`).join("")}
</tbody></table></div></details>

${section(
  "Blood pressure, cholesterol, kidney and weight",
  `First-visit value compared with the value at a fixed time later, same method as HbA1c.`,
)}
${markerTable(report.other_markers)}
<h3>Urine protein (kidney damage sign)</h3>
${stackChart(
  "Urine protein level at the later test",
  `Compared with the first visit, for patients tested both times. ${allPeriod}`,
  ["Better", "Same", "Worse"],
  [
    ["m12", "1 year later"],
    ["m24", "2 years later"],
  ]
    .map(([k, label]) => ({ k: report.kidney[k].uacr, label }))
    .filter(({ k }) => k.stage_better.d)
    .map(({ k, label }) => ({
      label,
      total: k.stage_better.d,
      values: [k.stage_better.n, k.stage_same.n, k.stage_worse.n],
    })),
)}
${tableFold(kidneyTable(report.kidney))}

${section(
  "Who the diabetes patients are",
  `All ${num(f.registry)} diabetes patients seen in the period, including those who came only once.`,
)}
<div class="grid--charts">
${donutChart(
  "Sex",
  seenText,
  report.demographics.sex.map((x, i) => ({
    label: x.sex === "Unspecified" ? "Not recorded" : x.sex,
    n: x.n,
    tone: x.sex === "Unspecified" ? "na" : `c${i}`,
  })),
)}
${donutChart(
  "Diabetes type",
  seenText,
  report.demographics.dm_type.map((x, i) => ({
    label: x.type,
    n: x.n,
    tone: x.type === "Unspecified" ? "na" : `c${i}`,
  })),
)}
${columnChart(
  "Age at first visit",
  `${seenText} Age not recorded for ${num(report.demographics.age_at_enrollment.unknown.n)} patients (${pctOf(report.demographics.age_at_enrollment.unknown)}).`,
  report.demographics.age_at_enrollment.bands.map((x) => ({ label: x.band, n: x.n, d: x.d })),
)}
${columnChart(
  "Year of first visit",
  `${seenText} 2024 is low because visits from April 2024 to February 2025 were not recorded in Scribe.`,
  report.demographics.enrollment_by_year
    .filter((y) => y.patients >= 10)
    .map((y) => ({ label: String(y.year), n: y.patients, d: f.registry })),
)}
</div>
${tableFold(
  `<div class="grid grid--tables">
${shareTable(
  "Sex",
  "Sex",
  report.demographics.sex.map((x) => [x.sex === "Unspecified" ? "Not recorded" : x.sex, x]),
)}
${shareTable(
  "Diabetes type",
  "Diabetes type",
  report.demographics.dm_type.map((x) => [x.type, x]),
)}
${shareTable("Age at first visit", "Age at first visit", [...report.demographics.age_at_enrollment.bands.map((x) => [x.band, x]), ["Not recorded", report.demographics.age_at_enrollment.unknown]])}
${shareTable(
  "Year of first visit",
  "Year of first visit",
  report.demographics.enrollment_by_year
    .filter((y) => y.patients >= 10)
    .map((y) => [y.year, { n: y.patients, d: f.registry, pct: (y.patients / f.registry) * 100 }]),
)}
</div>`,
  "Show the tables",
)}

${section(
  "Recorded complications",
  `Diabetes patients whose record lists each complication. These are recorded diagnoses, not screening results.`,
)}
${barChart(
  "Diabetes patients with each complication recorded",
  `Out of all ${num(f.registry)} diabetes patients. ${seenText} A patient can have more than one.`,
  [
    ...[...report.complications.rows]
      .sort((a, b) => b.n - a.n)
      .map((x) => ({ label: x.label, n: x.n, d: x.d })),
    { label: "Any of kidney, nerve or eye", ...report.complications.any_microvascular },
    { label: "Any of heart, stroke or leg arteries", ...report.complications.any_macrovascular },
  ],
)}
${tableFold(shareTable("Recorded complications", "Complication", [...report.complications.rows.map((x) => [x.label, x]), ["Any of kidney, nerve or eye", report.complications.any_microvascular], ["Any of heart, stroke or leg arteries", report.complications.any_macrovascular]]))}

${section(
  "Medicines",
  `HbA1c change for patients who started the medicine at Gini (first prescribed at least 30 days after their first visit). There is no comparison group, so these are not medicine effects.`,
)}
${barChart(
  "Diabetes patients prescribed each medicine",
  `Out of all ${num(f.registry)} diabetes patients. ${seenText} A patient can take more than one.`,
  report.treatments.map((t) => ({ label: t.label, n: t.started_in_period, d: f.registry })),
)}
${medicineTable(report.treatments)}

${section(
  "Coming back",
  `Last visit as of ${longDate(m.period.end)}: within 6 months ${pctOf(st.active)}, 6–12 months ago ${pctOf(st.overdue)}, over a year ago ${pctOf(st.long_gap)}. Deaths and transfers are not recorded in Scribe.`,
)}
${columnChart(
  "Came back about 1 year after their first visit",
  "Share of patients who had a visit 9–15 months after their first visit, by year of first visit. 2023 and 2024 are low because visits from April 2024 to February 2025 were not recorded in Scribe.",
  eng.retention_by_enrollment_year
    .filter((r) => r.enrolled >= 10 && r.m12.visit_in_window.d)
    .map((r) => ({
      label: String(r.enrollment_year),
      n: r.m12.visit_in_window.n,
      d: r.m12.visit_in_window.d,
    })),
  null,
  true,
)}
${tableFold(retentionTable(eng.retention_by_enrollment_year))}
<p class="def">Patients last seen more than a year ago: their last known HbA1c averaged ${fixed(eng.long_gap_last_known_hba1c.mean, 1)}% (${num(eng.long_gap_last_known_hba1c.n)} patients with a result), and ${pctOf(eng.long_gap_last_known_hba1c.below7)} were below 7%. This is an old result, not a current outcome.</p>

${section(
  "Who was re-tested at 1 year",
  `Both groups started alike; re-tested patients simply came more often. That is why results say "patients who came back".`,
)}
${biasTable(report.hba1c.missing_vs_measured_12m)}

<h2>${client ? "Limits of this data" : "Limits of this data (say these when asked)"}</h2>
<ul class="caveats">
<li>Scribe records start in January 2022. "First visit" means the first visit recorded in Scribe.</li>
<li>April 2024 – February 2025: far fewer visits and tests were recorded. This is missing data, not fewer patients.</li>
<li>Results cover patients who came back for a test (${pctOf(w.m12.measured)} at 1 year).</li>
<li>Copied values from old notes, year-only test dates and ${num(m.duplicate_records_merged)} duplicate records were removed.</li>
<li>Complications are recorded diagnoses, not screening results. Weight is not recorded reliably.</li>
<li>Deaths, transfers and CGM data are not available.</li>
<li>Snapshot of ${longDate(m.generated_at)}; Scribe is live, so later counts differ slightly.</li>
</ul>
${client ? `<footer>Gini Advanced Care Hospital, Mohali · real-world data from routine care · totals only, no patient-level information</footer>` : `<footer>Method: docs/DM_OUTCOMES_METHODOLOGY.md · rerun: node server/scripts/build-dm-outcomes.mjs</footer>`}
</main></body></html>`;
  return print ? page.replaceAll('<details class="how">', '<details class="how" open>') : page;
}
