const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const prettyDate = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const prettyFullDate = (iso) => `${prettyDate(iso)} ${iso.slice(0, 4)}`;

const YEAR_SHADES = {
  light: ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"],
  dark: ["#256abf", "#5598e7", "#86b6ef", "#b7d3f6"],
};
const SHADE_PICK = { 1: [2], 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };

function shadeIndexes(count) {
  if (SHADE_PICK[count]) return SHADE_PICK[count];
  return Array.from({ length: count }, (_, i) => Math.min(3, Math.max(0, i - (count - 4))));
}

function clientModel(model, moleculeLabels) {
  const yearPeriods = model.periods.filter((p) => !p.key.endsWith("-ytd"));
  const shades = shadeIndexes(yearPeriods.length);
  const years = yearPeriods.map((p, i) => ({
    key: p.key,
    year: p.key.slice(0, 4),
    partial: !!p.partial,
    history: !!p.history,
    sub: p.history ? "Scribe import" : p.partial ? `to ${prettyDate(p.to)}` : "full year",
    long: p.history
      ? `${p.key} (Scribe imports, incomplete)`
      : p.partial
        ? `${p.key.slice(0, 4)} (${prettyDate(p.from)} – ${prettyDate(p.to)})`
        : `${p.key} (full year)`,
    shade: shades[i],
  }));
  const current = years[years.length - 1];
  const prevYear = String(Number(current.year) - 1);
  const sameDates = model.periods.find((p) => p.key === `${prevYear}-ytd`) || null;
  return {
    asOf: model.asOf,
    years,
    current,
    compare: sameDates && {
      key: sameDates.key,
      year: prevYear,
      window: `${prettyDate(sameDates.from)} – ${prettyDate(sameDates.to)}`,
    },
    periods: model.periods.map((p) => ({
      key: p.key,
      history: !!p.history,
      label: p.history
        ? `${p.key} (Scribe imports)`
        : p.partial
          ? `${p.key.slice(0, 4)} (${prettyDate(p.from)} – ${prettyDate(p.to)})`
          : `${p.key} (full year)`,
    })),
    data: model.data,
    moleculeLabels,
  };
}

function shadeCss(mode) {
  return YEAR_SHADES[mode].map((hex, i) => `--y${i}:${hex}`).join(";");
}

const TOKENS_LIGHT = `--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#6f6d68;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);--focus:#2a78d6;--chip:#eef4fd;${shadeCss("light")}`;
const TOKENS_DARK = `--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--muted:#a3a198;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--focus:#86b6ef;--chip:#16243a;${shadeCss("dark")}`;

const STYLE = String.raw`
:root{color-scheme:light;${TOKENS_LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${TOKENS_DARK}}}
:root[data-theme="dark"]{color-scheme:dark;${TOKENS_DARK}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1080px;margin:0 auto;padding:24px 16px 48px}
header.top{display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between;align-items:flex-end;margin-bottom:20px}
h1{font-size:22px;line-height:1.25;margin:0 0 4px;font-weight:650}
.sub{margin:0;color:var(--ink-2)}
.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.seg{display:inline-flex;border:1px solid var(--axis);border-radius:8px;padding:2px;background:var(--surface)}
.seg button{font:inherit;border:0;background:transparent;color:var(--ink-2);padding:6px 12px;border-radius:6px;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--surface);font-weight:600}
button:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--ink-2);font-size:13px;margin:0;padding:0;list-style:none}
.legend li{display:flex;align-items:center;gap:6px}
.sw{width:12px;height:12px;border-radius:3px;display:inline-block;flex:0 0 12px}
.s0{background:var(--y0)}.s1{background:var(--y1)}.s2{background:var(--y2)}.s3{background:var(--y3)}
.scope{background:var(--chip);border-radius:8px;padding:10px 14px;color:var(--ink-2);margin:0 0 20px;font-size:13px}
.scope strong{color:var(--ink)}
.hist{font:inherit;font-size:13px;border:1px solid var(--axis);background:var(--surface);color:var(--ink-2);padding:6px 12px;border-radius:8px;cursor:pointer}
.hist[aria-pressed="true"]{border-color:var(--ink);color:var(--ink);font-weight:600}
.warn{border:1px solid var(--axis);border-left:4px solid var(--ink-2);background:var(--surface);border-radius:8px;padding:10px 14px;margin:0 0 20px;font-size:13px;color:var(--ink-2)}
.warn strong{color:var(--ink)}
.warn ul{margin:6px 0 0;padding-left:18px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:28px}
.kpi{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column}
.kpi h3{margin:0 0 10px;font-size:13px;font-weight:600;color:var(--ink)}
.kpi h3 .no{color:var(--muted);font-weight:600;margin-right:4px}
.yrs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.yrs li{display:grid;grid-template-columns:12px auto 1fr;gap:8px;align-items:baseline}
.yrs .sw{align-self:center}
.yrs .y{font-size:13px;color:var(--ink-2);font-variant-numeric:tabular-nums}
.yrs .y small{display:block;font-size:11px;color:var(--muted);line-height:1.2}
.yrs .v{text-align:right;font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.2}
.yrs .v .unit{font-size:12px;font-weight:500;color:var(--ink-2);margin-left:2px}
.kpi .cmp{margin-top:10px;padding-top:8px;border-top:1px solid var(--grid);font-size:12px;color:var(--ink-2);font-variant-numeric:tabular-nums}
.kpi .cmp b{font-weight:600;color:var(--ink)}
.kpi .foot{margin-top:4px;font-size:12px;color:var(--muted)}
.delta{font-weight:600;white-space:nowrap;color:var(--ink)}
section.block{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:18px 20px 8px;margin-bottom:20px}
section.block h2{font-size:17px;margin:0 0 2px;font-weight:650}
section.block .hint{margin:0 0 12px;color:var(--ink-2);font-size:13px}
.row{display:grid;grid-template-columns:minmax(0,280px) minmax(0,1fr) 150px;gap:8px 20px;align-items:center;padding:12px 0;border-top:1px solid var(--grid)}
.row:first-of-type{border-top:0}
.lab .no{display:inline-block;min-width:22px;font-size:12px;font-weight:600;color:var(--muted)}
.lab .t{font-weight:600}
.lab .d{display:block;color:var(--muted);font-size:12px;margin-left:22px}
.bars{display:flex;flex-direction:column;gap:4px}
.bar{display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px;align-items:center;font-size:12px;color:var(--ink-2)}
.bar .yl{line-height:1.15;font-variant-numeric:tabular-nums}
.bar .yl small{display:block;font-size:10px;color:var(--muted)}
.track{display:flex;align-items:center;gap:8px;min-width:0}
.rail{flex:1;min-width:0;height:18px;display:flex;align-items:center}
.fill{height:12px;border-radius:0 4px 4px 0;min-width:2px}
.f0{background:var(--y0)}.f1{background:var(--y1)}.f2{background:var(--y2)}.f3{background:var(--y3)}
.val{flex:0 0 132px;white-space:nowrap;color:var(--ink);font-variant-numeric:tabular-nums}
.val small{color:var(--muted);font-size:12px;margin-left:4px}
.fill.few{opacity:.35}
.few-tag{display:inline-block;margin-left:6px;font-size:11px;color:var(--ink-2);border:1px solid var(--axis);border-radius:4px;padding:0 4px}
.chg{text-align:right;font-variant-numeric:tabular-nums;font-size:13px}
.chg .k{display:block;color:var(--muted);font-size:11px;line-height:1.3}
.chg .pair{display:block;color:var(--muted);font-size:11px}
.note{margin:4px 0 12px;color:var(--muted);font-size:12px}
details.table{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:0 20px;margin-bottom:20px}
details.table summary{cursor:pointer;padding:14px 0;font-weight:650;font-size:15px}
.tw{overflow-x:auto;margin:0 -20px;padding:0 20px 16px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:13px}
th,td{padding:8px 10px;border-bottom:1px solid var(--grid);text-align:right;vertical-align:top}
th:first-child,td:first-child,thead th:nth-child(2){text-align:left}
thead th{font-weight:600;color:var(--ink-2);white-space:nowrap}
tbody th{font-weight:500;text-align:left;min-width:220px}
td small{display:block;color:var(--muted);font-size:11px}
.about{color:var(--ink-2);font-size:13px}
.about h2{font-size:15px;color:var(--ink);margin:0 0 8px}
.about dl{display:grid;grid-template-columns:minmax(0,200px) minmax(0,1fr);gap:6px 16px;margin:0 0 16px}
.about dt{font-weight:600;color:var(--ink)}.about dd{margin:0}
.about ul{margin:0;padding-left:18px}
#tip{position:fixed;pointer-events:none;z-index:10;background:var(--ink);color:var(--surface);padding:6px 10px;border-radius:6px;font-size:12px;line-height:1.4;max-width:280px;opacity:0;transition:opacity .12s}
@media (prefers-reduced-motion:reduce){#tip{transition:none}}
@media (max-width:860px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.row{grid-template-columns:minmax(0,1fr) 130px}.row .lab{grid-column:1/-1}}
@media (max-width:600px){.row{grid-template-columns:minmax(0,1fr)}.chg{text-align:left}.val{flex:0 0 96px;text-align:right}.val small{display:block;margin-left:0}}
@media (max-width:480px){.kpis{grid-template-columns:minmax(0,1fr)}.about dl{grid-template-columns:minmax(0,1fr)}}
@media print{body{background:#fff}main{padding:0}.controls .seg{display:none}#tip{display:none}
section.block,.kpi,details.table{break-inside:avoid;border-color:#ccc}}
`;

const SCRIPT = String.raw`
const M = JSON.parse(document.getElementById("opd-data").textContent);
const fmt = (n) => n == null ? "—" : Number(n).toLocaleString("en-IN");
const fmt1 = (n) => n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
let setKey = "all";
let showHistory = false;
const YEARS = () => M.years.filter((y) => showHistory || !y.history);
const PERIODS = () => M.periods.filter((p) => showHistory || !p.history);
const S = (periodKey) => M.data[periodKey][setKey];
const FEW = 100;
const C = M.current;
const P = M.compare;

const SECTIONS = [
  { title: "Treatment", hint: "Share of patients seen in the year who were prescribed the drug that year.", rows: [
    { no: "5", t: "On a GLP-1", key: "glp1", d: "of patients seen" },
    { no: "5", t: "On a GLP-1 — diabetic patients", key: "glp1Diabetic", d: "of diabetic patients seen" },
    { no: "5", t: "On a GLP-1 — CAD patients", key: "glp1Cad", d: "of patients with CAD in the latest diagnosis list" },
    { no: "5", t: "GLP-1 prescribed or advised", key: "glp1OrAdvised", d: "prescribed, or advised / planned in the visit note (including patients who deferred or declined), of patients seen" },
    { no: "6", t: "On Awiqli", key: "icodec", d: "of patients seen" },
    { no: "7", t: "On both GLP-1 and Awiqli", key: "both", d: "of patients seen" } ] },
  { title: "Weight and control", hint: "Latest diagnosis or reading in the year. Only patients who have that diagnosis list or test are counted.", rows: [
    { no: "8", t: "Dual adiposity — diagnosis", key: "dualDx", d: "of patients with a diagnosis list" },
    { no: "8", t: "Dual adiposity — measured", key: "dualMeasured", d: "BMI ≥ 25 and waist ≥ 90 cm (men) / ≥ 80 cm (women), of patients with both measured" },
    { no: "9", t: "HbA1c below 7", key: "hba1c", d: "of patients with an HbA1c" },
    { no: "10", t: "HbA1c < 7, systolic BP < 140, LDL < 100", key: "allThree", d: "all three in control, of patients with all three measured" } ] },
  { title: "Complications", hint: "Written in the diagnosis at the patient's latest visit of the year.", rows: [
    { no: "11", t: "DKD", key: "dkd", d: "diabetic kidney disease, of diabetic patients with a diagnosis list" },
    { no: "11", t: "CAD", key: "cad", d: "coronary artery disease, of patients with a diagnosis list" },
    { no: "11", t: "DKD or CAD", key: "dkdOrCad", d: "of patients with a diagnosis list" } ],
    note: () => YEARS().map((y) => { const u = S(y.key).kidneyUnclear; return u.n ? y.year + ": " + fmt(u.n) : null; }).filter(Boolean).join(" · ") + " diabetic patients had a kidney entry with no usable stage; they are not counted as DKD." },
];

function signed(r, suffix) {
  const arrow = r > 0 ? "▲" : r < 0 ? "▼" : "■";
  return '<span class="delta"><span aria-hidden="true">' + arrow + "</span> " + (r > 0 ? "+" : r < 0 ? "−" : "") + fmt1(Math.abs(r)) + suffix + "</span>";
}

function changeCount(cur, base) {
  if (cur == null || !base) return '<span class="delta">—</span>';
  return signed(Math.round(((cur - base) / base) * 1000) / 10, "%");
}
function changePts(cur, base) {
  if (cur == null || base == null) return '<span class="delta">—</span>';
  return signed(Math.round((cur - base) * 10) / 10, " pts");
}
function changeYrs(cur, base) {
  if (cur == null || base == null) return '<span class="delta">—</span>';
  return signed(Math.round((cur - base) * 10) / 10, " yrs");
}

function yearList(valueOf, unit) {
  return '<ul class="yrs">' + YEARS().map((y) =>
    '<li><span class="sw s' + y.shade + '" aria-hidden="true"></span><span class="y">' + y.year + "<small>" + y.sub + "</small></span>" +
    '<span class="v">' + valueOf(S(y.key)) + (unit ? '<span class="unit">' + unit + "</span>" : "") + "</span></li>").join("") + "</ul>";
}

function sameDatesLine(valueOf, change) {
  if (!P) return "";
  const b = S(P.key), c = S(C.key);
  return '<div class="cmp">Same dates (' + P.window + "): <b>" + valueOf(b) + "</b> in " + P.year + " → <b>" + valueOf(c) + "</b> in " + C.year + " " + change(b, c) + "</div>";
}

function renderKpis() {
  const tiles = [
    { no: "1", t: "Total visits", v: (s) => fmt(s.visits), ch: (b, c) => changeCount(c.visits, b.visits) },
    { no: "2", t: "Unique patients", v: (s) => fmt(s.patients), ch: (b, c) => changeCount(c.patients, b.patients) },
    { no: "3", t: "Average age", unit: "yrs", v: (s) => fmt1(s.age.mean), ch: (b, c) => changeYrs(c.age.mean, b.age.mean),
      foot: () => "Median " + YEARS().map((y) => y.year + ": " + S(y.key).age.median).join(" · ") + " yrs" },
    { no: "4", t: "Average age at diabetes onset", unit: "yrs", v: (s) => fmt1(s.aoo.mean), ch: (b, c) => changeYrs(c.aoo.mean, b.aoo.mean),
      foot: () => "Type 2 only: " + YEARS().map((y) => y.year + " " + fmt1(S(y.key).aooT2.mean)).join(" · ") + " yrs. Onset known for " +
        YEARS().map((y) => y.year + ": " + fmt(S(y.key).aoo.n) + " of " + fmt(S(y.key).aoo.of)).join(" · ") +
        " diabetic patients." },
  ];
  document.getElementById("kpis").innerHTML = tiles.map((k) =>
    '<article class="kpi"><h3><span class="no">' + k.no + "</span>" + k.t + "</h3>" + yearList(k.v, k.unit) +
    sameDatesLine((s) => k.v(s) + (k.unit ? " " + k.unit : ""), k.ch) + (k.foot ? '<div class="foot">' + k.foot() + "</div>" : "") + "</article>").join("");
}

function barLine(y, share, max, title) {
  const w = max ? Math.max(0, (share.pct / max) * 100) : 0;
  const few = share.of > 0 && share.of < FEW;
  const tip = title + " — " + y.long + ": " + fmt(share.n) + " of " + fmt(share.of) + " patients (" + fmt1(share.pct) + "%)" + (few ? ". Fewer than " + FEW + " patients, so this percentage is unreliable." : "");
  return '<div class="bar"><span class="yl">' + y.year + "<small>" + y.sub + '</small></span><div class="track" tabindex="0" data-tip="' + attr(tip) + '" aria-label="' + attr(tip) + '">' +
    '<div class="rail"><div class="fill f' + y.shade + (few ? " few" : "") + '" style="width:' + w.toFixed(2) + '%"></div></div>' +
    '<span class="val">' + fmt1(share.pct) + "%<small>" + fmt(share.n) + " of " + fmt(share.of) + "</small>" + (few ? '<span class="few-tag">few patients</span>' : "") + "</span></div></div>";
}

function changeCell(baseShare, curShare) {
  if (!P) return '<div class="chg"></div>';
  return '<div class="chg"><span class="k">' + C.year + " vs same dates " + P.year + "</span>" + changePts(curShare.pct, baseShare.pct) +
    '<span class="pair">' + fmt1(baseShare.pct) + "% → " + fmt1(curShare.pct) + "%</span></div>";
}

function rowHtml(no, title, desc, shareOf, scale) {
  const bars = YEARS().map((y) => barLine(y, shareOf(S(y.key)), scale, title)).join("");
  const chg = P ? changeCell(shareOf(S(P.key)), shareOf(S(C.key))) : '<div class="chg"></div>';
  return '<div class="row"><div class="lab"><span class="no">' + no + '</span><span class="t">' + title + "</span>" +
    (desc ? '<span class="d">' + desc + "</span>" : "") + '</div><div class="bars">' + bars + "</div>" + chg + "</div>";
}

function niceScale(values, step) {
  const max = Math.max(...values, 1);
  return Math.min(100, Math.ceil(max / step) * step);
}

function renderSections() {
  let html = "";
  for (const sec of SECTIONS) {
    const scale = niceScale(sec.rows.flatMap((r) => YEARS().map((y) => S(y.key)[r.key].pct || 0)), 10);
    html += '<section class="block" aria-labelledby="h-' + sec.title + '"><h2 id="h-' + sec.title + '">' + sec.title + '</h2><p class="hint">' + sec.hint + "</p>";
    for (const r of sec.rows) html += rowHtml(r.no, r.t, r.d, (s) => s[r.key], scale);
    const note = sec.note ? sec.note() : "";
    html += (note ? '<p class="note">' + note + "</p>" : "") + "</section>";
  }
  document.getElementById("sections").innerHTML = html;
}

function renderDrugs() {
  const find = (s, k) => s.molecules.find((m) => m.molecule === k) || { n: 0, of: s.patients, pct: 0 };
  const keys = [...new Set(YEARS().flatMap((y) => S(y.key).molecules.map((m) => m.molecule)))].filter((k) => k !== "glp1_unspecified");
  keys.sort((x, y) => find(S(C.key), y).pct - find(S(C.key), x).pct);
  const scale = niceScale(keys.flatMap((k) => YEARS().map((y) => find(S(y.key), k).pct)), 5);
  let html = '<section class="block" aria-labelledby="h-drugs"><h2 id="h-drugs">GLP-1 by drug</h2><p class="hint">Share of patients seen in the year. A patient on two GLP-1s is counted under each.</p>';
  for (const k of keys) html += rowHtml("", M.moleculeLabels[k] || k, "", (s) => find(s, k), scale);
  document.getElementById("drugs").innerHTML = html + "</section>";
}

function renderTable() {
  const avg = (d) => d.n ? fmt1(d.mean) + " yrs<small>median " + d.median + " · n=" + fmt(d.n) + " of " + fmt(d.of) + "</small>" : "—";
  const share = (s) => s.of ? fmt1(s.pct) + "%<small>" + fmt(s.n) + " of " + fmt(s.of) + "</small>" : "—";
  const rows = [
    ["1", "Total visits", (s) => fmt(s.visits)],
    ["2", "Unique patients", (s) => fmt(s.patients)],
    ["3", "Average age", (s) => avg(s.age)],
    ["4", "Average age at diabetes onset — all diabetes", (s) => avg(s.aoo)],
    ["4", "Average age at diabetes onset — Type 2", (s) => avg(s.aooT2)],
    ["5", "On a GLP-1", (s) => share(s.glp1)],
    ["5", "On a GLP-1 — diabetic patients", (s) => share(s.glp1Diabetic)],
    ["5", "On a GLP-1 — CAD patients", (s) => share(s.glp1Cad)],
    ["5", "GLP-1 prescribed or advised", (s) => share(s.glp1OrAdvised)],
    ["6", "On Awiqli", (s) => share(s.icodec)],
    ["7", "On both", (s) => share(s.both)],
    ["8", "Dual adiposity — diagnosis", (s) => share(s.dualDx)],
    ["8", "Dual adiposity — measured", (s) => share(s.dualMeasured)],
    ["9", "HbA1c below 7", (s) => share(s.hba1c)],
    ["10", "HbA1c < 7, systolic BP < 140, LDL < 100", (s) => share(s.allThree)],
    ["11", "DKD", (s) => share(s.dkd)],
    ["11", "Kidney status unclear (not counted as DKD)", (s) => share(s.kidneyUnclear)],
    ["11", "CAD", (s) => share(s.cad)],
    ["11", "DKD or CAD", (s) => share(s.dkdOrCad)],
  ];
  const head = '<tr><th scope="col">#</th><th scope="col">Figure</th>' + PERIODS().map((p) => '<th scope="col">' + p.label + "</th>").join("") + "</tr>";
  const body = rows.map(([no, t, f]) => "<tr><td>" + no + '</td><th scope="row">' + t + "</th>" + PERIODS().map((p) => "<td>" + f(M.data[p.key][setKey]) + "</td>").join("") + "</tr>").join("");
  document.getElementById("table-body").innerHTML = "<thead>" + head + "</thead><tbody>" + body + "</tbody>";
  document.getElementById("table-set").textContent = setKey === "all" ? "all patients seen" : "patients seen 3 or more times in the year";
}

function renderHeader() {
  document.getElementById("legend").innerHTML = YEARS().map((y) => '<li><span class="sw s' + y.shade + '" aria-hidden="true"></span>' + y.long + "</li>").join("");
  document.getElementById("years-text").textContent = YEARS().map((y) => y.year + " (" + y.sub + ")").join(", ");
  document.getElementById("hist-note").hidden = !showHistory;
}

function render() {
  renderHeader();
  document.getElementById("scope-set").textContent = setKey === "all"
    ? "All patients seen in person in the OPD, year by year."
    : "Only patients seen 3 or more times within the same year.";
  renderKpis(); renderSections(); renderDrugs(); renderTable();
}

const histBtn = document.getElementById("hist");
if (histBtn) histBtn.addEventListener("click", () => {
  showHistory = !showHistory;
  histBtn.setAttribute("aria-pressed", String(showHistory));
  histBtn.textContent = showHistory ? "Hide 2023–2024" : "Show 2023–2024 (Scribe imports)";
  render();
});

for (const btn of document.querySelectorAll(".seg button")) {
  btn.addEventListener("click", () => {
    setKey = btn.dataset.set;
    for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-pressed", String(b === btn));
    render();
  });
}

const tip = document.getElementById("tip");
function showTip(el, x, y) { tip.textContent = el.dataset.tip; tip.style.opacity = "1"; tip.style.left = Math.min(x + 12, innerWidth - 290) + "px"; tip.style.top = (y + 14) + "px"; }
function hideTip() { tip.style.opacity = "0"; }
document.addEventListener("mousemove", (e) => { const el = e.target.closest("[data-tip]"); if (el) showTip(el, e.clientX, e.clientY); else hideTip(); });
document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip]"); if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left, r.bottom - 10); } });
document.addEventListener("focusout", hideTip);
window.addEventListener("beforeprint", () => { document.querySelector("details.table").open = true; });
render();
`;

export function renderOpdYoyHtml(model, { moleculeLabels = {} } = {}) {
  const m = clientModel(model, moleculeLabels);
  const json = JSON.stringify(m).replace(/</g, "\\u003c");
  const hasHistory = m.years.some((y) => y.history);
  const compareText = m.compare
    ? `${escapeHtml(m.current.year)} is not over yet, so every change is measured against the same dates in ${escapeHtml(m.compare.year)} (${escapeHtml(m.compare.window)}), not against the full ${escapeHtml(m.compare.year)} year.`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OPD year by year</title>
<style>${STYLE}</style></head><body>
<main>
<header class="top">
  <div>
    <h1>OPD year by year</h1>
    <p class="sub"><span id="years-text"></span> · data as at ${escapeHtml(prettyFullDate(m.asOf))}</p>
  </div>
  <div class="controls">
    <div class="seg" role="group" aria-label="Which patients">
      <button type="button" data-set="all" aria-pressed="true">All patients</button>
      <button type="button" data-set="setB" aria-pressed="false">Seen 3+ times</button>
    </div>
    ${hasHistory ? '<button type="button" class="hist" id="hist" aria-pressed="false">Show 2023–2024 (Scribe imports)</button>' : ""}
    <ul class="legend" aria-label="Years" id="legend"></ul>
  </div>
</header>
<p class="scope"><strong id="scope-set"></strong> ${compareText} In-person OPD visits only; tele and lab-only visits are not counted.</p>
<div class="warn" id="hist-note" hidden><strong>2023 and 2024 are shown as stored in Scribe and are incomplete — use them as a rough reference only, not for comparison.</strong>
<ul>
<li>They come from HealthRay notes bulk-imported into Scribe in March 2026, not from appointments. Visit dates are approximate, and the import often stored one visit twice a few days apart, so imported dates for the same patient within 3 days are counted as one visit. Visit counts for these years are estimates (in the 2025 overlap this method came out about 9% below the real count); patient counts are reliable.</li>
<li>2024 is much thinner than 2023 (for example HbA1c for about 900 patients against about 5,600 in 2025), which reflects a gap in the import, not fewer patients.</li>
<li>BP was rarely recorded in 2023 and waist in both years, so "all three in control" and measured dual adiposity cover very few patients.</li>
<li>Diagnoses are read from the raw diagnosis text of the imported notes; medicines only where a medicine row was recorded for that year. No per-visit prescriptions exist for these years.</li>
</ul></div>
<div class="kpis" id="kpis"></div>
<div id="sections"></div>
<div id="drugs"></div>
<details class="table"><summary>All figures in a table — <span id="table-set"></span></summary>
<div class="tw"><table id="table-body"></table></div></details>
<section class="block about" aria-labelledby="h-about">
<h2 id="h-about">How to read these numbers</h2>
<dl>
<dt>Year by year</dt><dd>Each year is shown on its own: completed years in full, the current year up to the data date.</dd>
<dt>Change</dt><dd>Measured against the same dates in the previous year. For counts, the percentage change; for shares, the difference in percentage points (pts).</dd>
<dt>Percentages</dt><dd>A bar marked "few patients" (faded) rests on fewer than 100 patients and should not be read as a trend. Each percentage shows how many patients out of how many. Lab and diagnosis figures count only patients who had that test or a diagnosis list in the year, so untested patients are not counted as "not in control".</dd>
<dt>GLP-1</dt><dd>Tirzepatide (Mounjaro, Yurpeak), semaglutide injection (Wegovy, Semanext, Semasize, Semalix, Sembolic, Wyntide, Blupen, Semafull and other brands), oral semaglutide (Rybelsus), liraglutide, dulaglutide, exenatide and lixisenatide + glargine (Soliqua).</dd>
<dt>DKD</dt><dd>Diabetic patients whose kidney stage shows eGFR G3a or worse, or albumin A2 or worse. G1A1 and G2A1 are normal and not counted, and an entry the doctor marked absent (NEPHROPATHY−) is not counted.</dd>
<dt>CAD</dt><dd>The doctor's CAD+ / CAD− in the visit note; CAD with PTCA, CABG or stent counts as present (a "CAD− POST PTCA" dash is read as a separator, not as absent).</dd>
<dt>Age at onset</dt><dd>The AOO written in the diabetes diagnosis, or the age at the visit minus the years since diagnosis.</dd>
</dl>
<h2>Limits</h2>
<ul>
<li>Records start on 1 Jan 2025, so earlier years are not available.</li>
<li>Awiqli was first prescribed in 2026.</li>
<li>Fewer 2025 visits have their prescription stored, so 2025 GLP-1 numbers may be slightly low.</li>
<li>Waist was measured for fewer patients in 2025, so the measured dual adiposity figure covers fewer patients that year.</li>
<li>These are routine-care observations; they do not show cause and effect.</li>
</ul>
</section>
</main>
<div id="tip" role="presentation"></div>
<script type="application/json" id="opd-data">${json}</script>
<script>${SCRIPT}</script>
</body></html>`;
}
