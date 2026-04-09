import { memo, useState } from "react";
import { DX_STATUS_OPTS, DX_CATEGORIES, COMPLICATION_TYPES } from "../helpers";

const DX_LIST = [
  "Type 2 Diabetes Mellitus (T2DM)",
  "Type 1 Diabetes",
  "Prediabetes (Impaired Glucose Tolerance)",
  "Essential Hypertension",
  "Dyslipidemia",
  "MASLD (Metabolic-Associated Steatotic Liver Disease)",
  "Subclinical Hypothyroidism",
  "Clinical Hypothyroidism",
  "Hashimoto's Thyroiditis",
  "Hyperuricemia / Gout",
  "Overactive Bladder (OAB)",
  "Obesity Class 1",
  "Metabolic Syndrome",
  "Vitamin D Deficiency",
  "Vitamin B12 Deficiency",
  "Obstructive Sleep Apnoea",
  "Diabetic Peripheral Neuropathy",
  "Diabetic Retinopathy",
  "Diabetic Nephropathy (CKD)",
];

const AddDiagnosisModal = memo(function AddDiagnosisModal({ onClose, onSubmit }) {
  const [form, setForm] = useState({
    name: "",
    icd_code: "",
    status: "Newly Diagnosed",
    category: "primary",
    complication_type: "",
    external_doctor: "",
    key_value: "",
    trend: "",
    notes: "",
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Check if showing complication type selector
  const showComplicationType = form.category === "complication";
  // Check if showing external doctor field
  const showExternalDoctor = form.category === "external";
  // Check if showing trend field
  const showTrend = form.status === "Worsening";

  const handleSubmit = () => {
    if (!form.name) return;
    // Build the submission object
    const submitData = {
      ...form,
      // Only include relevant fields
      complication_type: showComplicationType ? form.complication_type : null,
      external_doctor: showExternalDoctor ? form.external_doctor : null,
      trend: showTrend ? form.trend : null,
    };
    onSubmit(submitData);
  };

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox" style={{ maxWidth: 480 }}>
        <div className="mttl">🏷 Add Diagnosis</div>

        {/* Diagnosis name */}
        <div className="mf">
          <label className="ml">Diagnosis name *</label>
          <input
            className="mi"
            list="dx-add-list"
            placeholder="Type to search..."
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
          <datalist id="dx-add-list">
            {DX_LIST.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </div>

        {/* Category */}
        <div className="mf">
          <label className="ml">Category</label>
          <select
            className="ms"
            value={form.category}
            onChange={(e) => set("category", e.target.value)}
          >
            {DX_CATEGORIES.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.label}
              </option>
            ))}
          </select>
        </div>

        {/* Complication type (conditional) */}
        {showComplicationType && (
          <div className="mf">
            <label className="ml">Complication Type</label>
            <select
              className="ms"
              value={form.complication_type}
              onChange={(e) => set("complication_type", e.target.value)}
            >
              <option value="">Select type...</option>
              {COMPLICATION_TYPES.map((ct) => (
                <option key={ct.id} value={ct.id}>
                  {ct.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* External doctor (conditional) */}
        {showExternalDoctor && (
          <div className="mf">
            <label className="ml">Prescribing Doctor *</label>
            <input
              className="mi"
              placeholder="e.g. Dr. Sharma, GM"
              value={form.external_doctor}
              onChange={(e) => set("external_doctor", e.target.value)}
            />
            <div style={{ fontSize: 10, color: "var(--t3)", marginTop: 4 }}>
              Never modify treatment without their consent
            </div>
          </div>
        )}

        <div className="g2">
          {/* ICD Code */}
          <div className="mf">
            <label className="ml">ICD Code</label>
            <input
              className="mi"
              placeholder="e.g. E11, I10"
              value={form.icd_code}
              onChange={(e) => set("icd_code", e.target.value)}
            />
          </div>

          {/* Status */}
          <div className="mf">
            <label className="ml">Status</label>
            <select
              className="ms"
              value={form.status}
              onChange={(e) => set("status", e.target.value)}
            >
              {DX_STATUS_OPTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Key value (e.g. HbA1c 10.6%) */}
        <div className="mf">
          <label className="ml">Key Value</label>
          <input
            className="mi"
            placeholder="e.g. HbA1c 10.6%, UACR 88 mg/g"
            value={form.key_value}
            onChange={(e) => set("key_value", e.target.value)}
          />
        </div>

        {/* Trend (if worsening) */}
        {showTrend && (
          <div className="mf">
            <label className="ml">Trend</label>
            <input
              className="mi"
              placeholder="e.g. 48 → 62 → 88"
              value={form.trend}
              onChange={(e) => set("trend", e.target.value)}
            />
            <div style={{ fontSize: 10, color: "var(--t3)", marginTop: 4 }}>
              Enter values separated by → to show progression
            </div>
          </div>
        )}

        {/* Notes */}
        <div className="mf">
          <label className="ml">Notes</label>
          <textarea
            className="mta"
            placeholder="Clinical notes..."
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </div>

        <div className="macts">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-p"
            disabled={!form.name || (showExternalDoctor && !form.external_doctor)}
            onClick={handleSubmit}
          >
            Add Diagnosis
          </button>
        </div>
      </div>
    </div>
  );
});

export default AddDiagnosisModal;
