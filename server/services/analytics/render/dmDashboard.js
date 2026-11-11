import { PALETTE } from "./theme.js";
import { computeDashboard } from "./dmDashboardCompute.js";
import { DASHBOARD_CODES, DM_WINDOWS, SEVERITY_BANDS } from "../dmOutcomes.js";

const STATUS_LABELS = ["Active (seen ≤6 months)", "Overdue (6–12 months)", "Long gap (>12 months)"];

function css() {
  const t = (
    p,
  ) => `--surface:${p.surface};--plane:${p.plane};--ink:${p.ink};--ink2:${p.inkSecondary};
    --muted:${p.muted};--grid:${p.grid};--border:${p.border};--accent:${p.series[0]};--accent2:${p.series[1]};
    --good:${p.good};--critical:${p.critical};--warn:${p.warning};`;
  return `
  :root{${t(PALETTE.light)}color-scheme:light}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${t(PALETTE.dark)}color-scheme:dark}}
  :root[data-theme="dark"]{${t(PALETTE.dark)}color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:var(--plane);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  header{padding:20px 16px 0;max-width:1240px;margin:0 auto}
  h1{font-size:21px;margin:0}
  .sub{color:var(--ink2);margin:2px 0 12px}
  .banner{border:1px solid var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent);padding:8px 12px;border-radius:6px;font-size:13px}
  .filters{position:sticky;top:0;z-index:2;background:var(--plane);border-bottom:1px solid var(--grid)}
  .filters form{max-width:1240px;margin:0 auto;padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:end}
  .filters label{display:flex;flex-direction:column;font-size:12px;color:var(--ink2);gap:2px}
  select,button{font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--ink)}
  button{cursor:pointer}
  button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .count{margin-left:auto;font-size:13px;color:var(--ink2)}
  .count strong{color:var(--ink)}
  nav[role=tablist]{max-width:1240px;margin:0 auto;padding:12px 16px 0;display:flex;gap:4px;flex-wrap:wrap}
  [role=tab]{border-radius:6px 6px 0 0;border-bottom:none}
  [role=tab][aria-selected=true]{background:var(--ink);color:var(--plane);border-color:var(--ink)}
  main{max-width:1240px;margin:0 auto;padding:0 16px 48px}
  section[role=tabpanel]{border-top:1px solid var(--grid);padding-top:8px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin:14px 0}
  .card h2{font-size:16px;margin:0 0 2px}
  .meta{font-size:12px;color:var(--ink2);margin:0 0 10px}
  .meta b{color:var(--ink)}
  .cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:14px}
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
  th,td{padding:6px 9px;border-bottom:1px solid var(--grid);text-align:left;vertical-align:top;white-space:nowrap}
  thead th{font-size:12px;color:var(--ink2);font-weight:600}
  td.n,th.n{text-align:right}
  .nd{display:block;font-size:11px;color:var(--muted)}
  .sup{color:var(--muted);font-size:12px}
  svg text{fill:var(--ink);font-size:12px}
  svg .lbl{fill:var(--ink2)}
  .bar{fill:var(--accent)}.bar.neg{fill:var(--good)}.bar.pos{fill:var(--critical)}
  .axis{stroke:var(--axis,var(--grid))}
  .kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,190px),1fr));gap:10px}
  .kpi{border:1px solid var(--border);border-radius:8px;padding:10px 12px;background:var(--surface)}
  .kpi .k{font-size:12px;color:var(--ink2)}.kpi .v{font-size:22px;font-weight:650}.kpi .d{font-size:11.5px;color:var(--muted)}
  footer{max-width:1240px;margin:0 auto;padding:0 16px 32px;color:var(--muted);font-size:12px}`;
}

function client() {
  const data = JSON.parse(document.getElementById("dm-data").textContent);
  const ctx = data.ctx;
  const MIN = 10;
  const $ = (id) => document.getElementById(id);
  const esc = (v) =>
    String(v).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const fmt = (v, d = 1) =>
    v == null || Number.isNaN(v)
      ? "—"
      : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  const exact = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN"));
  const int = (v) =>
    v != null && v > 0 && v < MIN ? `<span class="sup">&lt;${MIN}</span>` : exact(v);
  const sgn = (v, d = 2) =>
    v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt(Math.abs(v), d)}`;
  const tooSmall = (d) => d != null && d > 0 && d < MIN;
  const pc = (s) =>
    !s || !s.d
      ? `<td class="n">—</td>`
      : tooSmall(s.d) || tooSmall(s.n)
        ? `<td class="n"><span class="sup">${tooSmall(s.d) ? `n&lt;${MIN}` : `fewer than ${MIN}`}</span></td>`
        : `<td class="n"><strong>${fmt(s.pct)}%</strong><span class="nd">${int(s.n)} / ${int(s.d)}</span></td>`;
  const val = (n, html) => (tooSmall(n) ? `<span class="sup">n&lt;${MIN}</span>` : n ? html : "—");
  const meta = (n, def, fu) =>
    `<p class="meta"><b>n</b> ${n} · <b>Outcome</b> ${def} · <b>Follow-up</b> ${fu}</p>`;
  const table = (label, head, body) =>
    `<div class="scroll"><table aria-label="${esc(label)}"><thead><tr>${head.map((h, i) => `<th scope="col"${i ? ' class="n"' : ""}>${h}</th>`).join("")}</tr></thead><tbody>${body.join("")}</tbody></table></div>`;

  function bars(label, items, { unit = "", signed = false, digits = 1 } = {}) {
    const shown = items.filter((x) => x.value != null && !tooSmall(x.n));
    if (!shown.length) return `<p class="sup">Not enough patients to chart.</p>`;
    const max = Math.max(...shown.map((x) => Math.abs(x.value))) || 1;
    const rowH = 26;
    const lw = 150;
    const cw = 320;
    const zero = signed ? lw + cw / 2 : lw;
    const scale = signed ? cw / 2 / max : cw / max;
    const h = shown.length * rowH + 6;
    const g = shown
      .map((x, i) => {
        const y = i * rowH + 4;
        const w = Math.max(1, Math.abs(x.value) * scale);
        const xPos = signed && x.value < 0 ? zero - w : zero;
        const cls = signed ? (x.value < 0 ? "bar neg" : "bar pos") : "bar";
        const tx = signed ? lw + cw + 8 : zero + w + 4;
        const anchor = "start";
        const txt = `${signed ? sgn(x.value, digits) : fmt(x.value, digits)}${unit} (n=${int(x.n)})`;
        return `<text class="lbl" x="${lw - 8}" y="${y + 15}" text-anchor="end">${esc(x.label)}</text>
          <rect class="${cls}" x="${xPos}" y="${y + 3}" width="${w}" height="${rowH - 10}" rx="2"><title>${esc(x.label)}: ${txt}</title></rect>
          <text x="${tx}" y="${y + 15}" text-anchor="${anchor}">${txt}</text>`;
      })
      .join("");
    const axis = signed
      ? `<line class="axis" x1="${zero}" x2="${zero}" y1="0" y2="${h}" stroke="currentColor" stroke-opacity=".3"/>`
      : "";
    return `<div class="scroll"><svg role="img" aria-label="${esc(label)}" width="100%" viewBox="0 0 ${lw + cw + 150} ${h}" style="max-width:${lw + cw + 150}px">${axis}${g}</svg></div>`;
  }

  const filters = {
    y: (r, v) => r.y === Number(v),
    a: (r, v) => r.a === Number(v),
    s: (r, v) => r.s === Number(v),
    sev: (r, v) => {
      if (v === "none") return !r.hb;
      if (!r.hb) return false;
      const b = ctx.severity[Number(v)];
      return r.hb[0] >= b.min && r.hb[0] < b.max;
    },
    tx: (r, v) => (v === "none" ? r.tx === 0 : (r.tx & (1 << Number(v))) !== 0),
    t: (r, v) => r.t === Number(v),
    st: (r, v) => r.st === Number(v),
    nw: (r, v) => r.nw === Number(v),
    cf: (r, v) => (v === "confirmed" ? r.cf !== 2 : r.cf === Number(v)),
  };

  function selected() {
    const out = [];
    for (const key of Object.keys(filters)) {
      const v = $(`f-${key}`).value;
      if (v !== "") out.push([key, v]);
    }
    return out;
  }

  function render() {
    const active = selected();
    const rows = data.rows.filter((r) => active.every(([k, v]) => filters[k](r, v)));
    const c = computeDashboard(rows, ctx);
    const desc = active.length
      ? active.map(([k]) => $(`f-${k}`).selectedOptions[0].text).join(" · ")
      : "All patients";
    $("count").innerHTML =
      `<strong>${exact(rows.length)}</strong> of ${exact(data.rows.length)} patients · ${esc(desc)}`;
    if (rows.length < MIN) {
      for (const id of ["p1", "p2", "p3", "p4", "p5"])
        $(id).innerHTML =
          `<div class="card"><p>Fewer than ${MIN} patients match these filters. Widen the filters to see results.</p></div>`;
      return;
    }
    const W = ctx.windows;
    const hb = c.hba1c;

    $("p1").innerHTML = `
      <div class="card"><h2>Patient population</h2>${meta(int(c.total), "diabetes patients with at least one visit in the period", `${ctx.period.start} to ${ctx.period.end}`)}
      <div class="kpis">
        ${[
          ["Patients", int(c.total), "unique, de-duplicated"],
          [
            "With baseline HbA1c",
            `${fmt(c.funnel.with_baseline.pct)}%`,
            `${int(c.funnel.with_baseline.n)} patients`,
          ],
          ["With 2+ HbA1c", int(c.funnel.two_hba1c.n), `${fmt(c.funnel.two_hba1c.pct)}%`],
          [
            "3+ visits",
            int(c.funnel.three_visits.n),
            `${fmt(c.funnel.three_visits.pct)}%; ${int(c.funnel.three_visits_6m.n)} over ≥6 months`,
          ],
          ["Single visit only", int(c.funnel.single_visit.n), `${fmt(c.funnel.single_visit.pct)}%`],
        ]
          .map(
            ([k, v, d]) =>
              `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`,
          )
          .join("")}
      </div></div>
      <div class="card"><h2>Eligibility funnel by follow-up window</h2>${meta(int(c.total), "HbA1c measured inside the window", "per window, days after first visit")}
      ${table(
        "Eligibility funnel",
        ["Window", "Eligible", "Too recent", "Eligible with baseline", "Measured"],
        hb.map(
          (w) =>
            `<tr><th scope="row">${w.label}<span class="nd">${w.range[0]}–${w.range[1]} days</span></th><td class="n">${int(w.eligible)}</td><td class="n">${int(w.too_recent)}</td><td class="n">${int(w.with_baseline)}</td>${pc(w.measured)}</tr>`,
        ),
      )}
      ${bars(
        "Patients measured in each window",
        hb.map((w) => ({ label: w.label, value: w.measured.n, n: w.with_baseline })),
        { digits: 0 },
      )}</div>
      <div class="cols">
        ${[
          ["Sex", c.sex],
          ["Diabetes type", c.type],
          ["Age at first visit", c.age],
          ["First visit year", c.years],
        ]
          .map(
            ([t, list]) =>
              `<div class="card"><h2>${t}</h2>${meta(int(c.total), "share of patients", "at first visit")}${table(
                t,
                [t, "Patients"],
                list.map((x) => `<tr><th scope="row">${esc(x.label)}</th>${pc(x)}</tr>`),
              )}</div>`,
          )
          .join("")}
      </div>`;

    const outRow = (w) => {
      const o = w.outcome;
      return `<tr><th scope="row">${w.label}<span class="nd">${w.range[0]}–${w.range[1]} days</span></th><td class="n">${int(w.eligible)}</td>${pc(w.measured)}
        <td class="n">${val(o.n, `${fmt(o.baseline_mean, 2)} → ${fmt(o.follow_mean, 2)}`)}</td>
        <td class="n">${val(o.n, `<strong>${sgn(o.change_mean)}</strong><span class="nd">median ${sgn(o.change_median)}</span>`)}</td>
        ${tooSmall(o.n) ? `<td class="n" colspan="7"><span class="sup">n&lt;${MIN}</span></td>` : [o.any_improvement, o.improved_05, o.improved_10, o.worsened_05, o.reached_below7, o.maintained_below7, o.below7].map(pc).join("")}</tr>`;
    };
    $("p2").innerHTML = `
      <div class="card"><h2>Mean paired HbA1c change by follow-up window</h2>${meta(hb.map((w) => `${w.label} ${int(w.outcome.n)}`).join(", "), "follow-up HbA1c − baseline HbA1c, percentage points (negative = lower)", "nearest reading to 3, 6, 12, 24 and 36 months")}
      ${bars(
        "Mean paired HbA1c change",
        hb.map((w) => ({ label: w.label, value: w.outcome.change_mean, n: w.outcome.n })),
        { signed: true, digits: 2, unit: " pts" },
      )}</div>
      <div class="card"><h2>HbA1c outcomes at each window</h2>${meta("shown per row", "paired change and thresholds; missing results are excluded, never counted as success or failure", "windows in days after first visit")}
      ${table("HbA1c outcomes", ["Window", "Eligible", "Measured", "Mean baseline → follow-up (%)", "Paired change", "Any improvement", "Improved ≥0.5", "Improved ≥1.0", "Worsened ≥0.5", "Reached <7% (from ≥7)", "Stayed <7%", "Below 7% at follow-up"], hb.map(outRow))}</div>
      <div class="card"><h2>Share improving by ≥0.5 points</h2>${meta(hb.map((w) => `${w.label} ${int(w.outcome.n)}`).join(", "), "HbA1c fell by 0.5 percentage points or more", "per window")}
      ${bars(
        "Improved by 0.5 points or more",
        hb.map((w) => ({ label: w.label, value: w.outcome.improved_05.pct, n: w.outcome.n })),
        { unit: "%" },
      )}</div>`;

    const winSel = Number($("sev-window")?.value ?? 2);
    const sw = hb[winSel];
    $("p3").innerHTML = `
      <div class="card"><h2>Outcomes by baseline HbA1c</h2>
      <label style="font-size:12px;color:var(--ink2)">Follow-up window <select id="sev-window">${W.map((w, i) => `<option value="${i}"${i === winSel ? " selected" : ""}>${w.label}</option>`).join("")}</select></label>
      ${meta(int(sw.outcome.n), "paired HbA1c change by baseline severity band", `${sw.label} (${sw.range[0]}–${sw.range[1]} days)`)}
      ${bars(
        "Mean change by baseline band",
        sw.by_severity.map((b) => ({ label: b.band, value: b.change_mean, n: b.n })),
        { signed: true, digits: 2, unit: " pts" },
      )}
      ${table(
        "Severity outcomes",
        [
          "Baseline HbA1c",
          "Paired patients",
          "Mean baseline → follow-up",
          "Paired change",
          "Improved ≥0.5",
          "Worsened ≥0.5",
          "Below 7% at follow-up",
        ],
        sw.by_severity.map(
          (b) =>
            `<tr><th scope="row">${b.band}</th><td class="n">${int(b.n)}</td><td class="n">${val(b.n, `${fmt(b.baseline_mean, 2)} → ${fmt(b.follow_mean, 2)}`)}</td><td class="n">${val(b.n, `<strong>${sgn(b.change_mean)}</strong><span class="nd">median ${sgn(b.change_median)}</span>`)}</td>${pc(b.improved_05)}${pc(b.worsened_05)}${pc(b.below7)}</tr>`,
        ),
      )}
      <p class="meta">Patients who start highest fall most, partly through regression to the mean. Compare within a band, not across bands.</p></div>`;
    $("sev-window").addEventListener("change", render);

    const mk = {
      wt: ["Weight", "kg", 1],
      bp: ["Systolic BP", "mmHg", 0],
      ldl: ["LDL cholesterol", "mg/dL", 0],
    };
    $("p4").innerHTML = `
      <div class="card"><h2>HbA1c after starting a treatment at Gini</h2>${meta(c.treatments.map((t) => `${esc(t.label)} ${int(t.new_starts)}`).join(", "), "HbA1c change from the drug's first prescription; only patients started ≥30 days after their first visit", "3, 6 and 12 months after the first prescription")}
      ${table(
        "Treatment HbA1c outcomes",
        [
          "Treatment",
          "Prescribed",
          "Started at Gini",
          ...c.treatments[0].windows.map((w) => `HbA1c change at ${w.window}`),
          "Weight change at 6 months",
        ],
        c.treatments.map(
          (t) =>
            `<tr><th scope="row">${esc(t.label)}</th><td class="n">${int(t.prescribed)}</td><td class="n">${int(t.new_starts)}</td>${t.windows.map((w) => `<td class="n">${w.eligible ? val(w.hba1c.n, `<strong>${sgn(w.hba1c.change_mean)}</strong><span class="nd">n=${int(w.hba1c.n)} of ${int(w.with_baseline)}; ≥0.5 better ${fmt(w.hba1c.improved_05.pct)}%</span>`) : `—<span class="nd">not yet eligible</span>`}</td>`).join("")}<td class="n">${val(t.windows[1].weight.n, `${sgn(t.windows[1].weight.change_mean, 1)} kg<span class="nd">${sgn(t.windows[1].weight.pct_change_mean, 1)}%; n=${int(t.windows[1].weight.n)}</span>`)}</td></tr>`,
        ),
      )}
      ${bars(
        "6-month HbA1c change after starting",
        c.treatments.map((t) => ({
          label: t.label.replace(/ \(.*\)/, ""),
          value: t.windows[1].hba1c.change_mean,
          n: t.windows[1].hba1c.n,
        })),
        { signed: true, digits: 2, unit: " pts" },
      )}
      <p class="meta">Descriptive changes in patients who received the drug, with no comparison group: not drug effects. Weekly insulin was first prescribed in July 2026, so no patient has reached 3 months yet.</p></div>
      <div class="card"><h2>Weight, blood pressure and LDL</h2>${meta("shown per cell", "mean change from baseline (first visit) to the window", "6, 12 and 24 months")}
      ${table(
        "Other markers",
        ["Marker", ...c.markers[0].windows.map((w) => w.window)],
        c.markers.map(
          (m) =>
            `<tr><th scope="row">${mk[m.key][0]}<span class="nd">${mk[m.key][1]}</span></th>${m.windows.map((w) => `<td class="n">${val(w.n, `${fmt(w.baseline_mean, mk[m.key][2])} → ${fmt(w.follow_mean, mk[m.key][2])}<span class="nd">change ${sgn(w.change_mean, 1)} (median ${sgn(w.change_median, 1)}); n=${int(w.n)} of ${int(w.with_baseline)}</span>`)}</td>`).join("")}</tr>`,
        ),
      )}</div>`;

    $("p5").innerHTML = `
      <div class="card"><h2>Follow-up status</h2>${meta(int(c.total), "time since last visit on " + ctx.period.end, "deaths and transfers are not recorded in Scribe")}
      ${bars(
        "Follow-up status",
        c.status.map((s) => ({ label: s.label.replace(/ \(.*/, ""), value: s.pct, n: s.n })),
        { unit: "%" },
      )}
      ${table(
        "Follow-up status",
        ["Status", "Patients"],
        c.status.map((s) => `<tr><th scope="row">${esc(s.label)}</th>${pc(s)}</tr>`),
      )}</div>
      <div class="card"><h2>Engagement by first-visit year</h2>${meta(c.retention.map((r) => `${r.year} ${int(r.enrolled)}`).join(", "), "any visit inside the follow-up window", "3, 6, 12 and 24 months; only patients enrolled long enough ago")}
      ${table(
        "Retention",
        ["First visit year", "Patients", "Visit at 3 months", "6 months", "12 months", "24 months"],
        c.retention.map(
          (r) =>
            `<tr><th scope="row">${r.year}</th><td class="n">${int(r.enrolled)}</td>${r.windows.map((s) => (s.d ? pc(s) : `<td class="n">—<span class="nd">not yet eligible</span></td>`)).join("")}</tr>`,
        ),
      )}
      <p class="meta">April 2024 – February 2025 is a Scribe recording gap (about 70% fewer visits recorded), which depresses the 2023–2024 rows.</p></div>
      <div class="card"><h2>HbA1c follow-up completeness by first-visit year</h2>${meta("eligible patients with a baseline", "share with an HbA1c inside the window", "per window")}
      ${table(
        "Completeness",
        ["First visit year", ...W.map((w) => w.label)],
        c.completeness.map(
          (r) =>
            `<tr><th scope="row">${r.year}</th>${r.windows.map((s) => (s.d ? pc(s) : `<td class="n">—</td>`)).join("")}</tr>`,
        ),
      )}</div>
      <div class="card"><h2>Who has outcome data</h2>${meta("eligible patients with a baseline HbA1c", "baseline profile of patients with and without a follow-up HbA1c", "6 and 12 months")}
      ${table(
        "Measured versus missing",
        [
          "Window / group",
          "Patients",
          "Female",
          "Aged 60+",
          "Mean baseline HbA1c",
          "Median visits",
          "Type 1 / LADA",
        ],
        c.bias.flatMap((b) =>
          [
            ["with follow-up", b.measured],
            ["without", b.missing],
          ].map(
            ([g, p]) =>
              `<tr><th scope="row">${b.window} — ${g}</th><td class="n">${int(p.n)}</td>${pc(p.female)}${pc(p.age60)}<td class="n">${val(p.n, fmt(p.baseline, 2))}</td><td class="n">${val(p.n, fmt(p.visits, 0))}</td>${pc(p.type1)}</tr>`,
          ),
        ),
      )}</div>
      <div class="card"><h2>Latest HbA1c, BP and LDL control</h2>${meta(`${int(c.control.complete.n)} with all three measured (${fmt(c.control.complete.pct)}% of ${int(c.total)})`, "latest values within 12 months before the last visit: HbA1c <7%, BP <130/80, LDL <100", "latest available")}
      ${table(
        "Latest control",
        ["Target", "At target"],
        [
          ["HbA1c below 7%", c.control.hba1c],
          ["BP below 130/80", c.control.bp],
          ["LDL below 100 mg/dL", c.control.ldl],
          ["All three", c.control.all],
        ].map(([k, s]) => `<tr><th scope="row">${k}</th>${pc(s)}</tr>`),
      )}</div>`;
  }

  for (const key of Object.keys(filters)) $(`f-${key}`).addEventListener("change", render);
  $("reset").addEventListener("click", () => {
    for (const key of Object.keys(filters)) $(`f-${key}`).value = "";
    render();
  });
  const tabs = [...document.querySelectorAll("[role=tab]")];
  const show = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    }
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => show(t));
    t.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      const next = tabs[(i + d + tabs.length) % tabs.length];
      next.focus();
      show(next);
    });
  });
  render();
}

const option = (value, label) => `<option value="${value}">${label}</option>`;

export function renderDmDashboard(report, rows) {
  const ctx = {
    period: report.meta.period,
    windows: DM_WINDOWS.map(({ key, label, minDays, maxDays }) => ({
      key,
      label,
      minDays,
      maxDays,
    })),
    severity: SEVERITY_BANDS.map(({ label, min, max }) => ({ label, min, max })),
    sex: DASHBOARD_CODES.sex,
    type: DASHBOARD_CODES.type,
    age: DASHBOARD_CODES.age,
    statusLabels: STATUS_LABELS,
    treatments: DASHBOARD_CODES.treatments,
  };
  const years = [...new Set(rows.map((r) => r.y))].sort();
  const json = JSON.stringify({ ctx, rows }).replace(/</g, "\\u003c");
  const select = (key, label, options) =>
    `<label for="f-${key}">${label}<select id="f-${key}">${option("", "All")}${options}</select></label>`;
  const tabNames = [
    "Population & eligibility",
    "HbA1c outcomes",
    "By baseline severity",
    "Treatments",
    "Engagement & missing data",
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diabetes Outcomes Dashboard</title><style>${css()}</style></head><body>
<header><h1>Gini diabetes outcomes dashboard</h1>
<p class="sub">Reporting period ${report.meta.period.start} to ${report.meta.period.end} · generated ${report.meta.generated_at.slice(0, 10)} from Scribe records</p>
<p class="banner" role="note"><strong>Internal. Draft for clinical review.</strong> This file contains de-identified patient-level records (no names, IDs or dates) so the filters can work. Do not share it outside the clinical team; use the scorecard for public figures. Cells based on fewer than 10 patients are hidden.</p></header>
<div class="filters"><form aria-label="Filters" onsubmit="return false">
${select("y", "First visit year", years.map((y) => option(y, y)).join(""))}
${select("a", "Age at first visit", DASHBOARD_CODES.age.map((a, i) => option(i, a[0])).join("") + option(-1, "Not recorded"))}
${select("s", "Sex", DASHBOARD_CODES.sex.map((s, i) => option(i, s)).join(""))}
${select("sev", "Baseline HbA1c", SEVERITY_BANDS.map((b, i) => option(i, b.label)).join("") + option("none", "No baseline HbA1c"))}
${select("tx", "Treatment (ever prescribed)", DASHBOARD_CODES.treatments.map((t, i) => option(i, t.label)).join("") + option("none", "None of these"))}
${select("t", "Diabetes type", DASHBOARD_CODES.type.map((t, i) => option(i, t)).join(""))}
${select("st", "Follow-up status", STATUS_LABELS.map((s, i) => option(i, s)).join(""))}
${select("nw", "Patient group", option(1, "New to Gini (2025–26)") + option(0, "Returning / earlier patients"))}
${select("cf", "Diabetes confirmation", option("confirmed", "Confirmed (medicine or HbA1c ≥6.5%)") + option(0, "On diabetes medicine") + option(1, "HbA1c ≥6.5% only") + option(2, "Unconfirmed"))}
<button type="button" id="reset">Clear filters</button>
<span class="count" id="count" aria-live="polite"></span>
</form></div>
<nav role="tablist" aria-label="Dashboards">${tabNames.map((t, i) => `<button type="button" role="tab" id="t${i + 1}" aria-controls="p${i + 1}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${i + 1}. ${t}</button>`).join("")}</nav>
<main>${tabNames.map((t, i) => `<section role="tabpanel" id="p${i + 1}" aria-labelledby="t${i + 1}"${i ? " hidden" : ""}></section>`).join("")}</main>
<footer>Definitions: docs/DM_OUTCOMES_METHODOLOGY.md · Baseline = HbA1c closest to first visit (−180 to +14 days) · Windows: 3 m 60–150, 6 m 151–270, 12 m 271–450, 24 m 630–810, 36 m 990–1,170 days · Missing outcomes are never counted as success or failure.</footer>
<script type="application/json" id="dm-data">${json}</script>
<script>${computeDashboard.toString()}\n(${client.toString()})();</script>
</body></html>`;
}
