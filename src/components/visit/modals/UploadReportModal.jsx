import { memo, useState, useRef } from "react";

const REPORT_TYPES = [
  { value: "lab_report", label: "Blood Report (HbA1c, Lipids, TFT, KFT)" },
  { value: "imaging", label: "Radiology (X-Ray, USG, Echo, MRI, CT)" },
  { value: "abi", label: "ABI (Ankle-Brachial Index)" },
  { value: "vpt", label: "VPT (Vibration Perception Threshold)" },
  { value: "ecg", label: "ECG / Holter" },
  { value: "urine", label: "Urine Report" },
  { value: "other", label: "Other" },
];

const UploadReportModal = memo(function UploadReportModal({ onClose, onSubmit }) {
  const [form, setForm] = useState({ doc_type: "lab_report", doc_date: "", source: "", notes: "" });
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleFile = (f) => {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { alert("File too large (max 10MB)"); return; }
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setFile(reader.result.split(",")[1]); // base64 part
    reader.readAsDataURL(f);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox" style={{ width: 440 }}>
        <div className="mttl">📎 Upload Lab / Radiology Report</div>
        <div className="mf">
          <label className="ml">Report Type *</label>
          <select className="ms" value={form.doc_type} onChange={(e) => set("doc_type", e.target.value)}>
            {REPORT_TYPES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div className="g2">
          <div className="mf">
            <label className="ml">Lab / Report Date *</label>
            <input className="mi" type="date" value={form.doc_date} onChange={(e) => set("doc_date", e.target.value)} />
          </div>
          <div className="mf">
            <label className="ml">Lab / Hospital Name</label>
            <input className="mi" placeholder="e.g. SRL Diagnostics" value={form.source} onChange={(e) => set("source", e.target.value)} />
          </div>
        </div>
        <div className="mf">
          <label className="ml">Notes (optional)</label>
          <textarea className="mta" style={{ minHeight: 50 }} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </div>
        {/* Drop zone */}
        <div
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          style={{
            border: `2px dashed ${dragging ? "var(--primary)" : "var(--border2)"}`,
            borderRadius: "var(--rs)", padding: "18px 14px", textAlign: "center",
            cursor: "pointer", transition: "border-color .15s", marginBottom: 12,
            background: dragging ? "var(--pri-lt)" : "var(--bg)",
          }}
        >
          <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files?.[0])} />
          {fileName ? (
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--primary)" }}>📄 {fileName}</div>
          ) : (
            <>
              <div style={{ fontSize: 20, marginBottom: 4 }}>📂</div>
              <div style={{ fontSize: 12, color: "var(--t3)" }}>Drop file here or click to browse</div>
              <div style={{ fontSize: 10, color: "var(--t4)", marginTop: 2 }}>PDF, JPG, PNG · Max 10 MB</div>
            </>
          )}
        </div>
        <div className="macts">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-p" disabled={!form.doc_type} onClick={() => onSubmit({ ...form, base64: file, fileName })}>Upload Report</button>
        </div>
      </div>
    </div>
  );
});

export default UploadReportModal;
