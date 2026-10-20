import pool from "../../config/db.js";
import { toLocal10 } from "../../../shared/phone.js";
import { FOLLOWUP_KIND_GROUPS, REFERRAL_KINDS } from "../../../shared/careFollowups.js";
import { loadCatalog } from "./match.js";
import { followupsSince } from "./collect.js";

const PAGE = 50;
const TODAY = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

const shapeItem = (r) => ({
  id: r.id,
  patient: {
    id: r.patient_id,
    name: r.name,
    fileNo: r.file_no,
    phone: toLocal10(r.phone) || null,
    age: r.age,
    sex: r.sex,
  },
  source: r.source,
  kind: r.kind,
  target: r.target,
  detail: r.detail,
  availability: r.availability,
  matchedSpecialty: r.matched_specialty,
  matchedDoctor: r.matched_doctor_id
    ? { id: r.matched_doctor_id, name: r.matched_doctor_name, fullName: r.matched_doctor_full }
    : null,
  matchedTests: r.matched_tests || [],
  orderedBy: r.ordered_by_name,
  orderedOn: String(r.ordered_on).slice(0, 10),
  dueOn: r.due_on ? String(r.due_on).slice(0, 10) : null,
  overdueDays: r.overdue_days > 0 ? r.overdue_days : 0,
  status: r.status,
  outcomeReason: r.outcome_reason,
  booked: r.booked_appointment_id
    ? {
        appointmentId: r.booked_appointment_id,
        day: r.booked_day,
        slot: r.booked_slot,
        doctor: r.booked_doctor,
        status: r.booked_status,
      }
    : null,
  attempts: r.attempts,
  lastCall: r.last_call_status ? { status: r.last_call_status, at: r.last_call_at } : null,
  updatedAt: r.updated_at,
});

const ITEM_SQL = `
  SELECT cf.*, p.name, p.file_no, p.phone, p.age, p.sex,
         COALESCE(md.short_name, md.name) AS matched_doctor_name, md.name AS matched_doctor_full,
         ba.appointment_date::text AS booked_day, ba.time_slot AS booked_slot,
         ba.doctor_name AS booked_doctor, ba.status AS booked_status,
         (${TODAY} - cf.due_on) AS overdue_days
    FROM care_followups cf
    JOIN patients p ON p.id = cf.patient_id
    LEFT JOIN doctors md ON md.id = cf.matched_doctor_id
    LEFT JOIN appointments ba ON ba.id = cf.booked_appointment_id`;

function whereOf(f) {
  const params = [];
  const where = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  add("cf.kind = ANY(?)", REFERRAL_KINDS);
  if (f.kind && FOLLOWUP_KIND_GROUPS[f.kind]) add("cf.kind = ANY(?)", FOLLOWUP_KIND_GROUPS[f.kind]);
  if (f.availability) add("cf.availability = ?", f.availability);
  if (f.specialty) add("cf.matched_specialty = ?", f.specialty);
  if (f.from) add("cf.ordered_on >= ?::date", f.from);
  if (f.to) add("cf.ordered_on <= ?::date", f.to);
  if (f.due === "overdue") where.push(`cf.due_on < ${TODAY}`);
  if (f.due === "week") where.push(`cf.due_on <= ${TODAY} + 7`);
  const q = String(f.q || "").trim();
  if (q.length >= 2) {
    const digits = q.replace(/\D/g, "");
    params.push(`%${q}%`);
    const like = `$${params.length}`;
    const phone =
      digits.length >= 4
        ? (params.push(`%${digits.slice(-10)}%`),
          ` OR regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g') LIKE $${params.length}`)
        : "";
    where.push(
      `(p.name ILIKE ${like} OR p.file_no ILIKE ${like} OR cf.target ILIKE ${like}${phone})`,
    );
  }
  return { params, sql: where.length ? `WHERE ${where.join(" AND ")}` : "" };
}

export async function listFollowups(filters = {}, db = pool) {
  const { params, sql } = whereOf(filters);
  const statuses = filters.status === "all" || !filters.status ? null : [filters.status];
  const page = Math.max(1, Number(filters.page) || 1);
  params.push(statuses);
  const statusParam = `$${params.length}`;
  params.push(PAGE, (page - 1) * PAGE);
  const { rows } = await db.query(
    `WITH base AS (${ITEM_SQL} ${sql}),
          shown AS (SELECT * FROM base WHERE ${statusParam}::text[] IS NULL OR status = ANY(${statusParam}))
     SELECT (SELECT COALESCE(json_object_agg(status, n), '{}'::json)
               FROM (SELECT status, COUNT(*)::int AS n FROM base GROUP BY status) s) AS counts,
            (SELECT COUNT(*)::int FROM shown) AS total,
            (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
               SELECT * FROM shown
                ORDER BY (due_on IS NULL), due_on, ordered_on, created_at
                LIMIT $${params.length - 1} OFFSET $${params.length}) x) AS rows`,
    params,
  );
  const out = rows[0];
  const [catalog, since] = await Promise.all([loadCatalog(db), followupsSince(db)]);
  const consultantFor = (specialty) =>
    catalog.people.find((p) => p.role === "consultant" && p.specialty === specialty)?.name || null;
  return {
    counts: out.counts,
    total: out.total,
    since,
    page,
    pageSize: PAGE,
    rows: out.rows.map((r) => ({
      ...shapeItem(r),
      suggestedDoctor:
        r.matched_doctor_full ||
        (r.matched_specialty && r.availability === "in_house"
          ? consultantFor(r.matched_specialty)
          : null),
    })),
  };
}

export async function readFollowup(id, db = pool) {
  const { rows } = await db.query(`${ITEM_SQL} WHERE cf.id = $1`, [id]);
  if (!rows.length) throw Object.assign(new Error("Follow-up not found"), { status: 404 });
  const item = shapeItem(rows[0]);
  const [{ rows: events }, { rows: others }, { rows: facts }] = await Promise.all([
    db.query(
      `SELECT e.kind, e.call_status, e.from_status, e.to_status, e.note, e.at,
              COALESCE(d.short_name, d.name) AS actor
         FROM care_followup_events e
         LEFT JOIN doctors d ON d.id = e.actor_id
        WHERE e.followup_id = $1
        ORDER BY e.at DESC, e.id DESC`,
      [id],
    ),
    db.query(
      `${ITEM_SQL} WHERE cf.patient_id = $1 AND cf.id <> $2 AND cf.status IN ('open', 'booked')
          AND cf.kind = ANY($3)
        ORDER BY cf.due_on NULLS LAST, cf.ordered_on`,
      [item.patient.id, id, REFERRAL_KINDS],
    ),
    db.query(
      `SELECT p.address, p.emergency_contact, p.emergency_phone,
              last_visit.appointment_date::text AS last_day, last_visit.doctor_name AS last_doctor,
              next_visit.appointment_date::text AS next_day, next_visit.time_slot AS next_slot,
              next_visit.doctor_name AS next_doctor
         FROM patients p
         LEFT JOIN LATERAL (
           SELECT a.appointment_date, a.doctor_name FROM appointments a
            WHERE a.patient_id = p.id AND a.status = 'completed'
            ORDER BY a.appointment_date DESC, a.id DESC LIMIT 1
         ) last_visit ON TRUE
         LEFT JOIN LATERAL (
           SELECT a.appointment_date, a.time_slot, a.doctor_name FROM appointments a
            WHERE a.patient_id = p.id AND a.appointment_date >= ${TODAY}
              AND COALESCE(a.status, '') NOT IN ('cancelled', 'completed', 'no_show')
            ORDER BY a.appointment_date, a.id LIMIT 1
         ) next_visit ON TRUE
        WHERE p.id = $1`,
      [item.patient.id],
    ),
  ]);
  const f = facts[0] || {};
  return {
    ...item,
    patient: {
      ...item.patient,
      address: f.address || null,
      emergencyContact: f.emergency_contact || null,
      emergencyPhone: toLocal10(f.emergency_phone) || null,
      lastVisit: f.last_day ? { day: f.last_day, doctor: f.last_doctor } : null,
      nextVisit: f.next_day ? { day: f.next_day, slot: f.next_slot, doctor: f.next_doctor } : null,
    },
    history: events.map((e) => ({
      kind: e.kind,
      callStatus: e.call_status,
      from: e.from_status,
      to: e.to_status,
      note: e.note,
      at: e.at,
      actor: e.actor || (e.kind === "auto" ? "Automatic" : null),
    })),
    otherOpen: others.map(shapeItem),
  };
}
