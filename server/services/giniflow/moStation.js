import pool from "../../config/db.js";
import { chiefDeskOwner } from "../assistedDoctor.js";
import { linesForOrder } from "../billing/visitLines.js";
import { outsourcedTestNames } from "../billing/testMatch.js";
import { OPEN_LAB_CASES_SQL } from "./labStation.js";
import { LAB_SAMPLE_FLOW, UNDRAWN_SAMPLE_STATUSES } from "../../../shared/labStages.js";
import { finalizeConsult } from "./finalize.js";
import { applyChiefNextVisit } from "./planSuggestions.js";
import { seedDraftOn } from "./prescription.js";
import { advanceStatus, budgetColour, reopenResultsForNewOrder } from "./statusEngine.js";
import { getSlaConfig, budgetLookup } from "./board.js";
import {
  catalogBasePriceSql,
  testPricesFor,
  testCategoriesFor,
  schemeForVisit,
  withHomeDiscount,
} from "../pricing.js";
import {
  BACK_FOR_TESTS,
  isTerminalStatus,
  slaKeyForStatus,
  WAIT_SINCE_SQL,
} from "../../../shared/giniflowStatus.js";
import { reopenForTests } from "./lateTests.js";
import { todaysVitals, previousVitals } from "./visitVitals.js";
import { insertLabStepsForOrder, insertMachineStepsForOrders } from "./journey.js";
import { directConsultSql } from "../../../shared/directConsult.js";
import { getMachines } from "./machineCatalog.js";
import { machineForTest } from "../../../shared/machineStages.js";
import { ALLERGY_NOT_ASKED } from "../../../shared/giniflowAllergy.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import { TESTS_HOLD_SQL, chiefWaitClock } from "./testsHold.js";

export const CLOSEABLE_CATEGORY = "in_control";

const closeableNow = ({ hasPlan, orders, outcome }) =>
  !!hasPlan && (orders === 0 || outcome === "normal");

const GATING_ORDER_SQL = `o.urgency = 'today'`;

const gatingOrders = (orders = []) => orders.filter((o) => o.urgency === "today").length;

// Lab-track statuses that mean the sample has not been taken yet.
const UNCOLLECTED = UNDRAWN_SAMPLE_STATUSES;

const LAB_STAGE_ORDER_SQL = LAB_SAMPLE_FLOW.filter((v) => v !== "uploaded")
  .map((v) => `'${v}'`)
  .join(",");

const QUEUE_STATUSES = [
  "checked_in",
  "vitals_pending",
  "with_vitals",
  "vitals_done",
  "sd_pending",
  "with_sd",
  "ready_for_doctor",
  "doctor_done",
  "rx_pending",
  "with_rx",
];

const LEFT_THE_DOCTOR = ["pharmacy_pending", "dispensed", "exited"];

const bioChips = (biomarkers) => {
  if (!biomarkers || typeof biomarkers !== "object") return [];
  const chips = [];
  if (biomarkers.hba1c != null) {
    const v = Number(biomarkers.hba1c);
    chips.push({ label: `HbA1c ${v}`, tone: v > 9 ? "r" : v > 7 ? "a" : "g" });
  }
  if (biomarkers.bpSys != null && biomarkers.bpDia != null) {
    const sys = Number(biomarkers.bpSys);
    const dia = Number(biomarkers.bpDia);
    chips.push({
      label: `BP ${sys}/${dia}`,
      tone: sys >= 140 || dia >= 90 ? "r" : sys >= 130 || dia >= 85 ? "a" : "g",
    });
  }
  if (biomarkers.fg != null) {
    const v = Number(biomarkers.fg);
    chips.push({ label: `FBS ${v}`, tone: v > 130 ? "a" : "g" });
  }
  return chips;
};

// The line v2 and v3 put on every row: whether there is anything to work from.
const reportsLine = (resultsStatus, hasBiomarkers) => {
  if (resultsStatus === "ready") return { label: "✓ Reports complete", tone: "g" };
  if (resultsStatus === "partial") return { label: "Partial results", tone: "a" };
  if (hasBiomarkers) return { label: "✓ Previous reports on file", tone: "g" };
  return { label: "🔵 No reports", tone: "n" };
};

const QUEUE_SQL = `
  SELECT v.id, v.current_status, v.results_status, v.category, v.stability, v.stability_reasons, v.assigned_sd_id,
         (to_jsonb(v)->>'rx_mo_id')::int AS rx_mo_id,
         v.appointment_time::text AS appointment_time, v.blocked_reason, v.paused_at,
         p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
         sd.short_name AS sd_name,
         seq.visit_number,
         a.biomarkers,
         a.pre_visit_compliance,
         first_ev.occurred_at AS checked_in_at,
         last_ev.occurred_at  AS status_since,
         hold.tests_pending,
         hold.tests_ready_at,
         (SELECT count(*)::int FROM giniflow_lab_orders o
           WHERE o.visit_id = v.id AND o.sample_status NOT IN ('uploaded', 'sent_outside')
             AND ${GATING_ORDER_SQL}) AS open_orders,
         -- How far the slowest outstanding order has got. "Waiting on results"
         -- is not one state: a sample nobody has drawn is the MO's to chase,
         -- one on the analyser is not.
         (SELECT o.sample_status FROM giniflow_lab_orders o
           WHERE o.visit_id = v.id AND o.sample_status NOT IN ('uploaded', 'sent_outside')
             AND ${GATING_ORDER_SQL}
           ORDER BY array_position(
             ARRAY[${LAB_STAGE_ORDER_SQL}],
             o.sample_status) LIMIT 1) AS lab_stage,
         ${OPEN_LAB_CASES_SQL} AS open_cases,
         (SELECT plan IS NOT NULL AND length(trim(plan)) > 0
            FROM giniflow_sd_notes n WHERE n.visit_id = v.id) AS has_plan,
         (SELECT reports_outcome FROM giniflow_sd_notes n WHERE n.visit_id = v.id)
           AS reports_outcome,
         -- Search runs here, not in the browser, for two reasons: the queue the
         -- MO can see is only part of the day, and a phone number is never sent
         -- to the client at all, so it is unsearchable anywhere else. Digits are
         -- compared to digits so "98765 43210" finds "+91-9876543210".
         ($3::text IS NULL
          OR p.name ILIKE '%' || $3 || '%'
          OR p.file_no ILIKE '%' || $3 || '%'
          OR ($4::text <> '' AND (
               regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g') LIKE '%' || $4 || '%'
               OR EXISTS (
                    SELECT 1 FROM unnest(COALESCE(p.alt_phone, '{}'::text[])) ap
                     WHERE regexp_replace(ap, '\\D', '', 'g') LIKE '%' || $4 || '%')))
         ) AS matches
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors sd ON sd.id = v.assigned_sd_id
    LEFT JOIN appointments a ON a.id = v.appointment_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int + 1 AS visit_number FROM appointments pa
       WHERE pa.patient_id = v.patient_id AND pa.appointment_date < v.visit_date
         AND pa.status = 'completed'
    ) seq ON TRUE
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND e.status = 'checked_in' ORDER BY occurred_at LIMIT 1
    ) first_ev ON TRUE
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND ${WAIT_SINCE_SQL("e", "v")}
       ORDER BY occurred_at DESC, id DESC LIMIT 1
    ) last_ev ON TRUE
    LEFT JOIN LATERAL (${TESTS_HOLD_SQL("v", "p")}) hold ON TRUE
   WHERE v.visit_date = $1::date
     AND v.current_status = ANY($2)
     AND NOT COALESCE(p.is_blocked, FALSE)
     -- Samples-only patients belong to the lab track, not the MO's queue. See
     -- the same clause in doctorStation.js.
     AND NOT ${labOnlyPredicate("v", "$5")}
   ORDER BY v.appointment_time NULLS LAST, first_ev.occurred_at NULLS LAST`;

const waitMinutes = (row, now) => {
  const { since } = chiefWaitClock(row);
  const until = row.paused_at ? new Date(row.paused_at) : now;
  return since
    ? Math.max(0, Math.round((until.getTime() - new Date(since).getTime()) / 60000))
    : null;
};

const waitBudgetFor = (row, budgetFor) =>
  chiefWaitClock(row).heldForTests
    ? null
    : budgetFor(slaKeyForStatus(row.current_status), row.category);

const groupOf = (row, sdId) => {
  const mine = !row.assigned_sd_id || row.assigned_sd_id === sdId;
  if (row.current_status === "with_sd") return mine ? "withMe" : "withOtherSd";
  if (
    ["ready_for_doctor", "doctor_done", "rx_pending", "with_rx", ...LEFT_THE_DOCTOR].includes(
      row.current_status,
    )
  ) {
    return mine ? "done" : "withOtherSd";
  }
  if (["vitals_done", "sd_pending"].includes(row.current_status)) {
    if (!mine) return "withOtherSd";
    const openLab = row.open_orders + row.open_cases;
    if (row.results_status !== "ready" && openLab > 0) return "awaitingResults";
    if (row.results_status !== "ready" && !row.biomarkers) return "missingReports";
    return "waitingForMe";
  }
  return "inPipeline";
};

export async function getMoQueue(
  visitDate,
  sdId = null,
  q = null,
  now = new Date(),
  db = pool,
  { rxMoId = null } = {},
) {
  // A typed % or _ is a character the MO meant, not a wildcard.
  const raw = typeof q === "string" && q.trim() ? q.trim() : null;
  const term = raw ? raw.replace(/[%_\\]/g, "\\$&") : null;
  const digits = raw ? raw.replace(/\D/g, "") : "";
  const [{ rows }, sla] = await Promise.all([
    db.query(QUEUE_SQL, [
      visitDate,
      rxMoId ? [...QUEUE_STATUSES, ...LEFT_THE_DOCTOR] : QUEUE_STATUSES,
      term,
      digits,
      LAB_ONLY_DOCTOR,
    ]),
    getSlaConfig(db),
  ]);
  const budgetFor = budgetLookup(sla);

  const groups = {
    withMe: [],
    waitingForMe: [],
    awaitingResults: [],
    missingReports: [],
    inPipeline: [],
    done: [],
    withOtherSd: [],
  };

  const counters = {};
  const shown = rxMoId ? rows.filter((r) => r.rx_mo_id === rxMoId) : rows;
  for (const r of shown) {
    const compliancePct = r.pre_visit_compliance?.pct ?? null;
    const { since: waitSince } = chiefWaitClock(r);
    const card = {
      visitId: r.id,
      patientId: r.patient_id,
      name: r.name,
      fileNo: r.file_no,
      age: r.age,
      sex: r.sex,
      visitNumber: r.visit_number,
      category: r.category,
      stability: r.stability ? { state: r.stability, reasons: r.stability_reasons || [] } : null,
      status: r.current_status,
      resultsStatus: r.results_status,
      sdName: r.sd_name,
      assignedSdId: r.assigned_sd_id,
      appointmentTime: (r.appointment_time || "").slice(0, 5) || null,
      slot: null,
      checkedInAt: r.checked_in_at ? new Date(r.checked_in_at).toISOString() : null,
      statusSince: waitSince ? new Date(waitSince).toISOString() : null,
      pausedAt: r.paused_at ? new Date(r.paused_at).toISOString() : null,
      waitMinutes: waitMinutes(r, now),
      waitBudget: waitBudgetFor(r, budgetFor),
      waitColour: budgetColour(waitMinutes(r, now) ?? 0, waitBudgetFor(r, budgetFor)),
      bios: bioChips(r.biomarkers),
      reports: reportsLine(r.results_status, !!r.biomarkers),
      compliancePct,
      openOrders: r.open_orders + r.open_cases,
      labStage: r.lab_stage || null,
      hasPlan: !!r.has_plan,
      canClose: closeableNow({
        hasPlan: r.has_plan,
        orders: r.open_orders + r.open_cases,
        outcome: r.reports_outcome,
      }),
      reportsOutcome: r.reports_outcome || null,
    };
    const group = groupOf(r, sdId);
    counters[group] = (counters[group] || 0) + 1;
    if (r.matches) groups[group].push(card);
  }

  // "Now" is the patient at the desk; "Next" is the head of the waiting queue.
  groups.withMe.forEach((c) => (c.slot = "Now"));
  if (groups.waitingForMe[0]) groups.waitingForMe[0].slot = "Next";
  for (const g of Object.values(groups))
    for (const c of g) c.slot = c.slot || c.appointmentTime || "—";

  const matched = Object.values(groups).reduce((n, g) => n + g.length, 0);

  return {
    ...groups,
    query: raw,
    matched,
    total: shown.length,
    counters: {
      withMe: counters.withMe || 0,
      waitingForMe: counters.waitingForMe || 0,
      awaitingResults: counters.awaitingResults || 0,
      missingReports: counters.missingReports || 0,
      closedByMe: counters.done || 0,
    },
  };
}

// The brief an MO reads before writing a plan.
export async function getMoPatient(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT v.id, v.current_status, v.results_status, v.category, v.stability, v.stability_reasons, v.patient_id,
            v.appointment_id,
            v.visit_date::text AS visit_date,
            v.assigned_sd_id, v.blocked_reason,
            p.name, p.file_no, p.age, p.sex, p.notes,
            p.allergy_status, p.allergy_note,
            a.biomarkers, a.compliance, a.pre_visit_compliance,
            a.opd_diagnoses, a.opd_medications,
            seq.visit_number,
            first_ev.occurred_at AS checked_in_at
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN appointments a ON a.id = v.appointment_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int + 1 AS visit_number FROM appointments pa
          WHERE pa.patient_id = v.patient_id AND pa.appointment_date < v.visit_date
            AND pa.status = 'completed'
       ) seq ON TRUE
       LEFT JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events e
          WHERE e.visit_id = v.id AND e.status = 'checked_in' ORDER BY occurred_at LIMIT 1
       ) first_ev ON TRUE
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) return null;
  const v = rows[0];

  const [
    vitals,
    lastVitals,
    { rows: history },
    { rows: notes },
    { rows: proposals },
    { rows: orders },
    { rows: reports },
  ] = await Promise.all([
    todaysVitals(visitId, { patientId: v.patient_id, visitDate: v.visit_date }, db),
    previousVitals(v.patient_id, v.visit_date, db),
    db.query(
      `SELECT appointment_date, biomarkers FROM appointments
          WHERE patient_id = $1 AND biomarkers IS NOT NULL
            AND appointment_date < COALESCE(
                  (SELECT visit_date FROM giniflow_visits WHERE id = $2),
                  (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
          ORDER BY appointment_date DESC NULLS LAST LIMIT 6`,
      [v.patient_id, visitId],
    ),
    db.query(
      `SELECT plan, source, updated_at, reports_outcome, reports_reviewed_at, reports_review_note
         FROM giniflow_sd_notes WHERE visit_id = $1`,
      [visitId],
    ),
    db.query(
      `SELECT id, medicine_name, from_dose, to_dose, reason, change_type, status
           FROM giniflow_rx_proposals WHERE visit_id = $1 ORDER BY created_at`,
      [visitId],
    ),
    db.query(
      `SELECT o.id, o.urgency, o.payment_status, o.sample_status,
                COALESCE(json_agg(t.test_name ORDER BY t.test_name)
                         FILTER (WHERE t.test_name IS NOT NULL), '[]'::json) AS tests,
                -- Values the lab typed in rather than scanned. They are in
                -- lab_results like any other, so the chart and the trends have
                -- them already — this puts the numbers on the card where the MO
                -- is looking at the order they belong to. A scalar subquery, not
                -- a lateral: json has no equality operator, so it cannot be
                -- carried through the GROUP BY the tests need.
                COALESCE((
                  SELECT json_agg(json_build_object(
                           'testName', lr.test_name, 'value', lr.result,
                           'valueText', lr.result_text, 'unit', lr.unit,
                           'refRange', lr.ref_range, 'flag', lr.flag)
                         ORDER BY lr.flag NULLS LAST, lr.test_name)
                    FROM lab_results lr WHERE lr.lab_order_id = o.id
                ), '[]'::json) AS values
           FROM giniflow_lab_orders o
           LEFT JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
          WHERE o.visit_id = $1
          GROUP BY o.id ORDER BY o.created_at`,
      [visitId],
    ),
    db.query(
      `SELECT id, doc_type, title, doc_date, created_at, file_name, mime_type
         FROM documents WHERE patient_id = $1
        ORDER BY COALESCE(doc_date, created_at::date) DESC, created_at DESC LIMIT 30`,
      [v.patient_id],
    ),
  ]);

  return {
    visitId: v.id,
    patientId: v.patient_id,
    appointmentId: v.appointment_id,
    visitDate: v.visit_date,
    name: v.name,
    fileNo: v.file_no,
    age: v.age,
    sex: v.sex,
    visitNumber: v.visit_number,
    category: v.category,
    stability: v.stability ? { state: v.stability, reasons: v.stability_reasons || [] } : null,
    status: v.current_status,
    resultsStatus: v.results_status,
    assignedSdId: v.assigned_sd_id,
    checkedInAt: v.checked_in_at ? new Date(v.checked_in_at).toISOString() : null,
    canClose: closeableNow({
      hasPlan: !!notes[0]?.plan?.trim(),
      // Not orders.length: the list below shows tomorrow's and next visit's
      // orders too, and those gate nothing today.
      orders: gatingOrders(orders),
      outcome: notes[0]?.reports_outcome,
    }),
    reportsOutcome: notes[0]?.reports_outcome || null,
    reportsReviewNote: notes[0]?.reports_review_note || null,
    reportsReviewedAt: notes[0]?.reports_reviewed_at
      ? new Date(notes[0].reports_reviewed_at).toISOString()
      : null,
    allergyStatus: v.allergy_status || ALLERGY_NOT_ASKED,
    allergyNote: v.allergy_note,
    // No phase column exists either (plan §3b.1). Omitted rather than guessed.
    vitals,
    lastVitals,
    biomarkers: v.biomarkers || null,
    // Oldest first, so a sparkline reads left to right.
    biomarkerHistory: history
      .map((h) => ({ date: h.appointment_date, biomarkers: h.biomarkers }))
      .reverse(),
    previousBiomarkers: history[0]?.biomarkers || null,
    nextVisitDate: v.biomarkers?.followup || null,
    compliance: v.compliance || null,
    compliancePct: v.pre_visit_compliance?.pct ?? null,
    diagnoses: v.opd_diagnoses || null,
    medications: v.opd_medications || null,
    reports,
    plan: notes[0]?.plan ?? "",
    planUpdatedAt: notes[0]?.updated_at ?? null,
    proposals,
    orders: orders.map((o) => ({ ...o, tests: o.tests || [], values: o.values || [] })),
  };
}

async function assertOwner(db, visitId, actorId) {
  const { rows } = await db.query(
    `SELECT v.assigned_sd_id, d.short_name
       FROM giniflow_visits v
       LEFT JOIN doctors d ON d.id = v.assigned_sd_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  const owner = rows[0].assigned_sd_id;
  if (owner && owner !== (await chiefDeskOwner(actorId, db))) {
    throw Object.assign(
      new Error(
        `${rows[0].short_name || "Another MO"} is working this patient — take over first if they have handed them to you`,
      ),
      { status: 409, assignedTo: owner },
    );
  }
  return owner;
}

export async function takeOver(visitId, actorId = null, db = pool) {
  if (!actorId)
    throw Object.assign(new Error("Sign in as an MO to take a patient over"), { status: 403 });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT current_status, assigned_sd_id FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    const deskOwner = await chiefDeskOwner(actorId, client);
    if (rows[0].assigned_sd_id === deskOwner) {
      await client.query("COMMIT");
      return { takenOver: false, assignedTo: deskOwner };
    }
    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
       VALUES ($1, $2, 'mo_sd', $3, $4)`,
      [visitId, rows[0].current_status, actorId, { taken_over_from: rows[0].assigned_sd_id }],
    );
    await client.query(
      `UPDATE giniflow_visits SET assigned_sd_id = $2, updated_at = NOW() WHERE id = $1`,
      [visitId, deskOwner],
    );
    await client.query("COMMIT");
    return { takenOver: true, assignedTo: deskOwner, from: rows[0].assigned_sd_id };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function startWorkup(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT v.current_status, v.assigned_sd_id,
              (SELECT COALESCE(d.short_name, d.name) FROM doctors d
                WHERE d.id = v.assigned_sd_id) AS assigned_sd_name
         FROM giniflow_visits v WHERE v.id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    const deskOwner = actorId ? await chiefDeskOwner(actorId, client) : null;

    if (
      actorId &&
      rows[0].current_status === "with_sd" &&
      rows[0].assigned_sd_id &&
      rows[0].assigned_sd_id !== deskOwner
    ) {
      throw Object.assign(
        new Error(
          `This patient is already with ${rows[0].assigned_sd_name || "another MO"} — they cannot be in two places at once`,
        ),
        { status: 409 },
      );
    }

    const CLAIMABLE = ["vitals_done", "sd_pending"];
    if (CLAIMABLE.includes(rows[0].current_status)) {
      await advanceStatus(client, {
        visitId,
        toStatus: "with_sd",
        actorRole: "mo_sd",
        actorId,
      });
    } else if (rows[0].current_status !== "with_sd") {
      throw Object.assign(
        new Error(
          `This patient is at ${rows[0].current_status.replace(/_/g, " ")} — they reach you once vitals are done`,
        ),
        { status: 409 },
      );
    }
    if (!rows[0].assigned_sd_id && deskOwner) {
      await client.query(`UPDATE giniflow_visits SET assigned_sd_id = $2 WHERE id = $1`, [
        visitId,
        deskOwner,
      ]);
    }
    const seeded = await seedDraftOn(client, visitId);
    await client.query("COMMIT");
    return {
      started: true,
      assignedTo: rows[0].assigned_sd_id || deskOwner,
      seeded: seeded.seeded,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function savePlan(visitId, { plan, source = "typed", actorId = null }, db = pool) {
  await assertOwner(db, visitId, actorId);
  const { rows } = await db.query(
    `INSERT INTO giniflow_sd_notes (visit_id, plan, source, authored_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (visit_id) DO UPDATE
       SET plan = EXCLUDED.plan, source = EXCLUDED.source,
           authored_by = COALESCE(EXCLUDED.authored_by, giniflow_sd_notes.authored_by),
           updated_at = NOW()
     RETURNING updated_at`,
    [visitId, plan ?? "", source, actorId],
  );
  return { savedAt: rows[0].updated_at };
}

export async function addProposal(visitId, proposal, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO giniflow_rx_proposals
       (visit_id, medicine_name, from_dose, to_dose, reason, change_type, proposed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, medicine_name, from_dose, to_dose, reason, change_type, status`,
    [
      visitId,
      proposal.medicineName,
      proposal.fromDose ?? null,
      proposal.toDose ?? null,
      proposal.reason ?? null,
      proposal.changeType ?? "changed",
      proposal.actorId ?? null,
    ],
  );
  return rows[0];
}

export async function withdrawProposal(proposalId, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM giniflow_rx_proposals WHERE id = $1 AND status = 'proposed'`,
    [proposalId],
  );
  if (!rowCount) {
    throw Object.assign(new Error("Proposal not found, or already decided by the doctor"), {
      status: 409,
    });
  }
  return { withdrawn: true };
}

export async function getTestPanels(db = pool, visitId = null) {
  const { rows: panels } = await db.query(
    `SELECT panel_key, label, icon, test_names FROM giniflow_test_panels
      WHERE is_active ORDER BY display_order`,
  );
  const { rows: tests } = await db.query(
    `SELECT c.test_name, ${catalogBasePriceSql("c")} AS price, c.gloss
       FROM giniflow_test_catalog c WHERE c.is_active ORDER BY c.test_name`,
  );
  const { rows: usage } = await db.query(
    `SELECT t.test_name, COUNT(*)::int AS uses
       FROM giniflow_lab_order_tests t
       JOIN giniflow_lab_orders o ON o.id = t.lab_order_id
      WHERE o.created_at > NOW() - INTERVAL '90 days'
      GROUP BY t.test_name`,
  );
  const usesByName = new Map(usage.map((u) => [u.test_name, u.uses]));
  const schemeCode = visitId ? await schemeForVisit(visitId, db) : null;
  const schemePrices = schemeCode
    ? await testPricesFor(
        tests.map((t) => t.test_name),
        schemeCode,
        db,
      )
    : {};
  const listed = Object.fromEntries(
    tests.map((t) => {
      const scheme = schemePrices[t.test_name];
      return [
        t.test_name,
        scheme === undefined || scheme === null ? Number(t.price) : Number(scheme),
      ];
    }),
  );
  const homePrices = visitId ? await withHomeDiscount(visitId, listed, db) : listed;
  return {
    panels: panels.map((p) => ({
      key: p.panel_key,
      label: p.label,
      icon: p.icon,
      tests: p.test_names,
    })),
    tests: tests.map((t) => {
      const price = homePrices[t.test_name];
      return {
        name: t.test_name,
        price,
        homeDiscounted: price !== listed[t.test_name],
        gloss: t.gloss,
        basePrice: Number(t.price),
        schemePriced: listed[t.test_name] !== Number(t.price),
        uses: usesByName.get(t.test_name) || 0,
      };
    }),
    schemeCode,
  };
}

export async function orderTests(
  visitId,
  { urgency, tests = [], customTests = [], actorId = null, byReception = false },
  db = pool,
) {
  const custom = (Array.isArray(customTests) ? customTests : [])
    .map((t) => ({
      name: String(t?.name || "")
        .replace(/\s+/g, " ")
        .trim(),
      price: Number(t?.price) > 0 ? Number(t.price) : 0,
    }))
    .filter((t) => t.name.length >= 2);
  const catalogueNames = (Array.isArray(tests) ? tests : []).filter(Boolean);

  const seen = new Set(catalogueNames.map((n) => n.toUpperCase()));
  const customOnly = custom.filter((t) => !seen.has(t.name.toUpperCase()));

  if (!catalogueNames.length && !customOnly.length) {
    throw Object.assign(new Error("No tests selected"), { status: 400 });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (!byReception) await assertOwner(client, visitId, actorId);

    const { rows: visitRows } = await client.query(
      `SELECT v.current_status,
              (SELECT a.doctor_name FROM appointments a WHERE a.id = v.appointment_id) AS booked_doctor,
              (${directConsultSql("(SELECT a.doctor_name FROM appointments a WHERE a.id = v.appointment_id)")}
               OR EXISTS (SELECT 1 FROM doctors d
                           WHERE d.id = v.assigned_doctor_id AND d.direct_consult)) AS direct_consult
         FROM giniflow_visits v WHERE v.id = $1 FOR NO KEY UPDATE`,
      [visitId],
    );
    if (!visitRows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    const current = visitRows[0].current_status;
    if (byReception && !isTerminalStatus(current) && current !== BACK_FOR_TESTS) {
      throw Object.assign(
        new Error(
          "This patient is still on the floor — tests are ordered from the MO or doctor station",
        ),
        { status: 409 },
      );
    }
    const schemeCode = await schemeForVisit(visitId, client);

    const priceOf = await withHomeDiscount(
      visitId,
      await testPricesFor(catalogueNames, schemeCode, client),
      client,
    );
    const uncatalogued = catalogueNames.filter((name) => priceOf[name] === undefined);
    if (uncatalogued.length)
      throw Object.assign(new Error(`Not in the test catalogue: ${uncatalogued.join(", ")}`), {
        status: 400,
      });
    for (const t of customOnly) priceOf[t.name] = t.price;
    const tests = [...catalogueNames, ...customOnly.map((t) => t.name)];
    const { rows: already } = await client.query(
      `SELECT DISTINCT t.test_name
         FROM giniflow_lab_orders o
         JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1 AND t.test_name = ANY($2)
          AND o.sample_status = ANY($3)`,
      [visitId, tests, UNCOLLECTED],
    );
    if (already.length)
      throw Object.assign(
        new Error(
          `Already ordered and not yet collected: ${already.map((r) => r.test_name).join(", ")}`,
        ),
        { status: 409, duplicates: already.map((r) => r.test_name) },
      );

    const total = tests.reduce((sum, name) => sum + priceOf[name], 0);
    const categoryOf = await testCategoriesFor(catalogueNames, client);
    const kindOf = (name) => (categoryOf[name] === "machine" ? "machine" : "lab");
    const outsourced = await outsourcedTestNames(client, tests);
    const groups = new Map();
    for (const name of tests) {
      const kind = kindOf(name);
      const outside = kind === "lab" && outsourced.has(name);
      const key = `${kind}:${outside}`;
      if (!groups.has(key)) groups.set(key, { kind, outside, tests: [] });
      groups.get(key).tests.push(name);
    }

    const orders = [];
    for (const { kind, outside, tests: kindTests } of groups.values()) {
      const kindTotal = kindTests.reduce((sum, name) => sum + priceOf[name], 0);
      const order = await client.query(
        `INSERT INTO giniflow_lab_orders
           (visit_id, ordered_by, urgency, payment_status, amount_total, sample_status,
            scheme_code, kind, is_outsourced)
         VALUES ($1, $2, $3, 'pending', $4, 'payment_pending', $5, $6, $7)
         RETURNING id`,
        [visitId, actorId, urgency, kindTotal, schemeCode, kind, outside],
      );
      const id = order.rows[0].id;
      if (urgency === "today") await reopenResultsForNewOrder(client, visitId);
      await client.query(
        `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
         SELECT $1, * FROM UNNEST($2::text[], $3::numeric[])`,
        [id, kindTests, kindTests.map((n) => priceOf[n])],
      );
      await client.query(
        `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
         VALUES ($1, 'payment', 'pending', $3, $2)`,
        [id, actorId, byReception ? "reception" : "mo_sd"],
      );
      await linesForOrder(visitId, { labOrderId: id, testNames: kindTests }, { actorId }, client);
      orders.push({ id, kind, outside, tests: kindTests, total: kindTotal });
    }

    const labOrder =
      orders.find((o) => o.kind === "lab" && !o.outside) ||
      orders.find((o) => o.kind === "lab") ||
      null;
    const orderId = labOrder?.id ?? orders[0]?.id ?? null;

    let sentToLab = false;
    if (urgency === "today" && current === "with_sd") {
      await client.query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
         VALUES ($1, 'sd_pending', 'mo_sd', $2, $3)`,
        [visitId, actorId, { source: "lab_ordered", lab_order_id: orderId, tests: tests.length }],
      );
      await client.query(
        `UPDATE giniflow_visits SET current_status = 'sd_pending', updated_at = NOW()
          WHERE id = $1`,
        [visitId],
      );
      sentToLab = true;
    } else if (urgency === "today" && current === "with_doctor" && visitRows[0].direct_consult) {
      await client.query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
         VALUES ($1, 'ready_for_doctor', 'doctor', $2, $3)`,
        [visitId, actorId, { source: "tests_ordered", lab_order_id: orderId, tests: tests.length }],
      );
      await client.query(
        `UPDATE giniflow_visits SET current_status = 'ready_for_doctor', updated_at = NOW()
          WHERE id = $1`,
        [visitId],
      );
      sentToLab = true;
    }
    const afterExit =
      urgency === "today" && (isTerminalStatus(current) || current === BACK_FOR_TESTS);
    const late = afterExit
      ? await reopenForTests(client, visitId, {
          trigger: byReception ? "reception" : "scribe_order",
          tests,
          orderIds: orders.map((o) => o.id),
          actorRole: byReception ? "reception" : "mo_sd",
          actorId,
        })
      : null;
    if (urgency === "today" && labOrder && !afterExit)
      await insertLabStepsForOrder(client, visitId);
    const machineOrders = orders.filter((o) => o.kind === "machine");
    if (urgency === "today" && machineOrders.length && !afterExit) {
      const machines = await getMachines(client);
      const machineIds = [
        ...new Set(
          machineOrders
            .flatMap((o) => o.tests)
            .map((name) => machineForTest(machines, name)?.id)
            .filter(Boolean),
        ),
      ];
      if (machineIds.length) await insertMachineStepsForOrders(client, visitId, machineIds);
    }

    await client.query("COMMIT");
    return {
      orderId,
      orders: orders.map((o) => ({
        orderId: o.id,
        kind: o.kind,
        outsourced: o.outside,
        tests: o.tests,
        total: o.total,
      })),
      urgency,
      tests,
      total,
      sentToLab,
      backForTests: Boolean(late?.reopened),
      reachesReceptionToday: urgency === "today",
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function releaseWorkup(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT v.current_status, v.assigned_sd_id,
              (SELECT plan FROM giniflow_sd_notes n WHERE n.visit_id = v.id) AS plan
         FROM giniflow_visits v WHERE v.id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    if (
      rows[0].assigned_sd_id &&
      rows[0].assigned_sd_id !== (await chiefDeskOwner(actorId, client))
    )
      throw Object.assign(new Error("This patient is not yours to put back"), { status: 409 });
    if (rows[0].current_status !== "with_sd")
      throw Object.assign(
        new Error(
          `This patient is at ${rows[0].current_status.replace(/_/g, " ")} — only a patient open at your desk can be put back`,
        ),
        { status: 409 },
      );

    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
       VALUES ($1, 'sd_pending', 'mo_sd', $2, $3)`,
      [visitId, actorId, { released: true, had_plan: !!rows[0].plan?.trim() }],
    );
    await client.query(
      `UPDATE giniflow_visits
          SET current_status = 'sd_pending', assigned_sd_id = NULL, updated_at = NOW()
        WHERE id = $1`,
      [visitId],
    );
    await client.query("COMMIT");
    return { released: true, status: "sd_pending" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function readyForDoctor(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertOwner(client, visitId, actorId);
    const { rows } = await client.query(
      `SELECT (SELECT plan FROM giniflow_sd_notes n WHERE n.visit_id = v.id) AS plan
         FROM giniflow_visits v WHERE v.id = $1`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    if (!rows[0].plan || !rows[0].plan.trim()) {
      throw Object.assign(new Error("Write a plan before handing this patient to the doctor"), {
        status: 409,
      });
    }

    await advanceStatus(client, {
      visitId,
      toStatus: "ready_for_doctor",
      actorRole: "mo_sd",
      actorId,
    });
    await client.query("COMMIT");
    return { status: "ready_for_doctor" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function closeWithoutDoctor(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertOwner(client, visitId, actorId);
    const { rows } = await client.query(
      `SELECT v.category, v.results_status,
              (SELECT plan FROM giniflow_sd_notes n WHERE n.visit_id = v.id) AS plan,
              (SELECT reports_outcome FROM giniflow_sd_notes n WHERE n.visit_id = v.id)
                AS reports_outcome,
              (SELECT count(*)::int FROM giniflow_lab_orders o
                WHERE o.visit_id = v.id AND ${GATING_ORDER_SQL}) AS orders
         FROM giniflow_visits v
        WHERE v.id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    const { plan, reports_outcome: outcome, orders } = rows[0];

    if (!plan || !plan.trim()) {
      throw Object.assign(new Error("Write a plan before closing this patient"), { status: 409 });
    }

    if (orders > 0 && outcome !== "normal") {
      throw Object.assign(
        new Error(
          outcome === "needs_consultant"
            ? "You marked these reports as needing the consultant — send them on instead"
            : "Review the reports before closing this patient",
        ),
        { status: 409 },
      );
    }
    await applyChiefNextVisit(client, visitId, actorId);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const result = await finalizeConsult(visitId, actorId, db, {
    closedBySd: true,
    requireNextVisit: true,
  });
  return { ...result, status: "doctor_done", skippedDoctor: true };
}

export async function reviewReports(visitId, { outcome, note = null, actorId = null }, db = pool) {
  if (!["normal", "needs_consultant"].includes(outcome)) {
    throw Object.assign(new Error(`Unknown review outcome: ${outcome}`), { status: 400 });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertOwner(client, visitId, actorId);
    const { rows } = await client.query(
      `SELECT results_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    if (rows[0].results_status !== "ready") {
      throw Object.assign(new Error("The reports are not in yet — there is nothing to review"), {
        status: 409,
      });
    }

    await client.query(
      `INSERT INTO giniflow_sd_notes (visit_id, reports_reviewed_at, reports_reviewed_by,
                                      reports_outcome, reports_review_note)
       VALUES ($1, NOW(), $2, $3, $4)
       ON CONFLICT (visit_id) DO UPDATE
         SET reports_reviewed_at  = NOW(),
             reports_reviewed_by  = EXCLUDED.reports_reviewed_by,
             reports_outcome      = EXCLUDED.reports_outcome,
             reports_review_note  = COALESCE(EXCLUDED.reports_review_note,
                                             giniflow_sd_notes.reports_review_note)`,
      [visitId, actorId, outcome, note],
    );
    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
       VALUES ($1, 'reports_reviewed', 'mo_sd', $2, $3)`,
      [visitId, actorId, { outcome, source: "mo_review" }],
    );
    await client.query("COMMIT");
    return { visitId, outcome };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
