import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()
f=open(path+'.bak11','w'); f.write(c); f.close()
print("Backup: App.jsx.bak11")

server_path = os.path.expanduser("~/Downloads/gini-scribe/server/index.js")
s=open(server_path,'r'); sv=s.read(); s.close()
s=open(server_path+'.bak11','w'); s.write(sv); s.close()
print("Backup: server/index.js.bak11")

changes = 0

# ═══════════════════════════════════════════════════
# FIX 1: Add API retry wrapper for 529 errors
# ═══════════════════════════════════════════════════
helper_anchor = 'const App = () => {'
if helper_anchor in c and 'retryAnthropicFetch' not in c:
    retry_fn = '''// Retry wrapper for Anthropic API (handles 529 overloaded)
const retryAnthropicFetch = async (url, options, maxRetries = 3) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await fetch(url, options);
    if (r.status === 529 && attempt < maxRetries) {
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
      continue;
    }
    return r;
  }
};

const App = () => {'''
    c = c.replace(helper_anchor, retry_fn, 1)
    changes += 1
    print("1a. Retry helper: OK")
else:
    print("1a. Retry helper:", "EXISTS" if 'retryAnthropicFetch' in c else "FAILED")

old_fetch = 'await fetch("https://api.anthropic.com/v1/messages",'
new_fetch = 'await retryAnthropicFetch("https://api.anthropic.com/v1/messages",'
count = c.count(old_fetch)
if count > 0:
    c = c.replace(old_fetch, new_fetch)
    changes += 1
    print(f"1b. Replaced {count} fetch->retryFetch: OK")
else:
    print("1b. Fetch replacement:", "DONE" if 'retryAnthropicFetch' in c else "FAILED")

# ═══════════════════════════════════════════════════
# FIX 2: Server - store specialty + hospital + create document
# ═══════════════════════════════════════════════════
old_srv_insert = '''      "INSERT INTO consultations (patient_id, visit_date, visit_type, con_name, status) VALUES ($1,$2,$3,$4,'historical') RETURNING id",
      [patientId, visit_date, n(visit_type)||"OPD", n(doctor_name)]'''

new_srv_insert = '''      "INSERT INTO consultations (patient_id, visit_date, visit_type, con_name, con_data, status) VALUES ($1,$2,$3,$4,$5,'historical') RETURNING id",
      [patientId, visit_date, n(visit_type)||"OPD", n(doctor_name), JSON.stringify({specialty: n(specialty), hospital_name: req.body.hospital_name || null})]'''

if old_srv_insert in sv:
    sv = sv.replace(old_srv_insert, new_srv_insert, 1)
    changes += 1
    print("2a. Server stores specialty/hospital: OK")
else:
    print("2a. Server INSERT:", "ALREADY DONE" if 'hospital_name' in sv[700:800] else "FAILED")

# Add document creation - find COMMIT after the history endpoint
# We need to insert before the COMMIT that follows the history INSERT
history_marker = "n(visit_type)||\"OPD\""
hist_idx = sv.find(history_marker)
if hist_idx > 0:
    commit_after = sv.find('await client.query("COMMIT")', hist_idx)
    if commit_after > 0 and 'doc_type, "prescription"' not in sv[hist_idx:commit_after+500]:
        doc_code = '''    // Auto-save as document record
    try {
      const docTitle = (n(doctor_name)||"External") + (n(specialty) ? " - "+n(specialty) : "") + " - " + visit_date;
      await client.query(
        `INSERT INTO documents (patient_id, consultation_id, doc_type, title, doc_date, source, extracted_data) VALUES ($1,$2,'prescription',$3,$4,$5,$6)`,
        [patientId, cid, docTitle, visit_date, req.body.hospital_name || "External", JSON.stringify({doctor:n(doctor_name), specialty:n(specialty), hospital:req.body.hospital_name, visit_date, diagnoses, medications, labs, vitals})]
      );
    } catch(de) { console.log("Doc save skip:", de.message); }

    '''
        sv = sv[:commit_after] + doc_code + sv[commit_after:]
        changes += 1
        print("2b. Server creates document record: OK")
    else:
        print("2b. Server document:", "EXISTS" if 'doc_type' in sv[hist_idx:hist_idx+2000] else "FAILED")
else:
    print("2b. Server history endpoint: NOT FOUND")

s=open(server_path,'w'); s.write(sv); s.close()
print("   Server saved.")

# ═══════════════════════════════════════════════════
# FIX 3: Extract specialty/hospital from con_data in external meds
# ═══════════════════════════════════════════════════
old_grp = '''                    const doctor = con.con_name || con.mo_name || "Unknown";
                    const key = doctor + "|||" + (con.visit_date||"");
                    if (!groups[key]) groups[key] = { doctor, date: con.visit_date, status: con.status, meds: [] };'''

new_grp = '''                    const doctor = con.con_name || con.mo_name || "Unknown";
                    const _cd = typeof con.con_data === "string" ? (()=>{try{return JSON.parse(con.con_data);}catch(e){return {};}})() : (con.con_data||{});
                    const key = doctor + "|||" + (con.visit_date||"");
                    if (!groups[key]) groups[key] = { doctor, date: con.visit_date, status: con.status, specialty: _cd.specialty||"", hospital: _cd.hospital_name||_cd.hospital||"", meds: [] };'''

if old_grp in c:
    c = c.replace(old_grp, new_grp, 1)
    changes += 1
    print("3a. Group build with specialty/hospital: OK")
else:
    print("3a. Group build: FAILED")

# Update the group header display
old_hdr = '''{group.doctor}{group.date ? " \\u2014 " + fDate(group.date) : ""}'''
new_hdr = '''{group.doctor}{group.specialty ? " (" + group.specialty + ")" : ""}{group.date ? " \\u2014 " + fDate(group.date) : ""}{group.hospital ? " \\u2014 " + group.hospital : ""}'''

if old_hdr in c:
    c = c.replace(old_hdr, new_hdr, 1)
    changes += 1
    print("3b. Header shows specialty/hospital: OK")
else:
    print("3b. Header display: FAILED")

# ═══════════════════════════════════════════════════
# FIX 4: External meds in text export + print save
# ═══════════════════════════════════════════════════
lifestyle_text = '    text += `\\nLIFESTYLE'
if lifestyle_text in c and 'MEDICATIONS BY OTHER CONSULTANTS' not in c:
    idx = c.find(lifestyle_text)
    ext_export = '''    // External consultant medications in text
    if (patientFullData?.medications) {
      const _curNames = new Set(sa(conData,"medications_confirmed").map(m=>(m.name||"").toUpperCase().replace(/[^A-Z]/g,"")));
      const _extM = (patientFullData.medications||[]).filter(m => {
        if (!m.is_active) return false;
        const k = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
        return k.length > 1 && !_curNames.has(k);
      });
      if (_extM.length > 0) {
        text += `\\nMEDICATIONS BY OTHER CONSULTANTS:\\n`;
        text += `(Based on copies of prescriptions provided by patient. Verify with patient.)\\n`;
        const _cMap = {};
        (patientFullData.consultations||[]).forEach(cn => { _cMap[cn.id] = cn; });
        _extM.forEach(m => {
          const _cn = _cMap[m.consultation_id] || {};
          const _cdt = typeof _cn.con_data==="string"?(()=>{try{return JSON.parse(_cn.con_data)}catch(e){return{}}})():(_cn.con_data||{});
          text += `- ${m.name} | ${m.dose||""} | ${m.frequency||""} ${m.timing||""} | By: ${_cn.con_name||"ext"}${_cdt.specialty?" ("+_cdt.specialty+")":""}${_cdt.hospital_name?" - "+_cdt.hospital_name:""}\\n`;
        });
      }
    }
'''
    c = c[:idx] + ext_export + c[idx:]
    changes += 1
    print("4a. Text export external meds: OK")
else:
    print("4a. Text export:", "EXISTS" if 'MEDICATIONS BY OTHER CONSULTANTS' in c else "FAILED")

# Add external meds to print/save document
old_print_meds = 'medications: conData.medications_confirmed || [],'
if old_print_meds in c:
    new_print_meds = '''medications: [...(conData.medications_confirmed || []), ...((patientFullData?.medications||[]).filter(m => {
            if (!m.is_active) return false;
            const _cn = new Set((conData.medications_confirmed||[]).map(x=>(x.name||"").toUpperCase().replace(/[^A-Z]/g,"")));
            return !_cn.has((m.name||"").toUpperCase().replace(/[^A-Z]/g,""));
          }).map(m => ({...m, _external:true})))],'''
    c = c.replace(old_print_meds, new_print_meds, 1)
    changes += 1
    print("4b. Print save includes external meds: OK")
else:
    print("4b. Print save: FAILED")

# ═══════════════════════════════════════════════════
# FIX 5: Add specialty + hospital to historyForm + saveHistoryEntry
# ═══════════════════════════════════════════════════
# Add fields to historyForm default state
old_hist_state = 'doctor_name:"", visit_date:""'
if old_hist_state in c:
    new_hist_state = 'doctor_name:"", specialty:"", hospital_name:"", visit_date:""'
    c = c.replace(old_hist_state, new_hist_state, 1)
    changes += 1
    print("5a. HistoryForm state: OK")
else:
    # Try alternate patterns
    alt1 = "doctor_name:'', visit_date:''"
    alt2 = 'doctor_name: "", visit_date: ""'
    if alt1 in c:
        c = c.replace(alt1, "doctor_name:'', specialty:'', hospital_name:'', visit_date:''", 1)
        changes += 1
        print("5a. HistoryForm state (alt): OK")
    elif alt2 in c:
        c = c.replace(alt2, 'doctor_name: "", specialty: "", hospital_name: "", visit_date: ""', 1)
        changes += 1
        print("5a. HistoryForm state (alt2): OK")
    else:
        print("5a. HistoryForm state: FAILED - searching...")
        idx = c.find('historyForm')
        if idx > 0:
            print("   Context:", repr(c[idx:idx+120]))

# Add specialty + hospital to the API body in saveHistoryEntry
old_body = 'doctor_name: historyForm.doctor_name'
if old_body in c:
    new_body = 'doctor_name: historyForm.doctor_name,\n          specialty: historyForm.specialty || "",\n          hospital_name: historyForm.hospital_name || ""'
    c = c.replace(old_body, new_body, 1)
    changes += 1
    print("5b. saveHistoryEntry sends specialty/hospital: OK")
else:
    # Check if it uses a different pattern
    alt_body = 'doctor_name:historyForm.doctor_name'
    if alt_body in c:
        new_alt = 'doctor_name:historyForm.doctor_name,\n          specialty:historyForm.specialty||"",\n          hospital_name:historyForm.hospital_name||""'
        c = c.replace(alt_body, new_alt, 1)
        changes += 1
        print("5b. saveHistoryEntry (alt): OK")
    else:
        print("5b. saveHistoryEntry body: FAILED - searching...")
        idx = c.find('saveHistoryEntry')
        if idx > 0:
            chunk = c[idx:idx+500]
            doctor_idx = chunk.find('doctor_name')
            if doctor_idx > 0:
                print("   Context:", repr(chunk[doctor_idx:doctor_idx+60]))

# ═══════════════════════════════════════════════════
# FIX 6: Add UI inputs for specialty + hospital in history form
# ═══════════════════════════════════════════════════
# Find the doctor_name input in history tab and add specialty + hospital after it
old_doctor_input = 'placeholder="Doctor name" value={historyForm.doctor_name}'
if old_doctor_input in c:
    new_doctor_input = '''placeholder="Doctor name" value={historyForm.doctor_name}'''
    # Find the closing /> of this input
    pos = c.find(old_doctor_input)
    # Find the end of this input's line (next newline)
    end_of_line = c.find('\n', pos)
    if end_of_line > 0:
        # Insert specialty + hospital inputs after the doctor name line
        extra_inputs = '''
                    <input placeholder="Specialty (e.g. Cardiology)" value={historyForm.specialty||""} onChange={e=>setHistoryForm(p=>({...p,specialty:e.target.value}))}
                      style={{ flex:1, minWidth:100, padding:"6px 8px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:11 }} />
                    <input placeholder="Hospital (e.g. Fortis, Mohali)" value={historyForm.hospital_name||""} onChange={e=>setHistoryForm(p=>({...p,hospital_name:e.target.value}))}
                      style={{ flex:1, minWidth:100, padding:"6px 8px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:11 }} />'''
        c = c[:end_of_line] + extra_inputs + c[end_of_line:]
        changes += 1
        print("6. Specialty + Hospital inputs in form: OK")
    else:
        print("6. Form inputs: Could not find line end")
else:
    print("6. Form inputs: FAILED - searching for doctor input...")
    # Check alt patterns
    alts = ['placeholder="Doctor name"', 'Doctor name', 'doctor_name}']
    for a in alts:
        if a in c:
            pos = c.find(a)
            print(f"   Found '{a}' at pos {pos}")
            print(f"   Context: {repr(c[pos:pos+80])}")
            break

# Also fill specialty/hospital from prescription extraction
old_extract_fill = 'doctor_name: rx.doctor_name'
if old_extract_fill in c:
    new_extract_fill = 'doctor_name: rx.doctor_name, specialty: rx.specialty||"", hospital_name: rx.hospital_name||rx.hospital||""'
    c = c.replace(old_extract_fill, new_extract_fill, 1)
    changes += 1
    print("7. Rx extraction fills specialty/hospital: OK")
else:
    print("7. Rx extraction fill: SKIPPED (not found)")

f=open(path,'w'); f.write(c); f.close()
print(f"\nDone. {changes} changes applied.")
print("Run: npm run build")
print("Then: git add . && git commit -m 'fix: specialty/hospital, docs, text export, retry' && git push")
