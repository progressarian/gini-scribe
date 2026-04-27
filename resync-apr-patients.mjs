// For every patient with an appointment on Apr 27, 28, 29, or 30 2026,
// trigger the full per-patient resync via the local API. This clears the
// JSONB fast-path on each of their appointments and re-parses every
// clinical note through Claude with the new temperature: 0 + brand/unit
// fidelity prompt.

process.env.DATABASE_URL =
  "postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres";

const { default: pool } = await import("./server/config/db.js");

const API = process.env.API_BASE || "http://localhost:3001";
const DATES = ["2026-04-27", "2026-04-28", "2026-04-29", "2026-04-30"];

const { rows: patients } = await pool.query(
  `SELECT DISTINCT p.id, p.file_no, p.name
   FROM appointments a
   JOIN patients p ON p.id = a.patient_id
   WHERE a.appointment_date = ANY($1::date[])
   ORDER BY p.id`,
  [DATES],
);

console.log(`Found ${patients.length} unique patients with appointments on ${DATES.join(", ")}\n`);

let ok = 0;
let err = 0;
for (let i = 0; i < patients.length; i++) {
  const p = patients[i];
  if (!p.file_no) {
    console.log(`[${i + 1}/${patients.length}] SKIP id=${p.id} (${p.name}) — no file_no`);
    continue;
  }
  try {
    const resp = await fetch(`${API}/api/sync/patient/${encodeURIComponent(p.file_no)}/resync`, {
      method: "POST",
    });
    const body = await resp.json();
    if (resp.ok && body.success) {
      ok++;
      console.log(
        `[${i + 1}/${patients.length}] ✅ ${p.file_no} (${p.name}) — cleared=${body.clearedAppointments} reparsed=${body.reparsed} errors=${body.errors}`,
      );
    } else {
      err++;
      console.log(`[${i + 1}/${patients.length}] ✗ ${p.file_no}: ${JSON.stringify(body)}`);
    }
  } catch (e) {
    err++;
    console.log(`[${i + 1}/${patients.length}] ✗ ${p.file_no}: ${e.message}`);
  }
  // throttle so we don't hammer Claude or the local server
  await new Promise((r) => setTimeout(r, 500));
}

console.log(`\nDone. ok=${ok} errors=${err}`);
await pool.end();
