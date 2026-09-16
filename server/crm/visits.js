import { withCrmContext } from "./db.js";
import {
  VISIT_TYPE_VALUES,
  VISIT_OUTCOME_VALUES,
  DOCTOR_PRIORITY_VALUES,
} from "../../shared/crmVocab.js";

// Visit logging (brief §5) and the rep home screen (§13).
//
// The one constraint that shapes everything here: a rep logs a visit standing
// in a corridor, on a phone, often with no signal. So the visit id is minted on
// the CLIENT, and this module is written to be called twice with the same id
// and do the work once. That is what makes the offline queue safe to retry —
// there is no dedupe pass, no "did this already send?" bookkeeping, just a
// primary key doing its job.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Create a visit, or return the one already stored under this id.
 *
 * ON CONFLICT DO NOTHING plus a follow-up SELECT, rather than an upsert: a
 * replayed visit must not overwrite what the rep may have since corrected on
 * another device. First write wins, every later attempt is a no-op that still
 * reports success so the queue can drain.
 */
export async function logVisit(crmUser, visit) {
  const {
    id,
    doctor_id,
    visit_type = "in_person",
    purpose,
    occurred_at,
    discussion_notes,
    outcome,
    follow_up_required = false,
    next_visit_date,
    gps,
    client_created_at,
  } = visit;

  if (!id) throw new Error("A visit needs a client-generated id");
  if (!doctor_id) throw new Error("A visit needs a doctor");
  if (!VISIT_TYPE_VALUES.includes(visit_type)) throw new Error(`Unknown visit type: ${visit_type}`);
  if (outcome && !VISIT_OUTCOME_VALUES.includes(outcome)) {
    throw new Error(`Unknown outcome: ${outcome}`);
  }

  return withCrmContext(crmUser, async (sql) => {
    const { rows: hos } = await sql("SELECT id FROM crm.hospitals WHERE code = 'GACH'");
    const { rows: inserted } = await sql(
      `INSERT INTO crm.visits
         (id, hospital_id, doctor_id, executive_id, visit_type, purpose, occurred_at,
          discussion_notes, outcome, follow_up_required, next_visit_date,
          gps_latitude, gps_longitude, gps_accuracy_m, gps_captured_at,
          client_created_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()),$8,$9,$10,$11,$12,$13,$14,$15,$16,$4)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, occurred_at, synced_at`,
      [
        id,
        hos[0]?.id,
        doctor_id,
        crmUser.id,
        visit_type,
        purpose ?? null,
        occurred_at ?? null,
        discussion_notes ?? null,
        outcome ?? null,
        Boolean(follow_up_required),
        next_visit_date ?? null,
        gps?.latitude ?? null,
        gps?.longitude ?? null,
        gps?.accuracy ?? null,
        gps?.captured_at ?? null,
        client_created_at ?? null,
      ],
    );

    if (inserted[0]) return { ...inserted[0], duplicate: false };

    const { rows: existing } = await sql(
      "SELECT id, occurred_at, synced_at FROM crm.visits WHERE id = $1",
      [id],
    );
    return { ...existing[0], duplicate: true };
  });
}

/**
 * Fill a gap on a doctor record from the visit screen.
 *
 * The universe arrives as skeleton records — 47 doctors, no phone numbers —
 * and the only people who will ever learn those numbers are the reps standing
 * in front of them. So the gaps are answered where the rep already is, rather
 * than in a back-office data-cleaning screen nobody opens.
 */
export async function fillDoctorGap(crmUser, doctorId, patch) {
  const allowed = ["mobile", "whatsapp", "email", "specialty", "clinic_name", "area", "priority"];
  const fields = Object.entries(patch).filter(
    ([k, v]) => allowed.includes(k) && v !== undefined && v !== null && String(v).trim() !== "",
  );
  if (fields.length === 0) throw new Error("Nothing to update");
  if (patch.priority && !DOCTOR_PRIORITY_VALUES.includes(patch.priority)) {
    throw new Error(`Unknown priority: ${patch.priority}`);
  }

  return withCrmContext(crmUser, async (sql) => {
    const sets = fields.map(([k], i) => `${k} = $${i + 2}`).join(", ");
    const { rows } = await sql(
      `UPDATE crm.doctors SET ${sets}, updated_by = $${fields.length + 2}
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, full_name, mobile, specialty, clinic_name, area,
                  profile_complete, missing_fields`,
      [doctorId, ...fields.map(([, v]) => String(v).trim()), crmUser.id],
    );
    if (!rows[0]) throw new Error("Doctor not found, or not yours");
    return rows[0];
  });
}

/**
 * Everything the home screen needs, in one round trip.
 *
 * A rep opens this on a corridor connection. Six separate requests would mean
 * six chances to hang; one means the screen either arrives or it does not.
 */
export async function repHome(crmUser, { limit = 25 } = {}) {
  return withCrmContext(crmUser, async (sql) => {
    const [todays, due, dueTotal, doctors, tasks, performance] = await Promise.all([
      sql(
        `SELECT v.id, v.doctor_id, d.full_name, d.area, v.visit_type, v.outcome, v.occurred_at
           FROM crm.visits v JOIN crm.doctors d ON d.id = v.doctor_id
          WHERE v.deleted_at IS NULL
            AND v.executive_id = $1
            AND v.occurred_at >= date_trunc('day', now())
          ORDER BY v.occurred_at DESC`,
        [crmUser.id],
      ),
      // v_doctor_visit_due carries the cadence maths, not the doctor's details,
      // so the specialty and area the rep needs to recognise a name come from
      // the table itself.
      sql(
        `SELECT vd.doctor_id, vd.full_name, vd.priority, vd.due_state,
                vd.last_visit_at, vd.next_due_on,
                d.specialty, d.area, d.mobile, d.profile_complete
           FROM crm.v_doctor_visit_due vd
           JOIN crm.doctors d ON d.id = vd.doctor_id
          WHERE vd.due_state IN ('overdue', 'due', 'never_visited')
          ORDER BY CASE vd.due_state WHEN 'overdue' THEN 0 WHEN 'due' THEN 1 ELSE 2 END,
                   CASE vd.priority WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END,
                   vd.last_visit_at NULLS FIRST
          LIMIT $1`,
        [clamp(Number(limit) || 25, 1, 100)],
      ),
      // The list is paged; the COUNT is not. Without this the home screen
      // showed the page size as the workload — "To visit 25" when 46 doctors
      // were waiting — which is the one number on that screen a rep plans
      // their day around.
      sql(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE due_state = 'overdue')::int AS overdue,
                count(*) FILTER (WHERE due_state = 'never_visited')::int AS never_visited
           FROM crm.v_doctor_visit_due
          WHERE due_state IN ('overdue', 'due', 'never_visited')`,
      ),
      sql(
        `SELECT d.id AS doctor_id, d.full_name, d.specialty, d.area, d.city, d.priority,
                d.relationship_stage, d.mobile, d.profile_complete, d.missing_fields,
                d.needs_verification, t.name AS territory_name,
                vd.due_state, vd.last_visit_at
           FROM crm.doctors d
           LEFT JOIN crm.territories t ON t.id = d.territory_id
           LEFT JOIN crm.v_doctor_visit_due vd ON vd.doctor_id = d.id
          WHERE d.deleted_at IS NULL AND d.is_active
          ORDER BY t.name NULLS LAST,
                   CASE d.priority WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END,
                   d.full_name`,
      ),
      sql(
        `SELECT id, title, due_date, priority, status, doctor_id
           FROM crm.tasks
          WHERE deleted_at IS NULL AND owner_id = $1 AND status IN ('open', 'in_progress')
          ORDER BY due_date NULLS LAST, CASE priority
                     WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                     WHEN 'normal' THEN 2 ELSE 3 END
          LIMIT 25`,
        [crmUser.id],
      ),
      sql(
        `SELECT
           count(*) FILTER (WHERE occurred_at >= date_trunc('day', now()))::int   AS visits_today,
           count(*) FILTER (WHERE occurred_at >= date_trunc('week', now()))::int  AS visits_week,
           count(*) FILTER (WHERE occurred_at >= date_trunc('month', now()))::int AS visits_month,
           count(DISTINCT doctor_id) FILTER (WHERE occurred_at >= date_trunc('month', now()))::int
             AS unique_doctors_month
           FROM crm.visits WHERE deleted_at IS NULL AND executive_id = $1`,
        [crmUser.id],
      ),
    ]);

    const myDoctors = doctors.rows;
    return {
      user: { id: crmUser.id, name: crmUser.full_name, role: crmUser.role },
      todays_visits: todays.rows,
      due_visits: due.rows,
      due_summary: {
        ...dueTotal.rows[0],
        showing: due.rows.length,
      },
      my_doctors: myDoctors,
      tasks: tasks.rows,
      performance: {
        ...performance.rows[0],
        // The reason the import shipped skeleton records: turning fieldwork
        // into the thing that completes the universe.
        doctors_assigned: myDoctors.length,
        doctors_incomplete: myDoctors.filter((d) => !d.profile_complete).length,
      },
    };
  });
}

/**
 * The next visit date the cadence policy implies, so the rep confirms a date
 * rather than choosing one. A/B doctors every 15 days, C every 45.
 */
export async function suggestedNextVisit(crmUser, doctorId) {
  return withCrmContext(crmUser, async (sql) => {
    const { rows } = await sql(
      `SELECT (now() + make_interval(days => p.interval_days))::date AS next_visit_date,
              p.interval_days, d.priority
         FROM crm.doctors d
         JOIN crm.visit_cadence_policies p
           ON p.hospital_id = d.hospital_id AND p.priority = d.priority
        WHERE d.id = $1`,
      [doctorId],
    );
    return rows[0] ?? null;
  });
}
