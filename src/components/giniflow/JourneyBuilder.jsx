import { useState } from "react";
import { useFlowStepCatalog, useFlowStaff } from "../../queries/hooks/useFlow";
import useAuthStore from "../../stores/authStore";

// The journey reception confirms before an arrival completes: what this patient
// is here for, in the order they will do it.
// docs/gini-flow/29-RECEPTION-JOURNEY-PLAN.md
//
// Presentational — it takes steps and gives steps back. Every option in it comes
// from the catalog, the templates and the staff list, so a step added by an
// admin appears here without a deploy.

// Doctor roles are picked from the doctors list; everyone else from flow_staff.
const DOCTOR_ROLES = ["mo", "sd", "chief", "doctor", "consultant"];

const minutesOf = (steps) => steps.reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);

function AssignSelect({ step, onChange }) {
  const doctorsList = useAuthStore((s) => s.doctorsList) || [];
  const isDoctor = DOCTOR_ROLES.includes(step.role);
  const { data: staff = [] } = useFlowStaff(isDoctor ? null : step.role);
  const options = isDoctor
    ? doctorsList.map((d) => ({ id: d.id, name: d.short_name || d.name }))
    : staff.map((s) => ({ id: s.id, name: s.name }));

  return (
    <select
      className="jb-assign"
      value={step.staffId || ""}
      onChange={(e) => {
        const picked = options.find((o) => String(o.id) === e.target.value);
        onChange({ staffId: picked ? String(picked.id) : null, staffName: picked?.name || null });
      }}
    >
      <option value="">{step.role || "anyone"}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

export default function JourneyBuilder({ steps, onChange, visitTypes, visitTypeId, onTypeChange }) {
  const { data: catalog = [] } = useFlowStepCatalog();
  const [custom, setCustom] = useState(null);

  const replace = (i, patch) =>
    onChange(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const move = (i, by) => {
    const to = i + by;
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    [next[i], next[to]] = [next[to], next[i]];
    onChange(next);
  };

  const addFromCatalog = (catalogId) => {
    const c = catalog.find((x) => x.id === catalogId);
    if (!c) return;
    onChange([
      ...steps,
      {
        catalogId: c.id,
        name: c.name,
        minutes: c.default_duration_min,
        station: c.station,
        role: c.assigned_role,
        chainStatus: c.chain_status,
        source: "added",
      },
    ]);
  };

  const addCustom = (e) => {
    e.preventDefault();
    if (!custom.name.trim()) return;
    onChange([
      ...steps,
      {
        catalogId: null,
        name: custom.name.trim(),
        minutes: Number(custom.minutes) || 0,
        station: custom.station.trim() || null,
        role: null,
        chainStatus: null,
        source: "custom",
      },
    ]);
    setCustom(null);
  };

  return (
    <div className="jb">
      <div className="jb-types">
        {visitTypes.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`jb-type${t.id === visitTypeId ? " on" : ""}`}
            onClick={() => onTypeChange(t.id)}
          >
            {t.label}
            <span className="jb-type-min">{t.max_time_min}m</span>
          </button>
        ))}
      </div>

      <div className="jb-head">
        <span>Step</span>
        <span className="jb-h-min">Min</span>
        <span className="jb-h-assign">Assigned</span>
        <span />
      </div>

      {steps.length === 0 && (
        <div className="empty-note">
          No steps yet — this visit type has no default journey. Add the stops this patient needs.
        </div>
      )}

      {steps.map((step, i) => (
        <div className="jb-step" key={`${step.catalogId || "custom"}-${i}`}>
          <span className="jb-move">
            <button type="button" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
              ▲
            </button>
            <button
              type="button"
              disabled={i === steps.length - 1}
              onClick={() => move(i, 1)}
              title="Move down"
            >
              ▼
            </button>
          </span>
          <span className="jb-name">
            {i + 1}. {step.name}
            {/* A stop the board has no column for is one the desk will have to
                tick itself — better said here than discovered later. */}
            {!step.chainStatus && <span className="jb-manual">ticked by hand</span>}
          </span>
          <input
            className="jb-dur"
            type="number"
            min="0"
            value={step.minutes}
            onChange={(e) => replace(i, { minutes: e.target.value })}
          />
          <AssignSelect step={step} onChange={(patch) => replace(i, patch)} />
          <button
            type="button"
            className="jb-remove"
            title="Remove step"
            onClick={() => onChange(steps.filter((_, idx) => idx !== i))}
          >
            ✕
          </button>
        </div>
      ))}

      <select className="jb-add" value="" onChange={(e) => addFromCatalog(e.target.value)}>
        <option value="">+ Add step</option>
        {catalog.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.default_duration_min}m)
          </option>
        ))}
      </select>

      {custom ? (
        <form className="jb-custom" onSubmit={addCustom}>
          <input
            autoFocus
            className="ar-reason-input"
            placeholder="What is this step?"
            value={custom.name}
            onChange={(e) => setCustom({ ...custom, name: e.target.value })}
          />
          <input
            className="ar-reason-input jb-dur"
            type="number"
            min="0"
            placeholder="Min"
            value={custom.minutes}
            onChange={(e) => setCustom({ ...custom, minutes: e.target.value })}
          />
          <button className="st-btn st-btn-blu" type="submit">
            Add
          </button>
          <button className="st-btn st-btn-ghost" type="button" onClick={() => setCustom(null)}>
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="jb-add-custom"
          onClick={() => setCustom({ name: "", minutes: "", station: "" })}
        >
          + Custom step (type your own)
        </button>
      )}

      <div className="jb-total">
        <strong>
          {steps.length} step{steps.length === 1 ? "" : "s"} · Est. {minutesOf(steps)} min
        </strong>
      </div>
    </div>
  );
}
