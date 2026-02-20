import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()
f=open(path+'.bak13','w'); f.write(c); f.close()
print("Backup: App.jsx.bak13")
changes = 0

# ═══ FIX 1: Filter out Gini's own doctors from external meds ═══
# The external meds block currently only checks if med name is NOT in current prescription
# We need to ALSO exclude meds from Gini's own doctors (previous visits)

old_filter = '''                  const extMeds = (patientFullData.medications||[]).filter(m => {
                    if (!m.is_active) return false;
                    const key = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
                    return key.length > 1 && !currentMedNames.has(key);
                  });'''

new_filter = '''                  // Gini doctors list — meds from these doctors are NOT external
                  const giniDoctors = ["bhansali","khetarpal","beant","rahul","bansali"];
                  const extMeds = (patientFullData.medications||[]).filter(m => {
                    if (!m.is_active) return false;
                    const key = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
                    if (key.length <= 1 || currentMedNames.has(key)) return false;
                    // Exclude meds from Gini's own doctors
                    const con = conMap[(patientFullData.consultations||[]).find(c=>c.id===m.consultation_id)?.id] || {};
                    const docName = (con.con_name||con.mo_name||"").toLowerCase();
                    return !giniDoctors.some(gd => docName.includes(gd));
                  });'''

# But conMap is defined AFTER extMeds, so we need to move conMap up
# Let's restructure: move conMap before extMeds

old_block = '''                  const currentMedNames = new Set(sa(conData,"medications_confirmed").map(m=>(m.name||"").toUpperCase().replace(/[^A-Z]/g,"")));
                  const extMeds = (patientFullData.medications||[]).filter(m => {
                    if (!m.is_active) return false;
                    const key = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
                    return key.length > 1 && !currentMedNames.has(key);
                  });
                  if (extMeds.length === 0) return null;
                  const conMap = {};
                  (patientFullData.consultations||[]).forEach(con => { conMap[con.id] = con; });'''

new_block = '''                  const currentMedNames = new Set(sa(conData,"medications_confirmed").map(m=>(m.name||"").toUpperCase().replace(/[^A-Z]/g,"")));
                  const conMap = {};
                  (patientFullData.consultations||[]).forEach(con => { conMap[con.id] = con; });
                  // Gini doctors — their meds are NOT external
                  const giniDoctors = ["bhansali","khetarpal","beant","rahul","bansali"];
                  const extMeds = (patientFullData.medications||[]).filter(m => {
                    if (!m.is_active) return false;
                    const key = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
                    if (key.length <= 1 || currentMedNames.has(key)) return false;
                    const con = conMap[m.consultation_id] || {};
                    const docName = (con.con_name||con.mo_name||"").toLowerCase();
                    return !giniDoctors.some(gd => docName.includes(gd));
                  });
                  if (extMeds.length === 0) return null;'''

if old_block in c:
    c = c.replace(old_block, new_block, 1)
    changes += 1
    print("1. Filter out Gini doctors from external meds: OK")
else:
    print("1. External filter: FAILED - pattern not found")
    # Debug
    test = 'const extMeds = (patientFullData.medications||[]).filter'
    if test in c:
        idx = c.find(test)
        print("   Found extMeds at:", idx)
        print("   Context:", repr(c[idx-50:idx+200]))

# ═══ FIX 2: Auto-extract specialty from con_data or doctor name ═══
# Update group building to parse specialty from doctor name if not in con_data
old_grp_specialty = '''                    const _cd = typeof con.con_data === "string" ? (()=>{try{return JSON.parse(con.con_data);}catch(e){return {};}})() : (con.con_data||{});
                    const key = doctor + "|||" + (con.visit_date||"");
                    if (!groups[key]) groups[key] = { doctor, date: con.visit_date, status: con.status, specialty: _cd.specialty||"", hospital: _cd.hospital_name||_cd.hospital||"", meds: [] };'''

new_grp_specialty = '''                    const _cd = typeof con.con_data === "string" ? (()=>{try{return JSON.parse(con.con_data);}catch(e){return {};}})() : (con.con_data||{});
                    // Auto-detect specialty from visit_type or con_data
                    let _sp = _cd.specialty || con.visit_type || "";
                    let _hosp = _cd.hospital_name || _cd.hospital || "";
                    // Try to extract from assessment_summary or con_data fields
                    if (!_sp && _cd.assessment_summary) {
                      const spMatch = (_cd.assessment_summary||"").match(/(?:cardiol|neurol|urolog|endocrin|orthop|dermat|gastro|pulmon|nephrol|ophthal|gynec|oncol|psychiat|ent)/i);
                      if (spMatch) _sp = spMatch[0].charAt(0).toUpperCase() + spMatch[0].slice(1) + "ogy";
                    }
                    const key = doctor + "|||" + (con.visit_date||"");
                    if (!groups[key]) groups[key] = { doctor, date: con.visit_date, status: con.status, specialty: _sp, hospital: _hosp, meds: [] };'''

if old_grp_specialty in c:
    c = c.replace(old_grp_specialty, new_grp_specialty, 1)
    changes += 1
    print("2. Auto-extract specialty: OK")
else:
    print("2. Auto-extract specialty: FAILED")

# ═══ FIX 3: Also filter Gini doctors in text export ═══
old_text_ext = '''        const _exM = (patientFullData.medications||[]).filter(m => {
          if (!m.is_active) return false;
          const k = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
          return k.length > 1 && !_curN.has(k);
        });'''

new_text_ext = '''        const _cm2 = {};
        (patientFullData.consultations||[]).forEach(cn => { _cm2[cn.id] = cn; });
        const _giniDocs = ["bhansali","khetarpal","beant","rahul","bansali"];
        const _exM = (patientFullData.medications||[]).filter(m => {
          if (!m.is_active) return false;
          const k = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
          if (k.length <= 1 || _curN.has(k)) return false;
          const _c2 = _cm2[m.consultation_id] || {};
          const _dn = (_c2.con_name||_c2.mo_name||"").toLowerCase();
          return !_giniDocs.some(g => _dn.includes(g));
        });'''

if old_text_ext in c:
    c = c.replace(old_text_ext, new_text_ext, 1)
    changes += 1
    print("3. Text export filters Gini doctors: OK")
else:
    print("3. Text export filter: FAILED")

# ═══ FIX 4: Improve the summary prompt to be more patient-friendly ═══
# Find the assessment_summary instruction in the consultant prompt
old_summary_prompt = 'Dear [FirstName]: patient-friendly 2-3 line summary of findings and plan'
if old_summary_prompt in c:
    new_summary_prompt = 'Dear [FirstName]: Write a warm, clear 3-4 line summary. Start with good news or reassurance. Mention key findings simply. Explain what medicines we are giving and why. End with encouragement. Use simple Hindi-English words patients understand. Example: "Dear Rajesh: Your sugar levels have improved nicely from 8.1 to 7.2 — good progress! Your kidney and heart tests are stable. We are adding a new medicine Dapagliflozin which helps both sugar and kidneys. Keep up the walking and diet changes, you are on the right track."'
    c = c.replace(old_summary_prompt, new_summary_prompt, 1)
    changes += 1
    print("4. Better summary prompt: OK")
else:
    print("4. Summary prompt: FAILED - checking alt...")
    alt = 'patient-friendly 2-3 line summary of ALL findings'
    if alt in c:
        new_alt = 'Write a warm, clear 3-4 line summary for the patient. Start with reassurance/good news. Mention key findings in simple words. Explain new medicines and why. End with encouragement'
        c = c.replace(alt, new_alt, 1)
        changes += 1
        print("4. Better summary prompt (alt): OK")

f=open(path,'w'); f.write(c); f.close()
print(f"\nDone. {changes} changes. Run: npm run build")
