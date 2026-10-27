import pool from "../../config/db.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { sqlKey } from "../../../shared/directConsult.js";
import { savePatientAllergy } from "../patientAllergy.js";
import { tableReady } from "../slots/readiness.js";
import { withoutHiddenHistory } from "../../../shared/newPatientWorkup.js";

export const workupReady = tableReady("new_patient_workups");

const flaggedDoctorSql = (alias) => `EXISTS (
  SELECT 1 FROM doctors wd
   WHERE wd.new_patient_workup
     AND COALESCE(wd.is_active, TRUE)
     AND (wd.id = ${alias}.doctor_id
          OR (${sqlKey(`${alias}.doctor_name`)} <> ''
              AND ${sqlKey(`${alias}.doctor_name`)} IN (${sqlKey("wd.name")}, ${sqlKey("wd.short_name")})))
)`;

const WORKUP_COLUMNS = `
  w.id, w.appointment_id, w.patient_id, w.history, w.exam,
  w.created_at, w.updated_at::text AS version,
  a.appointment_date::text AS visit_date,
  pd.name AS prepared_by, ud.name AS updated_by`;

const WORKUP_JOINS = `
  JOIN appointments a ON a.id = w.appointment_id
  LEFT JOIN doctors pd ON pd.id = w.prepared_by_doctor_id
  LEFT JOIN doctors ud ON ud.id = w.updated_by_doctor_id`;

export async function workupContext(appointmentId, db = pool) {
  const { rows } = await db.query(
    `SELECT a.id, a.patient_id,
            appointment_is_new_type(a.visit_type) AS is_new,
            a.appointment_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS is_today,
            ${flaggedDoctorSql("a")} AS doctor_flagged,
            EXISTS (
              SELECT 1 FROM new_patient_workups ew
                JOIN appointments ea ON ea.id = ew.appointment_id
               WHERE ew.patient_id = a.patient_id
                 AND ew.appointment_id <> a.id
                 AND ea.appointment_date < a.appointment_date
            ) AS has_earlier_workup
       FROM appointments a
      WHERE a.id = $1`,
    [appointmentId],
  );
  const ctx = rows[0];
  if (!ctx) return null;
  const applies = ctx.is_new && ctx.doctor_flagged && !ctx.has_earlier_workup;
  return { ...ctx, applies, editable: applies && ctx.is_today };
}

const workupForAppointment = async (appointmentId, db, lock = false) =>
  (
    await db.query(
      `SELECT ${WORKUP_COLUMNS} FROM new_patient_workups w ${WORKUP_JOINS}
        WHERE w.appointment_id = $1 ${lock ? "FOR UPDATE OF w" : ""}`,
      [appointmentId],
    )
  ).rows[0] || null;

const earliestWorkup = async (patientId, exceptAppointmentId, db) =>
  (
    await db.query(
      `SELECT ${WORKUP_COLUMNS} FROM new_patient_workups w ${WORKUP_JOINS}
        WHERE w.patient_id = $1 AND w.appointment_id IS DISTINCT FROM $2
        ORDER BY a.appointment_date, w.created_at
        LIMIT 1`,
      [patientId, exceptAppointmentId ?? null],
    )
  ).rows[0] || null;

const patientAllergy = async (patientId, db) =>
  (await db.query(`SELECT allergy_status, allergy_note FROM patients WHERE id = $1`, [patientId]))
    .rows[0] || null;

const requireOwnAppointment = async (patientId, appointmentId, db) => {
  const ctx = await workupContext(appointmentId, db);
  if (!ctx || ctx.patient_id !== patientId)
    throw httpError(404, "That appointment isn't this patient's");
  return ctx;
};

export async function getWorkup(patientId, appointmentId, db = pool) {
  if (!(await workupReady()))
    return {
      applies: false,
      editable: false,
      workup: null,
      earlier: null,
      allergy: await patientAllergy(patientId, db),
    };
  const ctx = appointmentId ? await requireOwnAppointment(patientId, appointmentId, db) : null;
  const [workup, earlier, allergy] = await Promise.all([
    ctx ? workupForAppointment(appointmentId, db) : null,
    earliestWorkup(patientId, appointmentId, db),
    patientAllergy(patientId, db),
  ]);
  return {
    applies: !!ctx?.applies,
    editable: !!ctx?.editable,
    workup,
    earlier,
    allergy,
  };
}

const blank = (v) => v == null || (typeof v === "string" && v.trim() === "");

function compact(value) {
  if (Array.isArray(value) || value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    const kept = compact(inner);
    if (blank(kept)) continue;
    if (typeof kept === "object" && !Object.keys(kept).length) continue;
    out[key] = typeof kept === "string" ? kept.trim() : kept;
  }
  return out;
}

const refusal = (ctx) => {
  if (!ctx.is_new || ctx.has_earlier_workup)
    return "The History & Examination form is only for a patient's first visit";
  if (!ctx.doctor_flagged) return "This doctor doesn't use the new-patient History & Examination";
  if (!ctx.is_today) return "This visit's workup can only be changed on the day of the visit";
  return null;
};

export async function saveWorkup(patientId, body, actorId, db = pool) {
  if (!(await workupReady()))
    throw httpError(
      409,
      "The History & Examination form needs a database update first. Ask an administrator to run its migration.",
      { code: "workup_locked" },
    );
  const { appointment_id: appointmentId, expected_updated_at: expected } = body;
  const history = compact(withoutHiddenHistory(body.history || {}));
  const exam = compact(body.exam || {});
  try {
    return await inTransaction(async (client) => {
      const ctx = await requireOwnAppointment(patientId, appointmentId, client);
      const refused = refusal(ctx);
      if (refused) throw httpError(409, refused, { code: "workup_locked" });

      const current = await workupForAppointment(appointmentId, client, true);
      if (current && current.version !== expected) {
        throw httpError(
          409,
          `${current.updated_by || current.prepared_by || "Someone"} changed this workup since you opened it. Reload to see their version.`,
          { code: "workup_stale" },
        );
      }

      if (current) {
        await client.query(
          `UPDATE new_patient_workups
              SET history = $2, exam = $3, updated_by_doctor_id = $4, updated_at = clock_timestamp()
            WHERE appointment_id = $1`,
          [appointmentId, history, exam, actorId],
        );
      } else {
        await client.query(
          `INSERT INTO new_patient_workups
             (appointment_id, patient_id, history, exam, prepared_by_doctor_id, updated_by_doctor_id)
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [appointmentId, patientId, history, exam, actorId],
        );
      }
      if (body.allergy?.status)
        await savePatientAllergy(
          patientId,
          { status: body.allergy.status, note: body.allergy.note, actorId },
          client,
        );
      return {
        workup: await workupForAppointment(appointmentId, client),
        allergy: await patientAllergy(patientId, client),
      };
    }, db);
  } catch (e) {
    if (e.code === "23505")
      throw httpError(409, "Someone else started this workup at the same time. Reload to see it.", {
        code: "workup_stale",
      });
    throw e;
  }
}

export async function workupForPrint(appointmentId, patientId, db = pool) {
  if (!appointmentId || !(await workupReady())) return null;
  const ctx = await workupContext(appointmentId, db);
  if (!ctx?.applies || ctx.patient_id !== patientId) return null;
  const [row, allergy] = await Promise.all([
    workupForAppointment(appointmentId, db),
    patientAllergy(patientId, db),
  ]);
  return row ? { history: row.history, exam: row.exam, allergy } : null;
}
