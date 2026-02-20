import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()
f=open(path+'.bak7','w'); f.write(c); f.close()
print("Backup: App.jsx.bak7")

# ═══ 1. Update follow_up schema in Quick mode prompt (line ~208) ═══
old_followup1 = '"follow_up":{"duration":"6 weeks","tests_to_bring":["HbA1c","Fasting glucose"]}'
new_followup1 = '"follow_up":{"duration":"6 weeks","date":"YYYY-MM-DD or null","instructions":"Any special instructions like fasting, medication omission etc","tests_to_bring":["HbA1c","Fasting glucose"]}'
count = c.count(old_followup1)
c = c.replace(old_followup1, new_followup1)
print(f"1. Quick follow_up schema: {count} replaced")

# ═══ 2. Update follow_up schema in Consultant prompt (line ~250) ═══
old_followup2 = '"follow_up":{"duration":"6 weeks","tests_to_bring":["HbA1c"]}'
new_followup2 = '"follow_up":{"duration":"6 weeks","date":"YYYY-MM-DD or null","instructions":"Special instructions","tests_to_bring":["HbA1c"]}'
count2 = c.count(old_followup2)
c = c.replace(old_followup2, new_followup2)
print(f"2. Consultant follow_up schema: {count2} replaced")

# ═══ 3. Update follow_up instruction line ═══
old_fu_inst = '- follow_up: include duration and tests_to_bring'
new_fu_inst = '- follow_up: include duration, date (as YYYY-MM-DD if a specific date is mentioned like "28/03/2026"), instructions (fasting requirements, medication omission, lab timing etc), and tests_to_bring'
if old_fu_inst in c:
    c = c.replace(old_fu_inst, new_fu_inst, 1)
    print("3. follow_up instruction: OK")
else:
    print("3. follow_up instruction: SKIPPED")

# ═══ 4. Add history extraction to Consultant prompt ═══
# The consultant prompt needs to also extract history when used standalone
# Find the consultant prompt instructions
old_con_inst = '- follow_up: include duration, date (as YYYY-MM-DD if a specific date is mentioned like "28/03/2026"), instructions (fasting requirements, medication omission, lab timing etc), and tests_to_bring'
new_con_inst = '''- follow_up: include duration, date (as YYYY-MM-DD if a specific date is mentioned like "28/03/2026"), instructions (fasting requirements, medication omission, lab timing etc), and tests_to_bring
- If history information is present (family history, past medical/surgical, personal habits, COVID/vaccination), extract into mo.history object with keys: family, past_medical_surgical, personal, covid, vaccination. Include even if text says "NIL"'''
if old_con_inst in c:
    c = c.replace(old_con_inst, new_con_inst, 1)
    print("4. History extraction instruction: OK")
else:
    print("4. History extraction instruction: SKIPPED")

# ═══ 5. Update treatment plan text generation to include history ═══
# Find where treatment plan text is built and add history section
old_plan_summary = '    // Clinical Progress (longitudinal)'
if old_plan_summary in c:
    history_section = '''    // Patient History
    if (moData?.history) {
      const h = moData.history;
      const parts = [];
      if (h.family && h.family !== "NIL" && h.family !== "-") parts.push("Family: " + h.family);
      if (h.past_medical_surgical && h.past_medical_surgical !== "NIL" && h.past_medical_surgical !== "-") parts.push("Past Medical/Surgical: " + h.past_medical_surgical);
      if (h.personal && h.personal !== "NIL" && h.personal !== "-") parts.push("Personal: " + h.personal);
      if (h.covid) parts.push("COVID: " + h.covid);
      if (h.vaccination) parts.push("Vaccination: " + h.vaccination);
      if (parts.length > 0) {
        text += "HISTORY:\\n" + parts.join("\\n") + "\\n\\n";
      }
    }
'''
    c = c.replace(old_plan_summary, history_section + '    ' + old_plan_summary, 1)
    print("5. History in treatment plan: OK")
else:
    # Try without the clinical progress marker
    old_plan_summary2 = '      text += `SUMMARY:'
    if old_plan_summary2 in c:
        history_section2 = '''      // Patient History
      if (moData?.history) {
        const h = moData.history;
        const parts = [];
        if (h.family && h.family !== "NIL" && h.family !== "-") parts.push("Family: " + h.family);
        if (h.past_medical_surgical && h.past_medical_surgical !== "NIL" && h.past_medical_surgical !== "-") parts.push("Past Medical/Surgical: " + h.past_medical_surgical);
        if (h.personal && h.personal !== "NIL" && h.personal !== "-") parts.push("Personal: " + h.personal);
        if (h.covid) parts.push("COVID: " + h.covid);
        if (h.vaccination) parts.push("Vaccination: " + h.vaccination);
        if (parts.length > 0) {
          text += `HISTORY:\\n` + parts.join("\\n") + `\\n\\n`;
        }
      }
'''
        c = c.replace(old_plan_summary2, history_section2 + '      ' + old_plan_summary2.lstrip(), 1)
        print("5. History in treatment plan (alt): OK")
    else:
        print("5. History in treatment plan: FAILED")

# ═══ 6. Update follow-up rendering in treatment plan ═══
old_fu_render = '''    if (conData?.follow_up) {
      text += `FOLLOW-UP: ${conData.follow_up.timing||conData.follow_up.when||""}\\n`;
      if (conData.follow_up.instructions) text += `Instructions: ${conData.follow_up.instructions}\\n`;'''

new_fu_render = '''    if (conData?.follow_up) {
      text += `FOLLOW-UP: ${conData.follow_up.duration||conData.follow_up.timing||conData.follow_up.when||""}`;
      if (conData.follow_up.date) text += ` (${new Date(conData.follow_up.date).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})})`;
      text += `\\n`;
      if (conData.follow_up.instructions) text += `Instructions: ${conData.follow_up.instructions}\\n`;'''

if old_fu_render in c:
    c = c.replace(old_fu_render, new_fu_render, 1)
    print("6. Follow-up rendering: OK")
else:
    print("6. Follow-up rendering: FAILED - pattern not found")

# ═══ 7. Update the follow-up display card in the UI ═══
# Find the follow-up card and add date + instructions
old_fu_card = '''                {conData.follow_up?.instructions && ('''
if old_fu_card in c:
    # Add date display before instructions
    date_display = '''                {conData.follow_up?.date && (
                  <div style={{ fontSize:11, color:"#1e40af", fontWeight:600, marginTop:4 }}>
                    {"\\U0001f4c5 "}{new Date(conData.follow_up.date).toLocaleDateString("en-IN",{weekday:"long",day:"2-digit",month:"short",year:"numeric"})}
                  </div>
                )}
'''
    c = c.replace(old_fu_card, date_display + '                ' + old_fu_card, 1)
    print("7. Follow-up date card: OK")
else:
    print("7. Follow-up date card: SKIPPED")

# ═══ 8. Add history display section in the MO Summary UI ═══
# Find where history is rendered and make sure it also works for consultant-only flow
# Check if there's already a history section in the plan tab
old_history_display = '{moData.history.family && moData.history.family !== "NIL"'
if old_history_display in c:
    print("8. History display: EXISTS in MO tab")
else:
    print("8. History display: Not found (may need adding)")

f=open(path,'w'); f.write(c); f.close()
print("\nDone. Run: npm run build")
