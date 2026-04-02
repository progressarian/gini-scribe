import { memo, useState } from "react";

const DRUG_LIST = [
  "Metformin 500mg","Metformin 1000mg","Glimepiride 1mg","Glimepiride 2mg",
  "Gliclazide MR 30mg","Gliclazide MR 60mg","Sitagliptin 100mg","Vildagliptin 50mg",
  "Empagliflozin 10mg","Empagliflozin 25mg","Dapagliflozin 10mg","Canagliflozin 100mg",
  "Tirzepatide 2.5mg Inj (Mounjaro)","Tirzepatide 5mg Inj (Mounjaro)","Tirzepatide 7.5mg Inj (Mounjaro)",
  "Semaglutide 0.25mg Inj","Semaglutide 0.5mg Inj","Insulin Glargine 100 IU/mL",
  "Insulin Degludec+Aspart (Ryzodeg)","Telmisartan 40mg","Telmisartan 80mg",
  "Amlodipine 5mg","Metoprolol Succinate 25mg","Metoprolol Succinate 50mg",
  "Atorvastatin 10mg","Atorvastatin 20mg","Rosuvastatin 10mg","Rosuvastatin 20mg",
  "Levothyroxine 25mcg","Levothyroxine 50mcg","Levothyroxine 75mcg",
  "Vitamin D 60000 IU","Pantoprazole 40mg",
];

const TIMINGS = [
  "Fasting","Before breakfast","After breakfast","Before lunch","After lunch",
  "Before dinner","After dinner","At bedtime","With milk","SOS only",
];

const AddMedicationModal = memo(function AddMedicationModal({ onClose, onSubmit, diagnoses }) {
  const [form, setForm] = useState({
    name: "", dose: "", frequency: "OD", route: "Oral",
    for_diagnosis: "", started_date: "",
  });
  const [timings, setTimings] = useState([]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const toggleTiming = (t) => setTimings((ts) => ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]);

  const handleSubmit = () => {
    onSubmit({ ...form, timing: timings.join(", ") });
  };

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox" style={{ width: 460 }}>
        <div className="mttl">💊 Add New Medicine</div>
        <div className="mf">
          <label className="ml">Medicine name *</label>
          <input className="mi" list="med-add-list" placeholder="Type to search..." value={form.name} onChange={(e) => set("name", e.target.value)} />
          <datalist id="med-add-list">{DRUG_LIST.map((d) => <option key={d} value={d} />)}</datalist>
        </div>
        <div className="g2">
          <div className="mf">
            <label className="ml">Dosage</label>
            <input className="mi" placeholder="e.g. 500 mg, 24 Units" value={form.dose} onChange={(e) => set("dose", e.target.value)} />
          </div>
          <div className="mf">
            <label className="ml">Frequency</label>
            <select className="ms" value={form.frequency} onChange={(e) => set("frequency", e.target.value)}>
              <option value="OD">Once daily (OD)</option>
              <option value="BD">Twice daily (BD)</option>
              <option value="TDS">Three times (TDS)</option>
              <option value="Once weekly">Once weekly</option>
              <option value="Once in 14 days">Once in 14 days</option>
              <option value="SOS">As needed (SOS)</option>
            </select>
          </div>
        </div>
        <div className="mf">
          <label className="ml">When to take</label>
          <div className="time-pills">
            {TIMINGS.map((t) => (
              <label key={t}>
                <input type="checkbox" checked={timings.includes(t)} onChange={() => toggleTiming(t)} />
                <span>{t}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="g2">
          <div className="mf">
            <label className="ml">Prescribed for</label>
            <select className="ms" value={form.for_diagnosis} onChange={(e) => set("for_diagnosis", e.target.value)}>
              <option value="">Select...</option>
              {(diagnoses || []).map((d) => <option key={d.id} value={d.label || d.diagnosis_id}>{d.label || d.diagnosis_id}</option>)}
            </select>
          </div>
          <div className="mf">
            <label className="ml">Prescribed since</label>
            <input className="mi" type="date" value={form.started_date} onChange={(e) => set("started_date", e.target.value)} />
          </div>
        </div>
        <div className="macts">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-p" disabled={!form.name} onClick={handleSubmit}>Add Medicine</button>
        </div>
      </div>
    </div>
  );
});

export default AddMedicationModal;
