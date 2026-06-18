import { useState } from "react";
import { toast } from "../../stores/uiStore";
import {
  useFlowAdvance,
  useFlowEditDuration,
  useFlowRemoveStep,
} from "../../queries/hooks/useFlow";
import "../../styles/flow.css";

// Quick-pick reasons for skipping a step (free text still allowed).
const SKIP_REASONS = ["Already done", "Not required", "Done elsewhere", "Patient declined"];
const fmtSkipTime = (t) => {
  if (!t) return "";
  const d = new Date(t);
  return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

// Patient journey management modal — edit step durations, remove/skip steps, and
// force-advance. Shared by the Flow Coordinator floor and the Reception "checked
// in today" list so both manage a visit the same way. `visit` must include
// `steps` + `_timing` (the shape returned by GET /api/flow/visits).
export default function VisitDetailModal({ visit, onClose }) {
  const advance = useFlowAdvance();
  const editDur = useFlowEditDuration();
  const removeStep = useFlowRemoveStep();
  // The step whose skip-reason prompt is open, and the reason being typed.
  const [skipFor, setSkipFor] = useState(null);
  const [skipReason, setSkipReason] = useState("");

  const act = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) toast(okMsg, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const confirmSkip = (step) => {
    const reason = skipReason.trim();
    act(() => removeStep.mutateAsync({ stepId: step.id, reason }), "Step updated");
    setSkipFor(null);
    setSkipReason("");
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
            <div key={s.id}>
              <div className="jb-step">
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
                    onClick={() => {
                      setSkipFor(skipFor === s.id ? null : s.id);
                      setSkipReason("");
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Why a step was skipped — reason · who · when. */}
              {s.status === "skipped" && s.data?.skip && (
                <div className="flow-muted" style={{ fontSize: 11, margin: "-2px 0 6px 14px" }}>
                  ↳ {s.data.skip.reason ? `${s.data.skip.reason} · ` : ""}
                  {s.data.skip.by || "?"}
                  {s.data.skip.at ? ` · ${fmtSkipTime(s.data.skip.at)}` : ""}
                </div>
              )}

              {/* Reason prompt shown when ✕ is clicked. */}
              {skipFor === s.id && (
                <div
                  style={{
                    margin: "2px 0 8px 14px",
                    padding: 8,
                    border: "1px solid var(--fbd, #e2e2e2)",
                    borderRadius: 6,
                    background: "var(--fbg, #fafafa)",
                  }}
                >
                  <div className="flow-muted" style={{ marginBottom: 6 }}>
                    Reason for removing “{s.step_name}” (optional):
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                    {SKIP_REASONS.map((r) => (
                      <button
                        key={r}
                        type="button"
                        className={`flow-badge ${skipReason === r ? "fb-blu" : "fb-ink"}`}
                        style={{ cursor: "pointer", border: "none" }}
                        onClick={() => setSkipReason(r)}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={skipReason}
                    placeholder="or type a reason…"
                    autoFocus
                    onChange={(e) => setSkipReason(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && confirmSkip(s)}
                    style={{
                      width: "100%",
                      padding: "4px 6px",
                      marginBottom: 6,
                      boxSizing: "border-box",
                    }}
                  />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      className="flow-btn flow-btn-grn"
                      style={{ flex: 1 }}
                      disabled={removeStep.isPending}
                      onClick={() => confirmSkip(s)}
                    >
                      Confirm
                    </button>
                    <button
                      className="flow-btn flow-btn-ghost"
                      onClick={() => {
                        setSkipFor(null);
                        setSkipReason("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
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
