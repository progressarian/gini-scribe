import pool from "../../config/db.js";
import {
  manualFloor,
  healthrayMayWrite,
  healthrayTarget,
  holdOnUnrecorded,
  doctorsWaitForTests,
} from "../../../shared/manualFloor.js";
import {
  HEALTHRAY_STATUS_TO_CHAIN,
  BACK_FOR_TESTS,
  EXCEPTION_STATUSES,
  TERMINAL_STATUSES,
  CHAIN,
  chainIndex,
  isChainStatus,
  isExceptionStatus,
  NOT_A_MARKER_SQL,
} from "../../../shared/giniflowStatus.js";
import { slotStartTime } from "../../../shared/slotHour.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import { LAB_ONLY_STEP_NAMES } from "../../../shared/labOnly.js";
import { advanceStatus, IST_TODAY } from "./statusEngine.js";
import { recordHealthrayObservation, firstUnrecordedStation } from "./observation.js";
import { LIVE_LAB_CASE_SQL, TESTS_HOLD_SQL, testsOpenInScribe } from "./testsHold.js";
import { canReadBill, syncBillingForVisitId } from "./machineSync.js";
import { directConsultSql } from "../../../shared/directConsult.js";
import { reassignConsultant } from "./reassign.js";
import { sweepLateTestExits } from "./lateTests.js";
import { syncDayHolds } from "./coordinatorHold.js";
import { finishSyncLease, takeSyncLease } from "./syncLease.js";

const DIRECT_CONSULT_HEALTHRAY_WRITES = ["no_show", "cancelled"];

const PRE_VITALS = ["checked_in", "vitals_pending", "with_vitals"];

async function observeHealthrayVitals(client, day) {
  const { rows } = await client.query(
    `SELECT v.id AS visit_id, hv.id AS vitals_id, hv.recorded_at
       FROM giniflow_visits v
       JOIN LATERAL (
         SELECT id, recorded_at FROM vitals
          WHERE patient_id = v.patient_id
            AND (recorded_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
          ORDER BY recorded_at DESC LIMIT 1
       ) hv ON TRUE
      WHERE v.visit_date = $1::date
        AND v.current_status = ANY($2)
        AND NOT EXISTS (SELECT 1 FROM giniflow_vitals g WHERE g.visit_id = v.id)
        -- HealthRay stamps a vitals row for samples-only patients too, and
        -- advancing on it is what put them on the consultation track. The
        -- status engine now refuses that move, so without this clause the poll
        -- would retry and log the same refusal every cycle, forever.
        AND NOT ${labOnlyPredicate("v", "$3")}`,
    [day, PRE_VITALS, LAB_ONLY_DOCTOR],
  );

  let moved = 0;
  for (const row of rows) {
    try {
      await client.query("BEGIN");
      await advanceStatus(client, {
        visitId: row.visit_id,
        toStatus: "vitals_done",
        actorRole: "system",
        allowSkip: true,
        meta: {
          source: "healthray",
          observed: "vitals",
          vitals_id: row.vitals_id,
          recorded_at: row.recorded_at,
        },
      });
      await client.query("COMMIT");
      moved += 1;
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[giniflow] vitals observation:", row.visit_id, e.message);
    }
  }
  return moved;
}

const SYNCABLE = Object.keys(HEALTHRAY_STATUS_TO_CHAIN);
const BILL_RECHECK_MS = 60 * 60 * 1000;
const BILL_RECHECK_IN_FLIGHT = 2;
const billRechecks = new Map();

const revivesException = (currentStatus, target) =>
  isExceptionStatus(currentStatus) && target === "booked";

const NOT_ARRIVED = ["booked", "confirmed"];

const absentAfterArrival = (currentStatus, target) =>
  manualFloor() &&
  isExceptionStatus(target) &&
  !NOT_ARRIVED.includes(currentStatus) &&
  !isExceptionStatus(currentStatus);

const roomFree = async (client, visitDate, roomStatus) => {
  const { rows } = await client.query(
    `SELECT 1 FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       CROSS JOIN LATERAL (${TESTS_HOLD_SQL("v", "p")}) hold
      WHERE v.visit_date = $1::date AND v.current_status = $2
        AND ($3 OR hold.tests_pending = 0)
      LIMIT 1`,
    [visitDate, roomStatus, !doctorsWaitForTests()],
  );
  return rows.length === 0;
};

async function consultRoomFree(client, visitDate) {
  return roomFree(client, visitDate, "with_doctor");
}

async function chiefRoomFree(client, visitDate) {
  return roomFree(client, visitDate, "with_sd");
}

const PHARMACY_LEG = ["doctor_done", "rx_pending", "with_rx", "pharmacy_pending", "dispensed"];

const atPharmacyLeg = (currentStatus, target, online = false) =>
  target === "exited" && !online && PHARMACY_LEG.includes(currentStatus);

const onlineTarget = (appt, target) =>
  appt.online_journey && manualFloor() && target === "rx_pending" ? "exited" : target;

async function patientsAwaitingMedicines(client, day) {
  const { rows } = await client.query(
    `SELECT DISTINCT m.patient_id
       FROM medications m
      WHERE (m.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
        AND m.is_active
        AND NOT EXISTS (
          SELECT 1 FROM medicine_collections c
           WHERE c.medication_id = m.id AND c.collected_date = $1::date
        )
      UNION
     SELECT DISTINCT a.patient_id
       FROM appointments a
      WHERE a.appointment_date = $1::date
        AND a.patient_id IS NOT NULL
        AND jsonb_array_length(COALESCE(a.healthray_medications, '[]'::jsonb)) > 0
        AND NOT EXISTS (
          SELECT 1 FROM medicine_collections c
            JOIN medications m2 ON m2.id = c.medication_id
           WHERE m2.patient_id = a.patient_id AND c.collected_date = $1::date
        )`,
    [day],
  );
  return new Set(rows.map((r) => r.patient_id));
}

async function pharmacyGraceMinutes(client) {
  const { rows } = await client.query(
    `SELECT budget_minutes FROM giniflow_sla_config WHERE station = 'pharmacy'`,
  );
  return (rows[0]?.budget_minutes || 10) * 3;
}

async function sweepPharmacyLeg(client, day, graceMinutes) {
  const { rows } = await client.query(
    `SELECT v.id
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events e
          WHERE e.visit_id = v.id AND e.status = ANY($3)
          ORDER BY occurred_at DESC LIMIT 1
       ) leg ON TRUE
      WHERE v.visit_date = $1::date
        AND v.current_status = ANY($3)
        AND leg.occurred_at < NOW() - ($2 || ' minutes')::interval
        AND (SELECT h.tests_pending FROM (${TESTS_HOLD_SQL("v", "p")}) h) = 0
        AND NOT EXISTS (
          SELECT 1 FROM giniflow_visit_events e2
           WHERE e2.visit_id = v.id AND e2.meta->>'source' = 'consult_finalize'
        )`,
    [day, graceMinutes, PHARMACY_LEG],
  );

  let swept = 0;
  for (const row of rows) {
    try {
      await client.query("BEGIN");
      await advanceStatus(client, {
        visitId: row.id,
        toStatus: "exited",
        actorRole: "system",
        allowSkip: true,
        meta: {
          source: "healthray",
          reason: "pharmacy_grace_elapsed",
          grace_minutes: graceMinutes,
        },
      });
      await client.query("COMMIT");
      swept += 1;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[giniflow] pharmacy sweep:", row.id, e.message);
    }
  }
  return swept;
}

export const LAB_ONLY_EXIT_GRACE_MINUTES = 0;

const LAB_ONLY_DONE_STATUSES = ["results_ready", "uploaded", "reported", "sent_outside", "done"];

export async function reopenAfterLabOnlyExit(client, day) {
  const { rows } = await client.query(
    `SELECT v.id, consult.id AS appointment_id
       FROM giniflow_visits v
       CROSS JOIN LATERAL (
         SELECT a.id FROM appointments a
          WHERE a.patient_id = v.patient_id
            AND a.appointment_date = v.visit_date
            AND a.status NOT IN ('cancelled', 'no_show')
            AND lower(COALESCE(btrim(a.doctor_name), '')) <> lower($2)
          ORDER BY a.id DESC LIMIT 1
       ) consult
      WHERE v.visit_date = $1::date
        AND v.current_status = 'exited'
        AND v.merged_into_visit_id IS NULL
        AND (SELECT e.meta->>'reason' FROM giniflow_visit_events e
              WHERE e.visit_id = v.id AND ${NOT_A_MARKER_SQL("e.status")}
              ORDER BY e.seq DESC LIMIT 1) = 'lab_only_reports_complete'
        AND NOT EXISTS (SELECT 1 FROM giniflow_visit_events c
                         WHERE c.visit_id = v.id AND c.status = 'checked_in')`,
    [day, LAB_ONLY_DOCTOR],
  );

  let reopened = 0;
  for (const row of rows) {
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE giniflow_visits
            SET current_status = 'booked', appointment_id = $2,
                resume_status = NULL, blocked_reason = NULL, updated_at = NOW()
          WHERE id = $1 AND current_status = 'exited'`,
        [row.id, row.appointment_id],
      );
      await client.query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at, meta)
         VALUES ($1, 'booked', 'system', clock_timestamp(), $2)`,
        [
          row.id,
          {
            source: "giniflow",
            reason: "consult_booked_after_lab_only_exit",
            appointment_id: row.appointment_id,
          },
        ],
      );
      await client.query("COMMIT");
      reopened += 1;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[giniflow] reopen after lab-only exit:", row.id, e.message);
    }
  }
  return reopened;
}

export async function sweepLabOnlyExits(client, day, graceMinutes = LAB_ONLY_EXIT_GRACE_MINUTES) {
  const { rows } = await client.query(
    `SELECT v.id, GREATEST(lab.last_done, ord.last_at, step.last_at) AS exit_at
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       JOIN LATERAL (
         SELECT count(*)::int AS cases,
                count(*) FILTER (WHERE c.done_at IS NULL)::int AS pending,
                max(c.done_at) AS last_done
           FROM (
             SELECT COALESCE(
                      (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on')::timestamptz,
                      (SELECT max(a.created_at) FROM giniflow_lab_case_actions a
                        WHERE a.case_no = lc.case_no
                          AND a.action IN ('results_ready', 'report_uploaded', 'sent_outside'))
                    ) AS done_at
               FROM lab_cases lc
              WHERE lc.case_date = v.visit_date
                AND (lc.patient_id = v.patient_id
                     OR (lc.patient_id IS NULL
                         AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
                AND ${LIVE_LAB_CASE_SQL("lc")}
           ) c
       ) lab ON TRUE
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS orders,
                count(*) FILTER (WHERE o.sample_status <> ALL($6::text[]))::int AS pending,
                count(*) FILTER (WHERE o.payment_status NOT IN ('paid', 'claim_approved'))::int
                  AS unpaid,
                max(o.updated_at) AS last_at
           FROM giniflow_lab_orders o
          WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.sample_status <> 'cancelled'
       ) ord
       CROSS JOIN LATERAL (
         SELECT max(e.occurred_at) AS last_at FROM giniflow_visit_events e
          WHERE e.visit_id = v.id AND ${NOT_A_MARKER_SQL("e.status")}
       ) step
      WHERE v.visit_date = $1::date
        AND v.current_status <> ALL($3)
        AND (lab.cases > 0 OR ord.orders > 0)
        AND lab.pending = 0
        AND ord.pending = 0
        AND ord.unpaid = 0
        AND GREATEST(lab.last_done, ord.last_at, step.last_at)
              < NOW() - ($2 || ' minutes')::interval
        AND ${labOnlyPredicate("v", "$4")}
        AND NOT EXISTS (
          SELECT 1 FROM giniflow_visit_steps s
           WHERE s.visit_id = v.id AND s.chain_status = ANY($5)
        )
        AND NOT EXISTS (
          SELECT 1 FROM giniflow_visit_steps s
           WHERE s.visit_id = v.id AND s.step_catalog_id = 'lab_billing'
             AND s.status IN ('pending', 'in_progress')
        )`,
    [
      day,
      graceMinutes,
      [...EXCEPTION_STATUSES, ...TERMINAL_STATUSES],
      LAB_ONLY_DOCTOR,
      ["sd_pending", "with_sd", "ready_for_doctor", "with_doctor"],
      LAB_ONLY_DONE_STATUSES,
    ],
  );

  let swept = 0;
  for (const row of rows) {
    try {
      await client.query("BEGIN");
      await advanceStatus(client, {
        visitId: row.id,
        toStatus: "exited",
        actorRole: "system",
        allowSkip: true,
        occurredAt: row.exit_at,
        meta: {
          source: "giniflow",
          reason: "lab_only_reports_complete",
          grace_minutes: graceMinutes,
        },
      });
      await client.query("COMMIT");
      swept += 1;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[giniflow] lab-only sweep:", row.id, e.message);
    }
  }
  return swept;
}

export async function addLabOnlyBillingSteps(client, day) {
  try {
    return await insertLabOnlyBillingSteps(client, day);
  } catch (e) {
    console.error("[giniflow] lab-only billing steps:", e.message);
    return 0;
  }
}

async function insertLabOnlyBillingSteps(client, day) {
  const { rowCount } = await client.query(
    `INSERT INTO giniflow_visit_steps
       (visit_id, step_order, step_catalog_id, step_name, planned_duration_min,
        station, assigned_role, chain_status, source)
     SELECT v.id,
            COALESCE((SELECT max(s.step_order) FROM giniflow_visit_steps s WHERE s.visit_id = v.id), 0) + 1,
            c.id, $3, c.default_duration_min, c.station, c.assigned_role, c.chain_status, 'auto'
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       CROSS JOIN flow_step_catalog c
      WHERE c.id = 'lab_billing'
        AND v.visit_date = $1::date
        AND v.merged_into_visit_id IS NULL
        AND v.current_status NOT IN ('no_show', 'cancelled')
        AND ${labOnlyPredicate("v", "$2")}
        AND EXISTS (
          SELECT 1 FROM lab_cases lc
           WHERE lc.case_date = v.visit_date
             AND (lc.patient_id = v.patient_id
                  OR (lc.patient_id IS NULL
                      AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
             AND ${LIVE_LAB_CASE_SQL("lc")})
        AND NOT EXISTS (
          SELECT 1 FROM giniflow_visit_steps s
           WHERE s.visit_id = v.id AND s.step_catalog_id = 'lab_billing')
        AND NOT EXISTS (
          SELECT 1 FROM giniflow_lab_orders o
           WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab')`,
    [day, LAB_ONLY_DOCTOR, LAB_ONLY_STEP_NAMES.lab_billing],
  );
  return rowCount;
}

const ENGAGED_ROOMS = ["with_sd", "with_doctor"];

async function healthrayEventTime(client, visitId, appt, toStatus) {
  const stamp =
    appt.status === "completed"
      ? appt.engaged_end
      : appt.status === "in_visit" && ENGAGED_ROOMS.includes(toStatus)
        ? appt.engaged_start
        : null;
  if (!stamp) return null;
  const { rows } = await client.query(
    `SELECT GREATEST(
              LEAST($2::timestamptz, clock_timestamp()),
              (SELECT max(occurred_at) FROM giniflow_visit_events
                WHERE visit_id = $1 AND ${NOT_A_MARKER_SQL("status")})
            ) AS at`,
    [visitId, stamp],
  );
  return rows[0].at;
}

async function hasCheckedInEvent(client, visitId) {
  const { rows } = await client.query(
    `SELECT 1 FROM giniflow_visit_events
      WHERE visit_id = $1 AND status = 'checked_in' LIMIT 1`,
    [visitId],
  );
  return rows.length > 0;
}

const BEFORE_CONSULT = CHAIN.slice(0, CHAIN.indexOf("with_doctor"));

async function followAppointmentDoctors(client, day, db) {
  const { rows } = await client.query(
    `SELECT v.id, doc.id AS doctor_id
       FROM giniflow_visits v
       JOIN appointments a ON a.id = v.appointment_id
       JOIN doctors doc
         ON lower(btrim(doc.name)) = lower(btrim(a.doctor_name))
        AND doc.role = 'consultant'
        AND COALESCE(doc.is_active, TRUE)
        AND lower(btrim(a.doctor_name)) <> lower($2)
      WHERE v.visit_date = $1::date
        AND v.assigned_doctor_id IS NOT NULL
        AND v.assigned_doctor_id <> doc.id
        AND v.current_status = ANY($3::text[])
        AND NOT ${directConsultSql("a.doctor_name")}`,
    [day, LAB_ONLY_DOCTOR, BEFORE_CONSULT],
  );
  let followed = 0;
  for (const row of rows) {
    try {
      await reassignConsultant(row.id, row.doctor_id, { actorId: null }, db);
      followed++;
    } catch (e) {
      console.error(`giniflow appointment sync: follow doctor ${row.id}: ${e.message}`);
    }
  }
  return followed;
}

export async function syncAppointmentsToFlow({ date = null, db = pool, reuseRecent = true } = {}) {
  const day = date || (await db.query(`SELECT ${IST_TODAY}::text AS d`)).rows[0].d;
  const lease = await takeSyncLease(db, day, { reuseRecent });
  if (lease.skipped) return { date: day, skippedRun: lease.skipped };
  let ok = false;
  try {
    const result = await syncDay(day, db);
    ok = true;
    return result;
  } finally {
    await finishSyncLease(db, day, lease.holder, { ok });
  }
}

async function syncDay(day, db) {
  const client = await db.connect();
  const result = {
    created: 0,
    advanced: 0,
    unchanged: 0,
    refused: 0,
    held: 0,
    heldForTests: 0,
    skipped: 0,
    errors: 0,
    vitalsObserved: 0,
    pharmacySwept: 0,
    advancedIds: [],
  };
  try {
    const { rows: appts } = await client.query(
      `SELECT DISTINCT ON (a.patient_id)
              a.id, a.patient_id, a.status, a.time_slot,
              v.id AS visit_id, v.current_status, v.assigned_doctor_id,
              v.machine_scan_at,
              a.biomarkers->>'engagedStart' AS engaged_start,
              a.biomarkers->>'engagedEnd' AS engaged_end,
              COALESCE(vt.for_online, FALSE) AS online_journey,
              doc.id AS booked_doctor_id,
              (${directConsultSql("a.doctor_name")}
                OR EXISTS (SELECT 1 FROM doctors ad
                            WHERE ad.id = v.assigned_doctor_id AND ad.direct_consult)) AS direct_consult
         FROM appointments a
         LEFT JOIN giniflow_visits v
                ON v.patient_id = a.patient_id AND v.visit_date = a.appointment_date
         LEFT JOIN flow_visit_types vt ON vt.id = v.visit_type_id
         -- The consultant the patient booked with. HealthRay records it as free
         -- text on the appointment (doctor_name), never as an id, so it is
         -- resolved here against the roster — exactly, and only for someone who
         -- actually consults. A near-miss is deliberately left unresolved: the
         -- cost of guessing is a patient queued to the wrong consultant, which
         -- is worse than an unassigned one that first-claim will pick up.
         -- The lab-only provider is excluded even though it IS a consultant row:
         -- a samples-only registration has no consultation to assign, and
         -- resolving it handed the visit a doctor nobody would ever see, put a
         -- name on the card that reads as booked, and counted toward that
         -- "doctor's" load on the triage staff list.
         LEFT JOIN doctors doc
                ON lower(btrim(doc.name)) = lower(btrim(a.doctor_name))
               AND doc.role = 'consultant'
               AND COALESCE(doc.is_active, TRUE)
               AND lower(btrim(a.doctor_name)) <> lower($3)
        WHERE a.appointment_date = $1::date
          AND a.patient_id IS NOT NULL
          AND a.status = ANY($2)
          AND NOT EXISTS (
                SELECT 1 FROM patients p WHERE p.id = a.patient_id AND p.is_blocked
              )
          AND NOT (COALESCE(v.echo_referral, FALSE) AND ${directConsultSql("a.doctor_name")})
        ORDER BY a.patient_id,
                 CASE a.status
                   WHEN 'completed' THEN 4
                   WHEN 'seen'      THEN 4
                   WHEN 'in_visit'  THEN 3
                   WHEN 'checkedin' THEN 2
                   WHEN 'scheduled' THEN 1
                   ELSE 0
                 END DESC,
                 a.id DESC`,
      [day, SYNCABLE, LAB_ONLY_DOCTOR],
    );

    result.repointed = (
      await client.query(
        `UPDATE giniflow_visits v
            SET appointment_id = consult.id, updated_at = NOW()
           FROM appointments cur
           CROSS JOIN LATERAL (
             SELECT a.id FROM appointments a
              WHERE a.patient_id = cur.patient_id
                AND a.appointment_date = cur.appointment_date
                AND a.status NOT IN ('cancelled', 'no_show')
                AND lower(COALESCE(btrim(a.doctor_name), '')) <> lower($2)
              ORDER BY a.id DESC LIMIT 1
           ) consult
          WHERE cur.id = v.appointment_id
            AND v.visit_date = $1::date
            AND lower(btrim(cur.doctor_name)) = lower($2)`,
        [day, LAB_ONLY_DOCTOR],
      )
    ).rowCount;

    result.echoReferrals = (
      await client.query(
        `UPDATE giniflow_visits v
            SET echo_referral = TRUE, updated_at = NOW()
          WHERE v.visit_date = $1::date
            AND NOT v.echo_referral
            AND EXISTS (
                  SELECT 1 FROM appointments k
                   WHERE k.patient_id = v.patient_id AND k.appointment_date = v.visit_date
                     AND k.status NOT IN ('cancelled', 'no_show')
                     AND ${directConsultSql("k.doctor_name")})
            AND EXISTS (
                  SELECT 1 FROM appointments o
                   WHERE o.patient_id = v.patient_id AND o.appointment_date = v.visit_date
                     AND o.status NOT IN ('cancelled', 'no_show')
                     AND lower(COALESCE(btrim(o.doctor_name), '')) <> lower($2)
                     AND btrim(COALESCE(o.doctor_name, '')) <> ''
                     AND NOT ${directConsultSql("o.doctor_name")})`,
        [day, LAB_ONLY_DOCTOR],
      )
    ).rowCount;

    result.echoRepointed = (
      await client.query(
        `UPDATE giniflow_visits v
            SET appointment_id = other.id,
                assigned_doctor_id = CASE
                  WHEN v.assigned_doctor_id IS NULL OR COALESCE(cur_doc.direct_consult, FALSE)
                    THEN COALESCE(other_doc.id, v.assigned_doctor_id)
                  ELSE v.assigned_doctor_id
                END,
                updated_at = NOW()
           FROM giniflow_visits base
           LEFT JOIN appointments cur ON cur.id = base.appointment_id
           LEFT JOIN doctors cur_doc ON cur_doc.id = base.assigned_doctor_id
           CROSS JOIN LATERAL (
             SELECT a.id, a.doctor_name FROM appointments a
              WHERE a.patient_id = base.patient_id
                AND a.appointment_date = base.visit_date
                AND a.status NOT IN ('cancelled', 'no_show')
                AND lower(COALESCE(btrim(a.doctor_name), '')) <> lower($2)
                AND btrim(COALESCE(a.doctor_name, '')) <> ''
                AND NOT ${directConsultSql("a.doctor_name")}
              ORDER BY a.id DESC LIMIT 1
           ) other
           LEFT JOIN doctors other_doc
                  ON lower(btrim(other_doc.name)) = lower(btrim(other.doctor_name))
                 AND other_doc.role = 'consultant'
                 AND COALESCE(other_doc.is_active, TRUE)
          WHERE v.id = base.id
            AND base.visit_date = $1::date
            AND base.echo_referral
            AND (base.appointment_id IS NULL
                 OR ${directConsultSql("cur.doctor_name")}
                 OR base.assigned_doctor_id IS NULL
                 OR COALESCE(cur_doc.direct_consult, FALSE))`,
        [day, LAB_ONLY_DOCTOR],
      )
    ).rowCount;

    const assigned = await client.query(
      `UPDATE giniflow_visits v
          SET assigned_doctor_id = doc.id, updated_at = NOW()
         FROM appointments a
         JOIN doctors doc
           ON lower(btrim(doc.name)) = lower(btrim(a.doctor_name))
          AND doc.role = 'consultant'
          AND COALESCE(doc.is_active, TRUE)
          AND lower(btrim(a.doctor_name)) <> lower($2)
        WHERE a.id = v.appointment_id
          AND v.visit_date = $1::date
          AND v.assigned_doctor_id IS NULL`,
      [day, LAB_ONLY_DOCTOR],
    );
    result.assigned = assigned.rowCount;
    result.followedDoctor = await followAppointmentDoctors(client, day, db);

    result.vitalsObserved = manualFloor() ? 0 : await observeHealthrayVitals(client, day);

    result.pharmacySwept = manualFloor()
      ? 0
      : await sweepPharmacyLeg(client, day, await pharmacyGraceMinutes(client));
    result.labOnlyBilling = await addLabOnlyBillingSteps(client, day);
    result.labOnlySwept = await sweepLabOnlyExits(client, day);
    result.reopenedAfterLabOnly = await reopenAfterLabOnlyExit(client, day);
    result.lateTestsClosed = await sweepLateTestExits(client, day);
    result.coordinatorHolds = await syncDayHolds(client, day);
    const awaitingMedicines = manualFloor()
      ? new Set()
      : await patientsAwaitingMedicines(client, day);

    for (const [visitId, recheck] of billRechecks) {
      if (recheck.done && recheck.day < day) billRechecks.delete(visitId);
    }

    for (const appt of appts) {
      const target = onlineTarget(appt, healthrayTarget(appt.status, HEALTHRAY_STATUS_TO_CHAIN));
      if (!target) {
        result.skipped++;
        continue;
      }
      const mayWrite = (status) =>
        appt.direct_consult
          ? DIRECT_CONSULT_HEALTHRAY_WRITES.includes(status)
          : healthrayMayWrite(status) || (appt.online_journey && status === "exited");
      if (appt.visit_id && (!mayWrite(target) || absentAfterArrival(appt.current_status, target))) {
        result.refused++;
        continue;
      }
      if (
        appt.visit_id &&
        (appt.current_status === target ||
          revivesException(appt.current_status, target) ||
          atPharmacyLeg(appt.current_status, target, appt.online_journey) ||
          (isChainStatus(appt.current_status) &&
            isChainStatus(target) &&
            chainIndex(appt.current_status) >= chainIndex(target)))
      ) {
        result.unchanged++;
        continue;
      }

      if (
        appt.visit_id &&
        (target === "rx_pending" || (appt.online_journey && target === "exited")) &&
        doctorsWaitForTests()
      ) {
        const scannedAt = appt.machine_scan_at ? new Date(appt.machine_scan_at).getTime() : 0;
        const recheck = billRechecks.get(appt.visit_id);
        if (
          !recheck &&
          Date.now() - scannedAt > BILL_RECHECK_MS &&
          (await canReadBill(appt.visit_id, db))
        ) {
          const inFlight = [...billRechecks.values()].filter((r) => !r.done).length;
          if (inFlight >= BILL_RECHECK_IN_FLIGHT) {
            result.heldForTests++;
            continue;
          }
          const entry = { done: false, day };
          billRechecks.set(appt.visit_id, entry);
          syncBillingForVisitId(appt.visit_id, db)
            .catch((e) =>
              console.error(
                `giniflow appointment sync: bill recheck ${appt.visit_id}: ${e.message}`,
              ),
            )
            .finally(() => {
              entry.done = true;
            });
          result.heldForTests++;
          continue;
        }
        if (recheck && !recheck.done) {
          result.heldForTests++;
          continue;
        }
      }

      try {
        await client.query("BEGIN");

        let visitId = appt.visit_id;
        let currentStatus = appt.current_status;

        if (!visitId) {
          await client.query(
            `UPDATE giniflow_visits SET appointment_id = NULL
              WHERE appointment_id = $1 AND visit_date <> $2::date
                AND current_status IN ('no_show', 'cancelled')`,
            [appt.id, day],
          );
          const created = await client.query(
            `INSERT INTO giniflow_visits
               (patient_id, visit_date, appointment_id, appointment_time, current_status,
                assigned_doctor_id)
             VALUES ($1, $2::date,
                     CASE WHEN EXISTS (SELECT 1 FROM giniflow_visits held
                                        WHERE held.appointment_id = $3)
                          THEN NULL ELSE $3 END,
                     $4::time, 'booked', $5)
             ON CONFLICT (patient_id, visit_date) DO UPDATE
               SET appointment_id = COALESCE(giniflow_visits.appointment_id, EXCLUDED.appointment_id)
             RETURNING id, current_status`,
            [appt.patient_id, day, appt.id, slotStartTime(appt.time_slot), appt.booked_doctor_id],
          );
          visitId = created.rows[0].id;
          currentStatus = created.rows[0].current_status;
          result.created++;
        }

        if (!mayWrite(target) || absentAfterArrival(currentStatus, target)) {
          await client.query("COMMIT");
          result.refused++;
          continue;
        }
        const alreadyThere =
          currentStatus === target ||
          currentStatus === BACK_FOR_TESTS ||
          revivesException(currentStatus, target) ||
          atPharmacyLeg(currentStatus, target, appt.online_journey) ||
          (isChainStatus(currentStatus) &&
            isChainStatus(target) &&
            chainIndex(currentStatus) >= chainIndex(target));

        if (alreadyThere) {
          await client.query("COMMIT");
          result.unchanged++;
          continue;
        }
        if (holdOnUnrecorded() && isChainStatus(target)) {
          const owed = await firstUnrecordedStation(client, visitId);
          if (owed) {
            await client.query("COMMIT");
            result.held++;
            continue;
          }
        }

        if (
          isChainStatus(target) &&
          chainIndex(target) >= chainIndex("sd_pending") &&
          (await testsOpenInScribe(client, visitId)) > 0
        ) {
          await client.query("COMMIT");
          result.heldForTests++;
          continue;
        }

        let effective = target;
        if (
          target === "ready_for_doctor" &&
          healthrayMayWrite("with_doctor") &&
          (await consultRoomFree(client, day))
        ) {
          effective = "with_doctor";
        }
        if (
          target === "sd_pending" &&
          healthrayMayWrite("with_sd") &&
          (await chiefRoomFree(client, day))
        ) {
          effective = "with_sd";
        }
        if (target === "exited" && awaitingMedicines.has(appt.patient_id)) {
          effective = "rx_pending";
        }

        const meta = {
          source: "healthray",
          healthray_status: appt.status,
          appointment_id: appt.id,
          observed_from: currentStatus,
        };
        if (
          healthrayMayWrite("checked_in") &&
          isChainStatus(effective) &&
          chainIndex(effective) > chainIndex("checked_in") &&
          (!isChainStatus(currentStatus) || chainIndex(currentStatus) < chainIndex("checked_in")) &&
          !(await hasCheckedInEvent(client, visitId))
        ) {
          await advanceStatus(client, {
            visitId,
            toStatus: "checked_in",
            actorRole: "system",
            allowSkip: true,
            meta: { ...meta, implied: true },
          });
        }

        await advanceStatus(client, {
          visitId,
          toStatus: effective,
          actorRole: "system",
          allowSkip: true,
          occurredAt: await healthrayEventTime(client, visitId, appt, effective),
          meta,
        });
        await client.query("COMMIT");
        result.advanced++;
        result.advancedIds.push(visitId);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        result.errors++;
        console.error(`giniflow appointment sync: appointment ${appt.id}: ${e.message}`);
      }
    }

    const observed = await recordHealthrayObservation(client, day);

    return { date: day, considered: appts.length, ...result, ...observed };
  } finally {
    client.release();
  }
}
