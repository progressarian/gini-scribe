import { useRef, useState } from "react";
import { useReceptionQueue, useClearPayment } from "../../queries/hooks/useGiniflowReception";
import "../../styles/giniflow-station.css";

const AVATAR_COLOURS = ["#374151", "#1e3a5f", "#14532d", "#7c2d12", "#7f1d1d", "#b45309"];

const initials = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

const avatarColour = (id) => AVATAR_COLOURS[Math.abs(id ?? 0) % AVATAR_COLOURS.length];

const SAMPLE_LABEL = {
  ordered: "Lab notified",
  payment_pending: "Lab notified",
  paid: "Lab collecting",
  sample_collected: "Sample taken",
  processing: "In analyzer",
  results_ready: "Results ready",
  uploaded: "Results uploaded",
};

const rupees = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      })
    : "—";

const sinceLabel = (iso) => {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
};

function OrderCard({ order, onClear, pending }) {
  return (
    <div className="test-order-card">
      <div className="toc-head">
        <div className="toc-av" style={{ background: avatarColour(order.patientId) }}>
          {initials(order.name)}
        </div>
        <div className="toc-who">
          <div className="toc-name">
            {order.name} <span className="badge b-ink">{order.fileNo}</span>
          </div>
          <div className="toc-meta">
            {order.age}
            {(order.sex || "")[0] || ""}
            {order.orderedBy ? ` · Ordered by ${order.orderedBy}` : ""} at {clock(order.orderedAt)}{" "}
            · Urgency: <strong>{order.urgency}</strong>
          </div>
        </div>
        <div className="sp sp-pay">⚠ Payment pending</div>
      </div>

      <div className="toc-body">
        {order.tests.map((t) => (
          <span className="toc-test" key={t.name}>
            {t.name} <span className="tp">{rupees(t.price)}</span>
          </span>
        ))}
        {order.tests.length === 0 && <span className="toc-test">No tests listed</span>}
      </div>

      <div className="toc-total">
        <span className="amt">Total: {rupees(order.total)}</span>
        <span className="badge b-ink">
          {order.tests.length} test{order.tests.length === 1 ? "" : "s"}
        </span>
        <span style={{ fontSize: 10, color: "var(--ink3)" }}>Insurance: None</span>
      </div>

      <div className="toc-foot">
        <button
          className="st-btn st-btn-grn"
          disabled={pending}
          onClick={() => onClear(order, "paid")}
        >
          ✓ Payment received — notify lab
        </button>
        <button
          className="st-btn st-btn-blu"
          disabled={pending}
          onClick={() => onClear(order, "insurance_claim")}
        >
          Insurance claim
        </button>
        <span className="toc-age">{sinceLabel(order.orderedAt)}</span>
      </div>
    </div>
  );
}

export default function ReceptionStationPage() {
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);
  const { data, isLoading } = useReceptionQueue();
  const clearPayment = useClearPayment();

  const pending = data?.pending || [];
  const awaitingSample = data?.awaitingSample || [];
  const cleared = data?.cleared || [];

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };

  const onClear = (order, method) =>
    clearPayment.mutate(
      { orderId: order.orderId, method },
      {
        onSuccess: (r) =>
          showToast(
            r.alreadySettled
              ? `${order.name} was already cleared — nothing charged twice`
              : method === "insurance_claim"
                ? `${order.name} sent as an insurance claim — lab notified`
                : `✓ ${rupees(order.total)} received from ${order.name} — lab can collect now`,
          ),
        onError: (e) =>
          showToast(e?.response?.data?.error || "Could not clear this — nothing was changed"),
      },
    );

  return (
    <div className="gf">
      <div className="rail">
        <div className="rl">Reception</div>
        <div className="rsep" />
        <span className="rail-title">
          {new Date().toLocaleDateString("en-IN", {
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </span>
        <div className="rr">
          <a className="rbtn" href="/giniflow/stations">
            ← Stations
          </a>
        </div>
      </div>

      <div className="scroll">
        <div className="inner">
          <div className="stats">
            <div className="stat">
              <div className="sv" style={{ color: "var(--red)" }}>
                {pending.length}
              </div>
              <div>
                <div className="sl">Payment pending</div>
                <div className="ss">tests ordered today</div>
              </div>
            </div>
            <div className="stat">
              <div className="sv" style={{ color: "var(--tl)" }}>
                {awaitingSample.length}
              </div>
              <div>
                <div className="sl">Sample pending</div>
                <div className="ss">payment done, lab waiting</div>
              </div>
            </div>
            <div className="stat">
              <div className="sv" style={{ color: "var(--grn)" }}>
                {cleared.length}
              </div>
              <div>
                <div className="sl">Cleared</div>
                <div className="ss">lab collecting</div>
              </div>
            </div>
          </div>

          <div className="workflow-note">
            <span className="wn-ico">⚡</span>
            <span>
              <strong>Workflow:</strong> MO orders tests → appears here with payment pending → you
              collect payment → triggers lab sample collection task automatically.
            </span>
          </div>

          {/* Shown only while the catalogue still holds the mockup's figures —
              it disappears by itself once the hospital's tariff is loaded.
              Reception must not collect against a placeholder unknowingly. */}
          {data?.pricesArePlaceholders && (
            <div className="price-note">
              ⚠ Prices are placeholders from the design mockup, not the hospital's tariff — check
              the amount before collecting.
            </div>
          )}

          <div>
            <div className="grp-lbl" style={{ marginBottom: 7 }}>
              🔴 Payment pending — collect and clear
            </div>
            {isLoading && <div className="empty-note">Loading…</div>}
            {!isLoading && pending.length === 0 && (
              <div className="empty-note">Nothing waiting for payment.</div>
            )}
            {pending.map((order) => (
              <OrderCard
                key={order.orderId}
                order={order}
                onClear={onClear}
                pending={clearPayment.isPending}
              />
            ))}
          </div>

          {cleared.length > 0 && (
            <div>
              <div className="grp-lbl" style={{ marginBottom: 7 }}>
                ✅ Cleared today — lab notified
              </div>
              {cleared.slice(0, 8).map((o) => (
                <div className="test-order-card is-cleared" key={o.orderId}>
                  <div className="toc-head">
                    <div className="toc-cleared">
                      {o.name} ·{" "}
                      <span className="tc-detail">
                        {o.paymentStatus === "insurance_claim"
                          ? "Insurance claim"
                          : `Paid ${rupees(o.total)}`}{" "}
                        · {SAMPLE_LABEL[o.sampleStatus] || o.sampleStatus.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="sp sp-paid">✓ Cleared {clock(o.paidAt)}</div>
                  </div>
                </div>
              ))}
              {cleared.length > 8 && (
                <div className="more-note">+ {cleared.length - 8} more cleared today</div>
              )}
            </div>
          )}
        </div>
      </div>

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
