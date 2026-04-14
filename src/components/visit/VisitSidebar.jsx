import { memo, useState, useCallback } from "react";
import { MED_COLORS, DX_STATUS_STYLE, DX_STATUS_DEFAULT, findLab, fmtLabVal } from "./helpers";

// Order matches the canonical lab order in src/config/labOrder.js
// (Diabetes → Kidney → Lipids → Thyroid → CBC). Units and flag thresholds
// are sidebar-specific so the rich object structure stays local; the *order*
// of names mirrors KEY_BIOMARKERS in labOrder.js.
const KEY_BIOMARKERS = [
  { name: "HbA1c", unit: "%", flag: (v) => (v > 7 ? "high" : "ok") },
  { name: "FBS", unit: "mg/dL", flag: (v) => (v > 126 ? "high" : "ok") },
  { name: "Creatinine", unit: "mg/dL", flag: (v) => (v > 1.2 ? "high" : "ok") },
  { name: "eGFR", unit: "", flag: (v) => (v < 60 ? "low" : "ok") },
  { name: "LDL", unit: "mg/dL", flag: (v) => (v > 100 ? "high" : "ok") },
  { name: "TSH", unit: "µIU/mL", flag: (v) => (v > 4.5 ? "high" : v < 0.4 ? "low" : "ok") },
  { name: "Haemoglobin", unit: "g/dL", flag: (v) => (v < 12 ? "low" : "ok") },
];

const VITALS_FIELDS = [
  { key: "bp_sys", label: "BP", unit: "mmHg" },
  { key: "bp_dia", label: "BP Dia", unit: "mmHg" },
  { key: "pulse", label: "HR", unit: "bpm" },
  { key: "weight", label: "Weight", unit: "kg" },
  { key: "height", label: "Height", unit: "cm" },
  { key: "bmi", label: "BMI", unit: "", readOnly: true },
  { key: "body_fat", label: "Body Fat", unit: "%" },
  { key: "waist", label: "Waist", unit: "cm" },
  { key: "muscle_mass", label: "Muscle Mass", unit: "kg" },
  { key: "spo2", label: "SpO2", unit: "%" },
  { key: "temp", label: "Temp", unit: "°F" },
];

function calcBmi(weight, height) {
  const w = parseFloat(weight);
  const h = parseFloat(height);
  if (!w || !h) return "";
  return (w / (h / 100) ** 2).toFixed(1);
}

const VisitSidebar = memo(function VisitSidebar({
  summary,
  latestVitals,
  activeDx,
  activeMeds,
  flags,
  labResults = [],
  onSaveVitals,
  onSaveLab,
}) {
  const v = latestVitals;
  const [editing, setEditing] = useState(false);
  const [editVals, setEditVals] = useState({});
  const [saving, setSaving] = useState(false);
  const [labEditing, setLabEditing] = useState(false);
  const [labEditVals, setLabEditVals] = useState({});
  const [labSaving, setLabSaving] = useState(false);

  const startEdit = useCallback(() => {
    setEditVals({
      bp_sys: v?.bp_sys ?? "",
      bp_dia: v?.bp_dia ?? "",
      pulse: v?.pulse ?? "",
      weight: v?.weight ?? "",
      height: v?.height ?? "",
      bmi: v?.bmi ?? "",
      body_fat: v?.body_fat ?? "",
      waist: v?.waist ?? "",
      muscle_mass: v?.muscle_mass ?? "",
      spo2: v?.spo2 ?? "",
      temp: v?.temp ?? "",
    });
    setEditing(true);
  }, [v]);

  const handleChange = useCallback((field, value) => {
    setEditVals((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "weight" || field === "height") {
        const w = field === "weight" ? value : prev.weight;
        const h = field === "height" ? value : prev.height;
        next.bmi = calcBmi(w, h);
      }
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    await onSaveVitals(editVals);
    setSaving(false);
    setEditing(false);
  }, [onSaveVitals, editVals]);

  const handleCancel = useCallback(() => {
    setEditing(false);
  }, []);

  const startLabEdit = useCallback(() => {
    const vals = {};
    KEY_BIOMARKERS.forEach(({ name }) => {
      const lab = findLab(labResults, name);
      vals[name] = lab ? (lab.result ?? "") : "";
    });
    setLabEditVals(vals);
    setLabEditing(true);
  }, [labResults]);

  const handleLabSave = useCallback(async () => {
    setLabSaving(true);
    const today = new Date().toISOString().split("T")[0];
    for (const { name, unit } of KEY_BIOMARKERS) {
      const val = labEditVals[name];
      if (val !== "" && val !== null && val !== undefined) {
        const existing = findLab(labResults, name);
        if (String(val) !== String(existing?.result ?? "")) {
          await onSaveLab({ test_name: name, result: val, unit, test_date: today });
        }
      }
    }
    setLabSaving(false);
    setLabEditing(false);
  }, [labEditVals, labResults, onSaveLab]);

  return (
    <div className="sidebar">
      <div className="sb-hd">
        <span className="sb-lbl">Patient Snapshot</span>
        <span className="sb-v">V{summary.totalVisits}</span>
      </div>
      <div className="sb-scroll">
        {(v || editing) && (
          <div className="sbsec">
            <div
              className="sbsec-title"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
            >
              <span>{v ? new Date(v.recorded_at).toLocaleDateString() : "New Vitals"}</span>
              {!editing ? (
                <button
                  onClick={startEdit}
                  style={{
                    fontSize: 11,
                    padding: "1px 7px",
                    cursor: "pointer",
                    background: "#eff6ff",
                    border: "1px solid #bfdbfe",
                    borderRadius: 4,
                    color: "#2563eb",
                    fontWeight: 600,
                  }}
                >
                  ✎ Edit
                </button>
              ) : (
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    style={{
                      fontSize: 11,
                      padding: "1px 7px",
                      cursor: "pointer",
                      background: "var(--primary)",
                      border: "none",
                      borderRadius: 4,
                      color: "#fff",
                    }}
                  >
                    {saving ? "…" : "Save"}
                  </button>
                  <button
                    onClick={handleCancel}
                    style={{
                      fontSize: 11,
                      padding: "1px 7px",
                      cursor: "pointer",
                      background: "var(--sb2)",
                      border: "1px solid var(--sbb)",
                      borderRadius: 4,
                      color: "var(--t2)",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {editing ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                {VITALS_FIELDS.map(({ key, label, unit, readOnly }) => (
                  <div
                    key={key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 6,
                    }}
                  >
                    <span style={{ fontSize: 11, color: "var(--sbmuted)", minWidth: 60 }}>
                      {label}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                      {readOnly ? (
                        <span
                          style={{
                            width: 64,
                            fontSize: 13,
                            fontWeight: 700,
                            color: "#e2e8f0",
                            textAlign: "right",
                            display: "block",
                          }}
                        >
                          {editVals[key] ? Number(editVals[key]).toFixed(1) : "—"}
                        </span>
                      ) : (
                        <input
                          type="number"
                          value={editVals[key] ?? ""}
                          onChange={(e) => handleChange(key, e.target.value)}
                          style={{
                            width: 64,
                            fontSize: 12,
                            padding: "2px 5px",
                            background: "var(--bg)",
                            border: "1px solid var(--sbb)",
                            borderRadius: 4,
                            color: "var(--t1)",
                            textAlign: "right",
                          }}
                        />
                      )}
                      {unit && (
                        <span style={{ fontSize: 10, color: "var(--sbmuted)", minWidth: 20 }}>
                          {unit}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="vgrid">
                {VITALS_FIELDS.map(({ key, label, unit, readOnly }) => {
                  let displayVal = v?.[key] ?? "-";

                  // Format special cases
                  if (key === "bp_sys" && v?.bp_sys && v?.bp_dia) {
                    displayVal = `${v.bp_sys}/${v.bp_dia}`;
                  } else if (key === "bp_dia") {
                    return null; // Skip, already shown in BP
                  } else if (key === "bmi" && v?.bmi) {
                    displayVal = Number(v.bmi).toFixed(1);
                  }

                  if (displayVal === "-") return null; // Skip empty vitals

                  return (
                    <div key={key} className="vbox">
                      <div className="vval">
                        {displayVal}
                        {unit && unit !== "" && (
                          <span style={{ fontSize: 9, color: "var(--sbmuted)", marginLeft: 2 }}>
                            {unit}
                          </span>
                        )}
                      </div>
                      <div className="vlbl">{label}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {!v && !editing && (
          <div className="sbsec">
            <button
              onClick={startEdit}
              style={{
                width: "100%",
                fontSize: 12,
                padding: "6px",
                cursor: "pointer",
                background: "var(--sb2)",
                border: "1px dashed var(--sbb)",
                borderRadius: 6,
                color: "var(--t3)",
              }}
            >
              + Add Vitals
            </button>
          </div>
        )}

        {/* Key Biomarkers */}
        <div className="sbsec">
          <div
            className="sbsec-title"
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <span>Latest Biomarkers</span>
            {!labEditing ? (
              <button
                onClick={startLabEdit}
                style={{
                  fontSize: 11,
                  padding: "1px 7px",
                  cursor: "pointer",
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                  borderRadius: 4,
                  color: "#2563eb",
                  fontWeight: 600,
                }}
              >
                ✎ Edit
              </button>
            ) : (
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  onClick={handleLabSave}
                  disabled={labSaving}
                  style={{
                    fontSize: 11,
                    padding: "1px 7px",
                    cursor: "pointer",
                    background: "var(--primary)",
                    border: "none",
                    borderRadius: 4,
                    color: "#fff",
                  }}
                >
                  {labSaving ? "…" : "Save"}
                </button>
                <button
                  onClick={() => setLabEditing(false)}
                  style={{
                    fontSize: 11,
                    padding: "1px 7px",
                    cursor: "pointer",
                    background: "var(--sb2)",
                    border: "1px solid var(--sbb)",
                    borderRadius: 4,
                    color: "var(--t2)",
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: labEditing ? 6 : 4 }}>
            {KEY_BIOMARKERS.map(({ name, unit, flag }) => {
              const lab = findLab(labResults, name);
              if (!labEditing && !lab) return null;
              const val = parseFloat(lab?.result);
              const status = lab && !isNaN(val) ? flag(val) : "ok";
              const color =
                status === "high" ? "#dc2626" : status === "low" ? "#d97706" : "#e2e8f0"; // light text for dark UI

              return (
                <div
                  key={name}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 11,
                  }}
                >
                  <span style={{ color: "var(--sbmuted)" }}>{name}</span>
                  {labEditing ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                      <input
                        type="number"
                        value={labEditVals[name] ?? ""}
                        onChange={(e) => setLabEditVals((p) => ({ ...p, [name]: e.target.value }))}
                        placeholder="—"
                        style={{
                          width: 60,
                          fontSize: 12,
                          padding: "2px 5px",
                          background: "var(--bg)",
                          border: "1px solid var(--sbb)",
                          borderRadius: 4,
                          color: "var(--t1)",
                          textAlign: "right",
                        }}
                      />
                      {unit && (
                        <span style={{ fontSize: 9, color: "var(--sbmuted)", minWidth: 20 }}>
                          {unit}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: "1px 7px",
                        borderRadius: 10,
                        background:
                          status === "high"
                            ? "#fef2f2"
                            : status === "low"
                              ? "#fffbeb"
                              : "var(--sb2)",
                        color,
                        border: `1px solid ${
                          status === "high"
                            ? "#fecaca"
                            : status === "low"
                              ? "#fde68a"
                              : "var(--sbb)"
                        }`,
                      }}
                    >
                      {fmtLabVal(lab.result_text, lab.result)}
                      {unit && (
                        <span style={{ fontSize: 9, fontWeight: 400, marginLeft: 2, opacity: 0.7 }}>
                          {unit}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Diagnoses */}
        {activeDx.length > 0 && (
          <div className="sbsec">
            <div className="sbsec-title">Diagnoses ({activeDx.length})</div>
            {activeDx.map((dx, i) => {
              const st = DX_STATUS_STYLE[dx.status] || DX_STATUS_DEFAULT;
              return (
                <div key={i} className="sdx">
                  <div
                    className="sdx-dot"
                    style={{
                      background: st.dot,
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      flexShrink: 0,
                      marginTop: 4,
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div className="sdx-nm">
                      {dx.label?.replace(/\s*\(.*\)/, "") || dx.diagnosis_id}
                    </div>
                    <div className="sdx-sub">
                      {dx.since_year ? `Since ${dx.since_year}` : ""}
                      {dx.notes ? ` · ${dx.notes}` : ""}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: "2px 7px",
                      borderRadius: 10,
                      background: st.bg,
                      color: st.color,
                      border: `1px solid ${st.border}`,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {dx.status}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Active Meds */}
        {activeMeds.length > 0 && (
          <div className="sbsec">
            <div className="sbsec-title">Active Meds ({activeMeds.length})</div>
            {activeMeds.map((m, i) => (
              <div key={i} className="smed">
                <div
                  className="smed-dot"
                  style={{ background: MED_COLORS[i % MED_COLORS.length] }}
                />
                <div>
                  <div className="smed-nm">{m.name}</div>
                  <div className="smed-dose">
                    {m.dose} · {m.frequency || "OD"}
                    {m.timing ? ` · ${m.timing}` : ""}
                  </div>
                  {m.for_diagnosis?.length > 0 && (
                    <div className="smed-for">{m.for_diagnosis.join(", ")}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Flags */}
        {flags.length > 0 && (
          <div className="sbsec">
            <div className="sbsec-title">Flags</div>
            {flags.map((f, i) => (
              <div key={i} className={`salert ${f.type === "red" ? "red" : ""}`}>
                <span style={{ fontSize: 13 }}>{f.icon}</span>
                <div>
                  <div className="salert-txt">{f.text}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

export default VisitSidebar;
