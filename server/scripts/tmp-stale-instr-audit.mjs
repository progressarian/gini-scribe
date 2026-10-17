import "../loadEnv.js";
import fs from "node:fs";
import pool from "../config/db.js";
import { stripFormPrefix, canonicalMedKey } from "../services/medication/normalize.js";

const out = process.argv[2];
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const keyOf = (name) => canonicalMedKey(stripFormPrefix(name).name || name).slice(0, 200);
const c = await pool.connect();
const result = { clear: [], skip: {} };
const skip = (reason, row, extra = {}) => (result.skip[reason] ||= []).push({ id: row.id, patient_id: row.patient_id, name: row.name, instructions: row.instructions, ...extra });
try {
  await c.query("BEGIN READ ONLY");
  const { rows: meds } = await c.query(`
    SELECT m.id, m.patient_id, p.file_no, m.name, m.pharmacy_match, m.instructions, m.timing, m.dose, m.frequency,
           m.last_prescribed_date::text AS lpd, m.consultation_id
      FROM medications m JOIN patients p ON p.id = m.patient_id
     WHERE m.is_active AND m.source = 'healthray' AND COALESCE(btrim(m.instructions), '') <> ''`);
  const pids = [...new Set(meds.map((m) => m.patient_id))];
  const appts = new Map();
  const scribeAfter = new Map();
  for (let i = 0; i < pids.length; i += 200) {
    const ids = pids.slice(i, i + 200);
    const { rows } = await c.query(`
      SELECT id, patient_id, appointment_date::text AS d, healthray_medications AS meds
        FROM appointments
       WHERE patient_id = ANY($1) AND jsonb_typeof(healthray_medications) = 'array'
         AND jsonb_array_length(healthray_medications) > 0`, [ids]);
    for (const r of rows) (appts.get(r.patient_id) || appts.set(r.patient_id, []).get(r.patient_id)).push(r);
    const sc = await c.query(`
      SELECT patient_id, visit_date::text AS d,
             lower(regexp_replace(concat_ws(' ', con_data::text, mo_data::text, con_transcript, mo_transcript), '\\s+', ' ', 'g')) AS text
        FROM consultations WHERE patient_id = ANY($1)`, [ids]);
    for (const r of sc.rows) (scribeAfter.get(r.patient_id) || scribeAfter.set(r.patient_id, []).get(r.patient_id)).push(r);
  }
  for (const m of meds) {
    const key = m.pharmacy_match || keyOf(m.name);
    const hits = (appts.get(m.patient_id) || [])
      .flatMap((a) => a.meds.filter((e) => e?.name && keyOf(e.name) === key).map((e) => ({ d: a.d, id: a.id, e })))
      .sort((a, b) => (a.d === b.d ? b.id - a.id : a.d < b.d ? 1 : -1));
    if (!hits.length) { skip("no HealthRay entry found", m); continue; }
    const latest = hits[0];
    const latestNote = norm(latest.e.instructions);
    if (latestNote) {
      if (latestNote !== norm(m.instructions)) skip("latest HealthRay note differs (not blank)", m, { latest: latest.e.instructions, latestDate: latest.d });
      continue;
    }
    const current = (scribeAfter.get(m.patient_id) || []).filter((x) => x.d >= latest.d);
    const note = norm(m.instructions).replace(/\\n/g, " ");
    if (current.some((x) => x.text.includes(note) || x.text.replace(/\\n/g, " ").includes(note))) { skip("doctor's current visit text still has this note", m, { latestDate: latest.d }); continue; }
    const from = hits.find((h) => norm(h.e.instructions) === norm(m.instructions));
    if (!from) { skip("note not from any HealthRay visit", m, { latestDate: latest.d }); continue; }
    if (latest.d !== m.lpd) { skip("latest HealthRay date != last prescribed date", m, { latestDate: latest.d, lpd: m.lpd }); continue; }
    result.clear.push({ id: m.id, patient_id: m.patient_id, file_no: m.file_no, name: m.name, timing: m.timing, frequency: m.frequency,
      consultation_id: m.consultation_id, has_consult_text: current.length > 0, old_note: m.instructions, note_from: from.d, latest: latest.d, latest_timing: latest.e.timing });
  }
  await c.query("ROLLBACK");
} finally { c.release(); await pool.end(); }
fs.writeFileSync(out, JSON.stringify(result, null, 1));
console.log("candidates scanned; clear:", result.clear.length, "patients:", new Set(result.clear.map((r) => r.patient_id)).size);
for (const [k, v] of Object.entries(result.skip)) console.log("skip:", k, v.length);
