import pool from "../../config/db.js";
import { STATUS_LABEL } from "../../../shared/giniflowStatus.js";
import {
  TOKEN_ACTIVE_STAGES,
  TOKEN_LOCKED_STATUSES,
  tokenStageOf,
  tokenStatuses,
} from "../../../shared/giniflowTokens.js";
import { IST_TODAY } from "./statusEngine.js";
import { syncAppointmentsToFlow } from "./appointmentSync.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import {
  PATIENT_SEARCH_SQL,
  TOKEN_QUEUE_ON_SQL,
  FIRST_CHECK_IN_SQL,
  patientSearchParams,
} from "./stepSql.js";
import { publish } from "./eventHub.js";
import { publishEvents } from "./realtimeBus.js";

export class TokenError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = "TokenError";
    this.status = status;
  }
}

const TOKEN_CONSULTANTS_SQL = `
  SELECT id, name, short_name
    FROM doctors doc
   WHERE doc.is_active AND ${TOKEN_QUEUE_ON_SQL("doc")}
   ORDER BY name`;

const TOKEN_QUEUE_SQL = `
  SELECT v.id,
         v.patient_id,
         v.current_status,
         v.token_no,
         v.token_set_at,
         v.appointment_time::text AS appointment_time,
         p.name,
         p.file_no,
         p.age,
         p.sex,
         doc.id         AS doctor_id,
         doc.short_name AS doctor_short_name,
         doc.name       AS doctor_name,
         setter.short_name AS token_set_by_name,
         ${FIRST_CHECK_IN_SQL("v")} AS arrived_at
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    JOIN doctors doc ON doc.id = v.assigned_doctor_id
    LEFT JOIN doctors setter ON setter.id = v.token_set_by
   WHERE v.visit_date = $1::date
     AND ${TOKEN_QUEUE_ON_SQL("doc")}
     AND v.merged_into_visit_id IS NULL
     AND NOT COALESCE(p.is_blocked, FALSE)
     AND NOT ${labOnlyPredicate("v", "$3")}
     AND ($4::int[] IS NULL OR doc.id = ANY($4::int[]))
     AND ($5::time IS NULL OR v.appointment_time >= $5::time)
     AND ($6::time IS NULL OR v.appointment_time <= $6::time)
     AND ${PATIENT_SEARCH_SQL("p", "$7", "$8")}
   ORDER BY v.current_status = ANY($2::text[]) DESC,
            v.token_no IS NULL,
            v.token_no,
            CASE WHEN v.token_no IS NOT NULL THEN ${FIRST_CHECK_IN_SQL("v")} END NULLS LAST,
            v.appointment_time NULLS LAST,
            p.name`;

const toRow = (r, sharedTokens) => {
  const stage = tokenStageOf(r.current_status);
  return {
    visitId: r.id,
    patientId: r.patient_id,
    name: r.name,
    fileNo: r.file_no,
    age: r.age,
    sex: r.sex,
    doctorId: r.doctor_id,
    doctorName: r.doctor_short_name || r.doctor_name,
    appointmentTime: (r.appointment_time || "").slice(0, 5) || null,
    arrivedAt: r.arrived_at ? new Date(r.arrived_at).toISOString() : null,
    status: r.current_status,
    statusLabel: STATUS_LABEL[r.current_status] || r.current_status,
    stage: stage?.key ?? null,
    token: r.token_no,
    tokenShared: r.token_no != null && sharedTokens.has(r.token_no),
    tokenSetBy: r.token_set_by_name || null,
    tokenSetAt: r.token_set_at ? new Date(r.token_set_at).toISOString() : null,
  };
};

const tokenCounts = (rows) => {
  const counts = new Map();
  for (const r of rows) {
    if (r.token_no != null) counts.set(r.token_no, (counts.get(r.token_no) || 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([token]) => token));
};

async function ensureDay(date, db) {
  const { rows } = await db.query(`SELECT $1::date >= ${IST_TODAY} AS upcoming`, [date]);
  if (!rows[0]?.upcoming) return;
  try {
    await syncAppointmentsToFlow({ date, db });
  } catch (e) {
    console.error("[giniflow] token queue day sync failed:", e.message);
  }
}

export async function listTokenQueue(
  { date, doctorIds = null, from = null, to = null, q = null },
  db = pool,
) {
  const { rows: consultants } = await db.query(TOKEN_CONSULTANTS_SQL);
  if (consultants.length) await ensureDay(date, db);
  const { term, digits } = patientSearchParams(q);
  const { rows } = await db.query(TOKEN_QUEUE_SQL, [
    date,
    tokenStatuses(TOKEN_ACTIVE_STAGES),
    LAB_ONLY_DOCTOR,
    doctorIds?.length ? doctorIds : null,
    from,
    to,
    term,
    digits,
  ]);
  const shared = tokenCounts(rows);
  let position = 0;
  return {
    date,
    consultants: consultants.map((d) => ({
      id: d.id,
      name: d.name,
      shortName: d.short_name || d.name,
    })),
    rows: rows.map((r) => {
      const row = toRow(r, shared);
      const queued = r.token_no != null && TOKEN_ACTIVE_STAGES.includes(row.stage);
      return { ...row, position: queued ? ++position : null };
    }),
  };
}

export async function setToken(visitId, tokenNo, actorId, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT v.id, v.visit_date::text AS visit_date, v.current_status, v.token_no,
              ${TOKEN_QUEUE_ON_SQL("doc")} AS token_queue
         FROM giniflow_visits v
         LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
        WHERE v.id = $1
          FOR UPDATE OF v`,
      [visitId],
    );
    const visit = rows[0];
    if (!visit) throw new TokenError("This visit no longer exists. Refresh the list.", 404);
    if (!visit.token_queue)
      throw new TokenError("This patient's consultant does not use the token queue.");
    if (TOKEN_LOCKED_STATUSES.includes(visit.current_status))
      throw new TokenError(
        `The visit is ${STATUS_LABEL[visit.current_status] || visit.current_status} — a token can no longer be set.`,
      );

    const { rows: updated } = await client.query(
      `UPDATE giniflow_visits
          SET token_no     = $2,
              token_set_by = $3,
              token_set_at = NOW(),
              updated_at   = NOW()
        WHERE id = $1
        RETURNING id, token_no, token_set_at`,
      [visitId, tokenNo, actorId],
    );
    await client.query(
      `INSERT INTO audit_log (doctor_id, action, entity_type, details)
       VALUES ($1, 'giniflow_token_set', 'giniflow_visit', $2)`,
      [
        actorId,
        JSON.stringify({ visitId, visitDate: visit.visit_date, from: visit.token_no, to: tokenNo }),
      ],
    );
    await client.query("COMMIT");

    const event = {
      kind: "visit",
      visitId,
      status: visit.current_status,
      date: visit.visit_date,
    };
    publish(event);
    publishEvents([event]);

    return {
      visitId,
      token: updated[0].token_no,
      previousToken: visit.token_no,
      tokenSetAt: new Date(updated[0].token_set_at).toISOString(),
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
