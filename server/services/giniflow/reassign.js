import pool from "../../config/db.js";
import { chainIndex, consultStarted, isChainStatus } from "../../../shared/giniflowStatus.js";
import { consultSide } from "../../../shared/directConsult.js";
import { isLabOnlyDoctor } from "../../../shared/labOnly.js";
import { logFieldChanges } from "../appointmentHistory.js";
import { advanceStatus } from "./statusEngine.js";
import { consultantChangedIn, consultFeeDifference } from "../billing/consultantChange.js";
import { httpError, inTransaction } from "../billing/transaction.js";

const VISIT_SQL = `
  SELECT v.id, v.patient_id, v.current_status, v.assigned_doctor_id, v.appointment_id,
         a.doctor_name AS appointment_doctor_name,
         COALESCE(a.doctor_id,
                  (SELECT d.id FROM doctors d
                    WHERE lower(btrim(d.name)) = lower(btrim(a.doctor_name))
                    ORDER BY d.is_active IS NOT FALSE DESC, d.id LIMIT 1)) AS appointment_doctor_id,
         COALESCE(cur.short_name, cur.name) AS current_name
    FROM giniflow_visits v
    LEFT JOIN appointments a ON a.id = v.appointment_id
    LEFT JOIN doctors cur ON cur.id = v.assigned_doctor_id
   WHERE v.id = $1
   FOR UPDATE OF v`;

async function consultantFor(client, doctorId) {
  const { rows } = await client.query(
    `SELECT id, name, COALESCE(short_name, name) AS short_name, is_active, chief_step
       FROM doctors WHERE id = $1`,
    [doctorId],
  );
  if (!rows.length) throw httpError(400, "That consultant doesn't exist");
  if (rows[0].is_active === false) {
    throw httpError(409, `${rows[0].short_name} was removed, so patients can't be moved to them`);
  }
  return rows[0];
}

async function actorFor(client, ctx) {
  if (!ctx?.actorId) return {};
  const { rows } = await client.query(
    `SELECT COALESCE(short_name, name) AS name FROM doctors WHERE id = $1`,
    [ctx.actorId],
  );
  return { id: ctx.actorId, name: rows[0]?.name ?? null };
}

const WAITING_FOR_CHIEF = ["vitals_done", "sd_pending"];

async function skipChiefStepsIn(client, visit) {
  if (
    isChainStatus(visit.current_status) &&
    chainIndex(visit.current_status) >= chainIndex("with_sd")
  )
    return;
  const { rows } = await client.query(
    `SELECT id, step_catalog_id, assigned_role FROM giniflow_visit_steps
      WHERE visit_id = $1 AND status = 'pending'`,
    [visit.id],
  );
  const chief = rows
    .filter(
      (row) => consultSide({ catalogId: row.step_catalog_id, role: row.assigned_role }) === "chief",
    )
    .map((row) => row.id);
  if (chief.length)
    await client.query(`UPDATE giniflow_visit_steps SET status = 'skipped' WHERE id = ANY($1)`, [
      chief,
    ]);
  if (!WAITING_FOR_CHIEF.includes(visit.current_status)) return;
  await client.query("SAVEPOINT straight_to_consultant");
  try {
    await advanceStatus(client, {
      visitId: visit.id,
      toStatus: "ready_for_doctor",
      actorRole: "system",
      allowSkip: true,
      meta: { reason: "consultant_has_no_chief_step", after: visit.current_status },
    });
    await client.query("RELEASE SAVEPOINT straight_to_consultant");
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT straight_to_consultant");
  }
}

export async function reassignConsultantIn(client, visitId, doctorId, ctx) {
  const { rows } = await client.query(VISIT_SQL, [visitId]);
  if (!rows.length) throw httpError(404, "No such visit");
  const visit = rows[0];
  const to = await consultantFor(client, doctorId);
  const fromId = visit.assigned_doctor_id ?? visit.appointment_doctor_id ?? null;
  if (fromId !== to.id && consultStarted(visit.current_status)) {
    throw httpError(
      409,
      `${visit.current_name || "The consultant"} has already started this consult, so the patient can't be moved`,
    );
  }
  await client.query(
    `UPDATE giniflow_visits SET assigned_doctor_id = $2, updated_at = NOW() WHERE id = $1`,
    [visit.id, to.id],
  );
  if (to.chief_step === false) await skipChiefStepsIn(client, visit);
  if (isLabOnlyDoctor(visit.appointment_doctor_name))
    return { visitId: visit.id, fromDoctorId: fromId, doctorId: to.id, billing: null };
  if (visit.appointment_id && visit.appointment_doctor_id !== to.id) {
    await client.query(
      `UPDATE appointments
          SET doctor_id = $2, doctor_name = $3, doctor_set_manually_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [visit.appointment_id, to.id, to.name],
    );
    await logFieldChanges(
      client,
      visit.appointment_id,
      { doctor_name: visit.appointment_doctor_name },
      { doctor_name: to.name },
      { doctor_name: "Consultant" },
      await actorFor(client, ctx),
    );
  }
  const billing =
    fromId && fromId !== to.id ? await consultantChangedIn(client, visit.id, to.id, ctx) : null;
  return { visitId: visit.id, fromDoctorId: fromId, doctorId: to.id, billing };
}

export const reassignConsultant = (visitId, doctorId, ctx, db = pool) =>
  inTransaction((client) => reassignConsultantIn(client, visitId, doctorId, ctx), db);

async function visitOfAppointment(db, appointmentId) {
  const { rows } = await db.query(
    `SELECT id FROM giniflow_visits WHERE appointment_id = $1 ORDER BY visit_date DESC LIMIT 1`,
    [appointmentId],
  );
  return rows[0]?.id ?? null;
}

async function moveAppointmentIn(client, appointmentId, doctorId, ctx) {
  const { rows } = await client.query(
    `SELECT id, doctor_id, doctor_name FROM appointments WHERE id = $1 FOR UPDATE`,
    [appointmentId],
  );
  if (!rows.length) throw httpError(404, "Appointment not found");
  const to = await consultantFor(client, doctorId);
  if (rows[0].doctor_id === to.id && rows[0].doctor_name === to.name) return;
  await client.query(
    `UPDATE appointments
        SET doctor_id = $2, doctor_name = $3, doctor_set_manually_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [appointmentId, to.id, to.name],
  );
  await logFieldChanges(
    client,
    appointmentId,
    { doctor_name: rows[0].doctor_name },
    { doctor_name: to.name },
    { doctor_name: "Consultant" },
    await actorFor(client, ctx),
  );
}

export async function reassignAppointment(appointmentId, doctorId, ctx, db = pool) {
  return inTransaction(async (client) => {
    const visitId = await visitOfAppointment(client, appointmentId);
    const moved = visitId
      ? await reassignConsultantIn(client, visitId, doctorId, ctx)
      : (await moveAppointmentIn(client, appointmentId, doctorId, ctx), { billing: null });
    const { rows } = await client.query(`SELECT * FROM appointments WHERE id = $1`, [
      appointmentId,
    ]);
    return { appointment: rows[0], visitId, billing: moved.billing };
  }, db);
}

export async function appointmentConsultFee(appointmentId, doctorId, ctx, db = pool) {
  const visitId = await visitOfAppointment(db, appointmentId);
  if (!visitId) return { bill_state: "none", visit: false };
  return { ...(await consultFeeDifference(visitId, doctorId, ctx, db)), visit: true };
}
