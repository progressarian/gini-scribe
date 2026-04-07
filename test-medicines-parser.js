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
- For labs: extract ALL lab values
- For medications: parse CURRENT/TREATMENT medications. Also look for medications where dose has CHANGED (e.g. "NMZ 10 to NMZ 20") — the OLD dose should be in previous_medications.
- For previous_medications: extract from "PREVIOUS MEDICATION" section + ANY medicines with dose/frequency changes. Capture: old/previous dose, medication name, status ("stopped" or "changed"), and reason (e.g. "dose increased from 10mg to 20mg"). If dose changed (e.g. NMZ 10 became NMZ 20), extract NMZ 10 as previous_medication with reason "dose changed".
- For diagnoses: extract each condition separately
- For vitals: extract HT/WT/BMI/BP/WC/BF if mentioned
- For follow_up: extract follow-up timing and notes. Null fields if not found
- Return ONLY valid JSON, no markdown`;

async function testParser() {
  try {
    console.log("Testing medicine extraction with updated prompt...\n");
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

    try {
      const parsed = JSON.parse(rawJSON);
      console.log("💊 CURRENT MEDICATIONS extracted:\n");
      (parsed.medications || []).forEach((m, i) => {
        console.log(`  ${i + 1}. ${m.name} - ${m.dose || "N/A"} ${m.frequency || ""}`);
      });

      console.log("\n📌 PREVIOUS MEDICATIONS extracted:\n");
      if (!parsed.previous_medications || parsed.previous_medications.length === 0) {
        console.log("  ⚠️  None extracted");
      } else {
        (parsed.previous_medications || []).forEach((m, i) => {
          console.log(`  ${i + 1}. ${m.name} - ${m.dose || "N/A"} (Status: ${m.status})`);
          console.log(`     Reason: ${m.reason || "N/A"}`);
        });
      }

      console.log(
        '\n✅ Result: NMZ 10 mg should be in previous_medications with reason "dose changed to 20mg"',
      );
    } catch {
      console.log("Response:", rawJSON);
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

testParser();
