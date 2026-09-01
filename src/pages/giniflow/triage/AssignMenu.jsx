import { useEffect, useState } from "react";
import { CATEGORY_META } from "../../../../shared/giniflowStatus";

// The coordinator's one dialog: which column this patient belongs in, and who
// is going to work them. Both in one place because they are one decision — the
// category IS the answer to "does the doctor need to see them" (§4.2).
//
// An override is stamped as the coordinator's and survives every later run of
// the auto engine, so the dialog says so out loud and offers the way back:
// "Hand back to auto" clears the source and lets the sweep re-decide.

const initials = (name = "") =>
  name
    .replace(/^Dr\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

export default function AssignMenu({ card, staff, saving, onClose, onSave, onReset }) {
  const [category, setCategory] = useState(card.category);
  const [sdId, setSdId] = useState(card.assignment.sdId);
  const [doctorId, setDoctorId] = useState(card.assignment.doctorId);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dirty =
    category !== card.category ||
    sdId !== card.assignment.sdId ||
    doctorId !== card.assignment.doctorId;

  const toggle = (setter, current, id) => setter(current === id ? null : id);

  return (
    <div className="tmodal open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tbox" role="dialog" aria-label={`Triage ${card.name}`}>
        <div className="tb-hd">
          <div>
            <div className="tb-name">{card.name}</div>
            <div className="tb-meta">
              {card.age ?? "—"}
              {(card.sex || "")[0] || ""} · {card.fileNo} ·{" "}
              {card.isNewPatient ? "first visit" : `visit ${card.visitNumber}`} ·{" "}
              {card.slot || "no slot"}
            </div>
          </div>
          <button className="tb-cls" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="tb-body">
          <p className="dlg-label">Category</p>
          <div className="cat-grid">
            {Object.entries(CATEGORY_META).map(([key, meta]) => (
              <button
                type="button"
                key={key}
                className={`cat-opt${category === key ? " sel" : ""}`}
                onClick={() => setCategory(key)}
              >
                {meta.icon} {meta.short}
                <small>{meta.lead}</small>
              </button>
            ))}
          </div>
          <p className="dlg-note">
            {card.categorySource === "coordinator"
              ? `Set by hand${card.categorySetBy ? ` — ${card.categorySetBy}` : ""}. The automatic sweep leaves it alone.`
              : "Set automatically from HbA1c. Changing it here makes it yours, and the sweep will not overwrite it again."}
          </p>

          <p className="dlg-label">SD / MO who leads the workup</p>
          {(staff || []).map((person) => (
            <button
              type="button"
              key={`sd-${person.id}`}
              className={`sd-opt${sdId === person.id ? " sel" : ""}`}
              onClick={() => toggle(setSdId, sdId, person.id)}
            >
              <span className="sd-av">{initials(person.shortName)}</span>
              <span className="sd-info">
                <span className="sd-name">{person.shortName}</span>
                <span className="sd-detail">
                  {person.specialty || person.role || "clinician"} · {person.assignedToday} already
                  on this day
                </span>
              </span>
              {sdId === person.id && <span>✓</span>}
            </button>
          ))}

          <p className="dlg-label" style={{ marginTop: 12 }}>
            Consultant who sees them
          </p>
          {(staff || [])
            .filter((p) => p.isChief || String(p.role || "").toLowerCase() !== "mo")
            .map((person) => (
              <button
                type="button"
                key={`doc-${person.id}`}
                className={`sd-opt${doctorId === person.id ? " sel" : ""}`}
                onClick={() => toggle(setDoctorId, doctorId, person.id)}
              >
                <span className="sd-av">{initials(person.shortName)}</span>
                <span className="sd-info">
                  <span className="sd-name">
                    {person.shortName} {person.isChief ? "· chief" : ""}
                  </span>
                  <span className="sd-detail">
                    {person.specialty || person.role || "consultant"} · {person.assignedToday}{" "}
                    already on this day
                  </span>
                </span>
                {doctorId === person.id && <span>✓</span>}
              </button>
            ))}

          <div className="cf-actions" style={{ marginTop: 14 }}>
            {card.categorySource === "coordinator" && (
              <button
                className="btn btn-g"
                onClick={onReset}
                disabled={saving}
                title="Clear the override and let the engine decide again"
              >
                Hand back to auto
              </button>
            )}
            <button className="btn btn-g" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              className="btn btn-tl"
              disabled={!dirty || saving}
              onClick={() => onSave({ category, sdId, doctorId })}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
