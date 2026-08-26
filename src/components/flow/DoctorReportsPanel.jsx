import LabPanel from "./LabPanel";

const LIVE = ["in_progress", "paused"];

// Reports physically handed over and not yet acknowledged. Shared by the doctor
// station and the consultant worklist so both read the same rule.
export function deliveredReportRows(visits = []) {
  return visits
    .filter((v) => LIVE.includes(v.status))
    .map((v) => {
      const handed = (v.steps || []).find(
        (s) => s.step_catalog_id === "report_delivered" && s.status === "completed",
      );
      if (!handed || handed.data?.reviewed) return null;
      const tests = (v.steps || [])
        .filter((s) => s.assigned_role === "lab_tech" && !s.is_background)
        .map((s) => s.step_name);
      return { visit: v, step: handed, at: handed.completed_at, tests };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}

const fmtTime = (t) =>
  t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

// Patients the consultant has finished with, whose prescription the MO has not
// prepared yet. Everything before the stage must be closed — a prescription
// cannot be written before the consultation that decides it.
export function prescriptionRows(visits = []) {
  return visits
    .filter((v) => LIVE.includes(v.status))
    .map((v) => {
      const steps = v.steps || [];
      const stage = steps.find((s) => s.step_catalog_id === "rx_ready");
      if (!stage || ["completed", "skipped"].includes(stage.status)) return null;
      const blocked = steps.some(
        (s) =>
          !s.is_background &&
          s.step_order < stage.step_order &&
          !["completed", "skipped"].includes(s.status),
      );
      if (blocked) return null;
      const consult = steps.find(
        (s) => s.assigned_role === "sd" && ["completed", "skipped"].includes(s.status),
      );
      return { visit: v, step: stage, at: consult?.completed_at || null, tests: [] };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
}

export default function DoctorReportsPanel({
  rows,
  onReview,
  busy = false,
  title = "Lab reports handed to you",
  subtitle = "The assistant has brought these up. Newest first.",
  emptyText = "Nothing waiting. Reports appear here the moment the assistant marks them delivered, and leave once you mark them reviewed.",
  actionLabel = "✓ Reviewed",
  actionTitle = "Record that you have read this report",
  stampLabel = "handed over",
}) {
  return (
    <aside className="station-side">
      <div className="q-sec-head">
        <span className="flow-sec-title" style={{ margin: 0 }}>
          {title}
          <span className="q-count">{rows.length}</span>
        </span>
      </div>
      <p className="flow-muted" style={{ marginBottom: 6 }}>
        {subtitle}
      </p>
      {rows.length === 0 ? (
        <div className="flow-card flow-empty">{emptyText}</div>
      ) : (
        rows.map(({ visit, step, at, tests }) => (
          <article key={visit.id} className="docrep">
            <header className="docrep-head">
              <div>
                <div className="docrep-name">
                  {visit.patient_name}
                  {visit.is_vip && <span title="VIP"> ⭐</span>}
                </div>
                <div className="qrow-meta">
                  {visit.patient_id}
                  {at ? ` · ${stampLabel} ${fmtTime(at)}` : ""}
                </div>
              </div>
              <span className="flow-badge fb-ink">{visit.token_number || "—"}</span>
            </header>
            {tests.length > 0 && (
              <div className="qrow-chips">
                {tests.map((t) => (
                  <span key={t} className="flow-badge fb-ink">
                    {t}
                  </span>
                ))}
              </div>
            )}
            <LabPanel lab={visit.lab} />
            <button
              type="button"
              className="flow-btn flow-btn-grn flow-btn-mini docrep-seen"
              disabled={busy}
              title={actionTitle}
              onClick={() => onReview(step, visit.patient_name)}
            >
              {actionLabel}
            </button>
          </article>
        ))
      )}
    </aside>
  );
}
