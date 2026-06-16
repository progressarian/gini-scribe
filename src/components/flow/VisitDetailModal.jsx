import { toast } from "../../stores/uiStore";
import {
  useFlowAdvance,
  useFlowEditDuration,
  useFlowRemoveStep,
} from "../../queries/hooks/useFlow";
import "../../styles/flow.css";

// Patient journey management modal — edit step durations, remove/skip steps, and
// force-advance. Shared by the Flow Coordinator floor and the Reception "checked
// in today" list so both manage a visit the same way. `visit` must include
// `steps` + `_timing` (the shape returned by GET /api/flow/visits).
export default function VisitDetailModal({ visit, onClose }) {
  const advance = useFlowAdvance();
  const editDur = useFlowEditDuration();
  const removeStep = useFlowRemoveStep();

  const act = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) toast(okMsg, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        zIndex: 500,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "40px 16px",
        overflow: "auto",
      }}
    >
      <div
        className="flow-root"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560, width: "100%", padding: 0, borderRadius: 10, minHeight: 0 }}
      >
        <div className="flow-card" style={{ borderRadius: 10 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <div>
              <div className="flow-title" style={{ fontSize: 16 }}>
                {visit.patient_name} {visit.is_vip ? "⭐" : ""}
              </div>
              <div className="flow-sub">
                {visit.patient_id} · {visit.visit_type_id} · {visit._timing?.elapsed_min}/
                {visit.max_time_min} min
              </div>
            </div>
            <button className="flow-btn flow-btn-ghost" onClick={onClose}>
              ✕ Close
            </button>
          </div>

          <div className="flow-muted" style={{ marginBottom: 8 }}>
            Edit a step's minutes (blur to save) · ✕ to remove a not-yet-done step. Completed steps
            are locked.
          </div>

          {visit.steps?.map((s) => (
            <div key={s.id} className="jb-step">
              <span
                className="jb-name"
                style={{
                  textDecoration: s.status === "skipped" ? "line-through" : "none",
                  opacity: s.status === "skipped" ? 0.5 : 1,
                }}
              >
                {s.step_order}. {s.step_name}
                <span
                  className={`flow-badge ${s.status === "completed" ? "fb-grn" : s.status === "in_progress" ? "fb-blu" : "fb-ink"}`}
                  style={{ marginLeft: 6 }}
                >
                  {s.status}
                </span>
              </span>
              <input
                className="jb-dur"
                type="number"
                min="0"
                defaultValue={s.planned_duration_min}
                disabled={s.status === "completed"}
                onBlur={(e) => {
                  const v = parseInt(e.target.value);
                  if (v !== s.planned_duration_min)
                    act(
                      () => editDur.mutateAsync({ stepId: s.id, new_duration_min: v }),
                      "Duration updated",
                    );
                }}
              />
              {!["completed", "skipped"].includes(s.status) && (
                <button
                  className="jb-remove"
                  title="Remove / skip step"
                  onClick={() => act(() => removeStep.mutateAsync(s.id), "Step removed")}
                >
                  ✕
                </button>
              )}
            </div>
          ))}

          {visit.status === "in_progress" && (
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                className="flow-btn flow-btn-grn"
                style={{ flex: 1 }}
                disabled={advance.isPending}
                onClick={() => act(() => advance.mutateAsync({ visitId: visit.id }), "Advanced")}
              >
                ✓ Force-advance current step
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
