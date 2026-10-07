import pool from "../config/db.js";
import { IST_TODAY } from "./ghmDayWindow.js";
import { logAppointmentEvent } from "./appointmentHistory.js";
import { CAPABILITIES, hasCapability, ROLES } from "../../shared/permissions.js";

const NAME = `COALESCE(NULLIF(TRIM(d.short_name), ''), d.name)`;

export const canAssignCalls = (doctor) => hasCapability(doctor, CAPABILITIES.OBT_ASSIGN);

const cleanIds = (ids) => [
  ...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0)),
];

export async function obtTeam(db = pool) {
  const r = await db.query(
    `SELECT d.id, ${NAME} AS name
       FROM doctors d
      WHERE d.role = $1 AND COALESCE(d.is_active, TRUE) AND d.removed_at IS NULL
      ORDER BY 2`,
    [ROLES.OBT],
  );
  return r.rows;
}

export async function assignmentsFor(patientIds, db = pool) {
  const ids = cleanIds(patientIds);
  if (!ids.length) return {};
  const r = await db.query(
    `SELECT x.patient_id, x.assigned_to_id, ${NAME} AS assigned_to
       FROM obt_call_assignments x
       JOIN doctors d ON d.id = x.assigned_to_id
      WHERE x.work_date = ${IST_TODAY} AND x.patient_id = ANY($1::int[])`,
    [ids],
  );
  const out = {};
  for (const row of r.rows)
    out[row.patient_id] = { assigned_to_id: row.assigned_to_id, assigned_to: row.assigned_to };
  return out;
}

export async function teamCounts(patientIds, db = pool) {
  const ids = cleanIds(patientIds);
  const r = await db.query(
    `SELECT x.assigned_to_id, COUNT(*)::int AS count
       FROM obt_call_assignments x
      WHERE x.work_date = ${IST_TODAY} AND x.patient_id = ANY($1::int[])
      GROUP BY 1`,
    [ids],
  );
  return Object.fromEntries(r.rows.map((row) => [row.assigned_to_id, row.count]));
}

const patientIdOfRow = async (rawId, db) => {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id === 0) return null;
  if (id < 0) return -id;
  const r = await db.query("SELECT patient_id FROM appointments WHERE id=$1", [id]);
  return r.rows[0]?.patient_id ?? null;
};

const isObtMember = (doctor) => doctor?.role === ROLES.OBT && !canAssignCalls(doctor);

export async function patientEditBlockedFor(req, patientId, { call = false } = {}, db = pool) {
  if (canAssignCalls(req.doctor)) return null;
  const obt = isObtMember(req.doctor);
  if (!patientId) return obt ? "Only patients assigned to you can be changed." : null;
  const owner = (await assignmentsFor([patientId], db))[patientId];
  if (owner?.assigned_to_id === req.doctor?.doctor_id) return null;
  if (owner && (obt || call))
    return `This patient is assigned to ${owner.assigned_to} today. Only ${owner.assigned_to} can change or call them.`;
  if (!owner && obt)
    return "This patient is not assigned to you. Only patients assigned to you can be changed.";
  return null;
}

export async function editBlockedFor(req, rawAppointmentId, opts = {}, db = pool) {
  if (canAssignCalls(req.doctor)) return null;
  return patientEditBlockedFor(req, await patientIdOfRow(rawAppointmentId, db), opts, db);
}

const todayAppointmentIds = async (patientIds, db) => {
  const r = await db.query(
    `SELECT DISTINCT ON (patient_id) patient_id, id
       FROM appointments
      WHERE patient_id = ANY($1::int[])
      ORDER BY patient_id, (appointment_date = ${IST_TODAY}) DESC NULLS LAST,
               appointment_date DESC NULLS LAST, id DESC`,
    [patientIds],
  );
  return Object.fromEntries(r.rows.map((row) => [row.patient_id, row.id]));
};

const writeAssignments = async (client, pairs, actor) => {
  if (!pairs.length) return;
  const ids = pairs.map((p) => p.patientId);
  const before = await assignmentsFor(ids, client);
  const memberIds = [...new Set(pairs.map((p) => p.memberId).filter(Boolean))];
  const names = memberIds.length
    ? Object.fromEntries(
        (
          await client.query(`SELECT d.id, ${NAME} AS name FROM doctors d WHERE d.id = ANY($1)`, [
            memberIds,
          ])
        ).rows.map((d) => [d.id, d.name]),
      )
    : {};

  const assigned = pairs.filter((p) => p.memberId);
  const cleared = pairs.filter((p) => !p.memberId).map((p) => p.patientId);
  if (assigned.length)
    await client.query(
      `INSERT INTO obt_call_assignments (work_date, patient_id, assigned_to_id, assigned_by_id)
       SELECT ${IST_TODAY}, u.patient_id, u.member_id, $3
         FROM unnest($1::int[], $2::int[]) AS u(patient_id, member_id)
       ON CONFLICT (work_date, patient_id) DO UPDATE
         SET assigned_to_id = EXCLUDED.assigned_to_id,
             assigned_by_id = EXCLUDED.assigned_by_id,
             assigned_at = NOW()`,
      [assigned.map((p) => p.patientId), assigned.map((p) => p.memberId), actor.id],
    );
  if (cleared.length)
    await client.query(
      `DELETE FROM obt_call_assignments
        WHERE work_date = ${IST_TODAY} AND patient_id = ANY($1::int[])`,
      [cleared],
    );

  const apptIds = await todayAppointmentIds(ids, client);
  for (const p of pairs) {
    const oldName = before[p.patientId]?.assigned_to || null;
    const newName = p.memberId ? names[p.memberId] || null : null;
    if (oldName === newName) continue;
    await logAppointmentEvent(client, {
      appointmentId: apptIds[p.patientId],
      field: "call_assigned_to",
      label: "Call assigned to",
      oldValue: oldName,
      newValue: newName,
      actor,
    });
  }
};

const assertMembers = async (memberIds, db) => {
  const team = new Set((await obtTeam(db)).map((m) => m.id));
  const bad = memberIds.filter((id) => !team.has(id));
  if (bad.length) {
    const err = new Error("Pick members of the OBT team only.");
    err.status = 400;
    throw err;
  }
};

const inTransaction = async (work) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

export async function assignCalls(patientIds, memberId, actor) {
  const ids = cleanIds(patientIds);
  const member = memberId ? Number(memberId) : null;
  return inTransaction(async (client) => {
    if (member) await assertMembers([member], client);
    await writeAssignments(
      client,
      ids.map((patientId) => ({ patientId, memberId: member })),
      actor,
    );
    return { assigned: ids.length };
  });
}

export async function divideCalls(patientIds, memberIds, actor) {
  const ids = cleanIds(patientIds);
  const members = cleanIds(memberIds);
  if (!members.length) {
    const err = new Error("Pick at least one team member to divide the calls between.");
    err.status = 400;
    throw err;
  }
  return inTransaction(async (client) => {
    await assertMembers(members, client);
    const current = await assignmentsFor(ids, client);
    const load = Object.fromEntries(members.map((m) => [m, 0]));
    for (const a of Object.values(current))
      if (a.assigned_to_id in load) load[a.assigned_to_id] += 1;

    const pairs = [];
    for (const patientId of ids.filter((id) => !current[id])) {
      const memberId = members.reduce((min, m) => (load[m] < load[min] ? m : min), members[0]);
      load[memberId] += 1;
      pairs.push({ patientId, memberId });
    }
    await writeAssignments(client, pairs, actor);
    return { assigned: pairs.length, load };
  });
}
