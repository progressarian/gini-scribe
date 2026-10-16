export const PARAM_TABLE_CSS = `
.rx-ptable{width:100%;border-collapse:collapse;margin:0;font-size:var(--fs-meta);line-height:1.3;break-inside:avoid}
.rx-ptable th,.rx-ptable td{border:1px solid var(--bd);padding:2px 6px;text-align:center;white-space:nowrap}
.rx-ptable thead th{background:var(--bg);font-weight:700;color:var(--ink2);font-size:var(--fs-label)}
.rx-ptable thead th.today{color:var(--ink);background:#e8f0fb}
.rx-ptable tbody th{text-align:left;font-weight:600;color:var(--ink);background:#fbfcfd}
.rx-ptable .unit{color:var(--ink3);font-weight:500;font-size:var(--fs-label);margin-left:3px}
.rx-ptable td{color:var(--ink2)}
.rx-ptable td.today{font-weight:700;color:var(--ink);background:#f5f9ff}
.rx-ptable td.empty{color:#b6c0cc}
.rx-summary-block--tests .rx-summary-tests{margin-top:0;padding-top:0;border-top:0}
.rx-body>.rx-section-title:first-child{margin-top:0}
`;

const shortDate = (ymd) => {
  const t = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return String(ymd || "");
  return t.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
};

export function parameterTableHtml(table, escape) {
  const columns = Array.isArray(table?.columns) ? table.columns : [];
  const rows = (Array.isArray(table?.rows) ? table.rows : []).filter(
    (r) => r.show || (r.values || []).some((v) => v != null && v !== ""),
  );
  if (!columns.length || !rows.length) return "";
  const head = columns
    .map((c, i) => {
      const last = i === columns.length - 1;
      const label = c.today
        ? `Today (${shortDate(c.date)})`
        : last
          ? `Last visit (${shortDate(c.date)})`
          : shortDate(c.date);
      return `<th class="${c.today || last ? "today" : ""}">${escape(label)}</th>`;
    })
    .join("");
  const body = rows
    .map((r) => {
      const cells = columns
        .map((c, i) => {
          const v = r.values?.[i];
          const empty = v == null || v === "";
          return `<td class="${[c.today || i === columns.length - 1 ? "today" : "", empty ? "empty" : ""].filter(Boolean).join(" ")}">${empty ? "—" : escape(String(v))}</td>`;
        })
        .join("");
      const unit = r.unit ? `<span class="unit">(${escape(r.unit)})</span>` : "";
      return `<tr><th>${escape(r.label)}${unit}</th>${cells}</tr>`;
    })
    .join("");
  return `<div class="rx-section-title rx-ptable-title">Vitals &amp; biomarkers</div>
<table class="rx-ptable"><thead><tr><th>Parameter</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
