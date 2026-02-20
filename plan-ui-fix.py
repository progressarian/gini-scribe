import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()

# ═══ 1. Add follow-up date + instructions to the card UI ═══
old_fu_card = '''                      <div style={{ fontSize:8, color:"#64748b" }}>NEXT VISIT</div>
                      <div style={{ fontSize:18, fontWeight:800 }}><EditText value={getPlan("followup_dur", conData.follow_up.duration?.toUpperCase()||conData.follow_up.date||"")} onChange={v=>editPlan("followup_dur",v)} style={{ fontSize:18, fontWeight:800 }} /></div>'''

new_fu_card = '''                      <div style={{ fontSize:8, color:"#64748b" }}>NEXT VISIT</div>
                      <div style={{ fontSize:18, fontWeight:800 }}><EditText value={getPlan("followup_dur", conData.follow_up.duration?.toUpperCase()||"")} onChange={v=>editPlan("followup_dur",v)} style={{ fontSize:18, fontWeight:800 }} /></div>
                      {conData.follow_up.date && <div style={{ fontSize:12, fontWeight:700, color:"#1e40af", marginTop:2 }}>{"\U0001f4c5 "}{new Date(conData.follow_up.date+"T12:00:00").toLocaleDateString("en-IN",{weekday:"long",day:"2-digit",month:"short",year:"numeric"})}</div>}
                      {conData.follow_up.instructions && <div style={{ fontSize:11, color:"#475569", marginTop:4, padding:"4px 8px", background:"#fef3c7", borderRadius:4, border:"1px solid #fde68a" }}>{"\u26a0\ufe0f "}{conData.follow_up.instructions}</div>}'''

if old_fu_card in c:
    c = c.replace(old_fu_card, new_fu_card, 1)
    print("1. Follow-up date + instructions card: OK")
else:
    print("1. Follow-up date card: FAILED - pattern not found")

# ═══ 2. Add History section to the plan UI ═══
# Insert it after the Vitals block and before Goals
# Find the vitals PlanBlock closing
old_vitals_end = '''                {conData?.follow_up && <PlanBlock id="followup"'''

# Actually, let's put history right after conditions and before vitals
# Find where conditions block starts
old_conditions = '''                {conData?.follow_up && <PlanBlock id="followup"'''

# Better: insert history block before the Goals section
# Find the goals PlanBlock
goals_block = '<PlanBlock id="goals" title="\U0001f3af Your Health Goals"'
goals_idx = c.find(goals_block)
if goals_idx > 0:
    # Find the start of the line
    line_start = c.rfind('\n', max(0, goals_idx - 100), goals_idx) + 1
    
    history_block = '''                {moData?.history && (moData.history.family || moData.history.past_medical_surgical || moData.history.personal) && <PlanBlock id="history" title="\U0001f4d6 Patient History" color="#1e293b" hidden={planHidden.has("history")} onToggle={()=>toggleBlock("history")}>
                  <div style={{ display:"grid", gap:6 }}>
                    {moData.history.family && moData.history.family !== "NIL" && moData.history.family !== "-" && (
                      <div style={{ padding:"6px 10px", background:"#fef2f2", borderRadius:6, border:"1px solid #fecaca" }}>
                        <div style={{ fontSize:9, fontWeight:700, color:"#dc2626", marginBottom:2 }}>{"\U0001f468\u200d\U0001f469\u200d\U0001f467"} FAMILY HISTORY</div>
                        <div style={{ fontSize:11, color:"#1e293b" }}>{moData.history.family}</div>
                      </div>
                    )}
                    {moData.history.past_medical_surgical && moData.history.past_medical_surgical !== "NIL" && moData.history.past_medical_surgical !== "-" && (
                      <div style={{ padding:"6px 10px", background:"#f0f9ff", borderRadius:6, border:"1px solid #bae6fd" }}>
                        <div style={{ fontSize:9, fontWeight:700, color:"#0369a1", marginBottom:2 }}>{"\U0001f3e5"} PAST MEDICAL / SURGICAL</div>
                        <div style={{ fontSize:11, color:"#1e293b" }}>{moData.history.past_medical_surgical}</div>
                      </div>
                    )}
                    {moData.history.personal && moData.history.personal !== "NIL" && moData.history.personal !== "-" && (
                      <div style={{ padding:"6px 10px", background:"#f0fdf4", borderRadius:6, border:"1px solid #bbf7d0" }}>
                        <div style={{ fontSize:9, fontWeight:700, color:"#15803d", marginBottom:2 }}>{"\U0001f6ad"} PERSONAL</div>
                        <div style={{ fontSize:11, color:"#1e293b" }}>{moData.history.personal}</div>
                      </div>
                    )}
                    {moData.history.covid && (
                      <div style={{ padding:"6px 10px", background:"#faf5ff", borderRadius:6, border:"1px solid #e9d5ff" }}>
                        <div style={{ fontSize:9, fontWeight:700, color:"#7c3aed", marginBottom:2 }}>{"\U0001f9a0"} COVID / VACCINATION</div>
                        <div style={{ fontSize:11, color:"#1e293b" }}>{moData.history.covid}{moData.history.vaccination ? " | Vaccination: " + moData.history.vaccination : ""}</div>
                      </div>
                    )}
                  </div>
                </PlanBlock>}
'''
    c = c[:line_start] + history_block + c[line_start:]
    print("2. History card in plan: OK")
else:
    print("2. History card: FAILED - goals block not found")

f=open(path,'w'); f.write(c); f.close()
print("\nDone. Run: npm run build")
