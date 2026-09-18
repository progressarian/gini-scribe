import { CANCELLABLE_ORDER_STATUSES } from "../../../shared/testCancelReasons.js";
import pool from "../../config/db.js";
import { LIVE_LAB_CASE_SQL } from "./testsHold.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { opensLabGate, outstandingOf } from "../../../shared/labPayment.js";
import {
  STATUS_LABEL,
  BOARD_COLUMNS,
  columnForStatus,
  NOT_A_MARKER_SQL,
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
import { LAB_ONLY_DOCTOR, labOnlyPredicate, labOnlyHiddenPredicate } from "./labOnlyVisits.js";
import { hideLabOnlyPatients } from "./floorSettings.js";

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

// The machine room (36-MACHINE-TEST-STATION-PLAN.md).
//
// A machine test has no specimen. Nothing is drawn, nothing travels, nothing
// waits on a bench — the patient walks to a machine and sits at it. Three rules
// follow from that, and all three are enforced here rather than by hiding a
// button, because a screen left open in the wrong state is not a rule:
//
//   P1  The patient is needed for the whole test, not just its first step. Both
//       `in_progress` and `done` refuse to move while another station has them.
//   P2  A machine takes one patient at a time. A bench runs twenty tubes at
//       once; a treadmill does not.
//   P3  Payment gates the start, exactly as it gates a blood collection.

const COLUMN_NAME = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, c.name]));

const IN_A_ROOM = ["with_vitals", "with_sd", "with_doctor"];
const FINISHED = ["dispensed", "exited", "no_show", "cancelled"];
const NEVER_CAME = ["no_show", "cancelled"];

const stageOf = (sampleStatus) => MACHINE_STATUS_TO_STAGE[sampleStatus] || "ordered";

// Where the patient is standing, said the way a person would. A raw status key
// must never reach the screen: `wait_doctor` on a card is the database leaking
// through, and it tells a technician nothing. Falls back to a humanised form of
// whatever it was, so an unmapped status is at worst plain English.
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

// Which machine an order is for. An order carries its tests, and a machine order
// raised through the catalogue carries exactly one machine's worth — but a
// doctor can type a one-off, so the first test that names a machine wins and
// anything unrecognised is left unassigned rather than guessed at.
const machineOf = (machines, tests) => {
  for (const t of tests || []) {
    const m = machineForTest(machines, t.name ?? t);
    if (m) return m.id;
  }
  return null;
};

// Refused in the service, not just hidden on the screen — the same shape as
// P1/P2/P3 below. A capability gates the route; this is what actually stops an
// echo_tech acting on an ABI order (or a machine_tech on an Echo one) reached
// through a stale tab or a hand-built request.
const assertMachineInStation = (catalogue, machineId, station) => {
  if (!station) return;
  // A one-off test name that matches no catalogue machine stays the default
  // station's problem, exactly as the queue filter treats it — a dedicated
  // station like Echo never inherits ambiguous work.
  if (!machineId) {
    if (station === "machine_room") return;
  } else if (machinesForStation(catalogue, station).some((m) => m.id === machineId)) {
    return;
  }
  throw Object.assign(new Error("That test does not belong to this station"), { status: 403 });
};

// P1. Copied in meaning from the lab's own rule, not shared with it: the lab
// applies this to collection alone, and here it governs two rungs.
async function assertPatientIsFree(db, visitId, what) {
  if (!visitId) return;
  const { rows } = await db.query(
    `SELECT v.current_status, p.name,
            (SELECT e.meta->>'source' FROM giniflow_visit_events e
               WHERE e.visit_id = v.id AND ${NOT_A_MARKER_SQL("e.status")}
               ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) AS room_source
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

// P2. One machine, one patient. Asked of the table rather than of the screen,
// so a second tab cannot start a second treadmill.
async function assertMachineFree(db, machineId, visitDate, exceptOrderId = null) {
  if (!machineId) return;
  // Which machine an order is for lives in its test names, and matching them is
  // JS — so this asks for every test currently in progress and decides here,
  // rather than trying to express the match in SQL and getting it half right.
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

// The floor's order of operations (39-HYBRID-FLOOR-PLAN.md §3): vitals first,
// and where a patient is billed for blood as well, the draw before the machine.
// Enforced on the START of the test only — a test already running must never
// become unfinishable because of a box nobody ticked upstream.
async function assertReadyToStart(db, visitId, catalogue, machineId) {
  if (!visitId) return;
  const machine = machineFor(catalogue, machineId);
  const machineName = machine?.name || "machine";
  const { rows } = await db.query(
    `SELECT p.name,
            (
              EXISTS (SELECT 1 FROM giniflow_vitals g WHERE g.visit_id = v.id)
              OR EXISTS (
                SELECT 1 FROM giniflow_visit_events e
                 WHERE e.visit_id = v.id
                   AND e.status IN ('with_vitals', 'vitals_done')
                   AND e.actor_role <> 'system'
              )
            ) AS vitals_recorded,
            ${labOnlyPredicate("v", "$2")} AS lab_only,
            ${BLOOD_NOT_DRAWN_SQL("$3")} AS blood_not_drawn
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId, LAB_ONLY_DOCTOR, labStepsAreManual()],
  );
  if (!rows.length) return;
  const { name, vitals_recorded, lab_only, blood_not_drawn } = rows[0];
  if (!lab_only && !vitals_recorded) {
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
  // A machine can require another one done first — today only Echo, which
  // requires X-ray (46-XRAY-STATION-PLAN.md). Generic rather than hardcoded:
  // any machine row can carry `requiresBefore`.
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

export async function getMachineQueue(
  visitDate,
  q = null,
  db = pool,
  { machine = null, group = "all", station = null } = {},
) {
  const search = q && String(q).trim().length >= 2 ? String(q).trim() : null;
  const hideLabOnly = await hideLabOnlyPatients(db);
  const catalogue = await getMachines(db);
  // Additive to the `machine` filter below, not a replacement: a station's
  // screen always calls with its own `station` and never sees another
  // station's machines, whether or not it also asked for one machine's tab.
  const stationMachines = station ? machinesForStation(catalogue, station) : catalogue;
  const stationIds = new Set(stationMachines.map((m) => m.id));

  const { rows } = await db.query(
    `SELECT o.id, o.visit_id, o.sample_status, o.payment_status, o.urgency,
            o.amount_total, o.amount_paid, o.amount_claimed, o.claim_state,
            o.created_at, o.updated_at, o.uploaded_at, o.report_file_url,
            p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
            v.current_status,
            (SELECT e.meta->>'source' FROM giniflow_visit_events e
               WHERE e.visit_id = v.id AND ${NOT_A_MARKER_SQL("e.status")}
               ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) AS room_source,
            d.short_name AS ordered_by,
            COALESCE(t.tests, '[]'::json) AS tests,
            last_ev.occurred_at AS since,
            (SELECT doc.id FROM documents doc WHERE doc.giniflow_lab_order_id = o.id)
              AS report_doc_id,
            EXISTS (SELECT 1 FROM lab_results lr WHERE lr.lab_order_id = o.id) AS has_values,
            -- The two sequencing gates (39-HYBRID-FLOOR-PLAN.md §3). Asked of the
            -- table, not of the screen: a technician with a stale tab must be
            -- refused by the service, not merely shown no button.
            (
              EXISTS (SELECT 1 FROM giniflow_vitals g WHERE g.visit_id = v.id)
              OR EXISTS (
                SELECT 1 FROM giniflow_visit_events e
                 WHERE e.visit_id = v.id
                   AND e.status IN ('with_vitals', 'vitals_done')
                   AND e.actor_role <> 'system'
              )
            ) AS vitals_recorded,
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
        -- Samples-only patients don't show on any station screen while the
        -- floor has that toggled on (settings/flow) — see
        -- awaitingRegistration() in labStation.js for where this started.
        AND NOT ${labOnlyHiddenPredicate("v", "$3", "$5")}
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
    [visitDate, search, LAB_ONLY_DOCTOR, labStepsAreManual(), hideLabOnly],
  );

  const busy = await busyStations(
    db,
    rows.map((r) => r.visit_id),
  );

  let all = rows.map((r) => {
    const paid = opensLabGate(r.payment_status);
    const stage = stageOf(r.sample_status);
    const machineId = machineOf(catalogue, r.tests);
    const next = nextMachineStep(stage);
    const finished = NEVER_CAME.includes(r.current_status);
    const inARoom = IN_A_ROOM.includes(r.current_status) && r.room_source !== "healthray";
    const free = !inARoom && !finished;
    const hasEvidence = !!r.report_doc_id || !!r.has_values || !!r.report_file_url;
    // The offer, and every reason it might not be there. Computed once, here,
    // so the screen never shows a button the service would refuse.
    // Both gates apply to STARTING the test and nothing else. A test already on
    // the machine must never become unfinishable because of a box nobody ticked
    // upstream — that would trap a patient mid-test.
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
      reportDocId: r.report_doc_id || null,
      reportUrl: r.report_file_url || null,
      orderedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      since: new Date(r.since || r.updated_at || r.created_at).toISOString(),
      uploadedAt: r.uploaded_at ? new Date(r.uploaded_at).toISOString() : null,
      finished,
      inARoom,
      collectable: free,
      station: whereTheyAre(r.current_status),
    };
  });

  // A machine can require another one done first — today only Echo, which
  // requires X-ray (46-XRAY-STATION-PLAN.md). Cross-station and computed
  // BEFORE the station filter below, since the blocker (X-ray) usually lives
  // on a different screen than the row it blocks (Echo) — the button must
  // still not be offered here even though the blocking order is invisible on
  // this screen.
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

  all = all.filter((o) => {
    if (!station) return true;
    // An order whose test name matches no machine at all stays the default
    // station's problem, the same way it always has — a dedicated station like
    // Echo only ever sees its own, unambiguous work.
    if (!o.machine) return station === "machine_room";
    return stationIds.has(o.machine);
  });

  // P2, on the screen as well as in the service. A machine with somebody on it
  // cannot take a second patient, so the queue behind it must not be offered a
  // Start button — the service would refuse the tap, and a button that answers
  // 409 is worse than no button. Done as a second pass because it needs the
  // whole day's rows to know which machines are occupied.
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

  // Server-side, both of them: the screen asks for a machine and a group and
  // gets only those rows. Counts are whole-day and computed before any filter,
  // so a chip does not read 0 the moment another chip is pressed.
  const wantedMachine = stationMachines.some((m) => m.id === machine) ? machine : null;
  const wantedGroup = MACHINE_FILTER_TO_STAGE[group] ? group : "all";

  const counts = Object.fromEntries(
    MACHINE_RUNGS.map((r) => [r.filter, all.filter((o) => o.stage === r.key).length]),
  );

  const machines = stationMachines.map((m) => {
    const mine = all.filter((o) => o.machine === m.id);
    const onIt = mine.find((o) => o.stage === "in_progress") || null;
    const waiting = mine.filter((o) => o.stage === "ordered");
    return {
      ...m,
      total: mine.length,
      waiting: waiting.length,
      onIt: onIt ? { name: onIt.name, since: onIt.since, orderId: onIt.orderId } : null,
      // What this station can answer that nothing else on the floor can.
      waitMinutes: waitMinutesFor(catalogue, m.id, waiting.length) + (onIt ? m.durationMin : 0),
      byStage: Object.fromEntries(
        MACHINE_RUNGS.map((r) => [r.key, mine.filter((o) => o.stage === r.key).length]),
      ),
    };
  });

  const unassigned = all.filter((o) => !o.machine);

  // A test whose name matches no machine gets its own section, so it is not also
  // listed under a stage — one row, one place on the screen.
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

// Raising a machine test at the machine itself.
//
// The alternative is that the doctor orders every one during the consultation,
// and the floor as it stands says that does not happen: today three patients had
// ABI, VPT and Fundus run with zero orders behind them. A station whose queue
// depends on somebody else remembering is a station that stays empty while its
// machines run all day.
//
// Raised `payment_pending`, exactly as the collection bench's orders are: a
// machine test is billed before it is run, whoever raised it. The order lands on
// reception's payment desk, and P3 below holds the patient at the machine until
// the desk clears it.
// The rules, on a caller's transaction. Reception raises the same order from the
// check-in panel, and every rule here has to hold there too — one open test per
// machine, a patient still on the floor, a price to bill. Two implementations
// would mean two sets of rules and only one of them enforced.
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
  if (FINISHED.includes(visit[0].current_status)) {
    throw Object.assign(
      new Error(`${visit[0].name} has left the floor — the test cannot be added to today`),
      { status: 409 },
    );
  }

  // One open test per machine per visit. Tapping twice is the same statement,
  // and two cards for one patient on one machine is a queue that lies.
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

  const { rows: priced } = await client.query(
    `SELECT price FROM giniflow_test_catalog
      WHERE UPPER(test_name) = UPPER($1) AND COALESCE(is_active, TRUE)`,
    [machine.tests[0]],
  );
  const price = Number(priced[0]?.price ?? 0);
  // A test with no price cannot be billed, and an order for ₹0 would sit at
  // `pending` with nothing for reception to collect — blocked at the machine
  // for ever. The lab refuses an uncatalogued test outright; so does this.
  if (!priced.length || !(price > 0)) {
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

  return { orderId, machine: machine.id, name: visit[0].name, alreadyThere: false, price };
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

// Who is on the floor right now and could be walked to a machine. Anybody not
// finished — a machine test is a detour, not a step in the chain, so it does not
// matter which station currently holds them.
// Which machine (if any) an existing order is for — used by the route layer to
// guard the report upload path, which is shared with the lab and so cannot
// itself take a `station` argument without also constraining lab uploads.
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
  const hideLabOnly = await hideLabOnlyPatients(db);
  const { rows } = await db.query(
    `SELECT v.id AS visit_id, p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
            v.current_status
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.visit_date = $1::date
        AND NOT COALESCE(p.is_blocked, FALSE)
        AND v.current_status <> ALL($3::text[])
        AND NOT ${labOnlyHiddenPredicate("v", "$4", "$5")}
        AND (
          $2::text IS NULL
          OR p.name ILIKE '%' || $2 || '%'
          OR p.file_no ILIKE '%' || $2 || '%'
        )
      ORDER BY p.name
      LIMIT 40`,
    [visitDate, search, FINISHED, LAB_ONLY_DOCTOR, hideLabOnly],
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
    const row = rows[0];
    if (row.kind !== "machine") {
      throw Object.assign(new Error("That order belongs to the lab, not the machine room"), {
        status: 409,
      });
    }

    // P3. Enforced here, not in the UI: a hidden button is not a rule, and this
    // one decides whether a patient is charged for a test.
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
    }
    // The evidence gate — and here it covers FINISHING the test, not only filing
    // the report.
    //
    // This is where the machine room parts company with the lab. A tube leaves
    // the patient and its result comes back hours later, so "collected" is a
    // true statement on its own. A machine prints its report at the machine
    // while the patient is still in the chair: the test being over and the
    // result existing are the same moment. Marking a machine test done with
    // nothing captured records a result nobody will go back for.
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

    // Finishing IS filing. The evidence is already there — the gate above
    // refused otherwise — so a second tap to "file the report" would ask the
    // technician to confirm something they had just done.
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

    // Closing the test is what releases the patient on the MO and consultant
    // queues — the same flag an uploaded lab report sets, for the same reason.
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
                 AND o2.sample_status NOT IN ('uploaded', 'reported')
            )`,
        [row.visit_id, orderId],
      );
      markedResultsReady = rowCount > 0;
    }

    await client.query("COMMIT");
    return { orderId, sampleStatus: finalStatus, markedResultsReady };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Machine tests that produced a report today with no order behind them — the
// tests that happened without ever touching this screen. On the floor as it
// stands this is nearly everything, and it shrinks as the station gets used.
//
// A RECORD, not a queue. Nearly every row is a patient who has already left:
// the report reaches us after the test, and the test after the patient moved on.
// Filtering the departed out would empty the list and hide the gap it exists to
// show, so each row carries where the patient is instead — and the screen keeps
// it collapsed, below the day's actual work.
//
// Read-only, deliberately: there is nothing to record after the fact that would
// be true. Nobody can say at six in the evening who was at the machine at 15:29.
export async function getMachineReconciliation(visitDate, db = pool, station = null) {
  if (!machineShowsHealthrayReports()) return [];
  const fullCatalogue = await getMachines(db);
  // Scoped the same way the queue is: Echo's reconciliation must not show an
  // unmatched ABI report, and Machine Room's must not show an unmatched Echo
  // or X-ray one — each station's "what arrived with no order" is its own.
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
  // One row per PATIENT, not per report. A diabetic foot screen is an ABI, a VPT
  // and a Fundus, so reporting per document listed the same person three times
  // and a list of eleven rows was four people.
  const byPatient = new Map();
  for (const r of rows) {
    const key = r.patient_id;
    if (!byPatient.has(key)) {
      byPatient.set(key, {
        patientId: r.patient_id,
        name: r.name,
        fileNo: r.file_no,
        reports: [],
        // Where the patient is now. Almost always gone: a report reaches us
        // after the test, and the test after the patient has moved on. Shown so
        // nobody reads this list as work to do.
        where: whereTheyAre(r.current_status),
        gone: !r.current_status || FINISHED.includes(r.current_status),
        filedBy: null,
        at: null,
      });
    }
    const entry = byPatient.get(key);
    const at = r.created_at ? new Date(r.created_at).toISOString() : null;
    // One name per patient: these arrive as a set from one person in one sitting.
    if (r.filed_by && !entry.filedBy) entry.filedBy = r.filed_by;
    entry.reports.push({
      docId: r.id,
      machine: machineIdForDocType(catalogue, r.doc_type),
      docType: r.doc_type,
      title: r.title,
      at,
    });
    // The latest report of the set — what the row is timed by, so the list reads
    // most-recent-first as one patient rather than interleaving their tests.
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
