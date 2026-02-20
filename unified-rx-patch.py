import os, re
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()
f=open(path+'.bak9','w'); f.write(c); f.close()
print("Backup: App.jsx.bak9")

changes = 0

# ═══ 1. Add state for external med confirmation ═══
anchor = 'const [planAddText, setPlanAddText] = useState("");'
if anchor in c and 'confirmedExtMeds' not in c:
    insert = '''const [planAddText, setPlanAddText] = useState("");
  const [confirmedExtMeds, setConfirmedExtMeds] = useState({});'''
    c = c.replace(anchor, insert, 1)
    changes += 1
    print("1. State for confirmedExtMeds: OK")
else:
    print("1. State:", "EXISTS" if 'confirmedExtMeds' in c else "FAILED")

# ═══ 2. Add external meds computation in plan tab ═══
# Find the planMeds computation and add externalMeds after it
anchor2 = '{planMeds.length>0 && <PlanBlock id="meds" title="\U0001f48a Your Medications"'
idx2 = c.find(anchor2)
if idx2 > 0 and 'externalMedsBlock' not in c:
    # Find the line start
    line_start = c.rfind('\n', max(0, idx2-5), idx2) + 1
    
    ext_meds_block = '''
                {/* ═══ External Consultant Medications ═══ */}
                {(() => {
                  // externalMedsBlock marker
                  if (!patientFullData?.medications || !patientFullData?.consultations) return null;
                  // Current consultation meds (names)
                  const currentMedNames = new Set(sa(conData,"medications_confirmed").map(m=>(m.name||"").toUpperCase().replace(/[^A-Z]/g,"")));
                  // Get all active meds NOT in current prescription
                  const allActiveMeds = (patientFullData.medications||[]).filter(m => m.is_active);
                  const extMeds = allActiveMeds.filter(m => {
                    const key = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
                    return key.length > 1 && !currentMedNames.has(key);
                  });
                  if (extMeds.length === 0) return null;
                  // Group by consultation (doctor)
                  const conMap = {};
                  (patientFullData.consultations||[]).forEach(con => { conMap[con.id] = con; });
                  const groups = {};
                  extMeds.forEach(m => {
                    const con = conMap[m.consultation_id] || {};
                    const doctor = con.con_name || con.mo_name || "Unknown";
                    const key = `${doctor}|||${con.visit_date||""}`;
                    if (!groups[key]) groups[key] = { doctor, date: con.visit_date, status: con.status, meds: [] };
                    // Deduplicate
                    const dupKey = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
                    if (!groups[key].meds.find(x => (x.name||"").toUpperCase().replace(/[^A-Z]/g,"") === dupKey)) {
                      groups[key].meds.push(m);
                    }
                  });
                  const groupArr = Object.values(groups).filter(g => g.meds.length > 0);
                  if (groupArr.length === 0) return null;
                  const totalExt = groupArr.reduce((s,g) => s + g.meds.length, 0);
                  const allConfirmed = extMeds.every(m => confirmedExtMeds[(m.name||"").toUpperCase()]);
                  return (
                    <PlanBlock id="extmeds" title={"\U0001f3e5 Medications by Other Consultants (" + totalExt + ")"} color="#92400e" hidden={planHidden.has("extmeds")} onToggle={()=>toggleBlock("extmeds")}>
                      <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:6, padding:"6px 10px", marginBottom:8, fontSize:10, color:"#92400e", lineHeight:1.5 }}>
                        {"\u26a0\ufe0f"} <b>Note:</b> External consultant medications listed below are based on copies of prescriptions provided by the patient. Please verify all medications with the patient. Gini Advanced Care Hospital is not responsible for prescriptions by external consultants.
                      </div>
                      <div className="no-print" style={{ display:"flex", gap:6, marginBottom:8, alignItems:"center" }}>
                        <button onClick={()=>{const all={};extMeds.forEach(m=>{all[(m.name||"").toUpperCase()]=true;});setConfirmedExtMeds(prev=>({...prev,...all}));}}
                          style={{ padding:"4px 10px", background:allConfirmed?"#dcfce7":"#059669", color:allConfirmed?"#059669":"white", border:allConfirmed?"1px solid #bbf7d0":"none", borderRadius:4, fontSize:10, fontWeight:700, cursor:"pointer" }}>
                          {allConfirmed ? "\u2705 All Confirmed" : "\u2705 Confirm All"}
                        </button>
                        <span style={{ fontSize:9, color:"#64748b" }}>
                          {Object.values(confirmedExtMeds).filter(Boolean).length}/{totalExt} confirmed
                        </span>
                      </div>
                      {groupArr.map((group, gi) => {
                        const fmtDate = (d) => { try { const s=String(d||""); const dt=s.length>=10?new Date(s.slice(0,10)+"T12:00:00"):new Date(s); return dt.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}); } catch(e) { return ""; } };
                        return (
                          <div key={gi} style={{ marginBottom:8 }}>
                            <div style={{ fontSize:10, fontWeight:700, color:"#475569", padding:"3px 8px", background:"#f1f5f9", borderRadius:4, marginBottom:4, display:"flex", justifyContent:"space-between" }}>
                              <span>{group.doctor}{group.date ? " \u2014 " + fmtDate(group.date) : ""}</span>
                              <span style={{ fontSize:8, color:group.status==="historical"?"#64748b":"#059669" }}>{group.status||"external"}</span>
                            </div>
                            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                              <tbody>
                                {group.meds.map((m, mi) => {
                                  const mkey = (m.name||"").toUpperCase();
                                  const isConf = confirmedExtMeds[mkey];
                                  return (
                                    <tr key={mi} style={{ background:isConf?"#f0fdf4":mi%2?"#fafafa":"white", borderBottom:"1px solid #f1f5f9", cursor:"pointer" }}
                                      onClick={()=>setConfirmedExtMeds(prev=>({...prev,[mkey]:!prev[mkey]}))}>
                                      <td className="no-print" style={{ padding:"4px 6px", width:24, fontSize:16 }}>{isConf ? "\u2705" : "\U0001f7e8"}</td>
                                      <td style={{ padding:"4px 8px", fontWeight:700 }}>{m.name}{m.composition && <div style={{fontSize:9,color:"#94a3b8"}}>{m.composition}</div>}</td>
                                      <td style={{ padding:"4px 8px", textAlign:"center", fontWeight:600 }}>{m.dose||""}</td>
                                      <td style={{ padding:"4px 8px", textAlign:"center", fontSize:10, fontWeight:600, color:"#1e40af" }}>{m.timing||m.frequency||""}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </PlanBlock>
                  );
                })()}

'''
    c = c[:line_start] + ext_meds_block + c[line_start:]
    changes += 1
    print("2. External meds block in plan: OK")
else:
    print("2. External meds block:", "EXISTS" if 'externalMedsBlock' in c else "FAILED - anchor not found")

# ═══ 3. Add upcoming external appointments section after follow-up ═══
anchor3 = '{conData?.future_plan'
idx3 = c.find(anchor3)
if idx3 > 0 and 'extAppointments' not in c:
    line_start3 = c.rfind('\n', max(0, idx3-5), idx3) + 1
    
    appt_block = '''
                {/* ═══ extAppointments: Upcoming External Doctor Appointments ═══ */}
                {(() => {
                  if (!patientFullData?.consultations) return null;
                  // Find consultations with future follow-up dates from external doctors
                  const today = new Date().toISOString().split("T")[0];
                  const extCons = (patientFullData.consultations||[]).filter(con => {
                    // Only historical/external visits (not current Gini visit)
                    return con.status === "historical" || (con.con_name && !["Dr. Bhansali","Dr. Khetarpal","Dr. Beant","Dr. Rahul"].some(d => (con.con_name||"").includes(d.split(" ")[1])));
                  });
                  // Get the most recent from each doctor
                  const byDoctor = {};
                  extCons.forEach(con => {
                    const doc = con.con_name || con.mo_name || "External";
                    if (!byDoctor[doc] || new Date(con.visit_date) > new Date(byDoctor[doc].visit_date)) byDoctor[doc] = con;
                  });
                  const upcoming = Object.values(byDoctor).filter(con => {
                    const cd = con.con_data;
                    if (!cd) return true; // Show even without follow-up data
                    return true;
                  });
                  if (upcoming.length === 0) return null;
                  const fmtDate = (d) => { try { const s=String(d||""); const dt=s.length>=10?new Date(s.slice(0,10)+"T12:00:00"):new Date(s); return dt.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}); } catch(e) { return ""; } };
                  return (
                    <PlanBlock id="ext-appointments" title={"\U0001f4cb Other Doctor Visits"} color="#475569" hidden={planHidden.has("ext-appointments")} onToggle={()=>toggleBlock("ext-appointments")}>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                        {upcoming.map((con, i) => (
                          <div key={i} style={{ padding:"6px 10px", background:"#f8fafc", borderRadius:6, borderLeft:"3px solid #7c3aed" }}>
                            <div style={{ fontSize:11, fontWeight:700 }}>{con.con_name||con.mo_name||"External"}</div>
                            <div style={{ fontSize:9, color:"#64748b" }}>Last: {fmtDate(con.visit_date)}</div>
                          </div>
                        ))}
                      </div>
                    </PlanBlock>
                  );
                })()}

'''
    c = c[:line_start3] + appt_block + c[line_start3:]
    changes += 1
    print("3. External appointments section: OK")
else:
    print("3. External appointments:", "EXISTS" if 'extAppointments' in c else "FAILED")

# ═══ 4. Update AI Brief prompt to include external meds context ═══
# Find where AI brief sends patient data
anchor4 = 'const generateAIBrief = async () => {'
idx4 = c.find(anchor4)
if idx4 > 0:
    # Find where it builds the data payload - look for "medications:" in the brief function
    brief_meds_anchor = 'medications: patientFullData.medications?.filter(m=>m.is_active).map(m => `${m.name} ${m.dose} ${m.frequency}`)'
    if brief_meds_anchor in c:
        new_brief_meds = '''medications: patientFullData.medications?.filter(m=>m.is_active).map(m => {
            const con = (patientFullData.consultations||[]).find(c => c.id === m.consultation_id);
            return `${m.name} ${m.dose||""} ${m.frequency||""} ${m.timing||""} [prescribed by: ${con?.con_name||con?.mo_name||"unknown"} on ${con?.visit_date||"?"}]`;
          })'''
        c = c.replace(brief_meds_anchor, new_brief_meds, 1)
        changes += 1
        print("4. AI Brief meds with doctor attribution: OK")
    else:
        print("4. AI Brief meds: FAILED - pattern not found")
else:
    print("4. AI Brief function: NOT FOUND")

# ═══ 5. Add external meds to the text export (Copy Rx / Print) ═══
anchor5 = '    // Follow-up'
# Find after medications text section
med_text_anchor = 'text += `\\nMEDICATIONS:\\n`;'
if med_text_anchor in c and 'EXTERNAL CONSULTANT MEDICATIONS' not in c:
    # Find the end of the medications text block (before lifestyle)
    lifestyle_text = "text += `\\nLIFESTYLE"
    idx5 = c.find(lifestyle_text)
    if idx5 > 0:
        ext_text = '''
    // External medications
    if (patientFullData?.medications) {
      const currentMedNames = new Set(sa(conData,"medications_confirmed").map(m=>(m.name||"").toUpperCase().replace(/[^A-Z]/g,"")));
      const extMeds = (patientFullData.medications||[]).filter(m => {
        if (!m.is_active) return false;
        const key = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
        return key.length > 1 && !currentMedNames.has(key);
      });
      if (extMeds.length > 0) {
        text += `\\nMEDICATIONS BY OTHER CONSULTANTS:\\n`;
        text += `(Based on copies of prescriptions provided. Please verify with patient.)\\n`;
        const conMap = {};
        (patientFullData.consultations||[]).forEach(con => { conMap[con.id] = con; });
        extMeds.forEach(m => {
          const con = conMap[m.consultation_id] || {};
          text += `\\u2022 ${m.name} | ${m.dose||""} | ${m.frequency||""} ${m.timing||""} | By: ${con.con_name||con.mo_name||"external"}\\n`;
        });
      }
    }

'''
        c = c[:idx5] + ext_text + c[idx5:]
        changes += 1
        print("5. External meds in text export: OK")
    else:
        print("5. Text export: lifestyle anchor not found")
else:
    print("5. Text export:", "EXISTS" if 'EXTERNAL CONSULTANT MEDICATIONS' in c else "FAILED")

# ═══ 6. Update AI Brief prompt to mention external consultations ═══
brief_prompt_anchor = '**30-SECOND OVERVIEW**'
if brief_prompt_anchor in c:
    old_prompt_section = '**30-SECOND OVERVIEW**'
    # Find the system prompt for AI brief
    since_last_anchor = '**SINCE LAST VISIT**'
    if since_last_anchor in c:
        # Check if external consultation section already exists
        if 'EXTERNAL CONSULTATIONS' not in c:
            c = c.replace(since_last_anchor, 
                '**SINCE LAST VISIT** (include visits to ANY doctor — internal or external. For each external visit: doctor name, hospital, specialty, date, what was found, what was prescribed, what was planned next)\n**EXTERNAL CONSULTATIONS SUMMARY** (if patient visited other hospitals/doctors, provide a dedicated summary for each: doctor, hospital, date, findings, medications started/changed, follow-up plans)', 1)
            changes += 1
            print("6. AI Brief external consultations prompt: OK")
        else:
            print("6. AI Brief prompt: EXISTS")
    else:
        print("6. AI Brief prompt: SINCE LAST VISIT not found")
else:
    print("6. AI Brief prompt: 30-SECOND not found")

f=open(path,'w'); f.write(c); f.close()
print(f"\nDone. {changes} changes applied. Run: npm run build")
