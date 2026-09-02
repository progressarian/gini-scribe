import "../loadEnv.js";
import pool from "../config/db.js";
import {
  promoteVitals,
  promoteLabReport,
  backfillPromotions,
} from "../services/giniflow/promote.js";

// Promotion into the shared clinical record — 06-PHASE-2-PLAN.md question 12.
//
//   node scripts/smoke-giniflow-promote.mjs
//
// The assertion that matters is the SECOND call. Both original migrations
// refused to write `vitals` and `documents` because "a third writer while two
// floor modules run in parallel invites the same patient being recorded twice".
// Promotion is only safe if that cannot happen — so every check here runs twice
// and asserts the row count did not move.

let failed = 0;
const ok = (label, cond, detail = "") => {
  console.log(`  ${cond ? "ok " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
};

const cleanup = [];

try {
  // A real visit to hang the test rows off, so the joins are exercised.
  const { rows: visits } = await pool.query(
    `SELECT v.id, v.patient_id FROM giniflow_visits v ORDER BY v.visit_date DESC LIMIT 1`,
  );
  if (!visits.length) throw new Error("no giniflow_visits to test against");
  const { id: visitId, patient_id: patientId } = visits[0];

  console.log("\nvitals");

  const { rows: gv } = await pool.query(
    `INSERT INTO giniflow_vitals (visit_id, patient_id, weight, height, bmi, bp_sys, bp_dia, pulse, source)
     VALUES ($1,$2,71.5,170,24.7,138,86,78,'manual') RETURNING id`,
    [visitId, patientId],
  );
  const vitalsId = gv[0].id;
  cleanup.push(() => pool.query(`DELETE FROM vitals WHERE giniflow_vitals_id = $1`, [vitalsId]));
  cleanup.push(() => pool.query(`DELETE FROM giniflow_vitals WHERE id = $1`, [vitalsId]));

  const first = await promoteVitals(vitalsId);
  ok("a station reading reaches `vitals`", first.promoted, `vitals.id ${first.vitalsId}`);

  const { rows: copied } = await pool.query(
    `SELECT bp_sys, bp_dia, weight, bmi, source, appointment_id FROM vitals WHERE giniflow_vitals_id = $1`,
    [vitalsId],
  );
  // Number(): `vitals.bp_sys` is NUMERIC, and node-postgres returns numeric as a
  // string to avoid silent float precision loss. `giniflow_vitals.bp_sys` is INT
  // and comes back as a number — so the two tables genuinely differ in type, and
  // an assertion written against the wrong one fails while printing the right
  // value.
  ok(
    "the numbers arrive intact",
    Number(copied[0]?.bp_sys) === 138 && Number(copied[0]?.weight) === 71.5,
    `BP ${copied[0]?.bp_sys}/${copied[0]?.bp_dia} · ${copied[0]?.weight} kg`,
  );
  ok("and are marked as ours, not HealthRay's", copied[0]?.source === "giniflow");

  const { rows: stamped } = await pool.query(
    `SELECT promoted_at FROM giniflow_vitals WHERE id = $1`,
    [vitalsId],
  );
  ok("promoted_at is stamped", !!stamped[0].promoted_at);

  const second = await promoteVitals(vitalsId);
  const { rows: count } = await pool.query(
    `SELECT count(*)::int n FROM vitals WHERE giniflow_vitals_id = $1`,
    [vitalsId],
  );
  ok("promoting twice writes ONE row", count[0].n === 1, `${count[0].n} row(s)`);
  ok("and returns the same clinical row", second.vitalsId === first.vitalsId);

  // A corrected reading must update the copy, not leave a stale one behind.
  await pool.query(`UPDATE giniflow_vitals SET bp_sys = 122, bp_dia = 78 WHERE id = $1`, [
    vitalsId,
  ]);
  await promoteVitals(vitalsId);
  const { rows: fixed } = await pool.query(
    `SELECT bp_sys FROM vitals WHERE giniflow_vitals_id = $1`,
    [vitalsId],
  );
  ok(
    "a corrected reading updates the same row",
    Number(fixed[0].bp_sys) === 122,
    `BP ${fixed[0].bp_sys}`,
  );

  // The three rows on record carry a height and nothing else.
  const { rows: empty } = await pool.query(
    `INSERT INTO giniflow_vitals (visit_id, patient_id, height, source)
     VALUES ($1,$2,170,'manual') RETURNING id`,
    [visitId, patientId],
  );
  cleanup.push(() => pool.query(`DELETE FROM giniflow_vitals WHERE id = $1`, [empty[0].id]));
  const skipped = await promoteVitals(empty[0].id);
  ok("a height-only row is NOT promoted", !skipped.promoted, skipped.reason);

  console.log("\nlab reports");

  const { rows: order } = await pool.query(
    `INSERT INTO giniflow_lab_orders (visit_id, ordered_by, urgency, payment_status, sample_status, report_file_url, uploaded_at)
     VALUES ($1, NULL, 'today', 'paid', 'uploaded',
             'https://x.supabase.co/storage/v1/object/patient-files/giniflow/lab/1/999_report.pdf', NOW())
     RETURNING id`,
    [visitId],
  );
  const orderId = order[0].id;
  cleanup.push(() =>
    pool.query(`DELETE FROM documents WHERE giniflow_lab_order_id = $1`, [orderId]),
  );
  cleanup.push(() => pool.query(`DELETE FROM giniflow_lab_orders WHERE id = $1`, [orderId]));

  await pool.query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1,'HbA1c',400)`,
    [orderId],
  );

  const r1 = await promoteLabReport(orderId);
  ok("an uploaded report reaches `documents`", r1.promoted, `documents.id ${r1.documentId}`);

  const { rows: doc } = await pool.query(
    `SELECT doc_type, title, storage_path, file_url, mime_type, source
       FROM documents WHERE giniflow_lab_order_id = $1`,
    [orderId],
  );
  ok(
    "the bucket is stripped from the path",
    doc[0]?.storage_path === "giniflow/lab/1/999_report.pdf",
    doc[0]?.storage_path,
  );
  ok("file_url stays null — the bucket is private", doc[0]?.file_url === null);
  ok("the tests name the document", doc[0]?.title === "Lab report — HbA1c", doc[0]?.title);

  await promoteLabReport(orderId);
  const { rows: docCount } = await pool.query(
    `SELECT count(*)::int n FROM documents WHERE giniflow_lab_order_id = $1`,
    [orderId],
  );
  ok(
    "re-uploading replaces, never duplicates",
    docCount[0].n === 1,
    `${docCount[0].n} document(s)`,
  );

  // The legacy public-URL shape, which the one report already on file carries.
  await pool.query(
    `UPDATE giniflow_lab_orders
        SET report_file_url = 'https://x.supabase.co/storage/v1/object/public/patient-files/giniflow/lab/1/998_old.png'
      WHERE id = $1`,
    [orderId],
  );
  await promoteLabReport(orderId);
  const { rows: legacy } = await pool.query(
    `SELECT storage_path, mime_type FROM documents WHERE giniflow_lab_order_id = $1`,
    [orderId],
  );
  ok(
    "the pre-fix public URL shape still resolves",
    legacy[0].storage_path === "giniflow/lab/1/998_old.png",
    legacy[0].storage_path,
  );
  ok("and a PNG is not called a PDF", legacy[0].mime_type === "image/png", legacy[0].mime_type);

  console.log("\nbackfill");
  await pool.query(`UPDATE giniflow_vitals SET promoted_at = NULL WHERE id = $1`, [vitalsId]);
  const swept = await backfillPromotions({ since: null });
  ok("the sweep picks up an unpromoted reading", swept.vitals >= 1, JSON.stringify(swept));
  const { rows: afterSweep } = await pool.query(
    `SELECT count(*)::int n FROM vitals WHERE giniflow_vitals_id = $1`,
    [vitalsId],
  );
  ok("and still leaves exactly one row", afterSweep[0].n === 1, `${afterSweep[0].n} row(s)`);
} catch (e) {
  console.error("\nsmoke failed:", e.message);
  failed++;
} finally {
  for (const undo of cleanup.reverse()) {
    await undo().catch(() => {});
  }
  console.log(failed ? `\n${failed} check(s) failed\n` : "\nall checks passed\n");
  await pool.end();
  process.exitCode = failed ? 1 : 0;
}
