# Developer Brief: Intelligent Patient Summary Panel
## Gini Scribe — Feature Addition

**Prepared for:** Developer (using Claude Code)
**Production app:** https://gini-scribe-production.up.railway.app
**Repo:** [your Railway/GitHub repo]
**Date:** April 2026

---

## 1. What We Are Building

A smart summary panel that appears at the top of the patient clinical view in Gini Scribe. When the doctor opens a patient record — either directly or arriving from the OPD/Coordinator screen — they see an intelligent briefing generated from the patient's data before they start the consultation.

The goal: in 10 seconds, the doctor knows exactly what needs attention today, what is working well, and what decisions are due. No scrolling. No hunting for data.

---

## 2. Context: The Flow That Triggers This

### Current flow (what exists):
1. Coordinator opens `/find` or `/opd` → sees appointment list
2. Coordinator adds biomarkers, lab reports, compliance data per patient (new feature — see OPD coordinator brief)
3. Doctor arrives → clicks patient → `/visit` or `/fu-review` opens the clinical record

### New flow with summary:
1. Same coordinator prep happens
2. Doctor clicks patient from OPD screen
3. **Summary panel appears at the top of the clinical view** — auto-generated from all available data
4. Doctor reads the summary, then proceeds with the visit

The summary panel is **not a separate page**. It lives at the top of the existing `/visit` or `/fu-review` or patient detail view — wherever the doctor currently sees patient data.

---

## 3. What Data Goes Into the Summary

The rule engine and AI summary use the following data, all of which should already be available via existing API endpoints or new ones added for the coordinator prep feature:

### From existing APIs:
- `GET /api/patients/:id` — demographics, file number
- `GET /api/appointments?patientId=:id` — visit history with dates
- Previous biomarker values (HbA1c, FG, BP, LDL, UACR, weight, TSH etc.)
- Current medications list with status (active / stopped / paused)
- Previous visit notes / plan

### From coordinator prep (new data added before visit):
- Latest biomarker values entered or extracted from uploaded lab report
- Medication compliance percentage per drug
- Self-stopped or changed medications (with reason)
- Lifestyle: exercise, diet, stress level
- Symptoms / complaints reported since last visit (via WhatsApp, phone, or app)
- Uploaded reports not yet reviewed by doctor

---

## 4. The Summary Panel — Three Zones

The panel has three colour-coded zones displayed in order of urgency:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔴  BEFORE YOU START — 3 items need your attention today        │
│                                                                 │
│  • UACR 88 mg/g (↑ from 62) — Ramipril not prescribed.        │
│    Protocol requires ACE inhibitor for UACR > 30 in T2DM.     │
│  • Glimepiride self-stopped 3 weeks ago (dizziness).           │
│    Glycaemic cover is incomplete — consider replacement.        │
│  • HbA1c 10.6% — rising for 3rd consecutive visit (9.2→10.6)  │
│    Current regimen is insufficient. Insulin/GLP-1 to consider. │
│                                                                 │
│ 🟡  ALSO CONSIDER                                               │
│  • eGFR not done this cycle — urgent given UACR trend           │
│  • Last fundus photography: Dec 2025 — annual review due        │
│                                                                 │
│ ✅  WORKING WELL — tell the patient                             │
│  • BP 142/90 — stable, not worsening despite poor overall ctrl  │
│  • Patient attended today after missing previous visit          │
└─────────────────────────────────────────────────────────────────┘
```

**Zone 1 — Red: Action needed today**
Things that require a clinical decision in this visit.

**Zone 2 — Amber: Consider this visit**
Things worth discussing but not urgent.

**Zone 3 — Green: Working well**
Positive signals to acknowledge — motivates patients when said out loud.

### Collapsed state (for Sustain patients with nothing urgent):
```
┌─────────────────────────────────────────────────────────────────┐
│ ✅  All parameters on track — routine visit   ▾ See details     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Rule Engine — Build This First

Before adding AI, build a deterministic rule engine. This runs server-side (or client-side if simpler) every time a patient record is opened. Rules produce structured alert objects. AI then converts those to readable language.

### Rule format:
```javascript
{
  id: "missing_ace_inhibitor",
  zone: "red",           // red | amber | green
  category: "protocol",  // protocol | trend | compliance | test_due | progress
  title: "ACE inhibitor not prescribed",
  detail: "UACR {uacr} mg/g. Protocol requires Ramipril for UACR > 30 in T2DM.",
  action: "Consider adding Ramipril 2.5mg OD"
}
```

### Rules to implement (start with these):

#### 🔴 RED RULES — action needed today

**R1 — Protocol gap: Missing ACE inhibitor**
```
IF patient has T2DM diagnosis
AND UACR latest value > 30
AND no active ACE inhibitor (Ramipril, Enalapril) or ARB (Telmisartan) in medications
THEN → "UACR {value} — Ramipril not prescribed. Protocol requires ACE/ARB for UACR > 30 in T2DM."
```

**R2 — HbA1c rising trend**
```
IF HbA1c(visit N) > HbA1c(visit N-1) > HbA1c(visit N-2)
THEN → "HbA1c rising for 3 consecutive visits ({v1}→{v2}→{v3}). Regimen review needed."
```

**R3 — HbA1c critically high**
```
IF latest HbA1c > 10
THEN → "HbA1c {value}% — critically elevated. Insulin initiation or intensification to consider."
```

**R4 — Self-stopped medication**
```
IF any medication has status = 'stopped' AND stopped_date within last 60 days
THEN → "{drug} stopped {n} days ago ({reason}). Glycaemic/treatment gap — discuss replacement."
```

**R5 — New unreviewed report**
```
IF documents collection has any entry where reviewed = false
THEN → "Unreviewed report uploaded by coordinator: {report_name}. Review before prescribing."
```

**R6 — Compliance critically low**
```
IF medication compliance for any drug < 50%
THEN → "{drug}: compliance reported at {pct}%. Discuss barriers — consider simpler regimen."
```

**R7 — BP uncontrolled with rising trend**
```
IF BP systolic latest > 150
AND BP systolic(visit N) > BP systolic(visit N-1)
THEN → "BP {value} — elevated and rising. Antihypertensive review needed."
```

**R8 — UACR worsening trajectory**
```
IF UACR(visit N) > UACR(visit N-1) > UACR(visit N-2)
THEN → "UACR worsening: {v1}→{v2}→{v3} mg/g. Nephropathy progressing. Urgent review."
```

#### 🟡 AMBER RULES — consider this visit

**A1 — Test overdue**
```
IF patient on Levothyroxine AND last TSH > 90 days ago
THEN → "TSH not checked in {n} days — patient on Levothyroxine. Add to today's orders."

IF patient has T2DM AND last HbA1c > 90 days ago
THEN → "HbA1c overdue — last done {n} days ago."

IF patient has T2DM AND age > 40 AND last fundus > 365 days ago
THEN → "Annual fundus photography due — last done {date}."

IF patient has T2DM AND last foot exam > 180 days ago
THEN → "Foot examination due — last done {date}."
```

**A2 — Metformin + renal risk**
```
IF Metformin in active medications
AND eGFR latest < 45 OR UACR > 60
THEN → "Metformin dose review — eGFR {value} or UACR elevated. Check dose safety."
```

**A3 — Phase change due**
```
IF HbA1c < 7.0 for last 2 consecutive visits AND current phase = "Stabilize"
THEN → "Phase review due — HbA1c at target for 2 visits. Consider moving to Sustain phase."

IF HbA1c between 7.5-9.0 AND trending down for 2 visits AND current phase = "Control"  
THEN → "Phase review due — improving trend. Consider moving to Stabilize phase."
```

**A4 — Insulin on high dose**
```
IF Insulin Glargine dose > 40 units AND HbA1c still > 8
THEN → "Glargine at {dose}u — HbA1c still {hba1c}%. Consider specialist review or basal-bolus."
```

**A5 — Moderate compliance**
```
IF overall medication compliance between 50-70%
THEN → "Compliance {pct}% — moderate. Discuss barriers. Simplify if possible."
```

**A6 — Symptom reported between visits**
```
IF any symptom/complaint logged by coordinator since last visit
THEN → "Coordinator log: '{symptom}' reported on {date}. Patient to discuss today."
```

#### ✅ GREEN RULES — working well

**G1 — Strong HbA1c improvement**
```
IF HbA1c improved by > 1.5% since last visit
THEN → "HbA1c improved by {delta}% since last visit ({prev}→{current}) — excellent response."
```

**G2 — HbA1c at target**
```
IF HbA1c < 7.0
THEN → "HbA1c {value}% — at target. Tell the patient — they've earned it."
```

**G3 — High compliance**
```
IF overall medication compliance > 90%
THEN → "Compliance {pct}% — excellent. Acknowledge this with the patient."
```

**G4 — Near remission**
```
IF HbA1c < 6.5 for 2+ consecutive visits
THEN → "HbA1c {value}% for 2+ visits — near remission range. Discuss dose reduction trial."
```

**G5 — BP controlled**
```
IF BP systolic < 130 AND patient has Hypertension diagnosis
THEN → "BP {value} — well controlled despite hypertension diagnosis."
```

---

## 6. AI Layer — The Language Generation

Once the rule engine produces a list of alert objects, pass them to the Anthropic API to generate a readable briefing paragraph. The rule objects are the facts; the AI provides the language.

### API call:

```javascript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    system: `You are a clinical assistant briefing Dr. Anil Bhansali before he sees a patient.
Be concise, specific, and clinical. Use exact numbers from the data provided.
Never be vague. Never use generic language. 
Format output as JSON with three arrays: red_alerts, amber_alerts, green_notes.
Each item is a single sentence. Maximum 3 items per zone.
Do not hallucinate — only use information explicitly provided.`,
    messages: [{
      role: "user",
      content: `Patient: ${patient.name}, ${patient.age}y, ${patient.gender}
Diagnoses: ${patient.diagnoses.join(', ')}
Latest HbA1c: ${bio.hba1c}% (prev: ${prevBio.hba1c}%)
Fasting Glucose: ${bio.fg} mg/dL
BP: ${bio.bp}
LDL: ${bio.ldl}, UACR: ${bio.uacr}, Weight: ${bio.weight}kg
Active medications: ${medications.active.map(m => m.name + ' ' + m.dose).join(', ')}
Stopped medications: ${medications.stopped.map(m => m.name + ' — ' + m.stopReason).join(', ')}
Compliance: ${compliance.overallPct}%
Symptoms reported since last visit: ${symptoms.recent.join(', ') || 'None'}
Rule engine alerts: ${JSON.stringify(ruleAlerts)}

Generate a clinical briefing for the doctor.`
    }]
  })
});
```

### Expected output format:
```json
{
  "red_alerts": [
    "UACR 88 mg/g rising for third visit — Ramipril not prescribed despite protocol requirement for UACR > 30.",
    "Glimepiride self-stopped 3 weeks ago — current regimen has no sulphonylurea or equivalent glycaemic cover."
  ],
  "amber_alerts": [
    "eGFR not done this cycle — urgent given UACR trajectory.",
    "Fundus photography last done Dec 2025 — annual review due."
  ],
  "green_notes": [
    "BP stable at 142/90 — not worsening despite poor overall control.",
    "Patient attended despite missing previous visit — compliance improving."
  ]
}
```

---

## 7. Where It Appears in the UI — Placement Rules

### Which views show the summary:
- `/visit` — always show (live visit)
- `/fu-review` — always show (follow-up review)
- `/fu-edit` — show collapsed only
- `/patient` — show if coming from OPD screen (pass `?from=opd` query param)

### Logic for panel state:
```
IF red_alerts.length > 0 → panel expanded, red border, 🔴 heading
ELSE IF amber_alerts.length > 0 → panel expanded, amber border, 🟡 heading
ELSE → panel collapsed to single green line, expandable
```

### Visual spec:
- Fixed at top of content area, below the patient header
- Does not scroll away — stays visible as doctor scrolls down
- Dismiss button (✕) to hide for this session if doctor wants clean screen
- Timestamp showing when summary was generated (e.g. "Generated 2 min ago from latest data")

---

## 8. New API Endpoints Needed

### For the coordinator prep data (feeds into summary):

```
POST /api/appointments/:id/biomarkers
Body: { hba1c, fg, bpSys, bpDia, ldl, tg, uacr, weight, waist, creatinine, tsh }

POST /api/appointments/:id/compliance  
Body: { medications: [{drugId, compliance_pct, status, stop_reason}], 
        diet, exercise, stress, symptoms: [string], life_events: [string] }

POST /api/appointments/:id/documents
Body: { file_url, document_type, extracted_values: {}, reviewed: false }
```

### For the summary itself:

```
GET /api/patients/:id/summary
Query params: ?appointmentId=:id
Returns: { red_alerts, amber_alerts, green_notes, generated_at, rule_alerts }
```

Generate and cache this server-side when:
1. Coordinator marks patient as "ready" / "prepped"
2. Doctor first opens the patient record for this appointment
3. Any new data is added (lab upload, compliance update)

Cache invalidates when new data is posted.

---

## 9. Database Changes (Supabase)

New columns / tables needed:

```sql
-- On appointments table, add:
prep_biomarkers JSONB          -- latest values entered by coordinator
prep_compliance JSONB          -- compliance data per medication
prep_symptoms TEXT[]           -- symptoms reported since last visit
prep_documents JSONB[]         -- uploaded files with reviewed flag
prep_status TEXT               -- 'pending' | 'partial' | 'ready'
ai_summary JSONB               -- cached summary { red, amber, green, generated_at }
ai_summary_generated_at TIMESTAMPTZ

-- New table: patient_rule_flags (optional, for audit)
CREATE TABLE patient_rule_flags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id TEXT,
  appointment_id UUID,
  rule_id TEXT,
  zone TEXT,
  triggered_at TIMESTAMPTZ DEFAULT NOW(),
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ
);
```

---

## 10. Build Order — What to Do First

1. **Rule engine** — write the 15 rules above as pure functions. No API calls. Input: patient data object. Output: array of alert objects. Test with hardcoded patient data.

2. **Summary API endpoint** — `GET /api/patients/:id/summary`. Runs the rule engine and returns structured output. No AI yet — just rules.

3. **UI component** — the summary panel with three zones, collapse/expand, dismiss button. Wire to the summary endpoint. Style as per spec above.

4. **Test with real patients** — open the top 10 patients in the current system and verify the rules are firing correctly. Adjust thresholds with Dr. Bhansali.

5. **AI language layer** — once rules are confirmed accurate, add the Anthropic API call to generate the readable language. API key already in the project (used in `/ai` route).

6. **Coordinator prep data** — add the new fields to the appointments table and wire the coordinator screen to POST this data. This is what makes the summary richer.

---

## 11. Reference Files

The following HTML prototypes (in this conversation) contain the UI design for the coordinator screen and clinical view. Use them as visual reference only — do not copy the hardcoded data:

- `gini-coordinator.html` — coordinator pre-visit workflow, compliance entry, biomarker entry
- `gini-scribe-v4.html` — clinical detail view including AI recommendations panel
- `gini-final.html` — combined appointment + clinical view

---

## 12. Key Clinical Rules from Dr. Bhansali — Do Not Change These

These are clinical decisions, not engineering decisions. Do not alter thresholds without explicit approval:

| Parameter | Red threshold | Amber threshold | Green threshold |
|---|---|---|---|
| HbA1c | > 10% or rising 3 visits | 7.5–10% | ≤ 7.0% |
| UACR | > 60 mg/g OR > 30 + no ACE/ARB | 30–60 mg/g | < 30 mg/g |
| BP Systolic | > 150 mmHg | 130–150 mmHg | < 130 mmHg |
| Compliance | < 50% | 50–79% | ≥ 80% |
| HbA1c trend | Rising 3 consecutive visits | Rising 2 visits | Falling |
| TSH check interval | — | > 90 days if on Levothyroxine | — |
| Fundus interval | — | > 365 days | — |
| Foot exam interval | — | > 180 days | — |

---

## 13. One-Line Summary for Claude Code

> "Add an intelligent patient summary panel to the top of the `/visit` and `/fu-review` views in Gini Scribe. The panel is generated by a rule engine (15 rules defined in this brief) that analyses the patient's latest biomarkers, medication compliance, and symptoms, then optionally passes the results to the Anthropic API to generate readable clinical language. Output is three zones: red (action needed today), amber (consider this visit), green (what's working). Panel is collapsed for routine patients, expanded automatically when red alerts exist. Build the rule engine first, UI second, AI third."

