import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()
f=open(path+'.bak10','w'); f.write(c); f.close()
print("Backup: App.jsx.bak10")

changes = 0

# ═══ 1. Add state ═══
old1 = 'const [planAddText, setPlanAddText] = useState("");'
new1 = 'const [planAddText, setPlanAddText] = useState("");\n  const [confirmedExtMeds, setConfirmedExtMeds] = useState({});'
if 'confirmedExtMeds' not in c:
    c = c.replace(old1, new1, 1)
    changes += 1
    print("1. State: OK")
else:
    print("1. State: EXISTS")

# ═══ 2. Insert external meds block BETWEEN meds PlanBlock closing and Lifestyle PlanBlock ═══
old2 = '''                </PlanBlock>}

                {/* Lifestyle */}
                {planLifestyle.length>0 && <PlanBlock id="lifestyle" title="\U0001f957 Lifestyle Changes"'''

new2 = '''                </PlanBlock>}

                {/* ═══ External Consultant Medications ═══ */}
                {(() => {
                  if (!patientFullData?.medications || !patientFullData?.consultations) return null;
                  const currentMedNames = new Set(sa(conData,"medications_confirmed").map(m=>(m.name||"").toUpperCase().replace(/[^A-Z]/g,"")));
                  const extMeds = (patientFullData.medications||[]).filter(m => {
                    if (!m.is_active) return false;
                    const key = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
                    return key.length > 1 && !currentMedNames.has(key);
                  });
                  if (extMeds.length === 0) return null;
                  const conMap = {};
                  (patientFullData.consultations||[]).forEach(con => { conMap[con.id] = con; });
                  const groups = {};
                  extMeds.forEach(m => {
                    const con = conMap[m.consultation_id] || {};
                    const doctor = con.con_name || con.mo_name || "Unknown";
                    const key = doctor + "|||" + (con.visit_date||"");
                    if (!groups[key]) groups[key] = { doctor, date: con.visit_date, status: con.status, meds: [] };
                    const dupKey = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
                    if (!groups[key].meds.find(x => (x.name||"").toUpperCase().replace(/[^A-Z]/g,"") === dupKey)) {
                      groups[key].meds.push(m);
                    }
                  });
                  const groupArr = Object.values(groups).filter(g => g.meds.length > 0);
                  if (groupArr.length === 0) return null;
                  const totalExt = groupArr.reduce((s,g) => s + g.meds.length, 0);
                  const confirmedCount = extMeds.filter(m => confirmedExtMeds[(m.name||"").toUpperCase()]).length;
                  const allConfirmed = confirmedCount === totalExt;
                  return (
                    <PlanBlock id="extmeds" title={"\U0001f3e5 Medications by Other Consultants (" + totalExt + ")"} color="#92400e" hidden={planHidden.has("extmeds")} onToggle={()=>toggleBlock("extmeds")}>
                      <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:6, padding:"6px 10px", marginBottom:8, fontSize:10, color:"#92400e", lineHeight:1.5 }}>
                        <b>Note:</b> External consultant medications listed below are based on copies of prescriptions provided by the patient. Please verify all medications with the patient. Gini Advanced Care Hospital is not responsible for prescriptions by external consultants.
                      </div>
                      <div className="no-print" style={{ display:"flex", gap:6, marginBottom:8, alignItems:"center" }}>
                        <button onClick={()=>{const all={};extMeds.forEach(m=>{all[(m.name||"").toUpperCase()]=true;});setConfirmedExtMeds(prev=>({...prev,...all}));}}
                          style={{ padding:"4px 10px", background:allConfirmed?"#dcfce7":"#059669", color:allConfirmed?"#059669":"white", border:allConfirmed?"1px solid #bbf7d0":"none", borderRadius:4, fontSize:10, fontWeight:700, cursor:"pointer" }}>
                          {allConfirmed ? "All Confirmed" : "Confirm All"}
                        </button>
                        <span style={{ fontSize:9, color:"#64748b" }}>{confirmedCount}/{totalExt} confirmed</span>
                      </div>
                      {groupArr.map((group, gi) => {
                        const fDate = (d) => { try { const s=String(d||""); const dt=s.length>=10?new Date(s.slice(0,10)+"T12:00:00"):new Date(s); return dt.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}); } catch(e) { return ""; } };
                        return (
                          <div key={gi} style={{ marginBottom:8 }}>
                            <div style={{ fontSize:10, fontWeight:700, color:"#475569", padding:"3px 8px", background:"#f1f5f9", borderRadius:4, marginBottom:4 }}>
                              {group.doctor}{group.date ? " \\u2014 " + fDate(group.date) : ""}
                            </div>
                            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                              <tbody>
                                {group.meds.map((m, mi) => {
                                  const mkey = (m.name||"").toUpperCase();
                                  const isConf = confirmedExtMeds[mkey];
                                  return (
                                    <tr key={mi} style={{ background:isConf?"#f0fdf4":mi%2?"#fafafa":"white", borderBottom:"1px solid #f1f5f9", cursor:"pointer" }}
                                      onClick={()=>setConfirmedExtMeds(prev=>({...prev,[mkey]:!prev[mkey]}))}>
                                      <td className="no-print" style={{ padding:"4px 6px", width:24, fontSize:16 }}>{isConf ? "\\u2705" : "\\u2b1c"}</td>
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

                {/* Lifestyle */}
                {planLifestyle.length>0 && <PlanBlock id="lifestyle" title="\U0001f957 Lifestyle Changes"'''

if old2 in c and 'External Consultant Medications' not in c:
    c = c.replace(old2, new2, 1)
    changes += 1
    print("2. External meds block: OK")
else:
    if 'External Consultant Medications' in c:
        print("2. External meds block: EXISTS")
    else:
        print("2. External meds block: FAILED - anchor not found")
        # Debug
        test = '                </PlanBlock>}\n\n                {/* Lifestyle */}'
        if test in c:
            print("   DEBUG: simplified anchor found")
        else:
            print("   DEBUG: simplified anchor NOT found either")

# ═══ 3. Add external meds to AI Brief medication context ═══
old3 = "medications: patientFullData.medications?.filter(m=>m.is_active).map(m => `${m.name} ${m.dose} ${m.frequency}`)"
new3 = """medications: patientFullData.medications?.filter(m=>m.is_active).map(m => {
            const _con = (patientFullData.consultations||[]).find(c => c.id === m.consultation_id);
            return `${m.name} ${m.dose||""} ${m.frequency||""} ${m.timing||""} [by: ${_con?.con_name||_con?.mo_name||"unknown"}, ${_con?.visit_date||"?"}]`;
          })"""
if old3 in c:
    c = c.replace(old3, new3, 1)
    changes += 1
    print("3. AI Brief med attribution: OK")
else:
    print("3. AI Brief med attribution: FAILED")

# ═══ 4. Add EXTERNAL CONSULTATIONS to AI Brief prompt ═══
old4 = '**SINCE LAST VISIT**'
if old4 in c and 'EXTERNAL CONSULTATIONS' not in c:
    new4 = '**SINCE LAST VISIT** (include visits to other hospitals/doctors)\n**EXTERNAL CONSULTATIONS SUMMARY** (for each external doctor: name, hospital, date, findings, medications started, follow-up)'
    c = c.replace(old4, new4, 1)
    changes += 1
    print("4. AI Brief external consult prompt: OK")
else:
    print("4. AI Brief prompt:", "EXISTS" if 'EXTERNAL CONSULTATIONS' in c else "FAILED")

f=open(path,'w'); f.write(c); f.close()
print(f"\nDone. {changes} changes. Run: npm run build")
