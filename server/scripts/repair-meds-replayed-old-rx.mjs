import "../loadEnv.js";
import pool from "../config/db.js";
import { maybeAutoSavePrescription } from "../services/healthray/db.js";

const [date] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const apply = process.argv.includes("--apply");
const reissue = process.argv.includes("--reissue");
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
  console.error(
    "Usage: node scripts/repair-meds-replayed-old-rx.mjs <YYYY-MM-DD> [--apply] [--reissue]",
  );
  process.exit(1);
}

const KEY = `UPPER(COALESCE(pharmacy_match, name))`;
const canon = (name) => String(name || "").toUpperCase();

const { rows: visits } = await pool.query(
  `SELECT a.id AS appointment_id, a.patient_id, a.healthray_id, a.consultation_id,
          a.opd_medications, p.file_no, p.name, c.created_at AS seen_at,
          bad.first_at AS replayed_at
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     LEFT JOIN consultations c ON c.id = a.consultation_id
     JOIN LATERAL (
       SELECT min(m.updated_at) AS first_at FROM medications m
        WHERE m.patient_id = a.patient_id
          AND m.notes = 'healthray:' || a.healthray_id
          AND m.is_active = false
          AND m.stop_reason = 'Not in latest prescription'
          AND m.updated_at >= $1::date
     ) bad ON bad.first_at IS NOT NULL
    WHERE a.appointment_date = $1::date
      AND a.healthray_id IS NOT NULL
      AND a.status IN ('completed', 'seen')
    ORDER BY p.file_no`,
  [date],
);

console.log(
  `${apply ? "APPLY" : "DRY RUN"}: ${visits.length} patient(s) whose ${date} medicines were switched off by an older prescription`,
);
const skipped = [];
let failed = 0;
for (const v of visits) {
  const snapshot = Array.isArray(v.opd_medications) ? v.opd_medications : [];
  console.log(`\n=== ${v.file_no} ${v.name} (appointment ${v.appointment_id})`);
  if (!v.seen_at || !snapshot.length || new Date(v.seen_at) >= new Date(v.replayed_at)) {
    console.log("  SKIPPED: no medicine snapshot taken before the bad run — review by hand");
    skipped.push(v.file_no);
    continue;
  }
  const wanted = new Set(snapshot.map((m) => canon(m.name)));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: meds } = await client.query(
      `SELECT id, name, source, is_active, notes, ${KEY} AS k, updated_at
         FROM medications WHERE patient_id = $1 ORDER BY updated_at DESC, id DESC`,
      [v.patient_id],
    );
    const activeKeys = new Set(meds.filter((m) => m.is_active).map((m) => m.k));
    const inactiveKeys = new Set(meds.filter((m) => !m.is_active).map((m) => m.k));
    const matchesWanted = (m) => wanted.has(m.k) || wanted.has(canon(m.name));

    const toStop = meds.filter((m) => m.is_active && m.source === "healthray" && !matchesWanted(m));
    const stopConflicts = toStop.filter((m) => inactiveKeys.has(m.k));
    const stopNow = toStop.filter((m) => !inactiveKeys.has(m.k));

    const toRestore = [];
    const missing = [];
    for (const m of snapshot) {
      const k = canon(m.name);
      if (
        [...activeKeys].some((a) => a === k) ||
        meds.some((r) => r.is_active && canon(r.name) === k)
      )
        continue;
      const row = meds.find((r) => !r.is_active && (r.k === k || canon(r.name) === k));
      if (row) toRestore.push(row);
      else missing.push(m.name);
    }

    console.log(
      `  correct list (seen ${new Date(v.seen_at).toTimeString().slice(0, 5)}): ${snapshot.map((m) => m.name).join(", ")}`,
    );
    console.log(`  switch back on: ${toRestore.map((m) => m.name).join(", ") || "none"}`);
    console.log(
      `  stop (old medicines switched back on): ${stopNow.map((m) => `${m.name} [${m.notes}]`).join(", ") || "none"}`,
    );
    if (stopConflicts.length) {
      console.log(
        `  REVIEW (an inactive copy already exists, left active): ${stopConflicts.map((m) => m.name).join(", ")}`,
      );
    }
    if (missing.length) console.log(`  REVIEW (no row to switch back on): ${missing.join(", ")}`);

    for (const m of toRestore) {
      await client.query(
        `UPDATE medications SET is_active = true, stopped_date = NULL, stop_reason = NULL, updated_at = NOW()
          WHERE id = $1 AND is_active = false`,
        [m.id],
      );
    }
    for (const m of stopNow) {
      await client.query(
        `UPDATE medications SET is_active = false, stopped_date = $2::date,
                stop_reason = 'Not in latest prescription', updated_at = NOW()
          WHERE id = $1 AND is_active = true`,
        [m.id, date],
      );
    }
    if (v.consultation_id) {
      await client.query(
        `UPDATE medications SET consultation_id = $1
          WHERE patient_id = $2 AND is_active = true AND notes = 'healthray:' || $3::text
            AND (consultation_id IS NULL OR consultation_id <> $1)`,
        [v.consultation_id, v.patient_id, String(v.healthray_id)],
      );
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
  } catch (e) {
    await client.query("ROLLBACK");
    failed++;
    console.error(`  ${v.file_no}: stopped, nothing changed for this patient — ${e.message}`);
    client.release();
    break;
  }
  client.release();
  if (apply && reissue) {
    await maybeAutoSavePrescription(v.appointment_id);
    console.log("  prescription re-issued");
  }
}
await pool.end();
if (skipped.length) console.log(`\nSkipped for review: ${skipped.join(", ")}`);
if (!apply) {
  console.log(
    "\nDry run: rolled back, nothing changed. Re-run with --apply (and --reissue to remake the prescriptions).",
  );
} else {
  console.log(failed ? "\nStopped on an error; rerun after fixing it." : "\nDone.");
}
if (failed) process.exitCode = 1;
