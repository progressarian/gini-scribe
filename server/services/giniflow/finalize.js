import pool from "../../config/db.js";
import { advanceStatus } from "./statusEngine.js";
import { markMedicationVisitStatus } from "../medication/visitStatus.js";
import { savePrescriptionForVisit, buildVisitPayloadFromDb } from "../prescriptionAutoSave.js";

// Finalize — brief §2.3 trigger 4, docs/gini-flow/14-CONSULTANT-PRESCRIPTION-PLAN.md §6.
//
// ONE TRANSACTION. Either all of it happens or none of it does: a prescription
// that reached the pharmacy but not the patient's app is worse than a failed
// save, and a patient moved to `pharmacy_pending` with no medicines behind them
// is worse than both.
//
// Everything that can fail slowly — the PDF, the Genie push — happens AFTER the
// commit, never inside it.
//
// PLAN NOTE. The plan said to extract the body of `POST /api/consultations` into
// a shared `consultationSave.js` and call it from here. That is still the right
// end state, but it is NOT done in this pass: that route is the live Scribe save
// path, it is bound to the wizard's own payload shape (`mo_data` / `con_data` /
// `exam_data`), and the repo has no test suite to catch a regression in it.
// Writing this module against the same helpers and the same conflict keys, and
// converging later, is the smaller risk. What actually protects the invariant is
// the database, not the code path: `medications_patient_active_name_uniq` and
// `medications_patient_inactive_name_uniq` mean neither writer can create a
// second active row for the same medicine however it is called.

const DISPENSABLE = ["continued", "changed", "new"];

export async function finalizeConsult(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  let patientId = null;
  try {
    await client.query("BEGIN");

    const { rows: visitRows } = await client.query(
      `SELECT v.id, v.patient_id, v.visit_date, v.current_status, v.appointment_id
         FROM giniflow_visits v WHERE v.id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!visitRows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    const visit = visitRows[0];
    patientId = visit.patient_id;

    if (["doctor_done", "pharmacy_pending", "dispensed", "exited"].includes(visit.current_status)) {
      throw Object.assign(new Error("This consultation is already finalized"), { status: 409 });
    }

    // Finalize means "the consultation happened", so the patient has to have
    // been called in. Without this, finalizing someone still at the MO desk
    // would ask the chain to jump three statuses — which it rightly refuses —
    // and would log a consultation for a patient the consultant never saw.
    // `ready_for_doctor` is allowed because a consultant who calls a patient and
    // finishes immediately is a real thing; anything earlier is a mis-tap.
    if (!["with_doctor", "ready_for_doctor"].includes(visit.current_status)) {
      throw Object.assign(
        new Error("Start the consultation before finalizing it — this patient is not with you yet"),
        { status: 409 },
      );
    }

    const { rows: items } = await client.query(
      `SELECT * FROM giniflow_rx_items WHERE visit_id = $1 ORDER BY sort_order, created_at`,
      [visitId],
    );

    // ── 1. The consultation row ──────────────────────────────────────────────
    // One per patient per visit date. What prevents a second row for the same
    // visit is the status guard above — a finalized visit is refused — not this
    // statement, which is a plain INSERT. Said plainly because a comment that
    // overstates a safety property in a clinical write path is worse than none
    // (CS-10).
    const { rows: consultRows } = await client.query(
      `INSERT INTO consultations (patient_id, visit_date, visit_type, con_doctor_id, status)
       VALUES ($1, $2::date, 'OPD', $3, 'completed')
       RETURNING id`,
      [visit.patient_id, visit.visit_date, actorId],
    );
    const consultationId = consultRows[0].id;

    // ── 2. Medicines ─────────────────────────────────────────────────────────
    const stopped = items.filter((i) => i.change_type === "stopped");
    const active = items.filter((i) => DISPENSABLE.includes(i.change_type));
    const paused = items.filter((i) => i.change_type === "paused");

    // Stopped first, so a medicine stopped and re-prescribed under a new dose in
    // the same visit cannot collide on the active unique index.
    if (stopped.length) {
      // CS-02. `medications_patient_inactive_name_uniq` is unique on the same key
      // among INACTIVE rows, and the flip below moves a row into that set. A
      // medicine stopped at an earlier visit, re-prescribed, and stopped again
      // therefore lands a second inactive row and aborts the whole consultation
      // with a unique violation the consultant cannot act on.
      //
      // The older inactive row is superseded history — the row being stopped now
      // carries the current dose, timing and consultation. Dropping it keeps the
      // most recent row per (patient, medicine) in each active state, which is
      // exactly the policy `scripts/dedup-medications.js` applies when it repairs
      // this table.
      await client.query(
        `DELETE FROM medications old
          WHERE old.patient_id = $1
            AND old.is_active = false
            AND UPPER(COALESCE(old.pharmacy_match, old.name)) = ANY($2::text[])
            AND EXISTS (
              SELECT 1 FROM medications cur
               WHERE cur.patient_id = old.patient_id
                 AND cur.is_active = true
                 AND UPPER(COALESCE(cur.pharmacy_match, cur.name))
                     = UPPER(COALESCE(old.pharmacy_match, old.name)))`,
        [visit.patient_id, stopped.map((i) => (i.pharmacy_match || i.medicine_name).toUpperCase())],
      );

      await client.query(
        `UPDATE medications m
            SET is_active = false,
                stopped_date = COALESCE(m.stopped_date, CURRENT_DATE),
                stop_reason = COALESCE(t.stop_reason, m.stop_reason),
                change_type = 'stopped',
                consultation_id = $2,
                updated_at = NOW()
           FROM UNNEST($3::text[], $4::text[]) AS t(key, stop_reason)
          WHERE m.patient_id = $1
            AND m.is_active = true
            AND UPPER(COALESCE(m.pharmacy_match, m.name)) = UPPER(t.key)`,
        [
          visit.patient_id,
          consultationId,
          stopped.map((i) => i.pharmacy_match || i.medicine_name),
          stopped.map((i) => i.stop_reason || "Stopped at consultation"),
        ],
      );
    }

    // A paused medicine is still the patient's medicine — it keeps its row and
    // its history, and only stops appearing on the card until it resumes.
    if (paused.length) {
      await client.query(
        `UPDATE medications m
            SET change_type = 'paused',
                consultation_id = $2,
                updated_at = NOW()
           FROM UNNEST($3::text[]) AS t(key)
          WHERE m.patient_id = $1 AND m.is_active = true
            AND UPPER(COALESCE(m.pharmacy_match, m.name)) = UPPER(t.key)`,
        [visit.patient_id, consultationId, paused.map((i) => i.pharmacy_match || i.medicine_name)],
      );
    }

    if (active.length) {
      await client.query(
        `INSERT INTO medications
           (patient_id, consultation_id, name, pharmacy_match, composition, dose, previous_dose,
            frequency, timing, timing_category, time_of_day, route, form, clinical_note,
            instructions, drug_class, change_type, is_new, is_active, started_date,
            last_prescribed_date)
         SELECT $1, $2, t.name, t.pharm, t.composition, t.dose, t.previous_dose,
                t.frequency, t.timing, t.timing_category, t.time_of_day::time, t.route, t.form,
                t.reason, t.patient_instruction, t.drug_class, t.change_type,
                t.change_type = 'new', true,
                CASE WHEN t.change_type = 'new' THEN $3::date ELSE NULL END, $3::date
           FROM UNNEST($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                       $10::text[], $11::text[], $12::text[], $13::text[], $14::text[],
                       $15::text[], $16::text[], $17::text[], $18::text[])
                AS t(name, pharm, composition, dose, previous_dose, frequency, timing,
                     timing_category, time_of_day, route, form, reason, patient_instruction,
                     drug_class, change_type)
         ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
         DO UPDATE SET consultation_id = EXCLUDED.consultation_id,
           composition = COALESCE(EXCLUDED.composition, medications.composition),
           dose = COALESCE(EXCLUDED.dose, medications.dose),
           previous_dose = COALESCE(EXCLUDED.previous_dose, medications.previous_dose),
           frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
           timing = COALESCE(EXCLUDED.timing, medications.timing),
           timing_category = COALESCE(EXCLUDED.timing_category, medications.timing_category),
           time_of_day = COALESCE(EXCLUDED.time_of_day, medications.time_of_day),
           route = COALESCE(EXCLUDED.route, medications.route),
           form = COALESCE(EXCLUDED.form, medications.form),
           clinical_note = COALESCE(EXCLUDED.clinical_note, medications.clinical_note),
           instructions = COALESCE(EXCLUDED.instructions, medications.instructions),
           drug_class = COALESCE(EXCLUDED.drug_class, medications.drug_class),
           change_type = EXCLUDED.change_type,
           last_prescribed_date = EXCLUDED.last_prescribed_date,
           stopped_date = NULL,
           stop_reason = NULL,
           updated_at = NOW()`,
        [
          visit.patient_id,
          consultationId,
          visit.visit_date,
          active.map((i) => i.medicine_name),
          active.map((i) => i.pharmacy_match),
          active.map((i) => i.composition),
          active.map((i) => i.dose),
          active.map((i) => i.previous_dose),
          active.map((i) => i.frequency),
          active.map((i) => i.timing),
          active.map((i) => i.timing_category),
          active.map((i) => i.time_of_day),
          active.map((i) => i.route),
          active.map((i) => i.form),
          active.map((i) => i.reason),
          active.map((i) => i.patient_instruction),
          active.map((i) => i.drug_class),
          active.map((i) => i.change_type),
        ],
      );
    }

    // ── 3. Undecided MO proposals ────────────────────────────────────────────
    // Leaving them "proposed" for ever would tell the MO their suggestion is
    // still being considered after the patient has gone home.
    const { rows: undecided } = await client.query(
      `UPDATE giniflow_rx_proposals
          SET status = 'rejected',
              reason = COALESCE(reason || ' · ', '') || 'not decided at consultation',
              decided_by = $2, decided_at = NOW()
        WHERE visit_id = $1 AND status = 'proposed'
        RETURNING id`,
      [visitId, actorId],
    );

    // ── 4. Status ────────────────────────────────────────────────────────────
    await advanceStatus(client, {
      visitId,
      toStatus: "doctor_done",
      actorRole: "doctor",
      actorId,
      meta: {
        source: "consult_finalize",
        consultation_id: consultationId,
        medicines: active.length,
        stopped: stopped.length,
      },
    });
    await advanceStatus(client, {
      visitId,
      toStatus: "pharmacy_pending",
      actorRole: "doctor",
      actorId,
      meta: { source: "consult_finalize" },
    });

    // The draft has become the prescription; keeping it would give the next
    // reader two answers to the same question.
    await client.query(`DELETE FROM giniflow_rx_items WHERE visit_id = $1`, [visitId]);

    await client.query("COMMIT");

    // ── After the commit ─────────────────────────────────────────────────────
    // Fire-and-forget. A failure here must never undo a finalized consultation:
    // the medicines are prescribed either way, and every one of these is
    // idempotent and re-runnable.
    markMedicationVisitStatus(patientId).catch(() => {});

    // CS-03. Without this a consultation finalized through Gini Flow produced no
    // prescription PDF at all, while the same consultation finalized through
    // Scribe's wizard did — so the patient left with nothing to show and nothing
    // in their app. Same call, same options, same non-blocking shape as
    // `POST /api/consultations` uses; `savePrescriptionForVisit` is idempotent
    // per (patient, consultation, source), so a retry cannot produce two PDFs.
    //
    // Note on the patient's app: there is no separate Genie push to make here.
    // The outbound sync was removed on 2026-05-01 ("dual-DB routing replaces
    // it") — `syncDocumentsToGenie` is `null` in prescriptionAutoSave.js and
    // `syncVisitToGenie` is `null` in the consultations route. The document
    // reaching `documents` IS how it reaches the patient now.
    buildVisitPayloadFromDb(patientId, { appointmentId: visit.appointment_id })
      .then((payload) => {
        if (!payload) return null;
        return savePrescriptionForVisit(patientId, payload, {
          appointmentId: visit.appointment_id,
          consultationId,
          source: "visit",
        });
      })
      .catch((e) => console.warn("[giniflow finalize] Rx auto-save failed:", e?.message));

    return {
      finalized: true,
      consultationId,
      medicines: active.length,
      stopped: stopped.length,
      paused: paused.length,
      proposalsAutoRejected: undecided.length,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// What Finalize is about to do, for the confirmation panel. Read-only: the
// consultant sees the fan-out named before they trigger it, in the prototype's
// own words.
export async function finalizePreview(visitId, db = pool) {
  const { rows: items } = await db.query(
    `SELECT medicine_name, change_type, pharmacy_match FROM giniflow_rx_items
      WHERE visit_id = $1 ORDER BY sort_order`,
    [visitId],
  );
  const { rows: orders } = await db.query(
    `SELECT o.urgency, count(t.id)::int AS tests
       FROM giniflow_lab_orders o
       LEFT JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 GROUP BY o.urgency`,
    [visitId],
  );
  const { rows: pending } = await db.query(
    `SELECT count(*)::int AS n FROM giniflow_rx_proposals
      WHERE visit_id = $1 AND status = 'proposed'`,
    [visitId],
  );
  const { rows: outOfStock } = await db.query(
    `SELECT i.medicine_name FROM giniflow_rx_items r
       JOIN pharmacy_inventory i
         ON UPPER(i.medicine_name) = UPPER(COALESCE(r.pharmacy_match, r.medicine_name))
      WHERE r.visit_id = $1 AND i.stock_qty = 0`,
    [visitId],
  );

  return {
    medicines: items.filter((i) => DISPENSABLE.includes(i.change_type)).length,
    stopped: items.filter((i) => i.change_type === "stopped").length,
    tests: orders.reduce((n, o) => n + o.tests, 0),
    testsByUrgency: orders,
    undecidedProposals: pending[0].n,
    outOfStock: outOfStock.map((r) => r.medicine_name),
  };
}
