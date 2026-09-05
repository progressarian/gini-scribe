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
        <span className="toc-ins">Insurance: None</span>
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

// How many of the day's cleared orders the tab shows before it is asked.
const CLEARED_PREVIEW = 8;

// Exported so the render smoke can execute the payments branch too — only one
// tab is mounted at a time, and the tab that is not showing still has to render.
export function PaymentsTab({ data, isLoading, onClear, pending }) {
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
          <OrderCard key={order.orderId} order={order} onClear={onClear} pending={pending} />
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
            />
          )}
        </div>
      </div>

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
