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

function Line({ label, value }) {
  return (
    <div className="sd-line">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const sumOf = (amounts = {}, keys) => keys.reduce((sum, key) => sum + (amounts[key] ?? 0), 0);
const NON_CASH = ["card", "upi_bharatpe", "upi_paytm", "upi_other", "upi_unknown", "neft"];

export default function StaffTiles({ data }) {
  const total = data.total;
  const hand = data.handover;
  const change = changeOf(total.collected, data.previous.collected);
  const healthray = sumOf(total.taken, ["healthray", "prepaid"]);
  const cleared = Object.values(total.cleared ?? {}).reduce((sum, value) => sum + value, 0);
  const closedCount = hand.short.count + hand.over.count + hand.matched + hand.not_counted;
  return (
    <section className="bdash-tiles" aria-label="Headline figures">
      <Tile
        label="Collected"
        value={money(total.collected)}
        hint="Money taken less refunds paid back, on the day it was taken. Matches Collected on the billing dashboard."
      >
        <Line label="Cash taken" value={money(total.taken?.cash ?? 0)} />
        <Line label="Card / UPI / NEFT" value={money(sumOf(total.taken, NON_CASH))} />
        <Line label="Marked paid in HealthRay" value={money(healthray)} />
        <Line
          label="Refunds paid back"
          value={total.refunded ? `−${money(total.refunded)}` : money(0)}
        />
        {change && change.direction ? (
          <span className="bdash-tile__change">
            {change.direction > 0 ? "▲ Up" : "▼ Down"}
            {change.text ? ` ${change.text}` : ""} from {money(data.previous.collected)} in{" "}
            {rangeLabel(data.previous.from, data.previous.to)}
          </span>
        ) : null}
      </Tile>
      <Tile
        label="Cash handover"
        value={
          hand.open_shifts && !closedCount
            ? `${count(hand.open_shifts)} open`
            : `${count(closedCount)} closed`
        }
        hint="Shifts closed in these dates and how their counted cash compared with what was expected."
      >
        <Line label="Cash counted at close" value={money(hand.closed_cash)} />
        <Line
          label="Short"
          value={
            hand.short.count
              ? `${money(Math.abs(hand.short.amount))} (${hand.short.count})`
              : "None"
          }
        />
        <Line
          label="Over"
          value={hand.over.count ? `${money(hand.over.amount)} (${hand.over.count})` : "None"}
        />
        {hand.open_shifts ? (
          <span className="bdash-tile__change sd-warn">
            {count(hand.open_shifts)} {hand.open_shifts === 1 ? "shift" : "shifts"} still open
            {hand.includes_today ? ` · ${money(hand.open_cash)} in the drawers now` : ""}
          </span>
        ) : null}
      </Tile>
      <Tile
        label="Patients and bills"
        value={`${count(total.patients)} ${total.patients === 1 ? "patient" : "patients"}`}
      >
        <Line label="Bills finalised" value={count(total.finalised)} />
        {total.closed_by_cancel ? (
          <Line label="Closed by test cancel" value={count(total.closed_by_cancel)} />
        ) : null}
        <Line label="Check-ins" value={count(total.check_ins)} />
        <Line label="Payments taken" value={count(total.payments)} />
        {total.cancelled ? <Line label="Bills cancelled" value={count(total.cancelled)} /> : null}
      </Tile>
      <Tile label="Refunds paid back" value={money(total.refunded)}>
        <Line label="Refunds" value={count(total.refunds)} />
        <Line
          label="Manual discounts given"
          value={`${money(total.manual_discount_amount)} (${count(total.manual_discounts)})`}
        />
        {cleared ? (
          <span
            className="bdash-tile__change"
            title="Test payments cleared on the Payments tab and consultant fee changes settled. The money was taken in HealthRay, so it is not in Collected or any drawer."
          >
            Also cleared in HealthRay: {money(cleared)} ({count(total.cleared_count)})
          </span>
        ) : null}
      </Tile>
    </section>
  );
}
