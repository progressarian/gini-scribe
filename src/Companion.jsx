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

  // Capture state
  const [captureStep, setCaptureStep] = useState("camera");
  const [currentCapture, setCurrentCapture] = useState(null);
  const [currentCategory, setCurrentCategory] = useState(null);
  const [captureMeta, setCaptureMeta] = useState({ doctor: "", hospital: "", specialty: "", date: "" });
  const [extractedData, setExtractedData] = useState(null);
  const [captureCount, setCaptureCount] = useState(0);
  const [extracting, setExtracting] = useState(false);
  const [captureError, setCaptureError] = useState(null);

  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  // Load today's patients
  useEffect(() => {
    loadPatients();
  }, []);

  const loadPatients = async () => {
    try {
      const r = await fetch(`${API_URL}/api/patients?limit=50`);
      if (r.ok) {
        const data = await r.json();
        setPatients(data);
      }
    } catch (e) { console.error("Load patients:", e); }
  };

  const loadPatientData = async (patientId) => {
    setLoading(true);
    try {
      const r = await fetch(`${API_URL}/api/patients/${patientId}`);
      if (r.ok) {
        const data = await r.json();
        setPatientData(data);
      }
    } catch (e) { console.error("Load patient:", e); }
    setLoading(false);
  };

  const selectPatient = (p) => {
    setSelectedPatient(p);
    setScreen("patient");
    setPatientTab("records");
    loadPatientData(p.id);
  };

  // Camera / File capture
  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCurrentCapture({
        file,
        preview: reader.result,
        fileName: file.name,
        mediaType: file.type,
        timestamp: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
      });
      setCaptureStep("categorize");
    };
    reader.readAsDataURL(file);
  };

  // AI Extraction
  const extractDocument = async () => {
    if (!currentCapture?.preview || !currentCategory) return;
    setExtracting(true);
    setCaptureError(null);
    setCaptureStep("extracting");

    try {
      const isRx = currentCategory === "prescription";
      const isLab = ["blood_test", "thyroid", "lipid", "kidney", "hba1c", "urine"].includes(currentCategory);

      const prompt = isRx
        ? `Extract from this prescription image. Return JSON:
{"doctor_name":"","specialty":"","hospital_name":"","visit_date":"YYYY-MM-DD","diagnoses":[{"id":"dm2","label":"Type 2 DM","status":"Active"}],"medications":[{"name":"BRAND","composition":"Generic","dose":"dose","frequency":"OD","timing":"Morning"}],"labs":[{"test_name":"HbA1c","result":"7.2","unit":"%","flag":"HIGH","ref_range":"<6.5"}],"vitals":{"bp_sys":null,"bp_dia":null,"weight":null},"follow_up":"date or duration","advice":"key advice"}`
        : isLab
        ? `Extract lab values from this report image. Return JSON:
{"labs":[{"test_name":"","result":"","unit":"","flag":"HIGH/LOW/NORMAL","ref_range":""}],"report_date":"YYYY-MM-DD","lab_name":"","patient_name":""}`
        : `Extract key findings from this medical document. Return JSON:
{"doc_type":"${currentCategory}","findings":"","date":"YYYY-MM-DD","doctor":"","notes":""}`;

      const imgData = currentCapture.preview.split(",")[1];
      const mediaType = currentCapture.mediaType?.startsWith("image/") ? currentCapture.mediaType : "image/jpeg";

      const r = await retryFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: imgData } },
              { type: "text", text: prompt + "\n\nReturn ONLY valid JSON. No markdown, no backticks." }
            ]
          }]
        })
      });

      if (!r.ok) throw new Error(`API ${r.status}`);
      const data = await r.json();
      const text = data.content?.[0]?.text || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setExtractedData(parsed);
      // Auto-fill metadata
      if (parsed.doctor_name) setCaptureMeta(prev => ({ ...prev, doctor: parsed.doctor_name, hospital: parsed.hospital_name || "", specialty: parsed.specialty || "", date: parsed.visit_date || "" }));
      if (parsed.report_date) setCaptureMeta(prev => ({ ...prev, date: parsed.report_date }));
      setCaptureStep("review");
    } catch (e) {
      console.error("Extraction:", e);
      setCaptureError(e.message);
      setCaptureStep("review");
    }
    setExtracting(false);
  };

  // Save to API
  const saveCapture = async () => {
    if (!selectedPatient?.id) return;
    setLoading(true);
    try {
      const isRx = currentCategory === "prescription";
      const isLab = ["blood_test", "thyroid", "lipid", "kidney", "hba1c", "urine"].includes(currentCategory);

      if (isRx && extractedData) {
        // Save as historical visit
        const r = await fetch(`${API_URL}/api/patients/${selectedPatient.id}/history`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
        if (!r.ok) throw new Error("Save failed: " + r.status);
      } else if (isLab && extractedData?.labs) {
        // Save lab results
        for (const lab of extractedData.labs) {
          await fetch(`${API_URL}/api/patients/${selectedPatient.id}/labs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              test_date: captureMeta.date || new Date().toISOString().split("T")[0],
              test_name: lab.test_name, result: lab.result, unit: lab.unit, flag: lab.flag, ref_range: lab.ref_range, source: "companion"
            })
          });
        }
      }

      // Also save as document with image
      const docR = await fetch(`${API_URL}/api/patients/${selectedPatient.id}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doc_type: currentCategory,
          title: isRx ? `${captureMeta.doctor || "External"} — ${captureMeta.specialty || currentCategory}` : `${docCategories.find(c => c.id === currentCategory)?.label || currentCategory}`,
          doc_date: captureMeta.date || new Date().toISOString().split("T")[0],
          source: captureMeta.hospital || "Companion Upload",
          notes: captureMeta.doctor ? `Doctor: ${captureMeta.doctor}` : "",
          extracted_data: JSON.stringify(extractedData || {}),
        })
      });

      if (docR.ok) {
        const docData = await docR.json();
        // Upload the actual image file if we have it
        if (currentCapture.file && docData.id) {
          const formData = new FormData();
          formData.append("file", currentCapture.file);
          await fetch(`${API_URL}/api/documents/${docData.id}/upload-file`, { method: "POST", body: formData });
        }
      }

      setCaptureCount(prev => prev + 1);
      setCurrentCapture(null);
      setCurrentCategory(null);
      setExtractedData(null);
      setCaptureMeta({ doctor: "", hospital: "", specialty: "", date: "" });
      setCaptureStep("camera");
      setCaptureError(null);
      // Reload patient data
      loadPatientData(selectedPatient.id);
    } catch (e) {
      console.error("Save:", e);
      setCaptureError("Save failed: " + e.message);
    }
    setLoading(false);
  };

  // Filtered patients
  const filtered = patients.filter(p =>
    (p.name || "").toLowerCase().includes(searchText.toLowerCase()) ||
    (p.file_no || "").includes(searchText) ||
    (p.phone || "").includes(searchText)
  );

  const fDate = (d) => {
    try { const s = String(d || ""); const dt = s.length >= 10 ? new Date(s.slice(0, 10) + "T12:00:00") : new Date(s); return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); } catch (e) { return ""; }
  };

  // ═══ NAV BAR ═══
  const NavBar = () => (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: 480, margin: "0 auto", background: "white", borderTop: "1px solid #e2e8f0", display: "flex", zIndex: 20, boxShadow: "0 -2px 10px rgba(0,0,0,.08)" }}>
      {[
        ["home", "🏠", "Patients"],
        ["capture", "📸", "Capture"],
        ["patient", "👤", "Record"],
      ].map(([id, icon, label]) => (
        <button key={id} onClick={() => { if (id === "capture" && !selectedPatient) { alert("Select a patient first"); return; } setScreen(id); if (id === "capture") setCaptureStep("camera"); }}
          style={{ flex: 1, padding: "8px 4px", border: "none", cursor: "pointer", background: screen === id ? "#eff6ff" : "white", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          <span style={{ fontSize: 18 }}>{icon}</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: screen === id ? "#2563eb" : "#94a3b8" }}>{label}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif", background: "#f8fafc", minHeight: "100vh", paddingBottom: 60, position: "relative" }}>

      {/* ═══════════════════════════ */}
      {/* HOME — PATIENT LIST        */}
      {/* ═══════════════════════════ */}
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
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "white", borderRadius: 8, marginBottom: 6, border: "1px solid #e2e8f0", cursor: "pointer", transition: "all .15s" }}>
                  <div style={{ width: 36, height: 36, borderRadius: "50%", background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#2563eb" }}>
                    {(p.name || "?")[0]}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: "#64748b" }}>
                      {p.age}Y/{p.sex?.[0] || "?"} • {p.file_no || "—"} {p.phone ? `• ${p.phone}` : ""}
                    </div>
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

      {/* ═══════════════════════════ */}
      {/* CAPTURE — CAMERA + UPLOAD  */}
      {/* ═══════════════════════════ */}
      {screen === "capture" && selectedPatient && (
        <div>
          <div style={{ background: "#1e293b", color: "white", padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, position: "sticky", top: 0, zIndex: 10 }}>
            <button onClick={() => setScreen("patient")} style={{ background: "none", border: "none", color: "white", fontSize: 18, cursor: "pointer" }}>←</button>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{selectedPatient.name}</div>
              <div style={{ fontSize: 10, opacity: 0.7 }}>Capture Documents • {captureCount > 0 ? `${captureCount} saved` : ""}</div>
            </div>
          </div>

          <div style={{ padding: 12 }}>
            {/* Step 1: Camera / Upload */}
            {captureStep === "camera" && (
              <div>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <button onClick={() => cameraRef.current?.click()}
                    style={{ flex: 1, padding: "20px 10px", background: "linear-gradient(135deg, #2563eb, #3b82f6)", color: "white", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 800, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 28 }}>📷</span>
                    Take Photo
                  </button>
                  <button onClick={() => fileRef.current?.click()}
                    style={{ flex: 1, padding: "20px 10px", background: "linear-gradient(135deg, #059669, #10b981)", color: "white", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 800, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 28 }}>📁</span>
                    Upload File
                  </button>
                </div>
                <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={handleFileSelect} style={{ display: "none" }} />
                <input ref={fileRef} type="file" accept="image/*,.pdf" onChange={handleFileSelect} style={{ display: "none" }} />

                {captureCount > 0 && (
                  <div style={{ textAlign: "center", padding: 12, background: "#f0fdf4", borderRadius: 8, border: "1px solid #bbf7d0" }}>
                    <div style={{ fontSize: 24 }}>✅</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#059669" }}>{captureCount} document{captureCount > 1 ? "s" : ""} saved</div>
                    <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>Take another photo or go to patient records</div>
                  </div>
                )}
              </div>
            )}

            {/* Step 2: Categorize */}
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
                        background: currentCategory === cat.id ? cat.color : "white",
                        color: currentCategory === cat.id ? "white" : cat.color,
                        border: `2px solid ${currentCategory === cat.id ? cat.color : "#e2e8f0"}` }}>
                      {cat.label}
                    </button>
                  ))}
                </div>

                {/* Optional metadata */}
                {currentCategory === "prescription" && (
                  <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <input value={captureMeta.doctor} onChange={e => setCaptureMeta(p => ({ ...p, doctor: e.target.value }))} placeholder="Doctor name"
                      style={{ padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: 6, fontSize: 11 }} />
                    <input value={captureMeta.hospital} onChange={e => setCaptureMeta(p => ({ ...p, hospital: e.target.value }))} placeholder="Hospital"
                      style={{ padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: 6, fontSize: 11 }} />
                    <input value={captureMeta.specialty} onChange={e => setCaptureMeta(p => ({ ...p, specialty: e.target.value }))} placeholder="Specialty"
                      style={{ padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: 6, fontSize: 11 }} />
                    <input type="date" value={captureMeta.date} onChange={e => setCaptureMeta(p => ({ ...p, date: e.target.value }))}
                      style={{ padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: 6, fontSize: 11 }} />
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

            {/* Step 3: Extracting */}
            {captureStep === "extracting" && (
              <div style={{ textAlign: "center", padding: 40 }}>
                <div style={{ fontSize: 40, marginBottom: 12, animation: "pulse 1.5s infinite" }}>🧠</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#2563eb" }}>AI is reading the document...</div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>Extracting diagnoses, medications, lab values</div>
                <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
              </div>
            )}

            {/* Step 4: Review extracted data */}
            {captureStep === "review" && (
              <div>
                {captureError && (
                  <div style={{ padding: 10, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626" }}>⚠️ Extraction issue: {captureError}</div>
                    <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>You can still save the document without extraction, or retry.</div>
                  </div>
                )}

                {extractedData && (
                  <div>
                    {/* Doctor info */}
                    {extractedData.doctor_name && (
                      <div style={{ padding: 8, background: "#eff6ff", borderRadius: 8, marginBottom: 8, border: "1px solid #bfdbfe" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#1e40af" }}>{extractedData.doctor_name} {extractedData.specialty ? `(${extractedData.specialty})` : ""}</div>
                        {extractedData.hospital_name && <div style={{ fontSize: 10, color: "#64748b" }}>{extractedData.hospital_name}</div>}
                        {extractedData.visit_date && <div style={{ fontSize: 10, color: "#64748b" }}>{fDate(extractedData.visit_date)}</div>}
                      </div>
                    )}

                    {/* Diagnoses */}
                    {extractedData.diagnoses?.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 4 }}>DIAGNOSES</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                          {extractedData.diagnoses.map((d, i) => (
                            <span key={i} style={{ background: "#dbeafe", borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 600, color: "#1e40af" }}>
                              {d.label || d.id || d}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Medications */}
                    {extractedData.medications?.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 4 }}>MEDICATIONS ({extractedData.medications.length})</div>
                        {extractedData.medications.map((m, i) => (
                          <div key={i} style={{ padding: "4px 8px", background: "white", borderRadius: 4, marginBottom: 2, border: "1px solid #f1f5f9", fontSize: 11 }}>
                            <span style={{ fontWeight: 700 }}>{m.name}</span>
                            <span style={{ color: "#64748b", marginLeft: 4 }}>{m.dose} {m.frequency} {m.timing}</span>
                            {m.composition && <div style={{ fontSize: 9, color: "#94a3b8" }}>{m.composition}</div>}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Labs */}
                    {extractedData.labs?.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 4 }}>LAB VALUES ({extractedData.labs.length})</div>
                        <div style={{ background: "white", borderRadius: 6, border: "1px solid #e2e8f0", overflow: "hidden" }}>
                          {extractedData.labs.map((l, i) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 8px", borderBottom: "1px solid #f1f5f9", fontSize: 11 }}>
                              <span style={{ fontWeight: 600 }}>{l.test_name}</span>
                              <span>
                                <span style={{ fontWeight: 700, color: l.flag === "HIGH" ? "#dc2626" : l.flag === "LOW" ? "#f59e0b" : "#059669" }}>{l.result}</span>
                                <span style={{ color: "#94a3b8", marginLeft: 4 }}>{l.unit} {l.ref_range ? `(${l.ref_range})` : ""}</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Findings for imaging */}
                    {extractedData.findings && (
                      <div style={{ padding: 8, background: "#f8fafc", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: 11, marginBottom: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 2 }}>FINDINGS</div>
                        {extractedData.findings}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button onClick={() => { setCaptureStep("camera"); setCurrentCapture(null); setCurrentCategory(null); setExtractedData(null); setCaptureError(null); }}
                    style={{ flex: 1, padding: "10px", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>✕ Discard</button>
                  <button onClick={() => { setCaptureStep("categorize"); setExtractedData(null); setCaptureError(null); }}
                    style={{ flex: 1, padding: "10px", background: "#f59e0b", color: "white", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>🔄 Re-extract</button>
                  <button onClick={saveCapture} disabled={loading}
                    style={{ flex: 2, padding: "10px", background: "#059669", color: "white", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                    {loading ? "Saving..." : "✅ Confirm & Save"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════════════════════ */}
      {/* PATIENT — RECORDS + RX     */}
      {/* ═══════════════════════════ */}
      {screen === "patient" && selectedPatient && (
        <div>
          <div style={{ background: "linear-gradient(135deg, #1e293b, #334155)", color: "white", padding: "10px 16px", position: "sticky", top: 0, zIndex: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={() => { setScreen("home"); setSelectedPatient(null); setPatientData(null); }}
                style={{ background: "none", border: "none", color: "white", fontSize: 18, cursor: "pointer" }}>←</button>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{selectedPatient.name}</div>
                <div style={{ fontSize: 10, opacity: 0.7 }}>{selectedPatient.age}Y/{selectedPatient.sex?.[0]} • {selectedPatient.file_no}</div>
              </div>
              <button onClick={() => { setScreen("capture"); setCaptureStep("camera"); }}
                style={{ background: "#2563eb", border: "none", color: "white", padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>📸 Capture</button>
            </div>
            {/* Tabs */}
            <div style={{ display: "flex", marginTop: 8, gap: 2 }}>
              {[["records", "📎 Records"], ["rx", "💊 Rx"], ["visits", "📜 Visits"]].map(([id, label]) => (
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
              {/* RECORDS TAB */}
              {patientTab === "records" && (
                <div>
                  {(patientData.documents || []).length === 0 ? (
                    <div style={{ textAlign: "center", padding: 30, color: "#94a3b8" }}>
                      <div style={{ fontSize: 28 }}>📎</div>
                      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6 }}>No documents yet</div>
                      <button onClick={() => { setScreen("capture"); setCaptureStep("camera"); }}
                        style={{ marginTop: 8, padding: "8px 16px", background: "#2563eb", color: "white", border: "none", borderRadius: 6, fontWeight: 700, cursor: "pointer" }}>📸 Capture First Document</button>
                    </div>
                  ) : (
                    <div>
                      {(patientData.documents || []).map(doc => {
                        const cat = docCategories.find(c => c.id === doc.doc_type) || { label: doc.doc_type, color: "#64748b" };
                        return (
                          <div key={doc.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: "white", borderRadius: 8, marginBottom: 6, border: "1px solid #e2e8f0" }}>
                            <div style={{ width: 32, height: 32, borderRadius: 6, background: cat.color + "15", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>
                              {cat.label?.split(" ")[0] || "📄"}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 11, fontWeight: 700 }}>{doc.title || doc.doc_type}</div>
                              <div style={{ fontSize: 9, color: "#64748b" }}>{doc.source || ""} • {fDate(doc.doc_date)}</div>
                            </div>
                            {doc.storage_path && (
                              <button onClick={async () => {
                                try {
                                  const r = await fetch(`${API_URL}/api/documents/${doc.id}/file-url`);
                                  if (r.ok) { const d = await r.json(); window.open(d.url, "_blank"); }
                                } catch (e) { console.error(e); }
                              }}
                                style={{ fontSize: 9, background: "#2563eb", color: "white", border: "none", padding: "4px 8px", borderRadius: 4, cursor: "pointer", fontWeight: 600 }}>📄 View</button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* PRESCRIPTION TAB */}
              {patientTab === "rx" && (
                <div>
                  {/* Active medications */}
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#1e293b", marginBottom: 8 }}>💊 Active Medications</div>
                  {(patientData.medications || []).filter(m => m.is_active).length === 0 ? (
                    <div style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>No active medications</div>
                  ) : (
                    <div style={{ background: "white", borderRadius: 8, border: "1px solid #e2e8f0", overflow: "hidden" }}>
                      {(patientData.medications || []).filter(m => m.is_active).map((m, i) => {
                        const con = (patientData.consultations || []).find(c => c.id === m.consultation_id) || {};
                        return (
                          <div key={i} style={{ padding: "6px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 11 }}>
                            <div style={{ display: "flex", justifyContent: "space-between" }}>
                              <span style={{ fontWeight: 700 }}>{m.name}</span>
                              <span style={{ fontSize: 9, color: "#7c3aed" }}>{con.con_name || ""}</span>
                            </div>
                            <div style={{ fontSize: 10, color: "#64748b" }}>{m.dose || ""} {m.frequency || ""} {m.timing || ""}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Latest visit prescription */}
                  {patientData.consultations?.length > 0 && (() => {
                    const latest = patientData.consultations[0];
                    const conData = typeof latest.con_data === "string" ? (() => { try { return JSON.parse(latest.con_data); } catch (e) { return null; } })() : latest.con_data;
                    if (!conData) return null;
                    return (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color: "#1e293b", marginBottom: 6 }}>📋 Latest Visit — {latest.con_name || latest.mo_name || ""} ({fDate(latest.visit_date)})</div>
                        {conData.assessment_summary && (
                          <div style={{ padding: 8, background: "#eff6ff", borderRadius: 8, border: "1px solid #bfdbfe", fontSize: 11, lineHeight: 1.6, marginBottom: 8 }}>
                            {conData.assessment_summary}
                          </div>
                        )}
                        {conData.follow_up && (
                          <div style={{ padding: 8, background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0", marginBottom: 8 }}>
                            <div style={{ fontSize: 11, fontWeight: 700 }}>📅 Follow Up: {conData.follow_up.duration || ""}</div>
                            {conData.follow_up.date && <div style={{ fontSize: 11, color: "#2563eb", fontWeight: 600 }}>{fDate(conData.follow_up.date)}</div>}
                            {conData.follow_up.instructions && <div style={{ fontSize: 10, color: "#92400e" }}>⚠️ {conData.follow_up.instructions}</div>}
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => {
                            const text = `${selectedPatient.name} — ${latest.con_name || ""} (${fDate(latest.visit_date)})\n${conData.assessment_summary || ""}\nFollow Up: ${conData.follow_up?.duration || ""} ${conData.follow_up?.date ? fDate(conData.follow_up.date) : ""}`;
                            navigator.clipboard?.writeText(text);
                            alert("Copied to clipboard!");
                          }}
                            style={{ flex: 1, padding: "8px", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>📋 Copy</button>
                          <button onClick={() => {
                            const text = `${selectedPatient.name} — ${latest.con_name || ""} (${fDate(latest.visit_date)})\n${conData.assessment_summary || ""}\nMeds: ${(conData.medications_confirmed || []).map(m => m.name).join(", ")}\nFollow Up: ${conData.follow_up?.duration || ""} ${conData.follow_up?.date ? fDate(conData.follow_up.date) : ""}`;
                            const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
                            window.open(url, "_blank");
                          }}
                            style={{ flex: 1, padding: "8px", background: "#25D366", color: "white", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>📱 WhatsApp</button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* VISITS TAB */}
              {patientTab === "visits" && (
                <div>
                  {(patientData.consultations || []).length === 0 ? (
                    <div style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>No visits recorded</div>
                  ) : (
                    <div>
                      {(patientData.consultations || []).map((con, i) => (
                        <div key={i} style={{ padding: "8px 10px", background: "white", borderRadius: 8, marginBottom: 6, border: "1px solid #e2e8f0", borderLeft: `3px solid ${con.status === "completed" ? "#059669" : con.status === "historical" ? "#7c3aed" : "#f59e0b"}` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 700 }}>{con.con_name || con.mo_name || "—"}</div>
                              <div style={{ fontSize: 10, color: "#64748b" }}>{fDate(con.visit_date)} • {con.visit_type || "OPD"}</div>
                            </div>
                            <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, fontWeight: 700,
                              background: con.status === "completed" ? "#dcfce7" : con.status === "historical" ? "#f3e8ff" : "#fef3c7",
                              color: con.status === "completed" ? "#059669" : con.status === "historical" ? "#7c3aed" : "#f59e0b" }}>
                              {con.status || "—"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
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
