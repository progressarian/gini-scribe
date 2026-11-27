export const PARAM_TABLE_CSS = `
.rx-summary-block--tests .rx-summary-tests{margin-top:0;padding-top:0;border-top:0}
.rx-body>.rx-section-title:first-child{margin-top:0}
.rx-vlist{display:grid;grid-template-columns:minmax(150px,max-content) 1fr;column-gap:24px;row-gap:2px;margin:0;font-size:var(--fs-meta);line-height:1.35}
.rx-vlist dt{color:var(--ink2);margin:0}
.rx-vlist dd{margin:0;color:var(--ink);font-weight:600}
.rx-vlist .unit{color:var(--ink3);font-weight:500;margin-left:3px}
.rx-vlist .asof{color:var(--ink3);font-weight:400;margin-left:6px;font-size:var(--fs-label)}
.rx-vlist div{display:contents;break-inside:avoid}
`;

const dmy = (ymd) => {
  const [y, m, d] = String(ymd || "").split("-");
  return y && m && d ? `${d}-${m}-${y}` : String(ymd || "");
};

export function vitalsListHtml(table, escape) {
  const columns = Array.isArray(table?.columns) ? table.columns : [];
  const items = (Array.isArray(table?.rows) ? table.rows : [])
    .map((r) => {
      const values = r.values || [];
      for (let i = values.length - 1; i >= 0; i -= 1) {
        const v = values[i];
        if (v != null && v !== "") return { r, v, column: columns[i] };
      }
      return null;
    })
    .filter(Boolean);
  if (!items.length) return "";
  const body = items
    .map(({ r, v, column }) => {
      const unit = r.unit ? `<span class="unit">(${escape(r.unit)})</span>` : "";
      const asOf =
        column && !column.today ? `<span class="asof">(${escape(dmy(column.date))})</span>` : "";
      return `<div><dt>${escape(r.label)}${unit}</dt><dd>${escape(String(v))}${asOf}</dd></div>`;
    })
    .join("");
  return `<div class="rx-section-title">Vitals</div>
<dl class="rx-vlist">${body}</dl>`;
}
