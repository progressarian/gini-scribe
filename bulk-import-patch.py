#!/usr/bin/env python3
"""
Bulk History Import patch for Gini Scribe App.jsx
Run: python3 bulk-import-patch.py
"""
import os, sys

path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
if not os.path.exists(path):
    print(f"❌ File not found: {path}")
    sys.exit(1)

with open(path, "r") as f:
    c = f.read()

# Backup
with open(path + ".bak", "w") as f:
    f.write(c)
print("📋 Backup saved as App.jsx.bak")

# ═══════════════════════════════════════════════
# 1. Add state variables
# ═══════════════════════════════════════════════
old = 'const [hxMode, setHxMode] = useState("rx"); // "rx" | "report" | "manual"'
new = '''const [hxMode, setHxMode] = useState("rx"); // "rx" | "report" | "manual" | "bulk"
  const [bulkText, setBulkText] = useState("");
  const [bulkParsing, setBulkParsing] = useState(false);
  const [bulkVisits, setBulkVisits] = useState([]);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkProgress, setBulkProgress] = useState("");
  const [bulkSaved, setBulkSaved] = useState(0);'''
c = c.replace(old, new, 1)
print("1. State:", "✅" if "bulkText" in c else "❌")

# ═══════════════════════════════════════════════
# 2. Add bulk processing functions
# ═══════════════════════════════════════════════
old = '''const removeReport = (index) => {
    setReports(prev => prev.filter((_,i) => i !== index));
  };'''

new = r'''const removeReport = (index) => {
    setReports(prev => prev.filter((_,i) => i !== index));
  };

  // ═══ BULK HISTORY IMPORT ═══
  const processBulkImport = async () => {
    if (!bulkText.trim() || !API_URL) return;
    setBulkParsing(true); setBulkVisits([]); setBulkProgress("⏳ Splitting visits...");
    try {
      const prompt = `You are a clinical data extraction AI. The user is pasting ALL visit history for a patient from another EMR system.

TASK: Split this into INDIVIDUAL VISITS. Each visit has a date and its own data.

Output ONLY valid JSON array, no backticks:
[
  {
    "visit_date": "YYYY-MM-DD",
    "doctor_name": "Dr. Name",
    "visit_type": "OPD",
    "vitals": { "bp_sys": null, "bp_dia": null, "weight": null, "height": null, "bmi": null, "pulse": null },
    "diagnoses": [{"id": "dm2", "label": "Type 2 DM", "status": "Controlled"}],
    "medications": [{"name": "BRAND NAME", "dose": "500mg", "frequency": "BD", "timing": "After meals"}],
    "labs": [{"test_name": "HbA1c", "result": "5.3", "unit": "%", "flag": "N", "ref_range": "<6.5"}],
    "chief_complaints": ["symptom1"],
    "notes": "Brief summary of this visit"
  }
]

RULES:
- Split by FOLLOW UP dates. Each date = separate visit object
- Extract ALL lab values for each visit date with proper units and flags (H/L/N)
- Extract vitals: height (cm), weight (kg), BMI, BP (split sys/dia), waist circumference
- Extract medications at each visit (they may change between visits)
- Diagnosis IDs: dm2,dm1,htn,cad,ckd,hypo,obesity,dyslipidemia,dfu,masld,nephropathy,osas,hashimotos
- Sort visits by date ASCENDING (oldest first)
- If a visit only has labs and no treatment changes, still create a visit entry
- flag: "H" if above range, "L" if below, "N" if normal
- Convert dates like "16/9/25" to "2025-09-16", "2nd December 2023" to "2023-12-02"
- Include the LATEST/TODAY visit as well
- ALWAYS include the full diagnosis list for EVERY visit (not just the first one)

TEXT TO PARSE:
` + "${bulkText.trim()}";

      const resp = await fetch(API_URL + "/api/ai", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }], model: "haiku" })
      });
      const result = await resp.json();
      const text = (result.content?.[0]?.text || result.text || "").trim();
      const jsonStr = text.replace(/^```json\n?|```$/g, "").trim();
      const visits = JSON.parse(jsonStr);

      if (!Array.isArray(visits) || visits.length === 0) {
        setBulkProgress("❌ Could not parse visits. Try reformatting.");
        setBulkParsing(false);
        return;
      }

      visits.sort((a, b) => new Date(a.visit_date) - new Date(b.visit_date));
      setBulkVisits(visits);
      setBulkProgress(`✅ Found ${visits.length} visits. Review and click Save All.`);
    } catch (e) {
      setBulkProgress("❌ Parse error: " + e.message);
    }
    setBulkParsing(false);
  };

  const saveBulkVisits = async () => {
    if (!dbPatientId || !bulkVisits.length) return;
    setBulkSaving(true); setBulkSaved(0);
    let saved = 0;
    for (const visit of bulkVisits) {
      try {
        setBulkProgress(`Saving visit ${saved + 1}/${bulkVisits.length}: ${visit.visit_date}...`);
        const payload = {
          visit_date: visit.visit_date,
          visit_type: visit.visit_type || "OPD",
          doctor_name: visit.doctor_name || "",
          specialty: visit.specialty || "",
          vitals: visit.vitals || {},
          diagnoses: (visit.diagnoses || []).filter(d => d.label),
          medications: (visit.medications || []).filter(m => m.name),
          labs: (visit.labs || []).filter(l => l.test_name && l.result),
          notes: visit.notes || ""
        };
        const resp = await fetch(`${API_URL}/api/patients/${dbPatientId}/history`, {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify(payload)
        });
        const result = await resp.json();
        if (result.success) saved++;
      } catch (e) {
        console.log("Bulk save error for", visit.visit_date, e.message);
      }
      setBulkSaved(saved);
    }
    setBulkProgress(`✅ Saved ${saved}/${bulkVisits.length} visits!`);
    setBulkSaving(false);
    if (dbPatientId) {
      try {
        const pd = await fetch(`${API_URL}/api/patients/${dbPatientId}/full`, { headers: authHeaders() }).then(r=>r.json());
        setPatientFullData(pd);
      } catch(e) {}
    }
  };'''
c = c.replace(old, new, 1)
print("2. Functions:", "✅" if "processBulkImport" in c else "❌")

# ═══════════════════════════════════════════════
# 3. Add "bulk" tab button
# ═══════════════════════════════════════════════
old = '{[["rx","📝 Prescription"],["report","🧪 Reports"],["manual","📋 Manual"]].map(([id,label]) => ('
new = '{[["rx","📝 Prescription"],["report","🧪 Reports"],["manual","📋 Manual"],["bulk","📦 Bulk"]].map(([id,label]) => ('
c = c.replace(old, new, 1)
print("3. Tab:", "✅" if '"📦 Bulk"' in c else "❌")

# ═══════════════════════════════════════════════
# 4. Add bulk UI section before the review header
# ═══════════════════════════════════════════════
old_review = '              {hxMode==="manual" ? "📋 MANUAL ENTRY" : "📋 REVIEW EXTRACTED DATA"}'

bulk_ui = r'''
              {/* ═══ BULK IMPORT MODE ═══ */}
              {hxMode==="bulk" && (
                <div style={{ marginBottom:8 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"#1e40af", marginBottom:4 }}>📦 PASTE ALL VISIT HISTORY</div>
                  <div style={{ fontSize:9, color:"#64748b", marginBottom:4 }}>Paste the full EMR dump — all visits, all dates. AI will split into individual visits and save each one separately.</div>
                  <textarea value={bulkText} onChange={e=>setBulkText(e.target.value)}
                    placeholder={"Paste all visit history here...\n\nExample:\nFOLLOW UP ON 16/9/25\nHT 159.8 WT 81.7 BMI 32.3\nFBG 69 HBA1C 5.3 TG 268\nTREATMENT: TAB THYRONORM 75MCG...\n\nFOLLOW UP ON 16/5/25\nHT 159.5 WT 83.1 BF 34.75\nHBA1C 5.1 FBG 87.5 TG 287.2..."}
                    style={{ width:"100%", minHeight:150, padding:8, fontSize:11, borderRadius:6, border:"1px solid #d1d5db", fontFamily:"monospace", resize:"vertical" }} />
                  <div style={{ display:"flex", gap:6, marginTop:6, alignItems:"center", flexWrap:"wrap" }}>
                    <button onClick={processBulkImport} disabled={bulkParsing || !bulkText.trim()}
                      style={{ padding:"8px 16px", fontSize:11, fontWeight:700, background:bulkParsing?"#94a3b8":"#2563eb", color:"white", border:"none", borderRadius:6, cursor:bulkParsing?"wait":"pointer" }}>
                      {bulkParsing ? "⏳ Parsing..." : "🔍 Parse Visits"}
                    </button>
                    {bulkVisits.length > 0 && !bulkSaving && (
                      <button onClick={saveBulkVisits} disabled={!dbPatientId}
                        style={{ padding:"8px 16px", fontSize:11, fontWeight:700, background:"#16a34a", color:"white", border:"none", borderRadius:6, cursor:"pointer" }}>
                        {"💾 Save All " + bulkVisits.length + " Visits"}
                      </button>
                    )}
                    {bulkVisits.length > 0 && (
                      <button onClick={()=>{setBulkVisits([]);setBulkProgress("");setBulkText("");}}
                        style={{ padding:"8px 16px", fontSize:11, fontWeight:600, background:"#fef2f2", color:"#dc2626", border:"1px solid #fca5a5", borderRadius:6, cursor:"pointer" }}>
                        🗑️ Clear
                      </button>
                    )}
                    {bulkProgress && <span style={{ fontSize:10, color:bulkProgress.includes("❌")?"#dc2626":"#16a34a", fontWeight:600 }}>{bulkProgress}</span>}
                  </div>
                  {bulkSaving && (
                    <div style={{ marginTop:6, background:"#f0fdf4", borderRadius:6, overflow:"hidden", height:6 }}>
                      <div style={{ height:"100%", background:"#16a34a", width:str(0 if not True else 100)+"%" , transition:"width 0.3s" }} />
                    </div>
                  )}
                  {bulkVisits.length > 0 && (
                    <div style={{ marginTop:8, maxHeight:300, overflowY:"auto" }}>
                      {bulkVisits.map((v, i) => (
                        <div key={i} style={{ padding:8, marginBottom:4, background:i%2===0?"#f8fafc":"#f1f5f9", borderRadius:6, fontSize:10, border:"1px solid #e2e8f0" }}>
                          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                            <span style={{ fontWeight:800, color:"#1e40af" }}>{"📅 " + v.visit_date}</span>
                            <span style={{ color:"#64748b" }}>{v.doctor_name || ""}</span>
                          </div>
                          <div style={{ display:"flex", gap:8, flexWrap:"wrap", fontSize:9 }}>
                            {v.vitals?.weight && <span>{"⚖️ " + v.vitals.weight + "kg"}</span>}
                            {v.vitals?.bp_sys && <span>{"🩸 " + v.vitals.bp_sys + "/" + v.vitals.bp_dia}</span>}
                            {v.vitals?.bmi && <span>{"📊 BMI " + v.vitals.bmi}</span>}
                          </div>
                          {(v.labs||[]).length > 0 && (
                            <div style={{ marginTop:3, fontSize:9, color:"#475569" }}>
                              {"🧪 " + v.labs.map(l => l.test_name + ": " + l.result + (l.unit||"")).join(" | ")}
                            </div>
                          )}
                          {(v.medications||[]).length > 0 && (
                            <div style={{ marginTop:3, fontSize:9, color:"#475569" }}>
                              {"💊 " + v.medications.map(m => m.name).join(", ")}
                            </div>
                          )}
                          {(v.diagnoses||[]).length > 0 && (
                            <div style={{ marginTop:3, fontSize:9, color:"#475569" }}>
                              {"🏷️ " + v.diagnoses.map(d => d.label).join(", ")}
                            </div>
                          )}
                          {v.notes && <div style={{ marginTop:3, fontSize:9, color:"#64748b", fontStyle:"italic" }}>{v.notes}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
'''

# Replace the review header and add bulk UI before it
new_review = bulk_ui + '              {hxMode!=="bulk" && <div style={{ fontSize:11, fontWeight:800, color:"#1e40af", marginTop:8, marginBottom:6 }}>{hxMode==="manual" ? "📋 MANUAL ENTRY" : "📋 REVIEW EXTRACTED DATA"}</div>}'

c = c.replace(old_review, new_review, 1)
print("4. Bulk UI:", "✅" if "PASTE ALL VISIT HISTORY" in c else "❌")

# ═══════════════════════════════════════════════
# Fix: the progress bar JSX needs to be proper React, not Python
# ═══════════════════════════════════════════════
c = c.replace(
    'width:str(0 if not True else 100)+"%"',
    'width:`${(bulkSaved/Math.max(bulkVisits.length,1))*100}%`'
)
print("5. Progress bar fix:", "✅")

with open(path, "w") as f:
    f.write(c)

print(f"\n✅ Patch complete! File: {path}")
print("Next: npm run build && git add . && git commit -m 'feat: bulk history import' && git push origin main")
