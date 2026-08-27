// Today's booked patients (the GHM list) as a click-to-fill picker for the
// reception check-in screen. Rows carry whatever flow visit already exists for
// the patient, so a coordinator can see at a glance who is still to arrive.
//
// Picking a row is what links the flow visit to the real booking. That matters
// beyond saved typing: without appointment_id, ensureFlowAppointment() falls
// back to matching by file number and — failing that — INSERTs a synthetic
// appointment (booking_source='flow'), quietly duplicating a patient who was
// already on the day's list.
import { useMemo, useState } from "react";
import { useFlowAppointments } from "../../queries/hooks/useFlow";
import { classifyAppointment } from "../../lib/flowAppointmentType";
import BlockedBadge from "../ui/BlockedBadge";
import { usePatientBlockStatus } from "../../queries/hooks/usePatientBlocks";

// Appointment statuses that mean the visit is over. `no_show` is deliberately
// absent: the Sheets sync defaults rows to no_show until the patient is marked
// present, so treating it as terminal would hide half the morning's list.
const DONE_STATUSES = ["seen", "completed", "cancelled"];

const isDone = (a) =>
  DONE_STATUSES.includes((a.status || "").toLowerCase()) || a.flow_status === "completed";

// Which bucket a row belongs to. Either side may declare a visit finished, and
// they do disagree — today carries a row whose appointment is `completed` while
// its flow visit still reads `in_progress` (reconcileFromAppointments closes
// those on the next /flow/visits read). Done wins, so a seen patient can't sit
// in the queue looking actionable.
const bucketOf = (a) => (isDone(a) ? "done" : a.flow_visit_id ? "ongoing" : "pending");

const TABS = [
  // Reception's working set is `pending`, so that's where the picker opens.
  { key: "pending", label: "Pending", hint: "Booked, not yet checked in" },
  { key: "ongoing", label: "Ongoing", hint: "Checked in, journey running" },
  {
    key: "done",
    label: "Done",
    hint: "Finished today — includes patients HealthRay closed without a flow check-in",
  },
  { key: "all", label: "All", hint: "Every booking for today" },
];

const ageSexOf = (a) =>
  [a.age, (a.sex || "").charAt(0).toUpperCase()].filter(Boolean).join("") || null;

export default function AppointmentPicker({ date, selectedAppointmentId, onPick, onOpenVisit }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("pending");
  const {
    data: rows = [],
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useFlowAppointments(date, {});

  const patientIds = useMemo(() => rows.map((a) => a.patient_id).filter(Boolean), [rows]);
  const blocks = usePatientBlockStatus(patientIds).data || {};

  const counts = useMemo(() => {
    const c = { pending: 0, ongoing: 0, done: 0, all: rows.length };
    for (const a of rows) c[bucketOf(a)]++;
    return c;
  }, [rows]);

  // Filter on the client: the list is a clinic day (tens of rows), already in
  // memory and polled — round-tripping every keystroke would only add latency.
  const filtered = useMemo(() => {
    const byTab = tab === "all" ? rows : rows.filter((a) => bucketOf(a) === tab);
    const t = q.trim().toLowerCase();
    if (t.length < 2) return byTab;
    const words = t.split(/\s+/).filter(Boolean);
    return byTab.filter((a) => {
      const hay = `${a.patient_name || ""} ${a.file_no || ""} ${a.phone || ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [rows, q, tab]);

  return (
    <div className="flow-card ap-card">
      <div className="ap-head">
        <div>
          <div className="flow-sec-title">Today’s patients (GHM)</div>
          <div className="flow-sub">{isLoading ? "Loading…" : `${counts.all} booked today`}</div>
        </div>
        <button
          className="flow-btn flow-btn-ghost flow-btn-mini"
          onClick={() => refetch()}
          title="Refresh the list"
          disabled={isFetching}
        >
          {isFetching ? "…" : "⟳"}
        </button>
      </div>

      <div className="ap-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`ap-tab${tab === t.key ? " on" : ""}`}
            onClick={() => setTab(t.key)}
            title={t.hint}
          >
            {t.label}
            <span className="ap-tab-n">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      <div className="flow-field ap-search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name / file / phone…"
        />
      </div>

      {isError && (
        <div className="flow-empty">Couldn’t load today’s list. Manual check-in still works.</div>
      )}
      {!isError && !isLoading && !filtered.length && (
        <div className="flow-empty">
          {!rows.length
            ? "No appointments booked for today."
            : q.trim().length >= 2
              ? "No match in this list."
              : tab === "pending"
                ? "Everyone booked today is checked in or seen. 🎉"
                : tab === "ongoing"
                  ? "Nobody is mid-journey right now."
                  : "Nobody has finished yet today."}
          <div style={{ marginTop: 4 }}>Fill the form manually for walk-ins.</div>
        </div>
      )}

      <div className="ap-list">
        {filtered.map((a) => {
          const chip = classifyAppointment(a).chip;
          const done = isDone(a);
          const checkedIn = !!a.flow_visit_id && !done;
          const selected = selectedAppointmentId === a.id;
          const cls = ["ap-row", selected && "sel", (checkedIn || done) && "taken", done && "done"]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={a.id}
              className={cls}
              onClick={() =>
                a.flow_visit_id ? onOpenVisit?.(a.flow_visit_id) : !done && onPick(a)
              }
              title={
                a.flow_visit_id
                  ? "Already checked in — open the visit"
                  : done
                    ? "Marked complete in OPD/HealthRay — this patient never went through the flow, so there is no journey to open"
                    : "Fill the check-in form from this appointment"
              }
            >
              <div className="ap-time">{a.reporting_time_slot || a.time_slot || "—"}</div>
              <div className="ap-main">
                <div className="ap-name">
                  {a.patient_name || "Unnamed"}
                  {a.via_preferred && (
                    <span className="flow-badge fb-ink" title="Asked to come today">
                      PREF
                    </span>
                  )}
                  <BlockedBadge block={blocks[a.patient_id]} size="sm" />
                </div>
                <div className="ap-meta">
                  {[a.file_no, ageSexOf(a), a.doctor_name].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
              <div className="ap-right">
                <span className={`flow-badge ${chip.cls}`}>{chip.label}</span>
                {checkedIn && (
                  <span className="flow-badge fb-grn">
                    ✅ {a.flow_token_number ? `#${a.flow_token_number}` : "In"}
                  </span>
                )}
                {done &&
                  (a.flow_visit_id ? (
                    <span className="flow-badge fb-grn" title="Flow journey completed">
                      ✅ Done
                    </span>
                  ) : (
                    <span
                      className="flow-badge fb-ink"
                      title="Completed in OPD/HealthRay without a flow check-in"
                    >
                      Seen · no flow
                    </span>
                  ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
