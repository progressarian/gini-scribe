import { useState } from "react";
import { useNavigate } from "react-router-dom";
import useAuthStore from "../stores/authStore.js";
import usePatientStore from "../stores/patientStore.js";
import useUiStore from "../stores/uiStore.js";
import AudioInput from "../components/AudioInput.jsx";
import Err from "../components/Err.jsx";
import api from "../services/api.js";
import "./PatientPage.css";

export default function PatientPage() {
  const navigate = useNavigate();
  const { dgKey, whisperKey } = useAuthStore();
  const {
    patient,
    duplicateWarning,
    setDuplicateWarning,
    dbPatientId,
    loadPatientDB,
    updatePatient,
    voiceFillPatient,
    savePatient,
  } = usePatientStore();
  const { loading, errors, clearErr } = useUiStore();
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [resettingPw, setResettingPw] = useState(false);
  const [tempPassword, setTempPassword] = useState(null);
  const [resetError, setResetError] = useState(null);

  const handleResetAppPassword = async () => {
    if (!dbPatientId) return;
    if (
      !window.confirm(
        "Generate a temporary app password for this patient?\n\n" +
          "Their old password will stop working immediately. They'll be forced to set a new password on next sign-in.",
      )
    )
      return;
    setResettingPw(true);
    setResetError(null);
    setTempPassword(null);
    try {
      const res = await api.post(`/api/patients/${dbPatientId}/reset-app-password`);
      setTempPassword(res.data.temp_password);
    } catch (e) {
      setResetError(e?.response?.data?.error || e.message || "Reset failed");
    } finally {
      setResettingPw(false);
    }
  };

  const handleSave = async () => {
    const errs = {};
    if (!patient.name?.trim()) errs.name = true;
    if (Object.keys(errs).length) {
      setFieldErrors(errs);
      setSaveMsg({ type: "error", text: "Please fill required fields" });
      return;
    }
    setFieldErrors({});
    setSaving(true);
    setSaveMsg(null);
    const result = await savePatient();
    setSaving(false);
    if (result.error) {
      setSaveMsg({ type: "error", text: result.error });
    } else {
      setSaveMsg({
        type: "success",
        text: dbPatientId ? "Patient updated" : "Patient created",
      });
      setTimeout(() => navigate("/dashboard"), 600);
    }
  };

  return (
    <div className="patient-page">
      <AudioInput
        label="Say patient details"
        dgKey={dgKey}
        whisperKey={whisperKey}
        color="#1e40af"
        compact
        onTranscript={voiceFillPatient}
      />
      {loading.pv && <div className="patient-page__filling">🔬 Filling fields...</div>}
      <Err msg={errors.pv} onDismiss={() => clearErr("pv")} />
      <div className="patient-page__grid">
        {[
          { k: "name", l: "Full Name *", ph: "Rajinder Singh", span: 2 },
          { k: "phone", l: "Phone", ph: "+91 98765 43210" },
          { k: "fileNo", l: "File No.", ph: "GINI-2025-04821" },
          { k: "dob", l: "DOB", type: "date" },
          { k: "age", l: "Age", ph: "77", disabled: !!patient.dob },
          { k: "address", l: "Address", ph: "House No, Sector, City", span: 2 },
        ].map((f) => (
          <div key={f.k} style={{ gridColumn: f.span ? "span 2" : "span 1" }}>
            <label
              className={`patient-page__label ${(f.k === "fileNo" || f.k === "phone") && duplicateWarning ? "patient-page__label--error" : ""}`}
            >
              {f.l}
            </label>
            <input
              type={f.type || "text"}
              value={patient[f.k]}
              onChange={(e) => {
                updatePatient(f.k, e.target.value);
                if (fieldErrors[f.k] && e.target.value.trim())
                  setFieldErrors((p) => ({ ...p, [f.k]: false }));
              }}
              disabled={f.disabled}
              placeholder={f.ph}
              className={`patient-page__input ${fieldErrors[f.k] ? "patient-page__input--error" : ""} ${(f.k === "fileNo" || f.k === "phone") && duplicateWarning ? "patient-page__input--error" : ""} ${f.disabled ? "patient-page__input--disabled" : ""}`}
            />
          </div>
        ))}
        <div>
          <label className="patient-page__label">Sex</label>
          <div className="patient-page__sex-btns">
            {["Male", "Female"].map((s) => (
              <button
                key={s}
                onClick={() => updatePatient("sex", s)}
                className={`patient-page__sex-btn ${patient.sex === s ? "patient-page__sex-btn--active" : "patient-page__sex-btn--inactive"}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!dbPatientId && duplicateWarning && (
        <div className="patient-page__dup-warning">
          <div className="patient-page__dup-title">⚠️ This patient file already exists!</div>
          <div className="patient-page__dup-details">
            <b>{duplicateWarning.name}</b>
            {duplicateWarning.file_no ? ` · ${duplicateWarning.file_no}` : ""}
            {duplicateWarning.phone ? ` · ${duplicateWarning.phone}` : ""}
            {duplicateWarning.age
              ? ` · ${duplicateWarning.age}Y/${(duplicateWarning.sex || "?").charAt(0)}`
              : ""}
          </div>
          <div className="patient-page__dup-hint">
            Please look up this patient from Find Patient, or use a different file number.
          </div>
          <div className="patient-page__dup-actions">
            <button
              onClick={() => {
                loadPatientDB({
                  id: duplicateWarning.id,
                  name: duplicateWarning.name,
                  phone: duplicateWarning.phone,
                  file_no: duplicateWarning.file_no,
                  age: duplicateWarning.age,
                  sex: duplicateWarning.sex,
                });
                setDuplicateWarning(null);
              }}
              className="patient-page__dup-load-btn"
            >
              Load Existing Patient
            </button>
            <button
              onClick={() => {
                updatePatient("fileNo", "");
                setDuplicateWarning(null);
              }}
              className="patient-page__dup-clear-btn"
            >
              Clear File No
            </button>
          </div>
        </div>
      )}

      <details className="patient-page__ids">
        <summary className="patient-page__ids-summary">Health & Government IDs (optional)</summary>
        <div className="patient-page__ids-grid">
          <div>
            <label className="patient-page__label">ABHA ID</label>
            <input
              value={patient.abhaId || ""}
              onChange={(e) => updatePatient("abhaId", e.target.value)}
              placeholder="XX-XXXX-XXXX-XXXX"
              className="patient-page__id-input"
            />
          </div>
          <div>
            <label className="patient-page__label">Health ID</label>
            <input
              value={patient.healthId || ""}
              onChange={(e) => updatePatient("healthId", e.target.value)}
              placeholder="MyHealth Genie ID"
              className="patient-page__id-input"
            />
          </div>
          <div>
            <label className="patient-page__label">Aadhaar</label>
            <input
              value={patient.aadhaar || ""}
              onChange={(e) => updatePatient("aadhaar", e.target.value)}
              placeholder="XXXX XXXX XXXX"
              className="patient-page__id-input"
            />
          </div>
          <div>
            <label className="patient-page__label">
              <select
                value={patient.govtIdType || ""}
                onChange={(e) => updatePatient("govtIdType", e.target.value)}
                className="patient-page__id-type-select"
              >
                <option value="">Other ID</option>
                <option value="Passport">Passport</option>
                <option value="DrivingLicense">Driving License</option>
                <option value="VoterID">Voter ID</option>
                <option value="PAN">PAN</option>
              </select>
            </label>
            <input
              value={patient.govtId || ""}
              onChange={(e) => updatePatient("govtId", e.target.value)}
              placeholder="ID number"
              className="patient-page__id-input"
            />
          </div>
        </div>
      </details>

      {saveMsg && (
        <div
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            marginBottom: 8,
            background: saveMsg.type === "error" ? "#fef2f2" : "#f0fdf4",
            color: saveMsg.type === "error" ? "#dc2626" : "#059669",
            border: `1px solid ${saveMsg.type === "error" ? "#fecaca" : "#bbf7d0"}`,
          }}
        >
          {saveMsg.text}
        </div>
      )}

      {dbPatientId && (
        <div
          style={{
            marginTop: 16,
            marginBottom: 12,
            padding: 12,
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            background: "#f8fafc",
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: "#475569",
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            App access
          </div>
          {tempPassword ? (
            <div
              style={{
                padding: 12,
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 6,
                marginBottom: 8,
              }}
            >
              <div style={{ fontSize: 12, color: "#92400e", marginBottom: 6 }}>
                Read this temporary password to the patient. It won't be shown again.
              </div>
              <div
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 20,
                  fontWeight: 700,
                  letterSpacing: 2,
                  color: "#1f2937",
                  textAlign: "center",
                  padding: "8px 0",
                  background: "#fff",
                  border: "1px solid #fde68a",
                  borderRadius: 4,
                  userSelect: "all",
                }}
              >
                {tempPassword}
              </div>
              <button
                onClick={() => setTempPassword(null)}
                style={{
                  marginTop: 8,
                  background: "transparent",
                  border: "none",
                  color: "#92400e",
                  fontSize: 11,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                I've shared it — hide
              </button>
            </div>
          ) : (
            <button
              onClick={handleResetAppPassword}
              disabled={resettingPw}
              style={{
                padding: "8px 14px",
                borderRadius: 6,
                background: "#0f172a",
                color: "#fff",
                border: "none",
                fontSize: 13,
                fontWeight: 600,
                cursor: resettingPw ? "wait" : "pointer",
                opacity: resettingPw ? 0.7 : 1,
              }}
            >
              {resettingPw ? "Generating…" : "Reset app password"}
            </button>
          )}
          {resetError && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#dc2626" }}>{resetError}</div>
          )}
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving || !patient.name}
        className={`patient-page__next-btn ${patient.name && !saving ? "patient-page__next-btn--active" : "patient-page__next-btn--disabled"}`}
      >
        {saving
          ? "Saving..."
          : dbPatientId
            ? "Save Changes"
            : patient.name
              ? "Save & Continue"
              : "Enter name first"}
      </button>
    </div>
  );
}
