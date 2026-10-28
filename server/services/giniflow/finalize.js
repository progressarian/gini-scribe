import pool from "../../config/db.js";
import { advanceStatus } from "./statusEngine.js";
import { markMedicationVisitStatus } from "../medication/visitStatus.js";
import { savePrescriptionForVisit, buildVisitPayloadFromDb } from "../prescriptionAutoSave.js";
import { referralsForVisit, generateLetter } from "./referralsStation.js";
import { saveCarePlan } from "./doctorStation.js";
import { orderTests } from "./moStation.js";
import { checkVisit } from "./interactions.js";
import { whenToTakeFor } from "../../../shared/giniflowMedTiming.js";

const DISPENSABLE = ["continued", "changed", "new"];
export async function pendingProposalCount(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM giniflow_rx_proposals
              WHERE visit_id = $1 AND status = 'proposed')
          + (SELECT count(*) FROM giniflow_rx_items
              WHERE visit_id = $1 AND approval_status = 'pending')
          + (SELECT count(*) FROM giniflow_plan_suggestions
              WHERE visit_id = $1 AND status = 'proposed') AS n`,
    [visitId],
  );
  return Number(rows[0].n);
}

export async function writeMedicines(client, { patientId, consultationId, visitDate, items }) {
  // ── 2. Medicines ─────────────────────────────────────────────────────────
  const stopped = items.filter((i) => i.change_type === "stopped");
  const active = items.filter((i) => DISPENSABLE.includes(i.change_type));
  const paused = items.filter((i) => i.change_type === "paused");
  if (stopped.length) {
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
      [patientId, stopped.map((i) => (i.pharmacy_match || i.medicine_name).toUpperCase())],
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
        patientId,
        consultationId,
        stopped.map((i) => i.pharmacy_match || i.medicine_name),
        stopped.map((i) => i.stop_reason || "Stopped at consultation"),
      ],
    );
  }
  if (paused.length) {
    await client.query(
      `UPDATE medications m
          SET change_type = 'paused',
              consultation_id = $2,
              updated_at = NOW()
         FROM UNNEST($3::text[]) AS t(key)
        WHERE m.patient_id = $1 AND m.is_active = true
          AND UPPER(COALESCE(m.pharmacy_match, m.name)) = UPPER(t.key)`,
      [patientId, consultationId, paused.map((i) => i.pharmacy_match || i.medicine_name)],
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
        patientId,
        consultationId,
        visitDate,
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
  return { active, stopped, paused };
}

export async function finalizeConsult(
  visitId,
  actorId = null,
  db = pool,
  { closedBySd = false, requireNextVisit = false, consultantId = null } = {},
) {
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

    const allowed = closedBySd ? ["with_sd"] : ["with_doctor", "ready_for_doctor"];
    if (!allowed.includes(visit.current_status)) {
      throw Object.assign(
        new Error(
          closedBySd
            ? "Claim this patient at your desk before closing them"
            : "Start the consultation before finalizing it — this patient is not with you yet",
        ),
        { status: 409 },
      );
    }

    const pending = await pendingProposalCount(visitId, client);
    if (pending) {
      throw Object.assign(
        new Error(
          `${pending} Chief Endocrinologist proposal${pending === 1 ? "" : "s"} still to review — decide each one first`,
        ),
        { status: 409, pendingProposals: pending },
      );
    }
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

    if (requireNextVisit) {
      const { rows: plan } = await client.query(
        `SELECT next_visit_date FROM giniflow_care_plans WHERE visit_id = $1`,
        [visitId],
      );
      if (!plan[0]?.next_visit_date) {
        throw Object.assign(new Error("Set the next visit in the Care plan before finalizing"), {
          status: 409,
          nextVisitMissing: true,
        });
      }
    }

    const { rows: items } = await client.query(
      `SELECT * FROM giniflow_rx_items WHERE visit_id = $1 ORDER BY sort_order, created_at`,
      [visitId],
    );

    const { rows: consultRows } = await client.query(
      `INSERT INTO consultations (patient_id, visit_date, visit_type, con_doctor_id, mo_doctor_id, status)
       VALUES ($1, $2::date, 'OPD', $3, $4, 'completed')
       RETURNING id`,
      [
        visit.patient_id,
        visit.visit_date,
        consultantId ?? actorId,
        consultantId && consultantId !== actorId ? actorId : null,
      ],
    );
    const consultationId = consultRows[0].id;

    const { active, stopped, paused } = await writeMedicines(client, {
      patientId: visit.patient_id,
      consultationId,
      visitDate: visit.visit_date,
      items,
    });

    // ── 4. Status ────────────────────────────────────────────────────────────
    const actorRole = closedBySd ? "mo_sd" : "doctor";
    await advanceStatus(client, {
      visitId,
      toStatus: "doctor_done",
      actorRole,
      actorId,
      allowSkip: closedBySd,
      meta: {
        source: "consult_finalize",
        consultation_id: consultationId,
        medicines: active.length,
        stopped: stopped.length,
        ...(closedBySd ? { closed_by_sd: true } : {}),
      },
    });
    await advanceStatus(client, {
      visitId,
      toStatus: "rx_pending",
      actorRole,
      actorId,
      meta: { source: "consult_finalize", ...(closedBySd ? { closed_by_sd: true } : {}) },
    });

    await client.query(`DELETE FROM giniflow_rx_items WHERE visit_id = $1`, [visitId]);

    await client.query("COMMIT");

    markMedicationVisitStatus(patientId).catch(() => {});

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

export async function fastPathFinalize(visitId, actorId = null, db = pool, { consultantId } = {}) {
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
  const interactions = await checkVisit(visitId, db);
  if (interactions.blocking.length) {
    const first = interactions.blocking[0];
    throw Object.assign(
      new Error(`${first.medicines.join(" + ")} — ${first.note} Open the patient to record why.`),
      { status: 409, blockingInteractions: interactions.blocking },
    );
  }

  let nextVisitDate = visit.next_visit_date;
  if (!nextVisitDate) {
    const { rows: d } = await db.query(
      `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + INTERVAL '3 months')::date::text AS d`,
    );
    nextVisitDate = d[0].d;
    await saveCarePlan(visitId, { nextVisitDate, nextVisitInterval: "~3 months" }, actorId, db);
  }

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

  const result = await finalizeConsult(visitId, actorId, undefined, { consultantId });
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
  const referrals = await referralsForVisit(visitId, db);

  const { rows: outOfStock } = await db.query(
    `SELECT i.medicine_name FROM giniflow_rx_items r
       JOIN pharmacy_inventory i
         ON UPPER(i.medicine_name) = UPPER(COALESCE(r.pharmacy_match, r.medicine_name))
      WHERE r.visit_id = $1 AND i.stock_qty = 0`,
    [visitId],
  );

  const { rows: plan } = await db.query(
    `SELECT next_visit_date::text AS next_visit_date FROM giniflow_care_plans WHERE visit_id = $1`,
    [visitId],
  );

  return {
    nextVisitDate: plan[0]?.next_visit_date || null,
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
