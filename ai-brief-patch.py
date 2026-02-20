import os, re
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()
f=open(path+'.bak4','w'); f.write(c); f.close()
print("Backup: App.jsx.bak4")

# ═══════════════════════════════════════════════════════════════
# FIX 1: Bulk import — Sonnet + 16k + chunking
# ═══════════════════════════════════════════════════════════════

# Change model and tokens
old_model = 'body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 8000, messages: [{ role: "user", content: prompt }] })'
new_model = 'body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 16000, messages: [{ role: "user", content: prompt }] })'
if old_model in c:
    c = c.replace(old_model, new_model, 1)
    print("1. Model + tokens: OK")
else:
    # Try already-updated version
    if 'max_tokens: 16000' in c:
        print("1. Model + tokens: ALREADY DONE")
    else:
        print("1. Model + tokens: FAILED")

# Add chunking: replace the entire processBulkImport function
old_func_start = '  const processBulkImport = async () => {\n    if (!bulkText.trim() || !API_URL) return;\n    setBulkParsing(true); setBulkVisits([]); setBulkProgress("'
# Find it more carefully
func_start_idx = c.find('const processBulkImport = async () => {')
func_end_marker = 'setBulkParsing(false);\n  };'
func_end_idx = c.find(func_end_marker, func_start_idx)
if func_start_idx > 0 and func_end_idx > 0:
    old_func = c[func_start_idx:func_end_idx + len(func_end_marker)]
    
    new_func = r'''const processBulkImport = async () => {
    if (!bulkText.trim() || !API_URL) return;
    setBulkParsing(true); setBulkVisits([]); setBulkProgress("\u23f3 Splitting visits...");
    try {
      const fullText = bulkText.trim();
      
      // Split into chunks if text is very long (>5000 chars likely = 10+ visits)
      const chunks = [];
      if (fullText.length > 5000) {
        const markers = [];
        const regex = /FOLLOW\s*UP\s*(ON|TODAY|NOTES)/gi;
        let match;
        while ((match = regex.exec(fullText)) !== null) markers.push(match.index);
        
        if (markers.length > 6) {
          // Split at roughly the midpoint of follow-up markers
          const mid = Math.floor(markers.length / 2);
          const splitPoint = markers[mid];
          // Include header/diagnosis context in second chunk
          const firstFollowUp = markers[0] || 0;
          const header = fullText.slice(0, firstFollowUp);
          chunks.push(fullText.slice(0, splitPoint));
          chunks.push(header + "\n...(continued from previous visits)...\n" + fullText.slice(splitPoint));
          setBulkProgress(`\u23f3 Large history detected — processing in ${chunks.length} chunks...`);
        } else {
          chunks.push(fullText);
        }
      } else {
        chunks.push(fullText);
      }
      
      let allVisits = [];
      
      for (let ci = 0; ci < chunks.length; ci++) {
        if (chunks.length > 1) setBulkProgress(`\u23f3 Processing chunk ${ci + 1}/${chunks.length}...`);
        
        const chunkText = chunks[ci];
        const prompt = `You are a clinical data extraction AI. The user is pasting ALL visit history for a patient from another EMR system.

Your job: Split this text into INDIVIDUAL VISIT entries, one per follow-up date.

Output a JSON array of visit objects. ONLY output valid JSON, no markdown, no explanation.

Each visit object:
[
  {
    "visit_date": "YYYY-MM-DD",
    "visit_type": "OPD",
    "doctor_name": "Dr. Name if mentioned",
    "specialty": "Endocrinology",
    "vitals": { "bp_sys": 130, "bp_dia": 80, "weight": 65, "height": 155, "bmi": 27, "waist": 86, "body_fat": 32, "pulse": null },
    "diagnoses": [{ "id": "dm2", "label": "Type 2 DM (Since 2005)", "status": "Uncontrolled" }],
    "medications": [{ "name": "TAB SITACIP M", "dose": "100+500mg", "frequency": "OD", "timing": "30min before breakfast" }],
    "labs": [{ "test_name": "HbA1c", "result": 6.9, "unit": "%", "flag": "H", "ref_range": "<7" }],
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
` + chunkText;

        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 16000, messages: [{ role: "user", content: prompt }] })
        });
        const result = await resp.json();
        console.log(`Bulk chunk ${ci+1} response:`, JSON.stringify(result).slice(0,500));
        if (result.error) { setBulkProgress("API error: " + result.error.message); setBulkParsing(false); return; }
        const text = (result.content?.[0]?.text || "").trim();
        if (text.length === 0) { setBulkProgress("Empty response from AI"); setBulkParsing(false); return; }
        const jsonStr = text.replace(/^```json\n?|```$/g, "").trim();
        const visits = JSON.parse(jsonStr);
        if (Array.isArray(visits)) allVisits = allVisits.concat(visits);
      }

      if (allVisits.length === 0) {
        setBulkProgress("\u274c Could not parse visits. Try reformatting.");
        setBulkParsing(false);
        return;
      }

      // Deduplicate by date and sort
      const seen = new Set();
      const deduped = [];
      allVisits.sort((a, b) => new Date(a.visit_date) - new Date(b.visit_date));
      for (const v of allVisits) {
        if (!seen.has(v.visit_date)) { seen.add(v.visit_date); deduped.push(v); }
      }
      setBulkVisits(deduped);
      setBulkProgress(`\u2705 Found ${deduped.length} visits${chunks.length > 1 ? ` (processed in ${chunks.length} chunks)` : ""}. Review and click Save All.`);
    } catch (e) {
      setBulkProgress("\u274c Parse error: " + e.message);
    }
    setBulkParsing(false);
  };'''

    c = c[:func_start_idx] + new_func + c[func_end_idx + len(func_end_marker):]
    print("2. Chunked bulk import: OK")
else:
    print("2. Chunked bulk import: FAILED - function not found")

# ═══════════════════════════════════════════════════════════════
# FIX 2: Lab extraction prompt — only current visit labs
# ═══════════════════════════════════════════════════════════════

old_lab1 = '- CRITICAL: ANY numeric lab value mentioned ANYWHERE in the text (FBG, HbA1c, TSH, T3, T4, TG, LDL, HDL, creatinine, potassium, Non-HDL, eGFR, etc) MUST appear in mo.investigations array with value, unit, flag, ref. Do NOT just put them in goals or summary.'
new_lab1 = '- CRITICAL: For mo.investigations, ONLY extract lab values from the CURRENT/TODAY/LATEST visit. The text may contain historical values from previous follow-ups — IGNORE those. Look for the LAST "FOLLOW UP TODAY" or most recent date. Only values from that date go into investigations. Each value needs: test name, numeric value, unit, flag (HIGH/LOW/null), ref range.'

old_lab2 = '- Extract ALL lab values as investigations with proper flags (HIGH/LOW/null)'
new_lab2 = '- Extract ONLY lab values from the CURRENT/LATEST visit as investigations with proper flags (HIGH/LOW/null). IGNORE values from earlier follow-up dates.'

old_lab3 = '- Extract ALL lab values with flags (HIGH/LOW/null)'
new_lab3 = '- Extract ONLY lab values from the CURRENT/LATEST visit with flags (HIGH/LOW/null). IGNORE historical follow-up values.'

for old, new, label in [(old_lab1, new_lab1, "Quick prompt"), (old_lab2, new_lab2, "MO prompt"), (old_lab3, new_lab3, "Split prompt")]:
    if old in c:
        c = c.replace(old, new, 1)
        print(f"3. {label} lab fix: OK")
    else:
        print(f"3. {label} lab fix: SKIPPED (already fixed or not found)")

# ═══════════════════════════════════════════════════════════════
# FEATURE: AI Clinical Brief (Sonnet-powered)
# ═══════════════════════════════════════════════════════════════

# Add state for AI brief
old_brief_state = 'const [moBrief, setMoBrief] = useState(null);\n  const [briefMode, setBriefMode] = useState("narrative");'
if old_brief_state not in c:
    old_brief_state = 'const [moBrief, setMoBrief] = useState(null);'
new_brief_state = old_brief_state + '\n  const [aiBrief, setAiBrief] = useState(null);\n  const [aiBriefLoading, setAiBriefLoading] = useState(false);'
if 'aiBrief' not in c:
    c = c.replace(old_brief_state, new_brief_state, 1)
    print("4. AI brief state: OK")
else:
    print("4. AI brief state: EXISTS")

# Clear aiBrief on patient switch
old_clear = 'setMoBrief(null);\n    setPatientFullData(null);'
if old_clear not in c:
    old_clear = 'setMoBrief(null);'
new_clear = old_clear.rstrip(';') + ';\n    setAiBrief(null);'
if 'setAiBrief(null)' not in c:
    c = c.replace(old_clear, new_clear, 1)
    print("5. AI brief clear on switch: OK")
else:
    print("5. AI brief clear: EXISTS")

# Add the AI brief generation function after generateMOBrief
insert_marker = '  const processConsultant = async () => {'
insert_idx = c.find(insert_marker)
if insert_idx > 0 and 'generateAIBrief' not in c:
    ai_brief_func = r'''  const generateAIBrief = async () => {
    const pfd = patientFullData;
    if (!pfd) return;
    setAiBriefLoading(true); setAiBrief(null);
    try {
      // Build comprehensive patient data summary for AI
      const sortedCons = (pfd.consultations||[]).sort((a,b) => new Date(a.visit_date) - new Date(b.visit_date));
      const isFollowUp = sortedCons.length > 0;
      
      // Visits summary
      const visitsSummary = sortedCons.map(con => {
        const v = (pfd.vitals||[]).find(vt => vt.consultation_id === con.id);
        const meds = (pfd.medications||[]).filter(m => m.consultation_id === con.id);
        const labs = (pfd.lab_results||[]).filter(l => l.consultation_id === con.id);
        const diags = (pfd.diagnoses||[]).filter(d => d.consultation_id === con.id);
        return {
          date: con.visit_date, doctor: con.con_name || con.mo_name, status: con.status,
          vitals: v ? { bp: v.bp_sys ? `${v.bp_sys}/${v.bp_dia}` : null, weight: v.weight, bmi: v.bmi, waist: v.waist } : null,
          meds: meds.slice(0,15).map(m => `${m.name} ${m.dose||""} ${m.frequency||""} ${m.timing||""}`),
          labs: labs.map(l => `${l.test_name}: ${l.result}${l.unit||""} [${l.flag||"N"}]`),
          diagnoses: diags.map(d => `${d.label} (${d.status})`)
        };
      });

      // Current vitals
      const cv = vitals.bp_sys ? vitals : null;
      
      // Current MO data
      const currentMO = moData ? {
        complaints: moData.chief_complaints || [],
        compliance: moData.compliance || "",
        investigations: (moData.investigations||[]).map(i => `${i.test}: ${i.value}${i.unit||""}`),
        diagnoses: (moData.diagnoses||[]).map(d => `${d.label} (${d.status})`)
      } : null;

      const dataPayload = JSON.stringify({
        patient: { name: patient.name, age: patient.age, sex: patient.sex },
        isFollowUp,
        totalVisits: sortedCons.length,
        firstVisit: sortedCons[0]?.visit_date,
        visits: visitsSummary.slice(-15), // Last 15 visits
        currentVitals: cv ? { bp: `${cv.bp_sys}/${cv.bp_dia}`, weight: cv.weight, bmi: cv.bmi, pulse: cv.pulse } : null,
        currentMO: currentMO,
        todayDate: new Date().toISOString().split("T")[0]
      });

      const systemPrompt = isFollowUp ? `You are an expert clinical briefing AI for Gini Advanced Care Hospital. Generate a comprehensive CLINICAL BRIEF that an MO (Medical Officer) reads aloud to the Consultant before they see the patient.

Write in natural, professional English — as if an experienced MO is presenting the case. Use paragraph form, not bullet points.

Structure your brief with these sections (use these exact headers):

**PATIENT JOURNEY**
One paragraph covering: who they are, how long under care, total visits, primary diagnoses, what brought them originally.

**WHAT'S WORKING**
Conditions that are controlled. Lab values that improved. Medications showing effect. Be specific with numbers and trajectories.

**WHAT NEEDS ATTENTION**
Worsening parameters with trajectories. Uncontrolled conditions. New symptoms or complications. Be specific: "Creatinine has risen from 1.96 to 2.16 to 2.62 over 3 visits — eGFR now 29, suggesting CKD progression."

**MEDICATION REVIEW**
Current regimen summary. Any recent changes (added/stopped). Duration on current protocol. Any known intolerances or switches.

**ADHERENCE & COMPLIANCE**
Visit regularity (expected vs actual gaps). Lab compliance — are they bringing requested tests? Weight/BP trends suggesting lifestyle compliance.

**SINCE LAST VISIT**
What specifically changed between the previous visit and today. New labs, new symptoms, vitals comparison.

**QUESTIONS TO ASK**
3-5 specific questions the consultant should ask this patient based on their data patterns. E.g., "Ask about salt intake — BP trending up despite 3 antihypertensives."

**CLINICAL CONSIDERATIONS**
2-3 evidence-based suggestions the consultant might consider. E.g., "With eGFR 29 and rising creatinine, consider nephrology referral. Persistent hyperkalemia despite K-Bind — evaluate dietary potassium and consider dose adjustment."

Be precise with numbers. Reference actual lab values and dates. No generic advice — everything must be specific to THIS patient's data.` 

: `You are an expert clinical briefing AI for Gini Advanced Care Hospital. Generate a brief for a NEW PATIENT that helps the consultant make initial diagnosis and treatment decisions.

Write in natural, professional English.

Structure with these sections:

**PATIENT PRESENTATION**
Demographics, chief complaints, how they present today.

**HISTORY SUMMARY**
Past medical/surgical, family history, personal history if available. Current medications they came with.

**TODAY'S FINDINGS**
Vitals, any lab values available, physical exam findings.

**DIFFERENTIAL CONSIDERATIONS**
Based on presentation, suggest 2-3 clinical considerations or differential diagnoses worth exploring.

**SUGGESTED WORKUP**
What investigations should be ordered based on the presentation.

**KEY QUESTIONS**
Important history questions to ask for better clinical picture.

Be precise and clinical. Reference actual values from the data.`;

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000, system: systemPrompt, messages: [{ role: "user", content: `Generate clinical brief for this patient:\n\n${dataPayload}` }] })
      });
      const result = await resp.json();
      if (result.error) { setAiBrief("Error: " + result.error.message); }
      else {
        const text = (result.content?.[0]?.text || "").trim();
        setAiBrief(text || "No brief generated.");
      }
    } catch (e) {
      setAiBrief("Error generating brief: " + e.message);
    }
    setAiBriefLoading(false);
  };

''' + '  '
    c = c[:insert_idx] + ai_brief_func + c[insert_idx:]
    print("6. AI brief function: OK")
else:
    if 'generateAIBrief' in c:
        print("6. AI brief function: EXISTS")
    else:
        print("6. AI brief function: FAILED - insert point not found")

# ═══════════════════════════════════════════════════════════════
# Add AI Brief button and display in the MO brief panel
# ═══════════════════════════════════════════════════════════════

# Find the Generate Consultant Brief button and add AI Brief button after it
old_gen_btn = '📋 Generate Consultant Brief\n                </button>'
if old_gen_btn in c:
    new_gen_btn = old_gen_btn + r'''
              {patientFullData && (
                <button onClick={generateAIBrief} disabled={aiBriefLoading}
                  style={{ width:"100%", marginTop:6, background: aiBriefLoading ? "#94a3b8" : "linear-gradient(135deg,#7c3aed,#a855f7)", color:"white", border:"none", padding:"10px", borderRadius:8, fontSize:13, fontWeight:700, cursor:aiBriefLoading?"wait":"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                  {aiBriefLoading ? "\u23f3 Generating AI Brief..." : "\U0001f9e0 AI Clinical Brief"}
                </button>
              )}
              {aiBrief && (
                <div style={{ marginTop:8, border:"2px solid #7c3aed", borderRadius:10, overflow:"hidden" }}>
                  <div style={{ background:"linear-gradient(135deg,#7c3aed,#6d28d9)", color:"white", padding:"8px 12px", display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:14 }}>\U0001f9e0</span>
                    <div style={{ flex:1, fontWeight:800, fontSize:13 }}>AI CLINICAL BRIEF</div>
                    <button onClick={()=>{ navigator.clipboard.writeText(aiBrief); }}
                      style={{ background:"rgba(255,255,255,.2)", border:"none", color:"white", padding:"4px 10px", borderRadius:5, fontSize:10, fontWeight:700, cursor:"pointer" }}>\U0001f4cb Copy</button>
                    <button onClick={()=>setAiBrief(null)}
                      style={{ background:"rgba(255,255,255,.1)", border:"none", color:"white", padding:"4px 6px", borderRadius:5, fontSize:10, cursor:"pointer" }}>\u2715</button>
                  </div>
                  <div style={{ padding:12, fontSize:12, lineHeight:1.8, color:"#1e293b", whiteSpace:"pre-wrap", maxHeight:500, overflowY:"auto", background:"#faf5ff" }}>
                    {aiBrief.split(/\*\*(.*?)\*\*/g).map((part, i) => 
                      i % 2 === 1 
                        ? <div key={i} style={{ fontWeight:800, fontSize:11, color:"#7c3aed", marginTop:i>1?12:0, marginBottom:4, textTransform:"uppercase", letterSpacing:".5px", borderBottom:"1px solid #e9d5ff", paddingBottom:3 }}>{part}</div>
                        : <span key={i}>{part}</span>
                    )}
                  </div>
                </div>
              )}'''
    c = c.replace(old_gen_btn, new_gen_btn, 1)
    print("7. AI brief UI: OK")
else:
    print("7. AI brief UI: FAILED - button not found")

# Also fix: clear stale patientFullData on switch (from earlier fix)
if 'setPatientFullData(null)' not in c:
    old_switch = 'setMoBrief(null);\n    setCrExpanded'
    new_switch = 'setMoBrief(null);\n    setPatientFullData(null);\n    setCrExpanded'
    if old_switch in c:
        c = c.replace(old_switch, new_switch, 1)
        print("8. Clear data on switch: OK")
    else:
        print("8. Clear data on switch: SKIPPED")
else:
    print("8. Clear data on switch: EXISTS")

f=open(path,'w'); f.write(c); f.close()
print("\n=== DONE === Run: npm run build && git add . && git commit -m 'feat: AI clinical brief + chunk bulk + fix lab extraction' && git push origin main")
