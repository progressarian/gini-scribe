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

// A patient prescribed on HealthRay: no Gini Flow prescription exists, so there
// is nothing to open and no dispense flow to run. Rendered as a div, not a
// button, for that reason — the queue cards above it are clickable and these
// must not look like they are.
function HandoverRow({ row }) {
  return (
    <div className={`pt-card ph-handover-row${row.gone ? " is-gone" : ""}`}>
      <div className="pc-av" style={{ background: avatarColour(row.patientId) }}>
        {initials(row.name)}
      </div>
      <div className="pc-body">
        <div className="pc-name">
          {row.name}
          {row.fileNo && <span className="badge b-ink">{row.fileNo}</span>}
        </div>
        <div className="pc-meta">
          {[
            row.age && row.sex ? `${row.age}${row.sex[0]}` : row.age && `${row.age}y`,
            `${row.medicines} ${row.medicines === 1 ? "medicine" : "medicines"}`,
            `written ${clock(row.prescribedAt)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
        <div className="pc-tests">💊 {row.names.join(" · ")}</div>
      </div>
      <div className="pc-r">
        <div className={`sp ${row.gone ? "sp-done" : "sp-sample"}`}>{row.station}</div>
        <div className="pc-tlbl">{row.gone ? "has left" : "still here"}</div>
      </div>
    </div>
  );
}

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

export default function PharmacyStationPage() {
  const [toast, setToast] = useState("");
  const [openVisitId, setOpenVisitId] = useState(null);
  // Both are day-long records, not today's work, so they default closed —
  // the eye should land on the queue, not scroll past 121 finished rows first.
  const [doneOpen, setDoneOpen] = useState(false);
  const [goneOpen, setGoneOpen] = useState(false);
  // Dispensed is a day's worth of closed visits — 55 by the afternoon. The
  // column opens on the last few, because the counter works forward; the rest
  // are one press away rather than unreachable.
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

  const counts = data?.counts || {
    toDispense: 0,
    stockWarnings: 0,
    dispensed: 0,
    closedElsewhere: 0,
  };
  const dispensed = data?.dispensed || [];
  const toDispense = data?.toDispense || [];
  // Patients still in the building come first: they can still be handed their
  // medicines, and the ones who have gone are a record rather than a worklist.
  const pendingHandover = data?.pendingHandover || [];
  const onFloor = pendingHandover.filter((r) => !r.gone);
  const gone = pendingHandover.filter((r) => r.gone);

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
                <div className="sl">Dispensed here</div>
                <div className="ss">handed over at this counter</div>
              </div>
            </div>
            {/* Held apart from Dispensed on purpose. This tile used to be inside
                that one: `DONE_STATUSES` counts `exited` as well as `dispensed`,
                so every visit the HealthRay sync closed read as dispensed — 72 of
                them today, on a day the counter handed over nothing. */}
            <div className="stat">
              <div className="sv" style={{ color: "var(--ink3)" }}>
                {counts.closedElsewhere ?? 0}
              </div>
              <div>
                <div className="sl">Closed elsewhere</div>
                <div className="ss">visit ended, no pharmacy record</div>
              </div>
            </div>
          </div>

          <p className="stats-note">
            A patient reaches the queue below when a consultant taps Finalize on the Gini Flow
            consult screen. Prescriptions written on HealthRay never do, so they are listed as
            &ldquo;Prescribed on HealthRay&rdquo; instead — the medicines are owed either way.
          </p>

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
                {toDispense.length > 0 && (
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
                )}
                {/* Same column, because it is the same job: someone in the
                    building who has not been given their medicines. The Gini
                    queue is empty all day, so keeping these two apart put the
                    counter's only real work in a footnote. */}
                {onFloor.length > 0 && (
                  <div className="ph-group">
                    <div className="ph-group-head">Prescribed on HealthRay · {onFloor.length}</div>
                    <div className="ph-group-hint">
                      No Gini Flow prescription to close —{" "}
                      {onFloor.reduce((n, r) => n + r.medicines, 0)} medicines owed, nothing
                      recorded as collected.
                    </div>
                    <div className="pt-list">
                      {onFloor.map((r) => (
                        <HandoverRow key={r.patientId} row={r} />
                      ))}
                    </div>
                  </div>
                )}
                {toDispense.length === 0 && onFloor.length === 0 && (
                  <div className="empty-note">Nobody in the building is waiting on medicines.</div>
                )}
              </div>

              {/* Recessed: a record, not a worklist, so the eye goes left. */}
              <div className="dcol dcol-done">
                <button
                  type="button"
                  className="ph-collapse-head grp-lbl"
                  aria-expanded={doneOpen}
                  onClick={() => setDoneOpen((v) => !v)}
                >
                  <span className={`ph-chev${doneOpen ? " open" : ""}`} aria-hidden="true">
                    ▸
                  </span>
                  ✅ Done today — {dispensed.length + gone.length}
                </button>
                {doneOpen && dispensed.length > 0 && (
                  <div className="pt-list">
                    {dispensed.map((card) => (
                      <QueueCard
                        key={card.visitId}
                        card={card}
                        now={now}
                        done
                        onOpen={(c) => setOpenVisitId(c.visitId)}
                      />
                    ))}
                  </div>
                )}
                {/* Merged in, because both are the same fact to the counter: the
                    patient is gone. Held as its own group so the day's record
                    does not imply this pharmacy handed anything over. */}
                {/* Its own toggle, independent of Done today above — someone
                    checking who left with medicines unrecorded should not have
                    to open the dispensed list first to find it. */}
                {gone.length > 0 && (
                  <div className="ph-group">
                    <button
                      type="button"
                      className="ph-collapse-head grp-lbl"
                      aria-expanded={goneOpen}
                      onClick={() => setGoneOpen((v) => !v)}
                    >
                      <span className={`ph-chev${goneOpen ? " open" : ""}`} aria-hidden="true">
                        ▸
                      </span>
                      Left with medicines unrecorded · {gone.length}
                    </button>
                    <div className="ph-group-hint">
                      Prescribed on HealthRay, {gone.reduce((n, r) => n + r.medicines, 0)}{" "}
                      medicines, nothing recorded as collected before they left.
                    </div>
                    {goneOpen && (
                      <div className="pt-list">
                        {gone.map((r) => (
                          <HandoverRow key={r.patientId} row={r} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {dispensed.length === 0 && gone.length === 0 && (
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
