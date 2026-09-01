// The day's readiness in one line, and eight filters. "82 categorised · 26
// still pending" is the coordinator's actual worklist (§4.1).
//
// The step keys come from the shared vocabulary and are sent straight back to
// the API as `filter`, so a step's number and the patients clicking it opens
// can never be computed from two different rules.

const TONE_CLASS = {
  dim: "val-dim",
  ok: "val-ok",
  warn: "val-warn",
  crit: "val-crit",
};

export default function PipelineBar({ steps, active, onSelect, total }) {
  return (
    <div className="pipeline" role="group" aria-label="Day readiness — select a step to filter">
      {steps.map((step) => {
        const isActive = active === step.key;
        const pending = step.key === "categorised" || step.key === "assigned";
        return (
          <button
            type="button"
            key={step.key}
            className={`ps${isActive ? " active" : ""}`}
            aria-pressed={isActive}
            onClick={() => onSelect(isActive ? null : step.key)}
          >
            <div className={`ps-val ${TONE_CLASS[step.tone] || "val-dim"}`}>{step.count}</div>
            <div className="ps-lbl">{step.label}</div>
            <div className="ps-sub">
              {pending && total ? `${total - step.count} still pending` : step.sub}
            </div>
          </button>
        );
      })}
    </div>
  );
}
