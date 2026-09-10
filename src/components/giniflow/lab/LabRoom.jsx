import { useCallback, useEffect, useRef, useState } from "react";
import {
  useLabQueue,
  useAdvanceSample,
  useUploadReport,
  useMarkLabCaseAction,
  useUploadLabCaseReport,
  useDeleteLabCaseReport,
  reportHref,
} from "../../../queries/hooks/useGiniflowLab";
import { useGiniflowLive } from "../../../queries/hooks/useGiniflowLive";
import LiveBadge from "../LiveBadge";
import "../../../styles/giniflow-station.css";
import LabResultsForm from "../LabResultsForm";
import PdfViewerModal from "../../visit/PdfViewerModal";
import StationNotice from "../StationNotice";
import useAuthStore from "../../../stores/authStore";
import {
  LAB_RUNGS,
  visibleRungs,
  BUCKET_TO_STAGE,
  markableRungs,
  ACTION_PAST_LABEL,
  SAMPLE_STATUS_TO_STAGE,
  rungFor,
  stageIndexOf,
} from "../../../../shared/labStages.js";

const STAT_COLOUR = {
  pending: "var(--tl)",
  collected: "var(--blu)",
  sent: "var(--blu)",
  received: "var(--pu)",
  processing: "var(--pu)",
  results: "var(--amb)",
  reported: "var(--grn)",
};

const atLeast = (sampleStatus, stageKey) =>
  stageIndexOf(SAMPLE_STATUS_TO_STAGE[sampleStatus]) >= stageIndexOf(stageKey);

// The pill is where the patient is; the line under it says what that means for
// a sample still running. "Exited" with "patient is here" underneath was the
// screen contradicting itself.
// Wording taken from the reference design's own lab pane (gini-stations.html
// `openLab`): "✓ Mark sample collected", under the heading "Update status", with
// its hint "Mark that you have collected the sample from this patient." The Gini
// queue above already speaks that way and these must not speak differently for
// the same physical act.
//
// One action only. A "mark chased" button was here briefly and is gone: it
// appears nowhere in the reference, and inventing vocabulary for a screen that
// has a design is how two screens end up describing the same floor differently.
//
// `shows` is the point: an action that cannot apply must not be offered. A
// sample already collected has nothing left to mark.
const CASE_ACTIONS = markableRungs().map((r) => ({
  action: r.action,
  doneLabel: r.actionDone,
  hint: r.actionHint,
  needsPatient: r.needsPatient,
}));

const ACTION_LABEL = ACTION_PAST_LABEL;

const shortDate = (iso) =>
  iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
    : null;

const stationPill = (r) => {
  // One name for one thing. A patient booked under the lab-only provider and a
  // patient who walked into the lab with no appointment at all do exactly the
  // same thing here — a test and nothing else. Over the six days the flow has
  // been writing visit rows, the no-appointment group recorded no vitals, no
  // consultation and no appointment of any kind. Two different pills for that
  // read as two situations and sent people looking for a clinical difference
  // that does not exist.
  //
  // What DOES differ is only whether the floor knows they are here, so that
  // goes on the sub-line: a booked patient is checked in and can be called
  // over, a walk-in is known to the lab alone.
  if (r.labOnly)
    return {
      cls: "sp-process",
      text: "Lab only",
      sub: r.finished ? "has left the floor" : "checked in · free to call",
    };
  if (!r.station)
    return {
      cls: "sp-process",
      text: "Lab only",
      sub: r.lastSeenOn ? `walk-in · last seen ${shortDate(r.lastSeenOn)}` : "walk-in · no booking",
    };
  if (r.finished) return { cls: "sp-done", text: r.station, sub: "has left the floor" };
  // Somebody else has them in a room, or they are sitting in a queue. Only the
  // first is a patient the lab cannot get to.
  if (r.inARoom) return { cls: "sp-ready", text: r.station, sub: "in the room — not free" };
  // What are they actually waiting ON? A patient with today's bloods still out is
  // not waiting for the MO — the MO is waiting for the lab, which is exactly what
  // `awaitingResults` says on the MO board and `waitingOnLab` on the consultant's.
  // Naming the board column here instead had this screen call such a patient
  // "With Chief Endocrinologist" while the MO board called them "awaiting
  // results": one patient, two screens, opposite stories. On the LAB's own screen
  // the honest line is that the floor is stopped on this sample.
  if (r.awaitingResults) {
    // Nothing has been drawn, so there is no report to be waiting for. Saying
    // "waiting for lab reports" over an uncollected tube names the wrong problem
    // and hides the urgent one: the patient is on the floor NOW and about to
    // leave with their bloods untaken.
    if (r.stage.key === "pending")
      return {
        cls: "sp-sample",
        text: "Sample not taken",
        sub: `${r.statusLabel || r.station} · nothing drawn yet`,
      };
    return {
      cls: "sp-sample",
      text: "Waiting for lab reports",
      sub: `${r.statusLabel || r.station} · floor held on this sample`,
    };
  }
  // Nothing outstanding — then the board column is the whole answer, and the
  // status label draws the distinction the column erases (`vitals_done`,
  // `sd_pending` and `with_sd` all share one column name).
  return {
    cls: "sp-sample",
    text: r.statusLabel || r.station,
    sub: "waiting — free to call",
  };
};

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

const minutesSince = (iso) =>
  iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)) : null;

const groupsFor = (room) =>
  visibleRungs(room).map((r) => ({
    key: r.bucket,
    stageKey: r.key,
    filterKey: r.filter,
    room: r.room,
    label: r.sectionLabel,
    pill: r.pill,
    pillText: r.pillText,
    timerLabel: r.timerLabel,
  }));

// The filter row across the top. Keys match the sections below: the three
// running stages, plus the two columns of the split underneath them.
const filtersFor = (room) =>
  visibleRungs(room).map((r) => ({ key: r.filter, label: r.filterLabel }));

// The wording each room opens and closes on. Everything else on the page comes
// from the ladder; these are the two columns whose meaning changes with who is
// standing at the bench.
const ROOM_COPY = {
  all: {
    title: "Gini Lab",
    station: "Lab Station",
    firstLabel: "📞 To call — start lab steps",
    firstEmpty: "Nobody waiting to be called.",
    lastLabel: "✅ Lab done",
    lastEmpty: "No case has reported yet today.",
  },
  collection: {
    title: "Lab · Collection room",
    station: "Lab Station 1",
    firstLabel: "📞 To call — test ordered",
    firstEmpty: "Nobody waiting to be called.",
    lastLabel: "📤 Sent to the lab",
    lastEmpty: "Nothing sent to the lab yet today.",
  },
  processing: {
    title: "Lab · Processing room",
    station: "Lab Station 2",
    firstLabel: "📥 Inbox — on the way from collection",
    firstEmpty: "No samples waiting to be received.",
    lastLabel: "✅ Reports uploaded",
    lastEmpty: "No case has reported yet today.",
  },
};

const UNREACHABLE_GROUPS = [
  {
    key: "in_room",
    label: "⏸ In a room — collect once free",
    hint: "Somebody else has the patient right now. This clears itself when they come out.",
    holds: (r) => !r.finished,
  },
  {
    key: "gone",
    label: "🚫 Left the floor — sample not taken",
    hint: "The patient has gone home, so this sample cannot be drawn today. Chase it separately.",
    holds: (r) => r.finished,
  },
];

const SENT_LIST = {
  key: "sent",
  label: "Waiting for the lab to receive them",
  hint: "The collection room is finished with these. The lab room clears them as they arrive.",
  holds: () => true,
};

const DONE_SPLIT = [
  {
    key: "on_floor",
    label: "Still on the floor",
    hint: "Results are back and waiting for them at the next station.",
    holds: (r) => r.onFloor && !r.labOnly,
  },
  // Samples-only patients have no next station, so the group above would tell
  // the lab somebody downstream is waiting when nobody is.
  {
    key: "samples_only",
    label: "Lab only — free to go",
    hint: "Booked for the test alone, so nothing downstream is waiting on these.",
    holds: (r) => r.onFloor && r.labOnly,
  },
  {
    key: "left",
    label: "Left the floor",
    hint: "Nobody is waiting on these — kept for the day's record.",
    holds: (r) => !r.onFloor,
  },
];

const GROUP_TO_STAGE = BUCKET_TO_STAGE;

// One clock for two sources. The lists used to be a Gini block followed by a
// HealthRay block, so a case registered at 15:31 could sit above one from 09:12
// and the column read in no order at all. Sorted ascending, the top of every
// list is the person who has been waiting longest — the list is also the order
// to work them in. A row with no timestamp sorts last rather than jumping to
// the top on a 1970 epoch.
const rowTime = (r) => {
  const iso = r.source === "giniflow" ? r.row.orderedAt : r.row.registeredAt;
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : Infinity;
};
const byTimeAsc = (a, b) => rowTime(a) - rowTime(b);

// How long a report may sit in "results ready" before the wait itself is the
// problem — the report exists, the MO just has not been told.
const UPLOAD_WAIT_AMBER = 15;

function LabCard({ order, group, onAdvance, onUpload, onOpen, busy }) {
  const mins = minutesSince(group.key === "uploaded" ? order.uploadedAt : order.since);
  const fileRef = useRef(null);
  const waitingTooLong = group.key === "ready" && mins !== null && mins >= UPLOAD_WAIT_AMBER;
  return (
    <div
      className={`pt-card${group.key === "uploaded" ? " is-uploaded" : ""}`}
      onClick={(e) => {
        // The card opens the detail pane; the action button and the file input
        // inside it do their own thing.
        if (e.target.closest("button, input, a")) return;
        onOpen(order);
      }}
    >
      <div className="pc-av" style={{ background: avatarColour(order.patientId) }}>
        {initials(order.name)}
      </div>
      <div className="pc-body">
        <div className="pc-name">
          {order.name}{" "}
          {group.key === "uploaded" && order.uploadedAt ? (
            <span className="badge b-grn">Uploaded {clock(order.uploadedAt)}</span>
          ) : (
            <span className="badge b-ink">{order.fileNo}</span>
          )}
        </div>
        <div className="pc-meta">
          {order.age}
          {(order.sex || "")[0] || ""}
          {order.orderedBy ? ` · Ordered by ${order.orderedBy}` : ""} · {clock(order.orderedAt)}
        </div>
        <div className="pc-tests">
          🔬 {order.tests.map((t) => t.name).join(" · ") || "no tests listed"} ·{" "}
          <strong>
            {order.tests.length} test{order.tests.length === 1 ? "" : "s"}
          </strong>
        </div>
        <div className="steps">
          {order.steps.map((s, i) => (
            <span key={s.name}>
              <span className={`step step-${s.state}`}>{s.name}</span>
              {i < order.steps.length - 1 && <span className="step-arr">›</span>}
            </span>
          ))}
        </div>
        {order.blockedReason && <div className="lab-blocked">💰 {order.blockedReason}</div>}
      </div>
      <div className="pc-r">
        {order.nextAction?.to === "uploaded" ? (
          <>
            {/* The last step needs a file, not just a tap: an order marked
                uploaded with no report tells the MO a result exists when it
                does not. */}
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUpload(order, file);
                e.target.value = "";
              }}
            />
            <button
              className="st-btn st-btn-tl"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              📤 Upload report
            </button>
          </>
        ) : order.nextAction ? (
          <button
            className="st-btn st-btn-tl"
            disabled={busy}
            onClick={() => onAdvance(order, order.nextAction.to)}
          >
            {order.nextAction.label}
          </button>
        ) : (
          <div className={`sp ${group.pill}`}>{group.pillText}</div>
        )}
        {mins !== null && (
          <>
            <div className={`pc-time${waitingTooLong ? " late" : ""}`}>{mins}m</div>
            <div className="pc-tlbl">{group.timerLabel}</div>
          </>
        )}
      </div>
    </div>
  );
}

const TEST_STATUS_LABEL = {
  ordered: "Ordered",
  paid: "Ordered",
  sample_collected: "Sample taken",
  processing: "In analyzer",
  results_ready: "Result ready",
  uploaded: "Uploaded",
};

// A hospital-lab row has no patient_id until the detail sync matches the case
// to a chart, so `patientId` is null for a walk-in the hospital registered on
// its own. That null cannot address a row: it equals the closed state, so the
// pane opened itself on load and every close re-matched the same row. `rowKey`
// is the identity the query grouped on and is never null; the local fallback
// only covers a server that has not shipped it yet.
const caseRowKey = (r) => r.rowKey ?? r.patientId ?? `hr:${r.fileNo || "?"}`;

// Escape closes, focus returns, click outside closes — the same contract the
// board's modal and drawer follow.
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

function LabDetailPane({
  order,
  group,
  room,
  onViewReport,
  onClose,
  onAdvance,
  onUpload,
  onResultsSaved,
  onResultsFailed,
  busy,
}) {
  // Same rule as the hospital-case pane: results belong to the analyzer bench.
  const atTheBench = room !== "collection";
  const paneRef = useRef(null);
  const fileRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  useDismiss(!!order, onClose, paneRef);
  if (!order) return null;

  // 'uploaded' included: typing the values finishes the order, and the whole
  // point of having both is that the scan can still be attached afterwards —
  // which the upload zone disappearing would have quietly prevented.
  const canUpload = atTheBench && atLeast(order.sampleStatus, "results") && order.paid;
  // Values can be typed once the sample is in the lab's hands, and afterwards —
  // an order finished by an upload can still have its numbers added, and one
  // finished by numbers can be corrected.
  const canEnterResults = atTheBench && atLeast(order.sampleStatus, "results") && order.paid;

  // Refuse an oversized file here rather than spending a minute base64-encoding
  // it only for the service to reject it. The limit is the one the zone states.
  const take = (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      onUpload(order, file, "Report is larger than 10 MB — nothing was uploaded");
      return;
    }
    onUpload(order, file);
  };

  return (
    <div className="detail-overlay">
      <div className="detail-pane" ref={paneRef} role="dialog" aria-label="Lab order">
        <div className="dp-head">
          <div className="dp-name">{order.name}</div>
          <div className="dp-meta">
            {order.age}
            {(order.sex || "")[0] || ""} · {order.fileNo} · Tests:{" "}
            {order.tests.map((t) => t.name).join(" · ") || "none listed"}
          </div>
          <div className="dp-acts">
            <button className="rbtn" onClick={onClose}>
              ← Back
            </button>
            <span className={`sp ${group.pill}`}>{group.pillText}</span>
          </div>
        </div>

        <div className="dp-scroll">
          <div className="dp-inner">
            <div className="dp-sec">
              <div className="dp-sec-title">Tests ordered</div>
              {order.tests.map((t) => (
                <div className="test-row" key={t.name}>
                  <div className="tr-name">{t.name}</div>
                  <div className="tr-status">
                    <span className="badge b-ink">
                      {TEST_STATUS_LABEL[t.status] || t.status || "Ordered"}
                    </span>
                  </div>
                </div>
              ))}
              {order.tests.length === 0 && <div className="dp-hint">No tests on this order.</div>}
            </div>

            <div className="dp-sec">
              <div className="dp-sec-title">Update status</div>
              {order.blockedReason ? (
                <div className="dp-hint lab-blocked">💰 {order.blockedReason}</div>
              ) : order.nextAction && order.nextAction.to !== "uploaded" ? (
                <>
                  {/* The hint belongs to the step the button performs, so it is
                      asked of the ladder — the same source the hospital-case
                      pane uses. Written as a chain over three sample statuses it
                      could not survive a fourth: every rung added after it fell
                      through to the last branch, so "Mark sent to lab" was
                      captioned "running in the analyzer" and "Start processing"
                      was captioned "results as done". */}
                  <div className="dp-hint">
                    {rungFor(SAMPLE_STATUS_TO_STAGE[order.nextAction.to])?.actionHint}
                  </div>
                  <button
                    className="st-btn st-btn-tl btn-full"
                    disabled={busy}
                    onClick={() => onAdvance(order, order.nextAction.to)}
                  >
                    {order.nextAction.label}
                  </button>
                </>
              ) : (
                <div className="dp-hint">
                  {order.sampleStatus === "uploaded"
                    ? "✓ Report uploaded and the Chief Endocrinologist has been notified. This patient reads “Results ready” on every dashboard."
                    : "Upload the report below to notify the Chief Endocrinologist instantly."}
                </div>
              )}
            </div>

            {/* Typing the values in is the other way to finish an order, and the
                better one where the lab runs the test itself: a number can be
                trended and flagged, a scan of a number cannot. Either finishes
                the order; a case may carry both.
                docs/gini-flow/32-LAB-TYPED-RESULTS-PLAN.md */}
            {canEnterResults && (
              <div className="dp-sec">
                <div className="dp-sec-title">Enter results — values the doctor can trend</div>
                <LabResultsForm
                  // Keyed on the order: the detail pane is reused when the
                  // technician clicks straight from one patient's card to the
                  // next, and without this the form keeps the first patient's
                  // typed values and would save them onto the second's record.
                  key={order.orderId}
                  orderId={order.orderId}
                  onSaved={(r) => onResultsSaved?.(order, r)}
                  onFailed={(e) => onResultsFailed?.(e)}
                />
              </div>
            )}

            {canUpload && (
              <div className="dp-sec">
                <div className="dp-sec-title">Or upload a report — triggers MO notification</div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  hidden
                  onChange={(e) => {
                    take(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className={`upload-area${dragging ? " drag" : ""}`}
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    take(e.dataTransfer.files?.[0]);
                  }}
                >
                  <div className="ua-ico">📄</div>
                  <div className="ua-t">
                    {busy ? "Uploading…" : "Tap or drop the lab report here"}
                  </div>
                  <div className="ua-s">PDF · JPG · PNG accepted · Max 10MB</div>
                </button>
                <div className="dp-trigger">
                  <span className="wn-ico">⚡</span>
                  Uploading this report automatically changes this patient's status to{" "}
                  <strong>“Results ready”</strong> on the MO and SD dashboards.
                </div>
              </div>
            )}

            {order.reportUrl && (
              <div className="dp-sec">
                <div className="dp-sec-title">Report</div>
                {/* The same viewer every other screen opens a document in. The
                    raw file link is kept only for the moment before the chart
                    row exists — promotion into `documents` runs fire-and-forget
                    after the upload, so a report opened straight away may not
                    have one yet. */}
                {order.reportDocId ? (
                  <button
                    type="button"
                    className="st-btn st-btn-g"
                    onClick={() =>
                      onViewReport({
                        id: order.reportDocId,
                        title: "Lab report",
                        doc_type: "lab_report",
                      })
                    }
                  >
                    📄 View uploaded report
                  </button>
                ) : (
                  <a
                    className="st-btn st-btn-g"
                    href={reportHref(order.orderId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    📄 View uploaded report
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// How many of the day's finished uploads the column shows before it is asked.
const UPLOADED_PREVIEW = 5;

// Read-only states, so they borrow the queue's pills rather than earning new
// ones: nothing here is a step a technician can move.
// Two sides, and both are about a PERSON, not a tube.
//
// Left is the floor waiting on the lab: their sample is still out, so the card
// says where they are standing while it runs — a result that is late matters
// when the patient is sitting in the MO queue and matters differently when they
// have already gone home. Right is the reverse: the lab is finished with them
// and the delay, if any, is now somebody else's station.
//
// Patients whose lab is done AND who have left are neither — nobody is waiting
// on anything — so they collapse into a single line rather than filling a column.
// Longest wait first. A queue nobody works is ordered by whoever has been left
// longest, not by whoever the sync happened to fetch first.

// Anyone the lab can actually reach comes first; the rest are there to be seen,
// not worked, so they sink and dim.

// Inside "Waiting on the lab" the two halves are different problems, so the
// column says which: a sample nobody has drawn is a patient who has not come to
// the counter, and only the floor can move that. A sample already at the bench is
// the lab's own turnaround and there is nothing to fetch.

// The hospital lab's own pane. Same shell as the order pane above, with every
// action removed: there is no sample here for this technician to advance and no
// report for them to upload. What it adds is the per-case breakdown the card can
// only summarise — a patient with three samples usually has three different
// states, and "2 still out" does not say which two.
// One patient's hospital-lab row. Extracted because the settled group below the
// two columns renders exactly the same card — a patient who has gone home is
// still worth opening, and duplicating this markup to say so would guarantee the
// two drift apart.
// Why the lab cannot get to this patient right now. A sample that is overdue but
// unreachable is not the technician's failure, and a card that says "Collect now"
// about someone sitting in the doctor's room is asking for the impossible.
// Where the patient is matters only while the tube is still in their arm. Once
// it is drawn, processing, reporting and entering the values have nothing to do
// with them — so a case past collection stays openable after they have gone
// home, and the lab can carry on with it.
const stillNeedsThePatient = (row) => row.stage.key === "pending";

const cannotBeWorked = (row) => stillNeedsThePatient(row) && !row.collectable;

const blockedReason = (row) => {
  if (row.stage.key !== "pending") return null;
  if (row.inARoom) return `In the ${(row.station || "").toLowerCase()} room — collect once free`;
  if (row.finished) return "Patient has left — sample can no longer be taken";
  return null;
};

function HealthrayCard({ row, onOpen, readOnly = false }) {
  // A row nobody can act on must not be a button: it would take focus, look
  // pressable and do nothing.
  const Card = readOnly ? "div" : "button";
  const pill = stationPill(row);
  const mins = minutesSince(row.stageAt);
  const blocked = blockedReason(row);
  // A sample nobody has collected an hour after it was ordered is the one thing
  // on this read-only list worth chasing, so it is the only thing marked.
  const late = row.stage.key === "pending" && mins !== null && mins > 60;
  return (
    <Card
      {...(readOnly
        ? { className: "pt-card hr-case is-unreachable is-readonly", "aria-disabled": "true" }
        : {
            type: "button",
            className: `pt-card hr-case${blocked ? " is-unreachable" : ""}`,
            onClick: () => onOpen(row.patientId),
          })}
    >
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
            row.orderedBy && `Ordered by ${row.orderedBy}`,
            row.registeredAt && clock(row.registeredAt),
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
        <div className="pc-meta">
          {[
            `${row.cases} ${row.cases === 1 ? "case" : "cases"}`,
            row.outstanding > 0
              ? `${row.outstanding} still out`
              : row.reportedOn
                ? `all reported by ${clock(row.reportedOn)}`
                : "all reported",
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
        <div className="pc-tests">🔬 {row.tests.join(" · ") || "No tests listed"}</div>
        {blocked && <div className="lab-blocked">⏸ {blocked}</div>}
        <div className="steps">
          {row.steps.map((step, i) => (
            <span key={step.name}>
              <span className={`step step-${step.state}`}>
                {step.name}
                {step.state === "done" ? " ✓" : ""}
              </span>
              {i < row.steps.length - 1 && <span className="step-arr">›</span>}
            </span>
          ))}
        </div>
      </div>
      <div className="pc-r">
        <div className={`sp ${blocked ? "sp-process" : row.stage.pill}`}>
          {blocked ? (row.finished ? "Not taken" : "Not free yet") : row.stage.label}
        </div>
        {mins !== null && <div className={`pc-time${late ? " late" : ""}`}>{mins}m</div>}
        <div className="pc-tlbl">{row.stage.since}</div>
        {/* Two different questions, so two pills: what the LAB is doing with the
            sample, and where the PATIENT is standing while it happens. */}
        <div className="hr-where">
          <div className={`sp ${pill.cls}`}>{pill.text}</div>
          <div className="pc-tlbl">{pill.sub}</div>
        </div>
      </div>
    </Card>
  );
}

function HealthrayCasePane({
  row,
  onClose,
  onAction,
  onUploadCase,
  onViewReport,
  onDeleteReport,
  onResultsSaved,
  onResultsFailed,
  isAdmin,
  busy,
  room,
}) {
  // Once "done" is on the record the report is settled: view only.
  const caseIsDone = (c) => (c.actions || []).some((a) => a.action === "report_uploaded");

  // Results — typed values or an attached report — are the analyzer bench's
  // work. The collection room has not run anything, so offering it a form for
  // numbers that do not exist yet is the screen inviting a fiction; it is also
  // the wrong person, which is the whole reason for two rooms.
  // (35-LAB-TWO-ROOM-SPLIT-PLAN.md §5.2.)
  const atTheBench = room !== "collection";
  const paneRef = useRef(null);
  const caseFileRef = useRef(null);
  const [uploadFor, setUploadFor] = useState(null);
  const [dragCase, setDragCase] = useState(null);
  useDismiss(!!row, onClose, paneRef);
  if (!row) return null;

  const pill = stationPill(row);
  return (
    <div className="detail-overlay">
      <div className="detail-pane" ref={paneRef} role="dialog" aria-label="Hospital lab cases">
        <div className="dp-head">
          <div className="dp-name">{row.name}</div>
          <div className="dp-meta">
            {[
              row.age && row.sex ? `${row.age}${row.sex[0]}` : row.age && `${row.age}y`,
              row.fileNo,
              `${row.cases} ${row.cases === 1 ? "case" : "cases"} today`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          <div className="dp-acts">
            <button className="rbtn" onClick={onClose}>
              ← Back
            </button>
            <span className={`sp ${pill.cls}`}>{pill.text}</span>
            {/* The card renders this and the pane did not, so the pane dropped the
                one line that says a "With Chief Endocrinologist" patient is queued
                rather than held — the exact contradiction the pill provokes. */}
            {pill.sub && <span className="dp-pill-sub">{pill.sub}</span>}
          </div>
        </div>

        <input
          ref={caseFileRef}
          type="file"
          accept="application/pdf,image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && uploadFor) onUploadCase(uploadFor, file);
            e.target.value = "";
            setUploadFor(null);
          }}
        />
        <div className="dp-scroll">
          <div className="dp-inner">
            <div className="dp-sec">
              <div className="dp-sec-title">Where this patient is</div>
              <div className="dp-hint">
                {row.labOnly
                  ? "Booked for the test only — no consultation today, so nobody downstream is waiting on this result. They are checked in, so the lab can call them over."
                  : row.station
                    ? row.finished
                      ? `The visit is over — ${row.station.toLowerCase()}. Any result still running will land on the chart after they have gone home.`
                      : row.awaitingResults && row.stage.key === "pending"
                        ? `Nothing has been drawn yet, so there is no report to wait for. They are at ${row.statusLabel || row.station} and still on the floor — collect now, before they leave.`
                        : row.awaitingResults
                          ? `Waiting for today's lab reports. On the board they sit at ${row.statusLabel || row.station}, and the result is what releases them.`
                          : row.waiting
                            ? `${row.statusLabel || row.station} — queued in the ${row.station} column, nobody has them in a room. Free to call.`
                            : `${row.statusLabel || row.station} — somebody has them in a room right now. Collect once they are free.`
                    : row.lastSeenOn
                      ? `No OPD appointment today — consulted on ${shortDate(row.lastSeenOn)} and back for the sample only.`
                      : "No OPD visit on record — the sample was taken outside the OPD floor."}
              </div>
              {row.awaitingResults && row.stage.key !== "pending" && (
                <div className="dp-hint">
                  Uploading the report sets them <strong>&ldquo;Results ready&rdquo;</strong> on the
                  MO and consultant queues, which is what releases them. Until then they wait,
                  whatever column the board files them under.
                </div>
              )}
              <div className="steps" style={{ marginTop: 8 }}>
                {row.steps.map((step, i) => (
                  <span key={step.name}>
                    <span className={`step step-${step.state}`}>
                      {step.name}
                      {step.state === "done" ? " ✓" : ""}
                    </span>
                    {i < row.steps.length - 1 && <span className="step-arr">›</span>}
                  </span>
                ))}
              </div>
            </div>

            <div className="dp-sec">
              <div className="dp-sec-title">
                Cases at the hospital lab — {row.outstanding} of {row.cases} still out
              </div>
              {row.caseList.map((c) => (
                <div className="hr-case-block" key={c.caseNo}>
                  <div className="hr-case-top">
                    <span className="badge b-ink">Case {c.caseNo}</span>
                    {/* The STAGE, not the old `state` field. `state` is derived
                        from results_synced alone, so it called an uncollected
                        sample "Awaiting results" — true of the results and
                        nonsense about the case, which has not reached the lab. */}
                    <span className={`sp ${c.stage.pill}`}>{c.stage.label}</span>
                  </div>
                  {c.tests.map((t) => (
                    <div className="test-row" key={t}>
                      <div className="tr-name">{t}</div>
                      <div className="tr-status">
                        <span className="badge b-ink">{c.stage.label}</span>
                      </div>
                    </div>
                  ))}
                  {c.tests.length === 0 && <div className="dp-hint">No tests listed.</div>}
                  {c.orderedBy && (
                    <div className="dp-hint">
                      Ordered by <strong>{c.orderedBy}</strong>
                    </div>
                  )}
                  {/* The one thing the stage cannot say: some panels are already
                      back while the lab works through the rest. */}
                  {c.synced && !c.reported && (
                    <div className="dp-hint">
                      Partial — some panels are already back, the lab is still entering the rest.
                    </div>
                  )}
                  {/* One row per rung, built from the ladder — HealthRay's clock
                      where it has one, the floor's own record where it does not.
                      Hardcoding HealthRay's four left the two handoff steps off
                      the timeline entirely: a sample the collection room had
                      sent showed the time on a hint underneath while the strip
                      above it still read "—" against every lab step.

                      A rung the case is demonstrably past with no time on it
                      shows ✓ rather than "—": the fact and the time are separate
                      claims, and only one of them is missing. */}
                  <div className="hr-times">
                    {LAB_RUNGS.map((r) => {
                      const at =
                        (r.healthrayAt && c[r.healthrayAt]) ||
                        (c.actions || []).find((a) => a.action === r.action)?.at ||
                        (stageIndexOf(c.stage.key) > stageIndexOf(r.key) ? "done" : null);
                      return (
                        <div className={`hr-time${at ? "" : " is-pending"}`} key={r.key}>
                          <span>{r.timelineLabel}</span>
                          <strong>{at === "done" ? "✓" : at ? clock(at) : "—"}</strong>
                        </div>
                      );
                    })}
                  </div>
                  {/* Only says the file is missing once one could exist. Before
                      the sample is drawn there is nothing to have a report of,
                      and "No report file yet" reads as a problem rather than as
                      the obvious. */}
                  {(c.hasReport || (atTheBench && c.canHaveReport)) && (
                    <div className="dp-hint">
                      {c.hasReport ? "Report file stored" : "No report file yet"}
                    </div>
                  )}
                  {/* The file is openable from the moment it is stored, in the
                      viewer the rest of the app uses. Replacing or removing it
                      stops the moment the case is marked done: at that point the
                      report is what the MO and the consultant were told about,
                      and pulling it out from under them is not this screen's
                      to do. Undo "Done" first. */}
                  {c.hasReport && (
                    <div className="hr-acts">
                      <button
                        type="button"
                        className="st-btn"
                        onClick={() => onViewReport(c)}
                        disabled={!c.reportDocId}
                      >
                        📄 View report
                      </button>
                      {!caseIsDone(c) && (
                        <>
                          <button
                            type="button"
                            className="st-btn"
                            disabled={busy}
                            onClick={() => {
                              setUploadFor(c.caseNo);
                              caseFileRef.current?.click();
                            }}
                          >
                            🔁 Replace
                          </button>
                          <button
                            type="button"
                            className="st-btn"
                            disabled={busy}
                            onClick={() => onDeleteReport(c.caseNo)}
                          >
                            🗑 Remove
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {/* 06-PHASE-2-PLAN §0.4: the lab screen confirms and attributes.
                      Nothing here reaches HealthRay, and the buttons say so rather
                      than implying they moved the sample. */}
                  {(() => {
                    // What has been recorded, plus the ONE step that comes next —
                    // the same shape the Gini queue's cards have. Offering every
                    // step at once let a mis-tap record results on a tube nobody
                    // had drawn; the service refuses that now, and the screen
                    // should not ask for it either.
                    const done = CASE_ACTIONS.filter((a) =>
                      (c.actions || []).some((x) => x.action === a.action),
                    );
                    const next = c.nextAction
                      ? CASE_ACTIONS.find((a) => a.action === c.nextAction.action)
                      : null;
                    if (!done.length && !next) return null;
                    // Only the step that still needs the PATIENT can be blocked by
                    // where they are standing. Processing and results happen at the
                    // bench — telling a technician the sample "can no longer be
                    // taken" while they are running it is the screen contradicting
                    // itself, and it stranded every case of a patient who left.
                    const blocked = !!next?.needsPatient && !row.collectable;
                    const hint = !next
                      ? null
                      : !blocked
                        ? next.hint
                        : row.finished
                          ? "This patient has left the floor — the sample can no longer be taken."
                          : `This patient is in the ${(row.station || "").toLowerCase()} room right now. Collect once they are free.`;
                    return (
                      <>
                        <div className="dp-sec-title">Update status</div>
                        {hint && <div className="dp-hint">{hint}</div>}
                        <div className="hr-acts">
                          {done.map((a) => (
                            <button
                              key={a.action}
                              type="button"
                              className="st-btn is-done"
                              disabled={busy}
                              onClick={() => onAction(c.caseNo, a.action, true)}
                            >
                              ✓ {a.doneLabel}
                            </button>
                          ))}
                          {next && (
                            <button
                              type="button"
                              className="st-btn st-btn-tl"
                              disabled={busy || blocked}
                              onClick={() => onAction(c.caseNo, next.action, false)}
                            >
                              {c.nextAction.label}
                            </button>
                          )}
                        </div>
                      </>
                    );
                  })()}
                  {/* Typed values, for a hospital case as much as a Gini order
                      (32-LAB-TYPED-RESULTS-PLAN.md). That plan built the form
                      against `giniflow_lab_orders` only — six rows in the table's
                      whole history — so at this hospital, where every lab is
                      raised on HealthRay, the lab could never type a value.
                      Gated on the sample being in the lab's hands, the same rule
                      the Gini form uses, and available afterwards so a number can
                      be corrected or added late. */}
                  {atTheBench && c.canHaveReport && (
                    <>
                      <div className="dp-sec-title">
                        Enter results — values the doctor can trend
                      </div>
                      <LabResultsForm
                        // Keyed on the case: the pane is reused when the
                        // technician clicks from one patient to the next, and
                        // without this the form would carry the first patient's
                        // typed values onto the second's record.
                        key={c.caseNo}
                        caseNo={c.caseNo}
                        onSaved={(r) => onResultsSaved?.(row, r)}
                        onFailed={(e) => onResultsFailed?.(e)}
                      />
                    </>
                  )}
                  {/* The reference design's own upload section (gini-stations.html
                      `lp-upload`): a drop zone reading "Tap to upload lab report
                      PDF", not a button. Its ⚡ note is deliberately NOT copied —
                      it promises the upload flips the patient to "Results ready"
                      on the MO board, which is true of a Gini order and false
                      here, where nothing we store changes the case at HealthRay.

                      Gated on the case being able to HAVE a report, not on the
                      sample having been drawn. A printed report may be in
                      someone's hand before HealthRay stamps `reported_on`, so
                      requiring that would keep a real result off the chart — but
                      a tube the floor drew twenty minutes ago has nothing behind
                      it, and offering to upload one there is the screen inviting
                      a fiction. */}
                  {isAdmin && atTheBench && !c.hasReport && c.canHaveReport && (
                    <>
                      <div className="dp-sec-title">Upload report</div>
                      <button
                        type="button"
                        className={`upload-area${dragCase === c.caseNo ? " drag" : ""}`}
                        disabled={busy}
                        onClick={() => {
                          setUploadFor(c.caseNo);
                          caseFileRef.current?.click();
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragCase(c.caseNo);
                        }}
                        onDragLeave={() => setDragCase(null)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragCase(null);
                          const file = e.dataTransfer.files?.[0];
                          if (file) onUploadCase(c.caseNo, file);
                        }}
                      >
                        <div className="ua-ico">📄</div>
                        <div className="ua-t">Tap to upload lab report PDF</div>
                        <div className="ua-s">PDF · JPG · PNG accepted · Max 10MB</div>
                      </button>
                      <div className="dp-hint">
                        Stored on the patient&apos;s chart, where the doctor and the patient app
                        read it. If nothing else is outstanding for them today it also turns the
                        patient <strong>&ldquo;Results ready&rdquo;</strong> on the MO and
                        consultant queues. It does not change the case at HealthRay.
                      </div>
                    </>
                  )}
                  {(c.actions || []).map((x) => (
                    <div className="dp-hint" key={x.action}>
                      {ACTION_LABEL[x.action]} by <strong>{x.by}</strong> at {clock(x.at)} —
                      recorded here only, not sent to HealthRay.
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div className="dp-sec">
              <div className="dp-sec-title">What this pane can and cannot do</div>
              <div className="dp-hint">
                These samples were ordered on HealthRay and run by the hospital lab, so they never
                enter the Gini Flow queue above and nothing here changes their state over there —
                results arrive on their own through the lab sync. What is recorded here is who did
                what about a sample, so a tube nobody has collected has a name against it.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LabRoom({ room = null }) {
  const [toast, setToast] = useState("");
  const [confirmUpload, setConfirmUpload] = useState(null);
  const [openStages, setOpenStages] = useState({});
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const toastTimer = useRef(null);
  // Must stay above useLabQueue: `filter` is a const, so it is in the temporal
  // dead zone until this line and the query below reads it on the first render.
  const [filter, setFilter] = useState("all");
  const { data, isLoading } = useLabQueue(undefined, debounced, filter, room);

  // The server has the last word on which room this is. A role that holds only
  // one bench is pinned to it whatever the page asked for (the route's own
  // capability check, and `attachLabRoom` behind it), so a collection
  // technician opening the combined screen must not be shown five analyzer
  // counters reading zero. `?? room` covers the first render, before any
  // response has arrived.
  const inRoom = data?.room ?? room;
  const GROUPS = groupsFor(inRoom);
  const LAB_FILTERS = filtersFor(inRoom);
  // The rungs this room OWNS, and the ones it can only watch. The analyzer room
  // watches two — collected and sent — because a tube carried over without
  // anybody tapping "sent" is still on its bench, and both belong in one inbox.
  // The collection room watches none, so its own first rung opens the page.
  const owned = GROUPS.filter((g) => !inRoom || g.room === inRoom);
  const watched = GROUPS.filter((g) => inRoom && g.room !== inRoom);
  const ENTRY_GROUPS = watched.length ? watched : owned.slice(0, 1);
  const LAST_GROUP = owned[owned.length - 1];
  const FIRST_GROUP = ENTRY_GROUPS[0];
  const MID_GROUPS = owned.filter((g) => g !== LAST_GROUP && !ENTRY_GROUPS.includes(g));
  const isEntryFilter = (f) => ENTRY_GROUPS.some((g) => g.filterKey === f);
  // What the two ends of the page are. The collection room opens on patients
  // waiting to be called and closes on the samples it has sent; the analyzer
  // room opens on its inbox — tubes sent and not yet received — and closes on
  // the reports it has filed. Both are "the first rung and the last rung", so
  // the page asks the ladder rather than naming stages of its own.
  const rooming = ROOM_COPY[inRoom] || ROOM_COPY.all;
  const live = useGiniflowLive({ date: data?.date });
  const advance = useAdvanceSample();
  const upload = useUploadReport();
  const [openOrderId, setOpenOrderId] = useState(null);
  const [openCaseId, setOpenCaseId] = useState(null);
  const [showAllUploaded, setShowAllUploaded] = useState(false);
  const [viewingDoc, setViewingDoc] = useState(null);
  const deleteCaseReport = useDeleteLabCaseReport();

  const healthray = data?.healthray || [];
  const caseCount = healthray.reduce((n, r) => n + r.cases, 0);

  // Both sources, one strip. The Gini queue's buckets and the hospital lab's
  // stages are the same five steps; counting only the first is what made every
  // number read 0 on a day the lab ran 46 cases.
  const stage = data?.stageCounts || {};
  // Whole-day Gini bucket totals from the server. The arrays hold only the
  // filtered group now, so their lengths cannot feed the stats strip.
  const bucket = data?.bucketCounts || {};
  const counts = Object.fromEntries(
    GROUPS.map((g) => [g.key, (bucket[g.key] ?? 0) + (stage[g.stageKey] ?? 0)]),
  );
  const queueCounts = Object.fromEntries(GROUPS.map((g) => [g.key, data?.[g.key]?.length ?? 0]));
  const term = debounced.trim();
  // Which section the page is narrowed to. "all" is the full page as before.

  // Where the patient is standing only gates the one step that needs them in
  // front of you. A tube already sent to the lab is worked at the bench, so the
  // analyzer room's inbox never holds anybody back for being in a room.
  const gatedOnThePatient = ENTRY_GROUPS.some((g) => g.stageKey === "pending");
  // The three-way split of a finished patient — still on the floor, lab-only,
  // gone home — is a statement about who downstream is waiting on the report.
  // The collection room's last column is samples it has SENT, where nothing has
  // been reported yet and that question has no answer, so it lists them plainly.
  const doneSplit = LAST_GROUP.stageKey === "reported" ? DONE_SPLIT : [SENT_LIST];
  const hrFirst = healthray.filter((r) => ENTRY_GROUPS.some((g) => g.stageKey === r.stage.key));
  const toCall = [
    ...ENTRY_GROUPS.flatMap((g) =>
      (data?.[g.key] || []).map((row) => ({ source: "giniflow", row })),
    ),
    ...hrFirst
      .filter((r) => !gatedOnThePatient || r.collectable)
      .map((row) => ({ source: "healthray", row })),
  ].sort(byTimeAsc);
  const unreachable = gatedOnThePatient
    ? hrFirst
        .filter((r) => !r.collectable)
        .map((row) => ({ source: "healthray", row }))
        .sort(byTimeAsc)
    : [];

  const doneRows = [
    ...(data?.[LAST_GROUP.key] || []).map((row) => ({
      source: "giniflow",
      row,
      onFloor: !!row.station && !row.finished,
    })),
    ...healthray
      .filter((r) => r.stage.key === LAST_GROUP.stageKey)
      .map((row) => ({ source: "healthray", row, onFloor: !!row.station && !row.finished })),
  ].sort(byTimeAsc);
  const doneTotal = doneRows.length;

  const stageVisible = (k) =>
    (data?.[k] || []).length + healthray.filter((r) => r.stage.key === GROUP_TO_STAGE[k]).length;
  // Straight from the server, which counts the whole day (already narrowed by
  // the search, because that is server-side too). The local values are the
  // fallback for a response that predates this field — under a filter they
  // hold one group and would read 0 everywhere else.
  const serverCounts = data?.counts;
  const filterCounts = serverCounts || {
    ...Object.fromEntries(GROUPS.map((g) => [g.filterKey, stageVisible(g.key)])),
    [LAST_GROUP.filterKey]: doneRows.length,
  };
  const visibleTotal = Object.values(filterCounts).reduce((a, b) => a + b, 0);

  const unifiedTotal = Object.values(queueCounts).reduce((a, b) => a + b, 0) + healthray.length;

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };

  const onAdvance = (order, to) =>
    advance.mutate(
      { orderId: order.orderId, to },
      {
        onSuccess: (r) =>
          showToast(
            r.unchanged
              ? `${order.name} was already past that step`
              : to === "uploaded"
                ? `📤 ${order.name}'s report uploaded — MO and doctor now see "Results ready"`
                : `✓ ${order.name} — ${to.replace(/_/g, " ")}`,
          ),
        onError: (e) =>
          showToast(e?.response?.data?.error || "Could not update — nothing was changed"),
      },
    );

  const onResultsSaved = (order, r) =>
    showToast(
      // A value the lab already has from another source is not saved, and a
      // toast that counted it would send the technician away believing a number
      // is on the record that is not.
      r.skipped?.length
        ? `🧪 ${r.saved} saved · ${r.skipped.join(", ")} already reported today from another source — not overwritten`
        : `🧪 ${r.saved} result${r.saved === 1 ? "" : "s"} saved for ${order.name} — the doctor sees them as labs now`,
    );

  const onResultsFailed = (e) =>
    showToast(e?.response?.data?.error || "Could not save those results — nothing was written");

  const onUpload = (order, file, refuseWith, confirmAdditional = false) => {
    if (refuseWith) return showToast(refuseWith);
    return upload.mutate(
      { orderId: order.orderId, file, confirmAdditional },
      {
        onSuccess: () =>
          showToast(`📤 ${order.name}'s report uploaded — MO and doctor now see "Results ready"`),
        onError: (e) => {
          const d = e?.response?.data;
          if (d?.needsConfirmation === "additional_report") {
            return setConfirmUpload({
              kind: "order",
              order,
              file,
              at: d.existingUploadedAt || null,
            });
          }
          showToast(d?.error || "Upload failed — the report was not saved");
        },
      },
    );
  };

  // Resolved from the live queue, not held in state: the pane then follows the
  // order as it moves buckets instead of showing a stale copy of it.
  const allOrders = GROUPS.flatMap((g) => (data?.[g.key] || []).map((o) => ({ o, g })));
  const openPair = allOrders.find(({ o }) => o.orderId === openOrderId) || null;
  const openOrder = openPair?.o || null;
  const openGroup = openPair?.g || FIRST_GROUP;
  const closePane = useCallback(() => setOpenOrderId(null), []);
  const closeCasePane = useCallback(() => setOpenCaseId(null), []);
  const caseAction = useMarkLabCaseAction();
  const caseUpload = useUploadLabCaseReport();
  const isAdmin = useAuthStore((st) => st.currentDoctor?.role) === "admin";
  const onUploadCase = (caseNo, file, confirmAdditional = false) => {
    if (file.size > 10 * 1024 * 1024) return showToast("File is larger than 10 MB — not uploaded");
    caseUpload.mutate(
      { caseNo, file, confirmAdditional },
      {
        // The toast reports which of the two things happened. Saying "Results
        // ready" when the guard declined would be the message contradicting the
        // board it claims to have changed.
        onSuccess: (res) =>
          showToast(
            res?.markedResultsReady
              ? `📤 Report uploaded — MO and doctor now see "Results ready"`
              : `📤 Report filed on the chart — other results still outstanding, so the queue is unchanged`,
          ),
        onError: (e) => {
          const d = e?.response?.data;
          if (d?.needsConfirmation === "additional_report") {
            return setConfirmUpload({
              kind: "case",
              caseNo,
              file,
              source: d.existingSource || null,
            });
          }
          showToast(d?.error || "Upload failed");
        },
      },
    );
  };
  // The viewer the rest of the app uses, fed the chart row the file landed on.

  const onDeleteReport = (caseNo) =>
    deleteCaseReport.mutate(
      { caseNo },
      {
        onSuccess: () => showToast("🗑 Report removed — the case is open again"),
        onError: (e) => showToast(e?.response?.data?.error || "Could not remove that report"),
      },
    );

  const onCaseAction = (caseNo, action, undo) =>
    caseAction.mutate(
      { caseNo, action, undo },
      {
        onSuccess: () =>
          showToast(undo ? "Undone — nothing recorded" : `✓ Recorded on case ${caseNo}`),
        onError: (e) => showToast(e?.response?.data?.error || "Could not record that"),
      },
    );

  return (
    <div className="gf">
      <StationNotice station="lab" />
      <div className="rail">
        <div className="rl">{rooming.station}</div>
        <div className="rsep" />
        <span className="rail-title">
          {rooming.title} ·{" "}
          {new Date().toLocaleDateString("en-IN", {
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </span>
        <div className="rr">
          <input
            className="rail-search"
            type="search"
            value={search}
            placeholder="Search name, file no, test…"
            aria-label="Search today's lab patients"
            onChange={(e) => setSearch(e.target.value)}
          />
          <LiveBadge live={live} className="tr-live" />
          <a className="rbtn" href="/giniflow/stations">
            ← Stations
          </a>
        </div>
      </div>

      <div className="scroll">
        <div className="inner">
          <div className="stats stats--compact">
            {visibleRungs(inRoom).map((r) => (
              <div className="stat" key={r.key}>
                <div className="sv" style={{ color: STAT_COLOUR[r.key] }}>
                  {counts[r.bucket] ?? 0}
                </div>
                <div>
                  <div className="sl">{r.statLabel}</div>
                  <div className="ss">{r.statSub}</div>
                </div>
              </div>
            ))}
          </div>

          <p className="stats-note">
            Counted by case. A patient with several samples appears once per case here, and once by
            name in the columns below.
          </p>

          <div className="workflow-note lab-note">
            <span className="wn-ico">⚡</span>
            <span>
              <strong>Workflow:</strong> When you upload a report → the patient's status on the MO
              and SD dashboard changes to <strong>"Results ready"</strong> automatically. MO sees it
              in real time.
            </span>
          </div>

          {isLoading && <div className="empty-note">Loading…</div>}

          {!isLoading && (
            <div
              className="sq-filters sq-filters--page"
              role="group"
              aria-label="Filter the lab queue"
            >
              <button
                type="button"
                className={filter === "all" ? "on" : ""}
                aria-pressed={filter === "all"}
                onClick={() => setFilter("all")}
              >
                All
                <span className="sq-fcount">{visibleTotal}</span>
              </button>
              {/* A chip for a stage nobody is in filters to an empty page, so it
                  is left out until it has somebody — except the one currently
                  selected, which has to stay for the way back to All. */}
              {LAB_FILTERS.filter((f) => filterCounts[f.key] || filter === f.key).map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={filter === f.key ? "on" : ""}
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(filter === f.key ? "all" : f.key)}
                >
                  {f.label}
                  <span className="sq-fcount">{filterCounts[f.key]}</span>
                </button>
              ))}
            </div>
          )}

          {!isLoading && MID_GROUPS.some((g) => filter === "all" || filter === g.key) && (
            <div className="lab-running">
              {MID_GROUPS.filter((g) => filter === "all" || filter === g.key).map((group) => {
                const orders = data?.[group.key] || [];
                const cases = healthray.filter((r) => r.stage.key === GROUP_TO_STAGE[group.key]);
                const total = orders.length + cases.length;
                const open = openStages[group.key] ?? total > 0;
                return (
                  <div key={group.key}>
                    <h2 className="sq-gh">
                      <button
                        type="button"
                        className="sq-toggle"
                        aria-expanded={open}
                        aria-controls={`lab-stage-${group.key}`}
                        onClick={() => setOpenStages((v) => ({ ...v, [group.key]: !open }))}
                      >
                        <span className={`sq-chev${open ? " open" : ""}`} aria-hidden="true">
                          ▸
                        </span>
                        {group.label}
                        <span className="sq-count">
                          {orders.length} Gini · {cases.length} hospital
                        </span>
                      </button>
                    </h2>
                    <div id={`lab-stage-${group.key}`} hidden={!open}>
                      {!total ? (
                        <div className="empty-note">—</div>
                      ) : (
                        <div className="pt-list">
                          {[
                            ...cases.map((row) => ({ source: "healthray", row })),
                            ...orders.map((row) => ({ source: "giniflow", row })),
                          ]
                            .sort(byTimeAsc)
                            .map((r) =>
                              r.source === "healthray" ? (
                                <HealthrayCard
                                  key={`hr-${caseRowKey(r.row)}`}
                                  row={r.row}
                                  onOpen={() => setOpenCaseId(caseRowKey(r.row))}
                                  readOnly={cannotBeWorked(r.row)}
                                />
                              ) : (
                                <LabCard
                                  key={r.row.orderId}
                                  order={r.row}
                                  group={group}
                                  onAdvance={onAdvance}
                                  onUpload={onUpload}
                                  onOpen={(o) => setOpenOrderId(o.orderId)}
                                  busy={advance.isPending || upload.isPending}
                                />
                              ),
                            )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!isLoading &&
            (filter === "all" || isEntryFilter(filter) || filter === LAST_GROUP.filterKey) && (
              <div className={`ar-split${filter === "all" ? "" : " ar-split--one"}`}>
                {(filter === "all" || isEntryFilter(filter)) && (
                  <div className="ar-col">
                    <div className="grp-lbl">
                      {rooming.firstLabel}
                      <span className="grp-split">{toCall.length}</span>
                    </div>
                    {!toCall.length && <div className="empty-note">{rooming.firstEmpty}</div>}
                    <div className="pt-list">
                      {toCall.map((r) =>
                        r.source === "giniflow" ? (
                          <LabCard
                            key={`g-${r.row.orderId}`}
                            order={r.row}
                            group={FIRST_GROUP}
                            onAdvance={onAdvance}
                            onUpload={onUpload}
                            onOpen={(o) => setOpenOrderId(o.orderId)}
                            busy={advance.isPending || upload.isPending}
                          />
                        ) : (
                          <HealthrayCard
                            key={`h-${caseRowKey(r.row)}`}
                            row={r.row}
                            onOpen={() => setOpenCaseId(caseRowKey(r.row))}
                          />
                        ),
                      )}
                    </div>

                    {UNREACHABLE_GROUPS.map((g) => {
                      const rows = unreachable.filter((r) => g.holds(r.row));
                      if (!rows.length) return null;
                      return (
                        <div key={g.key}>
                          <div className="grp-lbl grp-sub">
                            {g.label}
                            <span className="grp-split">{rows.length}</span>
                          </div>
                          <div className="grp-hint">{g.hint}</div>
                          <div className="pt-list">
                            {rows.map((r) => (
                              <HealthrayCard
                                key={`u-${caseRowKey(r.row)}`}
                                row={r.row}
                                onOpen={() => setOpenCaseId(caseRowKey(r.row))}
                                readOnly
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {(filter === "all" || filter === LAST_GROUP.filterKey) && (
                  <div className="ar-col">
                    <div className="grp-lbl grp-lbl-sp">
                      {rooming.lastLabel}
                      <span className="grp-split">{doneTotal}</span>
                    </div>
                    {!doneTotal && <div className="empty-note">{rooming.lastEmpty}</div>}
                    {doneSplit.map((part) => {
                      const rows = doneRows.filter(part.holds);
                      if (!rows.length) return null;
                      const shown =
                        part.key === "left" && !showAllUploaded
                          ? rows.slice(0, UPLOADED_PREVIEW)
                          : rows;
                      return (
                        <div key={part.key}>
                          <div className="grp-lbl grp-sub">
                            {part.label}
                            <span className="grp-split">{rows.length}</span>
                          </div>
                          <div className="grp-hint">{part.hint}</div>
                          <div className="pt-list">
                            {shown.map((r) =>
                              r.source === "giniflow" ? (
                                <LabCard
                                  key={`dg-${r.row.orderId}`}
                                  order={r.row}
                                  group={LAST_GROUP}
                                  onAdvance={onAdvance}
                                  onUpload={onUpload}
                                  onOpen={(o) => setOpenOrderId(o.orderId)}
                                  busy={advance.isPending || upload.isPending}
                                />
                              ) : (
                                <HealthrayCard
                                  key={`dh-${caseRowKey(r.row)}`}
                                  row={r.row}
                                  onOpen={() => setOpenCaseId(caseRowKey(r.row))}
                                />
                              ),
                            )}
                          </div>
                          {part.key === "left" && rows.length > UPLOADED_PREVIEW && (
                            <button
                              type="button"
                              className="more-note more-btn"
                              aria-expanded={showAllUploaded}
                              onClick={() => setShowAllUploaded((v) => !v)}
                            >
                              {showAllUploaded
                                ? `Show fewer — ${rows.length} left the floor`
                                : `+ ${rows.length - UPLOADED_PREVIEW} more who left the floor — show all`}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          {/* A filter can land on a section that today has nobody in it, and an
              empty page with no explanation reads as a fault rather than as an
              empty filter. */}
          {!isLoading && filter !== "all" && !filterCounts[filter] && (
            <div className="empty-note">
              Nobody in {LAB_FILTERS.find((f) => f.key === filter)?.label || "this group"}
              {term ? ` matching “${search.trim()}”` : ""}.{" "}
              <button type="button" className="sq-clearfilter" onClick={() => setFilter("all")}>
                Show all
              </button>
            </div>
          )}

          {!isLoading && term && !visibleTotal && (
            <div className="empty-note">Nobody matches “{search.trim()}”.</div>
          )}

          {!isLoading && !term && !unifiedTotal && (
            <div className="empty-note">
              No lab work today — neither a Gini Flow order nor a hospital-lab case. A patient lands
              here the moment tests are ordered on the Chief Endocrinologist station, or the
              hospital lab registers a case of their own.
            </div>
          )}
        </div>
      </div>

      {viewingDoc && <PdfViewerModal doc={viewingDoc} onClose={() => setViewingDoc(null)} />}

      <HealthrayCasePane
        room={inRoom}
        onViewReport={(c) =>
          setViewingDoc({
            id: c.reportDocId,
            title: `Lab report — case ${c.caseNo}`,
            doc_type: "lab_report",
          })
        }
        onDeleteReport={onDeleteReport}
        onResultsSaved={onResultsSaved}
        onResultsFailed={onResultsFailed}
        row={
          openCaseId == null ? null : healthray.find((r) => caseRowKey(r) === openCaseId) || null
        }
        onClose={closeCasePane}
        onAction={onCaseAction}
        onUploadCase={onUploadCase}
        isAdmin={isAdmin}
        busy={caseAction.isPending || caseUpload.isPending}
      />

      <LabDetailPane
        room={inRoom}
        onViewReport={setViewingDoc}
        order={openOrder}
        group={openGroup}
        busy={advance.isPending || upload.isPending}
        onClose={closePane}
        onAdvance={onAdvance}
        onUpload={onUpload}
        onResultsSaved={onResultsSaved}
        onResultsFailed={onResultsFailed}
      />

      {confirmUpload && (
        <div className="modal-back" onClick={() => setConfirmUpload(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">A report is already here</h3>
            <p className="modal-body">
              {confirmUpload.kind === "order"
                ? `${confirmUpload.order.name} already has a report on this order${
                    confirmUpload.at ? `, uploaded at ${clock(confirmUpload.at)}` : ""
                  }.`
                : `This case already has a report from the ${confirmUpload.source || "hospital lab"}.`}{" "}
              Uploading <strong>{confirmUpload.file.name}</strong> adds it alongside — nothing is
              replaced or deleted.
            </p>
            <div className="modal-acts">
              <button className="st-btn st-btn-g" onClick={() => setConfirmUpload(null)}>
                Cancel
              </button>
              <button
                className="st-btn st-btn-grn"
                onClick={() => {
                  const c = confirmUpload;
                  setConfirmUpload(null);
                  if (c.kind === "order") onUpload(c.order, c.file, null, true);
                  else onUploadCase(c.caseNo, c.file, true);
                }}
              >
                Add as another report
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast show">{toast}</div>}
    </div>
  );
}
