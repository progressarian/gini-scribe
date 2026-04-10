// One-time fix: inject Om Tiwari (P_150200) notes and re-sync diagnoses + medications
// Run with: node fix-om-tiwari.mjs

const BASE = "http://localhost:3001";
const FILE_NO = "P_145840";
const DATE = "2026-01-09";

const notes = `DIAGNOSIS
INTENSIVE DIABETES MANAGEMENT PROGRAM
ADOLESCENT OBESITY (90TH PERCENTILE)
SMOLDERING TYPE 1 DM ( SINCE MARCH 2024) AOO 17
LEAN PHENOTYPE, HBA1C 12.2%, C-PEPTIDE 2.29
GAD 65 DUBIOUS (WAS POSITIVE EARLIER, IAA, IA-2 NEGATIVE)
PRESENTLY IN HONEYMOON PHASE
OVERWEIGHT
NEUROPATHY POSITIVE, NEPHROPATHY (G1A1), RETINOPATHY
CAD NEGATIVE, CVA NEGATIVE, PVD NEGATIVE

FOLLOW UP ON 28/1/26
HBA1C 8.3
FBG 173
C PEPTIDE 2.89
INSULIN 10.7
HOMA IR 4.6
HOMA BETA 35
TG 143
LDL 79.4
NHDL 89

TREATMENT:
INJ RYZODEG ONCE DAILY SC 5 UNIT 30 MIN BEFORE DINNER
INCREASE PRE DINNER DOSE BY 2 UNITS UNTIL POST DINNER BLOOD GLUCOSE 140-180 MG/DL
TAB DAPLO SM 10/100/500MG 30 MIN BEFORE BREAKFAST (DAPAGLIFLOZIN 10MG + SITAGLIPTIN 100MG + METFORMIN 500MG)
AB AKTIV-D 60000 UNITS ONCE IN 15 DAYS WITH HALF GLASS OF MILK AT BEDTIME
PROTEIN POWDER

PREVIOUS MEDICATION:
INJ EGLUCENT 8-8-8 UNIT TID (STOPPED)
INJ BASUGINE 10 UNIT OD (STOPPED)

VITAL SIGNS:
HEIGHT 170 CM
WEIGHT 77.2 KG
BMI 26.63
BODY FAT 25.64 PERCENT
WAIST CIRCUMFERENCE 85 CM
BP SITTING 120/83
BP STANDING 114/79`;

async function run() {
  // Step 0: Show appointment + notes status
  console.log("── Patient / appointment info ──");
  const ptRes = await fetch(`${BASE}/api/sync/debug/patient/${FILE_NO}`);
  const ptData = await ptRes.json();
  console.log(JSON.stringify(ptData, null, 2));

  // Step 1: Show current state
  console.log("\n── Current diagnoses in DB ──");
  const dxRes = await fetch(`${BASE}/api/sync/debug/diagnoses/${FILE_NO}`);
  const dxData = await dxRes.json();
  for (const d of dxData.diagnoses) {
    console.log(`  [${d.is_active ? "ACTIVE" : "inactive"}] id=${d.id}  diagnosis_id="${d.diagnosis_id}"  label="${d.label}"  status="${d.status}"`);
  }

  console.log("\n── Current meds in DB ──");
  const medsRes = await fetch(`${BASE}/api/sync/debug/meds/${FILE_NO}`);
  const medsData = await medsRes.json();
  for (const m of (medsData.medications || medsData.meds || medsData)) {
    console.log(`  [${m.is_active ? "ACTIVE" : "inactive"}] id=${m.id}  name="${m.name}"  dose="${m.dose}"  pharmacy_match="${m.pharmacy_match}"`);
  }

  // Step 2: Ask before deleting
  console.log("\nPaste the IDs of rows to DELETE (comma-separated), or press Enter to skip:");
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(r => rl.question("> ", r));
  rl.close();

  if (answer.trim()) {
    const ids = answer.split(",").map(s => Number(s.trim())).filter(Boolean);
    console.log("Deleting IDs:", ids);
    const delRes = await fetch(`${BASE}/api/sync/debug/delete-diagnoses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const delData = await delRes.json();
    console.log("Delete result:", JSON.stringify(delData, null, 2));
  } else {
    console.log("No deletions.");
  }
}

run().catch(console.error);
