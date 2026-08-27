import LabPanel from "./LabPanel";

const mins = (from) =>
  from ? Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 60000)) : 0;

export default function ConsultationBox({
  visit,
  step,
  rxStep,
  notes,
  setNotes,
  busy,
  onDone,
  onPrescription,
  onRelease,
  onCancel,
  onClaim,
  mine,
  onOpenChart,
  opening,
}) {
  // Three states, not two. A missing stage is not a satisfied one: every visit
  // created before the stage existed has no rx_ready row, and saying
  // "already on file" for those claimed something nobody had checked.
  const rxOpen = !!rxStep && !["completed", "skipped"].includes(rxStep.status);
  const rxOnFile = rxStep ? !rxOpen : !!visit.rx?.ready;
  const rxNote = rxOpen
    ? "The nurse cannot explain anything until the prescription is written."
    : rxOnFile
      ? "Prescription on file — the nurse can take them next."
      : "No prescription on file yet. This visit has no prescription step, so nothing is holding the nurse.";
  return (
    <div className="station-active consult-box">
      <div className="station-head">
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            {visit.token_number ? `#${visit.token_number} · ` : ""}
            {visit.patient_name}
            {visit.my_role === "chief" && (
              <span className="flow-badge fb-lv" style={{ marginLeft: 6 }}>
                as Chief
              </span>
            )}
          </div>
          <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>
            {visit.patient_age_sex || ""} · {visit.patient_id} · {visit.visit_type_id}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 14 }}>With you: {mins(step?.started_at)} min</div>
          <div style={{ fontSize: 10, opacity: 0.8 }}>In hospital {mins(visit.checkin_time)}m</div>
          <div style={{ fontSize: 10, opacity: 0.9, marginTop: 2 }}>
            {mine ? (
              "🔒 you have this patient"
            ) : (
              <button
                type="button"
                className="flow-btn flow-btn-ghost flow-btn-mini"
                disabled={busy}
                title="Put your name on this patient so the floor can see who has them"
                onClick={onClaim}
              >
                🔒 Take patient
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="station-body">
        <LabPanel lab={visit.lab} />

        <div className="flow-field" style={{ marginTop: 10 }}>
          <label htmlFor="consult-notes">Consultation notes</label>
          <textarea
            id="consult-notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Assessment, plan, what changed…"
          />
        </div>

        <div className="consult-actions">
          <button
            className="flow-btn flow-btn-grn"
            style={{ padding: "8px 18px" }}
            disabled={busy}
            onClick={onDone}
          >
            ✓ Consultation done
          </button>
          {rxOpen && (
            <button
              className="flow-btn flow-btn-ghost"
              disabled={busy}
              title="Marks the prescription written — this is what releases the nurse"
              onClick={onPrescription}
            >
              ✓ Prescription written
            </button>
          )}
          <button className="flow-btn flow-btn-primary" disabled={opening} onClick={onOpenChart}>
            {opening ? "Opening…" : "Open chart →"}
          </button>
          {mine && (
            <button
              className="flow-btn flow-btn-ghost"
              disabled={busy}
              title="Hand back without completing — the consultation stays open and its clock keeps running"
              onClick={onRelease}
            >
              ↩ Release
            </button>
          )}
          <button
            className="flow-btn flow-btn-ghost"
            style={{ color: "var(--fre)", borderColor: "var(--fre)" }}
            disabled={busy}
            title="Called in by mistake — undo it, reset the clock and put them back in your queue"
            onClick={onCancel}
          >
            ✕ Cancel call-in
          </button>
          <span className="flow-muted">{rxNote}</span>
        </div>
      </div>
    </div>
  );
}
