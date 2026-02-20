import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()
f=open(path+'.bak8','w'); f.write(c); f.close()
print("Backup: App.jsx.bak8")

# ═══ 1. Add state for rx file upload ═══
old_state = 'const [rxText, setRxText] = useState("");'
new_state = '''const [rxText, setRxText] = useState("");
  const [rxFile, setRxFile] = useState(null);
  const [rxFileExtracting, setRxFileExtracting] = useState(false);'''
if 'rxFile' not in c:
    c = c.replace(old_state, new_state, 1)
    print("1. State: OK")
else:
    print("1. State: EXISTS")

# ═══ 2. Add file upload handler + extraction function ═══
insert_before = '  // Handle report file upload'
idx = c.find(insert_before)
if idx > 0 and 'handleRxFile' not in c:
    rx_upload_func = r'''  // Handle prescription file upload (PDF/image)
  const handleRxFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      const mediaType = file.type || "image/jpeg";
      setRxFile({ fileName: file.name, base64, mediaType });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const extractRxFromFile = async () => {
    if (!rxFile) return;
    setRxFileExtracting(true);
    try {
      const block = rxFile.mediaType === "application/pdf"
        ? { type:"document", source:{type:"base64",media_type:"application/pdf",data:rxFile.base64} }
        : { type:"image", source:{type:"base64",media_type:rxFile.mediaType,data:rxFile.base64} };

      const prompt = `You are a clinical data extraction AI. Extract ALL information from this prescription image/PDF.

Return ONLY valid JSON with this structure:
{
  "visit_date": "YYYY-MM-DD",
  "doctor_name": "Dr. Name",
  "specialty": "Endocrinology",
  "hospital_name": "Hospital name if visible",
  "vitals": { "bp_sys": 130, "bp_dia": 80, "weight": 65, "height": 155, "bmi": 27, "pulse": null },
  "diagnoses": [{ "id": "dm2", "label": "Type 2 DM (Since 2005)", "status": "Uncontrolled" }],
  "medications": [{ "name": "TAB METFORMIN 500", "dose": "500mg", "frequency": "BD", "timing": "After meals" }],
  "labs": [{ "test_name": "HbA1c", "result": "8.5", "unit": "%", "flag": "H", "ref_range": "<7" }],
  "chief_complaints": ["symptom1"],
  "history": {
    "family": "Father DM, Mother HTN",
    "past_medical_surgical": "NIL",
    "personal": "Non-smoker"
  },
  "follow_up": { "duration": "6 weeks", "date": "YYYY-MM-DD or null", "instructions": "special instructions", "tests_to_bring": ["HbA1c"] },
  "notes": "Any additional observations or advice mentioned"
}

RULES:
- Extract EVERY piece of information visible: diagnoses, medications with full dose/frequency/timing, all lab values, vitals, history
- Convert dates to YYYY-MM-DD format
- Diagnosis IDs: dm2,dm1,htn,cad,ckd,hypo,obesity,dyslipidemia,masld,nephropathy,neuropathy,hashimotos
- flag: "H" for high, "L" for low, "N" for normal
- Include follow-up date if mentioned
- Include any lifestyle/diet advice in notes
- If handwritten and hard to read, do your best and note uncertainty in notes`;

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 8000, messages: [{ role: "user", content: [block, { type: "text", text: prompt }] }] })
      });
      const d = await r.json();
      if (d.error) { alert("API error: " + d.error.message); setRxFileExtracting(false); return; }
      const t = (d.content || []).map(c => c.text || "").join("");
      const clean = t.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const data = JSON.parse(clean);

      // Fill history form with extracted data
      setHistoryForm(prev => ({
        ...prev,
        visit_date: data.visit_date || prev.visit_date,
        doctor_name: data.doctor_name || prev.doctor_name,
        specialty: data.specialty || prev.specialty,
        vitals: { ...prev.vitals, ...(data.vitals || {}) },
        diagnoses: (data.diagnoses?.length > 0) ? data.diagnoses : prev.diagnoses,
        medications: (data.medications?.length > 0) ? data.medications : prev.medications,
        labs: (data.labs?.length > 0) ? data.labs : prev.labs,
        notes: [prev.notes, data.notes].filter(Boolean).join("\n"),
      }));
      // Also set the text version for reference
      if (data.notes) setRxText(prev => prev ? prev + "\n" + data.notes : data.notes);
      setRxExtracted(true);
      setRxFile(prev => ({ ...prev, extracted: data }));

      // Save document to DB + storage if patient exists
      if (dbPatientId && API_URL) {
        try {
          const docResp = await fetch(`${API_URL}/api/patients/${dbPatientId}/documents`, {
            method: "POST", headers: authHeaders(),
            body: JSON.stringify({
              doc_type: "prescription",
              title: `Prescription${data.doctor_name ? " — " + data.doctor_name : ""}${data.visit_date ? " — " + data.visit_date : ""}`,
              file_name: rxFile.fileName,
              doc_date: data.visit_date || new Date().toISOString().split("T")[0],
              source: data.hospital_name || "external",
              notes: data.notes || "",
              extracted_data: data
            })
          });
          const docResult = await docResp.json();
          if (docResult.id) {
            // Upload file to storage
            await fetch(`${API_URL}/api/documents/${docResult.id}/upload-file`, {
              method: "POST", headers: authHeaders(),
              body: JSON.stringify({ base64: rxFile.base64, mediaType: rxFile.mediaType, fileName: rxFile.fileName })
            });
            console.log("Prescription saved to docs:", docResult.id);
          }
        } catch (e) { console.log("Doc save error:", e.message); }
      }
    } catch (e) {
      console.error("Rx file extract error:", e);
      alert("Could not extract from file: " + e.message);
    }
    setRxFileExtracting(false);
  };

'''
    c = c[:idx] + rx_upload_func + c[idx:]
    print("2. Upload functions: OK")
else:
    print("2. Upload functions:", "EXISTS" if 'handleRxFile' in c else "FAILED")

# ═══ 3. Add file upload UI to the rx mode ═══
old_rx_ui = '''                  <div style={{ fontSize:9, color:"#94a3b8", marginBottom:6 }}>Paste prescription text, type from the slip, or use voice recording. Claude will auto-extract diagnoses, medications, vitals.</div>'''

new_rx_ui = '''                  <div style={{ fontSize:9, color:"#94a3b8", marginBottom:6 }}>Paste text, dictate, or upload a photo/PDF of the prescription.</div>
                  
                  {/* File upload area */}
                  <div style={{ display:"flex", gap:6, marginBottom:8 }}>
                    <label style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:4, padding:"8px", background:rxFile?"#f0fdf4":"#f8fafc", border:`2px dashed ${rxFile?"#22c55e":"#cbd5e1"}`, borderRadius:8, cursor:"pointer", fontSize:11, fontWeight:600, color:rxFile?"#059669":"#64748b" }}>
                      {rxFile ? ("\u2705 " + rxFile.fileName) : "\U0001f4f7 Upload Prescription (Photo/PDF)"}
                      <input type="file" accept="image/*,.pdf,.heic,.heif" style={{ display:"none" }} onChange={handleRxFile} />
                    </label>
                    {rxFile && !rxFile.extracted && (
                      <button onClick={extractRxFromFile} disabled={rxFileExtracting}
                        style={{ padding:"8px 16px", background:rxFileExtracting?"#94a3b8":"#059669", color:"white", border:"none", borderRadius:8, fontWeight:700, fontSize:11, cursor:rxFileExtracting?"wait":"pointer", whiteSpace:"nowrap" }}>
                        {rxFileExtracting ? "\U0001f52c Extracting..." : "\U0001f52c Extract"}
                      </button>
                    )}
                    {rxFile && (
                      <button onClick={()=>setRxFile(null)} style={{ padding:"8px", background:"none", border:"1px solid #fecaca", borderRadius:8, color:"#dc2626", cursor:"pointer", fontSize:11 }}>\u2715</button>
                    )}
                  </div>
                  {rxFile?.extracted && (
                    <div style={{ marginBottom:8, padding:6, background:"#f0fdf4", borderRadius:6, border:"1px solid #bbf7d0", fontSize:10 }}>
                      <span style={{ fontWeight:700, color:"#059669" }}>{"\u2705"} Extracted from file: </span>
                      {rxFile.extracted.diagnoses?.length||0} diagnoses, {rxFile.extracted.medications?.length||0} medications, {rxFile.extracted.labs?.length||0} lab values
                      {rxFile.extracted.doctor_name && <span> | {rxFile.extracted.doctor_name}</span>}
                      {rxFile.extracted.visit_date && <span> | {rxFile.extracted.visit_date}</span>}
                      <span style={{ color:"#64748b" }}> | Saved to Documents</span>
                    </div>
                  )}
                  
                  <div style={{ fontSize:9, fontWeight:600, color:"#64748b", marginBottom:4 }}>— OR type/paste/dictate below —</div>'''

if old_rx_ui in c:
    c = c.replace(old_rx_ui, new_rx_ui, 1)
    print("3. Upload UI: OK")
else:
    print("3. Upload UI: FAILED")

f=open(path,'w'); f.write(c); f.close()
print("\nDone. Run: npm run build")
