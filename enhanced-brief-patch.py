#!/usr/bin/env python3
"""
Enhanced Brief + Clinical Progress + Save Speed patch
Run: python3 enhanced-brief-patch.py
"""
import os, sys

path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
server_path = os.path.expanduser("~/Downloads/gini-scribe/server/index.js")

with open(path, "r") as f:
    c = f.read()
with open(path + ".bak2", "w") as f:
    f.write(c)
print("Backup: App.jsx.bak2")

# ═══════════════════════════════════════════════════════════════════
# PATCH 1: ENHANCED MO BRIEF — Replace the entire generateMOBrief
# ═══════════════════════════════════════════════════════════════════

old_brief_start = '''  const generateMOBrief = () => {
    const pfd = patientFullData;
    if (!pfd) return null;

    const sortedCons = (pfd.consultations||[]).sort((a,b) => {
      const d = new Date(b.visit_date) - new Date(a.visit_date);
      return d !== 0 ? d : new Date(b.created_at) - new Date(a.created_at);
    });
    const isFollowUp = sortedCons.length > 0;
    const lastVisit = sortedCons[0];
    const prevVisit = sortedCons[1]; // visit before last'''

old_brief_end = '''    return {
      isFollowUp, daysSince, briefText,
      diagnoses: uniqueDiags, medications: activeMeds,
      labTrends, newLabs, improving: labTrends.filter(l=>l.trend==="improving"),
      worsening: labTrends.filter(l=>l.trend==="worsening"),
      currentVitals, prevVitals, lastVisit, totalVisits: sortedCons.length
    };
  };'''

# Find the full old brief
start_idx = c.find(old_brief_start)
end_idx = c.find(old_brief_end)
if start_idx == -1 or end_idx == -1:
    print("FAILED: Could not find generateMOBrief boundaries")
    sys.exit(1)

old_brief_full = c[start_idx:end_idx + len(old_brief_end)]

new_brief = r'''  const generateMOBrief = () => {
    const pfd = patientFullData;
    if (!pfd) return null;

    const sortedCons = (pfd.consultations||[]).sort((a,b) => {
      const d = new Date(b.visit_date) - new Date(a.visit_date);
      return d !== 0 ? d : new Date(b.created_at) - new Date(a.created_at);
    });
    const isFollowUp = sortedCons.length > 0;
    const lastVisit = sortedCons[0];
    const prevVisit = sortedCons[1];

    // Current diagnoses (deduplicated)
    const diags = (pfd.diagnoses||[]);
    const uniqueDiags = [];
    const seen = new Set();
    diags.forEach(d => { if (!seen.has(d.diagnosis_id||d.label)) { seen.add(d.diagnosis_id||d.label); uniqueDiags.push(d); }});

    // Current medications (from most recent visit)
    const meds = (pfd.medications||[]).filter(m => {
      if (!lastVisit) return true;
      return m.consultation_id === lastVisit.id;
    });
    const activeMeds = meds.length > 0 ? meds : (pfd.medications||[]).slice(0, 15);

    // Vitals comparison
    const sortedVitals = (pfd.vitals||[]).sort((a,b) => new Date(b.recorded_at) - new Date(a.recorded_at));
    const currentVitals = vitals.bp_sys ? vitals : sortedVitals[0];
    const prevVitals = sortedVitals.length > 1 ? sortedVitals[1] : null;

    // ── LONGITUDINAL LAB TRENDS (all history, not just last 2) ──
    const labsByTest = {};
    (pfd.lab_results||[]).forEach(l => {
      if (!labsByTest[l.test_name]) labsByTest[l.test_name] = [];
      labsByTest[l.test_name].push(l);
    });
    const labTrends = [];
    const keyTests = ["HbA1c","Fasting Glucose","FBS","FBG","FPG","PPBS","Post Prandial Glucose","Creatinine","eGFR","EGFR","Total Cholesterol","LDL","HDL","Non-HDL","Non HDL","Triglycerides","TSH","T3","T4","Free T3","Free T4","SGPT","ALT","SGOT","AST","Hemoglobin","Hb","UACR","Microalbumin","Potassium","Sodium","Uric Acid"];
    Object.entries(labsByTest).forEach(([name, results]) => {
      const sorted = results.sort((a,b) => new Date(b.test_date) - new Date(a.test_date));
      const latest = sorted[0];
      const prev = sorted[1];
      const oldest = sorted[sorted.length - 1];
      if (!latest?.result) return;
      const isKey = keyTests.some(k => name.toLowerCase().includes(k.toLowerCase()));
      if (!isKey && sorted.length < 2) return;
      const latestNum = parseFloat(latest.result);
      const prevNum = prev ? parseFloat(prev.result) : null;
      const oldestNum = oldest ? parseFloat(oldest.result) : null;
      let trend = "stable";
      if (prevNum !== null && !isNaN(latestNum) && !isNaN(prevNum)) {
        const pctChange = ((latestNum - prevNum) / Math.abs(prevNum || 1)) * 100;
        if (pctChange > 10) trend = "worsening";
        else if (pctChange < -10) trend = "improving";
      }
      // Build full trajectory string
      let trajectory = "";
      if (sorted.length >= 2) {
        trajectory = sorted.slice().reverse().map(r => {
          const d = r.test_date ? new Date(r.test_date).toLocaleDateString("en-IN",{month:"short",year:"2-digit"}) : "";
          return `${r.result}${r.unit||""}(${d})`;
        }).join(" → ");
      }
      if (isKey || trend !== "stable") {
        labTrends.push({
          name, latest: latest.result, latestUnit: latest.unit||"",
          latestDate: latest.test_date, latestFlag: latest.flag,
          previous: prev?.result||null, prevDate: prev?.test_date||null,
          oldest: oldest?.result||null, oldestDate: oldest?.test_date||null,
          trend, isKey, trajectory, dataPoints: sorted.length
        });
      }
    });

    // New labs since last visit
    const lastDate = lastVisit?.visit_date ? String(lastVisit.visit_date).slice(0,10) : null;
    const newLabs = lastDate ? (pfd.lab_results||[]).filter(l => l.test_date && String(l.test_date).slice(0,10) > lastDate) : [];

    // Days since last visit
    const daysSince = lastVisit ? Math.round((Date.now() - new Date(lastVisit.visit_date)) / 86400000) : null;

    // ── VISIT FREQUENCY ANALYSIS ──
    const totalVisits = sortedCons.length;
    const firstVisitDate = sortedCons.length > 0 ? sortedCons[sortedCons.length - 1].visit_date : null;
    const monthsUnderCare = firstVisitDate ? Math.max(1, Math.round((Date.now() - new Date(firstVisitDate)) / (30*86400000))) : 0;
    const avgVisitGap = totalVisits > 1 ? Math.round((Date.now() - new Date(firstVisitDate)) / (totalVisits * 86400000)) : null;

    // ── MEDICATION CHANGES ACROSS VISITS ──
    const medChanges = [];
    if (sortedCons.length >= 2) {
      const currentMedNames = new Set(activeMeds.map(m => m.name?.toUpperCase()));
      const prevMeds = (pfd.medications||[]).filter(m => prevVisit && m.consultation_id === prevVisit.id);
      const prevMedNames = new Set(prevMeds.map(m => m.name?.toUpperCase()));
      currentMedNames.forEach(name => { if (!prevMedNames.has(name)) medChanges.push({ type: "added", name }); });
      prevMedNames.forEach(name => { if (!currentMedNames.has(name)) medChanges.push({ type: "stopped", name }); });
    }

    // ── WEIGHT TRAJECTORY ──
    const weightHistory = sortedVitals.filter(v => v.weight).slice(0, 10).reverse();
    let weightTrend = "";
    if (weightHistory.length >= 2) {
      const first = parseFloat(weightHistory[0].weight);
      const last = parseFloat(weightHistory[weightHistory.length - 1].weight);
      const diff = (last - first).toFixed(1);
      weightTrend = `${first}→${last}kg (${diff > 0 ? "+" : ""}${diff}kg over ${weightHistory.length} visits)`;
    }

    // ── BP TRAJECTORY ──
    const bpHistory = sortedVitals.filter(v => v.bp_sys).slice(0, 10).reverse();
    let bpTrend = "";
    if (bpHistory.length >= 2) {
      bpTrend = bpHistory.map(v => `${v.bp_sys}/${v.bp_dia}`).join(" → ");
    }

    // ── GOALS PROGRESS ──
    const goals = (pfd.goals||[]);
    const uniqueGoals = [];
    const seenGoals = new Set();
    goals.forEach(g => {
      if (!seenGoals.has(g.marker)) { seenGoals.add(g.marker); uniqueGoals.push(g); }
    });

    // ── DOCTORS SEEN ──
    const doctorsSeen = [...new Set(sortedCons.map(c => c.con_name).filter(Boolean))];

    // ═══ BUILD COMPREHENSIVE BRIEF ═══
    let briefText = "";
    if (isFollowUp) {
      briefText += `══ FOLLOW-UP PATIENT ══\n`;
      briefText += `${patient.name}, ${patient.age}Y/${patient.sex}`;
      if (patient.fileNo) briefText += ` | File #${patient.fileNo}`;
      briefText += `\n`;
      briefText += `Under care: ${monthsUnderCare} months (${totalVisits} visits, avg every ${avgVisitGap || "—"} days)\n`;
      if (doctorsSeen.length) briefText += `Seen by: ${doctorsSeen.join(", ")}\n`;
      briefText += `\n`;

      briefText += `── CONDITIONS ──\n`;
      briefText += `${uniqueDiags.map(d => `• ${d.label} — ${d.status}`).join("\n") || "None recorded"}\n\n`;

      briefText += `── LAST VISIT ──\n`;
      briefText += `${lastVisit.visit_date ? new Date(lastVisit.visit_date).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}) : "Unknown"} — ${daysSince} days ago`;
      if (lastVisit.con_name) briefText += ` — ${lastVisit.con_name}`;
      briefText += `\n\n`;

      briefText += `── CURRENT MEDICATIONS (${activeMeds.length}) ──\n`;
      briefText += `${activeMeds.length ? activeMeds.map(m => `• ${m.name} ${m.dose||""} ${m.frequency||""} ${m.timing||""}`).join("\n") : "None recorded"}\n`;
      if (medChanges.length) {
        briefText += `Changes since prev visit: ${medChanges.map(c => `${c.type === "added" ? "➕" : "➖"} ${c.name}`).join(", ")}\n`;
      }
      briefText += `\n`;

      // Lab trends section with full trajectories
      const improving = labTrends.filter(l => l.trend === "improving");
      const worsening = labTrends.filter(l => l.trend === "worsening");
      const stable = labTrends.filter(l => l.trend === "stable" && l.isKey);

      if (labTrends.length > 0) {
        briefText += `── LAB TRENDS ──\n`;
        if (worsening.length) {
          briefText += `⚠️ WORSENING:\n`;
          worsening.forEach(l => {
            briefText += `  • ${l.name}: ${l.trajectory || `${l.previous}→${l.latest}${l.latestUnit}`}`;
            if (l.latestFlag && l.latestFlag !== "N") briefText += ` [${l.latestFlag}]`;
            briefText += `\n`;
          });
        }
        if (improving.length) {
          briefText += `✅ IMPROVING:\n`;
          improving.forEach(l => {
            briefText += `  • ${l.name}: ${l.trajectory || `${l.previous}→${l.latest}${l.latestUnit}`}\n`;
          });
        }
        if (stable.length) {
          briefText += `➡️ STABLE: ${stable.map(l => `${l.name}: ${l.latest}${l.latestUnit}`).join(", ")}\n`;
        }
        briefText += `\n`;
      }

      if (newLabs.length) {
        briefText += `🔬 NEW LABS SINCE LAST VISIT (${newLabs.length}): ${[...new Set(newLabs.map(l=>l.test_name))].join(", ")}\n\n`;
      }

      // Vitals trends
      briefText += `── VITALS ──\n`;
      if (currentVitals?.bp_sys) {
        briefText += `Today: BP ${currentVitals.bp_sys}/${currentVitals.bp_dia}`;
        if (currentVitals.weight) briefText += `, Wt ${currentVitals.weight}kg`;
        if (currentVitals.bmi) briefText += `, BMI ${currentVitals.bmi}`;
        if (currentVitals.waist) briefText += `, WC ${currentVitals.waist}cm`;
        briefText += `\n`;
      }
      if (weightTrend) briefText += `Weight trend: ${weightTrend}\n`;
      if (bpTrend) briefText += `BP trend: ${bpTrend}\n`;
      briefText += `\n`;

      // Goals
      if (uniqueGoals.length > 0) {
        briefText += `── GOALS ──\n`;
        uniqueGoals.forEach(g => {
          // Find current lab value for this goal marker
          const labMatch = labTrends.find(l => l.name.toLowerCase().includes(g.marker?.toLowerCase() || ""));
          const currentVal = labMatch ? labMatch.latest + labMatch.latestUnit : g.current_value;
          briefText += `• ${g.marker}: ${currentVal} → Target: ${g.target_value} (${g.timeline || "ongoing"})\n`;
        });
        briefText += `\n`;
      }

      // Key attention items
      briefText += `── KEY ATTENTION ──\n`;
      if (worsening.length) briefText += `⚠️ ${worsening.length} lab(s) worsening — review needed\n`;
      if (daysSince > 120) briefText += `⚠️ ${daysSince} days since last visit — check adherence\n`;
      if (!newLabs.length && daysSince > 60) briefText += `⚠️ No new labs — consider ordering\n`;
      const abnormalLabs = labTrends.filter(l => l.latestFlag && l.latestFlag !== "N" && l.latestFlag !== "normal");
      if (abnormalLabs.length) briefText += `🔴 Abnormal: ${abnormalLabs.map(l => `${l.name} ${l.latest}${l.latestUnit} [${l.latestFlag}]`).join(", ")}\n`;
      if (!worsening.length && !abnormalLabs.length && daysSince <= 120) briefText += `✅ Patient appears stable\n`;

    } else {
      briefText += `══ NEW PATIENT ══\n`;
      briefText += `${patient.name}, ${patient.age}Y/${patient.sex}`;
      if (patient.fileNo) briefText += ` | File #${patient.fileNo}`;
      if (patient.address) briefText += `\nAddress: ${patient.address}`;
      briefText += `\n\n`;
      if (moData) {
        briefText += `CHIEF COMPLAINTS: ${(moData.chief_complaints||[]).join(", ") || "—"}\n\n`;
        briefText += `DIAGNOSES: ${sa(moData,"diagnoses").map(d=>`${d.label} (${d.status})`).join(", ") || "To be determined"}\n\n`;
        briefText += `MEDICATIONS: ${sa(moData,"previous_medications").map(m=>`${m.name} ${m.dose||""}`).join(", ") || "None"}\n\n`;
      }
      if (currentVitals?.bp_sys) {
        briefText += `VITALS: BP ${currentVitals.bp_sys}/${currentVitals.bp_dia}, Pulse ${currentVitals.pulse||"—"}, Wt ${currentVitals.weight||"—"}kg, BMI ${currentVitals.bmi||"—"}\n`;
      }
    }

    return {
      isFollowUp, daysSince, briefText,
      diagnoses: uniqueDiags, medications: activeMeds,
      labTrends, newLabs, improving: labTrends.filter(l=>l.trend==="improving"),
      worsening: labTrends.filter(l=>l.trend==="worsening"),
      currentVitals, prevVitals, lastVisit, totalVisits: sortedCons.length,
      weightTrend, bpTrend, medChanges, uniqueGoals, doctorsSeen, monthsUnderCare
    };
  };'''

c = c.replace(old_brief_full, new_brief)
print("1. Enhanced brief:", "OK" if "LONGITUDINAL" in c else "FAILED")

# ═══════════════════════════════════════════════════════════════════
# PATCH 2: Add Clinical Progress to Treatment Plan
# ═══════════════════════════════════════════════════════════════════

# Find where SUMMARY is output in treatment plan and add CLINICAL PROGRESS before it
old_summary = '''text += `SUMMARY:\\n${conData.assessment_summary'''
if old_summary not in c:
    # Try to find the line differently
    import re
    m = re.search(r'text \+= `SUMMARY:\\n\$\{conData\.assessment_summary', c)
    if m:
        old_summary = c[m.start():m.start()+50]
        print(f"Found summary at: {old_summary[:50]}")

# Let's find it more precisely
idx = c.find('SUMMARY:\\n${conData.assessment_summary')
if idx > 0:
    # Go backwards to find the start of this line
    line_start = c.rfind('\n', 0, idx) + 1
    # Find the end of this statement
    line_end = c.find('\n', idx)
    summary_line = c[line_start:line_end]
    print(f"Found summary line: {summary_line[:80]}...")

    # Build clinical progress section to insert BEFORE summary
    progress_section = r'''    // ── Clinical Progress (longitudinal) ──
    const brief = generateMOBrief();
    if (brief && brief.isFollowUp && brief.totalVisits > 1) {
      text += `CLINICAL PROGRESS:\n`;
      text += `Under care for ${brief.monthsUnderCare} months (${brief.totalVisits} visits).\n`;
      if (brief.weightTrend) text += `Weight: ${brief.weightTrend}.\n`;
      if (brief.bpTrend) text += `BP trend: ${brief.bpTrend}.\n`;
      const imp = brief.labTrends.filter(l => l.trend === "improving");
      const wrs = brief.labTrends.filter(l => l.trend === "worsening");
      if (imp.length) text += `Improving: ${imp.map(l => `${l.name} ${l.trajectory || (l.previous+"→"+l.latest+l.latestUnit)}`).join("; ")}.\n`;
      if (wrs.length) text += `Needs attention: ${wrs.map(l => `${l.name} ${l.trajectory || (l.previous+"→"+l.latest+l.latestUnit)}`).join("; ")}.\n`;
      if (brief.medChanges.length) text += `Med changes: ${brief.medChanges.map(c => `${c.type === "added" ? "Added" : "Stopped"} ${c.name}`).join(", ")}.\n`;
      text += `──────────────────────────────────────────────────\n`;
    }
''' + '    '

    c = c[:line_start] + progress_section + c[line_start:]
    print("2. Clinical Progress:", "OK" if "CLINICAL PROGRESS" in c else "FAILED")
else:
    print("2. Clinical Progress: SKIPPED (couldn't find SUMMARY line)")

with open(path, "w") as f:
    f.write(c)
print(f"\n✅ App.jsx patched!")

# ═══════════════════════════════════════════════════════════════════
# PATCH 3: Speed up server save with batch INSERTs
# ═══════════════════════════════════════════════════════════════════
if os.path.exists(server_path):
    with open(server_path, "r") as f:
        s = f.read()
    with open(server_path + ".bak2", "w") as f:
        f.write(s)

    # Replace sequential lab inserts with batch
    old_lab_loop = '''    for (const inv of (moData?.investigations || [])) {
      if (inv?.test && num(inv.value) !== null) {
        await client.query(
          `INSERT INTO lab_results (patient_id, consultation_id, test_name, result, unit, flag, is_critical, ref_range, source, test_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scribe',COALESCE($9::date, CURRENT_DATE))`,
          [patientId, consultationId, t(inv.test,200), num(inv.value), t(inv.unit,50), t(inv.flag,50), inv.critical===true, t(inv.ref,100), vDate]
        );
      }
    }'''

    new_lab_loop = '''    const labVals = (moData?.investigations || []).filter(inv => inv?.test && num(inv.value) !== null);
    if (labVals.length > 0) {
      const labParams = []; const labPlaceholders = [];
      labVals.forEach((inv, i) => {
        const off = i * 9;
        labPlaceholders.push(`($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8},'scribe',COALESCE($${off+9}::date, CURRENT_DATE))`);
        labParams.push(patientId, consultationId, t(inv.test,200), num(inv.value), t(inv.unit,50), t(inv.flag,50), inv.critical===true, t(inv.ref,100), vDate);
      });
      await client.query(`INSERT INTO lab_results (patient_id, consultation_id, test_name, result, unit, flag, is_critical, ref_range, source, test_date) VALUES ${labPlaceholders.join(",")}`, labParams);
    }'''

    if old_lab_loop in s:
        s = s.replace(old_lab_loop, new_lab_loop, 1)
        print("3. Batch labs:", "OK")
    else:
        print("3. Batch labs: SKIPPED (pattern not found)")

    # Replace sequential goal inserts with batch
    old_goal_loop = '''    for (const g of (conData?.goals || [])) {
      if (g?.marker) {
        await client.query(`INSERT INTO goals (patient_id, consultation_id, marker, current_value, target_value, timeline, priority) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [patientId, consultationId, t(g.marker,200), t(g.current,200), t(g.target,200), t(g.timeline,200), t(g.priority,100)]);
      }
    }'''

    new_goal_loop = '''    const goalVals = (conData?.goals || []).filter(g => g?.marker);
    if (goalVals.length > 0) {
      const gParams = []; const gPlaceholders = [];
      goalVals.forEach((g, i) => {
        const off = i * 7;
        gPlaceholders.push(`($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7})`);
        gParams.push(patientId, consultationId, t(g.marker,200), t(g.current,200), t(g.target,200), t(g.timeline,200), t(g.priority,100));
      });
      await client.query(`INSERT INTO goals (patient_id, consultation_id, marker, current_value, target_value, timeline, priority) VALUES ${gPlaceholders.join(",")}`, gParams);
    }'''

    if old_goal_loop in s:
        s = s.replace(old_goal_loop, new_goal_loop, 1)
        print("4. Batch goals:", "OK")
    else:
        print("4. Batch goals: SKIPPED (pattern not found)")

    # Replace sequential diagnosis inserts with batch
    old_diag_loop = '''    for (const d of (moData?.diagnoses || [])) {
      if (d?.id && d?.label) {
        await client.query(
          `INSERT INTO diagnoses (patient_id, consultation_id, diagnosis_id, label, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [patientId, consultationId, t(d.id, 100), t(d.label, 500), t(d.status, 100) || 'New']
        );
      }
    }'''

    new_diag_loop = '''    const diagVals = (moData?.diagnoses || []).filter(d => d?.id && d?.label);
    if (diagVals.length > 0) {
      const dParams = []; const dPlaceholders = [];
      diagVals.forEach((d, i) => {
        const off = i * 5;
        dPlaceholders.push(`($${off+1},$${off+2},$${off+3},$${off+4},$${off+5})`);
        dParams.push(patientId, consultationId, t(d.id, 100), t(d.label, 500), t(d.status, 100) || 'New');
      });
      await client.query(`INSERT INTO diagnoses (patient_id, consultation_id, diagnosis_id, label, status) VALUES ${dPlaceholders.join(",")} ON CONFLICT DO NOTHING`, dParams);
    }'''

    if old_diag_loop in s:
        s = s.replace(old_diag_loop, new_diag_loop, 1)
        print("5. Batch diagnoses:", "OK")
    else:
        print("5. Batch diagnoses: SKIPPED (pattern not found)")

    with open(server_path, "w") as f:
        f.write(s)
    print("✅ Server patched!")
else:
    print("Server file not found, skipping speed patches")

print("\nNext: npm run build && git add . && git commit -m 'feat: enhanced brief + clinical progress + batch save' && git push origin main")
