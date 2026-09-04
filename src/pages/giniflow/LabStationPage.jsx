import { useCallback, useEffect, useRef, useState } from "react";
import {
  useLabQueue,
  useAdvanceSample,
  useUploadReport,
  useMarkLabCaseAction,
  useUploadLabCaseReport,
  reportHref,
} from "../../queries/hooks/useGiniflowLab";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import LiveBadge from "../../components/giniflow/LiveBadge";
import "../../styles/giniflow-station.css";
import StationNotice from "../../components/giniflow/StationNotice";
import useAuthStore from "../../stores/authStore";

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
const CASE_ACTIONS = [
  {
    action: "sample_taken",
    label: "✓ Mark sample collected",
    doneLabel: "Sample collected",
    hint: "Mark that you have collected the sample from this patient.",
    shows: (c) => !c.collected,
  },
];

const ACTION_LABEL = { sample_taken: "Sample collected" };

const shortDate = (iso) =>
  iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
    : null;

const stationPill = (r) => {
  // No visit today is not a missed check-in. These patients were consulted on an
  // earlier day and have come back for the sample alone, so the card names the
  // day they were seen instead of implying they failed to arrive.
  if (!r.station)
    return {
      cls: "sp-process",
      text: "Lab only",
      sub: r.lastSeenOn ? `seen ${shortDate(r.lastSeenOn)}` : "no OPD visit on record",
    };
  if (r.finished) return { cls: "sp-done", text: r.station, sub: "has left the floor" };
  // Somebody else has them in a room, or they are sitting in a queue. Only the
  // second is a patient the lab can call over.
  // The pill names the board COLUMN, which is what the rest of Gini Flow calls
  // this patient. The line under it has to resolve the apparent contradiction of
  // a "With SD / MO" patient the lab may collect from: the column is where they
  // are queued, not who has hold of them.
  return {
    cls: r.inARoom ? "sp-ready" : "sp-sample",
    text: r.station,
    sub: r.inARoom ? "in the room — not free" : "waiting — free to call",
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

// Each bucket, its heading, the pill on the card and what the timer is counting.
const GROUPS = [
  {
    key: "pending",
    label: "⏳ Sample pending — reception cleared payment, collect now",
    pill: "sp-sample",
    pillText: "Collect now",
    timerLabel: "since order",
  },
  {
    key: "collecting",
    label: "🧪 Collected — sample taken",
    pill: "sp-sample",
    pillText: "Collected",
    timerLabel: "since collection",
  },
  {
    key: "processing",
    label: "⚙️ Processing — samples in analyzer",
    pill: "sp-process",
    pillText: "Processing",
    timerLabel: "in analyzer",
  },
  {
    key: "ready",
    label: "✅ Results ready — upload now to notify MO",
    pill: "sp-ready",
    pillText: "Upload now",
    timerLabel: "results waiting",
  },
  {
    key: "uploaded",
    label: "📤 Uploaded today — MO notified",
    pill: "sp-done",
    pillText: "Done",
    timerLabel: "uploaded",
  },
];

const MID_GROUPS_IDX = [1, 2, 3];

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

const DONE_SPLIT = [
  {
    key: "on_floor",
    label: "Still on the floor",
    hint: "Results are back and waiting for them at the next station.",
    holds: (r) => r.onFloor,
  },
  {
    key: "left",
    label: "Left the floor",
    hint: "Nobody is waiting on these — kept for the day's record.",
    holds: (r) => !r.onFloor,
  },
];

const GROUP_TO_STAGE = {
  pending: "pending",
  collecting: "collected",
  processing: "processing",
  ready: "results",
  uploaded: "reported",
};

const MID_GROUPS = MID_GROUPS_IDX.map((i) => GROUPS[i]);

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

function LabDetailPane({ order, group, onClose, onAdvance, onUpload, busy }) {
  const paneRef = useRef(null);
  const fileRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  useDismiss(!!order, onClose, paneRef);
  if (!order) return null;

  const canUpload = ["processing", "results_ready"].includes(order.sampleStatus) && order.paid;

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
                  <div className="dp-hint">
                    {order.sampleStatus === "paid"
                      ? "Mark that you have collected the sample from this patient."
                      : order.sampleStatus === "sample_collected"
                        ? "Mark the sample as running in the analyzer."
                        : "Mark results as done when the analyzer completes."}
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
                    ? "✓ Report uploaded and the MO has been notified. This patient reads “Results ready” on every dashboard."
                    : "Upload the report below to notify the MO instantly."}
                </div>
              )}
            </div>

            {canUpload && (
              <div className="dp-sec">
                <div className="dp-sec-title">Upload report — triggers MO notification</div>
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
                <a
                  className="st-btn st-btn-g"
                  href={reportHref(order.orderId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  📄 View uploaded report
                </a>
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

function HealthrayCasePane({ row, onClose, onAction, onUploadCase, isAdmin, busy }) {
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
                {row.station
                  ? row.finished
                    ? `The visit is over — ${row.station.toLowerCase()}. Any result still running will land on the chart after they have gone home.`
                    : row.waiting
                      ? `Waiting in the ${row.station.toLowerCase()} queue.`
                      : `At ${row.station.toLowerCase()} right now.`
                  : row.lastSeenOn
                    ? `No OPD appointment today — consulted on ${shortDate(row.lastSeenOn)} and back for the sample only.`
                    : "No OPD visit on record — the sample was taken outside the OPD floor."}
              </div>
              {row.statusLabel && row.statusLabel !== row.station && (
                <div className="dp-hint">
                  Last thing observed about them: <strong>{row.statusLabel}</strong>. HealthRay has
                  no status for the workup, so a patient with the MO still reads “vitals done” until
                  a station screen moves them.
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
                  <div className="hr-times">
                    {[
                      ["Registered", c.registeredAt],
                      // The clock may be missing while the phlebotomist's own
                      // status already says done, so the fact and the time are
                      // reported separately rather than the time standing in.
                      ["Sample collected", c.collectedOn || (c.collected ? "done" : null)],
                      ["Received by lab", c.receivedOn],
                      ["Reported", c.reportedOn],
                    ].map(([label, at]) => (
                      <div className={`hr-time${at ? "" : " is-pending"}`} key={label}>
                        <span>{label}</span>
                        <strong>{at === "done" ? "✓" : at ? clock(at) : "—"}</strong>
                      </div>
                    ))}
                  </div>
                  {/* Only says the file is missing once one could exist. Before
                      the sample is drawn there is nothing to have a report of,
                      and "No report file yet" reads as a problem rather than as
                      the obvious. */}
                  {(c.hasReport || c.collected) && (
                    <div className="dp-hint">
                      {c.hasReport ? "Report file stored" : "No report file yet"}
                    </div>
                  )}
                  {/* 06-PHASE-2-PLAN §0.4: the lab screen confirms and attributes.
                      Nothing here reaches HealthRay, and the buttons say so rather
                      than implying they moved the sample. */}
                  {(() => {
                    const offered = CASE_ACTIONS.filter(
                      (a) =>
                        (a.shows(c) && row.collectable) ||
                        (c.actions || []).some((x) => x.action === a.action),
                    );
                    if (!offered.length) return null;
                    return (
                      <>
                        <div className="dp-sec-title">Update status</div>
                        <div className="dp-hint">
                          {row.collectable
                            ? offered[0].hint
                            : row.finished
                              ? "This patient has left the floor — the sample can no longer be taken."
                              : `This patient is in the ${(row.station || "").toLowerCase()} room right now. Collect once they are free.`}
                        </div>
                        <div className="hr-acts">
                          {offered.map((a) => {
                            const done = (c.actions || []).find((x) => x.action === a.action);
                            return (
                              <button
                                key={a.action}
                                type="button"
                                className={`st-btn${done ? " is-done" : " st-btn-tl"}`}
                                disabled={busy || (!done && !row.collectable)}
                                onClick={() => onAction(c.caseNo, a.action, !!done)}
                              >
                                {done ? `✓ ${a.doneLabel}` : a.label}
                              </button>
                            );
                          })}
                        </div>
                      </>
                    );
                  })()}
                  {/* The reference design's own upload section (gini-stations.html
                      `lp-upload`): a drop zone reading "Tap to upload lab report
                      PDF", not a button. Its ⚡ note is deliberately NOT copied —
                      it promises the upload flips the patient to "Results ready"
                      on the MO board, which is true of a Gini order and false
                      here, where nothing we store changes the case at HealthRay.

                      Gated on the sample having been COLLECTED, not on the case
                      being reported. A printed report may be in someone's hand
                      before HealthRay stamps `reported_on`, so requiring that
                      would keep a real result off the chart — but a sample nobody
                      has drawn cannot have a report at all, and offering to
                      upload one there is the screen inviting a fiction. */}
                  {isAdmin && !c.hasReport && c.collected && (
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

export default function LabStationPage() {
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
  const { data, isLoading } = useLabQueue(undefined, debounced);
  const live = useGiniflowLive({ date: data?.date });
  const advance = useAdvanceSample();
  const upload = useUploadReport();
  const [openOrderId, setOpenOrderId] = useState(null);
  const [openCaseId, setOpenCaseId] = useState(null);
  const [showAllUploaded, setShowAllUploaded] = useState(false);

  const healthray = data?.healthray || [];
  const caseCount = healthray.reduce((n, r) => n + r.cases, 0);

  // Both sources, one strip. The Gini queue's buckets and the hospital lab's
  // stages are the same five steps; counting only the first is what made every
  // number read 0 on a day the lab ran 46 cases.
  const stage = data?.stageCounts || {};
  const counts = {
    pending: (data?.pending?.length ?? 0) + (stage.pending ?? 0),
    collecting: (data?.collecting?.length ?? 0) + (stage.collected ?? 0),
    processing: (data?.processing?.length ?? 0) + (stage.processing ?? 0),
    ready: (data?.ready?.length ?? 0) + (stage.results ?? 0),
    uploaded: (data?.uploaded?.length ?? 0) + (stage.reported ?? 0),
  };
  const queueCounts = {
    pending: data?.pending?.length ?? 0,
    collecting: data?.collecting?.length ?? 0,
    processing: data?.processing?.length ?? 0,
    ready: data?.ready?.length ?? 0,
    uploaded: data?.uploaded?.length ?? 0,
  };
  const term = debounced.trim();

  const hrPending = healthray.filter((r) => r.stage.key === "pending");
  const toCall = [
    ...(data?.pending || []).map((row) => ({ source: "giniflow", row })),
    ...hrPending.filter((r) => r.collectable).map((row) => ({ source: "healthray", row })),
  ];
  const unreachable = hrPending
    .filter((r) => !r.collectable)
    .map((row) => ({ source: "healthray", row }));

  const doneRows = [
    ...(data?.uploaded || []).map((row) => ({
      source: "giniflow",
      row,
      onFloor: !!row.station && !row.finished,
    })),
    ...healthray
      .filter((r) => r.stage.key === "reported")
      .map((row) => ({ source: "healthray", row, onFloor: !!row.station && !row.finished })),
  ];
  const doneTotal = doneRows.length;

  const midVisible = ["collecting", "processing", "ready"].reduce(
    (n, k) =>
      n +
      (data?.[k] || []).length +
      healthray.filter((r) => r.stage.key === GROUP_TO_STAGE[k]).length,
    0,
  );
  const visibleTotal = toCall.length + unreachable.length + midVisible + doneRows.length;

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
  const openGroup = openPair?.g || GROUPS[0];
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
        <div className="rl">Lab Station</div>
        <div className="rsep" />
        <span className="rail-title">
          Gini Lab ·{" "}
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
          <div className="stats">
            {[
              ["pending", "Sample pending", "not yet collected", "var(--tl)"],
              ["collecting", "Collecting", "sample taken", "var(--blu)"],
              ["processing", "Processing", "in analyzer", "var(--pu)"],
              ["ready", "Ready to upload", "results done", "var(--amb)"],
              ["uploaded", "Uploaded", "MO notified", "var(--grn)"],
            ].map(([key, label, sub, colour]) => (
              <div className="stat" key={key}>
                <div className="sv" style={{ color: colour }}>
                  {counts[key]}
                </div>
                <div>
                  <div className="sl">{label}</div>
                  <div className="ss">{sub}</div>
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
            <div className="lab-running">
              {MID_GROUPS.map((group) => {
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
                          {cases.map((row) => (
                            <HealthrayCard
                              key={`hr-${row.patientId}`}
                              row={row}
                              onOpen={() => setOpenCaseId(row.patientId)}
                              readOnly={!row.collectable}
                            />
                          ))}
                          {orders.map((order) => (
                            <LabCard
                              key={order.orderId}
                              order={order}
                              group={group}
                              onAdvance={onAdvance}
                              onUpload={onUpload}
                              onOpen={(o) => setOpenOrderId(o.orderId)}
                              busy={advance.isPending || upload.isPending}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!isLoading && (
            <div className="ar-split">
              <div className="ar-col">
                <div className="grp-lbl">
                  📞 To call — start lab steps
                  <span className="grp-split">{toCall.length}</span>
                </div>
                {!toCall.length && <div className="empty-note">Nobody waiting to be called.</div>}
                <div className="pt-list">
                  {toCall.map((r) =>
                    r.source === "giniflow" ? (
                      <LabCard
                        key={`g-${r.row.orderId}`}
                        order={r.row}
                        group={GROUPS[0]}
                        onAdvance={onAdvance}
                        onUpload={onUpload}
                        onOpen={(o) => setOpenOrderId(o.orderId)}
                        busy={advance.isPending || upload.isPending}
                      />
                    ) : (
                      <HealthrayCard
                        key={`h-${r.row.patientId}`}
                        row={r.row}
                        onOpen={() => setOpenCaseId(r.row.patientId)}
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
                            key={`u-${r.row.patientId}`}
                            row={r.row}
                            onOpen={() => setOpenCaseId(r.row.patientId)}
                            readOnly
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="ar-col">
                <div className="grp-lbl grp-lbl-sp">
                  ✅ Lab done<span className="grp-split">{doneTotal}</span>
                </div>
                {!doneTotal && <div className="empty-note">No case has reported yet today.</div>}
                {DONE_SPLIT.map((part) => {
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
                              group={GROUPS[4]}
                              onAdvance={onAdvance}
                              onUpload={onUpload}
                              onOpen={(o) => setOpenOrderId(o.orderId)}
                              busy={advance.isPending || upload.isPending}
                            />
                          ) : (
                            <HealthrayCard
                              key={`dh-${r.row.patientId}`}
                              row={r.row}
                              onOpen={() => setOpenCaseId(r.row.patientId)}
                              readOnly={part.key === "left"}
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
            </div>
          )}

          {!isLoading && term && !visibleTotal && (
            <div className="empty-note">Nobody matches “{search.trim()}”.</div>
          )}

          {!isLoading && !term && !unifiedTotal && (
            <div className="empty-note">
              No lab work today — neither a Gini Flow order nor a hospital-lab case. A patient lands
              here the moment an MO orders tests on the MO/SD station, or the hospital lab registers
              a case of their own.
            </div>
          )}
        </div>
      </div>

      <HealthrayCasePane
        row={healthray.find((r) => r.patientId === openCaseId) || null}
        onClose={closeCasePane}
        onAction={onCaseAction}
        onUploadCase={onUploadCase}
        isAdmin={isAdmin}
        busy={caseAction.isPending || caseUpload.isPending}
      />

      <LabDetailPane
        order={openOrder}
        group={openGroup}
        busy={advance.isPending || upload.isPending}
        onClose={closePane}
        onAdvance={onAdvance}
        onUpload={onUpload}
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
