import pool from "../../config/db.js";
import { HOME_COLLECTION_SQL } from "./homeCollection.js";
import { IST_TODAY } from "./statusEngine.js";
import { publish } from "./eventHub.js";
import { publishEvents } from "./realtimeBus.js";
import { istClock } from "../../../shared/homeCollection.js";
import { homeSampleProblems } from "../../../shared/homeCollectors.js";

const RECHECK_MS = 60 * 1000;
const CLOSED_STATUSES = ["no_show", "cancelled"];
let known = null;
let checkedAt = 0;

const fail = (status, message) => Object.assign(new Error(message), { status });

export async function homeSamplesReady(db = pool) {
  if (known === true) return true;
  if (known === false && Date.now() - checkedAt < RECHECK_MS) return false;
  try {
    const { rows } = await db.query(
      `SELECT to_regclass('public.giniflow_home_samples') IS NOT NULL AS ready`,
    );
    known = rows[0].ready;
  } catch {
    known = false;
  }
  checkedAt = Date.now();
  return known;
}

export function forgetHomeSamplesReady() {
  known = null;
  checkedAt = 0;
}

const RECORD_COLUMNS = `r.sample, r.collected_at, r.collected_by, r.payment, r.amount, r.mode,
       r.note, r.entered_at, COALESCE(d.short_name, d.name) AS entered_by_name`;

export const shapeHomeRecord = (r) =>
  r
    ? {
        sample: r.sample,
        collectedAt: r.collected_at ? new Date(r.collected_at).toISOString() : null,
        collectedBy: r.collected_by || null,
        payment: r.payment || null,
        amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
        mode: r.mode || null,
        note: r.note || null,
        enteredBy: r.entered_by_name || null,
        enteredAt: r.entered_at ? new Date(r.entered_at).toISOString() : null,
      }
    : null;

export async function homeForDay(visitDate, db = pool) {
  const ready = await homeSamplesReady(db);
  const { rows } = await db.query(
    `SELECT v.id, ${
      ready
        ? `hr.sample, hr.collected_at, hr.collected_by, hr.payment, hr.amount, hr.mode,
           hr.note, hr.entered_at, COALESCE(d.short_name, d.name) AS entered_by_name`
        : "NULL AS sample"
    }
       FROM giniflow_visits v
       ${
         ready
           ? `LEFT JOIN LATERAL (
                SELECT * FROM giniflow_home_samples r
                 WHERE r.visit_id = v.id
                 ORDER BY r.entered_at DESC, r.id DESC
                 LIMIT 1
              ) hr ON TRUE
              LEFT JOIN doctors d ON d.id = hr.entered_by`
           : ""
       }
      WHERE v.visit_date = $1::date
        AND v.merged_into_visit_id IS NULL
        AND ${HOME_COLLECTION_SQL("v")}`,
    [visitDate],
  );
  return {
    ready,
    byVisit: new Map(rows.map((r) => [r.id, r.sample ? shapeHomeRecord(r) : null])),
  };
}

async function homeVisitFor(db, visitId) {
  const { rows } = await db.query(
    `SELECT v.id, v.patient_id, v.visit_date::text AS visit_date, v.current_status,
            v.merged_into_visit_id, p.name,
            (v.visit_date = ${IST_TODAY}) AS today,
            ${HOME_COLLECTION_SQL("v")} AS home
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  return rows[0] ?? null;
}

const cleanAnswer = (body) => {
  const collected = body.sample === "collected" && !body.brief;
  const paid = collected && body.payment === "paid";
  return {
    brief: Boolean(body.brief),
    sample: body.sample,
    collectedTime: collected ? body.collectedTime || null : null,
    collectedBy: collected ? body.collectedBy : null,
    payment: collected ? body.payment : null,
    amount: paid ? Number(body.amount) : null,
    mode: paid ? body.mode : null,
    note: body.note?.trim() || null,
  };
};

export async function saveHomeSample(
  visitId,
  body,
  { actorId = null, role = null } = {},
  db = pool,
) {
  if (!(await homeSamplesReady(db))) {
    throw fail(503, "Home sample recording isn't switched on yet");
  }
  const visit = await homeVisitFor(db, visitId);
  if (!visit) throw fail(404, "Visit not found");
  if (visit.merged_into_visit_id) throw fail(409, "This visit was merged into another one");
  if (!visit.home) throw fail(400, "This patient did not opt for home collection");
  if (!visit.today) throw fail(400, "A home sample can only be recorded for today's visit");
  if (CLOSED_STATUSES.includes(visit.current_status)) {
    throw fail(409, "This visit is marked no-show or cancelled — undo that first");
  }
  const answer = cleanAnswer(body);
  const problems = homeSampleProblems(answer, istClock(new Date()), { brief: answer.brief });
  const first = Object.values(problems)[0];
  if (first) throw Object.assign(fail(400, first), { code: "invalid_home_sample", problems });

  const { rows } = await db.query(
    `INSERT INTO giniflow_home_samples
       (visit_id, patient_id, visit_date, sample, collected_at, collected_by, payment,
        amount, mode, note, entered_by, entered_role)
     VALUES ($1, $2, $3::date, $4,
             CASE WHEN $5::text IS NULL THEN NULL
                  ELSE ($3::date + $5::time) AT TIME ZONE 'Asia/Kolkata' END,
             $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      visit.id,
      visit.patient_id,
      visit.visit_date,
      answer.sample,
      answer.collectedTime,
      answer.collectedBy,
      answer.payment,
      answer.amount,
      answer.mode,
      answer.note,
      actorId,
      role,
    ],
  );
  const event = { kind: "visit", visitId: visit.id, status: "home_sample", date: visit.visit_date };
  publish(event);
  publishEvents([event]);
  const saved = await homeSampleHistory(visit.id, db);
  return {
    visitId: visit.id,
    name: visit.name,
    id: rows[0].id,
    record: saved[0] ?? null,
  };
}

export async function homeSampleHistory(visitId, db = pool) {
  if (!(await homeSamplesReady(db))) return [];
  const { rows } = await db.query(
    `SELECT ${RECORD_COLUMNS}
       FROM giniflow_home_samples r
       LEFT JOIN doctors d ON d.id = r.entered_by
      WHERE r.visit_id = $1
      ORDER BY r.entered_at DESC, r.id DESC`,
    [visitId],
  );
  return rows.map(shapeHomeRecord);
}
