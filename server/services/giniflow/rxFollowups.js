import pool from "../../config/db.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import { RX_FOLLOWUP_RESOLVES } from "../../../shared/rxFollowups.js";

export const EXPLAINED_SQL = (visit) => `EXISTS (
  SELECT 1 FROM giniflow_visit_events ex
   WHERE ex.visit_id = ${visit}.id AND ex.meta->>'explained' = 'true')`;

export const AMENDED_AT_SQL = (visit) => `(to_jsonb(${visit})->>'amended_at')::timestamptz`;

export const AMENDED_AFTER_EXPLAINED_SQL = (visit) => `COALESCE(${AMENDED_AT_SQL(visit)} > (
  SELECT max(ex.occurred_at) FROM giniflow_visit_events ex
   WHERE ex.visit_id = ${visit}.id AND ex.meta->>'explained' = 'true'), FALSE)`;

export const ONLINE_VISIT_SQL = (visit) => `(
  COALESCE((SELECT vt.for_online FROM flow_visit_types vt WHERE vt.id = ${visit}.visit_type_id), FALSE)
  OR COALESCE((SELECT a.visit_type ~* '(tele|online|video)' FROM appointments a
                WHERE a.id = ${visit}.appointment_id), FALSE))`;

const NOT_TAKEN_SQL = `
  WITH since AS (
    SELECT COALESCE(
             (SELECT (value #>> '{}')::date FROM app_kv WHERE key = 'rx_followups_since'),
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS d
  )
  SELECT v.id AS visit_id, v.patient_id, v.visit_date::text AS visit_date, v.current_status,
         p.name, p.file_no, p.age, p.sex, p.phone,
         doc.short_name AS doctor_name,
         ${EXPLAINED_SQL("v")} AS explained,
         fu.not_taken_at, last_fu.action AS last_action, last_fu.remark AS last_remark,
         last_fu.created_at AS last_at, last_fu.actor_name AS last_by,
         EXISTS (
           SELECT 1 FROM documents d
            WHERE d.patient_id = v.patient_id AND d.doc_type = 'prescription'
              AND (d.file_url IS NOT NULL OR d.storage_path IS NOT NULL)
              AND (d.consultation_id = cons.id OR (d.consultation_id IS NULL AND d.doc_date = v.visit_date))
         ) AS has_rx
    FROM giniflow_visits v
    CROSS JOIN since
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
    LEFT JOIN LATERAL (
      SELECT id FROM consultations c
       WHERE c.patient_id = v.patient_id AND c.visit_date = v.visit_date
       ORDER BY id DESC LIMIT 1
    ) cons ON TRUE
    LEFT JOIN LATERAL (
      SELECT max(f.created_at) FILTER (WHERE f.action = 'not_taken') AS not_taken_at,
             max(f.created_at) FILTER (WHERE f.action = ANY($4)) AS resolved_at
        FROM giniflow_rx_followups f WHERE f.visit_id = v.id
    ) fu ON TRUE
    LEFT JOIN LATERAL (
      SELECT f.action, f.remark, f.created_at, COALESCE(a.short_name, a.name) AS actor_name
        FROM giniflow_rx_followups f LEFT JOIN doctors a ON a.id = f.actor_id
       WHERE f.visit_id = v.id
       ORDER BY f.created_at DESC, f.id DESC LIMIT 1
    ) last_fu ON TRUE
   WHERE v.visit_date BETWEEN since.d AND $1::date
     AND v.current_status NOT IN ('cancelled', 'no_show')
     AND NOT COALESCE(p.is_blocked, FALSE)
     AND NOT ${labOnlyPredicate("v", "$2")}
     AND v.merged_into_visit_id IS NULL
     AND NOT COALESCE(v.is_demo, FALSE)
     AND (
       (fu.not_taken_at IS NOT NULL AND (fu.resolved_at IS NULL OR fu.resolved_at < fu.not_taken_at))
       OR (fu.not_taken_at IS NULL AND fu.resolved_at IS NULL
           AND v.current_status IN ('dispensed', 'exited', 'abandoned')
           AND NOT ${ONLINE_VISIT_SQL("v")}
           AND (
             cons.id IS NOT NULL
             OR EXISTS (SELECT 1 FROM documents d
                         WHERE d.patient_id = v.patient_id AND d.doc_type = 'prescription'
                           AND d.doc_date = v.visit_date)
           )
           AND NOT ${EXPLAINED_SQL("v")})
     )
     AND (
       $3::text IS NULL
       OR p.name ILIKE '%' || $3 || '%'
       OR p.file_no ILIKE '%' || $3 || '%'
       OR COALESCE(p.phone, '') ILIKE '%' || $3 || '%'
       OR doc.short_name ILIKE '%' || $3 || '%'
     )
   ORDER BY v.visit_date, p.name`;

const untilMigrated = (query) =>
  query.catch((e) => {
    if (e.code === "42P01") return { rows: [] };
    throw e;
  });

export async function getRxNotTaken(visitDate, q = null, db = pool) {
  const search = q && String(q).trim().length >= 2 ? String(q).trim() : null;
  const { rows } = await untilMigrated(
    db.query(NOT_TAKEN_SQL, [visitDate, LAB_ONLY_DOCTOR, search, RX_FOLLOWUP_RESOLVES]),
  );
  return rows.map((r) => ({
    visitId: r.visit_id,
    patientId: r.patient_id,
    visitDate: r.visit_date,
    name: r.name || "Patient not matched yet",
    fileNo: r.file_no,
    age: r.age,
    sex: r.sex,
    phone: r.phone,
    doctorName: r.doctor_name,
    status: r.current_status,
    explained: !!r.explained,
    reason: r.not_taken_at ? "not_taken" : "not_explained",
    canPrint: !!r.has_rx,
    lastFollowup: r.last_action
      ? {
          action: r.last_action,
          remark: r.last_remark,
          at: new Date(r.last_at).toISOString(),
          by: r.last_by,
        }
      : null,
  }));
}

export async function getRxFollowups(visitId, db = pool) {
  const { rows } = await untilMigrated(
    db.query(
      `SELECT f.id, f.action, f.remark, f.created_at, COALESCE(a.short_name, a.name) AS actor_name
       FROM giniflow_rx_followups f LEFT JOIN doctors a ON a.id = f.actor_id
      WHERE f.visit_id = $1
      ORDER BY f.created_at DESC, f.id DESC`,
      [visitId],
    ),
  );
  return rows.map((r) => ({
    id: Number(r.id),
    action: r.action,
    remark: r.remark,
    at: new Date(r.created_at).toISOString(),
    by: r.actor_name,
  }));
}

export async function addRxFollowup(visitId, { action, remark }, actorId = null, db = pool) {
  const { rows } = await db.query(
    `SELECT ${labOnlyPredicate("v", "$2")} AS lab_only
       FROM giniflow_visits v WHERE v.id = $1`,
    [visitId, LAB_ONLY_DOCTOR],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  if (rows[0].lab_only) {
    throw Object.assign(new Error("This patient came for samples only — no prescription"), {
      status: 409,
    });
  }
  await db.query(
    `INSERT INTO giniflow_rx_followups (visit_id, action, remark, actor_id)
     VALUES ($1, $2, $3, $4)`,
    [visitId, action, remark.trim(), actorId],
  );
  return { ok: true, followups: await getRxFollowups(visitId, db) };
}
