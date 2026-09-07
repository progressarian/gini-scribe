import { useEffect, useRef, useState } from "react";
import {
  useReceptionQueue,
  useClearPayment,
  useArrivals,
  useArrivalAction,
  useWalkInSearch,
  useCheckInWalkIn,
} from "../../queries/hooks/useGiniflowReception";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import LiveBadge from "../../components/giniflow/LiveBadge";
import "../../styles/giniflow-station.css";
import useAuthStore from "../../stores/authStore";
import { printRxHref } from "../../queries/hooks/useGiniflowRx";
import { hasCapability, CAPABILITIES } from "../../../shared/permissions";
import StationNotice from "../../components/giniflow/StationNotice";

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

const identity = (p) =>
  `${p.age ?? "—"}${(p.sex || "")[0] || ""} · ${p.fileNo || "no file no"}${
    p.phone ? ` · ${p.phone}` : ""
  }`;

const CHIP = {
  pending: { cls: "sp-pay", text: "⚠ Payment pending" },
  part_paid: { cls: "sp-process", text: "◐ Part paid — balance due" },
  insurance_claim: { cls: "sp-sample", text: "💰 Claim submitted — awaiting approval" },
};

const CLAIM_LINE = {
  submitted: "awaiting approval",
  approved: "approved",
  rejected: "rejected by the insurer",
};

function OrderCard({ order, onClear, pending, actorId }) {
  const claimed = order.claimState === "submitted";
  const [form, setForm] = useState(null);
  const ownClaim = claimed && actorId != null && order.claimSubmittedBy === actorId;
  const chip = CHIP[order.paymentStatus] || CHIP.pending;
  const due = Number(order.outstanding ?? order.total);
  // The cash button offers what can actually be collected — with a claim
  // standing, the balance is with the insurer, not at the counter.
  const collectible = Number(order.collectible ?? due);

  const field = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const send = (method, body) => {
    onClear(order, method, body);
    setForm(null);
  };
  const submit = (e) => {
    e.preventDefault();
    if (form.kind === "claim") {
      send("insurance_claim", {
        insurer: form.insurer,
        policyNo: form.policyNo || undefined,
        amountClaimed: form.amountClaimed ? Number(form.amountClaimed) : undefined,
      });
    } else if (form.kind === "split") {
      send("split", {
        amountPaid: Number(form.amountPaid),
        amountClaimed: Number(form.amountClaimed),
        insurer: form.insurer,
        policyNo: form.policyNo || undefined,
      });
    } else {
      send("claim_rejected", { note: form.note || undefined });
    }
  };

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
        <div className={`sp ${chip.cls}`}>{chip.text}</div>
      </div>

      <div className="toc-body">
        {order.tests.map((t) => (
          <span className="toc-test" key={t.name}>
            {t.name} <span className="tp">{rupees(t.price)}</span>
          </span>
        ))}
        {order.tests.length === 0 && <span className="toc-test">No tests listed</span>}
      </div>

      {/* What has actually been collected against what was quoted. The
          outstanding figure is the one the desk acts on, so it is the one that
          turns red. */}
      <div className="toc-total">
        <span className="amt">Total: {rupees(order.total)}</span>
        {order.paid > 0 && <span className="toc-part">Collected {rupees(order.paid)}</span>}
        {order.claimed > 0 && (
          <span className="toc-part">
            Claim {rupees(order.claimed)} · {CLAIM_LINE[order.claimState] || order.claimState}
          </span>
        )}
        <span className={due > 0 ? "toc-due" : "toc-settled"}>
          {due > 0 ? `Outstanding ${rupees(due)}` : "✓ Settled"}
        </span>
        <span className="toc-ins">
          Insurance:{" "}
          {order.insurer
            ? `${order.insurer}${order.policyNo ? ` · ${order.policyNo}` : ""}`
            : "None"}
        </span>
      </div>

      {claimed && (
        <div className="toc-claim">
          Claim submitted by {order.claimSubmittedByName || "the desk"}
        </div>
      )}
      {order.claimState === "rejected" && (
        <div className="toc-claim">
          Claim rejected{order.claimNote ? ` — ${order.claimNote}` : ""} · collect from the patient
        </div>
      )}

      <div className="toc-foot">
        {form ? (
          <form className="toc-claim-form" onSubmit={submit}>
            {form.kind === "split" && (
              <input
                autoFocus
                required
                type="number"
                min="1"
                step="0.01"
                className="ar-reason-input toc-amt-input"
                placeholder="Cash ₹"
                value={form.amountPaid}
                onChange={field("amountPaid")}
              />
            )}
            {form.kind !== "reject" && (
              <input
                autoFocus={form.kind === "claim"}
                required={form.kind === "split"}
                type="number"
                min="1"
                step="0.01"
                className="ar-reason-input toc-amt-input"
                placeholder={form.kind === "split" ? "Claim ₹" : `Claim ₹ (default ${due})`}
                value={form.amountClaimed}
                onChange={field("amountClaimed")}
              />
            )}
            {form.kind !== "reject" && (
              <>
                <input
                  required
                  className="ar-reason-input"
                  placeholder="Insurer or TPA"
                  value={form.insurer}
                  onChange={field("insurer")}
                />
                <input
                  className="ar-reason-input"
                  placeholder="Policy no (optional)"
                  value={form.policyNo}
                  onChange={field("policyNo")}
                />
              </>
            )}
            {form.kind === "reject" && (
              <input
                autoFocus
                className="ar-reason-input"
                placeholder="What the insurer said (optional)"
                value={form.note}
                onChange={field("note")}
              />
            )}
            <button
              className={`st-btn ${form.kind === "reject" ? "st-btn-red" : "st-btn-blu"}`}
              type="submit"
              disabled={pending}
            >
              {form.kind === "split"
                ? "Take cash + claim rest"
                : form.kind === "claim"
                  ? "Submit claim"
                  : "Record rejection"}
            </button>
            <button className="st-btn st-btn-ghost" type="button" onClick={() => setForm(null)}>
              Cancel
            </button>
          </form>
        ) : claimed ? (
          <>
            {/* The submitter is not offered the approval at all. A disabled
                button says "you may not", which reads as a fault; what the desk
                needs is who CAN, so the order can move. */}
            {ownClaim ? (
              <span className="toc-await">
                Waiting for a second person to confirm the insurer approved this — you submitted it
              </span>
            ) : (
              <button
                className="st-btn st-btn-grn"
                disabled={pending}
                onClick={() => onClear(order, "claim_approved")}
              >
                ✓ Claim approved — notify lab
              </button>
            )}
            <button
              className="st-btn st-btn-ghost"
              disabled={pending}
              onClick={() => setForm({ kind: "reject", note: "" })}
            >
              Insurer refused
            </button>
          </>
        ) : (
          <>
            {/* An order with nothing left to collect is still on this list
                because its status says so — an unpriced order, or one written by
                an older build. The button stays live: it is what reconciles the
                order and lets the lab have it, and greying it out would strand
                the patient with no way forward. */}
            <button
              className="st-btn st-btn-grn"
              disabled={pending}
              onClick={() => onClear(order, "paid")}
            >
              {collectible > 0
                ? `✓ ${rupees(collectible)} received — notify lab`
                : "✓ Nothing to collect — notify lab"}
            </button>
            <button
              className="st-btn st-btn-blu"
              disabled={pending}
              onClick={() =>
                setForm({ kind: "claim", insurer: "", policyNo: "", amountClaimed: "" })
              }
            >
              Insurance claim
            </button>
            <button
              className="st-btn st-btn-g"
              disabled={pending}
              onClick={() =>
                setForm({
                  kind: "split",
                  insurer: "",
                  policyNo: "",
                  amountPaid: "",
                  amountClaimed: "",
                })
              }
            >
              Split
            </button>
          </>
        )}
        <span className="toc-age">{sinceLabel(order.orderedAt)}</span>
      </div>
    </div>
  );
}

// What the desk is told after a write. The outstanding balance is the useful
// half: "received" on an order that still owes ₹350 would read as finished.
const clearedMessage = (order, method, body, r) => {
  const name = order.name;
  if (r.alreadySettled) {
    // The reconcile write settles nothing new but DOES hand the order to the
    // lab, so "nothing changed" would be the wrong thing to tell the desk.
    if (r.reconciled) return `✓ ${name}'s order had nothing left to collect — lab notified`;
    return r.claimState === "submitted"
      ? `${name}'s claim is already submitted — waiting for approval`
      : `${name} was already settled — nothing charged twice`;
  }
  const rest = r.outstanding > 0 ? `₹${r.outstanding} still outstanding` : "lab can collect now";
  if (method === "insurance_claim") return `${name}'s claim sent to ${body.insurer} — ${rest}`;
  if (method === "split")
    return `✓ ${rupees(body.amountPaid)} taken from ${name}, ${rupees(body.amountClaimed)} claimed from ${body.insurer} — ${rest}`;
  if (method === "claim_approved") return `✓ ${name}'s claim approved — ${rest}`;
  if (method === "claim_rejected")
    return `${name}'s claim was refused — ₹${r.outstanding} to collect from the patient`;
  return `✓ ${rupees(r.amountPaid - order.paid)} received from ${name} — ${rest}`;
};

// How a settled order reads once it is off the working list. A split says both
// halves — "Paid ₹1,250" on an order where the insurer covered ₹900 would be a
// lie the accounts would have to unpick later.
const settledAs = (o) => {
  const cash = Number(o.paid) || 0;
  const claim = o.claimState === "approved" ? Number(o.claimed) || 0 : 0;
  if (cash && claim) return `Cash ${rupees(cash)} + claim ${rupees(claim)} approved`;
  if (claim) return `Insurance claim ${rupees(claim)} approved`;
  return `Paid ${rupees(cash || o.total)}`;
};

// How many of the day's cleared orders the tab shows before it is asked.
const CLEARED_PREVIEW = 8;

// Exported so the render smoke can execute the payments branch too — only one
// tab is mounted at a time, and the tab that is not showing still has to render.
export function PaymentsTab({ data, isLoading, onClear, pending, actorId }) {
  const queue = data?.pending || [];
  const cleared = data?.cleared || [];
  const [showAllCleared, setShowAllCleared] = useState(false);

  return (
    <>
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
          ⚠ Prices are placeholders from the design mockup, not the hospital's tariff — check the
          amount before collecting.
        </div>
      )}

      <div>
        <div className="grp-lbl grp-lbl-sp">🔴 Payment pending — collect and clear</div>
        {isLoading && <div className="empty-note">Loading…</div>}
        {!isLoading && queue.length === 0 && (
          <div className="empty-note">Nothing waiting for payment.</div>
        )}
        {queue.map((order) => (
          <OrderCard
            key={order.orderId}
            order={order}
            onClear={onClear}
            pending={pending}
            actorId={actorId}
          />
        ))}
      </div>

      {cleared.length > 0 && (
        <div>
          <div className="grp-lbl grp-lbl-sp">✅ Cleared today — lab notified</div>
          {(showAllCleared ? cleared : cleared.slice(0, CLEARED_PREVIEW)).map((o) => (
            <div className="test-order-card is-cleared" key={o.orderId}>
              <div className="toc-head">
                <div className="toc-cleared">
                  {o.name} ·{" "}
                  <span className="tc-detail">
                    {settledAs(o)} ·{" "}
                    {SAMPLE_LABEL[o.sampleStatus] || o.sampleStatus.replace(/_/g, " ")}
                  </span>
                </div>
                <div className="sp sp-paid">✓ Cleared {clock(o.paidAt)}</div>
              </div>
            </div>
          ))}
          {cleared.length > CLEARED_PREVIEW && (
            <button
              type="button"
              className="more-note more-btn"
              aria-expanded={showAllCleared}
              onClick={() => setShowAllCleared((v) => !v)}
            >
              {showAllCleared
                ? `Show fewer — ${cleared.length} cleared today`
                : `+ ${cleared.length - CLEARED_PREVIEW} more cleared today — show all`}
            </button>
          )}
        </div>
      )}
    </>
  );
}

// How late they are against their own slot. The desk phones the patient 40
// minutes past their appointment, so lateness reads louder the longer it runs;
// a patient whose slot has not arrived yet is not a problem at all.
function LateChip({ minutesLate }) {
  if (minutesLate === null || minutesLate === undefined) return null;
  if (minutesLate < 0) return <span className="ar-late">in {Math.abs(minutesLate)}m</span>;
  const tone = minutesLate >= 30 ? " ar-late-r" : minutesLate >= 10 ? " ar-late-a" : "";
  return <span className={`ar-late${tone}`}>{minutesLate}m past slot</span>;
}

function ArrivalRow({ arrival, children, note, wide }) {
  return (
    <div className="ar-row">
      <div className="ar-slot">{arrival.slot || "—"}</div>
      <div className="ar-who">
        <div className="ar-name">
          {arrival.name}
          {arrival.priority !== "normal" && <span className="badge b-red">{arrival.priority}</span>}
        </div>
        <div className="ar-meta">{identity(arrival)}</div>
        {note && <div className="ar-note">{note}</div>}
      </div>
      <div className={`ar-acts${wide ? " ar-acts-wide" : ""}`}>{children}</div>
    </div>
  );
}

function ExpectedRow({ arrival, onAct, busy }) {
  const [reason, setReason] = useState(null);

  if (reason !== null) {
    return (
      <ArrivalRow arrival={arrival} wide>
        <form
          className="ar-reason"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length < 2) return;
            onAct(arrival, "cancel", reason.trim());
            setReason(null);
          }}
        >
          <input
            className="ar-reason-input"
            autoFocus
            value={reason}
            placeholder="Why is it cancelled?"
            onChange={(e) => setReason(e.target.value)}
          />
          <button className="st-btn st-btn-grn" type="submit" disabled={reason.trim().length < 2}>
            Cancel visit
          </button>
          <button className="st-btn st-btn-g" type="button" onClick={() => setReason(null)}>
            Back
          </button>
        </form>
      </ArrivalRow>
    );
  }

  return (
    <ArrivalRow arrival={arrival}>
      <LateChip minutesLate={arrival.minutesLate} />
      <button
        className="st-btn st-btn-grn"
        disabled={busy}
        onClick={() => onAct(arrival, "arrived")}
      >
        ✓ Arrived
      </button>
      <button
        className="st-btn st-btn-ghost"
        disabled={busy}
        onClick={() => onAct(arrival, "no-show")}
      >
        No-show
      </button>
      {/* A cancel another station will see has to say why, so it asks before it
          writes rather than after. */}
      <button className="st-btn st-btn-ghost" disabled={busy} onClick={() => setReason("")}>
        Cancel
      </button>
    </ArrivalRow>
  );
}

function WalkInPanel({ onClose, onCheckIn, busy }) {
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isFetching } = useWalkInSearch(term);
  const results = data?.results || [];

  return (
    <div className="wi-panel">
      <div className="wi-head">
        <strong>Walk-in — patient with no appointment</strong>
        <button className="st-btn st-btn-g" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="sq-search">
        <input
          autoFocus
          value={search}
          placeholder="File no, phone or name"
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="sqs-count">{isFetching ? "…" : `${results.length} found`}</span>
      </div>

      {term.length < 2 && (
        <div className="wi-note">
          Search the patient first — a walk-in is booked against their existing record, never a new
          one. A patient who has never been here is registered on the patients screen.
        </div>
      )}
      {term.length >= 2 && results.length === 0 && !isFetching && (
        <div className="empty-note">Nobody matches “{term}”.</div>
      )}

      {results.map((p) => (
        <div className="wi-row" key={p.patientId}>
          <div className="ar-who">
            <div className="ar-name">{p.name}</div>
            <div className="ar-meta">{identity(p)}</div>
            {/* A blocked patient is shown, not hidden: reception has to know the
                person in front of them is blocked and why the desk cannot book
                them. The reason itself is redacted for the role by the server. */}
            {p.isBlocked && <div className="wi-blocked">🚫 {p.block}</div>}
          </div>
          <div className="ar-acts">
            {p.isBlocked ? (
              <span className="badge b-red">Blocked</span>
            ) : p.status ? (
              <span className="badge b-ink">Already on today's list — {p.statusLabel}</span>
            ) : (
              <button className="st-btn st-btn-grn" disabled={busy} onClick={() => onCheckIn(p)}>
                ✓ Check in
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ArrivalsTab({ search, setSearch, data, isLoading, onAct, onCheckIn, busy }) {
  const [walkIn, setWalkIn] = useState(false);
  const role = useAuthStore((st) => st.currentDoctor?.role);
  const canPrintRx = hasCapability(role, CAPABILITIES.GINIFLOW_PRINT_RX);
  const expected = data?.expected || [];
  const onFloor = data?.onFloor || [];
  const notComing = data?.notComing || [];
  const searching = (data?.query || "").length >= 2;

  return (
    <>
      <div className="workflow-note">
        <span className="wn-ico">🚪</span>
        <span>
          <strong>Arrival marking</strong> is for walk-ins and corrections — HealthRay's own
          check-ins arrive on their own. Anything marked here stays in Gini Flow until HealthRay
          catches up; it is not written back.
        </span>
      </div>

      <div className="ar-controls">
        <div className="sq-search">
          <input
            value={search}
            placeholder="Search today — name, file no or phone"
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="st-btn st-btn-g" onClick={() => setSearch("")}>
              Clear
            </button>
          )}
        </div>
        <button className="st-btn st-btn-blu" onClick={() => setWalkIn((w) => !w)}>
          + Walk-in
        </button>
      </div>

      {walkIn && <WalkInPanel onClose={() => setWalkIn(false)} onCheckIn={onCheckIn} busy={busy} />}

      {/* Two columns, because the desk uses them differently: Expected is the
          worklist — the people to greet or chase — and On the floor is
          reference, checked when somebody asks "is my father in yet?". Side by
          side, the worklist stays visible while the long list scrolls. */}
      <div className="ar-split">
        <div className="ar-col">
          <div className="grp-lbl grp-lbl-sp">⏳ Expected — not here yet ({expected.length})</div>
          {isLoading && <div className="empty-note">Loading…</div>}
          {!isLoading && expected.length === 0 && (
            <div className="empty-note">
              {searching ? "Nobody expected matches that search." : "Everyone booked has arrived."}
            </div>
          )}
          {expected.map((a) => (
            <ExpectedRow key={a.visitId} arrival={a} onAct={onAct} busy={busy} />
          ))}
        </div>

        <div className="ar-col">
          <div className="grp-lbl grp-lbl-sp">🏥 On the floor ({onFloor.length})</div>
          {onFloor.length === 0 && <div className="empty-note">Nobody in the building yet.</div>}
          {onFloor.map((a) => (
            <ArrivalRow
              key={a.visitId}
              arrival={a}
              note={a.blockedReason && `🚫 ${a.blockedReason}`}
            >
              <span className="ar-where">{a.statusLabel}</span>
              <span className="ar-since">in since {clock(a.checkedInAt)}</span>
              {canPrintRx && (
                <a
                  className="st-btn"
                  href={printRxHref(a.visitId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  🖨 Rx
                </a>
              )}
            </ArrivalRow>
          ))}
        </div>
      </div>

      {notComing.length > 0 && (
        <div>
          <div className="grp-lbl grp-lbl-sp">🚫 Not coming ({notComing.length})</div>
          {notComing.map((a) => (
            <ArrivalRow key={a.visitId} arrival={a}>
              <span className="ar-where">{a.statusLabel}</span>
              {/* Undo returns them to booked; the desk then presses Arrived. A
                  no-show who turns up is re-checked-in, not un-no-showed. */}
              <button
                className="st-btn st-btn-ghost"
                disabled={busy}
                onClick={() => onAct(a, "undo")}
              >
                Undo
              </button>
            </ArrivalRow>
          ))}
        </div>
      )}
    </>
  );
}

export default function ReceptionStationPage() {
  const [tab, setTab] = useState("arrivals");
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);

  // The search runs in Postgres so it reaches the whole day and can match a
  // phone number the browser never receives. Debounced, because every keystroke
  // would otherwise be a query.
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useReceptionQueue();
  const { data: arrivals, isLoading: arrivalsLoading } = useArrivals(undefined, term);
  const live = useGiniflowLive({ date: data?.date });
  // /api/auth/me returns the doctors row, so the id is `id` — `doctor_id` is
  // only the login form's field name, and reading it left the card unable to
  // tell whose claim it was showing.
  const actorId = useAuthStore((st) => st.currentDoctor?.id ?? st.currentDoctor?.doctor_id);
  const clearPayment = useClearPayment();
  const arrivalAction = useArrivalAction();
  const checkInWalkIn = useCheckInWalkIn();

  const pending = data?.pending || [];
  const awaitingSample = data?.awaitingSample || [];
  const cleared = data?.cleared || [];
  const counts = arrivals?.counts || { expected: 0, onFloor: 0, notComing: 0 };

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const failed = (e, fallback) =>
    showToast(e?.response?.data?.detail || e?.response?.data?.error || fallback);

  // Every write carries the version the card was rendered from, so a second tap
  // on a stale card is refused by the server instead of charging twice.
  const onClear = (order, method, body = {}) =>
    clearPayment.mutate(
      { orderId: order.orderId, method, version: order.version, ...body },
      {
        onSuccess: (r) => showToast(clearedMessage(order, method, body, r)),
        onError: (e) => failed(e, "Could not clear this — nothing was changed"),
      },
    );

  const ACTION_DONE = {
    arrived: (name) => `✓ ${name} checked in — they are on the floor now`,
    "no-show": (name) => `${name} marked as a no-show — their timer has stopped`,
    cancel: (name) => `${name}'s visit is cancelled — every station can see it`,
    undo: (name) => `${name} is back on the expected list`,
  };

  const onAct = (arrival, action, reason) =>
    arrivalAction.mutate(
      { visitId: arrival.visitId, action, reason },
      {
        onSuccess: (r) =>
          showToast(
            r.unchanged
              ? `${arrival.name} was already there — nothing changed`
              : ACTION_DONE[action](arrival.name),
          ),
        onError: (e) => failed(e, "Could not do that — nothing was changed"),
      },
    );

  const onCheckIn = (patient) =>
    checkInWalkIn.mutate(
      { patientId: patient.patientId, appointmentId: patient.appointmentId },
      {
        onSuccess: (r) =>
          showToast(
            r.unchanged
              ? `${patient.name} was already checked in`
              : `✓ ${patient.name} checked in as a walk-in — they are on the board now`,
          ),
        onError: (e) => failed(e, "Could not check this patient in — nothing was created"),
      },
    );

  return (
    <div className="gf">
      <StationNotice station="reception" />
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
          <LiveBadge live={live} className="tr-live" />
          <a className="rbtn" href="/giniflow/stations">
            ← Stations
          </a>
        </div>
      </div>

      <div className="scroll">
        <div className="inner">
          <div className="st-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "arrivals"}
              className={`st-tab${tab === "arrivals" ? " on" : ""}`}
              onClick={() => setTab("arrivals")}
            >
              Arrivals <span className="st-tab-n">{counts.expected}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === "payments"}
              className={`st-tab${tab === "payments" ? " on" : ""}`}
              onClick={() => setTab("payments")}
            >
              Payments <span className="st-tab-n">{pending.length}</span>
            </button>
          </div>

          <div className="stats">
            {tab === "arrivals" ? (
              <>
                <div className="stat">
                  <div className="sv sv-amb">{counts.expected}</div>
                  <div>
                    <div className="sl">Expected</div>
                    <div className="ss">booked, not here yet</div>
                  </div>
                </div>
                <div className="stat">
                  <div className="sv sv-grn">{counts.onFloor}</div>
                  <div>
                    <div className="sl">On the floor</div>
                    <div className="ss">checked in and past it</div>
                  </div>
                </div>
                <div className="stat">
                  <div className="sv sv-ink">{counts.notComing}</div>
                  <div>
                    <div className="sl">Not coming</div>
                    <div className="ss">no-show or cancelled</div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="stat">
                  <div className="sv sv-red">{pending.length}</div>
                  <div>
                    <div className="sl">Payment pending</div>
                    <div className="ss">tests ordered today</div>
                  </div>
                </div>
                <div className="stat">
                  <div className="sv sv-tl">{awaitingSample.length}</div>
                  <div>
                    <div className="sl">Sample pending</div>
                    <div className="ss">payment done, lab waiting</div>
                  </div>
                </div>
                <div className="stat">
                  <div className="sv sv-grn">{cleared.length}</div>
                  <div>
                    <div className="sl">Cleared</div>
                    <div className="ss">lab collecting</div>
                  </div>
                </div>
              </>
            )}
          </div>

          {tab === "arrivals" ? (
            <ArrivalsTab
              search={search}
              setSearch={setSearch}
              data={arrivals}
              isLoading={arrivalsLoading}
              onAct={onAct}
              onCheckIn={onCheckIn}
              busy={arrivalAction.isPending || checkInWalkIn.isPending}
            />
          ) : (
            <PaymentsTab
              data={data}
              isLoading={isLoading}
              onClear={onClear}
              pending={clearPayment.isPending}
              actorId={actorId}
            />
          )}
        </div>
      </div>

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
