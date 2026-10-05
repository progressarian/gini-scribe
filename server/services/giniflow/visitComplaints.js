import pool from "../../config/db.js";

const KNOWN_LIMIT = 500;

const symptomKey = (label) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);

async function visitAppointment(visitId, db) {
  const { rows } = await db.query(
    `SELECT patient_id, appointment_id FROM giniflow_visits WHERE id = $1`,
    [visitId],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  if (!rows[0].appointment_id) {
    throw Object.assign(new Error("This visit has no appointment to record complaints against"), {
      status: 409,
    });
  }
  return rows[0];
}

export async function appointmentComplaints(patientId, appointmentId, db = pool) {
  if (!patientId || !appointmentId) return [];
  const { rows } = await db.query(
    `SELECT id, label FROM visit_symptoms
      WHERE patient_id = $1 AND appointment_id = $2 AND is_active
      ORDER BY created_at, id`,
    [patientId, appointmentId],
  );
  return rows;
}

export async function appointmentHistory(appointmentId, db = pool) {
  if (!appointmentId) return null;
  const { rows } = await db
    .query(
      `SELECT cp.history FROM giniflow_visits v
         JOIN giniflow_care_plans cp ON cp.visit_id = v.id
        WHERE v.appointment_id = $1
        LIMIT 1`,
      [appointmentId],
    )
    .catch(() => ({ rows: [] }));
  return rows[0]?.history?.trim() || null;
}

async function visitHistory(visitId, db) {
  const { rows } = await db
    .query(`SELECT history FROM giniflow_care_plans WHERE visit_id = $1`, [visitId])
    .catch(() => ({ rows: [] }));
  return rows[0]?.history ?? "";
}

export async function saveVisitHistory(visitId, history, actorId = null, db = pool) {
  await visitAppointment(visitId, db);
  const text = String(history ?? "").trim() || null;
  const { rows } = await db.query(
    `INSERT INTO giniflow_care_plans (visit_id, history, authored_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (visit_id) DO UPDATE
        SET history = EXCLUDED.history,
            authored_by = COALESCE(giniflow_care_plans.authored_by, EXCLUDED.authored_by),
            updated_at = NOW()
     RETURNING history, updated_at`,
    [visitId, text, actorId],
  );
  return rows[0];
}

export async function getVisitComplaints(visitId, db = pool) {
  const visit = await visitAppointment(visitId, db);
  const [current, history, { rows: common }] = await Promise.all([
    appointmentComplaints(visit.patient_id, visit.appointment_id, db),
    visitHistory(visitId, db),
    db.query(
      `SELECT MIN(label) AS label, COUNT(*)::int AS uses,
              MIN(created_at) > NOW() - INTERVAL '30 days' AS is_new
         FROM visit_symptoms
        WHERE updated_at > NOW() - INTERVAL '180 days' AND NULLIF(btrim(label), '') IS NOT NULL
        GROUP BY symptom_id
        ORDER BY uses DESC, MIN(label)
        LIMIT $1`,
      [KNOWN_LIMIT],
    ),
  ]);
  return {
    current,
    history,
    common: common.map((r) => ({ label: r.label, uses: r.uses, isNew: r.is_new })),
  };
}

export async function addVisitComplaint(visitId, label, db = pool) {
  const visit = await visitAppointment(visitId, db);
  const text = String(label || "")
    .replace(/\s+/g, " ")
    .trim();
  const key = symptomKey(text);
  if (!key) throw Object.assign(new Error("Enter a complaint"), { status: 400 });
  const { rows } = await db.query(
    `INSERT INTO visit_symptoms (patient_id, symptom_id, label, appointment_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (patient_id, symptom_id) DO UPDATE SET
       label = EXCLUDED.label,
       appointment_id = EXCLUDED.appointment_id,
       status = 'Active',
       is_active = true,
       updated_at = NOW()
     RETURNING id, label`,
    [visit.patient_id, key, text, visit.appointment_id],
  );
  return rows[0];
}

export async function removeVisitComplaint(visitId, complaintId, db = pool) {
  const visit = await visitAppointment(visitId, db);
  const { rowCount } = await db.query(
    `UPDATE visit_symptoms SET is_active = false, updated_at = NOW()
      WHERE id = $1 AND patient_id = $2 AND appointment_id = $3`,
    [complaintId, visit.patient_id, visit.appointment_id],
  );
  if (!rowCount)
    throw Object.assign(new Error("Complaint not found on this visit"), { status: 404 });
  return { removed: true };
}
