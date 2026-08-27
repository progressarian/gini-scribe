import LabPanel from "./LabPanel";

const LIVE = ["in_progress", "paused"];

// One rule for every stage list: the stage is open, and nothing before it is.
// Used for both of the MO's lists, and by the Assistant Station's two sections,
// so a patient can never appear at a desk before the work reaching them is done.
export function stageRows(visits = [], catalogId) {
  return visits
    .filter((v) => LIVE.includes(v.status))
    .map((v) => {
      const steps = v.steps || [];
      const stage = steps.find((s) => s.step_catalog_id === catalogId);
      if (!stage || ["completed", "skipped"].includes(stage.status)) return null;
      const blocked = steps.some(
        (s) => s.step_order < stage.step_order && !["completed", "skipped"].includes(s.status),
      );
      if (blocked) return null;
      const handed = steps.find(
        (s) => s.step_catalog_id === "report_delivered" && s.status === "completed",
      );
      const tests = steps
        .filter((s) => s.assigned_role === "lab_tech" && !s.is_background)
        .map((s) => s.step_name);
      return { visit: v, step: stage, at: handed?.completed_at || null, tests };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
}

const fmtTime = (t) =>
  t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

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
  // Always a plain section — the caller decides whether to wrap one or several
  // in a sticky rail. Rendering its own <aside> made two panels two rails.
  className = "",
}) {
  return (
    <section className={className}>
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
    </section>
  );
}
