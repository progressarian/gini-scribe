import os

# ═══ SERVER FIX: labs endpoint include source ═══
spath = os.path.expanduser("~/Downloads/gini-scribe/server/index.js")
f=open(spath,'r'); s=f.read(); f.close()
f=open(spath+'.bak12','w'); f.write(s); f.close()
print("Server backup: index.js.bak12")
sc = 0

# Fix 1: Add source to individual labs POST
old_lab_insert = '''    const { test_name, result, unit, flag, ref_range, test_date, consultation_id } = req.body;
    const r = await pool.query(
      `INSERT INTO lab_results (patient_id, consultation_id, test_name, result, unit, flag, ref_range, test_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, n(consultation_id), test_name, result, n(unit), n(flag)||"N", n(ref_range), n(test_date)||new Date().toISOString().split("T")[0]]'''

new_lab_insert = '''    const { test_name, result, unit, flag, ref_range, test_date, consultation_id, source } = req.body;
    const r = await pool.query(
      `INSERT INTO lab_results (patient_id, consultation_id, test_name, result, unit, flag, ref_range, test_date, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, n(consultation_id), test_name, result, n(unit), n(flag)||"N", n(ref_range), n(test_date)||new Date().toISOString().split("T")[0], n(source)||null]'''

if old_lab_insert in s:
    s = s.replace(old_lab_insert, new_lab_insert, 1)
    sc += 1
    print("S1. Labs POST includes source: OK")
else:
    print("S1. Labs POST: FAILED")

# Fix 2: Add extracted_data to documents SELECT (ensure it's there)
old_doc_sel = 'SELECT id, doc_type, title, file_name, doc_date, source, notes, extracted_data, storage_path, consultation_id, created_at FROM documents'
if old_doc_sel in s:
    print("S2. Documents SELECT already has extracted_data: OK (no change needed)")
    sc += 1
else:
    print("S2. Documents SELECT: checking...")
    if 'extracted_data' in s.split('FROM documents')[0] if 'FROM documents' in s else False:
        print("   Already present somewhere")

f=open(spath,'w'); f.write(s); f.close()
print(f"Server: {sc} changes")

# ═══ CLIENT FIXES ═══
cpath = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(cpath,'r'); c=f.read(); f.close()
f=open(cpath+'.bak16','w'); f.write(c); f.close()
print("\nClient backup: App.jsx.bak16")
cc = 0

# ═══ C1: Enhance documents tab to show extracted data ═══
old_doc_display = '''                  {patientFullData.documents.slice(0,10).map(doc => (
                    <div key={doc.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"4px 8px", borderBottom:"1px solid #f1f5f9", fontSize:11 }}>
                      <span>{doc.doc_type==="lab_report"?"🔬":doc.doc_type==="prescription"?"📄":"🩻"}</span>
                      <span style={{ flex:1 }}>{doc.title||doc.doc_type}</span>
                      {doc.doc_date && <span style={{ fontSize:9, color:"#64748b" }}>{(()=>{const d=new Date(String(doc.doc_date).slice(0,10)+"T12:00:00");return d.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"2-digit"});})()}</span>}
                      {doc.storage_path && <button onClick={()=>viewDocumentFile(doc.id)} style={{ fontSize:8, background:"#2563eb", color:"white", border:"none", padding:"2px 6px", borderRadius:3, cursor:"pointer", fontWeight:600 }}>📄 View</button>}
                      <span style={{ fontSize:8, color:"#94a3b8" }}>{doc.source||""}</span>
                    </div>
                  ))}'''

new_doc_display = '''                  {patientFullData.documents.slice(0,15).map(doc => {
                    const _ext = doc.extracted_data ? (typeof doc.extracted_data==="string" ? (()=>{try{return JSON.parse(doc.extracted_data)}catch(e){return null}})() : doc.extracted_data) : null;
                    const _meds = _ext?.medications?.length||0;
                    const _labs = _ext?.labs?.length||0;
                    const _diags = _ext?.diagnoses?.length||0;
                    const catIcon = ["lab_report","blood_test","thyroid","lipid","kidney","hba1c","urine"].includes(doc.doc_type)?"🔬":doc.doc_type==="prescription"?"💊":["xray","usg","mri","dexa","ecg","ncs","eye"].includes(doc.doc_type)?"🩻":"📄";
                    const isNew = doc.created_at && (Date.now()-new Date(doc.created_at).getTime())<24*60*60*1000;
                    return (
                    <div key={doc.id} style={{ padding:"6px 8px", borderBottom:"1px solid #f1f5f9", background:isNew?"#eff6ff":"white" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:11 }}>
                        <span style={{ fontSize:14 }}>{catIcon}</span>
                        <div style={{ flex:1 }}>
                          <div style={{ fontWeight:700 }}>
                            {doc.title||doc.doc_type}
                            {isNew && <span style={{ background:"#dc2626", color:"white", padding:"0 4px", borderRadius:3, fontSize:7, marginLeft:4, fontWeight:800 }}>NEW</span>}
                          </div>
                          <div style={{ fontSize:9, color:"#64748b" }}>{doc.source||""} • {doc.doc_date ? (()=>{const d=new Date(String(doc.doc_date).slice(0,10)+"T12:00:00");return d.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});})() : ""}</div>
                        </div>
                        {doc.storage_path && <button onClick={()=>viewDocumentFile(doc.id)} style={{ fontSize:8, background:"#2563eb", color:"white", border:"none", padding:"2px 6px", borderRadius:3, cursor:"pointer", fontWeight:600 }}>📄 View</button>}
                      </div>
                      {_ext && (_meds>0||_labs>0||_diags>0) && (
                        <div style={{ marginTop:4, marginLeft:22 }}>
                          <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
                            {_diags>0 && (_ext.diagnoses||[]).slice(0,4).map((d,i)=><span key={i} style={{ fontSize:8, background:"#fef3c7", color:"#92400e", padding:"1px 5px", borderRadius:3, fontWeight:600 }}>{typeof d==="string"?d:d.label||d.id||""}</span>)}
                            {_meds>0 && <span style={{ fontSize:8, background:"#dbeafe", color:"#2563eb", padding:"1px 5px", borderRadius:3, fontWeight:600 }}>💊 {_meds} meds</span>}
                            {_labs>0 && <span style={{ fontSize:8, background:"#dcfce7", color:"#059669", padding:"1px 5px", borderRadius:3, fontWeight:600 }}>🔬 {_labs} results</span>}
                          </div>
                          {_labs>0 && (
                            <div style={{ marginTop:3, display:"flex", flexWrap:"wrap", gap:2 }}>
                              {(_ext.labs||[]).slice(0,6).map((l,i)=>(
                                <span key={i} style={{ fontSize:8, padding:"1px 4px", borderRadius:2, fontWeight:600,
                                  background:l.flag==="HIGH"?"#fef2f2":l.flag==="LOW"?"#fffbeb":"#f0fdf4",
                                  color:l.flag==="HIGH"?"#dc2626":l.flag==="LOW"?"#f59e0b":"#059669" }}>
                                  {l.test_name}: {l.result}{l.unit?" "+l.unit:""}
                                </span>
                              ))}
                              {(_ext.labs||[]).length>6 && <span style={{ fontSize:8, color:"#94a3b8" }}>+{(_ext.labs||[]).length-6} more</span>}
                            </div>
                          )}
                          {_meds>0 && (
                            <div style={{ marginTop:3, display:"flex", flexWrap:"wrap", gap:2 }}>
                              {(_ext.medications||[]).slice(0,4).map((m,i)=>(
                                <span key={i} style={{ fontSize:8, background:"#eff6ff", color:"#1e40af", padding:"1px 4px", borderRadius:2, fontWeight:600 }}>{m.name} {m.dose||""}</span>
                              ))}
                              {(_ext.medications||[]).length>4 && <span style={{ fontSize:8, color:"#94a3b8" }}>+{(_ext.medications||[]).length-4} more</span>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>);
                  })}'''

if old_doc_display in c:
    c = c.replace(old_doc_display, new_doc_display, 1)
    cc += 1
    print("C1. Enhanced document display: OK")
else:
    print("C1. Document display: FAILED")

# ═══ C2: Add "New Data" alert banner at top of MO tab ═══
# Find the MO tab content start
# Look for the MO complaints/vitals section
mo_tab_marker = '{tab==="mo" && ('
if mo_tab_marker in c:
    # Find the first div after the MO tab check
    idx = c.find(mo_tab_marker)
    # Find the opening of content after the tab check
    # We need to insert alert after the MO section starts
    # Let's find a good anchor point
    pass

# Let's find the MO tab content more precisely
mo_content_markers = [
    'Chief Complaints',
    'moData?.complaints',
]
mo_anchor = None
for marker in mo_content_markers:
    if marker in c:
        mi = c.find(marker)
        # Go backwards to find a good insertion point
        # Find the nearest <div that contains the MO content
        print(f"  Found MO marker '{marker}' at {mi}")
        mo_anchor = marker
        break

# Alternative: insert alert before the first content in MO tab
# Find: the MO brief / vitals area 
# Instead let's add it to the top of the plan tab and MO tab as a floating banner
# This is simpler and more visible

# ═══ C2: Add new data alert computed from patientFullData ═══
# Add a computed variable after patientFullData is used

old_plan_start = '<div data-plan-content style={{display:planView==="plan"?"block":"none"}}>'
if old_plan_start in c:
    new_plan_alert = '''<div data-plan-content style={{display:planView==="plan"?"block":"none"}}>
              {/* New data alert */}
              {(() => {
                const newDocs = (patientFullData?.documents||[]).filter(d => d.created_at && (Date.now()-new Date(d.created_at).getTime()) < 24*60*60*1000);
                const newLabs = (patientFullData?.lab_results||[]).filter(l => l.created_at && (Date.now()-new Date(l.created_at).getTime()) < 24*60*60*1000);
                const companionDocs = newDocs.filter(d => (d.source||"").toLowerCase().includes("companion"));
                if (newDocs.length === 0 && newLabs.length === 0) return null;
                return (
                  <div className="no-print" style={{ background:"linear-gradient(135deg,#eff6ff,#f0fdf4)", border:"2px solid #60a5fa", borderRadius:8, padding:"8px 12px", marginBottom:10, animation:"pulse 2s 3" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontSize:16 }}>📸</span>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:11, fontWeight:800, color:"#1e40af" }}>New Data Available</div>
                        <div style={{ fontSize:10, color:"#475569" }}>
                          {newDocs.length > 0 && <span>{newDocs.length} new document{newDocs.length>1?"s":""} </span>}
                          {newLabs.length > 0 && <span>• {newLabs.length} new lab result{newLabs.length>1?"s":""} </span>}
                          {companionDocs.length > 0 && <span>• via Companion</span>}
                        </div>
                      </div>
                      <button onClick={()=>setTab("docs")} style={{ fontSize:9, background:"#2563eb", color:"white", border:"none", padding:"4px 8px", borderRadius:4, fontWeight:700, cursor:"pointer" }}>View</button>
                    </div>
                  </div>
                );
              })()}'''
    c = c.replace(old_plan_start, new_plan_alert, 1)
    cc += 1
    print("C2. New data alert on Plan tab: OK")
else:
    print("C2. Plan alert: FAILED")

# ═══ C3: Add alert on MO tab ═══
# Find the MO tab's first meaningful content
old_mo_vitals = '          {tab==="mo" && ('
if old_mo_vitals in c:
    # Count occurrences to make sure we get the right one
    idx_mo = c.find(old_mo_vitals)
    if idx_mo > 0:
        # Find the next <div after this
        next_div = c.find('<div', idx_mo + len(old_mo_vitals))
        # Find the end of that opening div tag
        if next_div > 0:
            div_end = c.find('>', next_div)
            insert_point = div_end + 1
            alert_html = '''
              {/* New data alert */}
              {(() => {
                const nd = (patientFullData?.documents||[]).filter(d => d.created_at && (Date.now()-new Date(d.created_at).getTime()) < 24*60*60*1000);
                const nl = (patientFullData?.lab_results||[]).filter(l => l.created_at && (Date.now()-new Date(l.created_at).getTime()) < 24*60*60*1000);
                if (nd.length === 0 && nl.length === 0) return null;
                return (
                  <div className="no-print" style={{ background:"#eff6ff", border:"1px solid #93c5fd", borderRadius:8, padding:"6px 10px", marginBottom:8 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span>📸</span>
                      <span style={{ fontSize:10, fontWeight:700, color:"#1e40af" }}>{nd.length} new doc{nd.length!==1?"s":""}{nl.length>0?`, ${nl.length} new lab${nl.length!==1?"s":""}`:""} added today</span>
                      <button onClick={()=>setTab("docs")} style={{ marginLeft:"auto", fontSize:8, background:"#2563eb", color:"white", border:"none", padding:"2px 6px", borderRadius:3, fontWeight:700, cursor:"pointer" }}>View</button>
                    </div>
                  </div>
                );
              })()}'''
            c = c[:insert_point] + alert_html + c[insert_point:]
            cc += 1
            print("C3. New data alert on MO tab: OK")
        else:
            print("C3. MO alert: FAILED (no div end)")
    else:
        print("C3. MO alert: FAILED (no MO tab)")
else:
    print("C3. MO tab: FAILED")

# ═══ C4: Include new docs/labs in AI brief context ═══
# Find where labs context is built for the AI
old_lab_context = 'const recent = patientFullData.lab_results.slice(0,15).map(l=>`${l.test_name}: ${l.result} ${l.unit||""} (${l.test_date||""})`);\n'
if old_lab_context in c:
    new_lab_context = '''const recent = patientFullData.lab_results.slice(0,15).map(l=>`${l.test_name}: ${l.result} ${l.unit||""} (${l.test_date||""})`);
      // Include extracted data from companion-uploaded documents
      const companionLabs = [];
      (patientFullData.documents||[]).forEach(doc => {
        const ext = doc.extracted_data ? (typeof doc.extracted_data==="string" ? (()=>{try{return JSON.parse(doc.extracted_data)}catch(e){return null}})() : doc.extracted_data) : null;
        if (ext?.labs) ext.labs.forEach(l => companionLabs.push(`${l.test_name}: ${l.result} ${l.unit||""} (from ${doc.source||"external"}, ${doc.doc_date||""})`));
      });
      if (companionLabs.length > 0) recent.push("--- From uploaded documents ---", ...companionLabs.slice(0,10));
'''
    c = c.replace(old_lab_context, new_lab_context, 1)
    cc += 1
    print("C4. AI brief includes companion labs: OK")
else:
    print("C4. AI lab context: FAILED")
    # Try alternate
    alt = 'patientFullData.lab_results.slice(0,15).map(l=>'
    if alt in c:
        idx2 = c.find(alt)
        print(f"   Found alt at {idx2}")

# ═══ C5: Add new data alert on Consultant tab ═══
old_con_tab = '          {tab==="consultant" && ('
if old_con_tab in c:
    idx_con = c.find(old_con_tab)
    if idx_con > 0:
        next_div2 = c.find('<div', idx_con + len(old_con_tab))
        if next_div2 > 0:
            div_end2 = c.find('>', next_div2)
            insert_point2 = div_end2 + 1
            alert_con = '''
              {/* New data alert */}
              {(() => {
                const nd2 = (patientFullData?.documents||[]).filter(d => d.created_at && (Date.now()-new Date(d.created_at).getTime()) < 24*60*60*1000);
                const nl2 = (patientFullData?.lab_results||[]).filter(l => l.created_at && (Date.now()-new Date(l.created_at).getTime()) < 24*60*60*1000);
                if (nd2.length === 0 && nl2.length === 0) return null;
                const extSummary = [];
                nd2.forEach(d => {
                  const ext = d.extracted_data ? (typeof d.extracted_data==="string" ? (()=>{try{return JSON.parse(d.extracted_data)}catch(e){return null}})() : d.extracted_data) : null;
                  if (ext?.labs?.length) extSummary.push(...ext.labs.slice(0,3).map(l => `${l.test_name}: ${l.result}${l.flag==="HIGH"?" ⬆":""}${l.flag==="LOW"?" ⬇":""}`));
                  if (ext?.medications?.length) extSummary.push(`${ext.medications.length} meds from ${d.title||"external"}`);
                });
                return (
                  <div className="no-print" style={{ background:"linear-gradient(135deg,#eff6ff,#fef3c7)", border:"2px solid #60a5fa", borderRadius:8, padding:"8px 12px", marginBottom:10 }}>
                    <div style={{ fontSize:11, fontWeight:800, color:"#1e40af", marginBottom:2 }}>📸 New Data Added Today</div>
                    <div style={{ fontSize:10, color:"#475569" }}>
                      {nd2.length} document{nd2.length>1?"s":""}{nl2.length>0?`, ${nl2.length} lab result${nl2.length>1?"s":""}`:""} uploaded via Companion
                    </div>
                    {extSummary.length > 0 && (
                      <div style={{ display:"flex", flexWrap:"wrap", gap:3, marginTop:4 }}>
                        {extSummary.slice(0,8).map((s,i) => <span key={i} style={{ fontSize:8, background:"white", border:"1px solid #e2e8f0", padding:"1px 5px", borderRadius:3, fontWeight:600, color:"#374151" }}>{s}</span>)}
                      </div>
                    )}
                    <button onClick={()=>setTab("docs")} style={{ marginTop:6, fontSize:9, background:"#2563eb", color:"white", border:"none", padding:"3px 8px", borderRadius:4, fontWeight:700, cursor:"pointer" }}>📎 View All Documents</button>
                  </div>
                );
              })()}'''
            c = c[:insert_point2] + alert_con + c[insert_point2:]
            cc += 1
            print("C5. New data alert on Consultant tab: OK")
        else:
            print("C5. Con alert: FAILED (no div)")
    else:
        print("C5. Con tab: FAILED")
else:
    print("C5. Con tab marker: FAILED")

f=open(cpath,'w'); f.write(c); f.close()
print(f"\nClient: {cc} changes")
print(f"Total: {sc + cc} changes. Run: npm run build")
