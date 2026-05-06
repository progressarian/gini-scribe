import { memo, useState } from "react";
import { getWarning } from "../../../utils/drugWarnings";
import {
  MED_GROUPS,
  DIABETES_CLASSES,
  TIMING_OPTIONS,
  findDrug,
} from "../../../config/drugDatabase";

const DRUG_LIST = [
  "Metformin 500mg",
  "Metformin 1000mg",
  "Glimepiride 1mg",
  "Glimepiride 2mg",
  "Gliclazide MR 30mg",
  "Gliclazide MR 60mg",
  "Sitagliptin 100mg",
  "Vildagliptin 50mg",
  "Empagliflozin 10mg",
  "Empagliflozin 25mg",
  "Dapagliflozin 10mg",
  "Canagliflozin 100mg",
  "Tirzepatide 2.5mg Inj (Mounjaro)",
  "Tirzepatide 5mg Inj (Mounjaro)",
  "Tirzepatide 7.5mg Inj (Mounjaro)",
  "Semaglutide 0.25mg Inj",
  "Semaglutide 0.5mg Inj",
  "Insulin Glargine 100 IU/mL",
  "Insulin Degludec+Aspart (Ryzodeg)",
  "Telmisartan 40mg",
  "Telmisartan 80mg",
  "Ramipril 2.5mg",
  "Ramipril 5mg",
  "Amlodipine 5mg",
  "Amlodipine 10mg",
  "Metoprolol Succinate 25mg",
  "Metoprolol Succinate 50mg",
  "Atorvastatin 10mg",
  "Atorvastatin 20mg",
  "Rosuvastatin 10mg",
  "Rosuvastatin 20mg",
  "Levothyroxine 25mcg",
  "Levothyroxine 50mcg",
  "Levothyroxine 75mcg",
  "Vitamin D 60000 IU",
  "Pantoprazole 40mg",
];

// Day-of-week tokens for weekly medicines. Selected days are appended to the
// `frequency` string as " · Mon, Wed" so no schema change is needed and the
// info displays naturally wherever frequency is rendered.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Map a weekday token to JS Date.getDay() ints (Sun = 0 … Sat = 6) so the
// structured `days_of_week` column lines up with what the patient app reads.
const WEEKDAY_TO_INT = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const AddMedicationModal = memo(function AddMedicationModal({
  onClose,
  onSubmit,
  diagnoses,
  patient,
  labResults,
  activeMeds,
  parentMed,
}) {
  // Top-level active meds eligible to be a parent of a support medicine.
  const parentCandidates = (activeMeds || []).filter(
    (m) => m && !m.parent_medication_id && Number.isFinite(Number(m.id)),
  );
  const [form, setForm] = useState({
    name: "",
    dose: "",
    frequency: "OD",
    route: "Oral",
    for_diagnosis: "",
    started_date: "",
    med_group: "",
    drug_class: "",
    external_doctor: "",
    clinical_note: "",
    notes: "",
    parent_medication_id: parentMed?.id ? String(parentMed.id) : "",
    support_condition: "",
  });
  const isSubMed = !!form.parent_medication_id;
  const [timings, setTimings] = useState([]);
  const [weekdays, setWeekdays] = useState([]); // only used when frequency = "Once weekly"
  const [warning, setWarning] = useState(null);
  const [loading, setLoading] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const toggleTiming = (t) =>
    setTimings((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]));
  const toggleWeekday = (d) =>
    setWeekdays((ws) => (ws.includes(d) ? ws.filter((x) => x !== d) : [...ws, d]));

  const handleNameChange = (e) => {
    const name = e.target.value;
    set("name", name);
    setWarning(getWarning(name, { labResults, diagnoses, activeMeds, patient }));

    // Auto-populate from drug database
    const drug = findDrug(name);
    if (drug) {
      // Auto-set group and drug class
      set("med_group", drug.group);
      set("drug_class", drug.drugClass);

      // Auto-set default dose if not already set
      if (!form.dose && drug.defaultDose) {
        set("dose", drug.defaultDose);
      }

      // Auto-set default timing
      if (drug.defaultTiming) {
        setTimings([drug.defaultTiming]);
      }

      // Auto-set frequency
      if (drug.defaultFrequency) {
        set("frequency", drug.defaultFrequency);
      }

      // Special instructions for thyroid meds
      if (drug.criticalNote) {
        set("notes", drug.criticalNote);
      }
    }

    // Special handling for specific drugs
    if (/levothyroxine|thyroxine|eltroxin/i.test(name)) {
      setTimings(["Empty stomach — 30 min before breakfast"]);
      set("notes", "30 min before breakfast");
    } else if (/atorvastatin|rosuvastatin/i.test(name)) {
      setTimings(["At night (after dinner)"]);
    }
  };

  // Check if showing drug class selector
  const showDrugClass = form.med_group === "diabetes";
  // Check if showing external doctor field
  const showExternalDoctor = form.med_group === "external";

  const supportsWeekday = form.frequency === "Once weekly" || form.frequency === "Once in 14 days";

  const handleSubmit = async () => {
    if (loading) return;
    // For weekly / fortnightly medicines, append the selected day(s) to the
    // frequency string so it persists without a schema change.
    // EditMedicationModal parses this suffix back out.
    const finalFrequency =
      supportsWeekday && weekdays.length
        ? `${form.frequency} · ${weekdays.join(", ")}`
        : form.frequency;
    const daysOfWeek =
      supportsWeekday && weekdays.length
        ? weekdays
            .map((d) => WEEKDAY_TO_INT[d])
            .filter((n) => typeof n === "number")
            .sort((a, b) => a - b)
        : null;
    const submitData = {
      ...form,
      frequency: finalFrequency,
      timing: timings.join(", "),
      days_of_week: daysOfWeek,
      // Only include relevant fields
      drug_class: showDrugClass ? form.drug_class : null,
      external_doctor: showExternalDoctor ? form.external_doctor : null,
      parent_medication_id: form.parent_medication_id ? Number(form.parent_medication_id) : null,
      support_condition: form.parent_medication_id ? form.support_condition || null : null,
    };
    setLoading(true);
    try {
      await onSubmit(submitData);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="mo open"
      onClick={(e) => {
        if (loading) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mbox" style={{ width: 500 }}>
        <div className="mttl">💊 {isSubMed ? "Add Support Medicine" : "Add New Medicine"}</div>

        {/* Sub-medicine selector — pick a parent to make this a support med. */}
        {parentCandidates.length > 0 && (
          <div className="mf">
            <label className="ml">Type</label>
            <select
              className="ms"
              value={form.parent_medication_id}
              onChange={(e) => set("parent_medication_id", e.target.value)}
            >
              <option value="">New medicine (standalone)</option>
              {parentCandidates.map((m) => (
                <option key={m.id} value={String(m.id)}>
                  Support medicine for {m.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {isSubMed && (
          <div className="mf">
            <label className="ml">Support for what</label>
            <input
              className="mi"
              placeholder="e.g. SOS for nausea/vomiting"
              value={form.support_condition}
              onChange={(e) => set("support_condition", e.target.value)}
            />
          </div>
        )}

        {/* Medicine name */}
        <div className="mf">
          <label className="ml">Medicine name *</label>
          <input
            className="mi"
            list="med-add-list"
            placeholder="Type to search..."
            value={form.name}
            onChange={handleNameChange}
          />
          <datalist id="med-add-list">
            {DRUG_LIST.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </div>

        {warning && (
          <div
            className={`noticebar ${
              warning.level === "RED" ? "red" : warning.level === "AMBER" ? "amb" : "pri"
            }`}
            style={{ marginTop: 6, marginBottom: 8 }}
          >
            {warning.message}
          </div>
        )}

        {/* Medication Group */}
        <div className="mf">
          <label className="ml">Group</label>
          <select
            className="ms"
            value={form.med_group}
            onChange={(e) => set("med_group", e.target.value)}
          >
            <option value="">Auto-detect from name</option>
            {MED_GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.icon} {g.label}
              </option>
            ))}
          </select>
        </div>

        {/* Drug Class (for diabetes) */}
        {showDrugClass && (
          <div className="mf">
            <label className="ml">Drug Class</label>
            <select
              className="ms"
              value={form.drug_class}
              onChange={(e) => set("drug_class", e.target.value)}
            >
              <option value="">Select...</option>
              {DIABETES_CLASSES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* External Doctor (for external meds) */}
        {showExternalDoctor && (
          <div className="mf">
            <label className="ml">Prescribing Doctor *</label>
            <input
              className="mi"
              placeholder="e.g. Dr. Sharma, Cardiologist"
              value={form.external_doctor}
              onChange={(e) => set("external_doctor", e.target.value)}
            />
            <div style={{ fontSize: 10, color: "var(--red)", marginTop: 4 }}>
              Never modify without their consent
            </div>
          </div>
        )}

        <div className="g2">
          <div className="mf">
            <label className="ml">Dosage</label>
            <input
              className="mi"
              placeholder="e.g. 500 mg, 24 Units"
              value={form.dose}
              onChange={(e) => set("dose", e.target.value)}
            />
          </div>
          <div className="mf">
            <label className="ml">Frequency</label>
            <select
              className="ms"
              value={form.frequency}
              onChange={(e) => set("frequency", e.target.value)}
            >
              <option value="OD">Once daily (OD)</option>
              <option value="BD">Twice daily (BD)</option>
              <option value="TDS">Three times (TDS)</option>
              <option value="Once weekly">Once weekly</option>
              <option value="Once in 14 days">Once in 14 days</option>
              <option value="SOS">As needed (SOS)</option>
            </select>
          </div>
        </div>

        {supportsWeekday && (
          <div className="mf">
            <label className="ml">
              On which day{weekdays.length > 1 ? "s" : ""}{" "}
              <span style={{ color: "var(--t3)", fontWeight: 400, fontSize: 11 }}>(optional)</span>
            </label>
            <div className="time-pills">
              {WEEKDAYS.map((d) => (
                <label key={d}>
                  <input
                    type="checkbox"
                    checked={weekdays.includes(d)}
                    onChange={() => toggleWeekday(d)}
                  />
                  <span>{d}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="mf">
          <label className="ml">When to take</label>
          <div className="time-pills">
            {TIMING_OPTIONS.slice(0, 8).map((t) => (
              <label key={t.value}>
                <input
                  type="checkbox"
                  checked={timings.includes(t.value)}
                  onChange={() => toggleTiming(t.value)}
                />
                <span>{t.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Route + Started date */}
        <div className="g2">
          <div className="mf">
            <label className="ml">Route</label>
            <select
              className="ms"
              value={form.route}
              onChange={(e) => set("route", e.target.value)}
            >
              <option value="Oral">Oral</option>
              <option value="Subcutaneous">Subcutaneous</option>
              <option value="Intramuscular">Intramuscular</option>
              <option value="Intravenous">Intravenous</option>
              <option value="Topical">Topical</option>
              <option value="Inhaled">Inhaled</option>
              <option value="Sublingual">Sublingual</option>
            </select>
          </div>
          <div className="mf">
            <label className="ml">
              Started on{" "}
              <span style={{ color: "var(--t3)", fontWeight: 400, fontSize: 11 }}>(optional)</span>
            </label>
            <input
              type="date"
              className="mi"
              value={form.started_date}
              onChange={(e) => set("started_date", e.target.value)}
            />
          </div>
        </div>

        {/* Clinical note */}
        <div className="mf">
          <label className="ml">Clinical Note</label>
          <input
            className="mi"
            placeholder="e.g. Renal protection — UACR 88"
            value={form.clinical_note}
            onChange={(e) => set("clinical_note", e.target.value)}
          />
        </div>

        <div className="mf">
          <label className="ml">Additional instruction</label>
          <input
            className="mi"
            placeholder="e.g. 30 min before breakfast, with food"
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </div>

        <div className="mf">
          <label className="ml">Prescribed for</label>
          <select
            className="ms"
            value={form.for_diagnosis}
            onChange={(e) => set("for_diagnosis", e.target.value)}
          >
            <option value="">Select...</option>
            {(diagnoses || []).map((d) => (
              <option key={d.id} value={d.label || d.diagnosis_id}>
                {d.label || d.diagnosis_id}
              </option>
            ))}
          </select>
        </div>

        <div className="macts">
          <button className="btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn-p"
            disabled={loading || !form.name || (showExternalDoctor && !form.external_doctor)}
            onClick={handleSubmit}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              opacity: loading ? 0.75 : 1,
              cursor: loading
                ? "not-allowed"
                : !form.name || (showExternalDoctor && !form.external_doctor)
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            {loading && (
              <span
                aria-hidden="true"
                style={{
                  width: 12,
                  height: 12,
                  border: "2px solid rgba(255,255,255,0.4)",
                  borderTopColor: "#fff",
                  borderRadius: "50%",
                  display: "inline-block",
                  animation: "spin 0.7s linear infinite",
                }}
              />
            )}
            {loading
              ? isSubMed
                ? "Adding…"
                : "Adding…"
              : isSubMed
                ? "Add Support Medicine"
                : "Add Medicine"}
          </button>
        </div>
      </div>
    </div>
  );
});

export default AddMedicationModal;
