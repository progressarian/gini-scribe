import { changeOf, count, money, rangeLabel } from "../dashboard/dashboardText";

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

export default function StaffTiles({ data }) {
  const total = data.total;
  const hand = data.handover;
  const change = changeOf(total.collected, data.previous.collected);
  const outside = (total.money.healthray ?? 0) + (total.money.prepaid ?? 0);
  const cleared = Object.values(total.cleared).reduce((sum, value) => sum + value, 0);
  return (
    <section className="bdash-tiles" aria-label="Headline figures">
      <Tile
        label="Collected"
        value={money(total.collected)}
        hint="Money taken at the counter less refunds paid back, by payment date. Includes bills marked Paid in HealthRay; excludes money moved from a deposit."
      >
        <span className="bdash-tile__change">
          {count(total.payments)} {total.payments === 1 ? "payment" : "payments"}
          {change && change.direction
            ? ` · ${change.direction > 0 ? "▲ Up" : "▼ Down"}${change.text ? ` ${change.text}` : ""} from ${money(data.previous.collected)} in ${rangeLabel(data.previous.from, data.previous.to)}`
            : ""}
        </span>
        {outside ? (
          <span className="bdash-tile__change">
            of which {money(outside)} marked paid in HealthRay or earlier
          </span>
        ) : null}
      </Tile>
      <Tile
        label="Cash to hand over"
        value={money(hand.closed_cash + hand.open_cash)}
        hint="Closed shifts: the cash counted at close (or expected, if not counted). Open shifts: what should be in the drawer now."
      >
        <span className="bdash-tile__change">{money(hand.closed_cash)} from closed shifts</span>
        <span className="bdash-tile__change">
          {money(hand.open_cash)} still in {count(hand.open_shifts)} open{" "}
          {hand.open_shifts === 1 ? "shift" : "shifts"}
        </span>
      </Tile>
      <Tile
        label="Cash difference"
        value={
          hand.short.count || hand.over.count
            ? `${hand.short.count + hand.over.count} ${hand.short.count + hand.over.count === 1 ? "shift" : "shifts"}`
            : "None"
        }
        hint="Counted cash against expected cash, for shifts closed in this period. Short and over are shown separately, never netted."
      >
        <span className="bdash-tile__change">
          Short:{" "}
          {hand.short.count
            ? `${money(Math.abs(hand.short.amount))} on ${hand.short.count}`
            : "none"}
        </span>
        <span className="bdash-tile__change">
          Over: {hand.over.count ? `${money(hand.over.amount)} on ${hand.over.count}` : "none"}
        </span>
        {hand.not_counted ? (
          <span className="bdash-tile__change">{hand.not_counted} closed without a count</span>
        ) : null}
      </Tile>
      <Tile
        label="Patients served"
        value={count(total.patients)}
        hint="Different patients who paid at the counter in this period."
      >
        <span className="bdash-tile__change">{count(total.check_ins)} check-ins</span>
      </Tile>
      <Tile label="Bills finalised" value={count(total.finalised)}>
        <span className="bdash-tile__change">
          {total.cancelled ? `${count(total.cancelled)} cancelled` : "None cancelled"}
        </span>
      </Tile>
      <Tile label="Refunds paid back" value={money(total.refunded)}>
        <span className="bdash-tile__change">
          {count(total.refunds)} {total.refunds === 1 ? "refund" : "refunds"}
        </span>
      </Tile>
      <Tile
        label="Manual discounts"
        value={money(total.manual_discount_amount)}
        hint="Discounts typed in by hand at the counter, by the person who gave them."
      >
        <span className="bdash-tile__change">{count(total.manual_discounts)} given</span>
      </Tile>
      <Tile
        label="Cleared in HealthRay"
        value={money(cleared)}
        hint="Test payments cleared on the Payments tab and consultant fee changes settled — the money is taken in HealthRay, not in the Scribe drawer."
      >
        <span className="bdash-tile__change">
          {count(total.cleared_count)} cleared, not in any drawer
        </span>
      </Tile>
    </section>
  );
}
