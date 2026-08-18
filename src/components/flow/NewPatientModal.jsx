// Full patient registration from the reception check-in screen.
//
// Before this existed, "New patient" only cleared the form and the record was
// created implicitly at submit time from four fields (name/phone/age/sex).
// Reception had no way to capture an address, an ABHA id or a DOB without
// leaving the screen, so those were simply never recorded for walk-ins.
//
// Creates the patients row up-front via POST /api/patients (which upserts on
// file_no/abha_id and mints GNI-##### when no file number is given), so the
// check-in form receives a real patient id and skips its own upsert.
import { useState } from "react";
import api from "../../services/api";
import { toast } from "../../stores/uiStore";

const SEXES = ["Male", "Female", "Other"]; // patientCreateSchema is a strict enum

const EMPTY = {
  name: "",
  phone: "",
  age: "",
  dob: "",
  sex: "",
  address: "",
  email: "",
  file_no: "",
  abha_id: "",
  health_id: "",
  aadhaar: "",
  govt_id: "",
  govt_id_type: "",
};

export default function NewPatientModal({ onClose, onCreated, initial = {} }) {
  const [f, setF] = useState({ ...EMPTY, ...initial });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  // { patient } when a likely-existing record was found — reception confirms or
  // switches to it rather than minting a second chart for the same person.
  const [dupe, setDupe] = useState(null);
  const [more, setMore] = useState(false);

  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const phoneOk = !f.phone || /^[6-9]\d{9}$/.test(f.phone);
  const canSave = f.name.trim() && phoneOk && (f.age || f.dob) && f.sex;

  // Duplicate patient records are the expensive mistake here: the chart splits
  // in two and the history never rejoins. Check both identifiers we can —
  // exact phone (GET /api/patients short-circuits on it) and the
  // name+age+sex triple that check-duplicate supports.
  const findDuplicate = async () => {
    try {
      if (f.phone && /^[6-9]\d{9}$/.test(f.phone)) {
        const { data } = await api.get(`/api/patients?q=${f.phone}&limit=3`);
        const hit = (data?.data || data || []).find(
          (p) => (p.phone || "").replace(/\D/g, "").slice(-10) === f.phone,
        );
        if (hit) return hit;
      }
      if (f.name.trim() && f.age && f.sex) {
        const { data } = await api.get(
          `/api/patients/check-duplicate?name=${encodeURIComponent(f.name.trim())}&age=${f.age}&sex=${f.sex}`,
        );
        if (data?.exists) return data.patient;
      }
    } catch {
      /* best-effort — never block registration on the duplicate probe */
    }
    return null;
  };

  const save = async (force = false) => {
    setErr("");
    if (!canSave) return;
    setSaving(true);
    try {
      if (!force) {
        const hit = await findDuplicate();
        if (hit) {
          setDupe(hit);
          setSaving(false);
          return;
        }
      }
      const body = {
        name: f.name.trim(),
        phone: f.phone ? `91${f.phone}` : undefined,
        age: f.age ? parseInt(f.age) : undefined,
        dob: f.dob || undefined,
        sex: f.sex || undefined,
        address: f.address.trim() || undefined,
        email: f.email.trim() || undefined,
        file_no: f.file_no.trim() || undefined,
        abha_id: f.abha_id.trim() || undefined,
        health_id: f.health_id.trim() || undefined,
        aadhaar: f.aadhaar.trim() || undefined,
        govt_id: f.govt_id.trim() || undefined,
        govt_id_type: f.govt_id_type.trim() || undefined,
      };
      const { data } = await api.post("/api/patients", body);
      toast(
        data._isNew === false
          ? `Updated existing record · File ${data.file_no}`
          : `Registered ${data.name} · File ${data.file_no}`,
        "success",
      );
      onCreated(data);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || "Could not save the patient");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        zIndex: 500,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "40px 16px",
        overflow: "auto",
      }}
    >
      <div
        className="flow-root"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560, width: "100%", padding: 0, borderRadius: 10, minHeight: 0 }}
      >
        <div className="flow-card" style={{ borderRadius: 10 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <div>
              <div className="flow-title" style={{ fontSize: 16 }}>
                Register new patient
              </div>
              <div className="flow-sub">File number is generated automatically if left blank.</div>
            </div>
            <button
              className="flow-btn flow-btn-ghost flow-btn-mini"
              style={{ marginLeft: "auto" }}
              onClick={onClose}
            >
              ✕
            </button>
          </div>

          {dupe && (
            <div className="flow-alert flow-alert-amb" style={{ marginBottom: 10 }}>
              <b>{dupe.name}</b> ({[dupe.file_no, dupe.phone].filter(Boolean).join(" · ")}) already
              exists. Use that record instead of creating a second chart.
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button
                  className="flow-btn flow-btn-primary flow-btn-mini"
                  onClick={() => onCreated(dupe)}
                >
                  Use existing
                </button>
                <button
                  className="flow-btn flow-btn-ghost flow-btn-mini"
                  onClick={() => {
                    setDupe(null);
                    save(true);
                  }}
                >
                  Create anyway
                </button>
              </div>
            </div>
          )}

          {err && (
            <div className="flow-alert flow-alert-red" style={{ marginBottom: 10 }}>
              {err}
            </div>
          )}

          <div className="flow-grid2">
            <div className="flow-field">
              <label>Patient name *</label>
              <input value={f.name} onChange={(e) => set("name", e.target.value)} autoFocus />
            </div>
            <div className="flow-field">
              <label>Phone (WhatsApp)</label>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit mobile"
                value={f.phone}
                onChange={(e) => set("phone", e.target.value.replace(/\D/g, "").slice(0, 10))}
                style={phoneOk ? undefined : { borderColor: "var(--fre)" }}
              />
            </div>
            <div className="flow-field">
              <label>Age *</label>
              <input
                type="number"
                min="0"
                max="120"
                value={f.age}
                onChange={(e) => set("age", e.target.value)}
              />
            </div>
            <div className="flow-field">
              <label>Date of birth</label>
              <input type="date" value={f.dob} onChange={(e) => set("dob", e.target.value)} />
            </div>
          </div>

          <div className="flow-field" style={{ marginTop: 10 }}>
            <label>Sex *</label>
            <div style={{ display: "flex", gap: 6 }}>
              {SEXES.map((s) => (
                <div
                  key={s}
                  className={`flow-toggle${f.sex === s ? " on" : ""}`}
                  style={{ flex: 1, textAlign: "center" }}
                  onClick={() => set("sex", s)}
                >
                  {s}
                </div>
              ))}
            </div>
          </div>

          <div className="flow-field" style={{ marginTop: 10 }}>
            <label>Address</label>
            <input value={f.address} onChange={(e) => set("address", e.target.value)} />
          </div>

          <button
            className="flow-btn flow-btn-ghost flow-btn-mini"
            style={{ marginTop: 10 }}
            onClick={() => setMore((m) => !m)}
          >
            {more ? "− Fewer fields" : "+ File number, ABHA, ID proof, email"}
          </button>

          {more && (
            <div className="flow-grid2" style={{ marginTop: 10 }}>
              <div className="flow-field">
                <label>File number</label>
                <input
                  placeholder="Auto (GNI-…)"
                  value={f.file_no}
                  onChange={(e) => set("file_no", e.target.value)}
                />
              </div>
              <div className="flow-field">
                <label>Email</label>
                <input
                  type="email"
                  value={f.email}
                  onChange={(e) => set("email", e.target.value)}
                />
              </div>
              <div className="flow-field">
                <label>ABHA id</label>
                <input value={f.abha_id} onChange={(e) => set("abha_id", e.target.value)} />
              </div>
              <div className="flow-field">
                <label>Health id</label>
                <input value={f.health_id} onChange={(e) => set("health_id", e.target.value)} />
              </div>
              <div className="flow-field">
                <label>Aadhaar</label>
                <input value={f.aadhaar} onChange={(e) => set("aadhaar", e.target.value)} />
              </div>
              <div className="flow-field">
                <label>Other govt ID</label>
                <input
                  placeholder="Number"
                  value={f.govt_id}
                  onChange={(e) => set("govt_id", e.target.value)}
                />
              </div>
              <div className="flow-field">
                <label>Govt ID type</label>
                <input
                  placeholder="PAN / Voter / Driving licence"
                  value={f.govt_id_type}
                  onChange={(e) => set("govt_id_type", e.target.value)}
                />
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button
              className="flow-btn flow-btn-primary"
              disabled={!canSave || saving}
              onClick={() => save(false)}
            >
              {saving ? "Saving…" : "Register & fill check-in"}
            </button>
            <button className="flow-btn flow-btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
