import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { usePaidAtReception } from "../../../queries/hooks/useBilling";
import { fromPaise } from "../format";
import { claimText } from "./lineText";
import LoadingCard from "./LoadingCard";

const clock = (value) =>
  value
    ? new Date(value).toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : null;

const totalText = (data) =>
  [
    data.total_paid > 0 && `${fromPaise(data.total_paid)} cleared`,
    data.total_claimed > 0 && `${fromPaise(data.total_claimed)} claimed`,
  ]
    .filter(Boolean)
    .join(" and ") || "Settled";

const orderKey = (orders) =>
  orders.map((order) => `${order.lab_order_id}:${order.paid}:${order.claim?.amount ?? 0}`).join();

export default function PaidAtReception({ bill, onChanged }) {
  const { data, isLoading } = usePaidAtReception(bill.visit_id, bill.version);
  const orders = data?.orders ?? [];
  const seen = useRef(null);
  const key = orderKey(orders);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!data) return;
    const before = seen.current;
    seen.current = key;
    if (before !== null && before !== key && bill.status === "draft") onChanged?.();
  }, [data, key]);

  if (isLoading) {
    return (
      <LoadingCard title="Cleared at reception" text="Checking reception payments…" lines={1} />
    );
  }
  if (!orders.length) return null;

  const payments = `${orders.length} order${orders.length === 1 ? "" : "s"}`;

  return (
    <section className="bc-card bc-paid" aria-label="Paid at reception">
      <button
        type="button"
        className="bc-paid__head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <CheckCircle2 size={18} aria-hidden="true" className="bc-paid__tick" />
        <span className="bc-paid__title">Cleared at reception</span>
        <span className="bc-paid__meta">
          · {data.total_paid > 0 ? fromPaise(data.total_paid) : totalText(data)} · {payments}
        </span>
        {open ? (
          <ChevronUp size={18} aria-hidden="true" className="bc-paid__chev" />
        ) : (
          <ChevronDown size={18} aria-hidden="true" className="bc-paid__chev" />
        )}
      </button>
      {open && (
        <>
          <ul className="bc-paid__list">
            {orders.map((order) => (
              <li key={order.lab_order_id} className="bc-paid__row">
                <span className="bc-paid__body">
                  <span className="bc-paid__tests">{order.tests.join(", ")}</span>
                  <span className="bc-paid__how">
                    {[
                      order.paid > 0 && `${fromPaise(order.paid)} · Cleared on Payments tab`,
                      order.claim && claimText(order.claim, fromPaise),
                      clock(order.paid_at),
                      order.cleared_by && `by ${order.cleared_by}`,
                    ]
                      .filter(Boolean)
                      .join(" • ")}
                  </span>
                  {order.still_due > 0 && (
                    <span className="bc-paid__due">
                      {fromPaise(order.still_due)} still due at reception
                    </span>
                  )}
                </span>
                <span
                  className={order.still_due > 0 ? "bc-pill bc-pill--due" : "bc-pill bc-pill--paid"}
                >
                  {order.still_due > 0
                    ? "Part cleared"
                    : order.claim && !order.paid
                      ? "Claimed"
                      : "Cleared"}
                </span>
              </li>
            ))}
          </ul>
          <p className="bc-paid__note">
            {totalText(data)} on the Payments tab — not part of this bill
            {data.still_due > 0 && ` · ${fromPaise(data.still_due)} still due at reception`}
          </p>
        </>
      )}
    </section>
  );
}
