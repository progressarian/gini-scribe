import { changeOf, count, money, rangeLabel } from "./dashboardText";

const ARROW = { 1: "▲", 0: "■", [-1]: "▼" };
const WORD = { 1: "up", 0: "same", [-1]: "down" };

function Change({ current, previous, points, against }) {
  const change = changeOf(current, previous, { points });
  if (!change) return <span className="bdash-tile__change">Nothing in {against} to compare</span>;
  return (
    <span className="bdash-tile__change">
      <span aria-hidden="true">{ARROW[change.direction]}</span>{" "}
      <span className="sr-only">{WORD[change.direction]}</span>
      {change.direction === 0 ? "Same as" : `${change.text} vs`} {against}
    </span>
  );
}

function Tile({ label, value, hint, children }) {
  return (
    <div className="bdash-tile" role="group" aria-label={label}>
      <div className="bdash-tile__label" title={hint}>
        {label}
      </div>
      <div className="bdash-tile__value">{value}</div>
      {children}
    </div>
  );
}

export default function KpiTiles({ data }) {
  const now = data.kpis.current;
  const was = data.kpis.previous;
  const against = rangeLabel(data.previous_range.from, data.previous_range.to);
  const compare = (key, extra = {}) => (
    <Change current={now[key]} previous={was[key]} against={against} {...extra} />
  );
  return (
    <section className="bdash-tiles" aria-label="Headline figures">
      <Tile
        label="Net revenue"
        value={money(now.net_revenue)}
        hint="What patients owe on final bills dated in this period, less credit notes. CGHS claims are not included."
      >
        {compare("net_revenue")}
      </Tile>
      <Tile
        label="Collected"
        value={money(now.collected)}
        hint="Money taken in this period by every mode, less refunds paid back — whichever bill it was for"
      >
        {compare("collected")}
      </Tile>
      <Tile
        label="Pending"
        value={money(now.pending)}
        hint="Net revenue − collected. Negative means more came in than was billed: earlier dues paid, or extra kept as deposit."
      >
        <span className="bdash-tile__change">
          {now.pending < 0 ? "More collected than billed" : "Billed but not yet collected"}
        </span>
      </Tile>
      <Tile
        label="Discount"
        value={money(now.discount)}
        hint="All discounts on final bills, less discounts credited back"
      >
        <span className="bdash-tile__change">
          {now.discount_pct === null ? "No charges" : `${now.discount_pct}% of charges`}
        </span>
        {compare("discount_pct", { points: true })}
      </Tile>
      <Tile label="Bills" value={count(now.bills)} hint="Final bills, not counting credit notes">
        <span className="bdash-tile__change">
          {now.credit_notes
            ? `${count(now.credit_notes)} credit ${now.credit_notes === 1 ? "note" : "notes"}`
            : "No credit notes"}
        </span>
        {compare("bills")}
      </Tile>
      <Tile
        label="Average bill"
        value={now.avg_bill === null ? "—" : money(now.avg_bill)}
        hint="Net revenue ÷ bills"
      >
        {compare("avg_bill")}
      </Tile>
      <Tile
        label="Revenue per patient"
        value={now.rev_per_patient === null ? "—" : money(now.rev_per_patient)}
        hint="Net revenue ÷ patients billed"
      >
        <span className="bdash-tile__change">
          {count(now.patients)} {now.patients === 1 ? "patient" : "patients"}
        </span>
        {compare("rev_per_patient")}
      </Tile>
      <Tile
        label="Dues still owed"
        value={money(data.dues.outstanding)}
        hint="Outstanding on final bills up to the end date, as of now — the Dues register's figure"
      >
        <span className="bdash-tile__change">
          {count(data.dues.bills)} {data.dues.bills === 1 ? "bill" : "bills"}, as of now
        </span>
      </Tile>
    </section>
  );
}
