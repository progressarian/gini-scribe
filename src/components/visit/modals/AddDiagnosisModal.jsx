import { memo, useState } from "react";

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
  const [form, setForm] = useState({ name: "", icd_code: "", status: "New", notes: "" });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox">
        <div className="mttl">🏷 Add Diagnosis</div>
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
        <div className="g2">
          <div className="mf">
            <label className="ml">ICD Code (optional)</label>
            <input
              className="mi"
              placeholder="e.g. E11, I10"
              value={form.icd_code}
              onChange={(e) => set("icd_code", e.target.value)}
            />
          </div>
          <div className="mf">
            <label className="ml">Status</label>
            <select
              className="ms"
              value={form.status}
              onChange={(e) => set("status", e.target.value)}
            >
              <option>New</option>
              <option>Active</option>
              <option>Monitoring</option>
            </select>
          </div>
        </div>
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
          <button className="btn-p" disabled={!form.name} onClick={() => onSubmit(form)}>
            Add Diagnosis
          </button>
        </div>
      </div>
    </div>
  );
});

export default AddDiagnosisModal;
