import { CANCELLABLE_ORDER_STATUSES } from "../../../shared/testCancelReasons.js";
import pool from "../../config/db.js";
import { linesForOrder } from "../billing/visitLines.js";
import { testPriceForVisit } from "../pricing.js";
import { LIVE_LAB_CASE_SQL } from "./testsHold.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { opensLabGate, outstandingOf } from "../../../shared/labPayment.js";
import {
  BACK_FOR_TESTS,
  isTerminalStatus,
  STATUS_LABEL,
  BOARD_COLUMNS,
  columnForStatus,
  ROOM_SOURCE_SQL,
  machineColumnFor,
} from "../../../shared/giniflowStatus.js";
import {
  MACHINE_RUNGS,
  MACHINE_STAGES,
  MACHINE_SAMPLE_FLOW,
  MACHINE_STATUS_TO_STAGE,
  MACHINE_FILTER_TO_STAGE,
  MACHINE_RAIL,
  machineStageIndexOf,
  machineRungFor,
  machineForTest,
  machineFor,
  machineHandsOver,
  nextMachineStep,
  waitMinutesFor,
  machineIdForDocType,
  machineDocTypes,
  machinesForStation,
} from "../../../shared/machineStages.js";
import { getMachines } from "./machineCatalog.js";
import { VITALS_TAKEN_SQL } from "./visitVitals.js";
import { resumeVisitTx, reopenResultsForNewOrder } from "./statusEngine.js";
import { UNDRAWN_SAMPLE_STATUSES } from "../../../shared/labStages.js";
import {
  machineShowsHealthrayReports,
  labStepsAreManual,
  bloodBeforeMachine,
} from "../../../shared/manualFloor.js";
import {
  assertStationFree,
  busyStations,
  busyElsewhere,
  busyReason,
  revertStart,
} from "./stationLock.js";
import { publish } from "./eventHub.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import { hasExtraReports } from "./extraReports.js";
import { reopenForTests } from "./lateTests.js";
import { assertNotHeld, HELD_ORDER_SQL } from "./cancelHold.js";
import { orderCancelStage } from "../../../shared/testCancelStages.js";

const UNDRAWN_LAB = UNDRAWN_SAMPLE_STATUSES.map((v) => `'${v}'`).join(", ");

const BLOOD_NOT_DRAWN_SQL = (manualParam) => `
            (
              EXISTS (
                SELECT 1 FROM giniflow_lab_orders lo
                 WHERE lo.visit_id = v.id AND lo.urgency = 'today' AND lo.kind = 'lab'
                   AND lo.sample_status IN (${UNDRAWN_LAB})
              )
              OR EXISTS (
                SELECT 1 FROM lab_cases lc
                 WHERE lc.case_date = v.visit_date
                   AND (lc.patient_id = v.patient_id
                        OR (lc.patient_id IS NULL
                            AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
                   AND NOT EXISTS (
                     SELECT 1 FROM giniflow_lab_orders lo
                      WHERE lo.visit_id = v.id AND lo.urgency = 'today' AND lo.kind = 'lab'
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM giniflow_lab_case_actions a
                      WHERE a.case_no = lc.case_no
                        AND a.action IN ('sample_taken', 'report_uploaded')
                   )
                   AND ${LIVE_LAB_CASE_SQL("lc")}
                   AND (${manualParam}
                        OR (lc.raw_list_json->>'phlebotomy_status' IS DISTINCT FROM 'Completed'
                            AND COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'collected_on' IS NULL))
              ))`;

const COLUMN_NAME = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, c.name]));

const IN_A_ROOM = ["with_vitals", "with_sd", "with_doctor"];
const FINISHED = ["dispensed", "exited", "no_show", "cancelled"];
const NEVER_CAME = ["no_show", "cancelled"];

const stageOf = (sampleStatus) => MACHINE_STATUS_TO_STAGE[sampleStatus] || "ordered";

const whereTheyAre = (status) => {
  if (!status) return "";
  if (FINISHED.includes(status)) return STATUS_LABEL[status] || humanise(status);
  return COLUMN_NAME[columnForStatus(status)] || STATUS_LABEL[status] || humanise(status);
};

const humanise = (key) =>
  String(key)
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());

const railFor = (stageKey) => {
  const reached = machineRungFor(stageKey)?.rail ?? 1;
  return MACHINE_RAIL.map((name, i) => ({
    name,
    state: i < reached ? "done" : i === reached ? "now" : "next",
  }));
};
const machineOf = (machines, tests) => {
  for (const t of tests || []) {
    const m = machineForTest(machines, t.name ?? t);
    if (m) return m.id;
  }
  return null;
};
const assertMachineInStation = (catalogue, machineId, station) => {
  if (!station) return;
  if (!machineId) {
    if (station === "machine_room") return;
  } else if (machinesForStation(catalogue, station).some((m) => m.id === machineId)) {
    return;
  }
  throw Object.assign(new Error("That test does not belong to this station"), { status: 403 });
};
async function assertPatientIsFree(db, visitId, what) {
  if (!visitId) return;
  const { rows } = await db.query(
    `SELECT v.current_status, p.name,
            ${ROOM_SOURCE_SQL("v")} AS room_source
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) return;
  const { current_status: status, name, room_source: roomSource } = rows[0];
  if (IN_A_ROOM.includes(status) && roomSource !== "healthray") {
    throw Object.assign(
      new Error(
        `${name} is with another station right now (${STATUS_LABEL[status] || status}) — ${what} once they are free`,
      ),
      { status: 409 },
    );
  }
  if (NEVER_CAME.includes(status)) {
    throw Object.assign(
      new Error(`${name} has left the floor — ${what} is no longer possible today`),
      { status: 409 },
    );
  }
}

async function assertMachineFree(db, machineId, visitDate, exceptOrderId = null) {
  if (!machineId) return;
  const { rows } = await db.query(
    `SELECT o.id, p.name, COALESCE(t.names, ARRAY[]::text[]) AS names
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN LATERAL (
         SELECT array_agg(lt.test_name) AS names
           FROM giniflow_lab_order_tests lt WHERE lt.lab_order_id = o.id
       ) t ON TRUE
      WHERE o.kind = 'machine'
        AND o.sample_status = 'in_progress'
        AND v.visit_date = $1::date
        AND ($2::uuid IS NULL OR o.id <> $2::uuid)`,
    [visitDate, exceptOrderId],
  );

  const machines = await getMachines(db);
  const busy = rows.find(
    (r) =>
      machineOf(
        machines,
        r.names.map((n) => ({ name: n })),
      ) === machineId,
  );
  if (busy) {
    const label = machineFor(machines, machineId)?.name || machineId;
    throw Object.assign(new Error(`The ${label} is busy — ${busy.name} is on it right now`), {
      status: 409,
    });
  }
}
async function assertReadyToStart(db, visitId, catalogue, machineId) {
  if (!visitId) return;
  const machine = machineFor(catalogue, machineId);
  const machineName = machine?.name || "machine";
  const { rows } = await db.query(
    `SELECT p.name,
            ${VITALS_TAKEN_SQL("v")} AS vitals_recorded,
            ${labOnlyPredicate("v", "$2")} AS lab_only,
            ${BLOOD_NOT_DRAWN_SQL("$3")} AS blood_not_drawn,
            v.echo_referral
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId, LAB_ONLY_DOCTOR, labStepsAreManual()],
  );
  if (!rows.length) return;
  const { name, vitals_recorded, lab_only, blood_not_drawn, echo_referral: echoReferral } = rows[0];
  const echoFirst = echoReferral && machine?.station === "echo";
  if (!lab_only && !echoFirst && !vitals_recorded) {
    throw Object.assign(
      new Error(
        `${name} has no vitals recorded yet — the patient goes to vitals before the ${machineName}`,
      ),
      { status: 409 },
    );
  }
  if (bloodBeforeMachine() && blood_not_drawn) {
    throw Object.assign(
      new Error(
        `${name} is billed for blood as well — Lab 1 draws the sample before the ${machineName}`,
      ),
      { status: 409 },
    );
  }
  if (machine?.requiresBefore) {
    const blocker = machineFor(catalogue, machine.requiresBefore);
    if (blocker) {
      const { rows: openRows } = await db.query(
        `SELECT array_agg(t.test_name) AS names
           FROM giniflow_lab_orders o
           JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
          WHERE o.visit_id = $1 AND o.kind = 'machine' AND o.urgency = 'today'
            AND o.sample_status <> 'reported'`,
        [visitId],
      );
      const stillOpen = (openRows[0]?.names || []).some(
        (n) => machineForTest(catalogue, n)?.id === blocker.id,
      );
      if (stillOpen) {
        throw Object.assign(
          new Error(`${name}'s ${blocker.name} must be done before the ${machineName}`),
          { status: 409 },
        );
      }
    }
  }
}

async function loadDayMachineOrders(visitDate, search, db) {
  const catalogue = await getMachines(db);
  const { rows } = await db.query(
    `SELECT o.id, o.visit_id, o.sample_status, o.payment_status, o.urgency,
            o.amount_total, o.amount_paid, o.amount_claimed, o.claim_state,
            o.created_at, o.updated_at, o.uploaded_at, o.report_file_url,
            p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
            v.current_status,
            ${ROOM_SOURCE_SQL("v")} AS room_source,
            d.short_name AS ordered_by,
            COALESCE(t.tests, '[]'::json) AS tests,
            last_ev.occurred_at AS since,
            (SELECT doc.id FROM documents doc WHERE doc.giniflow_lab_order_id = o.id)
              AS report_doc_id,
            COALESCE(
              (SELECT json_agg(
                        json_build_object('docId', doc.id, 'fileName', doc.file_name,
                                          'uploadedAt', doc.created_at)
                        ORDER BY doc.created_at)
                 FROM documents doc WHERE doc.giniflow_extra_report_of = o.id),
              '[]'::json
            ) AS extra_reports,
            EXISTS (SELECT 1 FROM lab_results lr WHERE lr.lab_order_id = o.id) AS has_values,
            ${HELD_ORDER_SQL("o")} AS cancel_held,
            -- The two sequencing gates (39-HYBRID-FLOOR-PLAN.md §3). Asked of the
            -- table, not of the screen: a technician with a stale tab must be
            -- refused by the service, not merely shown no button.
            ${VITALS_TAKEN_SQL("v")} AS vitals_recorded,
            ${labOnlyPredicate("v", "$3")} AS lab_only,
            ${BLOOD_NOT_DRAWN_SQL("$4")} AS blood_not_drawn
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN doctors d ON d.id = o.ordered_by
       LEFT JOIN LATERAL (
         SELECT json_agg(
                  json_build_object('name', lt.test_name, 'price', lt.price)
                  ORDER BY lt.test_name) AS tests
           FROM giniflow_lab_order_tests lt WHERE lt.lab_order_id = o.id
       ) t ON TRUE
       LEFT JOIN LATERAL (
         SELECT occurred_at FROM giniflow_lab_order_events e
          WHERE e.lab_order_id = o.id AND e.track = 'sample'
          ORDER BY occurred_at DESC LIMIT 1
       ) last_ev ON TRUE
      WHERE v.visit_date = $1::date
        AND o.kind = 'machine'
        AND NOT COALESCE(p.is_blocked, FALSE)
        AND o.urgency = 'today'
        AND v.current_status NOT IN ('no_show', 'cancelled')
        AND (
          $2::text IS NULL
          OR p.name ILIKE '%' || $2 || '%'
          OR p.file_no ILIKE '%' || $2 || '%'
          OR d.short_name ILIKE '%' || $2 || '%'
          OR EXISTS (
            SELECT 1 FROM giniflow_lab_order_tests lt2
             WHERE lt2.lab_order_id = o.id AND lt2.test_name ILIKE '%' || $2 || '%'
          )
        )
      ORDER BY o.created_at`,
    [visitDate, search, LAB_ONLY_DOCTOR, labStepsAreManual()],
  );

  const busy = await busyStations(
    db,
    rows.map((r) => r.visit_id),
  );

  const all = rows.map((r) => {
    const paid = opensLabGate(r.payment_status);
    const stage = stageOf(r.sample_status);
    const machineId = machineOf(catalogue, r.tests);
    const next = nextMachineStep(stage);
    const finished = NEVER_CAME.includes(r.current_status);
    const inARoom = IN_A_ROOM.includes(r.current_status) && r.room_source !== "healthray";
    const free = !inARoom && !finished;
    const hasEvidence = !!r.report_doc_id || !!r.has_values || !!r.report_file_url;
    const starting = next?.advanceTo === "in_progress";
    const needsVitals = starting && !r.lab_only && !r.vitals_recorded;
    const needsBloodFirst = starting && bloodBeforeMachine() && r.blood_not_drawn;
    const ownStation = machineFor(catalogue, machineId)?.station || "machine_room";
    const elsewhere = starting ? busyElsewhere(busy, r.visit_id, ownStation) : null;
    const blockedReason = !paid
      ? r.payment_status === "insurance_claim"
        ? `Insurance claim submitted — waiting for approval (₹${outstandingOf(r)} outstanding)`
        : `Waiting for reception to clear payment — ₹${outstandingOf(r)} outstanding`
      : needsVitals
        ? "Vitals not recorded yet — the patient goes to vitals first"
        : needsBloodFirst
          ? "Blood not drawn yet — Lab 1 collects before the machine"
          : elsewhere
            ? busyReason(elsewhere)
            : next?.needsPatient && !free
              ? finished
                ? "Patient has left the floor"
                : `In the ${(COLUMN_NAME[columnForStatus(r.current_status)] || "").toLowerCase()} room — call once free`
              : (next?.key === "done" || next?.key === "reported") &&
                  !hasEvidence &&
                  !machineHandsOver(catalogue, machineId)
                ? "Type the values in or attach the report to finish this test"
                : null;

    return {
      orderId: r.id,
      visitId: r.visit_id,
      patientId: r.patient_id,
      name: r.name || "Patient not matched yet",
      fileNo: r.file_no,
      age: r.age,
      sex: r.sex,
      orderedBy: r.ordered_by,
      machine: machineId,
      tests: (r.tests || []).map((t) => t.name),
      amountTotal: Number(r.amount_total) || 0,
      amountPaid: Number(r.amount_paid) || 0,
      paymentStatus: r.payment_status,
      sampleStatus: r.sample_status,
      paid,
      stage,
      stageLabel: machineRungFor(stage)?.stageLabel,
      steps: railFor(stage),
      nextAction: next && !blockedReason ? { to: next.advanceTo, label: next.advanceLabel } : null,
      blockedReason,
      heldElsewhere: paid && !needsVitals && !needsBloodFirst && !!elsewhere,
      hasReport: !!r.report_doc_id || !!r.report_file_url,
      hasValues: !!r.has_values,
      canMarkDone: hasEvidence,
      canCancel:
        CANCELLABLE_ORDER_STATUSES.includes(r.sample_status) &&
        !r.report_doc_id &&
        !r.report_file_url &&
        !r.has_values,
      cancelStage: orderCancelStage({
        kind: "machine",
        sampleStatus: r.sample_status,
        hasOutput: !!r.report_doc_id || !!r.report_file_url || !!r.has_values,
      }),
      cancelHeld: !!r.cancel_held,
      reportDocId: r.report_doc_id || null,
      reportUrl: r.report_file_url || null,
      extraReports: r.extra_reports || [],
      orderedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      since: new Date(r.since || r.updated_at || r.created_at).toISOString(),
      uploadedAt: r.uploaded_at ? new Date(r.uploaded_at).toISOString() : null,
      finished,
      inARoom,
      collectable: free,
      station: whereTheyAre(r.current_status),
    };
  });

  const openMachinesByVisit = new Map();
  for (const o of all) {
    if (o.stage !== "reported" && o.machine) {
      if (!openMachinesByVisit.has(o.visitId)) openMachinesByVisit.set(o.visitId, new Set());
      openMachinesByVisit.get(o.visitId).add(o.machine);
    }
  }
  for (const o of all) {
    if (o.stage !== "ordered" || !o.machine) continue;
    const requiresBefore = machineFor(catalogue, o.machine)?.requiresBefore;
    if (!requiresBefore) continue;
    if (openMachinesByVisit.get(o.visitId)?.has(requiresBefore)) {
      const blocker = machineFor(catalogue, requiresBefore);
      o.blockedReason =
        o.blockedReason || `${blocker?.name || requiresBefore} must be done before this test`;
      o.nextAction = null;
    }
  }

  return { catalogue, all };
}

const ordersForStation = (all, stationIds, station) =>
  all.filter((o) => {
    if (!station) return true;
    if (!o.machine) return station === "machine_room";
    return stationIds.has(o.machine);
  });

const stageCounts = (orders) =>
  Object.fromEntries(
    MACHINE_RUNGS.map((r) => [r.filter, orders.filter((o) => o.stage === r.key).length]),
  );

const stationIdsOf = (catalogue, station) =>
  new Set((station ? machinesForStation(catalogue, station) : catalogue).map((m) => m.id));

export async function getMachineCountsByStation(visitDate, stations, db = pool) {
  const { catalogue, all } = await loadDayMachineOrders(visitDate, null, db);
  return Object.fromEntries(
    stations.map((station) => [
      station,
      stageCounts(ordersForStation(all, stationIdsOf(catalogue, station), station)),
    ]),
  );
}

export async function getMachineQueue(
  visitDate,
  q = null,
  db = pool,
  { machine = null, group = "all", station = null } = {},
) {
  const search = q && String(q).trim().length >= 2 ? String(q).trim() : null;
  const { catalogue, all: dayOrders } = await loadDayMachineOrders(visitDate, search, db);
  const stationMachines = station ? machinesForStation(catalogue, station) : catalogue;
  const stationIds = new Set(stationMachines.map((m) => m.id));
  const all = ordersForStation(dayOrders, stationIds, station);

  const busyBy = new Map();
  for (const o of all) {
    if (o.stage === "in_progress" && o.machine) busyBy.set(o.machine, o.name);
  }
  for (const o of all) {
    if (o.stage !== "ordered" || !o.machine || !busyBy.has(o.machine)) continue;
    const label = machineFor(catalogue, o.machine)?.name || o.machine;
    o.blockedReason = o.blockedReason || `The ${label} is busy — ${busyBy.get(o.machine)} is on it`;
    o.nextAction = null;
  }

  const wantedMachine = stationMachines.some((m) => m.id === machine) ? machine : null;
  const wantedGroup = MACHINE_FILTER_TO_STAGE[group] ? group : "all";

  const counts = stageCounts(all);

  const machines = stationMachines.map((m) => {
    const mine = all.filter((o) => o.machine === m.id);
    const onIt = mine.find((o) => o.stage === "in_progress") || null;
    const waiting = mine.filter((o) => o.stage === "ordered");
    return {
      ...m,
      total: mine.length,
      waiting: waiting.length,
      onIt: onIt ? { name: onIt.name, since: onIt.since, orderId: onIt.orderId } : null,
      waitMinutes: waitMinutesFor(catalogue, m.id, waiting.length) + (onIt ? m.durationMin : 0),
      byStage: Object.fromEntries(
        MACHINE_RUNGS.map((r) => [r.key, mine.filter((o) => o.stage === r.key).length]),
      ),
    };
  });

  const unassigned = all.filter((o) => !o.machine);
  const rowsFor = (stageKey) =>
    all.filter(
      (o) =>
        o.stage === stageKey &&
        o.machine &&
        (!wantedMachine || o.machine === wantedMachine) &&
        (wantedGroup === "all" || MACHINE_FILTER_TO_STAGE[wantedGroup] === o.stage),
    );

  return {
    machine: wantedMachine,
    group: wantedGroup,
    counts,
    machines,
    stages: MACHINE_STAGES,
    ...Object.fromEntries(MACHINE_RUNGS.map((r) => [r.bucket, rowsFor(r.key)])),
    unassigned: wantedMachine ? [] : unassigned,
    total: all.length,
  };
}
export async function addMachineTestOn(
  client,
  visitId,
  { machineId, actorId = null, station = null } = {},
) {
  const catalogue = await getMachines(client);
  const machine = machineFor(catalogue, machineId);
  if (!machine) throw Object.assign(new Error(`Unknown machine: ${machineId}`), { status: 400 });
  assertMachineInStation(catalogue, machineId, station);

  const { rows: visit } = await client.query(
    `SELECT v.id, v.visit_date, v.current_status, p.name
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!visit.length) throw Object.assign(new Error("No such visit"), { status: 404 });
  const closed = isTerminalStatus(visit[0].current_status);
  if (FINISHED.includes(visit[0].current_status) && !closed) {
    throw Object.assign(
      new Error(`${visit[0].name} did not come in today — the test cannot be added`),
      { status: 409 },
    );
  }

  const { rows: existing } = await client.query(
    `SELECT o.id, o.sample_status
       FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND o.kind = 'machine' AND t.test_name = ANY($2::text[])
        AND o.sample_status <> 'reported'`,
    [visitId, machine.tests],
  );
  if (existing.length) {
    return { orderId: existing[0].id, machine: machine.id, alreadyThere: true };
  }

  const found = await testPriceForVisit(visitId, machine.tests[0], client);
  const price = Number(found ?? 0);
  if (found === null || !(price > 0)) {
    throw Object.assign(
      new Error(
        `${machine.name} has no price in the test catalogue — an admin must add it under Settings → Flow → Test catalogue before it can be billed`,
      ),
      { status: 409 },
    );
  }

  const { rows: order } = await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, ordered_by, urgency, payment_status, amount_total,
        sample_status, kind)
     VALUES ($1, $2, 'today', 'pending', $3, 'payment_pending', 'machine')
     RETURNING id`,
    [visitId, actorId, price],
  );
  const orderId = order[0].id;
  await reopenResultsForNewOrder(client, visitId);
  await client.query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
     VALUES ($1, $2, $3)`,
    [orderId, machine.tests[0], price],
  );
  await client.query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
     VALUES ($1, 'payment', 'pending', 'machine', $2)`,
    [orderId, actorId],
  );

  await linesForOrder(
    visitId,
    { labOrderId: orderId, testNames: [machine.tests[0]] },
    { actorId },
    client,
  );

  const late =
    closed || visit[0].current_status === BACK_FOR_TESTS
      ? await reopenForTests(client, visitId, {
          trigger: "scribe_order",
          tests: [machine.tests[0]],
          orderIds: [orderId],
          actorRole: "lab",
          actorId,
        })
      : null;

  return {
    orderId,
    machine: machine.id,
    name: visit[0].name,
    alreadyThere: false,
    price,
    backForTests: Boolean(late?.reopened),
  };
}

export async function addMachineTest(
  visitId,
  { machineId, actorId = null, station = null } = {},
  db = pool,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await addMachineTestOn(client, visitId, { machineId, actorId, station });
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function assertOrderInStation(orderId, station, db = pool) {
  if (!station) return;
  const { rows } = await db.query(
    `SELECT o.kind, COALESCE(t.names, ARRAY[]::text[]) AS names
       FROM giniflow_lab_orders o
       LEFT JOIN LATERAL (
         SELECT array_agg(lt.test_name) AS names
           FROM giniflow_lab_order_tests lt WHERE lt.lab_order_id = o.id
       ) t ON TRUE
      WHERE o.id = $1`,
    [orderId],
  );
  if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });
  const row = rows[0];
  if (row.kind !== "machine") {
    throw Object.assign(new Error("That order belongs to the lab, not the machine room"), {
      status: 409,
    });
  }
  const catalogue = await getMachines(db);
  const orderMachine = machineOf(
    catalogue,
    row.names.map((n) => ({ name: n })),
  );
  assertMachineInStation(catalogue, orderMachine, station);
}

export async function machineCandidates(visitDate, q = null, db = pool) {
  const search = q && String(q).trim().length >= 2 ? String(q).trim() : null;
  const { rows } = await db.query(
    `SELECT v.id AS visit_id, p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
            v.current_status
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.visit_date = $1::date
        AND NOT COALESCE(p.is_blocked, FALSE)
        AND v.current_status <> ALL($3::text[])
        AND (
          $2::text IS NULL
          OR p.name ILIKE '%' || $2 || '%'
          OR p.file_no ILIKE '%' || $2 || '%'
        )
      ORDER BY p.name
      LIMIT 40`,
    [visitDate, search, FINISHED],
  );
  return rows.map((r) => ({
    visitId: r.visit_id,
    patientId: r.patient_id,
    name: r.name,
    fileNo: r.file_no,
    age: r.age,
    sex: r.sex,
    where: whereTheyAre(r.current_status),
  }));
}

export async function cancelMachineStart(
  orderId,
  { actorId = null, actorRole = "machine", reason = null, station = null },
  db = pool,
) {
  const client = await db.connect();
  let visitId = null;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT o.sample_status, o.visit_id, o.kind,
              COALESCE(t.names, ARRAY[]::text[]) AS names
         FROM giniflow_lab_orders o
         LEFT JOIN LATERAL (
           SELECT array_agg(lt.test_name) AS names
             FROM giniflow_lab_order_tests lt WHERE lt.lab_order_id = o.id
         ) t ON TRUE
        WHERE o.id = $1 FOR UPDATE OF o`,
      [orderId],
    );
    if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });
    await assertNotHeld(client, { orderId });
    const row = rows[0];
    visitId = row.visit_id;
    if (row.kind !== "machine") {
      throw Object.assign(new Error("That order belongs to the lab, not the machine room"), {
        status: 409,
      });
    }
    const catalogue = await getMachines(client);
    assertMachineInStation(
      catalogue,
      machineOf(
        catalogue,
        row.names.map((n) => ({ name: n })),
      ),
      station,
    );
    if (row.sample_status !== "in_progress") {
      await client.query("COMMIT");
      return { orderId, sampleStatus: row.sample_status, unchanged: true };
    }
    const back = await revertStart(client, orderId, "in_progress", {
      actorId,
      actorRole,
      reason,
    });
    await client.query("COMMIT");
    publish({ kind: "lab_order", visitId, orderId, status: "start_cancelled" });
    return { orderId, sampleStatus: back, cancelled: true };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function advanceMachineTest(
  orderId,
  { to, actorId = null, reportUrl = null, station = null },
  db = pool,
) {
  if (!MACHINE_SAMPLE_FLOW.includes(to)) {
    throw Object.assign(new Error(`Unknown machine test status: ${to}`), { status: 400 });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT o.sample_status, o.payment_status, o.visit_id, o.kind, v.visit_date,
              COALESCE(t.names, ARRAY[]::text[]) AS names,
              (SELECT doc.id FROM documents doc WHERE doc.giniflow_lab_order_id = o.id)
                AS report_doc_id,
              o.report_file_url,
              EXISTS (SELECT 1 FROM lab_results lr WHERE lr.lab_order_id = o.id) AS has_values
         FROM giniflow_lab_orders o
         JOIN giniflow_visits v ON v.id = o.visit_id
         LEFT JOIN LATERAL (
           SELECT array_agg(lt.test_name) AS names
             FROM giniflow_lab_order_tests lt WHERE lt.lab_order_id = o.id
         ) t ON TRUE
        WHERE o.id = $1 FOR UPDATE OF o`,
      [orderId],
    );
    if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });
    await assertNotHeld(client, { orderId });
    const row = rows[0];
    if (row.kind !== "machine") {
      throw Object.assign(new Error("That order belongs to the lab, not the machine room"), {
        status: 409,
      });
    }

    if (!opensLabGate(row.payment_status)) {
      throw Object.assign(
        new Error(
          row.payment_status === "insurance_claim"
            ? "Insurance claim is not approved yet — the test cannot be started"
            : "Payment is not cleared — reception must take payment before the test",
        ),
        { status: 409 },
      );
    }

    const fromStage = stageOf(row.sample_status);
    const toStage = stageOf(to);
    const fromIdx = machineStageIndexOf(fromStage);
    const toIdx = machineStageIndexOf(toStage);
    if (toIdx <= fromIdx) {
      // Two taps on the same card is one statement, not two.
      await client.query("COMMIT");
      return { orderId, sampleStatus: row.sample_status, unchanged: true };
    }

    const rung = machineRungFor(toStage);
    if (rung?.needsPatient) {
      await assertPatientIsFree(client, row.visit_id, rung.actionNoun);
    }
    const catalogue = await getMachines(client);
    const orderMachine = machineOf(
      catalogue,
      row.names.map((n) => ({ name: n })),
    );
    assertMachineInStation(catalogue, orderMachine, station);
    if (toStage === "in_progress") {
      const machine = machineFor(catalogue, orderMachine);
      await assertStationFree(
        client,
        row.visit_id,
        machine?.station || "machine_room",
        `start the ${machine?.name || "test"}`,
      );
      await assertReadyToStart(client, row.visit_id, catalogue, orderMachine);
      await assertMachineFree(client, orderMachine, row.visit_date, orderId);
      await resumeVisitTx(client, row.visit_id, { actorId, actorRole: "lab" });
    }
    const hasEvidence = !!(row.report_doc_id || row.report_file_url || row.has_values || reportUrl);
    const handsOver = machineHandsOver(catalogue, orderMachine);
    if ((toStage === "done" || toStage === "reported") && !hasEvidence && !handsOver) {
      throw Object.assign(
        new Error(
          "Nothing recorded yet — type the values in, or attach the report, before finishing this test",
        ),
        { status: 409 },
      );
    }

    await client.query(
      `UPDATE giniflow_lab_orders
          SET sample_status = $2,
              report_file_url = COALESCE($3, report_file_url),
              uploaded_at = CASE WHEN $2 = 'reported' THEN NOW() ELSE uploaded_at END,
              updated_at = NOW()
        WHERE id = $1`,
      [orderId, to, reportUrl],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
       VALUES ($1, 'sample', $2, 'machine', $3)`,
      [orderId, to, actorId],
    );

    let finalStatus = to;
    if (toStage === "done") {
      await client.query(
        `UPDATE giniflow_lab_orders
            SET sample_status = 'reported', uploaded_at = COALESCE(uploaded_at, NOW()),
                updated_at = NOW()
          WHERE id = $1`,
        [orderId],
      );
      await client.query(
        `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
         VALUES ($1, 'sample', 'reported', 'machine', $2)`,
        [orderId, actorId],
      );
      finalStatus = "reported";
    }
    let markedResultsReady = false;
    if (finalStatus === "reported") {
      const { rowCount } = await client.query(
        `UPDATE giniflow_visits v
            SET results_status = 'ready', updated_at = NOW()
          WHERE v.id = $1
            AND v.results_status <> 'ready'
            AND NOT EXISTS (
              SELECT 1 FROM giniflow_lab_orders o2
               WHERE o2.visit_id = v.id AND o2.urgency = 'today'
                 AND o2.id <> $2
                 AND o2.sample_status NOT IN ('uploaded', 'reported', 'sent_outside')
            )`,
        [row.visit_id, orderId],
      );
      markedResultsReady = rowCount > 0;
    }

    const { syncMachineSteps } = await import("./journey.js");
    await syncMachineSteps(client, row.visit_id);

    await client.query("COMMIT");
    return { orderId, sampleStatus: finalStatus, markedResultsReady };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function getMachineReconciliation(visitDate, db = pool, station = null) {
  if (!machineShowsHealthrayReports()) return [];
  const fullCatalogue = await getMachines(db);
  const catalogue = station ? machinesForStation(fullCatalogue, station) : fullCatalogue;
  if (station && !catalogue.length) return [];
  const { rows } = await db.query(
    `SELECT d.id, d.doc_type, d.title, d.doc_date::text AS doc_date, d.created_at,
            p.id AS patient_id, p.name, p.file_no, v.current_status,
            -- Who filed the report. HealthRay has no field for it, but it names
            -- the uploader in the FILENAME — other_beant_kaur_11_09_2026_02_06_
            -- PM_xxxx.pdf — so the one answer this screen could not give
            -- ("who ran it?") was in the row all along. Parsed rather than
            -- guessed: a name that does not match the pattern is left null
            -- instead of showing a mangled string.
            NULLIF(
              initcap(replace(
                regexp_replace(
                  d.file_name,
                  '^other_(.+?)_[0-9]{2}_[0-9]{2}_[0-9]{4}_.*$', '\\1'
                ), '_', ' ')),
              initcap(replace(d.file_name, '_', ' '))
            ) AS filed_by
       FROM documents d
       JOIN patients p ON p.id = d.patient_id
       LEFT JOIN giniflow_visits v
              ON v.patient_id = p.id AND v.visit_date = $1::date
      WHERE d.doc_type = ANY($2::text[])
        AND d.doc_date = $1::date
        AND NOT EXISTS (
          SELECT 1 FROM giniflow_lab_orders o
           JOIN giniflow_visits v2 ON v2.id = o.visit_id
          WHERE o.kind = 'machine'
            AND v2.patient_id = p.id
            AND v2.visit_date = $1::date
        )
        -- A patient who has gone is nobody's work. The floor asked for this
        -- screen to hold only what can still be acted on today, the way
        -- HealthRay's own list clears as people leave.
        AND COALESCE(v.current_status, '') <> ALL($3::text[])
      ORDER BY d.created_at DESC
      LIMIT 200`,
    [visitDate, machineDocTypes(catalogue), FINISHED],
  );
  const byPatient = new Map();
  for (const r of rows) {
    const key = r.patient_id;
    if (!byPatient.has(key)) {
      byPatient.set(key, {
        patientId: r.patient_id,
        name: r.name,
        fileNo: r.file_no,
        reports: [],
        where: whereTheyAre(r.current_status),
        gone: !r.current_status || FINISHED.includes(r.current_status),
        filedBy: null,
        at: null,
      });
    }
    const entry = byPatient.get(key);
    const at = r.created_at ? new Date(r.created_at).toISOString() : null;
    if (r.filed_by && !entry.filedBy) entry.filedBy = r.filed_by;
    entry.reports.push({
      docId: r.id,
      machine: machineIdForDocType(catalogue, r.doc_type),
      docType: r.doc_type,
      title: r.title,
      at,
    });
    if (at && (!entry.at || at > entry.at)) entry.at = at;
  }

  return [...byPatient.values()].sort((a, b) => (b.at || "").localeCompare(a.at || ""));
}

export async function removeMachineReport(
  orderId,
  { actorId = null, station = null } = {},
  db = pool,
) {
  const { rows } = await db.query(
    `SELECT o.kind, o.report_file_url, o.sample_status,
            COALESCE(t.names, ARRAY[]::text[]) AS names,
            (SELECT doc.id FROM documents doc WHERE doc.giniflow_lab_order_id = o.id)
              AS report_doc_id
       FROM giniflow_lab_orders o
       LEFT JOIN LATERAL (
         SELECT array_agg(lt.test_name) AS names
           FROM giniflow_lab_order_tests lt WHERE lt.lab_order_id = o.id
       ) t ON TRUE
      WHERE o.id = $1`,
    [orderId],
  );
  if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });
  const row = rows[0];
  if (row.kind !== "machine") {
    throw Object.assign(new Error("That order belongs to the lab, not the machine room"), {
      status: 409,
    });
  }
  const catalogue = await getMachines(db);
  const orderMachine = machineOf(
    catalogue,
    row.names.map((n) => ({ name: n })),
  );
  assertMachineInStation(catalogue, orderMachine, station);
  if (!row.report_file_url && !row.report_doc_id) {
    throw Object.assign(new Error("There is no report on this test to remove"), { status: 409 });
  }
  if (await hasExtraReports(orderId, db)) {
    throw Object.assign(new Error("Remove the additional reports on this test first"), {
      status: 409,
    });
  }

  const storagePath = String(row.report_file_url || "").split(`/${STORAGE_BUCKET}/`)[1] || null;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM documents WHERE giniflow_lab_order_id = $1`, [orderId]);
    await client.query(
      `UPDATE giniflow_lab_orders
          SET report_file_url = NULL, uploaded_at = NULL,
              sample_status = 'done', updated_at = NOW()
        WHERE id = $1`,
      [orderId],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
       VALUES ($1, 'sample', 'done', 'machine', $2)`,
      [orderId, actorId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  if (storagePath) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    }).catch(() => {});
  }

  return { orderId, removed: storagePath };
}

export async function getMachineTrack(db, visitId, now = new Date()) {
  const catalogue = await getMachines(db);
  const { rows } = await db.query(
    `SELECT o.id, o.sample_status, o.created_at,
            (SELECT string_agg(t.test_name, ', ' ORDER BY t.test_name)
               FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS tests,
            (SELECT array_agg(t.test_name ORDER BY t.test_name)
               FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS test_names,
            (SELECT min(e.occurred_at) FROM giniflow_lab_order_events e
              WHERE e.lab_order_id = o.id AND e.track = 'sample' AND e.status = 'in_progress')
              AS started_at,
            (SELECT min(e.occurred_at) FROM giniflow_lab_order_events e
              WHERE e.lab_order_id = o.id AND e.track = 'sample' AND e.status IN ('done', 'reported'))
              AS done_at
       FROM giniflow_lab_orders o
      WHERE o.visit_id = $1 AND o.kind = 'machine' AND o.urgency = 'today'
      ORDER BY o.created_at, tests, o.id`,
    [visitId],
  );
  const minutes = (from, to) =>
    from
      ? Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000))
      : null;
  return rows.map((r) => {
    const done = !!r.done_at || r.sample_status === "reported";
    const running = !done && !!r.started_at;
    const station = (r.test_names || [])
      .map((n) => machineForTest(catalogue, n)?.station)
      .find(Boolean);
    return {
      orderId: r.id,
      label: r.tests || "Machine test",
      room: COLUMN_NAME[machineColumnFor(station)],
      state: done ? "done" : running ? "running" : "waiting",
      orderedAt: new Date(r.created_at).toISOString(),
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
      doneAt: r.done_at ? new Date(r.done_at).toISOString() : null,
      minutes: done
        ? minutes(r.started_at, r.done_at)
        : running
          ? minutes(r.started_at, now)
          : null,
    };
  });
}
