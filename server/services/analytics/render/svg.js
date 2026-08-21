export function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function tip(title, lines = []) {
  const body = lines
    .filter((l) => l != null && l !== "")
    .map((l) => `<s>${esc(l)}</s>`)
    .join("");
  return `data-tt="<b>${esc(title)}</b>${body}"`;
}

function niceMax(value) {
  if (!(value > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export function barChart(
  rows,
  {
    width = 900,
    barHeight = 22,
    gap = 8,
    valueFormat,
    label = "value",
    color = "var(--series-1)",
    labelWidth = 250,
  } = {},
) {
  if (!rows.length) return "";
  const maxChars = Math.floor((labelWidth - 18) / 6.4);
  const valueWidth = 96;
  const plotWidth = width - labelWidth - valueWidth;
  const height = rows.length * (barHeight + gap) + gap;
  const max = niceMax(Math.max(...rows.map((r) => Math.abs(r.value) || 0)));
  const fmt = valueFormat || ((v) => v);

  const bars = rows
    .map((row, i) => {
      const y = gap + i * (barHeight + gap);
      const w = max ? Math.max(2, (Math.abs(row.value) / max) * plotWidth) : 2;
      const fill = row.color || color;
      const hover = tip(row.label, [`${label}: ${fmt(row.value)}`, row.note]);
      return `<g class="mark" ${hover}>
      <rect x="0" y="${y}" width="${width}" height="${barHeight}" fill="transparent"/>
      <text x="${labelWidth - 10}" y="${y + barHeight / 2}" text-anchor="end" dominant-baseline="central" font-size="12.5" fill="var(--ink-secondary)">${esc(clamp(row.label, maxChars))}</text>
      <rect x="${labelWidth}" y="${y}" width="${w.toFixed(1)}" height="${barHeight}" rx="4" fill="${fill}"/>
      <text x="${labelWidth + w + 10}" y="${y + barHeight / 2}" dominant-baseline="central" font-size="12.5" font-weight="600" fill="var(--ink)">${esc(fmt(row.value))}</text>
    </g>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
    <line x1="${labelWidth}" y1="0" x2="${labelWidth}" y2="${height}" stroke="var(--axis)" stroke-width="1"/>
    ${bars}
  </svg>`;
}

export function stackedShareChart(
  rows,
  segments,
  { width = 900, barHeight = 20, gap = 10, label = "distribution" } = {},
) {
  if (!rows.length) return "";
  const labelWidth = 210;
  const trailWidth = 74;
  const plotWidth = width - labelWidth - trailWidth;
  const height = rows.length * (barHeight + gap) + gap;

  const bars = rows
    .map((row, i) => {
      const y = gap + i * (barHeight + gap);
      const total = segments.reduce((sum, s) => sum + (Number(row[s.key]) || 0), 0);
      if (!total) return "";
      let x = labelWidth;
      const parts = segments
        .map((s, idx) => {
          const v = Number(row[s.key]) || 0;
          if (!v) return "";
          const raw = (v / total) * plotWidth;
          const w = Math.max(0, raw - (idx < segments.length - 1 ? 2 : 0));
          const share = ((v / total) * 100).toFixed(1);
          const rect = `<rect class="mark" ${tip(`${row.label} — ${s.label}`, [`${Number(v).toLocaleString()} patients`, `${share}% of ${Number(total).toLocaleString()}`])} x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${barHeight}" rx="${w > 8 ? 4 : 1}" fill="${s.color}"/>`;
          const inner =
            w > 40
              ? `<text pointer-events="none" x="${(x + w / 2).toFixed(1)}" y="${y + barHeight / 2}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="600" fill="#ffffff">${share}%</text>`
              : "";
          x += raw;
          return rect + inner;
        })
        .join("");
      return `<g>
      <text x="${labelWidth - 10}" y="${y + barHeight / 2}" text-anchor="end" dominant-baseline="central" font-size="12.5" fill="var(--ink-secondary)">${esc(row.label)}</text>
      ${parts}
      <text x="${labelWidth + plotWidth + 10}" y="${y + barHeight / 2}" dominant-baseline="central" font-size="11.5" fill="var(--muted)">n=${total}</text>
    </g>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${bars}</svg>`;
}

export function lineChart(
  series,
  {
    width = 900,
    height = 260,
    xLabels,
    yLabel = "",
    label = "trend",
    yMin,
    yMax,
    valueFormat,
  } = {},
) {
  const padL = 54;
  const padR = 16;
  const padT = 14;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const allValues = series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => v != null);
  if (!allValues.length) return "";
  const lo = yMin != null ? yMin : Math.min(0, Math.min(...allValues));
  const hi = yMax != null ? yMax : niceMax(Math.max(...allValues));
  const n = Math.max(...series.map((s) => s.points.length));
  const fmt = valueFormat || ((v) => Number(v).toLocaleString());

  const xAt = (i) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v) => padT + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  const ticks = 4;
  const grid = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = lo + ((hi - lo) / ticks) * i;
    const y = yAt(v);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 8}" y="${y.toFixed(1)}" text-anchor="end" dominant-baseline="central" font-size="11" fill="var(--muted)">${esc(fmt(Math.round(v * 10) / 10))}</text>`;
  }).join("");

  const xTicks = (xLabels || [])
    .map((lbl, i) => {
      const every = Math.ceil((xLabels.length || 1) / 8);
      const isLast = i === xLabels.length - 1;
      if (i % every !== 0 && !isLast) return "";
      const anchor = isLast ? "end" : i === 0 ? "start" : "middle";
      const x = isLast ? width : i === 0 ? padL - 4 : xAt(i);
      return `<text x="${Number(x).toFixed(1)}" y="${height - padB + 16}" text-anchor="${anchor}" font-size="11" fill="var(--muted)">${esc(lbl)}</text>`;
    })
    .join("");

  const paths = series
    .map((s) => {
      const pts = s.points
        .map((p, i) => (p.y == null ? null : `${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`))
        .filter(Boolean);
      if (!pts.length) return "";
      const last = s.points.length - 1;
      const dot =
        s.points[last] && s.points[last].y != null
          ? `<circle cx="${xAt(last).toFixed(1)}" cy="${yAt(s.points[last].y).toFixed(1)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`
          : "";
      const step = n <= 1 ? plotW : plotW / (n - 1);
      const hover = s.points
        .map((p, i) => {
          if (p.y == null) return "";
          const cx = xAt(i).toFixed(1);
          const cy = yAt(p.y).toFixed(1);
          const band = Math.max(10, step);
          const bx = (xAt(i) - band / 2).toFixed(1);
          return `<g class="pt" ${tip(xLabels ? xLabels[i] : `Point ${i + 1}`, [`${s.name}: ${fmt(p.y)}`, p.note])}>
        <rect x="${bx}" y="${padT}" width="${band.toFixed(1)}" height="${plotH}" fill="transparent"/>
        <line class="pt__x" x1="${cx}" y1="${padT}" x2="${cx}" y2="${padT + plotH}" stroke="var(--ink-secondary)" stroke-width="1"/>
        <circle class="pt__dot" cx="${cx}" cy="${cy}" r="5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>
      </g>`;
        })
        .join("");
      return `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dot}${hover}`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
    ${grid}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${height - padB}" stroke="var(--axis)" stroke-width="1"/>
    ${xTicks}
    ${paths}
    ${yLabel ? `<text x="4" y="10" font-size="11" fill="var(--muted)">${esc(yLabel)}</text>` : ""}
  </svg>`;
}

export function columnChart(
  bins,
  {
    width = 900,
    height = 220,
    label = "distribution",
    color = "var(--series-1)",
    xTickEvery = 2,
    valueSuffix = "",
  } = {},
) {
  if (!bins.length) return "";
  const padL = 46;
  const padR = 12;
  const padT = 12;
  const padB = 32;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const max = niceMax(Math.max(...bins.map((b) => b.count)));
  const bw = plotW / bins.length;

  const bars = bins
    .map((b, i) => {
      const h = max ? (b.count / max) * plotH : 0;
      const x = padL + i * bw;
      const y = padT + plotH - h;
      return `<g class="mark" ${tip(`${b.from}${valueSuffix} to ${b.to}${valueSuffix}`, [`${Number(b.count).toLocaleString()} patients`])}>
      <rect x="${(x + 1).toFixed(1)}" y="${padT}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${plotH}" fill="transparent"/>
      <rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="3" fill="${color}"/>
    </g>`;
    })
    .join("");

  const ticks = Array.from({ length: 4 }, (_, i) => {
    const v = (max / 3) * i;
    const y = padT + plotH - (v / (max || 1)) * plotH;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 8}" y="${y.toFixed(1)}" text-anchor="end" dominant-baseline="central" font-size="11" fill="var(--muted)">${Math.round(v).toLocaleString()}</text>`;
  }).join("");

  const xLabels = bins
    .map((b, i) =>
      i % xTickEvery === 0
        ? `<text x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${height - padB + 15}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${b.from}</text>`
        : "",
    )
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
    ${ticks}
    ${bars}
    <line x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
    ${xLabels}
  </svg>`;
}

export function groupedBarChart(
  groups,
  series,
  { width = 900, rowHeight = 26, label = "comparison", valueFormat } = {},
) {
  if (!groups.length) return "";
  const labelWidth = 190;
  const valueWidth = 70;
  const plotWidth = width - labelWidth - valueWidth;
  const barH = Math.max(9, (rowHeight - 6) / series.length);
  const height = groups.length * (rowHeight + 12) + 10;
  const values = groups.flatMap((g) => series.map((s) => Math.abs(Number(g[s.key]) || 0)));
  const max = niceMax(Math.max(...values));
  const fmt = valueFormat || ((v) => v);

  const rows = groups
    .map((g, i) => {
      const top = 6 + i * (rowHeight + 12);
      const bars = series
        .map((s, j) => {
          const v = Number(g[s.key]);
          if (v == null || isNaN(v)) return "";
          const w = max ? Math.max(2, (Math.abs(v) / max) * plotWidth) : 2;
          const y = top + j * (barH + 2);
          return `<g class="mark" ${tip(`${g.label} — ${s.label}`, [String(fmt(v))])}>
          <rect x="${labelWidth}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="${s.color}"/>
          <text x="${labelWidth + w + 8}" y="${(y + barH / 2).toFixed(1)}" dominant-baseline="central" font-size="11" fill="var(--ink-secondary)">${esc(fmt(v))}</text>
        </g>`;
        })
        .join("");
      return `<g>
      <text x="${labelWidth - 10}" y="${(top + (rowHeight - 6) / 2).toFixed(1)}" text-anchor="end" dominant-baseline="central" font-size="12.5" fill="var(--ink-secondary)">${esc(g.label)}</text>
      ${bars}
    </g>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
    <line x1="${labelWidth}" y1="0" x2="${labelWidth}" y2="${height}" stroke="var(--axis)" stroke-width="1"/>
    ${rows}
  </svg>`;
}

export function funnelChart(steps, { width = 900, label = "funnel", labelWidth = 300 } = {}) {
  if (!steps.length) return "";
  const rowH = 40;
  const gap = 10;
  const maxChars = Math.floor((labelWidth - 18) / 6.4);
  const plotWidth = width - labelWidth - 90;
  const height = steps.length * (rowH + gap) + gap;
  const max = steps[0].patients || 1;
  const shades = ["var(--ord-5)", "var(--ord-4)", "var(--ord-3)", "var(--ord-2)", "var(--ord-1)"];

  const rows = steps
    .map((s, i) => {
      const y = gap + i * (rowH + gap);
      const w = Math.max(3, (s.patients / max) * plotWidth);
      const drop =
        i > 0 && steps[i - 1].patients
          ? `<text x="${labelWidth - 10}" y="${y + rowH / 2 + 13}" text-anchor="end" font-size="11" fill="var(--status-critical)">-${(steps[i - 1].patients - s.patients).toLocaleString()} lost</text>`
          : "";
      const lost = i > 0 ? steps[i - 1].patients - s.patients : null;
      return `<g class="mark" ${tip(s.step, [
        `${Number(s.patients).toLocaleString()} patients`,
        `${s.share_pct}% of the starting group`,
        lost != null ? `${Number(lost).toLocaleString()} lost at this step` : null,
      ])}>
      <rect x="0" y="${y}" width="${width}" height="${rowH}" fill="transparent"/>
      <text x="${labelWidth - 10}" y="${y + rowH / 2 - 4}" text-anchor="end" dominant-baseline="central" font-size="12.5" fill="var(--ink-secondary)">${esc(clamp(s.step, maxChars))}</text>
      ${drop}
      <rect x="${labelWidth}" y="${y}" width="${w.toFixed(1)}" height="${rowH}" rx="4" fill="${shades[Math.min(i, shades.length - 1)]}"/>
      <text x="${labelWidth + w + 10}" y="${y + rowH / 2}" dominant-baseline="central" font-size="13" font-weight="600" fill="var(--ink)">${s.patients.toLocaleString()}</text>
      <text x="${labelWidth + w + 10}" y="${y + rowH / 2 + 15}" dominant-baseline="central" font-size="11" fill="var(--muted)">${s.share_pct}%</text>
    </g>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${rows}</svg>`;
}

function clamp(text, maxChars) {
  const s = String(text == null ? "" : text);
  return s.length <= maxChars ? s : `${s.slice(0, maxChars - 1)}…`;
}

export function dotPlot(
  rows,
  { width = 900, label = "sensitivity", valueFormat, zeroLine = true, labelWidth = 320 } = {},
) {
  if (!rows.length) return "";
  const maxChars = Math.floor((labelWidth - 24) / 6.6);
  const padR = 70;
  const plotWidth = width - labelWidth - padR;
  const rowH = 24;
  const height = rows.length * rowH + 20;
  const values = rows.map((r) => r.value).filter((v) => v != null);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const xAt = (v) => labelWidth + ((v - lo) / span) * plotWidth;
  const fmt = valueFormat || ((v) => v);

  const zero =
    zeroLine && lo <= 0 && hi >= 0
      ? `<line x1="${xAt(0).toFixed(1)}" y1="6" x2="${xAt(0).toFixed(1)}" y2="${height - 10}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3"/>`
      : "";

  const dots = rows
    .map((r, i) => {
      const y = 16 + i * rowH;
      if (r.value == null) return "";
      const cx = xAt(r.value);
      const color = r.color || "var(--series-1)";
      return `<g class="mark" ${tip(r.label, [`${fmt(r.value)}`, `paired n = ${Number(r.n).toLocaleString()}`])}>
      <rect x="0" y="${y - rowH / 2}" width="${width}" height="${rowH}" fill="transparent"/>
      <text x="${labelWidth - 12}" y="${y}" text-anchor="end" dominant-baseline="central" font-size="12" fill="var(--ink-secondary)">${esc(clamp(r.label, maxChars))}</text>
      <line x1="${xAt(0).toFixed(1)}" y1="${y}" x2="${cx.toFixed(1)}" y2="${y}" stroke="${color}" stroke-width="2" opacity="0.35"/>
      <circle cx="${cx.toFixed(1)}" cy="${y}" r="5.5" fill="${color}" stroke="var(--surface)" stroke-width="2"/>
      <text x="${width - padR + 6}" y="${y}" dominant-baseline="central" font-size="11.5" font-weight="600" fill="var(--ink)">${esc(fmt(r.value))}</text>
      <text x="${width - padR + 6}" y="${y + 11}" dominant-baseline="central" font-size="10" fill="var(--muted)">n=${r.n}</text>
    </g>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${zero}${dots}</svg>`;
}

export function legend(items) {
  return `<div class="legend">${items
    .map((i) => `<span><i style="background:${i.color}"></i>${esc(i.label)}</span>`)
    .join("")}</div>`;
}
