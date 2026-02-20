import os
path = os.path.expanduser("~/Downloads/gini-scribe/src/App.jsx")
f=open(path,'r'); c=f.read(); f.close()
f=open(path+'.bak6','w'); f.write(c); f.close()
print("Backup: App.jsx.bak6")

# ═══ 1. Fix inverse marker trend logic ═══
# Find where trend is calculated in generateMOBrief
old_trend = '''      let trend = "stable";
      if (prevNum !== null && !isNaN(latestNum) && !isNaN(prevNum)) {
        const pctChange = ((latestNum - prevNum) / Math.abs(prevNum || 1)) * 100;
        if (pctChange > 10) trend = "worsening";
        else if (pctChange < -10) trend = "improving";
      }'''

new_trend = '''      // For some markers, HIGHER is better (invert the trend)
      const higherIsBetter = ["Vitamin D","HDL","eGFR","EGFR","Hemoglobin","Hb","HB","Iron","Ferritin","HDL Cholesterol"].some(k => name.toLowerCase().includes(k.toLowerCase()));
      let trend = "stable";
      if (prevNum !== null && !isNaN(latestNum) && !isNaN(prevNum)) {
        const pctChange = ((latestNum - prevNum) / Math.abs(prevNum || 1)) * 100;
        if (higherIsBetter) {
          if (pctChange > 10) trend = "improving";
          else if (pctChange < -10) trend = "worsening";
        } else {
          if (pctChange > 10) trend = "worsening";
          else if (pctChange < -10) trend = "improving";
        }
      }'''

if old_trend in c:
    c = c.replace(old_trend, new_trend, 1)
    print("1. Inverse marker fix: OK")
else:
    print("1. Inverse marker fix: FAILED - pattern not found")

# ═══ 2. Deduplicate medications by normalized name ═══
old_meds = '''    const activeMeds = meds.length > 0 ? meds : (pfd.medications||[]).slice(0, 15);'''

new_meds = '''    const rawMeds = meds.length > 0 ? meds : (pfd.medications||[]).slice(0, 15);
    // Deduplicate by normalized name (strip numbers, spaces)
    const medSeen = new Set();
    const activeMeds = [];
    for (const m of rawMeds) {
      const key = (m.name||"").toUpperCase().replace(/[^A-Z]/g,"");
      if (!medSeen.has(key) && key.length > 1) { medSeen.add(key); activeMeds.push(m); }
    }'''

if old_meds in c:
    c = c.replace(old_meds, new_meds, 1)
    print("2. Dedupe meds: OK")
else:
    print("2. Dedupe meds: FAILED")

# ═══ 3. Update AI Clinical Brief prompt for better format ═══
old_followup_prompt = '''`You are an expert clinical briefing AI for Gini Advanced Care Hospital. Generate a comprehensive CLINICAL BRIEF that an MO reads aloud to the Consultant.

Write in natural professional English, paragraph form, not bullets.

Use these exact section headers wrapped in **double asterisks**:

**PATIENT JOURNEY**
Who they are, how long under care, total visits, primary diagnoses, what brought them.

**WHAT'S WORKING**
Controlled conditions, improving labs with specific trajectories and numbers, effective medications.

**WHAT NEEDS ATTENTION**
Worsening parameters with trajectories. Uncontrolled conditions. New symptoms. Be specific with numbers and dates.

**MEDICATION REVIEW**
Current regimen. Recent changes. Duration on current protocol.

**ADHERENCE & COMPLIANCE**
Visit regularity. Lab compliance. Weight/BP trends suggesting lifestyle compliance.

**SINCE LAST VISIT**
What specifically changed. New labs, new symptoms, vitals comparison.

**QUESTIONS TO ASK**
3-5 specific questions based on data patterns.

**CLINICAL CONSIDERATIONS**
2-3 evidence-based suggestions the consultant might consider. Reference actual values.

Be precise with numbers. No generic advice.`'''

new_followup_prompt = r'''`You are an expert clinical briefing AI at Gini Advanced Care Hospital. Generate a CLINICAL BRIEF for the consultant.

Format EXACTLY like this — keep it concise and clinical:

**30-SECOND OVERVIEW**
[Age]-year-old [sex]. Known case: [list diagnoses with durations]. Under care [X months/years], [N] visits.
[1-2 sentences: what's controlled, what's not, current status snapshot]

**CURRENT STATUS**
Group by clinical domain. Use this exact format:

Diabetes (or relevant condition):
- HbA1c [trend with arrows]: X% -> Y%
- Fasting glucose: Xmg/dL
- Renal: Cr X, eGFR Y

Lipids:
- LDL [trend]: X -> Y mg/dL
- TG: X mg/dL

Thyroid (if applicable):
- TSH [trend]: X -> Y
- T3/T4 values

Vitals:
- BP: X/Y (trend if available)
- Weight: Xkg, BMI Y

**CURRENT MEDICATIONS**
List medications grouped by purpose. Keep brief: name + dose + timing only.

**SINCE LAST VISIT**
What changed since previous visit — new labs, symptoms, vitals changes. Be specific.

**CONCERNS & DECISION POINTS**
Bullet list of 3-5 specific clinical questions or decisions needed. Examples:
- Any change in thyroid plan given rising T4?
- Psychiatric medication adjustment for persistent anxiety?
- Weight optimization strategy?

**CLINICAL CONSIDERATIONS**
2-3 evidence-based suggestions. Reference actual patient values.

RULES:
- Use actual numbers from the data, never generic ranges
- For lab trends, show trajectory with arrows (X -> Y)
- For markers where HIGHER is better (Vitamin D, HDL, eGFR, Hemoglobin, Iron, Ferritin), mark increases as improvement
- Keep total brief under 400 words
- No filler text, no greetings, pure clinical content
- Use bullet points sparingly, prefer inline values`'''

if old_followup_prompt in c:
    c = c.replace(old_followup_prompt, new_followup_prompt, 1)
    print("3a. Follow-up prompt: OK")
else:
    print("3a. Follow-up prompt: FAILED - not found")

old_new_prompt = '''`You are an expert clinical briefing AI. Generate a NEW PATIENT brief.

Use these exact section headers wrapped in **double asterisks**:

**PATIENT PRESENTATION**
Demographics, chief complaints, how they present.

**HISTORY SUMMARY**
Past medical/surgical, family, personal history. Current medications.

**TODAY'S FINDINGS**
Vitals, lab values, exam findings.

**DIFFERENTIAL CONSIDERATIONS**
2-3 clinical considerations worth exploring.

**SUGGESTED WORKUP**
Investigations to order.

**KEY QUESTIONS**
Important history questions to ask.

Be precise and clinical.`'''

new_new_prompt = r'''`You are an expert clinical briefing AI at Gini Advanced Care Hospital. Generate a NEW PATIENT brief.

Format:

**PRESENTATION**
[Age]-year-old [sex] presenting with [chief complaints]. [Any relevant history mentioned].

**HISTORY & MEDICATIONS**
Past medical/surgical history. Family history. Current medications with doses.

**TODAY'S FINDINGS**
Vitals: BP X/Y, Wt Xkg, BMI Y, Pulse Z
Labs (if available): list with values and flags

**INITIAL ASSESSMENT**
Key clinical impressions. Risk factors identified. Severity assessment.

**SUGGESTED WORKUP**
Specific investigations to order based on presentation.

**QUESTIONS TO ASK**
5-6 specific history questions to clarify diagnosis and guide treatment.

RULES:
- Use actual values from the data
- Keep total brief under 300 words
- Pure clinical content, no filler`'''

if old_new_prompt in c:
    c = c.replace(old_new_prompt, new_new_prompt, 1)
    print("3b. New patient prompt: OK")
else:
    print("3b. New patient prompt: FAILED")

f=open(path,'w'); f.write(c); f.close()
print("\nDone. Run: npm run build")
