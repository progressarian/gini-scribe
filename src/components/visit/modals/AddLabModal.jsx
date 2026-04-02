import { memo, useState } from "react";

const AddLabModal = memo(function AddLabModal({ onClose, onSubmit }) {
  const [form, setForm] = useState({ test_name: "", result: "", unit: "", test_date: "" });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox">
        <div className="mttl">🧪 Add Lab Value</div>
        <div className="g2">
          <div className="mf">
            <label className="ml">Test name *</label>
            <input className="mi" placeholder="e.g. TSH, Uric Acid" value={form.test_name} onChange={(e) => set("test_name", e.target.value)} />
          </div>
          <div className="mf">
            <label className="ml">Value *</label>
            <input className="mi" type="number" step="any" placeholder="e.g. 6.4" value={form.result} onChange={(e) => set("result", e.target.value)} />
          </div>
        </div>
        <div className="g2">
          <div className="mf">
            <label className="ml">Unit</label>
            <input className="mi" placeholder="e.g. µIU/mL" value={form.unit} onChange={(e) => set("unit", e.target.value)} />
          </div>
          <div className="mf">
            <label className="ml">Date of test</label>
            <input className="mi" type="date" value={form.test_date} onChange={(e) => set("test_date", e.target.value)} />
          </div>
        </div>
        <div className="macts">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-p" disabled={!form.test_name || !form.result} onClick={() => onSubmit(form)}>Add Value</button>
        </div>
      </div>
    </div>
  );
});

export default AddLabModal;
