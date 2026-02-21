import { useState, useRef, useEffect } from "react";

const API_URL = import.meta.env.VITE_API_URL || window.location.origin;
const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_KEY;

const docCategories = [
  { id: "prescription", label: "💊 Prescription", color: "#2563eb" },
  { id: "blood_test", label: "🩸 Blood Test", color: "#dc2626" },
  { id: "thyroid", label: "🦋 Thyroid", color: "#7c3aed" },
  { id: "lipid", label: "🫀 Lipid Profile", color: "#f59e0b" },
  { id: "kidney", label: "🫘 Kidney Fn", color: "#059669" },
  { id: "hba1c", label: "📊 HbA1c", color: "#e11d48" },
  { id: "urine", label: "🧪 Urine", color: "#ca8a04" },
  { id: "xray", label: "🩻 X-Ray", color: "#475569" },
  { id: "usg", label: "📡 Ultrasound", color: "#6366f1" },
  { id: "mri", label: "🧲 MRI / CT", color: "#4f46e5" },
  { id: "dexa", label: "🦴 DEXA", color: "#78716c" },
  { id: "ecg", label: "💓 ECG/Echo", color: "#be123c" },
  { id: "ncs", label: "⚡ NCS/EMG", color: "#0369a1" },
  { id: "eye", label: "👁️ Eye/Fundus", color: "#15803d" },
  { id: "other", label: "📄 Other", color: "#64748b" },
];

const retryFetch = async (url, options, maxRetries = 3) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await fetch(url, options);
    if (r.status === 529 && attempt < maxRetries) {
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
      continue;
    }
    return r;
  }
};

export default function Companion() {
  const [screen, setScreen] = useState("home");
  const [patients, setPatients] = useState([]);
  const [searchText, setSearchText] = useState("");
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [patientData, setPatientData] = useState(null);
  const [patientTab, setPatientTab] = useState("records");
  const [loading, setLoading] = useState(false);
  const [captureStep, setCaptureStep] = useState("camera");
  const [currentCapture, setCurrentCapture] = useState(null);
  const [currentCategory, setCurrentCategory] = useState(null);
  const [captureMeta, setCaptureMeta] = useState({ doctor: "", hospital: "", specialty: "", date: "" });
  const [extractedData, setExtractedData] = useState(null);
  const [captureCount, setCaptureCount] = useState(0);
  const [extracting, setExtracting] = useState(false);
  const [captureError, setCaptureError] = useState(null);
  const [nameMismatch, setNameMismatch] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null);

  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  useEffect(() => { loadPatients(); }, []);

  const loadPatients = async () => {
    try {
      const r = await fetch(`${API_URL}/api/patients?limit=50`);
      if (r.ok) { const data = await r.json(); setPatients(data); }
    } catch (e) { console.error("Load patients:", e); }
  };

  const loadPatientData = async (patientId) => {
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/api/patients/${patientId}`);
      if (r.ok) { const data = await r.json(); setPatientData(data); }
    } catch (e) { console.error("Load patient:", e); }
    setLoading(false);
  };

  const selectPatient = (p) => {
    setSelectedPatient(p);
    setScreen("patient");
    setPatientTab("records");
    loadPatientData(p.id);
  };

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCurrentCapture({
        file,
        preview: reader.result,
        base64: reader.result.split(",")[1],
        fileName: file.name,
        mediaType: file.type || "image/jpeg",
        timestamp: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
      });
      setCaptureStep("categorize");
      setNameMismatch(null);
      setCaptureError(null);
    };
    reader.readAsDataURL(file);
  };

  const checkNameMismatch = (extracted) => {
    const reportName = (extracted.patient_name || extracted.name || "").toLowerCase().trim();
    const selectedName = (selectedPatient?.name || "").toLowerCase().trim();
    if (!reportName || !selectedName || reportName.length < 3) return null;
    const reportParts = reportName.split(/\s+/);
    const selectedParts = selectedName.split(/\s+/);
    const hasMatch = reportParts.some(rp => rp.length > 2 && selectedParts.some(sp => sp.includes(rp) || rp.includes(sp)));
    if (!hasMatch) return { reportName: extracted.patient_name || extracted.name, selectedName: selectedPatient.name };
    return null;
  };

  const extractDocument = async () => {
    if (!currentCapture?.preview || !currentCategory) return;
    setExtracting(true);
    setCaptureError(null);
    setNameMismatch(null);
    setCaptureStep("extracting");

    try {
      const isRx = currentCategory === "prescription";
      const isLab = ["blood_test", "thyroid", "lipid", "kidney", "hba1c", "urine"].includes(currentCategory);

      const prompt = isRx
        ? `Extract from this prescription image. Return JSON:
{"patient_name":"name on document","doctor_name":"","specialty":"","hospital_name":"","visit_date":"YYYY-MM-DD","diagnoses":[{"id":"dm2","label":"Type 2 DM","status":"Active"}],"medications":[{"name":"BRAND","composition":"Generic","dose":"dose","frequency":"OD","timing":"Morning"}],"labs":[{"test_name":"HbA1c","result":"7.2","unit":"%","flag":"HIGH","ref_range":"<6.5"}],"vitals":{"bp_sys":null,"bp_dia":null,"weight":null},"follow_up":"date or duration","advice":"key advice"}`
        : isLab
        ? `Extract lab values from this report image. Return JSON:
{"patient_name":"name on document","labs":[{"test_name":"","result":"","unit":"","flag":"HIGH/LOW/NORMAL","ref_range":""}],"report_date":"YYYY-MM-DD","lab_name":"","summary":"brief clinical interpretation"}`
        : `Extract key findings from this medical document. Return JSON:
{"patient_name":"name on document","doc_type":"${currentCategory}","findings":"","date":"YYYY-MM-DD","doctor":"","notes":""}`;

      const imgData = currentCapture.base64;
      const mediaType = currentCapture.mediaType?.startsWith("image/") ? currentCapture.mediaType : "image/jpeg";

      const r = await retryFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 2000,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imgData } },
            { type: "text", text: prompt + "\n\nReturn ONLY valid JSON. No markdown, no backticks." }
          ]}]
        })
      });

      if (!r.ok) throw new Error(`API ${r.status}`);
      const data = await r.json();
      const text = data.content?.[0]?.text || "";
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      setExtractedData(parsed);

      if (parsed.doctor_name) setCaptureMeta(prev => ({ ...prev, doctor: parsed.doctor_name, hospital: parsed.hospital_name || "", specialty: parsed.specialty || "", date: parsed.visit_date || "" }));
      if (parsed.report_date) setCaptureMeta(prev => ({ ...prev, date: parsed.report_date }));
      if (parsed.lab_name) setCaptureMeta(prev => ({ ...prev, hospital: parsed.lab_name }));

      const mismatch = checkNameMismatch(parsed);
      if (mismatch) setNameMismatch(mismatch);

      setCaptureStep("review");
    } catch (e) {
      console.error("Extraction:", e);
      setCaptureError(e.message);
      setCaptureStep("review");
    }
    setExtracting(false);
  };

  const saveCapture = async () => {
    if (!selectedPatient?.id) return;
    setLoading(true);
    setSaveStatus("Saving...");
    try {
      const isRx = currentCategory === "prescription";
      const isLab = ["blood_test", "thyroid", "lipid", "kidney", "hba1c", "urine"].includes(currentCategory);

      if (isRx && extractedData) {
        setSaveStatus("Saving prescription...");
        const r = await fetch(`${API_URL}/api/patients/${selectedPatient.id}/history`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            visit_date: captureMeta.date || new Date().toISOString().split("T")[0],
            visit_type: "OPD",
            doctor_name: captureMeta.doctor || extractedData.doctor_name || "",
            specialty: captureMeta.specialty || extractedData.specialty || "",
            hospital_name: captureMeta.hospital || extractedData.hospital_name || "",
            diagnoses: extractedData.diagnoses || [],
            medications: extractedData.medications || [],
            labs: (extractedData.labs || []).map(l => ({ test_name: l.test_name, result: l.result, unit: l.unit, flag: l.flag, ref_range: l.ref_range })),
            vitals: extractedData.vitals || {},
          })
        });
        if (!r.ok) throw new Error("Prescription save: " + r.status);
      } else if (isLab && extractedData?.labs?.length) {
        setSaveStatus(`Saving ${extractedData.labs.length} lab values...`);
        for (const lab of extractedData.labs) {
          await fetch(`${API_URL}/api/patients/${selectedPatient.id}/labs`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              test_date: captureMeta.date || new Date().toISOString().split("T")[0],
              test_name: lab.test_name, result: lab.result, unit: lab.unit, flag: lab.flag, ref_range: lab.ref_range, source: captureMeta.hospital || "companion"
            })
          });
        }
      }

      // Save document record
      setSaveStatus("Saving document...");
      const docR = await fetch(`${API_URL}/api/patients/${selectedPatient.id}/documents`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doc_type: currentCategory,
          title: isRx ? `${captureMeta.doctor || "External"} — ${captureMeta.specialty || currentCategory}` : `${(docCategories.find(c => c.id === currentCategory)?.label || currentCategory).replace(/^[^\s]+\s/, "")} — ${captureMeta.date || "Today"}`,
          doc_date: captureMeta.date || new Date().toISOString().split("T")[0],
          source: captureMeta.hospital || "Companion Upload",
          notes: captureMeta.doctor ? `Doctor: ${captureMeta.doctor}` : (extractedData?.summary || ""),
          extracted_data: JSON.stringify(extractedData || {}),
        })
      });

      if (docR.ok) {
        const docData = await docR.json();
        // Upload image as base64 JSON — server expects {base64, mediaType, fileName}
        if (currentCapture.base64 && docData.id) {
          setSaveStatus("Uploading image...");
          try {
            await fetch(`${API_URL}/api/documents/${docData.id}/upload-file`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                base64: currentCapture.base64,
                mediaType: currentCapture.mediaType || "image/jpeg",
                fileName: currentCapture.fileName || `capture_${Date.now()}.jpg`
              })
            });
          } catch (uploadErr) {
            console.warn("Image upload failed (doc still saved):", uploadErr);
          }
        }
      }

      setSaveStatus(null);
      setCaptureCount(prev => prev + 1);
      setCurrentCapture(null);
      setCurrentCategory(null);
      setExtractedData(null);
      setCaptureMeta({ doctor: "", hospital: "", specialty: "", date: "" });
      setCaptureStep("camera");
      setCaptureError(null);
      setNameMismatch(null);
      loadPatientData(selectedPatient.id);
    } catch (e) {
      console.error("Save:", e);
      setCaptureError("Save failed: " + e.message);
      setSaveStatus(null);
    }
    setLoading(false);
  };

  const filtered = patients.filter(p =>
    (p.name || "").toLowerCase().includes(searchText.toLowerCase()) ||
    (p.file_no || "").includes(searchText) ||
    (p.phone || "").includes(searchText)
  );

  const fDate = (d) => {
    try { const s = String(d || ""); const dt = s.length >= 10 ? new Date(s.slice(0, 10) + "T12:00:00") : new Date(s); return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); } catch (e) { return ""; }
  };

  const NavBar = () => (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: 480, margin: "0 auto", background: "white", borderTop: "1px solid #e2e8f0", display: "flex", zIndex: 20, boxShadow: "0 -2px 10px rgba(0,0,0,.08)" }}>
      {[["home", "🏠", "Patients"], ["capture", "📸", "Capture"], ["patient", "👤", "Record"]].map(([id, icon, label]) => (
        <button key={id} onClick={() => { if (id === "capture" && !selectedPatient) { alert("Select a patient first"); return; } setScreen(id); if (id === "capture") setCaptureStep("camera"); }}
          style={{ flex: 1, padding: "8px 4px", border: "none", cursor: "pointer", background: screen === id ? "#eff6ff" : "white", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          <span style={{ fontSize: 18 }}>{icon}</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: screen === id ? "#2563eb" : "#94a3b8" }}>{label}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif", background: "#f8fafc", minHeight: "100vh", paddingBottom: 60 }}>

      {/* HOME */}
      {screen === "home" && (
        <div>
          <div style={{ background: "linear-gradient(135deg, #1e293b, #334155)", color: "white", padding: "14px 16px", position: "sticky", top: 0, zIndex: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800 }}>Gini Companion</div>
                <div style={{ fontSize: 10, opacity: 0.7 }}>{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "short", year: "numeric" })} • Gini Advanced Care</div>
              </div>
              <div style={{ fontSize: 10, background: "#059669", padding: "4px 10px", borderRadius: 8, fontWeight: 700 }}>{patients.length} patients</div>
            </div>
          </div>
          <div style={{ padding: 12 }}>
            <input value={searchText} onChange={e => setSearchText(e.target.value)} placeholder="🔍 Search name, file no, phone..."
              style={{ width: "100%", padding: "10px 14px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13, boxSizing: "border-box", background: "white" }} />
            <div style={{ marginTop: 10 }}>
              {filtered.slice(0, 30).map(p => (
                <div key={p.id} onClick={() => selectPatient(p)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "white", borderRadius: 8, marginBottom: 6, border: "1px solid #e2e8f0", cursor: "pointer" }}>
                  <div style={{ width: 36, height: 36, borderRadius: "50%", background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#2563eb" }}>{(p.name || "?")[0]}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: "#64748b" }}>{p.age}Y/{p.sex?.[0] || "?"} • {p.file_no || "—"}{p.phone ? ` • ${p.phone}` : ""}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 9, color: "#64748b" }}>{p.visit_count || 0} visits</div>
                    {p.last_visit && <div style={{ fontSize: 8, color: "#94a3b8" }}>{fDate(p.last_visit)}</div>}
                  </div>
                </div>
              ))}
              {filtered.length === 0 && <div style={{ textAlign: "center", padding: 30, color: "#94a3b8" }}>No patients found</div>}
            </div>
          </div>
        </div>
      )}

      {/* CAPTURE */}
      {screen === "capture" && selectedPatient && (
        <div>
          <div style={{ background: "#1e293b", color: "white", padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, position: "sticky", top: 0, zIndex: 10 }}>
            <button onClick={() => setScreen("patient")} style={{ background: "none", border: "none", color: "white", fontSize: 18, cursor: "pointer" }}>←</button>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{selectedPatient.name}</div>
              <div style={{ fontSize: 10, opacity: 0.7 }}>Capture Documents{captureCount > 0 ? ` • ${captureCount} saved ✅` : ""}</div>
            </div>
          </div>
          <div style={{ padding: 12 }}>

            {captureStep === "camera" && (
              <div>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <button onClick={() => cameraRef.current?.click()}
                    style={{ flex: 1, padding: "20px 10px", background: "linear-gradient(135deg, #2563eb, #3b82f6)", color: "white", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 800, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 28 }}>📷</span>Take Photo
                  </button>
                  <button onClick={() => fileRef.current?.click()}
                    style={{ flex: 1, padding: "20px 10px", background: "linear-gradient(135deg, #059669, #10b981)", color: "white", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 800, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 28 }}>📁</span>Upload File
                  </button>
                </div>
                <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={handleFileSelect} style={{ display: "none" }} />
                <input ref={fileRef} type="file" accept="image/*,.pdf" onChange={handleFileSelect} style={{ display: "none" }} />
                {captureCount > 0 && (
                  <div style={{ textAlign: "center", padding: 12, background: "#f0fdf4", borderRadius: 8, border: "1px solid #bbf7d0" }}>
                    <div style={{ fontSize: 24 }}>✅</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#059669" }}>{captureCount} document{captureCount > 1 ? "s" : ""} saved</div>
                  </div>
                )}
              </div>
            )}

            {captureStep === "categorize" && currentCapture && (
              <div>
                {currentCapture.preview && (
                  <div style={{ marginBottom: 10, borderRadius: 8, overflow: "hidden", border: "1px solid #e2e8f0", maxHeight: 200 }}>
                    <img src={currentCapture.preview} alt="Captured" style={{ width: "100%", objectFit: "cover", maxHeight: 200 }} />
                  </div>
                )}
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: "#1e293b" }}>What type of document is this?</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                  {docCategories.map(cat => (
                    <button key={cat.id} onClick={() => setCurrentCategory(cat.id)}
                      style={{ padding: "8px 4px", borderRadius: 8, fontSize: 10, fontWeight: 700, cursor: "pointer", textAlign: "center",
                        background: currentCategory === cat.id ? cat.color : "white", color: currentCategory === cat.id ? "white" : cat.color,
                        border: `2px solid ${currentCategory === cat.id ? cat.color : "#e2e8f0"}` }}>{cat.label}</button>
                  ))}
                </div>
                {currentCategory === "prescription" && (
                  <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <input value={captureMeta.doctor} onChange={e => setCaptureMeta(p => ({ ...p, doctor: e.target.value }))} placeholder="Doctor name" style={{ padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: 6, fontSize: 11 }} />
                    <input value={captureMeta.hospital} onChange={e => setCaptureMeta(p => ({ ...p, hospital: e.target.value }))} placeholder="Hospital" style={{ padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: 6, fontSize: 11 }} />
                    <input value={captureMeta.specialty} onChange={e => setCaptureMeta(p => ({ ...p, specialty: e.target.value }))} placeholder="Specialty" style={{ padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: 6, fontSize: 11 }} />
                    <input type="date" value={captureMeta.date} onChange={e => setCaptureMeta(p => ({ ...p, date: e.target.value }))} style={{ padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: 6, fontSize: 11 }} />
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button onClick={() => { setCaptureStep("camera"); setCurrentCapture(null); setCurrentCategory(null); }}
                    style={{ flex: 1, padding: "10px", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>✕ Cancel</button>
                  <button onClick={extractDocument} disabled={!currentCategory}
                    style={{ flex: 2, padding: "10px", background: currentCategory ? "#2563eb" : "#cbd5e1", color: "white", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: currentCategory ? "pointer" : "default" }}>🧠 Extract with AI</button>
                </div>
              </div>
            )}

            {captureStep === "extracting" && (
              <div style={{ textAlign: "center", padding: 40 }}>
                <div style={{ fontSize: 40, marginBottom: 12, animation: "pulse 1.5s infinite" }}>🧠</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#2563eb" }}>AI is reading the document...</div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>Extracting diagnoses, medications, lab values</div>
              </div>
            )}

            {captureStep === "review" && (
              <div>
                {nameMismatch && (
                  <div style={{ padding: 10, background: "#fef3c7", border: "2px solid #f59e0b", borderRadius: 8, marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: "#92400e" }}>⚠️ Name Mismatch</div>
                    <div style={{ fontSize: 11, color: "#78350f", marginTop: 4, lineHeight: 1.5 }}>
                      Report says: <b>{nameMismatch.reportName}</b><br />
                      Selected patient: <b>{nameMismatch.selectedName}</b>
                    </div>
                    <div style={{ fontSize: 10, color: "#92400e", marginTop: 4 }}>Please verify this is the correct patient before saving.</div>
                  </div>
                )}
                {captureError && (
                  <div style={{ padding: 10, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626" }}>⚠️ {captureError}</div>
                  </div>
                )}
                {currentCapture?.preview && (
                  <div style={{ marginBottom: 8, borderRadius: 6, overflow: "hidden", border: "1px solid #e2e8f0", maxHeight: 100 }}>
                    <img src={currentCapture.preview} alt="" style={{ width: "100%", objectFit: "cover", maxHeight: 100 }} />
                  </div>
                )}
                {extractedData && (
                  <div>
                    {extractedData.doctor_name && (
                      <div style={{ padding: 8, background: "#eff6ff", borderRadius: 8, marginBottom: 8, border: "1px solid #bfdbfe" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#1e40af" }}>{extractedData.doctor_name} {extractedData.specialty ? `(${extractedData.specialty})` : ""}</div>
                        {extractedData.hospital_name && <div style={{ fontSize: 10, color: "#64748b" }}>{extractedData.hospital_name}</div>}
                      </div>
                    )}
                    {extractedData.diagnoses?.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 4 }}>DIAGNOSES</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                          {extractedData.diagnoses.map((d, i) => <span key={i} style={{ background: "#dbeafe", borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 600, color: "#1e40af" }}>{typeof d === "string" ? d : d.label || d.id || ""}</span>)}
                        </div>
                      </div>
                    )}
                    {extractedData.medications?.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 4 }}>MEDICATIONS ({extractedData.medications.length})</div>
                        {extractedData.medications.map((m, i) => (
                          <div key={i} style={{ padding: "4px 8px", background: "white", borderRadius: 4, marginBottom: 2, border: "1px solid #f1f5f9", fontSize: 11 }}>
                            <span style={{ fontWeight: 700 }}>{m.name}</span>
                            <span style={{ color: "#64748b", marginLeft: 4 }}>{m.dose} {m.frequency} {m.timing}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {extractedData.labs?.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 4 }}>LAB VALUES ({extractedData.labs.length})</div>
                        <div style={{ background: "white", borderRadius: 6, border: "1px solid #e2e8f0", overflow: "hidden" }}>
                          {extractedData.labs.map((l, i) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 8px", borderBottom: "1px solid #f1f5f9", fontSize: 11 }}>
                              <span style={{ fontWeight: 600 }}>{l.test_name}</span>
                              <span>
                                <span style={{ fontWeight: 700, color: l.flag === "HIGH" ? "#dc2626" : l.flag === "LOW" ? "#f59e0b" : "#059669" }}>{l.result}</span>
                                <span style={{ color: "#94a3b8", marginLeft: 4 }}>{l.unit}</span>
                              </span>
                            </div>
                          ))}
                        </div>
                        {extractedData.summary && <div style={{ fontSize: 10, color: "#475569", marginTop: 4, padding: "4px 8px", background: "#f8fafc", borderRadius: 4 }}>💡 {extractedData.summary}</div>}
                      </div>
                    )}
                    {extractedData.findings && (
                      <div style={{ padding: 8, background: "#f8fafc", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: 11, marginBottom: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 2 }}>FINDINGS</div>
                        {extractedData.findings}
                      </div>
                    )}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button onClick={() => { setCaptureStep("camera"); setCurrentCapture(null); setCurrentCategory(null); setExtractedData(null); setCaptureError(null); setNameMismatch(null); }}
                    style={{ flex: 1, padding: "10px", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>✕ Discard</button>
                  <button onClick={() => { setCaptureStep("categorize"); setExtractedData(null); setCaptureError(null); setNameMismatch(null); }}
                    style={{ flex: 1, padding: "10px", background: "#f59e0b", color: "white", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>🔄 Retry</button>
                  <button onClick={saveCapture} disabled={loading}
                    style={{ flex: 2, padding: "10px", background: loading ? "#94a3b8" : "#059669", color: "white", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: loading ? "default" : "pointer" }}>
                    {loading ? (saveStatus || "Saving...") : "✅ Save"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* PATIENT */}
      {screen === "patient" && selectedPatient && (
        <div>
          <div style={{ background: "linear-gradient(135deg, #1e293b, #334155)", color: "white", padding: "10px 16px", position: "sticky", top: 0, zIndex: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={() => { setScreen("home"); setSelectedPatient(null); setPatientData(null); setCaptureCount(0); }}
                style={{ background: "none", border: "none", color: "white", fontSize: 18, cursor: "pointer" }}>←</button>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{selectedPatient.name}</div>
                <div style={{ fontSize: 10, opacity: 0.7 }}>{selectedPatient.age}Y/{selectedPatient.sex?.[0]} • {selectedPatient.file_no}</div>
              </div>
              <button onClick={() => { setScreen("capture"); setCaptureStep("camera"); }}
                style={{ background: "#2563eb", border: "none", color: "white", padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>📸 Capture</button>
            </div>
            <div style={{ display: "flex", marginTop: 8, gap: 2 }}>
              {[["records", "📎 Docs"], ["rx", "💊 Meds"], ["labs", "🔬 Labs"], ["visits", "📜 Visits"]].map(([id, label]) => (
                <button key={id} onClick={() => setPatientTab(id)}
                  style={{ flex: 1, padding: "6px", border: "none", borderRadius: "6px 6px 0 0", fontSize: 10, fontWeight: 700, cursor: "pointer",
                    background: patientTab === id ? "white" : "rgba(255,255,255,.1)",
                    color: patientTab === id ? "#1e293b" : "rgba(255,255,255,.6)" }}>{label}</button>
              ))}
            </div>
          </div>

          {loading && <div style={{ textAlign: "center", padding: 30 }}><div style={{ fontSize: 24, animation: "pulse 1s infinite" }}>⏳</div></div>}

          {!loading && patientData && (
            <div style={{ padding: 12 }}>
              {patientTab === "records" && (
                <div>
                  {(patientData.documents || []).length === 0 ? (
                    <div style={{ textAlign: "center", padding: 30, color: "#94a3b8" }}>
                      <div style={{ fontSize: 28 }}>📎</div>
                      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6 }}>No documents yet</div>
                      <button onClick={() => { setScreen("capture"); setCaptureStep("camera"); }}
                        style={{ marginTop: 8, padding: "8px 16px", background: "#2563eb", color: "white", border: "none", borderRadius: 6, fontWeight: 700, cursor: "pointer" }}>📸 Capture</button>
                    </div>
                  ) : (patientData.documents || []).map(doc => {
                    const cat = docCategories.find(c => c.id === doc.doc_type) || { label: "📄", color: "#64748b" };
                    const ext = doc.extracted_data ? (typeof doc.extracted_data === "string" ? (() => { try { return JSON.parse(doc.extracted_data); } catch(e) { return null; } })() : doc.extracted_data) : null;
                    return (
                      <div key={doc.id} style={{ padding: "8px 10px", background: "white", borderRadius: 8, marginBottom: 6, border: "1px solid #e2e8f0" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 32, height: 32, borderRadius: 6, background: cat.color + "15", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>{cat.label?.split(" ")[0]}</div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 11, fontWeight: 700 }}>{doc.title || doc.doc_type}</div>
                            <div style={{ fontSize: 9, color: "#64748b" }}>{doc.source} • {fDate(doc.doc_date)}</div>
                            {ext && <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                              {ext.medications?.length > 0 && <span style={{ fontSize: 8, background: "#dbeafe", color: "#2563eb", padding: "1px 4px", borderRadius: 3, fontWeight: 600 }}>💊{ext.medications.length}</span>}
                              {ext.labs?.length > 0 && <span style={{ fontSize: 8, background: "#dcfce7", color: "#059669", padding: "1px 4px", borderRadius: 3, fontWeight: 600 }}>🔬{ext.labs.length}</span>}
                              {ext.diagnoses?.length > 0 && <span style={{ fontSize: 8, background: "#fef3c7", color: "#92400e", padding: "1px 4px", borderRadius: 3, fontWeight: 600 }}>🏥{ext.diagnoses.length}</span>}
                            </div>}
                          </div>
                          {doc.storage_path && <button onClick={async () => { try { const r = await fetch(`${API_URL}/api/documents/${doc.id}/file-url`); if(r.ok){const d=await r.json();window.open(d.url,"_blank");} } catch(e){} }}
                            style={{ fontSize: 9, background: "#2563eb", color: "white", border: "none", padding: "4px 8px", borderRadius: 4, cursor: "pointer", fontWeight: 600, flexShrink: 0 }}>View</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {patientTab === "rx" && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 8 }}>💊 Active Medications</div>
                  {(patientData.medications || []).filter(m => m.is_active).length === 0
                    ? <div style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>No active medications</div>
                    : <div style={{ background: "white", borderRadius: 8, border: "1px solid #e2e8f0", overflow: "hidden" }}>
                        {(patientData.medications || []).filter(m => m.is_active).map((m, i) => {
                          const con = (patientData.consultations || []).find(c => c.id === m.consultation_id) || {};
                          return (
                            <div key={i} style={{ padding: "6px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 11 }}>
                              <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <span style={{ fontWeight: 700 }}>{m.name}</span>
                                <span style={{ fontSize: 9, color: "#7c3aed" }}>{con.con_name || ""}</span>
                              </div>
                              <div style={{ fontSize: 10, color: "#64748b" }}>{m.dose} {m.frequency} {m.timing}</div>
                            </div>
                          );
                        })}
                      </div>}
                </div>
              )}

              {patientTab === "labs" && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 8 }}>🔬 Lab Results</div>
                  {(patientData.lab_results || []).length === 0
                    ? <div style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>No lab results</div>
                    : <div style={{ background: "white", borderRadius: 8, border: "1px solid #e2e8f0", overflow: "hidden" }}>
                        {(patientData.lab_results || []).slice(0, 40).map((l, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 11 }}>
                            <div>
                              <span style={{ fontWeight: 600 }}>{l.test_name}</span>
                              <span style={{ fontSize: 9, color: "#94a3b8", marginLeft: 4 }}>{fDate(l.test_date)}</span>
                            </div>
                            <span>
                              <span style={{ fontWeight: 700, color: l.flag === "HIGH" ? "#dc2626" : l.flag === "LOW" ? "#f59e0b" : "#059669" }}>{l.result}</span>
                              <span style={{ color: "#94a3b8", marginLeft: 3 }}>{l.unit}</span>
                            </span>
                          </div>
                        ))}
                      </div>}
                </div>
              )}

              {patientTab === "visits" && (
                <div>
                  {(patientData.consultations || []).length === 0
                    ? <div style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>No visits</div>
                    : (patientData.consultations || []).map((con, i) => (
                        <div key={i} style={{ padding: "8px 10px", background: "white", borderRadius: 8, marginBottom: 6, border: "1px solid #e2e8f0", borderLeft: `3px solid ${con.status === "completed" ? "#059669" : con.status === "historical" ? "#7c3aed" : "#f59e0b"}` }}>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 700 }}>{con.con_name || con.mo_name || "—"}</div>
                              <div style={{ fontSize: 10, color: "#64748b" }}>{fDate(con.visit_date)} • {con.visit_type || "OPD"}</div>
                            </div>
                            <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, fontWeight: 700,
                              background: con.status === "completed" ? "#dcfce7" : con.status === "historical" ? "#f3e8ff" : "#fef3c7",
                              color: con.status === "completed" ? "#059669" : con.status === "historical" ? "#7c3aed" : "#f59e0b" }}>{con.status}</span>
                          </div>
                        </div>
                      ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <NavBar />
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
    </div>
  );
}
