import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  usePharmacyQueue,
  usePharmacyPatient,
  useDispenseItem,
  useDispenseAll,
  useSendCard,
} from "../../queries/hooks/useGiniflowPharmacy";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import LiveBadge from "../../components/giniflow/LiveBadge";
import CounsellingNote from "./pharmacy/CounsellingNote";
import DispenseCard from "./pharmacy/DispenseCard";
import "../../styles/giniflow-station.css";
import StationNotice from "../../components/giniflow/StationNotice";

// The pharmacy station — gini-stations.html `#s-pharmacy` + `#pharmPane`.
//
// Design: docs/gini-flow/16-PHARMACY-STATION-PLAN.md
//
// The last station on the floor. When it marks a patient dispensed the visit
// ends, so the blanket button confirms first and says what it does — the same
// contract the board's Done drop follows (BQ-03).

const AVATAR_COLOURS = ["#374151", "#1e3a5f", "#14532d", "#7c2d12", "#7f1d1d", "#b45309"];

const initials = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

const avatarColour = (id) => AVATAR_COLOURS[Math.abs(id ?? 0) % AVATAR_COLOURS.length];

const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      })
    : "—";

const useTick = (intervalMs = 30_000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
};

const minutesSince = (iso, now) =>
  iso ? Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000)) : null;

// The 10-minute `pharmacy` budget, coloured the way every other station's timer
// is. The server sends the budget with the card so the two cannot disagree.
const timerTone = (minutes, budget) => {
  if (!budget || minutes === null) return "";
  const pct = (minutes / budget) * 100;
  if (pct > 100) return " late";
  if (pct >= 80) return " near";
  return "";
};

const PRIORITY_CHIP = {
  urgent: { cls: "pri-urgent", label: "❗ Urgent" },
  high: { cls: "pri-high", label: "⬆ High" },
};

function QueueCard({ card, now, onOpen, done }) {
  const minutes = minutesSince(done ? card.dispensedAt : card.since, now);
  const priority = PRIORITY_CHIP[card.priority];
  const shown = card.medicines.slice(0, 5);

  return (
    <div
      className={`pt-card ph-pt${done ? " is-uploaded" : ""}${priority ? ` ${priority.cls}` : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(card)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(card))}
    >
      <div className="pc-av" style={{ background: avatarColour(card.patientId) }}>
        {initials(card.name)}
      </div>

      <div className="pc-body">
        <div className="pc-name">
          {card.name}
          <span className="badge b-ink">{card.fileNo}</span>
          {priority && <span className="badge b-red">{priority.label}</span>}
          {/* Stock chips are absent entirely while the inventory is empty —
              never rendered as "all in stock" (16 §4.2). */}
          {card.stock?.out > 0 && (
            <span className="badge b-red">⚠ {card.stock.out} out of stock</span>
          )}
          {card.stock?.low > 0 && <span className="badge b-amb">{card.stock.low} low</span>}
          {done && card.counts.notGiven > 0 && (
            <span className="badge b-amb">{card.counts.notGiven} not given</span>
          )}
        </div>

        <div className="pc-meta">
          {card.age}
          {(card.sex || "")[0] || ""}
          {done
            ? ` · Dispensed ${clock(card.dispensedAt)}`
            : ` · Finalized ${clock(card.finalizedAt)}`}
          {card.doctor ? ` · ${card.doctor}` : ""} · {card.counts.gini} medicine
          {card.counts.gini === 1 ? "" : "s"}
          {card.counts.external > 0 ? ` · ${card.counts.external} external` : ""}
          {done && card.counselled ? " · Counselling done" : ""}
        </div>

        {/* The names, inline: the pharmacist starts pulling stock from this line
            before opening anything. */}
        {shown.length > 0 && (
          <div className="pc-tests">
            💊 {shown.join(" · ")}
            {card.medicines.length > shown.length
              ? ` +${card.medicines.length - shown.length} more`
              : ""}
          </div>
        )}
      </div>

      <div className="pc-r">
        <div className={`sp ${done ? "sp-done" : "sp-disp"}`}>{done ? "✓ Done" : "Dispense"}</div>
        {minutes !== null && (
          <>
            <div className={`pc-time${done ? "" : timerTone(minutes, card.waitBudget)}`}>
              {minutes}m
            </div>
            <div className="pc-tlbl">{done ? "ago" : "since finalized"}</div>
          </>
        )}
      </div>
    </div>
  );
}

// Escape closes, focus returns, click outside closes — the same contract the
// board's modal and the lab pane follow.
function useDismiss(open, onClose, ref) {
  const opener = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    const onKey = (e) => e.key === "Escape" && onClose();
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && onClose();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open, onClose, ref]);
}

function PharmacyPane({ visitId, onClose, onToast }) {
  const paneRef = useRef(null);
  const [confirming, setConfirming] = useState(false);
  const { data, isLoading } = usePharmacyPatient(visitId);
  const dispense = useDispenseItem();
  const dispenseAll = useDispenseAll();
  const sendCard = useSendCard();
  useDismiss(!!visitId, onClose, paneRef);

  const busy = dispense.isPending || dispenseAll.isPending;

  const onDispense = (medicine, status, reason) =>
    dispense.mutate(
      { visitId, medicationId: medicine.medicationId, status, reason },
      {
        onSuccess: () =>
          onToast(
            status === "given"
              ? `✓ ${medicine.name} dispensed`
              : `${medicine.name} marked not given — ${reason}`,
          ),
        onError: (e) =>
          onToast(e?.response?.data?.error || "Could not mark that — nothing was changed"),
      },
    );

  const onDispenseAll = () =>
    dispenseAll.mutate(
      { visitId },
      {
        onSuccess: (r) => {
          // The card send is not awaited by the API (PH-02), so this cannot
          // claim it arrived — the pane's "✓ Card sent" line reports that once
          // `card_sent_at` comes back on the next poll.
          onToast(
            r.partial
              ? `✓ ${data?.name} dispensed the rest · ${r.notGiven.join(", ")} not given · visit closed`
              : `✓ ${data?.name} — all dispensed, visit closed · medicine card on its way`,
          );
          setConfirming(false);
          onClose();
        },
        onError: (e) => {
          setConfirming(false);
          onToast(e?.response?.data?.error || "Could not close this visit — nothing was changed");
        },
      },
    );

  // PH-01. A no-op send — the WhatsApp template is not approved yet — says so.
  // A green tick for a message that never left the building is the same mistake
  // as an "all in stock" chip with no inventory behind it.
  const onSend = () =>
    sendCard.mutate(
      { visitId },
      {
        onSuccess: (r) =>
          onToast(
            r.sent
              ? `📱 Medicine card sent to ${data?.name} on WhatsApp`
              : r.reason || "The card was logged, not sent",
          ),
        onError: (e) => onToast(e?.response?.data?.error || "Could not send the card"),
      },
    );

  const totals = data?.totals;
  const blocked = !!data?.blockedByNotGiven;

  return (
    <div className="detail-overlay">
      <div
        className="detail-pane ph-pane"
        ref={paneRef}
        role="dialog"
        aria-label="Pharmacy — dispense"
      >
        <div className="dp-head">
          <div className="dp-name">{data?.name || "Loading…"}</div>
          <div className="dp-meta">
            {data
              ? `${data.age ?? "—"}${(data.sex || "")[0] || ""} · ${data.fileNo} · ${
                  data.doctor || "Gini Health"
                } · Finalized ${clock(data.finalizedAt)} · ${totals.gini} Gini medicine${
                  totals.gini === 1 ? "" : "s"
                }${totals.external ? ` · ${totals.external} external` : ""}`
              : "Opening the card…"}
          </div>
          <div className="dp-acts">
            <button className="rbtn" onClick={onClose}>
              ← Back
            </button>
            {data && !data.finished && (
              <button
                className="rbtn grn"
                disabled={busy || !totals.gini}
                onClick={() => setConfirming(true)}
              >
                ✓ {blocked ? "Dispense the rest" : "Mark all dispensed"}
              </button>
            )}
            {data?.finished && <span className="sp sp-done">✓ Dispensed · visit closed</span>}
          </div>
        </div>

        <div className="dp-scroll">
          <div className="dp-inner">
            {isLoading && <div className="empty-note">Loading the card…</div>}

            {data && confirming && (
              <div className="confirm-box">
                <div className="cb-title">
                  {blocked ? "Dispense the rest and close the visit?" : "Close this visit?"}
                </div>
                <div className="cb-body">
                  {totals.pending > 0
                    ? `${totals.pending} medicine${totals.pending === 1 ? "" : "s"} will be marked given. `
                    : "Every medicine is already marked. "}
                  {blocked &&
                    `${totals.notGiven} medicine${totals.notGiven === 1 ? " stays" : "s stay"} marked NOT given, with the reason. `}
                  {data.name}&apos;s journey closes, the medicine card goes to them on WhatsApp, and
                  the day&apos;s stats recompute. This cannot be undone.
                </div>
                <div className="cb-acts">
                  <button className="st-btn st-btn-g" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                  <button className="st-btn st-btn-grn" disabled={busy} onClick={onDispenseAll}>
                    {busy ? "Closing…" : blocked ? "Dispense the rest" : "Yes, all dispensed"}
                  </button>
                </div>
              </div>
            )}

            {/* A closed visit nobody marked at the counter.
                
                This is not a bug and not an empty state: it is what the floor
                actually does. The HealthRay sync closes the visit when the
                hospital's own system says the patient left, so `exited` arrives
                without a single medicine having been pressed here — and every
                row then reads "Not marked", correctly and unhelpfully. The note
                says which of the two happened. */}
            {data?.finished && totals.given === 0 && totals.notGiven === 0 && (
              <div className="dp-sec ph-unmarked">
                Closed without anything being marked at the counter — the visit was ended by the
                HealthRay sync, not from this screen. Nothing records what {data.name} was actually
                handed, so every medicine below shows <strong>Not marked</strong>.
              </div>
            )}

            {data && (
              <CounsellingNote
                note={data.counselling}
                sentAt={data.cardSentAt}
                lastSend={sendCard.data}
                onSend={onSend}
                sending={sendCard.isPending}
              />
            )}

            {/* Inert until the inventory has rows — which is the whole of §5.2
                today. Rendered only when there is something true to say. */}
            {data?.stockWarnings?.length > 0 && (
              <div className="dp-sec ph-stock">
                <div className="dp-sec-title ph-stock-title">
                  ⚠ Stock warnings for this prescription
                </div>
                {data.stockWarnings.map((w) => (
                  <div className="ph-stock-line" key={w.medicationId}>
                    • <strong>{w.name}</strong> — {w.message}
                  </div>
                ))}
              </div>
            )}

            {data && (
              <div className="dp-sec ph-cardsec">
                <div className="dp-sec-title">Medicine card — full instructions for patient</div>
                <div className="ph-tally">
                  <span className="ph-tally-g">{totals.given} dispensed</span>
                  <span>{totals.pending} to go</span>
                  {totals.notGiven > 0 && (
                    <span className="ph-tally-r">{totals.notGiven} not given</span>
                  )}
                  {totals.external > 0 && <span>{totals.external} external</span>}
                </div>
                <DispenseCard
                  card={data.card}
                  onDispense={onDispense}
                  busy={busy}
                  closed={data.finished}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// How many closed visits the column shows before it has to be asked. The
// counter works forward, so the last few are the ones anybody scrolls to.
const DISPENSED_PREVIEW = 5;

export default function PharmacyStationPage() {
  const [toast, setToast] = useState("");
  const [openVisitId, setOpenVisitId] = useState(null);
  // Dispensed is a day's worth of closed visits — 55 by the afternoon. The
  // column opens on the last few, because the counter works forward; the rest
  // are one press away rather than unreachable.
  const [showAllDispensed, setShowAllDispensed] = useState(false);
  const toastTimer = useRef(null);
  const now = useTick();

  const { data, isLoading } = usePharmacyQueue();
  const live = useGiniflowLive({ date: data?.date });

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4000);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const counts = data?.counts || { toDispense: 0, stockWarnings: 0, dispensed: 0 };
  const dispensed = data?.dispensed || [];
  const toDispense = data?.toDispense || [];

  // The pane follows the live queue rather than a copy of it, so a card that
  // moves out of "to dispense" while it is open does not go stale.
  const openCard = useMemo(
    () => [...toDispense, ...dispensed].find((c) => c.visitId === openVisitId) || null,
    [toDispense, dispensed, openVisitId],
  );

  const closePane = useCallback(() => setOpenVisitId(null), []);

  return (
    <div className="gf">
      <StationNotice station="pharmacy" />
      <div className="rail">
        <div className="rl">Pharmacy Station</div>
        <div className="rsep" />
        <span className="rail-title">
          Gini Pharmacy ·{" "}
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
          <div className="stats">
            <div className="stat">
              <div className="sv" style={{ color: "var(--pu)" }}>
                {counts.toDispense}
              </div>
              <div>
                <div className="sl">To dispense</div>
                <div className="ss">prescription ready</div>
              </div>
            </div>
            <div className="stat">
              <div className="sv" style={{ color: "var(--amb)" }}>
                {counts.stockWarnings}
              </div>
              <div>
                <div className="sl">Stock warnings</div>
                <div className="ss">low / out of stock</div>
              </div>
            </div>
            <div className="stat">
              <div className="sv" style={{ color: "var(--grn)" }}>
                {counts.dispensed}
              </div>
              <div>
                <div className="sl">Dispensed</div>
                <div className="ss">today</div>
              </div>
            </div>
          </div>

          <div className="workflow-note ph-note-strip">
            <span className="wn-ico">⚡</span>
            <span>
              <strong>Workflow:</strong> The doctor finalizes → the patient appears here → you
              dispense each medicine and read the counselling note →{" "}
              <strong>Mark all dispensed</strong> closes the visit and sends the medicine card on
              WhatsApp.
            </span>
          </div>

          {isLoading && <div className="empty-note">Loading…</div>}

          {/* The heading stays even with nothing under it.
              
              It used to be inside `toDispense.length > 0`, so on a day with 55
              dispensed and none waiting the whole section vanished — no heading,
              no note, just the Dispensed list where the queue should be. That
              reads as a broken screen rather than a clear counter, and the
              difference matters: one means wait, the other means nothing is
              coming. */}
          {/* Waiting on the left, done on the right.
              
              Two questions, and they are asked at different moments: "who is at
              my counter" is the whole job, and "what did we hand out today" is a
              lookup. Stacked, the second pushed the first off a full day's
              screen. Same `.dsplit` the doctor station uses — one layout, not a
              second one that drifts. */}
          {!isLoading && (
            <div className="dsplit">
              <div className="dcol">
                <div className="grp-lbl" style={{ marginBottom: 7 }}>
                  💊 To dispense — prescription finalized by doctor
                </div>
                {toDispense.length ? (
                  <div className="pt-list">
                    {toDispense.map((card) => (
                      <QueueCard
                        key={card.visitId}
                        card={card}
                        now={now}
                        onOpen={(c) => setOpenVisitId(c.visitId)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="empty-note">
                    {dispensed.length
                      ? "Queue clear — nobody is waiting at the counter. A patient appears here the moment a consultant finalizes their prescription."
                      : "Nobody waiting yet. A patient appears here the moment a consultant finalizes their prescription."}
                  </div>
                )}
              </div>

              {/* Recessed: a record, not a worklist, so the eye goes left. */}
              <div className="dcol dcol-done">
                <div className="grp-lbl" style={{ marginBottom: 7 }}>
                  ✅ Dispensed today
                </div>
                {dispensed.length ? (
                  <div className="pt-list">
                    {(showAllDispensed ? dispensed : dispensed.slice(0, DISPENSED_PREVIEW)).map(
                      (card) => (
                        <QueueCard
                          key={card.visitId}
                          card={card}
                          now={now}
                          done
                          onOpen={(c) => setOpenVisitId(c.visitId)}
                        />
                      ),
                    )}
                    {/* Was a plain "+ 52 more dispensed today" line, which named
                        the other 52 and then gave nobody a way to reach them. */}
                    {dispensed.length > DISPENSED_PREVIEW && (
                      <button
                        type="button"
                        className="more-note more-btn"
                        aria-expanded={showAllDispensed}
                        onClick={() => setShowAllDispensed((v) => !v)}
                      >
                        {showAllDispensed
                          ? `Show fewer — ${dispensed.length} dispensed today`
                          : `+ ${dispensed.length - DISPENSED_PREVIEW} more dispensed today — show all`}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="empty-note">Nothing dispensed yet today.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {openCard && (
        <PharmacyPane visitId={openCard.visitId} onClose={closePane} onToast={showToast} />
      )}

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
