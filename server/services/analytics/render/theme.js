export const PALETTE = {
  light: {
    surface: "#fcfcfb",
    plane: "#f9f9f7",
    ink: "#0b0b0b",
    inkSecondary: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    border: "rgba(11,11,11,0.10)",
    series: ["#2a78d6", "#eb6834", "#1baf7a"],
    good: "#0ca30c",
    warning: "#fab219",
    serious: "#ec835a",
    critical: "#d03b3b",
    successText: "#006300",
    ordinal: ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"],
  },
  dark: {
    surface: "#1a1a19",
    plane: "#0d0d0d",
    ink: "#ffffff",
    inkSecondary: "#c3c2b7",
    muted: "#898781",
    grid: "#2c2c2a",
    axis: "#383835",
    border: "rgba(255,255,255,0.10)",
    series: ["#3987e5", "#d95926", "#199e70"],
    good: "#0ca30c",
    warning: "#fab219",
    serious: "#ec835a",
    critical: "#d03b3b",
    successText: "#0ca30c",
    ordinal: ["#184f95", "#256abf", "#2a78d6", "#5598e7", "#86b6ef"],
  },
};

export const CONTROL_COLORS = {
  good: "var(--status-good)",
  warn: "var(--status-warning)",
  bad: "var(--status-critical)",
  unknown: "var(--muted)",
};

export const TRAJECTORY_COLORS = {
  better: "var(--status-good)",
  stable: "var(--muted)",
  worse: "var(--status-critical)",
  unknown: "var(--grid)",
};

export function buildCss() {
  const l = PALETTE.light;
  const d = PALETTE.dark;
  const vars = (p) => `
    --surface: ${p.surface};
    --plane: ${p.plane};
    --ink: ${p.ink};
    --ink-secondary: ${p.inkSecondary};
    --muted: ${p.muted};
    --grid: ${p.grid};
    --axis: ${p.axis};
    --border: ${p.border};
    --series-1: ${p.series[0]};
    --series-2: ${p.series[1]};
    --series-3: ${p.series[2]};
    --status-good: ${p.good};
    --status-warning: ${p.warning};
    --status-serious: ${p.serious};
    --status-critical: ${p.critical};
    --success-text: ${p.successText};
    --ord-1: ${p.ordinal[0]};
    --ord-2: ${p.ordinal[1]};
    --ord-3: ${p.ordinal[2]};
    --ord-4: ${p.ordinal[3]};
    --ord-5: ${p.ordinal[4]};`;

  return `
:root { color-scheme: light; ${vars(l)} }
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) { color-scheme: dark; ${vars(d)} }
}
:root[data-theme="dark"] { color-scheme: dark; ${vars(d)} }

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--plane);
  color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.55;
}
.wrap { max-width: 1380px; margin: 0 auto; padding: 32px 20px 96px; }
header.report { border-bottom: 1px solid var(--border); padding-bottom: 24px; margin-bottom: 8px; }
header.report h1 { font-size: 30px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.02em; }
.sub { color: var(--ink-secondary); font-size: 14px; margin: 0; }
nav.toc { position: sticky; top: 0; background: var(--plane); padding: 12px 0; border-bottom: 1px solid var(--border); z-index: 5; margin-bottom: 28px; }
nav.toc ul { list-style: none; display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0; padding: 0; }
nav.toc a { color: var(--ink-secondary); text-decoration: none; font-size: 13px; padding: 3px 8px; border-radius: 6px; border: 1px solid transparent; }
nav.toc a:hover, nav.toc a:focus-visible { color: var(--ink); border-color: var(--border); background: var(--surface); }
section { margin: 0 0 52px; scroll-margin-top: 64px; }
section > h2 { font-size: 21px; margin: 0 0 4px; letter-spacing: -0.01em; }
section > .lede { color: var(--ink-secondary); margin: 0 0 20px; font-size: 14px; max-width: 78ch; }
h3 { font-size: 15px; margin: 28px 0 10px; letter-spacing: 0.01em; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; margin-bottom: 18px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 22px; }
.kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.kpi .v { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; display: block; }
.kpi .k { font-size: 12px; color: var(--ink-secondary); display: block; margin-top: 2px; }
.kpi .n { font-size: 11px; color: var(--muted); display: block; margin-top: 4px; }
.tablewrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); position: relative; }
.tablewrap.is-scrollable { background-image: linear-gradient(to left, rgba(0,0,0,0.10), rgba(0,0,0,0)); background-size: 22px 100%; background-repeat: no-repeat; background-position: right center; background-attachment: local; }
table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 8px 12px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th:first-child, td:first-child {
  text-align: left; white-space: normal; min-width: 170px; max-width: 320px;
  position: sticky; left: 0; z-index: 1; background: var(--surface);
  box-shadow: 1px 0 0 var(--grid);
}
thead th { color: var(--ink-secondary); font-weight: 600; font-size: 12px; position: sticky; top: 0; background: var(--surface); white-space: normal; max-width: 128px; vertical-align: bottom; line-height: 1.3; }
thead th:first-child { z-index: 2; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: var(--plane); }
tbody tr:hover td:first-child { background: var(--plane); }
.scrollnote { font-size: 11.5px; color: var(--muted); margin: 6px 0 0; }
figure { margin: 0 0 8px; }
figcaption { font-size: 12px; color: var(--ink-secondary); margin-bottom: 10px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--ink-secondary); margin: 8px 0 4px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.notes { margin: 12px 0 0; padding: 12px 16px; background: var(--plane); border-left: 3px solid var(--axis); border-radius: 0 8px 8px 0; }
.notes ul { margin: 0; padding-left: 18px; }
.notes li { font-size: 12.5px; color: var(--ink-secondary); margin-bottom: 5px; }
.notes li:last-child { margin-bottom: 0; }
.caveat { border-left-color: var(--status-warning); }
.pill { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--ink-secondary); }
.pos { color: var(--success-text); }
.neg { color: var(--status-critical); }
svg { display: block; max-width: 100%; height: auto; }
svg text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.small { font-size: 12px; color: var(--muted); }

.tt {
  position: absolute;
  z-index: 50;
  pointer-events: none;
  max-width: 320px;
  padding: 8px 11px;
  border-radius: 9px;
  background: var(--ink);
  color: var(--surface);
  font-size: 12.5px;
  line-height: 1.45;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
}
.tt b { display: block; font-size: 12.5px; margin-bottom: 3px; }
.tt s { display: block; text-decoration: none; opacity: 0.82; font-variant-numeric: tabular-nums; }
.tt[hidden] { display: none; }

[data-tt] { cursor: default; }
.mark { transition: opacity 0.08s ease; }
.mark:hover { opacity: 0.82; }
.pt .pt__dot, .pt .pt__x { opacity: 0; transition: opacity 0.08s ease; }
.pt:hover .pt__dot { opacity: 1; }
.pt:hover .pt__x { opacity: 0.45; }

@media print { nav.toc { display: none; } .card, .kpi, .tablewrap { break-inside: avoid; } .tt { display: none; } }
@media (prefers-reduced-motion: reduce) { .mark, .pt .pt__dot, .pt .pt__x { transition: none; } }
`;
}

export function buildJs() {
  return `
(function () {
  var tip = document.createElement("div");
  tip.className = "tt";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.appendChild(tip);

  var active = null;

  function place(x, y) {
    var pad = 16;
    var box = tip.getBoundingClientRect();
    var left = x + pad;
    var top = y + pad;
    if (left + box.width > window.innerWidth - 10) left = x - box.width - pad;
    if (left < 6) left = 6;
    if (top + box.height > window.innerHeight - 10) top = y - box.height - pad;
    if (top < 6) top = 6;
    tip.style.left = left + window.scrollX + "px";
    tip.style.top = top + window.scrollY + "px";
  }

  function hide() {
    tip.hidden = true;
    active = null;
  }

  function track(e) {
    var target = e.target;
    var el = target && target.closest ? target.closest("[data-tt]") : null;
    if (!el) {
      if (!tip.hidden) hide();
      return;
    }
    if (el !== active) {
      active = el;
      tip.innerHTML = el.getAttribute("data-tt");
    }
    tip.hidden = false;
    place(e.clientX, e.clientY);
  }

  document.addEventListener("mouseover", track);
  document.addEventListener("mousemove", track);
  document.addEventListener("mouseleave", hide);
  window.addEventListener("blur", hide);

  function markScrollers() {
    var wraps = document.querySelectorAll(".tablewrap");
    for (var i = 0; i < wraps.length; i++) {
      var w = wraps[i];
      var scrollable = w.scrollWidth > w.clientWidth + 1;
      w.classList.toggle("is-scrollable", scrollable);
      var note = w.nextElementSibling;
      var isNote = note && note.classList && note.classList.contains("scrollnote");
      if (scrollable && !isNote) {
        var p = document.createElement("p");
        p.className = "scrollnote";
        p.textContent = "Scroll sideways to see the remaining columns. The first column stays fixed.";
        w.parentNode.insertBefore(p, w.nextSibling);
      } else if (!scrollable && isNote) {
        note.parentNode.removeChild(note);
      }
    }
  }

  markScrollers();
  window.addEventListener("resize", markScrollers);
})();
`;
}
