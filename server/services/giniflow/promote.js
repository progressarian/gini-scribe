import pool from "../../config/db.js";
import { t as clipText } from "../../utils/helpers.js";
export async function promoteVitals(giniflowVitalsId, db = pool) {
  const { rows } = await db.query(
    `SELECT gv.id, gv.patient_id, gv.weight, gv.height, gv.bmi, gv.bp_sys, gv.bp_dia,
            gv.bp_standing_sys, gv.bp_standing_dia, gv.waist, gv.body_fat,
            gv.pulse, gv.spo2, gv.temp, gv.recorded_at, gv.source,
            v.appointment_id, v.visit_date::text AS visit_date
       FROM giniflow_vitals gv
       JOIN giniflow_visits v ON v.id = gv.visit_id
      WHERE gv.id = $1`,
    [giniflowVitalsId],
  );
  if (!rows.length) return { promoted: false, reason: "not found" };
  const r = rows[0];
  const measured = [
    r.bp_sys,
    r.bp_dia,
    r.bp_standing_sys,
    r.bp_standing_dia,
    r.waist,
    r.body_fat,
    r.pulse,
    r.spo2,
    r.temp,
    r.weight,
    r.bmi,
  ];
  if (measured.every((v) => v === null || v === undefined)) {
    return { promoted: false, reason: "nothing measured — height alone is not a reading" };
  }

  const { rows: written } = await db.query(
    `INSERT INTO vitals
       (patient_id, appointment_id, recorded_at, bp_sys, bp_dia, pulse, temp, spo2,
        weight, height, bmi, source, giniflow_vitals_id, bp_standing_sys, bp_standing_dia, waist,
        body_fat)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'giniflow',$12,$13,$14,$15,$16)
     ON CONFLICT (giniflow_vitals_id) WHERE giniflow_vitals_id IS NOT NULL
     DO UPDATE SET bp_sys = EXCLUDED.bp_sys, bp_dia = EXCLUDED.bp_dia,
                   pulse = EXCLUDED.pulse, temp = EXCLUDED.temp, spo2 = EXCLUDED.spo2,
                   weight = EXCLUDED.weight, height = EXCLUDED.height, bmi = EXCLUDED.bmi,
                   bp_standing_sys = EXCLUDED.bp_standing_sys,
                   bp_standing_dia = EXCLUDED.bp_standing_dia,
                   waist = EXCLUDED.waist,
                   body_fat = EXCLUDED.body_fat,
                   recorded_at = EXCLUDED.recorded_at
     RETURNING id`,
    [
      r.patient_id,
      r.appointment_id,
      r.recorded_at,
      r.bp_sys,
      r.bp_dia,
      r.pulse,
      r.temp,
      r.spo2,
      r.weight,
      r.height,
      r.bmi,
      r.id,
      r.bp_standing_sys,
      r.bp_standing_dia,
      r.waist,
      r.body_fat,
    ],
  );

  await db.query(`UPDATE giniflow_vitals SET promoted_at = NOW() WHERE id = $1`, [r.id]);
  return { promoted: true, vitalsId: written[0].id };
}

export async function promoteLabReport(orderId, db = pool) {
  const { rows } = await db.query(
    `SELECT o.id, o.report_file_url, o.uploaded_at, v.patient_id,
            v.visit_date::text AS visit_date,
            (SELECT string_agg(t.test_name, ', ' ORDER BY t.test_name)
               FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS tests
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!rows.length) return { promoted: false, reason: "not found" };
  const r = rows[0];
  if (!r.report_file_url) return { promoted: false, reason: "no report uploaded" };

  const marker = "/storage/v1/object/";
  const at = r.report_file_url.indexOf(marker);
  if (at < 0) return { promoted: false, reason: "unreadable report path" };
  const withBucket = r.report_file_url.slice(at + marker.length).replace(/^public\//, "");
  const storagePath = withBucket.slice(withBucket.indexOf("/") + 1);
  const fileName = storagePath.split("/").pop() || "report.pdf";
  const ext = fileName.split(".").pop()?.toLowerCase();
  const mime =
    { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" }[ext] ||
    "application/octet-stream";

  const { rows: written } = await db.query(
    `INSERT INTO documents
       (patient_id, doc_type, title, file_name, storage_path, mime_type, doc_date,
        source, notes, giniflow_lab_order_id)
     VALUES ($1,'lab_report',$2,$3,$4,$5,$6::date,'giniflow_lab',$7,$8)
     ON CONFLICT (giniflow_lab_order_id) WHERE giniflow_lab_order_id IS NOT NULL
     DO UPDATE SET storage_path = EXCLUDED.storage_path, file_name = EXCLUDED.file_name,
                   mime_type = EXCLUDED.mime_type, title = EXCLUDED.title,
                   doc_date = EXCLUDED.doc_date, notes = EXCLUDED.notes
     RETURNING id`,
    [
      r.patient_id,
      clipText(r.tests ? `Lab report — ${r.tests}` : "Lab report", 200),
      clipText(fileName, 200),
      storagePath,
      mime,
      r.visit_date,
      r.tests || null,
      r.id,
    ],
  );

  await db.query(`UPDATE giniflow_lab_orders SET promoted_at = NOW() WHERE id = $1`, [orderId]);
  return { promoted: true, documentId: written[0].id };
}

export function promoteQuietly(fn, id) {
  return fn(id).catch((e) => console.warn(`[giniflow promote] ${id}:`, e?.message || e));
}

export async function backfillPromotions({ since = null } = {}, db = pool) {
  const { rows: vitals } = await db.query(
    `SELECT gv.id FROM giniflow_vitals gv
       JOIN giniflow_visits v ON v.id = gv.visit_id
      WHERE gv.promoted_at IS NULL
        AND ($1::date IS NULL OR v.visit_date >= $1::date)
      ORDER BY gv.recorded_at`,
    [since],
  );
  const { rows: reports } = await db.query(
    `SELECT o.id FROM giniflow_lab_orders o
      JOIN giniflow_visits v ON v.id = o.visit_id
     WHERE o.promoted_at IS NULL AND o.report_file_url IS NOT NULL
       AND ($1::date IS NULL OR v.visit_date >= $1::date)
     ORDER BY o.uploaded_at`,
    [since],
  );

  const done = { vitals: 0, reports: 0, failed: 0 };
  for (const v of vitals) {
    try {
      if ((await promoteVitals(v.id, db)).promoted) done.vitals++;
    } catch (e) {
      done.failed++;
      console.warn("[giniflow promote] vitals", v.id, e.message);
    }
  }
  for (const o of reports) {
    try {
      if ((await promoteLabReport(o.id, db)).promoted) done.reports++;
    } catch (e) {
      done.failed++;
      console.warn("[giniflow promote] report", o.id, e.message);
    }
  }
  return done;
}
