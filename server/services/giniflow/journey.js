import pool from "../../config/db.js";
import { AUTO_LAB_BILLING_SQL, JOURNEY_STEPS_SQL } from "./stepSql.js";
import { draftAtCheckIn, linesForOrder } from "../billing/visitLines.js";
import { outsourcedTestNames } from "../billing/testMatch.js";
import {
  CHAIN,
  STATUS_LABEL,
  chainIndex,
  isChainStatus,
  isTerminalStatus,
  BACK_FOR_TESTS,
  JOURNEY_START_SQL,
  TERMINAL_STATUSES,
} from "../../../shared/giniflowStatus.js";
import { reopenForTests } from "./lateTests.js";
import { advanceStatus, reopenResultsForNewOrder } from "./statusEngine.js";
import {
  labOnlyJourney,
  labOnlyName,
  PROCEDURE_STEP,
  procedureStep,
  withProcedure,
} from "../../../shared/labOnly.js";
import { billedProcedures } from "../billing/healthrayBillLines.js";
import {
  ARRIVED_FOR_APPOINTMENT,
  LAB_ONLY_DOCTOR,
  awaitsAppointmentArrivalSql,
  consultBookingSql,
  labOnlyPredicate,
} from "./labOnlyVisits.js";
import { labStepsAreManual } from "../../../shared/manualFloor.js";
import { genVisitToken } from "../flow/journey.js";
import { LAB_RUNGS, stageIndexOf, UNDRAWN_SAMPLE_STATUSES } from "../../../shared/labStages.js";
import {
  machineFor,
  machineForTest,
  MACHINE_STATUS_TO_STAGE,
} from "../../../shared/machineStages.js";
import {
  testsBeforeDoctors,
  requiredStepsFirst,
  isTestStep,
  LAB_TEST_STEP_IDS,
} from "../../../shared/journeyOrder.js";
import { getMachines } from "./machineCatalog.js";
import { addMachineTestOn } from "./machineStation.js";
import { testPricesFor, schemeForVisit, withHomeDiscount } from "../pricing.js";
import {
  LIVE_LAB_CASE_SQL,
  caseFromEarlierLabOnlyVisit,
  caseSampledBeforeVisit,
} from "./testsHold.js";
import { billSuppressor } from "./testCancel.js";
import {
  billedLabLines,
  billedMachineLines,
  billedStepIds,
  priceOrdersFromBill,
  storedBill,
  stepsAllowedByBill,
  syncBillCharges,
} from "./patientBill.js";
import {
  directConsultSql,
  keepsForChoice,
  onlineConsultChoice,
  withoutChief,
} from "../../../shared/directConsult.js";

const DRAWN_STATUS_SQL = LAB_RUNGS.filter((r) => stageIndexOf(r.key) >= stageIndexOf("collected"))
  .flatMap((r) => r.sampleStatuses)
  .map((v) => `'${v}'`)
  .join(", ");

const STEP_SELECT = `
  SELECT id, visit_id, step_order, step_catalog_id, step_name, planned_duration_min,
         station, assigned_role, assigned_staff_id, assigned_staff_name,
         chain_status, status, started_at, completed_at, source
    FROM giniflow_visit_steps`;

const shapeStep = (r) => ({
  stepId: r.id,
  order: r.step_order,
  catalogId: r.step_catalog_id,
  name: r.step_name,
  minutes: r.planned_duration_min,
  station: r.station,
  role: r.assigned_role,
  staffId: r.assigned_staff_id,
  staffName: r.assigned_staff_name,
  chainStatus: r.chain_status,
  status: r.status,
  manual: !r.chain_status,
  startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
  completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  source: r.source,
});

export { AUTO_LAB_BILLING_SQL, JOURNEY_STEPS_SQL };

const LAB_ONLY_LEG = ["blood_sample", "lab_processing_2"];
const AFTER_LAB_BILLING = ["blood_sample", "lab_processing_2", "report_upload"];
const LAB_BILLING_OPEN_SQL = (visit) => `EXISTS (
  SELECT 1 FROM giniflow_visit_steps lb
   WHERE lb.visit_id = ${visit} AND lb.step_catalog_id = 'lab_billing' AND lb.status <> 'done'
)`;

const PLANNED_STEP_SQL = (step) => `NOT ${AUTO_LAB_BILLING_SQL(step)}`;

export async function planSkips(db, visitId, chainStatuses) {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM giniflow_visit_steps ps
                     WHERE ps.visit_id = $1 AND ${PLANNED_STEP_SQL("ps")}) AS planned,
            EXISTS (SELECT 1 FROM giniflow_visit_steps
                     WHERE visit_id = $1 AND chain_status = ANY($2::text[]) AND status <> 'skipped')
              AS has_stop`,
    [visitId, chainStatuses],
  );
  return !!rows[0]?.planned && !rows[0].has_stop;
}

export const VISIT_DIRECT_CONSULT_SQL = `(${directConsultSql(
  "(SELECT ba.doctor_name FROM appointments ba WHERE ba.id = v.appointment_id)",
)} OR EXISTS (SELECT 1 FROM doctors dd WHERE dd.id = v.assigned_doctor_id AND dd.direct_consult))`;

export const PLAN_STOP = { vitals: ["with_vitals"], chief: ["with_sd"], doctor: ["with_doctor"] };

async function consultantChiefStep(db, visitId) {
  const { rows } = await db.query(
    `SELECT d.chief_step
       FROM giniflow_visits v
       LEFT JOIN appointments a ON a.id = v.appointment_id
       JOIN doctors d ON d.id = COALESCE(
              v.assigned_doctor_id,
              a.doctor_id,
              (SELECT x.id FROM doctors x
                WHERE lower(btrim(x.name)) = lower(btrim(a.doctor_name))
                ORDER BY x.is_active IS NOT FALSE DESC, x.id LIMIT 1))
      WHERE v.id = $1`,
    [visitId],
  );
  return rows[0]?.chief_step;
}

export async function consultantSkipsChief(db, visitId) {
  return (await consultantChiefStep(db, visitId)) !== true;
}

async function isOnlineType(db, visitTypeId) {
  const { rows } = await db.query(
    `SELECT COALESCE(for_online, FALSE) AS online FROM flow_visit_types WHERE id = $1`,
    [visitTypeId],
  );
  return !!rows[0]?.online;
}

export async function skipsChiefStop(db, visitId) {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM giniflow_visit_steps ps
                     WHERE ps.visit_id = $1 AND ${PLANNED_STEP_SQL("ps")}) AS planned`,
    [visitId],
  );
  return rows[0]?.planned
    ? planSkips(db, visitId, PLAN_STOP.chief)
    : consultantSkipsChief(db, visitId);
}

const clampMinutes = (v) => Math.min(600, Math.max(0, Math.round(Number(v) || 0)));

const RESULTS_STATUS_SQL = LAB_RUNGS.filter((r) => stageIndexOf(r.key) >= stageIndexOf("results"))
  .flatMap((r) => r.sampleStatuses)
  .map((v) => `'${v}'`)
  .join(", ");

const REPORTED_STATUS_SQL = LAB_RUNGS.filter((r) => r.key === "reported")
  .flatMap((r) => r.sampleStatuses)
  .map((v) => `'${v}'`)
  .join(", ");

const HR_LAB_EVIDENCE_SQL = `
  (SELECT count(*)::int FROM lab_cases lc
    WHERE lc.case_date = v.visit_date
      AND (lc.patient_id = v.patient_id
           OR (lc.patient_id IS NULL
               AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
      AND ${LIVE_LAB_CASE_SQL("lc")}) AS hr_cases,
  (SELECT bool_or(${
    labStepsAreManual()
      ? `EXISTS (SELECT 1 FROM giniflow_lab_case_actions ca
                  WHERE ca.case_no = lc.case_no AND ca.action = 'sample_taken')`
      : `lc.raw_list_json->>'phlebotomy_status' = 'Completed'
         OR (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'collected_on') IS NOT NULL
         OR (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on') IS NOT NULL`
  })
     FROM lab_cases lc
    WHERE lc.case_date = v.visit_date
      AND (lc.patient_id = v.patient_id
           OR (lc.patient_id IS NULL
               AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
      AND ${LIVE_LAB_CASE_SQL("lc")}) AS hr_collected,
  (SELECT bool_and(${
    labStepsAreManual()
      ? `EXISTS (SELECT 1 FROM giniflow_lab_case_actions ca
                  WHERE ca.case_no = lc.case_no AND ca.action = 'report_uploaded')`
      : `(COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on') IS NOT NULL`
  })
     FROM lab_cases lc
    WHERE lc.case_date = v.visit_date
      AND (lc.patient_id = v.patient_id
           OR (lc.patient_id IS NULL
               AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
      AND ${LIVE_LAB_CASE_SQL("lc")}) AS hr_reported,
  (SELECT bool_and(${
    labStepsAreManual()
      ? `EXISTS (SELECT 1 FROM giniflow_lab_case_actions ca
                  WHERE ca.case_no = lc.case_no
                    AND ca.action IN ('results_ready', 'report_uploaded'))`
      : `(COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on') IS NOT NULL`
  })
     FROM lab_cases lc
    WHERE lc.case_date = v.visit_date
      AND (lc.patient_id = v.patient_id
           OR (lc.patient_id IS NULL
               AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
      AND ${LIVE_LAB_CASE_SQL("lc")}) AS hr_results`;

export const SAMPLE_TAKEN_BEFORE_VISIT_SQL = (v = "v", p = "p") => `EXISTS (
  SELECT 1 FROM lab_cases lc
   WHERE lc.case_date = ${v}.visit_date
     AND (lc.patient_id = ${v}.patient_id
          OR (lc.patient_id IS NULL
              AND lc.raw_list_json->'patient'->>'healthray_uid' = ${p}.file_no))
     AND ${LIVE_LAB_CASE_SQL("lc")}
     AND (${caseSampledBeforeVisit(v)} OR ${caseFromEarlierLabOnlyVisit(v)}))`;

export async function sampleTakenBeforeVisit(db, visitId) {
  const { rows } = await db.query(
    `SELECT ${SAMPLE_TAKEN_BEFORE_VISIT_SQL()} AS earlier
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  return !!rows[0]?.earlier;
}

export async function healthrayCaseTestNames(db, visitId) {
  const { rows: visit } = await db.query(
    `SELECT v.patient_id, v.visit_date::text AS visit_date, p.file_no
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!visit.length) return [];
  const { patient_id: patientId, visit_date: visitDate, file_no: fileNo } = visit[0];
  const { rows } = await db.query(
    `SELECT lc.test_names
       FROM lab_cases lc
      WHERE lc.case_date = $1::date
        AND (lc.patient_id = $2
             OR (lc.patient_id IS NULL
                 AND lc.raw_list_json->'patient'->>'healthray_uid' = $3))
        AND ${LIVE_LAB_CASE_SQL("lc")}`,
    [visitDate, patientId, fileNo],
  );
  return rows.flatMap((r) => r.test_names || []);
}

export async function labCaseAlreadyReported(db, visitId) {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM lab_cases lc
        WHERE lc.case_date = v.visit_date
          AND (lc.patient_id = v.patient_id
               OR (lc.patient_id IS NULL
                   AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
          AND ${LIVE_LAB_CASE_SQL("lc")}
          AND COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' IS NOT NULL
     ) AS reported
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  return !!rows[0]?.reported;
}

const trimmed = (v, max = 120) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

export async function defaultPlan(visitTypeId, db = pool) {
  const { rows } = await db.query(
    `SELECT t.step_order, t.is_default, t.condition_key,
            c.id AS catalog_id, c.name, c.station, c.assigned_role, c.chain_status,
            COALESCE(c.machine, FALSE) AS machine,
            COALESCE(t.override_duration_min, c.default_duration_min)::int AS minutes
       FROM flow_step_templates t
       JOIN flow_step_catalog c ON c.id = t.step_catalog_id
      WHERE t.visit_type_id = $1 AND COALESCE(c.is_active, TRUE)
        -- The lab's own pipeline — delivered / processing / reports available,
        -- and the report desk's stages — is not a stop the patient makes. The
        -- lab station records that work already, and listing it here asked the
        -- desk to tick seven boxes for things they never touch. A background
        -- step that DOES map to a board column (the MO preparing a prescription)
        -- stays: it ticks itself and costs nobody anything.
        AND NOT (COALESCE(c.is_background, FALSE) AND c.chain_status IS NULL)
      ORDER BY t.step_order`,
    [visitTypeId],
  );
  return rows.map((r) => ({
    catalogId: r.catalog_id,
    machine: r.machine,
    name: r.name,
    minutes: r.minutes,
    station: r.station,
    role: r.assigned_role,
    chainStatus: r.chain_status,
    conditionKey: r.condition_key,
    included: r.is_default !== false,
    source: "template",
  }));
}
export async function suggestVisitType(
  { isFollowUp, isWalkIn, isTests = false, isOnline = false },
  db = pool,
) {
  const { rows } = await db.query(
    `SELECT id FROM flow_visit_types t
      WHERE is_active = TRUE
        AND NOT ${FOR_LAB_ONLY_SQL("t")}
        AND CASE
              WHEN $4 THEN for_online
              ELSE NOT for_online
                   AND ($3 OR for_followup = $1) AND for_walkin = $2
                   AND COALESCE(for_tests, FALSE) = $3
            END
      ORDER BY for_followup IS NOT DISTINCT FROM $1 DESC, max_time_min, id LIMIT 1`,
    [!!isFollowUp, !!isWalkIn, !!isTests, !!isOnline],
  );
  return rows[0]?.id || null;
}

// ── Reading a journey ──────────────────────────────────────────────────────

export async function getJourney(visitId, db = pool) {
  const { rows } = await db.query(`${STEP_SELECT} WHERE visit_id = $1 ORDER BY step_order`, [
    visitId,
  ]);
  const { rows: visitRows } = await db.query(
    `SELECT current_status FROM giniflow_visits WHERE id = $1`,
    [visitId],
  );
  const visitStatus = visitRows[0]?.current_status || null;
  const skipNote = rows.some(
    (r) => r.status === "skipped" && LAB_ONLY_LEG.includes(r.step_catalog_id),
  )
    ? await labLegSkipNote(db, visitId)
    : null;
  const steps = rows
    .map(shapeStep)
    .map((s) =>
      skipNote && s.status === "skipped" && LAB_ONLY_LEG.includes(s.catalogId)
        ? { ...s, skipNote }
        : s,
    );
  const done = steps.filter((s) => s.status === "done").length;
  const current = steps.find((s) => s.status === "in_progress") || null;
  const next = steps.find((s) => s.status === "pending") || null;
  return {
    visitId,
    steps,
    visitStatus,
    // A visit that ended is a record, not a worklist: nothing left in it is
    // still somebody's to do.
    finished: isTerminalStatus(visitStatus) || ABANDONED.includes(visitStatus),
    doneCount: done,
    totalCount: steps.length,
    plannedTotalMin: steps.reduce((sum, s) => sum + s.minutes, 0),
    currentStep: current?.name || null,
    nextStep: next?.name || null,
  };
}

// ── Writing one ────────────────────────────────────────────────────────────

const insertSteps = async (client, visitId, steps) => {
  const { rows } = await client.query(
    `SELECT COALESCE(max(step_order), 0)::int AS last FROM giniflow_visit_steps WHERE visit_id = $1`,
    [visitId],
  );
  const after = rows[0].last;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await client.query(
      `INSERT INTO giniflow_visit_steps
         (visit_id, step_order, step_catalog_id, step_name, planned_duration_min,
          station, assigned_role, assigned_staff_id, assigned_staff_name,
          chain_status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               -- The catalog's mapping is snapshotted here, and a custom step
               -- has none: it is a stop nobody's board was built to show.
               (SELECT chain_status FROM flow_step_catalog WHERE id = $3),
               $10)`,
      [
        visitId,
        after + i + 1,
        s.catalogId || null,
        trimmed(s.name) || "Step",
        clampMinutes(s.minutes),
        trimmed(s.station) || null,
        trimmed(s.role, 60) || null,
        s.staffId ? String(s.staffId).slice(0, 40) : null,
        trimmed(s.staffName) || null,
        s.catalogId ? s.source || "template" : "custom",
      ],
    );
  }
};
const UNCOLLECTED = UNDRAWN_SAMPLE_STATUSES;

export const labTestsOf = (steps) => [
  ...new Set(
    steps
      .filter((s) => s.catalogId === "blood_sample" && s.billedIn !== "healthray")
      .flatMap((s) => (Array.isArray(s.tests) ? s.tests : []))
      .map((t) => trimmed(t))
      .filter(Boolean),
  ),
];

export const billedLabTestsOf = (steps) => {
  const byName = new Map();
  for (const step of steps) {
    if (step.catalogId !== "blood_sample" || step.billedIn !== "healthray") continue;
    for (const t of step.billedTests || []) {
      const name = trimmed(t?.name);
      if (name && !byName.has(name)) byName.set(name, Math.max(0, Number(t.amount) || 0));
    }
  }
  return byName;
};

const benchAlreadyStarted = async (client, visitId) => {
  const { rows } = await client.query(
    `SELECT EXISTS (
       SELECT 1
         FROM giniflow_visits v
         JOIN patients p ON p.id = v.patient_id
         JOIN lab_cases lc
           ON lc.case_date = v.visit_date
          AND (lc.patient_id = v.patient_id
               OR (lc.patient_id IS NULL
                   AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
        WHERE v.id = $1
          AND EXISTS (SELECT 1 FROM giniflow_lab_case_actions a WHERE a.case_no = lc.case_no)
     ) AS started`,
    [visitId],
  );
  return rows[0].started || (await sampleTakenBeforeVisit(client, visitId));
};

async function insertLabOrder(client, visitId, { tests, priceOf, schemeCode, actorId, outside }) {
  const total = tests.reduce((sum, n) => sum + priceOf[n], 0);
  const { rows: order } = await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, ordered_by, urgency, payment_status, amount_total, sample_status,
        scheme_code, kind, is_outsourced)
     VALUES ($1, $2, 'today', 'pending', $3, 'payment_pending', $4, 'lab', $5)
     RETURNING id`,
    [visitId, actorId, total, schemeCode, outside],
  );
  const labOrderId = order[0].id;
  await reopenResultsForNewOrder(client, visitId);
  await client.query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
     SELECT $1, * FROM UNNEST($2::text[], $3::numeric[])`,
    [labOrderId, tests, tests.map((n) => priceOf[n])],
  );
  await client.query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
     VALUES ($1, 'payment', 'pending', 'reception', $2)`,
    [labOrderId, actorId],
  );
  await linesForOrder(visitId, { labOrderId, testNames: tests }, { actorId }, client);
  return labOrderId;
}

export async function raiseOrdersFromSteps(client, visitId, steps, actorId = null) {
  const raised = {
    labOrderId: null,
    labTests: [],
    outsideOrderId: null,
    outsideTests: [],
    machine: [],
  };
  const billed = billedLabTestsOf(steps);
  if (billed.size && (await benchAlreadyStarted(client, visitId))) billed.clear();
  const picked = labTestsOf(steps).filter((n) => !billed.has(n));
  const wantedTests = [...picked, ...billed.keys()];

  if (wantedTests.length) {
    // Priced the way every other order is: the scheme is snapshotted onto the
    // row, so a card corrected next week cannot re-price a settled order.
    const schemeCode = await schemeForVisit(visitId, client);
    const priceOf = {
      ...(picked.length
        ? await withHomeDiscount(visitId, await testPricesFor(picked, schemeCode, client), client)
        : {}),
      ...Object.fromEntries(billed),
    };
    const unknown = wantedTests.filter((n) => priceOf[n] === undefined);
    if (unknown.length) {
      throw Object.assign(new Error(`Not in the test catalogue: ${unknown.join(", ")}`), {
        status: 400,
      });
    }

    const { rows: already } = await client.query(
      `SELECT DISTINCT t.test_name
         FROM giniflow_lab_orders o
         JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1 AND t.test_name = ANY($2) AND o.sample_status = ANY($3)`,
      [visitId, wantedTests, UNCOLLECTED],
    );
    const tests = wantedTests.filter((n) => !already.some((r) => r.test_name === n));

    const outsourced = await outsourcedTestNames(client, tests);
    const inHouse = tests.filter((n) => !outsourced.has(n));
    const outside = tests.filter((n) => outsourced.has(n));
    const order = { priceOf, schemeCode, actorId };
    if (inHouse.length) {
      raised.labOrderId = await insertLabOrder(client, visitId, {
        ...order,
        tests: inHouse,
        outside: false,
      });
      raised.labTests = inHouse;
    }
    if (outside.length) {
      raised.outsideOrderId = await insertLabOrder(client, visitId, {
        ...order,
        tests: outside,
        outside: true,
      });
      raised.outsideTests = outside;
    }
  }

  const machines = steps.some((s) => s.catalogId) ? await getMachines(client) : [];
  for (const step of steps) {
    const machine = step.catalogId ? machineFor(machines, step.catalogId) : null;
    if (!machine) continue;
    const r = await addMachineTestOn(client, visitId, { machineId: machine.id, actorId });
    raised.machine.push({
      machine: r.machine,
      orderId: r.orderId,
      alreadyThere: !!r.alreadyThere,
    });
  }

  if (raised.labOrderId || raised.outsideOrderId) await insertLabStepsForOrder(client, visitId);
  return raised;
}

const isEarlierLabStep = (s) =>
  LAB_TEST_STEP_IDS.includes(s.catalogId) &&
  s.source !== "added" &&
  !(s.billedIn !== "healthray" && s.tests?.length);

const uniqueToken = async (client) => {
  for (let i = 0; i < 5; i++) {
    const token = genVisitToken();
    const hit = await client.query(`SELECT 1 FROM giniflow_visits WHERE visit_token = $1`, [token]);
    if (!hit.rowCount) return token;
  }
  return genVisitToken();
};

const consultantPicked = async (client, steps) => {
  const picks = steps.filter((s) => s.catalogId && /^\d+$/.test(String(s.staffId ?? "")));
  if (!picks.length) return null;
  const { rows } = await client.query(
    `SELECT d.id
       FROM unnest($1::text[], $2::int[]) WITH ORDINALITY AS p(catalog_id, staff_id, n)
       JOIN flow_step_catalog c ON c.id = p.catalog_id AND c.chain_status = 'with_doctor'
       JOIN doctors d ON d.id = p.staff_id AND d.role = 'consultant' AND COALESCE(d.is_active, TRUE)
      ORDER BY p.n
      LIMIT 1`,
    [picks.map((s) => s.catalogId), picks.map((s) => Number(s.staffId))],
  );
  return rows[0]?.id ?? null;
};

export const FOR_LAB_ONLY_SQL = (t = "t") =>
  `COALESCE((to_jsonb(${t}) ->> 'for_lab_only')::boolean, FALSE)`;

export async function savedLabOnlyType(db = pool) {
  const { rows } = await db.query(
    `SELECT t.id FROM flow_visit_types t
      WHERE ${FOR_LAB_ONLY_SQL("t")} AND COALESCE(t.is_active, TRUE)
        AND EXISTS (SELECT 1 FROM flow_step_templates s WHERE s.visit_type_id = t.id)
      ORDER BY t.id LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}

const isLabOnlyVisit = async (db, visitId) => {
  const { rows } = await db.query(
    `SELECT ${labOnlyPredicate("v", "$2")} AS lab_only FROM giniflow_visits v WHERE v.id = $1`,
    [visitId, LAB_ONLY_DOCTOR],
  );
  return !!rows[0]?.lab_only;
};

const labOnlyPlan = async (db, visitId, steps) => {
  const { rows } = await db.query(
    `SELECT ${labOnlyPredicate("v", "$2")} AS lab_only,
            EXISTS (SELECT 1 FROM giniflow_visit_steps s
                     WHERE s.visit_id = v.id AND s.step_catalog_id = 'lab_billing') AS has_lab_billing
       FROM giniflow_visits v WHERE v.id = $1`,
    [visitId, LAB_ONLY_DOCTOR],
  );
  if (!rows[0]?.lab_only) return steps;
  const { rows: catalog } = await db.query(
    `SELECT id, name, default_duration_min, station, assigned_role, chain_status
       FROM flow_step_catalog WHERE COALESCE(is_active, TRUE)`,
  );
  return labOnlyJourney(steps, catalog, {
    hasBilling: rows[0].has_lab_billing,
    saved: !!(await savedLabOnlyType(db)),
  });
};

export async function procedureStepFor(db, bill, machines) {
  const onMachines = new Set(
    billedMachineLines(bill, machines)
      .filter((line) => line.machines.length)
      .map((line) => line.name),
  );
  const names = await billedProcedures(db, bill, onMachines);
  if (!names.length) return null;
  const { rows } = await db.query(
    `SELECT id, name, default_duration_min, station, assigned_role
       FROM flow_step_catalog WHERE id = $1 AND COALESCE(is_active, TRUE)`,
    [PROCEDURE_STEP],
  );
  return procedureStep(rows[0], names);
}

const withBilledProcedure = async (db, visitId, steps, bill, machines) => {
  if (!(await isLabOnlyVisit(db, visitId))) return steps;
  const procedure = await procedureStepFor(db, bill, machines);
  return withProcedure(steps, procedure, { only: billedStepIds(bill, machines).size === 0 });
};

const requireConsultant = async (client, visitId) => {
  const { rows } = await client.query(
    `SELECT v.assigned_doctor_id IS NULL
            AND EXISTS (SELECT 1 FROM giniflow_visit_steps s
                         WHERE s.visit_id = v.id AND s.chain_status = 'with_doctor'
                           AND s.status <> 'skipped') AS missing
       FROM giniflow_visits v WHERE v.id = $1`,
    [visitId],
  );
  if (rows[0]?.missing) {
    throw Object.assign(
      new Error("Choose the consultant this patient will see before checking them in."),
      { status: 400 },
    );
  }
};

export async function checkInWithJourney(visitId, choices, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { alreadyHere, alreadyPlanned, raised } = await checkInIn(client, visitId, choices);
    await client.query("COMMIT");
    if (!alreadyHere) await draftAtCheckIn(visitId, { actorId: choices.actorId ?? null }, db);
    const journey = await getJourney(visitId, db);
    const { rows } = await db.query(
      `SELECT visit_token, planned_total_min FROM giniflow_visits WHERE id = $1`,
      [visitId],
    );
    return {
      ...journey,
      alreadyPlanned,
      raised,
      visitToken: rows[0]?.visit_token || null,
      plannedTotalMin: rows[0]?.planned_total_min ?? journey.plannedTotalMin,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const notAllowed = (status, message) => Object.assign(new Error(message), { status });

export async function arriveForAppointmentIn(
  client,
  visitId,
  { visitTypeId = null, steps: askedSteps = [], actorId = null, actorRole = "reception" },
) {
  const { rows } = await client.query(
    `SELECT v.current_status, v.patient_id, v.visit_date, v.echo_referral,
            ${VISIT_DIRECT_CONSULT_SQL} AS direct_consult,
            ${awaitsAppointmentArrivalSql("v", "$2")} AS eligible,
            ${consultBookingSql("v", "$2")} AS consult_appointment_id,
            array(SELECT s.step_catalog_id FROM giniflow_visit_steps s
                   WHERE s.visit_id = v.id AND s.step_catalog_id IS NOT NULL) AS have
       FROM giniflow_visits v WHERE v.id = $1 FOR NO KEY UPDATE`,
    [visitId, LAB_ONLY_DOCTOR],
  );
  const visit = rows[0];
  if (!visit) throw notAllowed(404, "Visit not found");
  if (!visit.eligible)
    throw notAllowed(
      409,
      "This patient has no consultant booking waiting, or their journey already has the consultation",
    );
  const have = new Set(visit.have);
  const bill = await storedBill(visit.patient_id, visit.visit_date, client);
  const machines = await getMachines(client);
  const allowed = stepsAllowedByBill(askedSteps, bill, machines);
  const routed = visit.direct_consult ? withoutChief(allowed) : allowed;
  const ordered = visit.echo_referral ? echoFirst(routed, machines) : routed;
  const steps = ordered.filter((s) => !s.catalogId || !have.has(s.catalogId));
  const { rows: catalog } = await client.query(
    `SELECT id, chain_status, COALESCE(machine, FALSE) AS machine
       FROM flow_step_catalog WHERE id = ANY($1)`,
    [steps.map((s) => s.catalogId).filter(Boolean)],
  );
  const addsTests = catalog.some((c) => isTestStep(c.id, c.machine));
  if (!catalog.some((c) => ["with_sd", "with_doctor"].includes(c.chain_status)))
    throw notAllowed(400, "Add the Chief or consultant stop this patient is here for.");

  await client.query(
    `UPDATE giniflow_visits
        SET current_status = 'booked', appointment_id = $2, resume_status = NULL,
            blocked_reason = NULL,
            planned_total_min = COALESCE(planned_total_min, 0) + $3, updated_at = NOW()
      WHERE id = $1`,
    [
      visitId,
      visit.consult_appointment_id,
      steps.reduce((sum, s) => sum + clampMinutes(s.minutes), 0),
    ],
  );
  await advanceStatus(client, {
    visitId,
    toStatus: "checked_in",
    actorRole,
    actorId,
    meta: {
      reason: ARRIVED_FOR_APPOINTMENT,
      after: visit.current_status,
      appointment_id: visit.consult_appointment_id,
      visitTypeId,
      steps: steps.length,
    },
  });
  await insertSteps(client, visitId, steps);
  const raised = await raiseOrdersFromSteps(client, visitId, steps, actorId);
  await priceOrdersFromBill(client, visitId, bill, machines);
  await syncBillCharges(client, visitId, bill, machines, await billSuppressor(client, visitId));
  if (addsTests) await placeTestsBeforeDoctors(client, visitId);
  await settlePlanIn(client, visitId, {
    askedSteps,
    steps,
    visitTypeId,
    actorId,
    keepPlannedTotal: true,
  });
  await syncLabStepsFromLab(client, visitId);
  return { raised, added: steps.length };
}

export async function arriveForAppointment(visitId, choices, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { raised, added } = await arriveForAppointmentIn(client, visitId, choices);
    await client.query("COMMIT");
    await draftAtCheckIn(visitId, { actorId: choices.actorId ?? null }, db);
    return { ...(await getJourney(visitId, db)), raised, added };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function settlePlanIn(
  client,
  visitId,
  { askedSteps, steps, visitTypeId, actorId, keepPlannedTotal },
) {
  const assigned = await client.query(
    `SELECT chain_status, assigned_staff_id::int AS staff_id
         FROM giniflow_visit_steps
        WHERE visit_id = $1
          AND chain_status IN ('with_sd', 'with_doctor')
          AND assigned_staff_id ~ '^[0-9]+$'
          AND (chain_status <> 'with_doctor'
               OR EXISTS (SELECT 1 FROM doctors d
                           WHERE d.id = assigned_staff_id::int AND d.role = 'consultant'
                             AND COALESCE(d.is_active, TRUE)))
        ORDER BY step_order`,
    [visitId],
  );
  const forColumn = (status) =>
    assigned.rows.find((r) => r.chain_status === status)?.staff_id ?? null;
  const doctorId = forColumn("with_doctor") ?? (await consultantPicked(client, askedSteps));

  const token = await uniqueToken(client);
  const planned = steps.reduce((sum, s) => sum + clampMinutes(s.minutes), 0);
  await client.query(
    `UPDATE giniflow_visits
          SET visit_type_id = COALESCE($2, visit_type_id),
              planned_total_min = CASE WHEN $4 THEN planned_total_min ELSE $3 END,
              visit_token = COALESCE(visit_token, $5),
              checked_in_by = COALESCE(checked_in_by, $6),
              -- COALESCE, never an overwrite: the module's existing rule is that
              -- whoever is in the room beats whoever was booked, and by the time
              -- a station has claimed a patient the desk's guess is stale.
              assigned_sd_id = COALESCE(assigned_sd_id, $7),
              assigned_doctor_id = COALESCE(assigned_doctor_id, $8),
              updated_at = NOW()
        WHERE id = $1`,
    [
      visitId,
      visitTypeId,
      planned,
      keepPlannedTotal,
      token,
      actorId,
      forColumn("with_sd"),
      doctorId,
    ],
  );
  await requireConsultant(client, visitId);
  const { rows: nowAt } = await client.query(
    `SELECT current_status FROM giniflow_visits WHERE id = $1`,
    [visitId],
  );
  const checkedInOnly =
    nowAt[0]?.current_status === "checked_in" &&
    (await planSkips(client, visitId, PLAN_STOP.vitals));
  if (
    checkedInOnly &&
    !(await planSkips(client, visitId, PLAN_STOP.chief)) &&
    (await planSkips(client, visitId, PLAN_STOP.doctor))
  ) {
    await client.query("SAVEPOINT straight_to_chief");
    try {
      await advanceStatus(client, {
        visitId,
        toStatus: "sd_pending",
        actorRole: "system",
        allowSkip: true,
        meta: { reason: "plan_has_no_vitals_or_consultant_step", after: "checked_in" },
      });
      await client.query("RELEASE SAVEPOINT straight_to_chief");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT straight_to_chief");
    }
  }
  if (
    checkedInOnly &&
    (await planSkips(client, visitId, PLAN_STOP.chief)) &&
    !(await planSkips(client, visitId, PLAN_STOP.doctor))
  ) {
    await client.query("SAVEPOINT straight_to_consultant");
    try {
      await advanceStatus(client, {
        visitId,
        toStatus: "ready_for_doctor",
        actorRole: "system",
        allowSkip: true,
        meta: { reason: "plan_has_no_vitals_or_chief_step", after: "checked_in" },
      });
      await client.query("RELEASE SAVEPOINT straight_to_consultant");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT straight_to_consultant");
    }
  }
}

export async function checkInIn(
  client,
  visitId,
  { visitTypeId = null, steps: askedSteps = [], actorId = null, actorRole = "reception" },
) {
  const existing = await client.query(
    `SELECT v.current_status, v.patient_id, v.visit_date,
              (SELECT count(*)::int FROM giniflow_visit_steps s
                WHERE s.visit_id = v.id AND ${PLANNED_STEP_SQL("s")}) AS steps,
              (SELECT a.doctor_name FROM appointments a WHERE a.id = v.appointment_id) AS booked_doctor,
              (SELECT d.name FROM doctors d WHERE d.id = v.assigned_doctor_id) AS assigned_doctor,
              ${VISIT_DIRECT_CONSULT_SQL} AS direct_consult,
              v.echo_referral
         FROM giniflow_visits v WHERE v.id = $1 FOR NO KEY UPDATE`,
    [visitId],
  );
  if (!existing.rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  const labAlreadyDone = await sampleTakenBeforeVisit(client, visitId);
  const bill = await storedBill(existing.rows[0].patient_id, existing.rows[0].visit_date, client);
  const machines = await getMachines(client);
  const allowed = stepsAllowedByBill(askedSteps, bill, machines).filter(
    (s) => !(labAlreadyDone && isEarlierLabStep(s)),
  );
  const routed = existing.rows[0].direct_consult ? withoutChief(allowed) : allowed;
  const ordered = existing.rows[0].echo_referral ? echoFirst(routed, machines) : routed;
  const steps = (await consultantPicked(client, askedSteps))
    ? ordered
    : await labOnlyPlan(client, visitId, ordered);
  const current = existing.rows[0].current_status;
  // A second press at a busy counter must not give the patient two journeys.
  const alreadyPlanned = existing.rows[0].steps > 0;
  const alreadyHere = isChainStatus(current) && chainIndex(current) >= chainIndex("checked_in");

  if (isChainStatus(current) && chainIndex(current) > chainIndex("checked_in")) {
    throw Object.assign(
      new Error(`${STATUS_LABEL[current] || current} — this patient is already past reception`),
      { status: 409 },
    );
  }

  if (!alreadyHere) {
    await advanceStatus(client, {
      visitId,
      toStatus: "checked_in",
      actorRole,
      actorId,
      meta: { visitTypeId, steps: steps.length },
    });
  }

  let raised = {
    labOrderId: null,
    labTests: [],
    outsideOrderId: null,
    outsideTests: [],
    machine: [],
  };
  if (!alreadyPlanned) {
    await insertSteps(client, visitId, steps);
    if (alreadyHere) await syncFromStatus(client, visitId, current);
    raised = await raiseOrdersFromSteps(client, visitId, steps, actorId);
    await priceOrdersFromBill(client, visitId, bill, machines);
    await syncBillCharges(client, visitId, bill, machines, await billSuppressor(client, visitId));
    await insertLabStepsIfHealthrayCase(client, visitId);
    await addSkippedLabLeg(client, visitId);
    await placeTestsBeforeDoctors(client, visitId);
  }

  await settlePlanIn(client, visitId, {
    askedSteps,
    steps,
    visitTypeId,
    actorId,
    keepPlannedTotal: alreadyPlanned,
  });
  await syncLabStepsFromLab(client, visitId);
  return { alreadyHere, alreadyPlanned, raised };
}

export async function ensurePlan(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT v.id, v.visit_type_id, v.current_status, v.patient_id, v.visit_date,
            -- Completed bookings only, and never appointments.is_walkin — the
            -- reasons are on ARRIVAL_SELECT in receptionStation.js, with the
            -- numbers in src/lib/flowAppointmentType.js.
            (SELECT COUNT(*)::int FROM appointments pa
              WHERE pa.patient_id = v.patient_id
                AND pa.appointment_date < v.visit_date
                AND pa.status = 'completed') AS prior_visits,
            CASE
              WHEN a.visit_type ~* '(follow|f/?u|review)' THEN TRUE
              WHEN a.visit_type ~* '^\s*new\b' THEN FALSE
              ELSE NULL
            END AS booked_as_followup,
            (a.visit_type ~* '(investigat|lab|test)') AS booked_for_tests,
            (a.visit_type ~* '(tele|online|video)') AS booked_online,
            (SELECT COUNT(*)::int FROM giniflow_visit_steps s
              WHERE s.visit_id = v.id AND ${PLANNED_STEP_SQL("s")}) AS steps,
            a.doctor_name AS booked_doctor,
            (SELECT d.name FROM doctors d WHERE d.id = v.assigned_doctor_id) AS assigned_doctor,
            ${VISIT_DIRECT_CONSULT_SQL} AS direct_consult,
            v.echo_referral
       FROM giniflow_visits v
       LEFT JOIN appointments a ON a.id = v.appointment_id
      WHERE v.id = $1`,
    [visitId],
  );
  const visit = rows[0];
  if (!visit) throw Object.assign(new Error("Visit not found"), { status: 404 });
  if (visit.steps > 0) return { seeded: false };

  const labType = (await isLabOnlyVisit(db, visitId)) ? await savedLabOnlyType(db) : null;
  const visitTypeId =
    labType ||
    visit.visit_type_id ||
    (await suggestVisitType(
      {
        isFollowUp: visit.booked_as_followup ?? visit.prior_visits > 0,
        isWalkIn: false,
        isTests: !!visit.booked_for_tests,
        isOnline: !!visit.booked_online,
      },
      db,
    ));
  if (!visitTypeId) return { seeded: false };

  const machines = await getMachines(db);
  const bill = await storedBill(visit.patient_id, visit.visit_date, db);
  const billed = stepsAllowedByBill(
    (await defaultPlan(visitTypeId, db)).filter((s) => s.included),
    bill,
    machines,
  );
  const chiefStep = visit.direct_consult ? false : await consultantChiefStep(db, visitId);
  const routed =
    chiefStep === true || (await isOnlineType(db, visitTypeId))
      ? billed.filter((s) => keepsForChoice(s, onlineConsultChoice(chiefStep)))
      : withoutChief(billed);
  const plan = await withBilledProcedure(
    db,
    visitId,
    await labOnlyPlan(db, visitId, visit.echo_referral ? echoFirst(routed, machines) : routed),
    bill,
    machines,
  );
  if (!plan.length) return { seeded: false };

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [visitId]);
    const race = await client.query(
      `SELECT count(*)::int AS c FROM giniflow_visit_steps s
        WHERE s.visit_id = $1 AND ${PLANNED_STEP_SQL("s")}`,
      [visitId],
    );
    if (race.rows[0].c > 0) {
      await client.query("COMMIT");
      return { seeded: false };
    }
    await insertSteps(
      client,
      visitId,
      plan.map((s) => ({ ...s, source: "template" })),
    );
    await client.query(
      `UPDATE giniflow_visits
          SET visit_type_id = COALESCE(visit_type_id, $2),
              planned_total_min = COALESCE(planned_total_min, $3)
        WHERE id = $1`,
      [visitId, visitTypeId, plan.reduce((sum, s) => sum + s.minutes, 0)],
    );
    await syncFromStatus(client, visitId, visit.current_status);
    await insertLabStepsIfHealthrayCase(client, visitId);
    await addSkippedLabLeg(client, visitId);
    await client.query("COMMIT");
    return { seeded: true, visitTypeId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const ABANDONED = ["cancelled", "no_show"];
async function evidencedStatuses(client, visitId, statuses) {
  const { rows } = await client.query(
    `SELECT DISTINCT status FROM giniflow_visit_events
      WHERE visit_id = $1 AND status <> 'exited'`,
    [visitId],
  );
  const stamped = new Set(rows.map((r) => r.status).filter(isChainStatus));
  return statuses.filter((st) => stamped.has(st) || stamped.has(CHAIN[chainIndex(st) + 1]));
}

export async function syncFromStatus(client, visitId, toStatus, meta = null) {
  const counterEnded =
    toStatus === "exited" &&
    (meta?.source === "counter_end_visit" || meta?.reason === "lab_only_reports_complete");
  if (ABANDONED.includes(toStatus)) {
    await client.query(
      `UPDATE giniflow_visit_steps
          SET status = 'skipped'
        WHERE visit_id = $1 AND status IN ('pending', 'in_progress')`,
      [visitId],
    );
    return;
  }
  if (!isChainStatus(toStatus)) return;

  const reached = chainIndex(toStatus);
  const behind = CHAIN.filter((s) => chainIndex(s) < reached);
  if (behind.length) {
    const evidenced = counterEnded ? await evidencedStatuses(client, visitId, behind) : behind;
    if (evidenced.length) {
      await client.query(
        `UPDATE giniflow_visit_steps
            SET status = 'done',
                started_at = COALESCE(started_at, NOW()),
                completed_at = COALESCE(completed_at, NOW())
          WHERE visit_id = $1 AND chain_status = ANY($2::text[])
            AND status IN ('pending', 'in_progress')`,
        [visitId, evidenced],
      );
    }
    const jumped = behind.filter((st) => !evidenced.includes(st));
    if (jumped.length) {
      await client.query(
        `UPDATE giniflow_visit_steps
            SET status = 'skipped'
          WHERE visit_id = $1 AND chain_status = ANY($2::text[])
            AND status IN ('pending', 'in_progress')`,
        [visitId, jumped],
      );
    }
  }
  await client.query(
    `UPDATE giniflow_visit_steps
        SET status = 'in_progress',
            started_at = COALESCE(started_at, NOW()),
            completed_at = NULL
      WHERE id = (
        SELECT id FROM giniflow_visit_steps
         WHERE visit_id = $1 AND chain_status = $2
           -- 'done' as well as 'pending': a consultant who steps out sends the
           -- patient back to a station they had left, and the plan has to be
           -- able to walk backwards with them.
           AND status IN ('pending', 'done')
         ORDER BY step_order LIMIT 1
      )`,
    [visitId, toStatus],
  );
  if (toStatus === "exited") {
    await client.query(
      `UPDATE giniflow_visit_steps
          SET status = 'skipped'
        WHERE visit_id = $1 AND status IN ('pending', 'in_progress')`,
      [visitId],
    );
  }
}

export async function placeTestsBeforeDoctors(client, visitId) {
  const { rows: plan } = await client.query(
    `SELECT s.id, s.step_catalog_id, s.step_order, s.status, s.chain_status,
            COALESCE(c.machine, FALSE) AS machine,
            c.machine_requires_before
       FROM giniflow_visit_steps s
       LEFT JOIN flow_step_catalog c ON c.id = s.step_catalog_id
      WHERE s.visit_id = $1 ORDER BY s.step_order`,
    [visitId],
  );
  const ranked = testsBeforeDoctors(plan, {
    idOf: (s) => s.step_catalog_id,
    chainOf: (s) => s.chain_status,
    statusOf: (s) => s.status,
    machineOf: (s) => s.machine,
  });
  const required = requiredStepsFirst(ranked, {
    idOf: (s) => s.step_catalog_id,
    requiresOf: (s) => s.machine_requires_before,
    statusOf: (s) => s.status,
  });
  const { rows: visit } = await client.query(
    `SELECT echo_referral FROM giniflow_visits WHERE id = $1`,
    [visitId],
  );
  const echoed = visit[0]?.echo_referral
    ? echoFirst(required, await getMachines(client))
    : required;
  const next = echoed.every((s, i) => s === plan[i]) ? plan : echoed;
  if (next === plan) return false;

  await client.query(`SET CONSTRAINTS giniflow_visit_steps_order DEFERRED`);
  await client.query(
    `UPDATE giniflow_visit_steps s SET step_order = x.ord
       FROM unnest($1::uuid[], $2::int[]) AS x(id, ord)
      WHERE s.id = x.id`,
    [next.map((s) => s.id), next.map((_, i) => i + 1)],
  );
  return true;
}

const firstPendingAfterVitals = (plan) =>
  plan.find((s) => s.status === "pending" && s.step_catalog_id !== "vitals") ||
  plan.find((s) => s.status === "pending");

async function insertAutoSteps(
  client,
  visitId,
  wanted,
  placeIn,
  { status = "pending", nameOf = (c) => c.name } = {},
) {
  const { rows: plan } = await client.query(
    `SELECT s.step_catalog_id, s.step_order, s.status, s.chain_status,
            COALESCE(c.machine, FALSE) AS machine
       FROM giniflow_visit_steps s
       LEFT JOIN flow_step_catalog c ON c.id = s.step_catalog_id
      WHERE s.visit_id = $1 ORDER BY s.step_order`,
    [visitId],
  );
  if (!plan.length) return { added: [] };

  const missing = wanted.filter((id) => !plan.some((s) => s.step_catalog_id === id));
  if (!missing.length) {
    await placeTestsBeforeDoctors(client, visitId);
    return { added: [] };
  }

  const { rows: catalog } = await client.query(
    `SELECT id, name, default_duration_min, station, assigned_role, chain_status
       FROM flow_step_catalog WHERE id = ANY($1) AND COALESCE(is_active, TRUE)`,
    [missing],
  );
  const ordered = missing.map((id) => catalog.find((c) => c.id === id)).filter(Boolean);
  if (!ordered.length) return { added: [] };

  const at = placeIn(plan) ?? plan[plan.length - 1].step_order + 1;

  await client.query(`SET CONSTRAINTS giniflow_visit_steps_order DEFERRED`);
  await client.query(
    `UPDATE giniflow_visit_steps SET step_order = step_order + $3
      WHERE visit_id = $1 AND step_order >= $2`,
    [visitId, at, ordered.length],
  );

  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    await client.query(
      `INSERT INTO giniflow_visit_steps
         (visit_id, step_order, step_catalog_id, step_name, planned_duration_min,
          station, assigned_role, chain_status, source, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'auto',$9)`,
      [
        visitId,
        at + i,
        c.id,
        nameOf(c),
        c.default_duration_min,
        c.station,
        c.assigned_role,
        c.chain_status,
        status,
      ],
    );
  }
  if (status === "pending") {
    await client.query(
      `UPDATE giniflow_visits
          SET planned_total_min = COALESCE(planned_total_min, 0) + $2, updated_at = NOW()
        WHERE id = $1`,
      [visitId, ordered.reduce((sum, c) => sum + (c.default_duration_min || 0), 0)],
    );
  }
  await placeTestsBeforeDoctors(client, visitId);
  return { added: ordered.map((c) => c.id) };
}

async function labLegSkipNote(db, visitId) {
  const { rows } = await db.query(`SELECT lab_site FROM giniflow_visits WHERE id = $1`, [visitId]);
  if (rows[0]?.lab_site === "home") return "collected at home";
  if (await sampleTakenBeforeVisit(db, visitId)) return "sample taken earlier";
  const { rows: lab } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM giniflow_lab_orders o
                     WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab'
                       AND o.sample_status <> 'cancelled')
            OR EXISTS (SELECT 1 FROM lab_cases lc
                        WHERE lc.case_date = v.visit_date
                          AND (lc.patient_id = v.patient_id
                               OR (lc.patient_id IS NULL
                                   AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
                          AND ${LIVE_LAB_CASE_SQL("lc")}) AS has_lab
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  return lab[0]?.has_lab ? "sample not collected yet" : "no lab test billed";
}

export async function addSkippedLabLeg(client, visitId) {
  if (!(await isLabOnlyVisit(client, visitId))) return { added: [] };
  return insertAutoSteps(
    client,
    visitId,
    LAB_ONLY_LEG,
    (plan) => {
      const report = plan.find((s) => s.step_catalog_id === "report_upload");
      const checkIn = plan.find((s) => s.step_catalog_id === "check_in");
      return report?.step_order ?? (checkIn ? checkIn.step_order + 1 : null);
    },
    { status: "skipped", nameOf: (c) => labOnlyName({ catalogId: c.id, name: c.name }) },
  );
}

export async function insertLabStepsForOrder(client, visitId) {
  if (await isLabOnlyVisit(client, visitId)) {
    await client.query(
      `UPDATE giniflow_visit_steps SET status = 'pending'
        WHERE visit_id = $1 AND status = 'skipped' AND step_catalog_id = ANY($2::text[])`,
      [visitId, LAB_ONLY_LEG],
    );
  }
  return insertAutoSteps(client, visitId, ["lab_billing", "blood_sample"], (plan) => {
    const pendingSample = plan.find(
      (s) => s.step_catalog_id === "blood_sample" && s.status === "pending",
    );
    return (pendingSample || firstPendingAfterVitals(plan))?.step_order;
  });
}

export async function insertMachineStepsForOrders(client, visitId, machineIds) {
  const { rows } = await client.query(`SELECT echo_referral FROM giniflow_visits WHERE id = $1`, [
    visitId,
  ]);
  const echoReferral = Boolean(rows[0]?.echo_referral);
  return insertAutoSteps(client, visitId, machineIds, (plan) => {
    if (echoReferral) return plan.find((s) => s.status === "pending")?.step_order;
    const lastTest = plan.findLast((s) => isTestStep(s.step_catalog_id, s.machine));
    return lastTest ? lastTest.step_order + 1 : firstPendingAfterVitals(plan)?.step_order;
  });
}

const AFTER_COORDINATOR = ["rx_pending", "with_rx", "pharmacy_pending", "dispensed"];

export async function insertCoordinatorStep(client, visitId) {
  return insertAutoSteps(
    client,
    visitId,
    ["care_coordinator"],
    (plan) =>
      plan.find((s) => s.status !== "done" && AFTER_COORDINATOR.includes(s.chain_status))
        ?.step_order,
  );
}

export async function closeCoordinatorStep(client, visitId, status) {
  await client.query(
    `UPDATE giniflow_visit_steps
        SET status = $2,
            started_at = COALESCE(started_at, NOW()),
            completed_at = CASE WHEN $2 = 'done' THEN NOW() ELSE completed_at END
      WHERE visit_id = $1 AND step_catalog_id = 'care_coordinator'
        AND status IN ('pending', 'in_progress')`,
    [visitId, status],
  );
}

const isEchoStep = (step, machines) =>
  machineFor(machines, step.catalogId ?? step.step_catalog_id)?.station === "echo";

export const echoFirst = (steps, machines) => {
  const echo = steps.filter((step) => isEchoStep(step, machines));
  return echo.length ? [...echo, ...steps.filter((step) => !echo.includes(step))] : steps;
};

export async function addLabStepsForArrivedLabCase(
  patientId,
  caseDate,
  db = pool,
  { caseNo = null, testNames = [] } = {},
) {
  if (!patientId || !caseDate) return { added: [] };
  const { rows } = await db.query(
    `SELECT id FROM giniflow_visits
      WHERE patient_id = $1 AND visit_date = $2::date
        AND current_status <> ALL($3::text[])
      ORDER BY created_at DESC LIMIT 1`,
    [
      patientId,
      caseDate,
      ["booked", "confirmed", "no_show", "cancelled", "abandoned", "dispensed", "exited"],
    ],
  );
  if (!rows.length) return reopenForArrivedLabCase(patientId, caseDate, db, caseNo, testNames);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [rows[0].id]);
    const result =
      (await billHasNoLab(client, rows[0].id)) || (await sampleTakenBeforeVisit(client, rows[0].id))
        ? { added: [] }
        : await insertLabStepsForOrder(client, rows[0].id);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function reopenForArrivedLabCase(patientId, caseDate, db, caseNo, testNames) {
  if (!caseNo) return { added: [] };
  const { rows } = await db.query(
    `SELECT v.id FROM giniflow_visits v
      WHERE v.patient_id = $1 AND v.visit_date = $2::date
        AND v.current_status = ANY($3::text[])
        AND v.merged_into_visit_id IS NULL
        AND EXISTS (SELECT 1 FROM lab_cases lc
                     WHERE lc.case_no = $4 AND ${LIVE_LAB_CASE_SQL("lc")}
                       AND COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' IS NULL)
      ORDER BY v.created_at DESC LIMIT 1`,
    [patientId, caseDate, [...TERMINAL_STATUSES, BACK_FOR_TESTS], caseNo],
  );
  if (!rows.length) return { added: [] };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await reopenForTests(client, rows[0].id, {
      trigger: "healthray_case",
      tests: testNames,
      stepIds: LAB_TEST_STEP_IDS,
    });
    await client.query("COMMIT");
    return { added: result.steps, reopened: result.reopened };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function billHasNoLab(client, visitId) {
  const { rows } = await client.query(
    `SELECT patient_id, visit_date::text AS visit_date FROM giniflow_visits WHERE id = $1`,
    [visitId],
  );
  if (!rows.length) return false;
  const bill = await storedBill(rows[0].patient_id, rows[0].visit_date, client);
  if (bill?.status !== "billed") return false;
  const skip = await billSuppressor(client, visitId);
  return billedLabLines(bill, { skip }).length === 0;
}

export async function insertLabStepsIfHealthrayCase(client, visitId) {
  const { rows } = await client.query(
    `SELECT ${HR_LAB_EVIDENCE_SQL}
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (
    !(rows[0]?.hr_cases > 0) ||
    (await sampleTakenBeforeVisit(client, visitId)) ||
    (await billHasNoLab(client, visitId))
  ) {
    return { added: [] };
  }
  return insertLabStepsForOrder(client, visitId);
}

export async function syncLabStepsFromLab(db, visitId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM giniflow_lab_orders o
         WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab') AS orders,
       (SELECT count(*)::int FROM giniflow_lab_orders o
         WHERE o.visit_id = v.id AND o.urgency = 'today'
           AND o.sample_status <> 'cancelled') AS test_orders,
       (SELECT count(*)::int FROM giniflow_lab_orders o
         WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.sample_status <> 'cancelled'
           AND o.payment_status NOT IN ('paid', 'claim_approved')) AS unsettled,
       (SELECT count(*)::int FROM giniflow_lab_orders o
         WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab'
           AND o.sample_status IN (${DRAWN_STATUS_SQL}))
         AS drawn,
       (SELECT count(*)::int FROM giniflow_lab_orders o
         WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab'
           AND o.sample_status IN (${REPORTED_STATUS_SQL}))
         AS reported,
       (SELECT count(*)::int FROM giniflow_lab_orders o
         WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab'
           AND o.sample_status IN (${RESULTS_STATUS_SQL}))
         AS results,
       EXISTS (SELECT 1 FROM giniflow_visit_events ce
                WHERE ce.visit_id = v.id AND ce.status = 'checked_in') AS checked_in,
       ${HR_LAB_EVIDENCE_SQL}
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  const e = rows[0];
  if (!e) return { billed: false, drawn: false };

  const drawn = e.orders > 0 ? e.drawn === e.orders : !!e.hr_collected;
  const billed = e.test_orders > 0 && e.unsettled === 0;
  const reported = e.orders > 0 ? e.reported === e.orders : !!e.hr_reported;
  const results = e.orders > 0 ? e.results === e.orders : !!e.hr_results;

  const tick = async (catalogId) =>
    db.query(
      `UPDATE giniflow_visit_steps
          SET status = 'done',
              started_at = COALESCE(started_at, NOW()),
              completed_at = COALESCE(completed_at, NOW())
        WHERE visit_id = $1 AND step_catalog_id = $2
          AND status IN ('pending', 'in_progress', 'skipped')
          AND NOT ($2 = ANY($3::text[]) AND ${LAB_BILLING_OPEN_SQL("$1")})`,
      [visitId, catalogId, AFTER_LAB_BILLING],
    );
  const reopen = async (catalogId) =>
    db.query(
      `UPDATE giniflow_visit_steps
          SET status = 'pending', completed_at = NULL
        WHERE visit_id = $1 AND step_catalog_id = $2 AND status = 'done'`,
      [visitId, catalogId],
    );
  if (billed) await tick("lab_billing");
  else if (e.test_orders > 0) await reopen("lab_billing");
  if (drawn) await tick("blood_sample");
  else if (e.orders > 0) await reopen("blood_sample");
  if (results) await tick("lab_processing_2");
  else if (e.orders > 0) await reopen("lab_processing_2");
  if (reported) await tick("report_upload");
  else if (e.orders > 0) await reopen("report_upload");
  if (e.checked_in || drawn) await tick("check_in");
  await syncMachineSteps(db, visitId);
  return { billed, drawn };
}

const MACHINE_STEP_FOR_STAGE = { in_progress: "in_progress", done: "done", reported: "done" };

export async function syncMachineSteps(db, visitId) {
  const { rows } = await db.query(
    `SELECT o.sample_status, array_agg(t.test_name) AS names
       FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND o.kind = 'machine'
      GROUP BY o.id, o.sample_status`,
    [visitId],
  );
  const moved = rows
    .map((row) => ({
      ...row,
      step: MACHINE_STEP_FOR_STAGE[MACHINE_STATUS_TO_STAGE[row.sample_status]],
    }))
    .filter((row) => row.step);
  if (!moved.length) return;
  const machines = await getMachines(db);
  for (const row of moved) {
    const machine = row.names.map((name) => machineForTest(machines, name)).find(Boolean);
    if (!machine) continue;
    await db.query(
      `UPDATE giniflow_visit_steps
          SET status = $3,
              started_at = COALESCE(started_at, NOW()),
              completed_at = CASE WHEN $3 = 'done' THEN COALESCE(completed_at, NOW())
                                  ELSE completed_at END
        WHERE visit_id = $1 AND step_catalog_id = $2
          AND status = ANY($4::text[])
          AND NOT ${LAB_BILLING_OPEN_SQL("$1")}`,
      [
        visitId,
        machine.id,
        row.step,
        row.step === "done" ? ["pending", "in_progress", "skipped"] : ["pending", "skipped"],
      ],
    );
  }
}

export async function tickBillingIfConsultPaid(db, billId, visitId) {
  if (!visitId) return false;
  const { rowCount } = await db.query(
    `UPDATE giniflow_visit_steps
        SET status = 'done',
            started_at = COALESCE(started_at, NOW()),
            completed_at = COALESCE(completed_at, NOW())
      WHERE visit_id = $1 AND step_catalog_id = 'billing'
        AND status IN ('pending', 'in_progress', 'skipped')
        AND EXISTS (
          SELECT 1 FROM bill_lines l
            JOIN service_items i ON i.id = l.service_item_id
           WHERE l.bill_id = $2 AND l.is_live AND i.kind = 'consultation')`,
    [visitId, billId],
  );
  return rowCount > 0;
}

// ── Editing a journey that is already on the floor ─────────────────────────

export async function setStepStatus(stepId, status, db = pool) {
  if (!["pending", "in_progress", "done", "skipped"].includes(status)) {
    throw Object.assign(new Error("Unknown step status"), { status: 400 });
  }

  if (status === "done") {
    const { rows: unpaid } = await db.query(
      `SELECT 1
         FROM giniflow_visit_steps s
         LEFT JOIN flow_step_catalog c ON c.id = s.step_catalog_id
        WHERE s.id = $1
          AND (s.step_catalog_id = ANY($2::text[]) OR COALESCE(c.machine, FALSE))
          AND ${LAB_BILLING_OPEN_SQL("s.visit_id")}`,
      [stepId, AFTER_LAB_BILLING],
    );
    if (unpaid.length) {
      throw Object.assign(
        new Error("Lab Billing comes first — clear the test payment on the Payments tab"),
        { status: 409 },
      );
    }
    const { rows: earlier } = await db.query(
      `SELECT prev.step_name
         FROM giniflow_visit_steps s
         JOIN giniflow_visit_steps prev
           ON prev.visit_id = s.visit_id AND prev.step_order < s.step_order
        WHERE s.id = $1 AND prev.status NOT IN ('done', 'skipped')
          -- Only what the TEMPLATE laid out is a sequence. A stop the desk added
          -- during the visit is appended to the end of the list but happened
          -- now, and holding it until the pharmacy had been done would make it
          -- untickable for the whole visit.
          AND s.source IN ('template', 'auto')
          AND s.step_catalog_id <> 'lab_billing'
        ORDER BY prev.step_order LIMIT 1`,
      [stepId],
    );
    if (earlier.length) {
      throw Object.assign(
        new Error(`${earlier[0].step_name} comes first — this stop is not due yet`),
        { status: 409 },
      );
    }
  }

  const { rows } = await db.query(
    `UPDATE giniflow_visit_steps
        SET status = $2,
            started_at = CASE
              WHEN $2 IN ('in_progress', 'done') THEN COALESCE(started_at, NOW())
              ELSE started_at END,
            completed_at = CASE WHEN $2 = 'done' THEN NOW() ELSE NULL END
      WHERE id = $1 RETURNING visit_id, step_catalog_id`,
    [stepId, status],
  );
  if (!rows.length) throw Object.assign(new Error("Step not found"), { status: 404 });
  if (status === "done" && rows[0].step_catalog_id === "lab_billing") {
    await syncLabStepsFromLab(db, rows[0].visit_id);
  }
  return getJourney(rows[0].visit_id, db);
}

export async function addStep(visitId, step, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // The visit is the lock for its own journey: two people adding a stop at the
    // same moment would otherwise both take MAX+1 and one would fail.
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [visitId]);
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(step_order), 0) AS last FROM giniflow_visit_steps WHERE visit_id = $1`,
      [visitId],
    );
    await client.query(
      `INSERT INTO giniflow_visit_steps
         (visit_id, step_order, step_catalog_id, step_name, planned_duration_min,
          station, assigned_role, assigned_staff_id, assigned_staff_name, chain_status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               (SELECT chain_status FROM flow_step_catalog WHERE id = $3), $10)`,
      [
        visitId,
        rows[0].last + 1,
        step.catalogId || null,
        trimmed(step.name) || "Step",
        clampMinutes(step.minutes),
        trimmed(step.station) || null,
        trimmed(step.role, 60) || null,
        step.staffId ? String(step.staffId).slice(0, 40) : null,
        trimmed(step.staffName) || null,
        step.catalogId ? "added" : "custom",
      ],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getJourney(visitId, db);
}

export async function removeStep(stepId, db = pool) {
  const { rows } = await db.query(
    `DELETE FROM giniflow_visit_steps WHERE id = $1 RETURNING visit_id`,
    [stepId],
  );
  if (!rows.length) throw Object.assign(new Error("Step not found"), { status: 404 });
  return getJourney(rows[0].visit_id, db);
}
export async function reorderSteps(visitId, stepIds, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [visitId]);
    const { rows } = await client.query(
      `SELECT count(*)::int AS c FROM giniflow_visit_steps WHERE visit_id = $1`,
      [visitId],
    );
    if (rows[0].c !== stepIds.length) {
      throw Object.assign(
        new Error("This journey changed while you were reordering it — reopen it and try again"),
        { status: 409 },
      );
    }
    await client.query(`SET CONSTRAINTS giniflow_visit_steps_order DEFERRED`);
    for (let i = 0; i < stepIds.length; i++) {
      await client.query(
        `UPDATE giniflow_visit_steps SET step_order = $3 WHERE id = $1 AND visit_id = $2`,
        [stepIds[i], visitId, i + 1],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return getJourney(visitId, db);
}

export async function trackByToken(token, db = pool) {
  const { rows } = await db.query(
    `SELECT v.id, v.current_status, v.planned_total_min, v.paused_at, p.name,
            checkin.occurred_at AS checked_in_at
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events e
          WHERE e.visit_id = v.id AND ${JOURNEY_START_SQL("e.status")}
          ORDER BY occurred_at DESC LIMIT 1
       ) checkin ON TRUE
      WHERE v.visit_token = $1`,
    [token],
  );
  const visit = rows[0];
  if (!visit) return null;

  const { steps, doneCount, totalCount, currentStep } = await getJourney(visit.id, db);
  const planned = visit.planned_total_min || 0;
  const now = visit.paused_at ? new Date(visit.paused_at).getTime() : Date.now();
  const elapsed = visit.checked_in_at
    ? Math.max(0, Math.round((now - new Date(visit.checked_in_at).getTime()) / 60000))
    : 0;
  return {
    first_name: (visit.name || "").split(" ")[0],
    status: visit.current_status,
    current_step: currentStep,
    step_index: currentStep ? doneCount + 1 : doneCount,
    total_steps: totalCount,
    remaining_min:
      isTerminalStatus(visit.current_status) || ABANDONED.includes(visit.current_status)
        ? 0
        : Math.max(0, planned - elapsed),
    timeline: steps.map((s) => ({ name: s.name, status: s.status })),
  };
}
