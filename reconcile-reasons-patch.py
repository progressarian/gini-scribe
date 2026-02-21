import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()
f=open(path+'.bak15','w'); f.write(c); f.close()
print("Backup: App.jsx.bak15")
changes = 0

# ═══ 1. Add state for reconcile reasons + active reason picker ═══
old_state = 'const [extMedActions, setExtMedActions] = useState({});'
new_state = '''const [extMedActions, setExtMedActions] = useState({});
  const [extMedReasons, setExtMedReasons] = useState({});
  const [activeReasonPicker, setActiveReasonPicker] = useState(null);'''
if old_state in c:
    c = c.replace(old_state, new_state, 1)
    changes += 1
    print("1. Reason states: OK")
else:
    print("1. Reason states: FAILED")

# ═══ 2. Replace the reconcile action buttons with version that shows reason picker ═══
# Find the reconcile buttons per med
old_reconcile_buttons = '''                                {showReconcile && (
                                  <div className="no-print" style={{ display:"flex", gap:2 }}>
                                    {["continue","hold","stop"].map(a => (
                                      <button key={a} onClick={()=>setExtMedActions(prev=>({...prev,[mkey]:a}))}
                                        style={{ padding:"2px 6px", borderRadius:4, fontSize:8, fontWeight:700, cursor:"pointer",
                                          background:action===a?actionColors[a]:"#f1f5f9", color:action===a?"white":"#64748b",
                                          border:action===a?"none":"1px solid #e2e8f0" }}>{actionLabels[a]}</button>
                                    ))}
                                  </div>
                                )}'''

new_reconcile_buttons = '''                                {showReconcile && (
                                  <div className="no-print" style={{ display:"flex", gap:2, alignItems:"center" }}>
                                    {["continue","hold","stop"].map(a => (
                                      <button key={a} onClick={()=>{
                                        if (a==="continue") { setExtMedActions(prev=>({...prev,[mkey]:a})); setActiveReasonPicker(null); setExtMedReasons(prev=>{const n={...prev};delete n[mkey];return n;}); }
                                        else { setExtMedActions(prev=>({...prev,[mkey]:a})); setActiveReasonPicker(mkey); }
                                      }}
                                        style={{ padding:"2px 6px", borderRadius:4, fontSize:8, fontWeight:700, cursor:"pointer",
                                          background:action===a?actionColors[a]:"#f1f5f9", color:action===a?"white":"#64748b",
                                          border:action===a?"none":"1px solid #e2e8f0" }}>{actionLabels[a]}</button>
                                    ))}
                                    {extMedReasons[mkey] && <span style={{ fontSize:8, color:"#64748b", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={extMedReasons[mkey]}>💬 {extMedReasons[mkey]}</span>}
                                  </div>
                                )}'''

if old_reconcile_buttons in c:
    c = c.replace(old_reconcile_buttons, new_reconcile_buttons, 1)
    changes += 1
    print("2. Reconcile buttons with reason trigger: OK")
else:
    print("2. Reconcile buttons: FAILED")

# ═══ 3. Add reason picker popup after the med row, inside the group meds loop ═══
# Find the closing of each med row div and add reason picker after it
# The med rows end with </div> before the next iteration
# We need to add after the reconcile buttons div
old_med_row_end = '''                              </div>
                            );
                          })}
                        </div>
                      ))}'''

new_med_row_end = '''                              {/* Reason picker */}
                              {activeReasonPicker === mkey && (action === "stop" || action === "hold") && (
                                <div className="no-print" style={{ padding:"6px 8px", background:action==="stop"?"#fef2f2":"#fffbeb", borderTop:"1px dashed "+actionColors[action], marginTop:4 }}>
                                  <div style={{ fontSize:9, fontWeight:700, color:actionColors[action], marginBottom:4 }}>
                                    {action==="stop"?"Why stopping this medicine?":"Why putting on hold?"}
                                  </div>
                                  <div style={{ display:"flex", flexWrap:"wrap", gap:3, marginBottom:4 }}>
                                    {(action==="stop" ? [
                                      "Course completed",
                                      "No clinical benefit",
                                      "Side effects reported",
                                      "Replaced by Gini prescription",
                                      "Duplicate therapy",
                                      "Contraindicated with new medicine",
                                      "Not indicated for diagnosis",
                                      "Reducing pill burden",
                                      "Patient not tolerating",
                                      "Outdated prescription",
                                    ] : [
                                      "Discuss with prescribing doctor first",
                                      "Awaiting lab results",
                                      "Potential drug interaction",
                                      "Limited evidence for indication",
                                      "Monitor before continuing",
                                      "Dose adjustment needed",
                                      "Renal function concern",
                                      "Hepatic function concern",
                                      "Patient preference",
                                      "Temporary hold during illness",
                                    ]).map(reason => (
                                      <button key={reason} onClick={()=>{setExtMedReasons(prev=>({...prev,[mkey]:reason}));setActiveReasonPicker(null);}}
                                        style={{ padding:"3px 8px", borderRadius:4, fontSize:9, cursor:"pointer", fontWeight:600,
                                          background:extMedReasons[mkey]===reason?actionColors[action]:"white",
                                          color:extMedReasons[mkey]===reason?"white":"#374151",
                                          border:"1px solid "+(extMedReasons[mkey]===reason?actionColors[action]:"#d1d5db") }}>{reason}</button>
                                    ))}
                                  </div>
                                  <div style={{ display:"flex", gap:4 }}>
                                    <input placeholder="Other reason..." value={extMedReasons[mkey]&&![
                                      "Course completed","No clinical benefit","Side effects reported","Replaced by Gini prescription",
                                      "Duplicate therapy","Contraindicated with new medicine","Not indicated for diagnosis","Reducing pill burden",
                                      "Patient not tolerating","Outdated prescription",
                                      "Discuss with prescribing doctor first","Awaiting lab results","Potential drug interaction",
                                      "Limited evidence for indication","Monitor before continuing","Dose adjustment needed",
                                      "Renal function concern","Hepatic function concern","Patient preference","Temporary hold during illness"
                                    ].includes(extMedReasons[mkey]) ? extMedReasons[mkey] : ""}
                                      onChange={e=>setExtMedReasons(prev=>({...prev,[mkey]:e.target.value}))}
                                      onKeyDown={e=>{if(e.key==="Enter")setActiveReasonPicker(null);}}
                                      style={{ flex:1, padding:"4px 8px", border:"1px solid #d1d5db", borderRadius:4, fontSize:10 }} />
                                    <button onClick={()=>setActiveReasonPicker(null)}
                                      style={{ padding:"4px 8px", background:actionColors[action], color:"white", border:"none", borderRadius:4, fontSize:9, fontWeight:700, cursor:"pointer" }}>Done</button>
                                  </div>
                                </div>
                              )}
                              </div>
                            );
                          })}
                        </div>
                      ))}'''

if old_med_row_end in c:
    c = c.replace(old_med_row_end, new_med_row_end, 1)
    changes += 1
    print("3. Reason picker popup: OK")
else:
    print("3. Reason picker: FAILED - searching...")
    # Debug
    test = "                          })}\n                        </div>\n                      ))}"
    if test in c:
        idx = c.find(test)
        print(f"   Found similar at pos {idx}")
        print(f"   Context before:", repr(c[max(0,idx-100):idx]))

# ═══ 4. Show reasons on stopped/held meds sections ═══
old_stopped_display = '''                          {stoppedMeds.map((m,i) => {
                            const con = conMap[m.consultation_id]||{};
                            return <div key={i} style={{ fontSize:10, color:"#dc2626", textDecoration:"line-through", padding:"2px 0" }}>{m.name} ({con.con_name||"ext"})</div>;
                          })}'''

new_stopped_display = '''                          {stoppedMeds.map((m,i) => {
                            const con = conMap[m.consultation_id]||{};
                            const reason = extMedReasons[(m.name||"").toUpperCase()];
                            return <div key={i} style={{ fontSize:10, color:"#dc2626", padding:"2px 0" }}>
                              <span style={{ textDecoration:"line-through" }}>{m.name} ({con.con_name||"ext"})</span>
                              {reason && <span style={{ fontStyle:"italic", color:"#991b1b", marginLeft:4 }}>— {reason}</span>}
                            </div>;
                          })}'''

if old_stopped_display in c:
    c = c.replace(old_stopped_display, new_stopped_display, 1)
    changes += 1
    print("4a. Stopped reasons display: OK")
else:
    print("4a. Stopped display: FAILED")

old_held_display = '''                          {heldMeds.map((m,i) => {
                            const con = conMap[m.consultation_id]||{};
                            const _cd2 = typeof con.con_data==="string"?(()=>{try{return JSON.parse(con.con_data)}catch(e){return{}}})():(con.con_data||{});
                            return <div key={i} style={{ fontSize:10, color:"#92400e", padding:"2px 0" }}>{m.name} — {con.con_name||"ext"} ({_cd2.hospital_name||_cd2.hospital||""})</div>;
                          })}'''

new_held_display = '''                          {heldMeds.map((m,i) => {
                            const con = conMap[m.consultation_id]||{};
                            const _cd2 = typeof con.con_data==="string"?(()=>{try{return JSON.parse(con.con_data)}catch(e){return{}}})():(con.con_data||{});
                            const reason = extMedReasons[(m.name||"").toUpperCase()];
                            return <div key={i} style={{ fontSize:10, color:"#92400e", padding:"2px 0" }}>
                              {m.name} — {con.con_name||"ext"} ({_cd2.hospital_name||_cd2.hospital||""})
                              {reason && <span style={{ fontStyle:"italic", marginLeft:4 }}>— {reason}</span>}
                            </div>;
                          })}'''

if old_held_display in c:
    c = c.replace(old_held_display, new_held_display, 1)
    changes += 1
    print("4b. Held reasons display: OK")
else:
    print("4b. Held display: FAILED")

# ═══ 5. Add "Regenerate Summary" button after reconciliation ═══
# Find the "Done" button in reconcile controls
old_reconcile_controls = '''                        <button onClick={()=>setShowReconcile(!showReconcile)}
                          style={{ padding:"4px 10px", background:showReconcile?"#7c3aed":"#f1f5f9", color:showReconcile?"white":"#64748b", border:"none", borderRadius:4, fontSize:10, fontWeight:700, cursor:"pointer" }}>
                          {showReconcile ? "Done" : "⚕️ Reconcile"}
                        </button>'''

new_reconcile_controls = '''                        <button onClick={()=>setShowReconcile(!showReconcile)}
                          style={{ padding:"4px 10px", background:showReconcile?"#7c3aed":"#f1f5f9", color:showReconcile?"white":"#64748b", border:"none", borderRadius:4, fontSize:10, fontWeight:700, cursor:"pointer" }}>
                          {showReconcile ? "Done" : "⚕️ Reconcile"}
                        </button>
                        {Object.values(extMedActions).some(a=>a==="stop"||a==="hold") && !showReconcile && (
                          <button onClick={async()=>{
                            try {
                              const reconcileContext = Object.entries(extMedActions).filter(([k,v])=>v!=="continue").map(([k,v])=>{
                                const reason = extMedReasons[k]||"";
                                return `${k}: ${v.toUpperCase()}${reason?" — "+reason:""}`;
                              }).join("\\n");
                              const giniMedsList = sa(conData,"medications_confirmed").map(m=>`${m.name} ${m.dose||""} ${m.frequency||""}`).join(", ");
                              const prompt = `You are updating a patient-friendly treatment summary for ${patient.name||"the patient"}.

Current Gini medications: ${giniMedsList}

Medication reconciliation changes made today:
${reconcileContext}

Patient context: ${conData?.assessment_summary||""}

Write a warm, clear 4-5 line summary. Include:
1. Start with reassurance/good news about their progress
2. Mention key findings in simple words  
3. Explain what Gini prescribed and why (new medicines especially)
4. Explain which external medicines were stopped/held and WHY in patient-friendly language
5. Mention medicines being continued from other doctors
6. End with encouragement

Use simple language. Be specific about medicine names. Write as "Dear ${patient.name?patient.name.split(" ")[0]:"Patient"}:"
Return ONLY the summary text, no quotes or markdown.`;
                              const r = await retryAnthropicFetch("https://api.anthropic.com/v1/messages", {
                                method:"POST", headers:{"Content-Type":"application/json","x-api-key":window.__ANTHROPIC_KEY||localStorage.getItem("anthropic_key")||"","anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
                                body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:500,messages:[{role:"user",content:prompt}]})
                              });
                              if(!r.ok) throw new Error("API "+r.status);
                              const data = await r.json();
                              const newSummary = data.content?.[0]?.text||"";
                              if(newSummary) setConData(prev=>({...prev, assessment_summary:newSummary}));
                            } catch(e) { console.error("Summary regen:",e); alert("Could not regenerate: "+e.message); }
                          }}
                          style={{ padding:"4px 10px", background:"#2563eb", color:"white", border:"none", borderRadius:4, fontSize:10, fontWeight:700, cursor:"pointer" }}>
                            🔄 Update Summary
                          </button>
                        )}'''

if old_reconcile_controls in c:
    c = c.replace(old_reconcile_controls, new_reconcile_controls, 1)
    changes += 1
    print("5. Regenerate Summary button: OK")
else:
    print("5. Regenerate Summary: FAILED")

# ═══ 6. Include reconciliation data in the text export ═══
# Add after the external meds text export section
old_ext_text_end = '''          text += `- ${m.name} | ${m.dose||""} | ${m.frequency||""} ${m.timing||""} | By: ${_cn.con_name||"ext"}${_cdt.specialty?" ("+_cdt.specialty+")":""}${_cdt.hospital_name?" - "+_cdt.hospital_name:""}\\n`;
          });
        }
      }'''

new_ext_text_end = '''          text += `- ${m.name} | ${m.dose||""} | ${m.frequency||""} ${m.timing||""} | By: ${_cn.con_name||"ext"}${_cdt.specialty?" ("+_cdt.specialty+")":""}${_cdt.hospital_name?" - "+_cdt.hospital_name:""}`;
            const _act = extMedActions[(m.name||"").toUpperCase()];
            const _rsn = extMedReasons[(m.name||"").toUpperCase()];
            if (_act === "stop") text += ` [STOPPED${_rsn?" — "+_rsn:""}]`;
            else if (_act === "hold") text += ` [ON HOLD${_rsn?" — "+_rsn:""}]`;
            text += `\\n`;
          });
        }
      }'''

if old_ext_text_end in c:
    c = c.replace(old_ext_text_end, new_ext_text_end, 1)
    changes += 1
    print("6. Text export with reasons: OK")
else:
    print("6. Text export: FAILED")

# ═══ 7. Include reconciliation in print/save data ═══
old_print_ext = "...m, _external:true}"
new_print_ext = "...m, _external:true, _action:extMedActions[(m.name||'').toUpperCase()]||'continue', _reason:extMedReasons[(m.name||'').toUpperCase()]||''}"
if old_print_ext in c:
    c = c.replace(old_print_ext, new_print_ext, 1)
    changes += 1
    print("7. Print save with reasons: OK")
else:
    print("7. Print save: FAILED - checking...")
    if '_external:true' in c:
        idx = c.find('_external:true')
        print(f"   Found _external at {idx}: {repr(c[idx-10:idx+30])}")

# ═══ 8. Also show reasons on the Medicine Card stopped/held sections ═══
old_card_stopped = '''                      {stoppedExt.map((m,i) => {
                        const con = conMap2[m.consultation_id]||{};
                        return <div key={i} style={{ fontSize:11, padding:"3px 0", textDecoration:"line-through", color:"#dc2626" }}>
                          {m.name} — {m.dose||""} ({con.con_name||"ext"})
                        </div>;
                      })}'''

new_card_stopped = '''                      {stoppedExt.map((m,i) => {
                        const con = conMap2[m.consultation_id]||{};
                        const _rsn = extMedReasons[(m.name||"").toUpperCase()];
                        return <div key={i} style={{ fontSize:11, padding:"3px 0", color:"#dc2626" }}>
                          <span style={{ textDecoration:"line-through" }}>{m.name} — {m.dose||""} ({con.con_name||"ext"})</span>
                          {_rsn && <div style={{ fontSize:9, fontStyle:"italic", color:"#991b1b", marginLeft:20 }}>Reason: {_rsn}</div>}
                        </div>;
                      })}'''

if old_card_stopped in c:
    c = c.replace(old_card_stopped, new_card_stopped, 1)
    changes += 1
    print("8a. Card stopped reasons: OK")
else:
    print("8a. Card stopped: FAILED")

old_card_held = '''                      {heldExt.map((m,i) => {
                        const con = conMap2[m.consultation_id]||{};
                        const _cd3 = typeof con.con_data==="string"?(()=>{try{return JSON.parse(con.con_data)}catch(e){return{}}})():(con.con_data||{});
                        return <div key={i} style={{ fontSize:11, padding:"3px 0", color:"#92400e" }}>
                          {m.name} — {m.dose||""} — Discuss with {con.con_name||"ext"} ({_cd3.hospital_name||_cd3.hospital||""})
                        </div>;
                      })}'''

new_card_held = '''                      {heldExt.map((m,i) => {
                        const con = conMap2[m.consultation_id]||{};
                        const _cd3 = typeof con.con_data==="string"?(()=>{try{return JSON.parse(con.con_data)}catch(e){return{}}})():(con.con_data||{});
                        const _rsn = extMedReasons[(m.name||"").toUpperCase()];
                        return <div key={i} style={{ fontSize:11, padding:"3px 0", color:"#92400e" }}>
                          {m.name} — {m.dose||""} — Discuss with {con.con_name||"ext"} ({_cd3.hospital_name||_cd3.hospital||""})
                          {_rsn && <div style={{ fontSize:9, fontStyle:"italic", marginLeft:20 }}>Reason: {_rsn}</div>}
                        </div>;
                      })}'''

if old_card_held in c:
    c = c.replace(old_card_held, new_card_held, 1)
    changes += 1
    print("8b. Card held reasons: OK")
else:
    print("8b. Card held: FAILED")

f=open(path,'w'); f.write(c); f.close()
print(f"\nDone. {changes} changes. Run: npm run build")
