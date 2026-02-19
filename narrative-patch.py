import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()
f=open(path+'.bak3','w'); f.write(c); f.close()
print("Backup: App.jsx.bak3")

changes = 0

# ═══ 1. Add briefMode state ═══
old = 'const [moBrief, setMoBrief] = useState(null);'
new = 'const [moBrief, setMoBrief] = useState(null);\n  const [briefMode, setBriefMode] = useState("narrative");'
if 'briefMode' not in c:
    c = c.replace(old, new, 1)
    changes += 1
    print("1. briefMode state: OK")
else:
    print("1. briefMode state: EXISTS")

# ═══ 2. Add narrative generation before the return in generateMOBrief ═══
old_return = '''      weightTrend, bpTrend, medChanges, uniqueGoals, doctorsSeen, monthsUnderCare
    };
  };'''

if 'narrative,' not in c or 'moBrief.narrative' not in c:
    new_return = '''      weightTrend, bpTrend, medChanges, uniqueGoals, doctorsSeen, monthsUnderCare
    };

    // ═══ Generate readable narrative ═══
    let narrative = "";
    const firstName = patient.name?.split(" ")[0] || "Patient";
    if (isFollowUp) {
      narrative += `Sir, ${patient.name}, ${patient.age} year old ${patient.sex?.toLowerCase()||"patient"}`;
      narrative += `, has been under our care for ${monthsUnderCare > 12 ? Math.round(monthsUnderCare/12) + " years" : monthsUnderCare + " months"}`;
      narrative += ` with ${totalVisits} visits so far. `;
      if (daysSince !== null) narrative += daysSince === 0 ? "Seen today. " : `Last visit was ${daysSince} days ago${lastVisit?.con_name ? " with " + lastVisit.con_name : ""}. `;

      const controlled = uniqueDiags.filter(d => d.status?.toLowerCase() === "controlled");
      const uncontrolled = uniqueDiags.filter(d => d.status?.toLowerCase() === "uncontrolled");
      narrative += "\\n\\nDiagnosis: " + uniqueDiags.map(d => d.label).join(", ") + ". ";
      if (controlled.length) narrative += controlled.map(d => d.label).join(" and ") + (controlled.length === 1 ? " is" : " are") + " well controlled. ";
      if (uncontrolled.length) narrative += uncontrolled.map(d => d.label).join(" and ") + (uncontrolled.length === 1 ? " remains" : " remain") + " uncontrolled. ";

      narrative += `\\n\\nCurrently on ${activeMeds.length} medications: `;
      narrative += activeMeds.map(m => `${m.name} ${m.dose||""} ${m.timing||m.frequency||""}`).join(", ") + ". ";
      if (medChanges.length) {
        const added = medChanges.filter(mc => mc.type === "added");
        const stopped = medChanges.filter(mc => mc.type === "stopped");
        if (added.length) narrative += "Since last visit, " + added.map(mc => mc.name).join(", ") + (added.length === 1 ? " was" : " were") + " added. ";
        if (stopped.length) narrative += stopped.map(mc => mc.name).join(", ") + (stopped.length === 1 ? " was" : " were") + " stopped. ";
      }

      const improving = labTrends.filter(l => l.trend === "improving");
      const worsening = labTrends.filter(l => l.trend === "worsening");
      const stableKey = labTrends.filter(l => l.trend === "stable" && l.isKey);
      const abnormal = labTrends.filter(l => l.latestFlag && l.latestFlag !== "N" && l.latestFlag !== "normal");

      if (labTrends.length) {
        narrative += "\\n\\nRegarding labs: ";
        if (improving.length) {
          narrative += "Good news \\u2014 ";
          improving.forEach((l, i) => { narrative += l.name + (l.trajectory ? " has improved: " + l.trajectory : " improved from " + l.previous + " to " + l.latest + l.latestUnit) + (i < improving.length - 1 ? "; " : ". "); });
        }
        if (worsening.length) {
          narrative += "Concern \\u2014 ";
          worsening.forEach((l, i) => { narrative += l.name + (l.trajectory ? " has worsened: " + l.trajectory : " went from " + l.previous + " to " + l.latest + l.latestUnit) + (i < worsening.length - 1 ? "; " : ". "); });
        }
        if (stableKey.length) narrative += "Stable: " + stableKey.map(l => l.name + " " + l.latest + l.latestUnit).join(", ") + ". ";
      }
      if (newLabs.length) narrative += newLabs.length + " new lab results available since last visit. ";

      narrative += "\\n\\nToday's vitals: ";
      if (currentVitals?.bp_sys) {
        narrative += "BP " + currentVitals.bp_sys + "/" + currentVitals.bp_dia;
        if (prevVitals?.bp_sys) { const bpDiff = parseInt(currentVitals.bp_sys) - parseInt(prevVitals.bp_sys); if (Math.abs(bpDiff) >= 5) narrative += " (" + (bpDiff > 0 ? "up" : "down") + " from " + prevVitals.bp_sys + "/" + prevVitals.bp_dia + ")"; }
      }
      if (currentVitals?.weight) {
        narrative += ", weight " + currentVitals.weight + "kg";
        if (prevVitals?.weight) { const wd = (parseFloat(currentVitals.weight) - parseFloat(prevVitals.weight)).toFixed(1); if (Math.abs(wd) >= 0.5) narrative += " (" + (wd > 0 ? "gained" : "lost") + " " + Math.abs(wd) + "kg)"; }
      }
      if (currentVitals?.bmi) narrative += ", BMI " + currentVitals.bmi;
      narrative += ". ";
      if (weightTrend) narrative += "Overall weight trend: " + weightTrend + ". ";

      if (uniqueGoals.length) {
        narrative += "\\n\\nGoals: ";
        uniqueGoals.forEach((g, i) => {
          const lm = labTrends.find(l => l.name.toLowerCase().includes(g.marker?.toLowerCase()||""));
          narrative += g.marker + " currently " + (lm ? lm.latest + lm.latestUnit : g.current_value) + ", target " + g.target_value;
          if (g.timeline) narrative += " in " + g.timeline;
          narrative += i < uniqueGoals.length - 1 ? "; " : ". ";
        });
      }

      narrative += "\\n\\nKey points: ";
      if (daysSince > 120) narrative += "Patient hasn't visited in " + daysSince + " days \\u2014 adherence may need review. ";
      if (worsening.length) narrative += worsening.length + " parameter" + (worsening.length > 1 ? "s" : "") + " worsening \\u2014 may need treatment adjustment. ";
      if (!worsening.length && improving.length) narrative += "Overall trajectory is positive with " + improving.length + " parameter" + (improving.length > 1 ? "s" : "") + " improving. ";
      if (!worsening.length && !improving.length && !abnormal.length) narrative += "Patient appears stable on current management. ";
    } else {
      narrative += "Sir, this is a new patient. " + patient.name + ", " + patient.age + " year old " + (patient.sex?.toLowerCase()||"patient") + ". ";
      if (moData?.chief_complaints?.length) narrative += "Presenting with " + moData.chief_complaints.join(", ") + ". ";
      if (sa(moData,"diagnoses").length) narrative += "Working diagnosis: " + sa(moData,"diagnoses").map(d => d.label).join(", ") + ". ";
      if (sa(moData,"previous_medications").length) narrative += "Currently taking: " + sa(moData,"previous_medications").map(m => m.name + " " + (m.dose||"")).join(", ") + ". ";
      if (currentVitals?.bp_sys) narrative += "Vitals: BP " + currentVitals.bp_sys + "/" + currentVitals.bp_dia + ", weight " + (currentVitals.weight||"--") + "kg, BMI " + (currentVitals.bmi||"--") + ". ";
    }

    result.narrative = narrative;
    return result;
  };'''

    if old_return in c:
        c = c.replace(old_return, new_return, 1)
        changes += 1
        print("2. Narrative generation: OK")
    else:
        print("2. Narrative generation: FAILED - return not found")
else:
    print("2. Narrative generation: EXISTS")

# ═══ 3. Add toggle buttons in brief header (before Copy button) ═══
old_copy_btn = '''<button onClick={()=>{ navigator.clipboard.writeText(moBrief.briefText); }}
                      style={{ background:"rgba(255,255,255,.2)", border:"none", color:"white", padding:"4px 10px", borderRadius:5, fontSize:10, fontWeight:700, cursor:"pointer" }}>📋 Copy</button>'''

new_copy_btn = '''<div style={{display:"flex",gap:0,borderRadius:4,overflow:"hidden",border:"1px solid rgba(255,255,255,.3)"}}>
                      <button onClick={()=>setBriefMode("narrative")} style={{padding:"3px 8px",fontSize:9,fontWeight:700,border:"none",cursor:"pointer",background:briefMode==="narrative"?"rgba(255,255,255,.3)":"transparent",color:"white"}}>📖 Read</button>
                      <button onClick={()=>setBriefMode("structured")} style={{padding:"3px 8px",fontSize:9,fontWeight:700,border:"none",cursor:"pointer",background:briefMode==="structured"?"rgba(255,255,255,.3)":"transparent",color:"white"}}>📊 Cards</button>
                    </div>
                    <button onClick={()=>{ navigator.clipboard.writeText(briefMode==="narrative" ? (moBrief.narrative||moBrief.briefText) : moBrief.briefText); }}
                      style={{ background:"rgba(255,255,255,.2)", border:"none", color:"white", padding:"4px 10px", borderRadius:5, fontSize:10, fontWeight:700, cursor:"pointer" }}>📋 Copy</button>'''

if old_copy_btn in c:
    c = c.replace(old_copy_btn, new_copy_btn, 1)
    changes += 1
    print("3. Toggle + Copy buttons: OK")
else:
    print("3. Toggle buttons: FAILED - copy button not found")

# ═══ 4. Add narrative view before the structured cards ═══
old_content_start = '''                  <div style={{ padding:10, fontSize:11, lineHeight:1.7 }}>
                    {/* Diagnoses */}
                    {moBrief.diagnoses.length > 0 && ('''

new_content_start = '''                  <div style={{ padding:10, fontSize:11, lineHeight:1.7 }}>
                    {/* Narrative View */}
                    {briefMode === "narrative" && moBrief.narrative && (
                      <div style={{ whiteSpace:"pre-wrap", fontSize:12, lineHeight:1.8, color:"#1e293b", padding:4 }}>
                        {moBrief.narrative}
                      </div>
                    )}
                    {/* Structured Cards View */}
                    {briefMode === "structured" && moBrief.diagnoses.length > 0 && ('''

if old_content_start in c:
    c = c.replace(old_content_start, new_content_start, 1)
    changes += 1
    print("4. Narrative view: OK")
else:
    print("4. Narrative view: FAILED - content start not found")

# ═══ 5. Wrap the rest of structured sections in briefMode check ═══
# Find "CURRENT MEDICATIONS" and wrap everything from diagnoses to the end
# We need to close the structured conditional at the end of the panel

# Find the closing of the brief panel's content div
# The structured content ends somewhere before the panel's closing tags
# Find all the structured sections and close the conditional after the last one

# Look for the TODAY'S VITALS section which is the last structured section
todays_vitals = c.find('"TODAY\'S VITALS"')
if todays_vitals == -1:
    todays_vitals = c.find("TODAY'S VITALS")
if todays_vitals == -1:
    todays_vitals = c.find("TODAY\\'S VITALS")

# Try another approach - find where the structured panel content div closes
# The medications section starts with {moBrief.medications.length > 0
# Let's wrap: put {briefMode === "structured" && before each section

# Better approach: wrap all remaining structured sections
# Find "CURRENT MEDICATIONS" which follows diagnoses
meds_section = c.find('"CURRENT MEDICATIONS (')
if meds_section > 0:
    # Find the {moBrief.medications before it
    meds_start = c.rfind('{moBrief.medications', max(0, meds_section - 100), meds_section)
    if meds_start > 0:
        c = c[:meds_start] + '{briefMode === "structured" && ' + c[meds_start:]
        changes += 1
        print("5a. Wrap meds section: OK")

        # Find improving/worsening section
        trends_section = c.find('{(moBrief.improving.length', meds_start + 50)
        if trends_section > 0:
            c = c[:trends_section] + '{briefMode === "structured" && ' + c[trends_section:]
            changes += 1
            print("5b. Wrap trends section: OK")
        
        # Find KEY LAB VALUES section
        lab_section = c.find('"KEY LAB VALUES"', meds_start + 50)
        if lab_section > 0:
            lab_div = c.rfind('{moBrief.labTrends', max(0, lab_section - 200), lab_section)
            if lab_div == -1:
                lab_div = c.rfind('<div style=', max(0, lab_section - 100), lab_section)
            if lab_div > 0:
                # Check if already wrapped
                before = c[lab_div-40:lab_div]
                if 'structured' not in before:
                    c = c[:lab_div] + '{briefMode === "structured" && ' + c[lab_div:]
                    # Find the closing of this section
                    # Look for the next major section or closing
                    next_section = c.find("TODAY'S VITALS", lab_div + 50)
                    if next_section == -1:
                        next_section = c.find("TODAY\\'S VITALS", lab_div + 50)
                    if next_section > 0:
                        # Find the div that starts TODAY'S section
                        today_div = c.rfind('{', max(0, next_section - 200), next_section)
                        # Close the lab section wrapper before TODAY section
                        # Find the </div> that closes the lab section
                        close_before_today = c.rfind('</div>', lab_div, next_section - 10)
                        if close_before_today > 0:
                            close_after = c.find('\n', close_before_today)
                            c = c[:close_after] + '\n                    }' + c[close_after:]
                            changes += 1
                            print("5c. Wrap lab values section: OK")

        # Find TODAY'S VITALS section
        today_section = c.find("TODAY'S VITALS")
        if today_section == -1:
            today_section = c.find("TODAY\\'S VITALS")
        if today_section > 0:
            today_div = c.rfind('{moBrief.currentVitals', max(0, today_section - 200), today_section)
            if today_div == -1:
                today_div = c.rfind('{currentVitals', max(0, today_section - 200), today_section)
            if today_div > 0:
                before = c[today_div-40:today_div]
                if 'structured' not in before:
                    c = c[:today_div] + '{briefMode === "structured" && ' + c[today_div:]
                    changes += 1
                    print("5d. Wrap vitals section: OK")

# ═══ 6. Also update the other Copy button (line 3934) ═══
old_copy2 = 'navigator.clipboard.writeText(moBrief.briefText)'
new_copy2 = 'navigator.clipboard.writeText(briefMode==="narrative"?(moBrief.narrative||moBrief.briefText):moBrief.briefText)'
# Replace all remaining instances
c = c.replace(old_copy2, new_copy2)
print("6. All copy buttons updated")

f=open(path,'w'); f.write(c); f.close()
print(f"\nTotal changes: {changes}")
print("Next: npm run build && git add . && git commit -m 'feat: narrative brief for MO' && git push origin main")
