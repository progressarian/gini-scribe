import { toast } from "../../stores/uiStore";
import { useFlowActiveVisit, useFlowAdvance } from "../../queries/hooks/useFlow";
import "../../styles/flow.css";

// Compact patient-flow strip embedded in the existing clinical views (SD / Chief
// / Pharmacy). Renders NOTHING when the patient has no live flow visit, so it's
// invisible for clinics not using the flow module. The "advance" button completes
// the patient's current in-progress step and routes them to the next station;
// for the final (pharmacy) step this stops the visit clock.
//
// Props: { patientDbId, fileNo, roleHint } — roleHint is cosmetic ("sd"|"chief"|
// "pharmacy") and only changes the button label.
const shorten = (n = "") =>
  n
    .replace(/ \(.*\)$/, "")
    .replace("Prescription Explain", "Rx")
    .replace("Pharmacy / Exit", "Pharmacy");

export default function FlowPanel({ patientDbId, fileNo, roleHint }) {
  const { data: visit } = useFlowActiveVisit({ patientDbId, fileNo });
  const advance = useFlowAdvance();

  if (!visit) return null; // no live flow visit → render nothing

  const t = visit._timing || {};
  const steps = (visit.steps || []).filter((s) => s.status !== "skipped");
  const current = steps.find((s) => s.status === "in_progress");
  const tone =
    t.urgency === "breach" ? "var(--fre)" : t.urgency === "atrisk" ? "var(--fam)" : "var(--ftl)";

  const isFinal = current && steps[steps.length - 1]?.id === current.id;
  const label =
    roleHint === "pharmacy" || isFinal
      ? "💊 Confirm Exit (stops clock)"
      : roleHint === "chief"
        ? "✓ Done — route onward"
        : "✓ Done — next step";

  const advanceStep = async () => {
    try {
      await advance.mutateAsync({ visitId: visit.id, step_id: current?.id });
      toast("Flow step advanced", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  return (
    <div
      className="flow-root"
      style={{ padding: 0, minHeight: 0, marginBottom: 10, background: "transparent" }}
    >
      <div className="flow-card" style={{ borderColor: tone, padding: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="flow-badge fb-tl">FLOW</span>
          <span style={{ fontSize: 12, fontWeight: 700 }}>
            {visit.is_vip ? "⭐ " : ""}
            {current ? shorten(current.step_name) : "Awaiting next step"}
          </span>
          <span className="flow-muted">
            {t.elapsed_min}/{visit.max_time_min} min ·{" "}
            <b style={{ color: tone }}>{t.remaining_min}m left</b>
          </span>
          <div style={{ flex: 1 }} />
          {current && (
            <button
              className={`flow-btn ${roleHint === "pharmacy" || isFinal ? "flow-btn-primary" : "flow-btn-grn"}`}
              disabled={advance.isPending}
              onClick={advanceStep}
            >
              {label}
            </button>
          )}
        </div>

        {/* Journey pills */}
        <div className="j-steps" style={{ marginTop: 8 }}>
          {steps.map((s, i) => {
            let cls = "j-next";
            let txt = shorten(s.step_name);
            if (s.status === "completed") {
              cls = "j-done";
              txt = `${txt} ✓`;
            } else if (s.status === "in_progress") {
              cls = "j-now";
              txt = `🔸 ${txt}`;
            }
            return (
              <span key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <span className={`j-step ${cls}`}>{txt}</span>
                {i < steps.length - 1 && <span className="j-arrow">→</span>}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
