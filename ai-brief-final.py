import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()
f=open(path+'.bak5','w'); f.write(c); f.close()
print("Backup: App.jsx.bak5")

# ═══ 1. Add state ═══
old = 'const [moBrief, setMoBrief] = useState(null);'
new = 'const [moBrief, setMoBrief] = useState(null);\n  const [aiBrief, setAiBrief] = useState(null);\n  const [aiBriefLoading, setAiBriefLoading] = useState(false);'
if 'aiBrief' not in c:
    c = c.replace(old, new, 1)
    print("1. State: OK")
else:
    print("1. State: EXISTS")

# ═══ 2. Clear on patient switch ═══
old = 'setMoBrief(null);'
new = 'setMoBrief(null); setAiBrief(null);'
if 'setAiBrief(null)' not in c:
    c = c.replace(old, new, 1)
    print("2. Clear on switch: OK")
else:
    print("2. Clear on switch: EXISTS")

# ═══ 3. Add generateAIBrief function ═══
marker = '  const processConsultant = async () => {'
idx = c.find(marker)
if idx > 0 and 'generateAIBrief' not in c:
    func = '''  const generateAIBrief = async () => {
    const pfd = patientFullData;
    if (!pfd) return;
    setAiBriefLoading(true); setAiBrief(null);
    try {
      const sortedCons = (pfd.consultations||[]).sort((a,b) => new Date(a.visit_date) - new Date(b.visit_date));
      const isFollowUp = sortedCons.length > 0;
      const visitsSummary = sortedCons.map(con => {
        const v = (pfd.vitals||[]).find(vt => vt.consultation_id === con.id);
        const meds = (pfd.medications||[]).filter(m => m.consultation_id === con.id);
        const labs = (pfd.lab_results||[]).filter(l => l.consultation_id === con.id);
        const diags = (pfd.diagnoses||[]).filter(d => d.consultation_id === con.id);
        return {
          date: con.visit_date, doctor: con.con_name || con.mo_name,
          vitals: v ? { bp: v.bp_sys ? v.bp_sys+"/"+v.bp_dia : null, weight: v.weight, bmi: v.bmi, waist: v.waist } : null,
          meds: meds.slice(0,15).map(m => m.name+" "+(m.dose||"")+" "+(m.frequency||"")+" "+(m.timing||"")),
          labs: labs.map(l => l.test_name+": "+l.result+(l.unit||"")+" ["+(l.flag||"N")+"]"),
          diagnoses: diags.map(d => d.label+" ("+d.status+")")
        };
      });
      const cv = vitals.bp_sys ? vitals : null;
      const currentMO = moData ? {
        complaints: moData.chief_complaints || [],
        compliance: moData.compliance || "",
        investigations: (moData.investigations||[]).map(i => i.test+": "+i.value+(i.unit||"")),
        diagnoses: (moData.diagnoses||[]).map(d => d.label+" ("+d.status+")")
      } : null;
      const dataPayload = JSON.stringify({
        patient: { name: patient.name, age: patient.age, sex: patient.sex },
        isFollowUp, totalVisits: sortedCons.length,
        firstVisit: sortedCons[0]?.visit_date,
        visits: visitsSummary.slice(-15),
        currentVitals: cv ? { bp: cv.bp_sys+"/"+cv.bp_dia, weight: cv.weight, bmi: cv.bmi, pulse: cv.pulse } : null,
        currentMO, todayDate: new Date().toISOString().split("T")[0]
      });
      const systemPrompt = isFollowUp ? `You are an expert clinical briefing AI for Gini Advanced Care Hospital. Generate a comprehensive CLINICAL BRIEF that an MO reads aloud to the Consultant.

Write in natural professional English, paragraph form, not bullets.

Use these exact section headers wrapped in **double asterisks**:

**PATIENT JOURNEY**
Who they are, how long under care, total visits, primary diagnoses, what brought them.

**WHAT'S WORKING**
Controlled conditions, improving labs with specific trajectories and numbers, effective medications.

**WHAT NEEDS ATTENTION**
Worsening parameters with trajectories. Uncontrolled conditions. New symptoms. Be specific with numbers and dates.

**MEDICATION REVIEW**
Current regimen. Recent changes. Duration on current protocol.

**ADHERENCE & COMPLIANCE**
Visit regularity. Lab compliance. Weight/BP trends suggesting lifestyle compliance.

**SINCE LAST VISIT**
What specifically changed. New labs, new symptoms, vitals comparison.

**QUESTIONS TO ASK**
3-5 specific questions based on data patterns.

**CLINICAL CONSIDERATIONS**
2-3 evidence-based suggestions the consultant might consider. Reference actual values.

Be precise with numbers. No generic advice.` : `You are an expert clinical briefing AI. Generate a NEW PATIENT brief.

Use these exact section headers wrapped in **double asterisks**:

**PATIENT PRESENTATION**
Demographics, chief complaints, how they present.

**HISTORY SUMMARY**
Past medical/surgical, family, personal history. Current medications.

**TODAY'S FINDINGS**
Vitals, lab values, exam findings.

**DIFFERENTIAL CONSIDERATIONS**
2-3 clinical considerations worth exploring.

**SUGGESTED WORKUP**
Investigations to order.

**KEY QUESTIONS**
Important history questions to ask.

Be precise and clinical.`;
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000, system: systemPrompt, messages: [{ role: "user", content: "Generate clinical brief:\\n\\n" + dataPayload }] })
      });
      const result = await resp.json();
      if (result.error) setAiBrief("Error: " + result.error.message);
      else setAiBrief((result.content?.[0]?.text || "").trim() || "No brief generated.");
    } catch (e) { setAiBrief("Error: " + e.message); }
    setAiBriefLoading(false);
  };

'''
    c = c[:idx] + func + c[idx:]
    print("3. AI brief function: OK")
else:
    print("3. AI brief function:", "EXISTS" if 'generateAIBrief' in c else "FAILED")

# ═══ 4. Insert UI — AFTER the MO brief section, BEFORE consultant tab ═══
insertion_target = '''        </div>
      )}

      {/* ===== CONSULTANT ===== */}'''

ai_ui = '''
          {/* ── AI CLINICAL BRIEF ── */}
          {dbPatientId && patientFullData && (
            <div style={{ marginBottom:10 }}>
              <button onClick={generateAIBrief} disabled={aiBriefLoading}
                style={{ width:"100%", background: aiBriefLoading ? "#94a3b8" : "linear-gradient(135deg,#7c3aed,#a855f7)", color:"white", border:"none", padding:"10px", borderRadius:8, fontSize:13, fontWeight:700, cursor:aiBriefLoading?"wait":"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                {aiBriefLoading ? "\\u23f3 Generating AI Brief..." : "\\U0001f9e0 AI Clinical Brief"}
              </button>
              {aiBrief && (
                <div style={{ marginTop:8, border:"2px solid #7c3aed", borderRadius:10, overflow:"hidden" }}>
                  <div style={{ background:"linear-gradient(135deg,#7c3aed,#6d28d9)", color:"white", padding:"8px 12px", display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:14 }}>\\U0001f9e0</span>
                    <div style={{ flex:1, fontWeight:800, fontSize:13 }}>AI CLINICAL BRIEF</div>
                    <button onClick={()=>navigator.clipboard.writeText(aiBrief)}
                      style={{ background:"rgba(255,255,255,.2)", border:"none", color:"white", padding:"4px 10px", borderRadius:5, fontSize:10, fontWeight:700, cursor:"pointer" }}>\\U0001f4cb Copy</button>
                    <button onClick={()=>setAiBrief(null)}
                      style={{ background:"rgba(255,255,255,.1)", border:"none", color:"white", padding:"4px 6px", borderRadius:5, fontSize:10, cursor:"pointer" }}>\\u2715</button>
                  </div>
                  <div style={{ padding:12, fontSize:12, lineHeight:1.8, color:"#1e293b", whiteSpace:"pre-wrap", maxHeight:500, overflowY:"auto", background:"#faf5ff" }}>
                    {aiBrief.split(/\\*\\*(.*?)\\*\\*/g).map((part, i) =>
                      i % 2 === 1
                        ? <div key={i} style={{ fontWeight:800, fontSize:11, color:"#7c3aed", marginTop:i>1?12:0, marginBottom:4, textTransform:"uppercase", letterSpacing:".5px", borderBottom:"1px solid #e9d5ff", paddingBottom:3 }}>{part}</div>
                        : <span key={i}>{part}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
'''

replacement = ai_ui + '''        </div>
      )}

      {/* ===== CONSULTANT ===== */}'''

if insertion_target in c and 'AI CLINICAL BRIEF' not in c:
    c = c.replace(insertion_target, replacement, 1)
    print("4. AI brief UI: OK")
else:
    print("4. AI brief UI:", "EXISTS" if 'AI CLINICAL BRIEF' in c else "FAILED - target not found")

# ═══ 5. Fix lab extraction prompts ═══
old_lab = '- CRITICAL: ANY numeric lab value mentioned ANYWHERE in the text (FBG, HbA1c, TSH, T3, T4, TG, LDL, HDL, creatinine, potassium, Non-HDL, eGFR, etc) MUST appear in mo.investigations array with value, unit, flag, ref. Do NOT just put them in goals or summary.'
new_lab = '- CRITICAL: For mo.investigations, ONLY extract lab values from the CURRENT/TODAY/LATEST visit. The text may contain historical values from previous follow-ups - IGNORE those. Look for the LAST "FOLLOW UP TODAY" or most recent date. Only values from that date go into investigations. Each value needs: test name, numeric value, unit, flag (HIGH/LOW/null), ref range.'
if old_lab in c:
    c = c.replace(old_lab, new_lab, 1)
    print("5a. Quick lab fix: OK")

old_lab2 = '- Extract ALL lab values as investigations with proper flags (HIGH/LOW/null)'
new_lab2 = '- Extract ONLY lab values from the CURRENT/LATEST visit as investigations with flags (HIGH/LOW/null). IGNORE historical follow-up values.'
if old_lab2 in c:
    c = c.replace(old_lab2, new_lab2, 1)
    print("5b. MO lab fix: OK")

old_lab3 = '- Extract ALL lab values with flags (HIGH/LOW/null)'
new_lab3 = '- Extract ONLY lab values from the CURRENT/LATEST visit with flags (HIGH/LOW/null). IGNORE historical values.'
if old_lab3 in c:
    c = c.replace(old_lab3, new_lab3, 1)
    print("5c. Split lab fix: OK")

# ═══ 6. Bulk import: Sonnet + 16k ═══
old_bulk = 'model: "claude-haiku-4-5-20251001", max_tokens: 8000, messages: [{ role: "user", content: prompt }]'
new_bulk = 'model: "claude-sonnet-4-20250514", max_tokens: 16000, messages: [{ role: "user", content: prompt }]'
if old_bulk in c:
    c = c.replace(old_bulk, new_bulk, 1)
    print("6. Bulk model: OK")

# ═══ 7. Clear patientFullData on switch ═══
old_switch = 'setMoBrief(null); setAiBrief(null);\n    setCrExpanded'
new_switch = 'setMoBrief(null); setAiBrief(null);\n    setPatientFullData(null);\n    setCrExpanded'
if 'setPatientFullData(null)' not in c:
    if old_switch in c:
        c = c.replace(old_switch, new_switch, 1)
        print("7. Clear patientFullData: OK")
    else:
        print("7. Clear patientFullData: SKIPPED - pattern not found")
else:
    print("7. Clear patientFullData: EXISTS")

f=open(path,'w'); f.write(c); f.close()
print("\nDone. Run: npm run build")
