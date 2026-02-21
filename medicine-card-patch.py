import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()
f=open(path+'.bak14','w'); f.write(c); f.close()
print("Backup: App.jsx.bak14")
changes = 0

# ═══ 1. Add state: extMedActions + planView ═══
old_state = 'const [confirmedExtMeds, setConfirmedExtMeds] = useState({});'
new_state = '''const [confirmedExtMeds, setConfirmedExtMeds] = useState({});
  const [extMedActions, setExtMedActions] = useState({});
  const [planView, setPlanView] = useState("plan");
  const [showReconcile, setShowReconcile] = useState(false);'''
if old_state in c:
    c = c.replace(old_state, new_state, 1)
    changes += 1
    print("1. States added: OK")
else:
    print("1. States: FAILED")

# ═══ 2. Add Plan/Medicine Card toggle buttons in plan header area ═══
# Find the plan header buttons area (Copy Rx and Print)
old_buttons = '<button className="no-print" onClick={copyPlanToClipboard}'
if old_buttons in c:
    toggle_btns = '''<div className="no-print" style={{ display:"flex", background:"#f1f5f9", borderRadius:6, padding:2, marginRight:8 }}>
                  {[["plan","📋 Rx"],["card","💊 Medicine Card"]].map(([id,label])=>(
                    <button key={id} onClick={()=>setPlanView(id)} style={{ padding:"3px 8px", fontSize:9, fontWeight:700, border:"none", borderRadius:4, cursor:"pointer",
                      background:planView===id?"white":"transparent", color:planView===id?"#2563eb":"#64748b",
                      boxShadow:planView===id?"0 1px 2px rgba(0,0,0,.1)":"none" }}>{label}</button>
                  ))}
                </div>
                <button className="no-print" onClick={copyPlanToClipboard}'''
    c = c.replace(old_buttons, toggle_btns, 1)
    changes += 1
    print("2. Plan/Card toggle: OK")
else:
    print("2. Toggle buttons: FAILED")

# ═══ 3. Replace external meds block with reconcile version ═══
# Find start and end of external meds block
ext_start = '                {/* ═══ External Consultant Medications ═══ */}'
ext_end_marker = '                {/* Lifestyle */}'

idx_start = c.find(ext_start)
idx_end = c.find(ext_end_marker, idx_start) if idx_start > 0 else -1

if idx_start > 0 and idx_end > idx_start:
    new_ext_block = '''                {/* ═══ External Consultant Medications with Reconciliation ═══ */}
                {(() => {
                  if (!patientFullData?.medications || !patientFullData?.consultations) return null;
                  const currentMedNames = new Set(sa(conData,"medications_confirmed").map(m=>(m.name||"").toUpperCase().replace(/[^A-Z]/g,"")));
                  const conMap = {};
                  (patientFullData.consultations||[]).forEach(con => { conMap[con.id] = con; });
                  const giniDoctors = ["bhansali","khetarpal","beant","rahul","bansali"];
                  const extMeds = (patientFullData.medications||[]).filter(m => {
                    if (!m.is_active) return false;
                    const key = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
                    if (key.length <= 1 || currentMedNames.has(key)) return false;
                    const con = conMap[m.consultation_id] || {};
                    const docName = (con.con_name||con.mo_name||"").toLowerCase();
                    return !giniDoctors.some(gd => docName.includes(gd));
                  });
                  if (extMeds.length === 0) return null;
                  const groups = {};
                  extMeds.forEach(m => {
                    const con = conMap[m.consultation_id] || {};
                    const _cd = typeof con.con_data === "string" ? (()=>{try{return JSON.parse(con.con_data);}catch(e){return {};}})() : (con.con_data||{});
                    const doctor = con.con_name || con.mo_name || "Unknown";
                    let _sp = _cd.specialty || con.visit_type || "";
                    let _hosp = _cd.hospital_name || _cd.hospital || "";
                    const key = doctor + "|||" + (con.visit_date||"");
                    if (!groups[key]) groups[key] = { doctor, date: con.visit_date, specialty: _sp, hospital: _hosp, meds: [] };
                    const dupKey = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
                    if (!groups[key].meds.find(x => (x.name||"").toUpperCase().replace(/[^A-Z]/g,"") === dupKey)) {
                      groups[key].meds.push(m);
                    }
                  });
                  const groupArr = Object.values(groups).filter(g => g.meds.length > 0);
                  if (groupArr.length === 0) return null;
                  const totalExt = groupArr.reduce((s,g) => s + g.meds.length, 0);
                  const getAction = (m) => extMedActions[(m.name||"").toUpperCase()] || "continue";
                  const stoppedMeds = extMeds.filter(m => getAction(m) === "stop");
                  const heldMeds = extMeds.filter(m => getAction(m) === "hold");
                  const fDate = (d) => { try { const s=String(d||""); const dt=s.length>=10?new Date(s.slice(0,10)+"T12:00:00"):new Date(s); return dt.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}); } catch(e) { return ""; } };
                  const actionColors = { continue:"#059669", hold:"#f59e0b", stop:"#dc2626" };
                  const actionIcons = { continue:"\\u2705", hold:"\\u23f8\\ufe0f", stop:"\\u274c" };
                  const actionLabels = { continue:"Continue", hold:"Hold", stop:"Stop" };
                  return (
                    <PlanBlock id="extmeds" title={"\\U0001f3e5 Medications by Other Consultants (" + totalExt + ")"} color="#92400e" hidden={planHidden.has("extmeds")} onToggle={()=>toggleBlock("extmeds")}>
                      <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:6, padding:"6px 10px", marginBottom:8, fontSize:10, color:"#92400e", lineHeight:1.5 }}>
                        <b>Note:</b> External consultant medications based on prescriptions provided by patient. Verified during this visit.
                      </div>
                      <div className="no-print" style={{ display:"flex", gap:6, marginBottom:8 }}>
                        <button onClick={()=>setShowReconcile(!showReconcile)}
                          style={{ padding:"4px 10px", background:showReconcile?"#7c3aed":"#f1f5f9", color:showReconcile?"white":"#64748b", border:"none", borderRadius:4, fontSize:10, fontWeight:700, cursor:"pointer" }}>
                          {showReconcile ? "Done" : "\\u2695\\ufe0f Reconcile"}
                        </button>
                        {!showReconcile && <button onClick={()=>{const all={};extMeds.forEach(m=>{all[(m.name||"").toUpperCase()]="continue";});setExtMedActions(prev=>({...prev,...all}));}}
                          style={{ padding:"4px 10px", background:"#059669", color:"white", border:"none", borderRadius:4, fontSize:10, fontWeight:700, cursor:"pointer" }}>
                          \\u2705 Confirm All Continue
                        </button>}
                      </div>
                      {groupArr.map((group, gi) => (
                        <div key={gi} style={{ marginBottom:8 }}>
                          <div style={{ fontSize:10, fontWeight:700, color:"#475569", padding:"3px 8px", background:"#f1f5f9", borderRadius:4, marginBottom:4, display:"flex", justifyContent:"space-between" }}>
                            <span>{group.doctor}{group.specialty ? " (" + group.specialty + ")" : ""}{group.date ? " \\u2014 " + fDate(group.date) : ""}</span>
                            {group.hospital && <span style={{ fontSize:9, color:"#7c3aed", fontWeight:600 }}>{group.hospital}</span>}
                          </div>
                          {group.meds.map((m, mi) => {
                            const mkey = (m.name||"").toUpperCase();
                            const action = extMedActions[mkey] || "continue";
                            return (
                              <div key={mi} style={{ display:"flex", alignItems:"center", gap:6, padding:"4px 8px", borderBottom:"1px solid #f1f5f9",
                                background: action==="stop"?"#fef2f2":action==="hold"?"#fffbeb":"white",
                                opacity: action==="stop"?0.6:1 }}>
                                <span style={{ fontSize:14, width:20 }}>{actionIcons[action]}</span>
                                <div style={{ flex:1 }}>
                                  <span style={{ fontWeight:700, fontSize:11, textDecoration:action==="stop"?"line-through":"none" }}>{m.name}</span>
                                  {m.composition && <span style={{ fontSize:9, color:"#94a3b8", marginLeft:4 }}>{m.composition}</span>}
                                </div>
                                <span style={{ fontSize:10, fontWeight:600, minWidth:50, textAlign:"center" }}>{m.dose||""}</span>
                                <span style={{ fontSize:10, color:"#1e40af", fontWeight:600, minWidth:70, textAlign:"center" }}>{m.timing||m.frequency||""}</span>
                                {showReconcile && (
                                  <div className="no-print" style={{ display:"flex", gap:2 }}>
                                    {["continue","hold","stop"].map(a => (
                                      <button key={a} onClick={()=>setExtMedActions(prev=>({...prev,[mkey]:a}))}
                                        style={{ padding:"2px 6px", borderRadius:4, fontSize:8, fontWeight:700, cursor:"pointer",
                                          background:action===a?actionColors[a]:"#f1f5f9", color:action===a?"white":"#64748b",
                                          border:action===a?"none":"1px solid #e2e8f0" }}>{actionLabels[a]}</button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                      {stoppedMeds.length > 0 && (
                        <div style={{ marginTop:8, padding:6, background:"#fef2f2", borderRadius:6, border:"1px solid #fecaca" }}>
                          <div style={{ fontSize:9, fontWeight:700, color:"#dc2626" }}>\\u274c STOPPED / COMPLETED</div>
                          {stoppedMeds.map((m,i) => {
                            const con = conMap[m.consultation_id]||{};
                            return <div key={i} style={{ fontSize:10, color:"#dc2626", textDecoration:"line-through", padding:"2px 0" }}>{m.name} ({con.con_name||"ext"})</div>;
                          })}
                        </div>
                      )}
                      {heldMeds.length > 0 && (
                        <div style={{ marginTop:6, padding:6, background:"#fffbeb", borderRadius:6, border:"1px solid #fde68a" }}>
                          <div style={{ fontSize:9, fontWeight:700, color:"#92400e" }}>\\u23f8\\ufe0f ON HOLD \\u2014 Discuss with prescribing doctor</div>
                          {heldMeds.map((m,i) => {
                            const con = conMap[m.consultation_id]||{};
                            const _cd2 = typeof con.con_data==="string"?(()=>{try{return JSON.parse(con.con_data)}catch(e){return{}}})():(con.con_data||{});
                            return <div key={i} style={{ fontSize:10, color:"#92400e", padding:"2px 0" }}>{m.name} \\u2014 {con.con_name||"ext"} ({_cd2.hospital_name||_cd2.hospital||""})</div>;
                          })}
                        </div>
                      )}
                    </PlanBlock>
                  );
                })()}

'''
    c = c[:idx_start] + new_ext_block + c[idx_end:]
    changes += 1
    print("3. Reconcile external meds: OK")
else:
    print("3. External meds block: FAILED", idx_start, idx_end)

# ═══ 4. Add Medicine Card view after plan footer, before Clinical Reasoning ═══
old_footer_end = '''                <div style={{ borderTop:"2px solid #1e293b", paddingTop:6, display:"flex", justifyContent:"space-between", fontSize:10, color:"#94a3b8" }}>
                  <div>{conName} | MO: {moName} | 📞 0172-4120100</div>
                  <div>Gini Clinical Scribe v1</div>
                </div>
              </div>
            </div>
          )}'''

if old_footer_end in c:
    medicine_card = '''                <div style={{ borderTop:"2px solid #1e293b", paddingTop:6, display:"flex", justifyContent:"space-between", fontSize:10, color:"#94a3b8" }}>
                  <div>{conName} | MO: {moName} | \\U0001f4de 0172-4120100</div>
                  <div>Gini Clinical Scribe v1</div>
                </div>
              </div>
            </div>
          )}

          {/* ═══ MEDICINE CARD VIEW ═══ */}
          {planView === "card" && conData && (() => {
            const gMeds = sa(conData,"medications_confirmed").map(m => ({
              ...m, source:"Gini", sourceLabel:"Dr. Bhansali (Gini)",
              times: guessTime(m.timing || m.frequency || "")
            }));
            const conMap2 = {};
            (patientFullData?.consultations||[]).forEach(con => { conMap2[con.id] = con; });
            const giniDocs = ["bhansali","khetarpal","beant","rahul","bansali"];
            const curNames = new Set(gMeds.map(m=>(m.name||"").toUpperCase().replace(/[^A-Z]/g,"")));
            const eMeds = (patientFullData?.medications||[]).filter(m => {
              if (!m.is_active) return false;
              const k = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
              if (k.length<=1 || curNames.has(k)) return false;
              const con = conMap2[m.consultation_id]||{};
              return !giniDocs.some(gd => (con.con_name||con.mo_name||"").toLowerCase().includes(gd));
            }).filter(m => (extMedActions[(m.name||"").toUpperCase()]||"continue") === "continue")
              .map(m => {
                const con = conMap2[m.consultation_id]||{};
                const _cd = typeof con.con_data==="string"?(()=>{try{return JSON.parse(con.con_data)}catch(e){return{}}})():(con.con_data||{});
                return { ...m, source:"external", sourceLabel:`${con.con_name||"ext"} (${_cd.hospital_name||_cd.hospital||""})`.replace(/\\(\\)/,""),
                  times: guessTime(m.timing || m.frequency || "") };
              });
            const stoppedExt = (patientFullData?.medications||[]).filter(m => {
              if (!m.is_active) return false;
              const k = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
              if (k.length<=1 || curNames.has(k)) return false;
              const con = conMap2[m.consultation_id]||{};
              if (giniDocs.some(gd => (con.con_name||con.mo_name||"").toLowerCase().includes(gd))) return false;
              return (extMedActions[(m.name||"").toUpperCase()]) === "stop";
            });
            const heldExt = (patientFullData?.medications||[]).filter(m => {
              if (!m.is_active) return false;
              const k = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
              if (k.length<=1 || curNames.has(k)) return false;
              const con = conMap2[m.consultation_id]||{};
              if (giniDocs.some(gd => (con.con_name||con.mo_name||"").toLowerCase().includes(gd))) return false;
              return (extMedActions[(m.name||"").toUpperCase()]) === "hold";
            });
            const allActive = [...gMeds, ...eMeds];
            const timeSlots = [
              { id:"wakeup", label:"\\U0001f305 Wake Up (Empty Stomach)", time:"6:00 AM" },
              { id:"morning", label:"\\U0001f305 Morning", time:"7:00 AM" },
              { id:"before_breakfast", label:"\\U0001f373 Before Breakfast (30 min)", time:"7:30 AM" },
              { id:"after_breakfast", label:"\\U0001f963 After Breakfast", time:"8:30 AM" },
              { id:"after_lunch", label:"\\U0001f35b After Lunch", time:"1:30 PM" },
              { id:"evening", label:"\\U0001f306 Evening", time:"5:00 PM" },
              { id:"after_dinner", label:"\\U0001f37d\\ufe0f After Dinner", time:"8:30 PM" },
              { id:"night_10pm", label:"\\U0001f319 Night (10 PM)", time:"10:00 PM" },
              { id:"bedtime", label:"\\U0001f6cf\\ufe0f Bedtime", time:"10:30 PM" },
              { id:"other", label:"\\U0001f4cb As Directed", time:"" },
            ];
            const medsByTime = {};
            timeSlots.forEach(slot => {
              const meds = allActive.filter(m => (m.times||[]).includes(slot.id));
              if (meds.length > 0) medsByTime[slot.id] = { ...slot, meds };
            });
            const ungrouped = allActive.filter(m => !m.times || m.times.length === 0);
            if (ungrouped.length > 0) {
              medsByTime["other"] = { ...timeSlots[timeSlots.length-1], meds: [...(medsByTime["other"]?.meds||[]), ...ungrouped] };
            }
            return (
              <div data-medicine-card>
                <div style={{ background:"linear-gradient(135deg,#1e293b,#334155)", borderRadius:12, padding:14, color:"white", marginBottom:10 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <div>
                      <div style={{ fontSize:14, fontWeight:800 }}>\\U0001f48a YOUR COMPLETE MEDICINE SCHEDULE</div>
                      <div style={{ fontSize:11, opacity:.7, marginTop:2 }}>{patient.name} | {patient.fileNo} | Updated: {new Date().toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})}</div>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:24, fontWeight:800 }}>{allActive.length}</div>
                      <div style={{ fontSize:9, opacity:.7 }}>Active Medicines</div>
                    </div>
                  </div>
                </div>
                {timeSlots.filter(slot => medsByTime[slot.id]).map(slot => {
                  const slotData = medsByTime[slot.id];
                  return (
                    <div key={slot.id} style={{ marginBottom:8, borderRadius:8, overflow:"hidden", border:"1px solid #e2e8f0" }}>
                      <div style={{ background:"#f8fafc", padding:"6px 12px", display:"flex", justifyContent:"space-between", borderBottom:"1px solid #e2e8f0" }}>
                        <span style={{ fontSize:12, fontWeight:700 }}>{slot.label}</span>
                        <span style={{ fontSize:10, color:"#64748b" }}>{slot.time}</span>
                      </div>
                      <div style={{ background:"white" }}>
                        {slotData.meds.map((m, i) => (
                          <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 12px", borderBottom:i<slotData.meds.length-1?"1px solid #f1f5f9":"none" }}>
                            <div style={{ width:18, height:18, borderRadius:4, border:"2px solid #cbd5e1", display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, flexShrink:0 }}>\\u2610</div>
                            <div style={{ flex:1 }}>
                              <div style={{ fontSize:12, fontWeight:700 }}>
                                {m.name}
                                {m.isNew && <span style={{ background:"#1e40af", color:"white", padding:"0 4px", borderRadius:3, fontSize:8, marginLeft:4 }}>NEW</span>}
                              </div>
                              <div style={{ fontSize:10, color:"#64748b" }}>
                                {m.dose||""} {m.frequency||""} \\u2014 {(m.forDiagnosis||[]).map(d => typeof d==="string"?d:d.label||"").join(", ")||""}
                              </div>
                            </div>
                            <span style={{ fontSize:8, padding:"2px 6px", borderRadius:4, fontWeight:600,
                              background:m.source==="external"?"#fef3c7":"#dbeafe",
                              color:m.source==="external"?"#92400e":"#2563eb" }}>
                              {m.source==="external"?m.sourceLabel:"Gini"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {stoppedExt.length > 0 && (
                  <div style={{ marginBottom:8, borderRadius:8, overflow:"hidden", border:"2px solid #fecaca" }}>
                    <div style={{ background:"#fef2f2", padding:"6px 12px", borderBottom:"1px solid #fecaca" }}>
                      <span style={{ fontSize:12, fontWeight:700, color:"#dc2626" }}>\\u274c STOPPED \\u2014 Do NOT Take</span>
                    </div>
                    <div style={{ background:"white", padding:8 }}>
                      {stoppedExt.map((m,i) => {
                        const con = conMap2[m.consultation_id]||{};
                        return <div key={i} style={{ fontSize:11, padding:"3px 0", textDecoration:"line-through", color:"#dc2626" }}>
                          {m.name} \\u2014 {m.dose||""} ({con.con_name||"ext"})
                        </div>;
                      })}
                    </div>
                  </div>
                )}
                {heldExt.length > 0 && (
                  <div style={{ marginBottom:8, borderRadius:8, overflow:"hidden", border:"2px solid #fde68a" }}>
                    <div style={{ background:"#fffbeb", padding:"6px 12px", borderBottom:"1px solid #fde68a" }}>
                      <span style={{ fontSize:12, fontWeight:700, color:"#92400e" }}>\\u23f8\\ufe0f ON HOLD \\u2014 Ask Doctor Before Restarting</span>
                    </div>
                    <div style={{ background:"white", padding:8 }}>
                      {heldExt.map((m,i) => {
                        const con = conMap2[m.consultation_id]||{};
                        const _cd3 = typeof con.con_data==="string"?(()=>{try{return JSON.parse(con.con_data)}catch(e){return{}}})():(con.con_data||{});
                        return <div key={i} style={{ fontSize:11, padding:"3px 0", color:"#92400e" }}>
                          {m.name} \\u2014 {m.dose||""} \\u2014 Discuss with {con.con_name||"ext"} ({_cd3.hospital_name||_cd3.hospital||""})
                        </div>;
                      })}
                    </div>
                  </div>
                )}
                <div style={{ background:"white", borderRadius:8, padding:10, border:"1px solid #e2e8f0", marginBottom:8 }}>
                  <div style={{ fontSize:11, fontWeight:700, marginBottom:6 }}>\\u26a0\\ufe0f IMPORTANT REMINDERS</div>
                  <div style={{ fontSize:10, lineHeight:1.8, color:"#374151" }}>
                    <div>\\u2022 \\U0001fa78 <b>If sugar below 70:</b> Eat 3 glucose tablets IMMEDIATELY, recheck in 15 min</div>
                    <div>\\u2022 \\U0001f4ca <b>Sugar diary:</b> Fasting daily + post-meal 3x/week</div>
                    <div>\\u2022 \\u26a0\\ufe0f <b>Before next visit:</b> Get fasting blood test, skip morning DM medicines that day</div>
                  </div>
                </div>
                {conData?.follow_up && (
                  <div style={{ background:"white", borderRadius:8, padding:10, border:"1px solid #e2e8f0", marginBottom:8 }}>
                    <div style={{ fontSize:11, fontWeight:700, marginBottom:6 }}>\\U0001f4c5 NEXT VISIT</div>
                    <div style={{ fontSize:14, fontWeight:800 }}>{conData.follow_up.duration||""}</div>
                    {conData.follow_up.date && <div style={{ fontSize:12, fontWeight:700, color:"#2563eb" }}>{(() => { const d = conData.follow_up.date; const dt = new Date(d); return isNaN(dt) ? d : dt.toLocaleDateString("en-IN",{weekday:"long",day:"2-digit",month:"short",year:"numeric"}); })()}</div>}
                    {conData.follow_up.instructions && <div style={{ fontSize:10, color:"#92400e", marginTop:4 }}>\\u26a0\\ufe0f {conData.follow_up.instructions}</div>}
                  </div>
                )}
                <div style={{ textAlign:"center", fontSize:9, color:"#94a3b8", padding:8 }}>
                  Medicine schedule prepared at Gini Advanced Care Hospital, Mohali. Verify with your doctor before changes. | \\U0001f4de 0172-4120100
                </div>
              </div>
            );
          })()}'''

    c = c.replace(old_footer_end, medicine_card, 1)
    changes += 1
    print("4. Medicine Card view: OK")
else:
    print("4. Medicine Card: FAILED - footer not found")

# ═══ 5. Add guessTime helper function ═══
# This maps timing strings to time slot IDs
guess_fn_anchor = '// Retry wrapper for Anthropic API'
if guess_fn_anchor in c and 'guessTime' not in c:
    guess_fn = '''// Map medication timing to time-of-day slots
const guessTime = (timing) => {
  const t = (timing||"").toLowerCase();
  const slots = [];
  if (/wake|empty.*stomach|thyro|levothyrox/i.test(t)) slots.push("wakeup");
  if (/morning|od(?![a-z])|once.*daily/i.test(t) && !slots.length) slots.push("morning");
  if (/before.*break|30.*min.*break|ac.*morning/i.test(t)) { slots.length=0; slots.push("before_breakfast"); }
  if (/after.*break|post.*break/i.test(t)) slots.push("after_breakfast");
  if (/after.*lunch|post.*lunch/i.test(t)) slots.push("after_lunch");
  if (/evening|eve/i.test(t)) slots.push("evening");
  if (/10.*pm|night(?!.*bed)/i.test(t)) slots.push("night_10pm");
  if (/after.*dinner|post.*dinner/i.test(t)) slots.push("after_dinner");
  if (/bedtime|hs(?![a-z])|bed/i.test(t)) slots.push("bedtime");
  if (/bd|twice/i.test(t) && slots.length < 2) {
    if (!slots.includes("after_breakfast")) slots.push("after_breakfast");
    if (!slots.includes("after_dinner")) slots.push("after_dinner");
  }
  if (/tds|thrice|3.*times/i.test(t)) {
    slots.length = 0;
    slots.push("after_breakfast", "after_lunch", "after_dinner");
  }
  if (/after.*meals/i.test(t) && slots.length === 0) {
    slots.push("after_breakfast", "after_dinner");
  }
  return slots;
};

// Retry wrapper for Anthropic API'''
    c = c.replace(guess_fn_anchor, guess_fn, 1)
    changes += 1
    print("5. guessTime helper: OK")
else:
    print("5. guessTime:", "EXISTS" if 'guessTime' in c else "FAILED")

# ═══ 6. Wrap plan content in planView conditional ═══
# Show plan content only when planView === "plan" (or always for now, card is separate)
# Actually the plan is always visible, card is an additional view below. Let me instead
# hide plan when card is selected
plan_content_start = '<div data-plan-content>'
if plan_content_start in c:
    c = c.replace(plan_content_start, '<div data-plan-content style={{display:planView==="plan"?"block":"none"}}>', 1)
    changes += 1
    print("6. Plan content conditional display: OK")
else:
    print("6. Plan content display: FAILED")

f=open(path,'w'); f.write(c); f.close()
print(f"\nDone. {changes} changes. Run: npm run build")
