import pool from "../../config/db.js";
import {
  HEALTHRAY_STATUS_TO_CHAIN,
  chainIndex,
  isChainStatus,
} from "../../../shared/giniflowStatus.js";
import { slotStartTime } from "../../../shared/slotHour.js";
import { advanceStatus, IST_TODAY } from "./statusEngine.js";

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

export async function syncAppointmentsToFlow({ date = null, db = pool } = {}) {
  const client = await db.connect();
  const result = { created: 0, advanced: 0, unchanged: 0, skipped: 0, errors: 0, advancedIds: [] };
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
              v.id AS visit_id, v.current_status
         FROM appointments a
         LEFT JOIN giniflow_visits v
                ON v.patient_id = a.patient_id AND v.visit_date = a.appointment_date
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
      [day, SYNCABLE],
    );

    for (const appt of appts) {
      const target = HEALTHRAY_STATUS_TO_CHAIN[appt.status];
      if (!target) {
        result.skipped++;
        continue;
      }

      // Nothing to do for a visit already at or past the target: skip it without
      // opening a transaction. A BEGIN/COMMIT per appointment over the connection
      // pooler is what made a full day take 20 seconds.
      if (
        appt.visit_id &&
        (appt.current_status === target ||
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
            `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, appointment_time, current_status)
             VALUES ($1, $2::date, $3, $4::time, 'booked')
             ON CONFLICT (patient_id, visit_date) DO UPDATE
               SET appointment_id = COALESCE(giniflow_visits.appointment_id, EXCLUDED.appointment_id)
             RETURNING id, current_status`,
            [appt.patient_id, day, appt.id, slotStartTime(appt.time_slot)],
          );
          visitId = created.rows[0].id;
          currentStatus = created.rows[0].current_status;
          result.created++;
        }

        // Never move a patient backwards: a station screen may have advanced
        // them past what HealthRay knows about, and HealthRay lags by a poll.
        const alreadyThere =
          currentStatus === target ||
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

        await advanceStatus(client, {
          visitId,
          toStatus: effective,
          actorRole: "system",
          allowSkip: true,
          meta: {
            source: "healthray",
            healthray_status: appt.status,
            appointment_id: appt.id,
            observed_from: currentStatus,
          },
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
