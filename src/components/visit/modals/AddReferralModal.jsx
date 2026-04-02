import { memo, useState } from "react";

const SPECIALTIES = [
  "Cardiology","Nephrology","Ophthalmology","Urology","Gastroenterology",
  "Orthopedics","Physiotherapy","Dietetics","Podiatry",
];

const AddReferralModal = memo(function AddReferralModal({ onClose, onSubmit }) {
  const [form, setForm] = useState({ doctor_name: "", speciality: "", reason: "" });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox">
        <div className="mttl">👨‍⚕️ Add Referral</div>
        <div className="g2">
          <div className="mf">
            <label className="ml">Doctor name *</label>
            <input className="mi" placeholder="e.g. Dr. Sharma" value={form.doctor_name} onChange={(e) => set("doctor_name", e.target.value)} />
          </div>
          <div className="mf">
            <label className="ml">Speciality *</label>
            <input className="mi" list="spec-add-list" placeholder="e.g. Cardiology" value={form.speciality} onChange={(e) => set("speciality", e.target.value)} />
            <datalist id="spec-add-list">{SPECIALTIES.map((s) => <option key={s} value={s} />)}</datalist>
          </div>
        </div>
        <div className="mf">
          <label className="ml">Reason for referral</label>
          <textarea className="mta" style={{ minHeight: 55 }} placeholder="Reason for referral..." value={form.reason} onChange={(e) => set("reason", e.target.value)} />
        </div>
        <div className="macts">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-p" disabled={!form.doctor_name || !form.speciality} onClick={() => onSubmit(form)}>Add Referral</button>
        </div>
      </div>
    </div>
  );
});

export default AddReferralModal;
