import dotenv from "dotenv";

dotenv.config({ path: "server/.env" });

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const clinicalText = `GRAVES' DISEASE OVERT AGOITROUS THYROTOXICOSIS CAS 0/7 SS MILD DERMOPATHY NIL FOLLOW UP TODAY ON 07/04/2026 PREVIOUS MEDICATION: NMZ 10 FOR LAST 3 DAYS BRIEF HISTORYPT HAD C/O WT GAIN FOR LAST 5 YEARS, ON ROUTINE TESTING TSH: <0.01, T4: 11.12, T3: 2.314, FT4: 2.431, FT3: 8.701 AND ANTI TSHR: 10.57. OBSERVATION: F/H/O AITD: S. DM: F. NO H/O COVID, VACCINATED+ LSCS 5 YEARS BACK ANTI TSHR: 10.57 TSH:0.005, T4: 14.5, T3: 269.8 TREMOR: + HR: 120 HANDS WARM AND MOIST THYROID SCAN: INCREASED UPTAKE S/O DIFFUSE TOXIC GOITRE(9.8% UPTAKE) TREATMENT TAB NMZ 20MG AT 8AM TAB CIPLAR LA 40MG AT 8AM AND 8PM TAB RACAL XT ONE TAB AFTER DINNER. TAB PANTOCID DSR 30MIN BEFORE BREAKFAST FOR 15 DAYS TEAR FRESH DROPS ADVICE: ANTI TSHR AFTER 3 MONTHS FOLLOW UP AFTER 6 WEEKS WITH TSH ,T4 ,T3`;

const prompt = `Parse this clinical note into structured JSON. Extract ONLY data present in the text.

Return JSON with these keys:
{
  "diagnoses": [{"name": "...", "details": "...", "since": "..."}],
  "labs": [{"test": "...", "value": "...", "unit": "...", "date": "..."}],
  "medications": [{"name": "...", "dose": "...", "frequency": "...", "timing": "...", "route": "Oral", "is_new": false}],
  "previous_medications": [{"name": "...", "dose": "...", "frequency": "...", "status": "stopped/changed", "reason": "..."}],
  "vitals": {"height": null, "weight": null, "bmi": null, "bpSys": null, "bpDia": null, "waist": null, "bodyFat": null},
  "lifestyle": {"diet": null, "exercise": null, "smoking": null, "alcohol": null, "stress": null},
  "investigations_to_order": [{"name": "...", "urgency": "urgent/routine/next_visit"}],
  "follow_up": {"date": null, "timing": null, "notes": null},
  "advice": "..."
}

STRICT Rules:
- NEVER invent or assume data. If a field is not explicitly mentioned in the text, set it to null. Do NOT fill fields with unrelated data.
- For labs: extract ALL lab values with test name, numeric value, unit. Include HbA1c, FBG, PPBG, LDL, TG, TSH, T3, T4, Creatinine, eGFR, UACR, Hb, Iron, Ferritin, OT/SGOT, PT/SGPT, ALP, Calcium, Albumin, etc. For the date field in labs, ALWAYS use YYYY-MM-DD format (e.g. "2026-04-03" for April 3rd 2026). If date is ambiguous or not present, set to null.
- For medications: parse CURRENT/TREATMENT medications with name, dose, frequency (OD/BD/TDS etc), timing (before/after food etc), route (Oral/SC/IV/IM etc). Set is_new=true if it's a new addition
- For previous_medications: extract medications from "PREVIOUS MEDICATION" section that were stopped/changed. Include reason if mentioned (e.g. side effect, replaced, discontinued)
- For diagnoses: extract each condition separately. Include clinical findings like tremor, observations, scan findings (e.g., diffuse toxic goitre). Include weight gain as a complaint/diagnosis if mentioned.
- For vitals: extract HT/WT/BMI/BP/WC/BF if mentioned
- For lifestyle: SPLIT into separate fields. Set to null if not found
- For advice: glucose monitoring instructions, TSH targets, medication holds, insulin dose adjustments, other clinical instructions. Null if not found
- For investigations_to_order: extract ALL tests/investigations ordered or recommended. Set urgency to "urgent" if marked urgent, "next_visit" if scheduled for next visit, "routine" otherwise. [] if none found
- For follow_up: extract follow-up date (YYYY-MM-DD if exact date given), timing (e.g. "1 month", "3 months"), and any notes. Null fields if not found
- Only include the LATEST follow-up data if multiple follow-ups exist
- Return ONLY valid JSON, no markdown`;

async function testParser() {
  try {
    console.log("Sending clinical notes to Claude AI for parsing...\n");
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: `${prompt}\n\nClinical Note:\n${clinicalText}` }],
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error("API Error:", data);
      return;
    }

    const rawJSON = data.content[0].text;
    console.log("📋 AI Response:\n");
    console.log(rawJSON);

    // Try to parse JSON
    try {
      const parsed = JSON.parse(rawJSON);
      console.log("\n✅ Parsed JSON:\n");
      console.log(JSON.stringify(parsed, null, 2));

      console.log("\n🔍 ANALYSIS:");
      console.log(`   Diagnoses extracted: ${parsed.diagnoses?.length || 0}`);
      parsed.diagnoses?.forEach((d) => console.log(`   - ${d.name}`));
      console.log(`   Previous medications: ${parsed.previous_medications?.length || 0}`);
      console.log(`   Current medications: ${parsed.medications?.length || 0}`);
      console.log(`   Labs: ${parsed.labs?.length || 0}`);
    } catch {
      console.log("⚠️ Could not parse JSON");
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

testParser();
