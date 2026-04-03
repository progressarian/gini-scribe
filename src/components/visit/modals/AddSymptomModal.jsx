import { memo, useState, useMemo } from "react";

const SEVERITY_OPTS = ["Mild", "Moderate", "Severe"];

const SYMPTOM_LIST = [
  "Excessive thirst (polydipsia)",
  "Frequent urination (polyuria)",
  "Fatigue and low energy",
  "Blurred vision",
  "Nausea or vomiting",
  "Bloating or acidity",
  "Numbness or tingling in feet",
  "Burning sensation in feet",
  "Swelling in feet (pedal oedema)",
  "Weight gain",
  "Weight loss",
  "Reduced appetite",
  "Urinary urgency",
  "Urinary frequency",
  "Injection site reaction",
  "Constipation",
  "Diarrhoea",
  "Headache",
  "Dizziness (low BP on standing)",
  "Low blood sugar episode (hypoglycaemia)",
];

const AddSymptomModal = memo(function AddSymptomModal({
  onClose,
  onSubmit,
  activeDx = [],
  activeMeds = [],
}) {
  const [form, setForm] = useState({ name: "", since: "", severity: "Mild", related_to: "" });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const relatedOpts = useMemo(() => {
    const opts = [];
    activeDx.forEach((dx) => opts.push(dx.label || dx.name));
    activeMeds.forEach((m) => {
      if (m.name) opts.push(`Medication side effect (${m.name})`);
    });
    opts.push("Not linked to current diagnosis");
    return opts;
  }, [activeDx, activeMeds]);

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox">
        <div className="mttl">🩹 Add Symptom / Concern</div>
        <div className="mf">
          <label className="ml">Symptom or Concern (Type to Search)</label>
          <input
            className="mi"
            list="sy-add-list"
            placeholder="e.g. Nausea, Burning feet, Swelling..."
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
          <datalist id="sy-add-list">
            {SYMPTOM_LIST.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <div className="g2">
          <div className="mf">
            <label className="ml">Since When</label>
            <input
              className="mi"
              type="date"
              value={form.since}
              onChange={(e) => set("since", e.target.value)}
            />
          </div>
          <div className="mf">
            <label className="ml">Severity</label>
            <select
              className="ms"
              value={form.severity}
              onChange={(e) => set("severity", e.target.value)}
            >
              {SEVERITY_OPTS.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="mf">
          <label className="ml">Related To</label>
          <select
            className="ms"
            value={form.related_to}
            onChange={(e) => set("related_to", e.target.value)}
          >
            {relatedOpts.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div className="macts">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-p" disabled={!form.name} onClick={() => onSubmit(form)}>
            Add Symptom
          </button>
        </div>
      </div>
    </div>
  );
});

export default AddSymptomModal;
