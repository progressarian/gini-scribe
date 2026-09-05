import pool from "../../config/db.js";
import { advanceStatus } from "./statusEngine.js";
import { markMedicationVisitStatus } from "../medication/visitStatus.js";
import { savePrescriptionForVisit, buildVisitPayloadFromDb } from "../prescriptionAutoSave.js";
import { referralsForVisit, generateLetter } from "./referralsStation.js";
import { saveCarePlan } from "./doctorStation.js";
import { orderTests } from "./moStation.js";
import { checkVisit } from "./interactions.js";
import { whenToTakeFor } from "../../../shared/giniflowMedTiming.js";

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

// Proposals the doctor has not decided. One definition, read by the guard below
// and by the preview the button renders — two counts could disagree, and the
// disagreement would always surface as a refused click with no explanation.
export async function pendingProposalCount(visitId, db = pool) {
  // Both models are counted while the old one is retired (plan §4.1): proposals
  // now live as draft rows, but the side table still holds what was written
  // before the change, and a row in either is a decision the doctor has not
  // made. Counting only the new one would let the old rows through silently —
  // which is the exact failure this guard exists to prevent.
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM giniflow_rx_proposals
              WHERE visit_id = $1 AND status = 'proposed')
          + (SELECT count(*) FROM giniflow_rx_items
              WHERE visit_id = $1 AND approval_status = 'pending') AS n`,
    [visitId],
  );
  return Number(rows[0].n);
}

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

    if (
      ["doctor_done", "rx_pending", "with_rx", "pharmacy_pending", "dispensed", "exited"].includes(
        visit.current_status,
      )
    ) {
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

    // The MO's proposals must be decided, not defaulted (addendum v1.1 §3,
    // docs/gini-flow/24-ADDENDUM-V11-PLAN.md §4.3).
    //
    // This used to auto-reject anything still `proposed`, so a consultant could
    // finalize with "TG tripled — add Fenofibrate" unread and the record would
    // say they rejected it. They never saw it. A rejection has to be a decision
    // somebody made.
    const pending = await pendingProposalCount(visitId, client);
    if (pending) {
      throw Object.assign(
        new Error(
          `${pending} proposal${pending === 1 ? "" : "s"} still to review — approve, adjust or reject each one first`,
        ),
        { status: 409, pendingProposals: pending },
      );
    }

    // A severe interaction stops the finalize until somebody has said why they
    // are prescribing it anyway (§5.2). Not a hard block, deliberately: dual
    // antiplatelet after a stent and an MRA with an ACE inhibitor in heart
    // failure are the combinations this check is best at spotting, and both are
    // things a cardiologist means. A stop that cannot be passed gets worked
    // around, and then it protects nobody — so the way past it is a recorded
    // reason, which is the sentence the whole check exists to produce.
    const interactions = await checkVisit(visitId, client);
    if (interactions.blocking.length) {
      const first = interactions.blocking[0];
      throw Object.assign(
        new Error(
          `${first.medicines.join(" + ")} — ${first.note} Say why this is intended, or change the prescription.`,
        ),
        { status: 409, blockingInteractions: interactions.blocking },
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
            frequency, timing, timing_category, when_to_take, time_of_day, route, form,
            clinical_note, instructions, drug_class, change_type, is_new, is_active,
            started_date, last_prescribed_date)
         SELECT $1, $2, t.name, t.pharm, t.composition, t.dose, t.previous_dose,
                t.frequency, t.timing, t.timing_category,
                NULLIF(string_to_array(t.when_to_take, '|'), '{}')::when_to_take_pill[],
                t.time_of_day::time, t.route, t.form,
                t.reason, t.patient_instruction, t.drug_class, t.change_type,
                t.change_type = 'new', true,
                CASE WHEN t.change_type = 'new' THEN $3::date ELSE NULL END, $3::date
           FROM UNNEST($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                       $10::text[], $11::text[], $12::text[], $13::text[], $14::text[],
                       $15::text[], $16::text[], $17::text[], $18::text[], $19::text[])
                AS t(name, pharm, composition, dose, previous_dose, frequency, timing,
                     timing_category, time_of_day, route, form, reason, patient_instruction,
                     drug_class, change_type, when_to_take)
         ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
         DO UPDATE SET consultation_id = EXCLUDED.consultation_id,
           composition = COALESCE(EXCLUDED.composition, medications.composition),
           dose = COALESCE(EXCLUDED.dose, medications.dose),
           previous_dose = COALESCE(EXCLUDED.previous_dose, medications.previous_dose),
           frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
           timing = COALESCE(EXCLUDED.timing, medications.timing),
           timing_category = COALESCE(EXCLUDED.timing_category, medications.timing_category),
           when_to_take = COALESCE(EXCLUDED.when_to_take, medications.when_to_take),
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
          active.map((i) => whenToTakeFor(i.timing_categories).join("|") || null),
        ],
      );
    }

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
      toStatus: "rx_pending",
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

    // The referral letters (19 §6). Here, beside the prescription PDF, and never
    // inside the transaction: a Puppeteer render is exactly the "can fail
    // slowly" this block exists for. Each generation is idempotent — it skips a
    // referral that already has a letter_file_url — so a retry is always safe,
    // and a letter that failed to render can be regenerated from the station
    // with one button.
    //
    // A referral is NOT a reason to block Finalize. A consultation that refused
    // to finalize because a PDF timed out would strand the patient before
    // pharmacy.
    referralsForVisit(visitId)
      .then((referrals) =>
        Promise.all(
          referrals
            .filter((r) => !r.letterUrl)
            .map((r) =>
              generateLetter(r.id).catch((e) =>
                console.warn("[giniflow finalize] referral letter failed:", r.id, e?.message),
              ),
            ),
        ),
      )
      .catch((e) => console.warn("[giniflow finalize] referral letters failed:", e?.message));

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
// The fast path — addendum v1.1 §2, docs/gini-flow/24-ADDENDUM-V11-PLAN.md §3.
//
// One tap for a green patient: keep the pre-seeded prescription, repeat today's
// panel at the next visit, set the follow-up three months out, finalize. Roughly
// 28% of visits are `in_control`, and for those the consultation is a
// confirmation rather than a decision.
//
// Three transactions, not one, and the ORDER is the design (§3.2). `orderTests`
// and `finalizeConsult` each own theirs, and giving them client-taking variants
// would touch both stations for a path that is a convenience. So the sequence is
// arranged by what a failure leaves behind:
//
//   care plan  — harmless on its own if the rest fails
//   tests      — a patient with tests ordered and still in the room; a phone call
//   finalize   — last, because a finished visit with no follow-up is not
//                recoverable by hand
//
// Everything below reuses the normal services. `finalizeConsult` is not forked:
// a second finalize would be a second answer to "what does finishing a visit
// mean".
export async function fastPathFinalize(visitId, actorId = null, db = pool) {
  const { rows } = await db.query(
    `SELECT v.category, v.current_status,
            (SELECT count(*)::int FROM giniflow_rx_items i
              WHERE i.visit_id = v.id AND i.change_type <> 'stopped') AS medicines,
            (SELECT next_visit_date FROM giniflow_care_plans c WHERE c.visit_id = v.id)
              AS next_visit_date
       FROM giniflow_visits v WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  const visit = rows[0];

  if (visit.category !== "in_control") {
    throw Object.assign(
      new Error(
        `The fast path is for green-category patients — this one is ${visit.category || "uncategorised"}`,
      ),
      { status: 409 },
    );
  }
  if (!visit.medicines) {
    throw Object.assign(new Error("Nothing to continue — the prescription is empty"), {
      status: 409,
    });
  }
  const pending = await pendingProposalCount(visitId, db);
  if (pending) {
    throw Object.assign(
      new Error(`${pending} proposal${pending === 1 ? "" : "s"} still to review`),
      { status: 409 },
    );
  }
  // The fast path finalizes without anybody reading the prescription screen, so
  // it is the one route where an unread severe interaction would go out
  // unnoticed. Same rule, and no override here — a combination that needs a
  // reason needs the consultant to open the patient and give one.
  const interactions = await checkVisit(visitId, db);
  if (interactions.blocking.length) {
    const first = interactions.blocking[0];
    throw Object.assign(
      new Error(`${first.medicines.join(" + ")} — ${first.note} Open the patient to record why.`),
      { status: 409, blockingInteractions: interactions.blocking },
    );
  }

  // 1. The follow-up, three months out. Never overwritten: a doctor who already
  //    set a date meant it.
  let nextVisitDate = visit.next_visit_date;
  if (!nextVisitDate) {
    const { rows: d } = await db.query(
      `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + INTERVAL '3 months')::date::text AS d`,
    );
    nextVisitDate = d[0].d;
    await saveCarePlan(visitId, { nextVisitDate, nextVisitInterval: "~3 months" }, actorId, db);
  }

  // 2. Repeat what was measured today. Read from the visit's own orders — a
  //    panel nobody chose is a bill the patient did not agree to, so when there
  //    is nothing to repeat this orders nothing and says so.
  const { rows: repeatable } = await db.query(
    `SELECT DISTINCT t.test_name FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1`,
    [visitId],
  );
  const tests = repeatable.map((r) => r.test_name);
  if (tests.length) {
    await orderTests(visitId, { urgency: "next_visit", tests, actorId }, db);
  }

  // 3. The ordinary fan-out — always on the pool, never on a caller's client.
  //
  // `finalizeConsult` opens its own transaction (`db.connect()`), so forwarding
  // a client here would throw on the last and least reversible step. `db` above
  // is for the reads and the two composable writes; this one owns its own.
  const result = await finalizeConsult(visitId, actorId);
  return { ...result, fastPath: true, nextVisitDate, testsRepeated: tests };
}

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
  // Named, not counted: "Ophthalmology referral" is actionable, "1 referral" is
  // not — and the prototype's Finalize panel says the specialty out loud.
  const referrals = await referralsForVisit(visitId, db);

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
    undecidedProposals: await pendingProposalCount(visitId, db),
    interactions: await checkVisit(visitId, db),
    outOfStock: outOfStock.map((r) => r.medicine_name),
    referrals: referrals.map((r) => ({
      id: r.id,
      icon: r.icon,
      specialty: r.specialty,
      label: `${r.icon} ${r.specialtyLabel} referral`,
      hasLetter: !!r.letterUrl,
    })),
  };
}
