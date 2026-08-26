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

export default function DoctorReportsPanel({ rows, onReview, busy = false }) {
  return (
    <aside className="station-side">
      <div className="q-sec-head">
        <span className="flow-sec-title" style={{ margin: 0 }}>
          Lab reports handed to you
          <span className="q-count">{rows.length}</span>
        </span>
      </div>
      <p className="flow-muted" style={{ marginBottom: 6 }}>
        The assistant has brought these up. Newest first.
      </p>
      {rows.length === 0 ? (
        <div className="flow-card flow-empty">
          Nothing waiting. Reports appear here the moment the assistant marks them delivered, and
          leave once you mark them reviewed.
        </div>
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
                  {visit.patient_id} · handed over {fmtTime(at)}
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
              title="Record that you have read this report"
              onClick={() => onReview(step, visit.patient_name)}
            >
              ✓ Reviewed
            </button>
          </article>
        ))
      )}
    </aside>
  );
}
