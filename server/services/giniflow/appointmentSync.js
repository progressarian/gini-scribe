import pool from "../../config/db.js";
import {
  HEALTHRAY_STATUS_TO_CHAIN,
  EXCEPTION_STATUSES,
  TERMINAL_STATUSES,
  chainIndex,
  isChainStatus,
  isExceptionStatus,
} from "../../../shared/giniflowStatus.js";
import { slotStartTime } from "../../../shared/slotHour.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import { advanceStatus, IST_TODAY } from "./statusEngine.js";

// Vitals HealthRay recorded, which its appointment status cannot express.
//
// The nurses take vitals on HealthRay's own screen, and HealthRay has no
// appointment status meaning "vitals done" — a patient whose BP was measured
// stays `checkedin` there and so stayed `checked_in` here, sitting in the vitals
// queue with their readings already on file. On the day this was written that
// was 11 of the 38 patients the station was showing as waiting, one of them a
// 166/106 nobody had looked at.
//
// So the `vitals` table is read as the observation it is. Only forward, only
// from a pre-vitals status, and only once: a patient already at `vitals_done` or
// beyond no longer matches, which is what makes this safe to run every poll.
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
        AND NOT EXISTS (SELECT 1 FROM giniflow_vitals g WHERE g.visit_id = v.id)`,
    [day, PRE_VITALS],
  );

  let moved = 0;
  for (const row of rows) {
    try {
      await client.query("BEGIN");
      // `allowSkip`, deliberately: checked_in → vitals_done is a three-step jump
      // the chain would otherwise refuse, and this is exactly the caller that
      // flag exists for — an observation of a patient further along than we
      // last saw them, with no knowledge of how they got there.
      await advanceStatus(client, {
        visitId: row.visit_id,
        toStatus: "vitals_done",
        actorRole: "system",
        allowSkip: true,
        meta: {
          source: "healthray",
          observed: "vitals",
          vitals_id: row.vitals_id,
          // HealthRay stores most of these as a date with no clock time, so the
          // event carries what it actually knows rather than implying a minute.
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

// Turns HealthRay's appointment list into Gini Flow visits.
//
// HealthRay has no webhooks, so `appointments` is kept current by the worker's
// own polling loop; this reads that table rather than calling HealthRay again.
// A screen polling every 10s must never reach HealthRay directly — tight polling
// trips their WAF into a 403 IP block.
//
// It does NOT touch the older flow_* module. `appointments` is the hospital's
// data, shared by both, which is the one thing the separation decision allows.

const SYNCABLE = Object.keys(HEALTHRAY_STATUS_TO_CHAIN);

// A visit the floor deliberately took OFF the day must not be put back on it by
// a poll. `booked` is where every day starts, so it is never evidence of
// anything: HealthRay reports `scheduled` for any appointment nobody has
// touched, and an OBT-booked row keeps that value permanently because the
// appointment exists only in our database — HealthRay was never told about it.
// So `scheduled` → `booked` over a no-show or a cancellation is the sync
// asserting the absence of news as news, and it undid reception twice in fifty
// minutes on 3 Sep 2026.
//
// Only `booked` is refused. A target further along the chain IS real evidence —
// a patient marked no-show who is later checked in at the desk did turn up, and
// that should still come through. Un-cancelling is a decision, not an
// observation, so it stays with the desk's own Undo button.
const revivesException = (currentStatus, target) =>
  isExceptionStatus(currentStatus) && target === "booked";

// HealthRay reports `in_visit` when the patient reaches the consultation stage,
// not when a doctor starts. Advancing everyone straight into `with_doctor` would
// show one doctor seeing four patients at once — the exact bug the older module
// hit. So the sync parks them in the queue and only moves one patient into the
// room when the room is free.
async function consultRoomFree(client, visitDate) {
  const { rows } = await client.query(
    `SELECT 1 FROM giniflow_visits
      WHERE visit_date = $1::date AND current_status = 'with_doctor' LIMIT 1`,
    [visitDate],
  );
  return rows.length === 0;
}

// The pharmacy leg HealthRay cannot see.
//
// HealthRay's `completed` means the consultation is over, and it was mapped
// straight to `exited` — so a patient walked out of the system the moment the
// doctor finished, and no visit in the table's history has ever held
// `doctor_done` or `pharmacy_pending`. The counter's queue was not empty, it was
// unreachable.
//
// A patient with medicines prescribed today and nothing recorded against them in
// `medicine_collections` still has to collect them, so `completed` parks them at
// the pharmacy instead. Nothing is invented: the evidence is a prescription with
// no dispensing record.
const PHARMACY_LEG = ["doctor_done", "rx_pending", "with_rx", "pharmacy_pending", "dispensed"];

const atPharmacyLeg = (currentStatus, target) =>
  target === "exited" && PHARMACY_LEG.includes(currentStatus);

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

// The floor does not work the pharmacy screen, so a patient parked there would
// stay there all day and the board would fill with a queue nobody is standing
// in. The grace period is what makes the leg safe to write: past three times the
// station's own budget the sync completes the exit itself, so the queue always
// drains without the counter having to.
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
       JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events e
          WHERE e.visit_id = v.id AND e.status = ANY($3)
          ORDER BY occurred_at DESC LIMIT 1
       ) leg ON TRUE
      WHERE v.visit_date = $1::date
        AND v.current_status = ANY($3)
        AND leg.occurred_at < NOW() - ($2 || ' minutes')::interval`,
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

// A lab-only visit is over when its last report lands. HealthRay will never say
// so — it has no consultation to complete, so the appointment sits at
// `checkedin` for ever: across the six days Gini Flow has run, 41 lab-only
// visits were created and not one of them ever exited. They stayed in "In
// building now" all day, could never reach "Completed", and their open clock
// went on counting against a floor they had already left.
//
// The evidence is the same one the lab station reads: every case of the day
// reported. The grace period is short because nothing follows a report — it
// only covers the patient still at the counter collecting a printout.
export const LAB_ONLY_EXIT_GRACE_MINUTES = 15;

export async function sweepLabOnlyExits(client, day, graceMinutes = LAB_ONLY_EXIT_GRACE_MINUTES) {
  const { rows } = await client.query(
    `SELECT v.id, lab.last_report
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       JOIN LATERAL (
         SELECT count(*)::int AS cases,
                count(*) FILTER (
                  WHERE COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' IS NULL
                )::int AS pending,
                max((COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on')::timestamptz)
                  AS last_report
           FROM lab_cases lc
          WHERE lc.case_date = v.visit_date
            AND (lc.patient_id = v.patient_id
                 OR (lc.patient_id IS NULL
                     AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
       ) lab ON TRUE
      WHERE v.visit_date = $1::date
        AND v.current_status <> ALL($3)
        AND lab.cases > 0
        AND lab.pending = 0
        AND lab.last_report < NOW() - ($2 || ' minutes')::interval
        AND ${labOnlyPredicate("v", "$4")}`,
    [day, graceMinutes, [...EXCEPTION_STATUSES, ...TERMINAL_STATUSES], LAB_ONLY_DOCTOR],
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
        // Dated when the patient actually finished — the last report — not when
        // the sweep happened to notice. Stamping NOW would give a visit closed
        // days later a journey of several thousand minutes.
        occurredAt: row.last_report,
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

async function hasCheckedInEvent(client, visitId) {
  const { rows } = await client.query(
    `SELECT 1 FROM giniflow_visit_events
      WHERE visit_id = $1 AND status = 'checked_in' LIMIT 1`,
    [visitId],
  );
  return rows.length > 0;
}

export async function syncAppointmentsToFlow({ date = null, db = pool } = {}) {
  const client = await db.connect();
  const result = {
    created: 0,
    advanced: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    vitalsObserved: 0,
    pharmacySwept: 0,
    advancedIds: [],
  };
  try {
    const day = date || (await client.query(`SELECT ${IST_TODAY}::text AS d`)).rows[0].d;

    // Blocked patients are excluded here as they are everywhere else in this
    // repo — a blocked patient should not appear on a floor board.
    // One row per PATIENT, not per appointment. A patient can hold several
    // appointments on one day — five did today, one of them "cancelled" plus
    // "checkedin". Since there is exactly one visit per patient per day, two rows
    // fight over it and the sync writes an event for each on every run: the visit
    // oscillated checked_in → cancelled → checked_in forever.
    //
    // The winner is the appointment furthest along the chain, with cancelled and
    // no-show ranked last: a patient with a cancelled slot and a live one is here.
    const { rows: appts } = await client.query(
      `SELECT DISTINCT ON (a.patient_id)
              a.id, a.patient_id, a.status, a.time_slot,
              v.id AS visit_id, v.current_status, v.assigned_doctor_id,
              doc.id AS booked_doctor_id
         FROM appointments a
         LEFT JOIN giniflow_visits v
                ON v.patient_id = a.patient_id AND v.visit_date = a.appointment_date
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

    // The consultant the patient booked with, in one statement for the whole
    // day. It runs outside the per-appointment loop deliberately: that loop
    // skips any visit whose status already matches HealthRay, which on a normal
    // day is every one of them — so an assignment written in there would almost
    // never run.
    //
    // COALESCE, never an overwrite: a consultant who has already claimed the
    // patient keeps them, because who is in the room beats who was booked.
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

    result.vitalsObserved = await observeHealthrayVitals(client, day);

    const grace = await pharmacyGraceMinutes(client);
    result.pharmacySwept = await sweepPharmacyLeg(client, day, grace);
    result.labOnlySwept = await sweepLabOnlyExits(client, day);
    const awaitingMedicines = await patientsAwaitingMedicines(client, day);

    for (const appt of appts) {
      const target = HEALTHRAY_STATUS_TO_CHAIN[appt.status];
      if (!target) {
        result.skipped++;
        continue;
      }

      // Nothing to do for a visit already at or past the target, or for one the
      // floor took off the day: skip it without opening a transaction. A
      // BEGIN/COMMIT per appointment over the connection pooler is what made a
      // full day take 20 seconds — and a cancelled patient would otherwise open
      // one on every poll, all day, to write an event nobody wants.
      if (
        appt.visit_id &&
        (appt.current_status === target ||
          revivesException(appt.current_status, target) ||
          atPharmacyLeg(appt.current_status, target) ||
          (isChainStatus(appt.current_status) &&
            isChainStatus(target) &&
            chainIndex(appt.current_status) >= chainIndex(target)))
      ) {
        result.unchanged++;
        continue;
      }

      try {
        await client.query("BEGIN");

        let visitId = appt.visit_id;
        let currentStatus = appt.current_status;

        if (!visitId) {
          const created = await client.query(
            `INSERT INTO giniflow_visits
               (patient_id, visit_date, appointment_id, appointment_time, current_status,
                assigned_doctor_id)
             VALUES ($1, $2::date, $3, $4::time, 'booked', $5)
             ON CONFLICT (patient_id, visit_date) DO UPDATE
               SET appointment_id = COALESCE(giniflow_visits.appointment_id, EXCLUDED.appointment_id)
             RETURNING id, current_status`,
            [appt.patient_id, day, appt.id, slotStartTime(appt.time_slot), appt.booked_doctor_id],
          );
          visitId = created.rows[0].id;
          currentStatus = created.rows[0].current_status;
          result.created++;
        }

        // Never move a patient backwards: a station screen may have advanced
        // them past what HealthRay knows about, and HealthRay lags by a poll.
        // Re-checked here and not only above because the ON CONFLICT insert
        // above returns the EXISTING row's status when a visit was created
        // between the read and now — which can be a cancellation.
        const alreadyThere =
          currentStatus === target ||
          revivesException(currentStatus, target) ||
          atPharmacyLeg(currentStatus, target) ||
          (isChainStatus(currentStatus) &&
            isChainStatus(target) &&
            chainIndex(currentStatus) >= chainIndex(target));

        if (alreadyThere) {
          await client.query("COMMIT");
          result.unchanged++;
          continue;
        }

        let effective = target;
        if (target === "ready_for_doctor" && (await consultRoomFree(client, day))) {
          effective = "with_doctor";
        }
        if (target === "exited" && awaitingMedicines.has(appt.patient_id)) {
          effective = "pharmacy_pending";
        }

        const meta = {
          source: "healthray",
          healthray_status: appt.status,
          appointment_id: appt.id,
          observed_from: currentStatus,
        };

        if (
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

    return { date: day, considered: appts.length, ...result };
  } finally {
    client.release();
  }
}
