import pool from "../../config/db.js";
import {
  CASE_CANCELLABLE_SQL,
  LIVE_LAB_CASE_SQL,
  ORDER_CANCELLABLE_SQL,
  ORDER_OUTPUT_SQL,
  caseFromEarlierLabOnlyVisit,
} from "./testsHold.js";
import {
  LAB_STATION,
  assertStationFree,
  busyStations,
  busyElsewhere,
  busyReason,
  withVisitLock,
  revertStart,
} from "./stationLock.js";
import { publish } from "./eventHub.js";
import { outsourcedTestNames } from "../billing/testMatch.js";
import { t as clipText } from "../../utils/helpers.js";
import { promoteLabReport, promoteQuietly } from "./promote.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { advanceStatus, cancelPauseTx, pauseVisitTx, resumeVisitTx } from "./statusEngine.js";
import { advanceMachineTest } from "./machineStation.js";
import {
  HOME_PAYMENT_PENDING,
  HOME_RELEASE_STEP,
  opensLabGate,
  opensLabGateFor,
  outstandingOf,
} from "../../../shared/labPayment.js";
import {
  HOME_COLLECTION_SQL,
  ORDER_COLLECTED_SQL,
  ORDER_HOME_COLLECTED_SQL,
  cleanCollectedAt,
  homeVisit,
  refuseSiteForNonHome,
} from "./homeCollection.js";
import {
  BOARD_COLUMNS,
  STATUS_LABEL,
  WAIT_STATUSES,
  columnForStatus,
  ROOM_SOURCE_SQL,
  SAMPLE_BREAK_REASON,
} from "../../../shared/giniflowStatus.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import { hideLabOnlyPatients } from "./floorSettings.js";
import { syncLabStepsFromLab } from "./journey.js";
import { labStepsAreManual, labShowsHealthrayCases } from "../../../shared/manualFloor.js";
import {
  LAB_ROOMS,
  LAB_RUNGS,
  LAB_STAGES,
  LAB_RAIL,
  LAB_SAMPLE_FLOW,
  NEXT_SAMPLE_ACTION,
  SAMPLE_STATUS_TO_STAGE,
  stageIndexOf,
  UNDRAWN_SAMPLE_STATUSES,
  visibleRungs,
  roomOwns,
  CASE_ACTION_VERBS,
  nextOfferedFor,
  ACTION_NOUN,
  SAMPLE_STATUS_TO_BUCKET,
  BUCKET_TO_STAGE,
  FILTER_TO_TARGETS,
  FLOOR_ACTION_STAGE,
  markableRungs,
  railForStage,
  OUTSIDE_SKIPPED_STATUSES,
  OUTSIDE_STEP,
  SENT_OUTSIDE,
} from "../../../shared/labStages.js";
import {
  assertNotHeld,
  CASE_CANCEL_STAGE_SQL,
  HELD_CASE_SQL,
  HELD_ORDER_SQL,
} from "./cancelHold.js";
import { orderCancelStage } from "../../../shared/testCancelStages.js";

const COLUMN_NAME = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, c.name]));

const FINISHED = ["dispensed", "exited", "no_show", "cancelled"];
const NEVER_CAME = ["no_show", "cancelled"];

const IN_A_ROOM = ["with_vitals", "with_sd", "with_doctor"];

const inStationRoom = (r) => IN_A_ROOM.includes(r.current_status) && r.room_source !== "healthray";

export { LAB_SAMPLE_FLOW as SAMPLE_FLOW };

const roomAction = (sampleStatus, room) => {
  const rung = nextOfferedFor(SAMPLE_STATUS_TO_STAGE[sampleStatus], room);
  return rung ? { to: rung.advanceTo, label: rung.advanceLabel } : null;
};

const OUTSIDE_UPLOAD = { to: "uploaded", label: "📤 Upload report" };

const outsideAction = (sampleStatus, room) => {
  if (room === LAB_ROOMS.PROCESSING) return null;
  if (sampleStatus === "drawing" || sampleStatus === "sample_collected") return OUTSIDE_STEP;
  if (sampleStatus === SENT_OUTSIDE) return OUTSIDE_UPLOAD;
  return roomAction(sampleStatus, room);
};

const orderAction = (order, room) =>
  order.is_outsourced
    ? outsideAction(order.sample_status, room)
    : roomAction(order.sample_status, room);

const stepsFor = (sampleStatus, paid, moving = paid) => {
  const reached = moving ? railForStage[stageIndexOf(SAMPLE_STATUS_TO_STAGE[sampleStatus])] : 0;
  return [
    { name: "Payment ✓", state: paid ? "done" : "now" },
    ...LAB_RAIL.slice(1).map((name, i) => {
      const step = i + 1;
      return { name, state: step < reached ? "done" : step === reached ? "now" : "next" };
    }),
  ];
};

export const OPEN_LAB_CASES_SQL = `
  (SELECT count(*)::int FROM lab_cases lc
    WHERE lc.case_date = v.visit_date
      AND (lc.patient_id = v.patient_id
           OR (lc.patient_id IS NULL
               AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
      AND lc.raw_detail_json->>'reported_on' IS NULL
      AND lc.pdf_storage_path IS NULL
      AND NOT EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                       WHERE a.case_no = lc.case_no AND a.action = 'sent_outside')
      AND ${LIVE_LAB_CASE_SQL("lc")})`;

const unifiedFromOrder = (o) => ({
  key: `giniflow:${o.orderId}`,
  source: "giniflow",
  driven: true,
  stage: BUCKET_TO_STAGE[o.bucket] || "pending",
  steps: o.steps,
  patientId: o.patientId,
  name: o.name,
  fileNo: o.fileNo,
  age: o.age,
  sex: o.sex,
  tests: o.tests.map((t) => t.name),
  outsourcedTests: o.tests.filter((t) => t.outsourced).map((t) => t.name),
  caseCount: 1,
  since: o.since,
  orderedBy: o.orderedBy,
  nextAction: o.nextAction,
  blockedReason: o.blockedReason,
  reportUrl: o.reportUrl,
  orderId: o.orderId,
  visitId: o.visitId,
  homeCollection: o.homeCollection,
  homeCollectable: o.homeCollectable,
  collectedAtSite: o.collectedAtSite,
  collectedBy: o.collectedBy,
  collectedAt: o.collectedAt,
});

const unifiedFromCase = (r) => ({
  key: `healthray:${r.rowKey}`,
  source: "healthray",
  driven: false,
  stage: r.stage?.key || "pending",
  steps: r.steps,
  patientId: r.patientId,
  name: r.name,
  fileNo: r.fileNo,
  age: r.age,
  sex: r.sex,
  tests: r.tests || [],
  outsourcedTests: r.outsourcedTests || [],
  caseCount: r.cases,
  since: r.stageAt || r.registeredAt || null,
  orderedBy: r.orderedBy || null,
  nextAction: null,
  blockedReason: null,
  reportUrl: null,
  station: r.station || null,
  outstanding: r.outstanding,
  homeCollection: r.homeCollection,
  homeCollectable: r.homeCollectable,
  collectedAtSite: r.collectedAtSite,
  collectedBy: r.collectedBy,
  collectedAt: r.collectedAt,
});

export const LAB_GROUPS = FILTER_TO_TARGETS;

async function awaitingRegistration(visitDate, search, db) {
  const { rows } = await db.query(
    `SELECT v.id AS visit_id, v.current_status,
            p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
            first_ev.occurred_at AS checked_in_at
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events e
          WHERE e.visit_id = v.id AND e.status = 'checked_in'
          ORDER BY occurred_at LIMIT 1
       ) first_ev ON TRUE
      WHERE v.visit_date = $1::date
        AND NOT COALESCE(p.is_blocked, FALSE)
        AND v.current_status NOT IN ('no_show', 'cancelled')
        AND ${labOnlyPredicate("v", "$3")}
        AND NOT EXISTS (SELECT 1 FROM giniflow_lab_orders o WHERE o.visit_id = v.id)
        AND NOT EXISTS (
          SELECT 1 FROM lab_cases lc
           WHERE lc.case_date = v.visit_date
             AND (lc.patient_id = v.patient_id
                  OR (lc.patient_id IS NULL
                      AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
        )
        AND (
          $2::text IS NULL
          OR p.name ILIKE '%' || $2 || '%'
          OR p.file_no ILIKE '%' || $2 || '%'
        )
      ORDER BY first_ev.occurred_at NULLS LAST`,
    [visitDate, search, LAB_ONLY_DOCTOR],
  );

  return rows.map((r) => ({
    key: `visit:${r.visit_id}`,
    source: "awaiting",
    visitId: r.visit_id,
    patientId: r.patient_id,
    name: r.name,
    fileNo: r.file_no,
    age: r.age,
    sex: r.sex,
    since: r.checked_in_at ? new Date(r.checked_in_at).toISOString() : null,
    finished: FINISHED.includes(r.current_status),
    station: FINISHED.includes(r.current_status)
      ? STATUS_LABEL[r.current_status] || r.current_status
      : COLUMN_NAME[columnForStatus(r.current_status)] ||
        STATUS_LABEL[r.current_status] ||
        r.current_status,
    blockedReason: "No case registered in HealthRay and no test ordered here",
  }));
}

const doneHereFor = (unified, room) => {
  if (!room) return [];
  const own = LAB_RUNGS.filter((r) => r.room === room);
  if (!own.length) return [];
  const lastOwn = stageIndexOf(own[own.length - 1].key);
  return unified
    .filter((u) => stageIndexOf(u.stage) > lastOwn)
    .sort((a, b) => (b.since || "").localeCompare(a.since || ""));
};

const homeCountsOf = (orders, healthray) => {
  const homeSites = [
    ...orders.map((o) => o.collectedAtSite),
    ...healthray.flatMap((h) =>
      (h.caseList || []).map(
        (c) => (c.actions || []).find((a) => a.action === "sample_taken")?.site ?? null,
      ),
    ),
  ];
  const pending = new Set([
    ...orders.filter((o) => o.homeCollectable).map((o) => `p:${o.patientId ?? o.orderId}`),
    ...healthray.filter((h) => h.homeCollectable).map((h) => `p:${h.patientId ?? h.rowKey}`),
  ]);
  return {
    homeCollected: homeSites.filter((site) => site === "home").length,
    homePending: pending.size,
  };
};

export async function getLabQueue(
  visitDate,
  q = null,
  db = pool,
  { group = "all", room = null } = {},
) {
  const search = q && String(q).trim().length >= 2 ? String(q).trim() : null;
  const healthray = labShowsHealthrayCases()
    ? await getHealthrayCases(visitDate, search, db, room)
    : [];
  const awaiting =
    !room || room === LAB_ROOMS.COLLECTION ? await awaitingRegistration(visitDate, search, db) : [];
  const { rows: queued } = await db.query(
    `SELECT o.id, o.visit_id, o.sample_status, o.payment_status, o.urgency,
            o.amount_total, o.amount_paid, o.amount_claimed, o.claim_state,
            o.created_at, o.updated_at, o.uploaded_at, o.report_file_url, o.is_outsourced,
            p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
            v.current_status,
            ${ROOM_SOURCE_SQL("v")} AS room_source,
            d.short_name AS ordered_by,
            -- The chart row the report landed on, so the pane can open it in the
            -- viewer the rest of the app uses instead of throwing the file at a
            -- new browser tab.
            (SELECT doc.id FROM documents doc WHERE doc.giniflow_lab_order_id = o.id)
              AS report_doc_id,
            ${ORDER_CANCELLABLE_SQL("o")} AS can_cancel,
            ${ORDER_OUTPUT_SQL("o")} AS has_output,
            ${HELD_ORDER_SQL("o")} AS cancel_held,
            ${HOME_COLLECTION_SQL("v")} AS home_collection,
            ${ORDER_COLLECTED_SQL("o")} AS collected_info,
            COALESCE((SELECT json_agg(json_build_object('caseNo', lc.case_no, 'tests', lc.test_names)
                                      ORDER BY lc.case_no)
                        FROM lab_cases lc
                       WHERE lc.case_date = v.visit_date
                         AND (lc.patient_id = v.patient_id
                              OR (lc.patient_id IS NULL
                                  AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
                         AND ${CASE_CANCELLABLE_SQL("lc")}
                         AND NOT EXISTS (SELECT 1 FROM giniflow_lab_orders o2
                                          WHERE o2.visit_id = o.visit_id AND o2.id <> o.id
                                            AND o2.urgency = 'today' AND o2.kind = 'lab')),
                     '[]'::json) AS cancellable_cases,
            COALESCE(t.tests, '[]'::json) AS tests,
            last_ev.occurred_at AS since
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN doctors d ON d.id = o.ordered_by
       LEFT JOIN LATERAL (
         SELECT json_agg(
                  json_build_object('id', lt.id, 'name', lt.test_name, 'price', lt.price,
                                    'status', lt.status)
                  ORDER BY lt.test_name) AS tests
           FROM giniflow_lab_order_tests lt WHERE lt.lab_order_id = o.id
       ) t ON TRUE
       LEFT JOIN LATERAL (
         SELECT occurred_at FROM giniflow_lab_order_events e
          WHERE e.lab_order_id = o.id AND e.track = 'sample'
          ORDER BY occurred_at DESC LIMIT 1
       ) last_ev ON TRUE
      WHERE v.visit_date = $1::date
        AND NOT COALESCE(p.is_blocked, FALSE)
        -- The lab's own work only. A machine test is an order like any other —
        -- it is priced, paid for and waited on — but nothing is drawn for it, so
        -- on this queue it would be a card asking a phlebotomist to take a
        -- sample that does not exist (36-MACHINE-TEST-STATION-PLAN.md §2.7).
        AND o.kind = 'lab'
        -- Only today's tests are today's work (brief §2.3 trigger 2). A test
        -- ordered for the next visit would otherwise sit here as a sample that
        -- never arrives.
        AND o.urgency = 'today'
        -- No sample to take from a patient who never arrived or has gone home.
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
    [visitDate, search],
  );
  const rows = queued.filter(
    (r) => r.sample_status !== SENT_OUTSIDE && !(room === LAB_ROOMS.PROCESSING && r.is_outsourced),
  );

  const busy = await busyStations(
    db,
    rows.map((r) => r.visit_id),
  );
  const outsourced = await outsourcedTestNames(db, [
    ...rows.flatMap((r) => (r.tests || []).map((t) => t.name)),
    ...healthray.flatMap((h) => h.tests || []),
  ]);
  const outsourcedOf = (names) => (names || []).filter((name) => outsourced.has(name));
  for (const row of healthray) {
    row.outsourcedTests = outsourcedOf(row.tests);
    for (const c of row.caseList || []) {
      c.outsourcedTests = outsourcedOf(c.tests);
      c.outsourced =
        c.caseSource === "outsource" ||
        (c.tests.length > 0 && c.tests.every((name) => outsourced.has(name)));
      c.sentOutside = (c.actions || []).some((a) => a.action === SENT_OUTSIDE);
      if (!c.outsourced) continue;
      const reportIn = c.reported || c.hasReport;
      c.nextAction =
        room === LAB_ROOMS.PROCESSING || c.sentOutside || reportIn
          ? null
          : c.collected || c.nextAction?.action === "sample_sent"
            ? { action: SENT_OUTSIDE, label: OUTSIDE_STEP.label }
            : c.nextAction;
      c.canUploadOutside = !reportIn && (c.sentOutside || c.collected);
      if (c.sentOutside) c.stage = { ...c.stage, label: "📮 Sent to outside lab" };
    }
  }
  const floorHealthray = healthray.flatMap((row) => {
    const held = (row.caseList || []).filter((c) => !c.sentOutside || c.reported || c.hasReport);
    if (held.length === 0 && row.caseList?.length) return [];
    if (held.length === row.caseList?.length) return [row];
    const lowest = held.reduce((worst, c) => (stageIndex(c) < stageIndex(worst) ? c : worst));
    return [
      { ...row, stage: lowest.stage, stageAt: lowest.stageAt, steps: labSteps(stageIndex(lowest)) },
    ];
  });
  const orders = rows.map((r) => {
    const paid = opensLabGate(r.payment_status);
    const elsewhere = busyElsewhere(busy, r.visit_id, LAB_STATION);
    const collected = r.collected_info || null;
    const homeCollected = collected?.site === "home";
    const moving = opensLabGateFor(r.payment_status, { homeCollected });
    const offered = moving ? orderAction(r, room) : null;
    const next = paid || offered?.to !== HOME_RELEASE_STEP ? offered : null;
    const homeCollectable =
      !!r.home_collection &&
      HOME_FROM_STATUSES.includes(r.sample_status) &&
      (!room || room === LAB_ROOMS.COLLECTION) &&
      !r.cancel_held;
    const startHeld = next?.to === "drawing" && !!elsewhere;
    return {
      orderId: r.id,
      visitId: r.visit_id,
      patientId: r.patient_id,
      name: r.name || "Patient not matched yet",
      fileNo: r.file_no,
      age: r.age,
      sex: r.sex,
      orderedBy: r.ordered_by,
      urgency: r.urgency,
      outsourced: !!r.is_outsourced,
      tests: (r.tests || []).map((t) => ({ ...t, outsourced: outsourced.has(t.name) })),
      amountTotal: Number(r.amount_total) || 0,
      amountPaid: Number(r.amount_paid) || 0,
      paymentStatus: r.payment_status,
      sampleStatus: r.sample_status,
      paid,
      bucket: SAMPLE_STATUS_TO_BUCKET[r.sample_status] || "pending",
      steps: stepsFor(r.sample_status, paid, moving),
      nextAction: startHeld ? null : next,
      blockedReason: !paid
        ? homeCollected
          ? `Payment pending — ₹${outstandingOf(r)}; the report is held until reception records it`
          : r.home_collection
            ? `Payment pending — collect ₹${outstandingOf(r)} at the home and tell reception`
            : r.payment_status === "insurance_claim"
              ? `Insurance claim submitted — waiting for approval (₹${outstandingOf(r)} outstanding)`
              : `Waiting for reception to clear payment — ₹${outstandingOf(r)} outstanding`
        : startHeld
          ? busyReason(elsewhere)
          : null,
      heldElsewhere: startHeld,
      canCancelStart: r.sample_status === "drawing" && (!room || room === LAB_ROOMS.COLLECTION),
      canCancel: !!r.can_cancel,
      cancelStage: orderCancelStage({
        kind: "lab",
        sampleStatus: r.sample_status,
        hasOutput: r.has_output,
      }),
      cancelHeld: !!r.cancel_held,
      cancellableCases: r.cancellable_cases || [],
      claimState: r.claim_state || "none",
      orderedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      since:
        r.since || r.updated_at || r.created_at
          ? new Date(r.since || r.updated_at || r.created_at).toISOString()
          : null,
      uploadedAt: r.uploaded_at ? new Date(r.uploaded_at).toISOString() : null,
      reportUrl: r.report_file_url || null,
      reportDocId: r.report_doc_id || null,
      finished: FINISHED.includes(r.current_status),
      station: FINISHED.includes(r.current_status)
        ? STATUS_LABEL[r.current_status] || r.current_status
        : COLUMN_NAME[columnForStatus(r.current_status)] ||
          STATUS_LABEL[r.current_status] ||
          r.current_status,
      collectable: !inStationRoom(r) && !NEVER_CAME.includes(r.current_status) && !elsewhere,
      busyAt: elsewhere ? busyReason(elsewhere) : null,
      homeCollection: !!r.home_collection,
      homeCollectable,
      collectedAtSite: collected?.site ?? null,
      collectedBy: collected?.by ?? null,
      collectedAt: collected?.at ?? null,
    };
  });

  const by = (b) => orders.filter((o) => o.bucket === b);

  const unified = [...orders.map(unifiedFromOrder), ...floorHealthray.map(unifiedFromCase)];
  const unifiedCounts = LAB_STAGES.reduce(
    (acc, s) => ({ ...acc, [s.key]: unified.filter((u) => u.stage === s.key).length }),
    {},
  );
  const rungs = visibleRungs(room);
  const inRoom = (stageKey) => rungs.some((r) => r.key === stageKey);
  const roomHealthray = room ? floorHealthray.filter((r) => inRoom(r.stage.key)) : floorHealthray;

  const bucketCounts = Object.fromEntries(rungs.map((r) => [r.bucket, by(r.bucket).length]));
  const groupCounts = Object.fromEntries(
    rungs.map((r) => [
      r.filter,
      by(r.bucket).length + roomHealthray.filter((h) => h.stage.key === r.key).length,
    ]),
  );

  const wanted = rungs.some((r) => r.filter === group) ? group : "all";
  const keep = (bucket) =>
    wanted === "all" || FILTER_TO_TARGETS[wanted].bucket === bucket ? by(bucket) : [];
  const keptHealthray =
    wanted === "all"
      ? roomHealthray
      : roomHealthray.filter((r) => r.stage.key === FILTER_TO_TARGETS[wanted].stage);

  return {
    group: wanted,
    room,
    awaiting,
    doneHere: doneHereFor(unified, room),
    counts: groupCounts,
    bucketCounts,
    ...Object.fromEntries(rungs.map((r) => [r.bucket, keep(r.bucket)])),
    healthray: keptHealthray,
    unified: room ? unified.filter((u) => inRoom(u.stage)) : unified,
    unifiedCounts,
    stages: rungs.map((r) => ({ key: r.key, label: r.stageLabel })),
    homeCounts: homeCountsOf(orders, healthray),
    stageCounts: roomHealthray.reduce(
      (acc, r) => {
        r.caseList.forEach((c) => {
          if (c.sentOutside && !c.reported && !c.hasReport) return;
          if (c.stage.key in acc) acc[c.stage.key] += 1;
        });
        return acc;
      },
      Object.fromEntries(rungs.map((r) => [r.key, 0])),
    ),
  };
}

const CASE_STAGE = LAB_RUNGS.map((r) => ({
  key: r.key,
  label: r.stageLabel,
  pill: r.pill,
  at: r.healthrayAt,
  since: r.sinceLabel,
}));

export { LAB_STAGES };
const pastCollection = (c) => !!c.receivedOn || !!c.resultSavedOn || !!c.reportedOn;

// HealthRay's own evidence, and the only evidence this screen used to have.
const healthrayStage = (c) => {
  if (c.reportedOn) return stageIndexOf("reported");
  if (c.resultSavedOn) return stageIndexOf("results");
  if (c.receivedOn) return stageIndexOf("received");
  if (c.phlebotomy === "Completed" || !!c.collectedOn || pastCollection(c))
    return stageIndexOf("collected");
  return 0;
};

const floorStage = (c) =>
  (c.actions || []).reduce((max, a) => Math.max(max, FLOOR_ACTION_STAGE[a.action] ?? 0), 0);

const STAGE_FOR_ACTION = Object.fromEntries(
  LAB_RUNGS.filter((r) => r.action).map((r) => [r.action, r.key]),
);
const assertRoomOwns = (room, stageKey) => {
  if (!room || !stageKey) return;
  if (!roomOwns(room, stageKey)) {
    throw Object.assign(
      new Error(`The ${room} room does not own this step — it belongs to the other lab room`),
      { status: 403 },
    );
  }
};
const hasEvidence = (c) => !!c.hasReport || !!c.hasValues;
const stageIndex = (c) =>
  labStepsAreManual() ? floorStage(c) : Math.max(healthrayStage(c), floorStage(c));

export const isCollected = (c) => stageIndex(c) >= stageIndexOf("collected");

const canHaveReport = (c) => stageIndex(c) >= stageIndexOf("results");
const CASE_NEXT_ACTION = markableRungs().map((r) => ({ action: r.action, label: r.actionLabel }));

const labSteps = (stage) => {
  const reached = railForStage[stage];
  return LAB_RAIL.map((name, i) => ({
    name,
    state: i < reached ? "done" : i === reached ? "now" : "next",
  }));
};

async function getHealthrayCases(visitDate, q = null, db = pool, room = null) {
  const hideLabOnly = await hideLabOnlyPatients(db);
  const { rows } = await db.query(
    `WITH cases AS (
       SELECT lc.*,
              COALESCE(lc.raw_detail_json, lc.raw_list_json) AS payload,
              -- A case the lab is still running has no patient_id: that column is
              -- stamped only once the detail fetch has written the values. The
              -- UHID is in the raw payload from the first list sync, so matching
              -- on it is what keeps outstanding work visible at all.
              COALESCE(lc.patient_id, uid.id) AS pid,
              -- What counts as "one patient" for grouping. pid alone cannot:
              -- every case the hospital registered for somebody with no chart
              -- here has pid NULL, and grouping on that collapses all of them
              -- into a single card carrying one arbitrary name. Unmatched cases
              -- fall back to HealthRay's own UHID, and to the case number when
              -- even that is absent, so a stranger is at worst their own row.
              COALESCE(
                (COALESCE(lc.patient_id, uid.id))::text,
                'hr:' || (lc.raw_list_json->'patient'->>'healthray_uid'),
                'case:' || lc.case_no
              ) AS grp
         FROM lab_cases lc
         LEFT JOIN patients uid
                ON uid.file_no = lc.raw_list_json->'patient'->>'healthray_uid'
        WHERE lc.case_date = $1::date
          AND ${LIVE_LAB_CASE_SQL("lc")}
          AND NOT (
            $4::boolean
            AND EXISTS (
              SELECT 1 FROM giniflow_visits hv
               WHERE hv.patient_id = COALESCE(lc.patient_id, uid.id)
                 AND hv.visit_date = lc.case_date
                 AND ${caseFromEarlierLabOnlyVisit("hv")}
                 AND NOT ${labOnlyPredicate("hv", "$3")}
            )
          )
          -- NO DOUBLE ROWS. Once reception or a doctor raises the same patient's
          -- tests in Scribe, that order is the one the bench works: it carries
          -- the payment, the manual ladder and the audit trail. The hospital's
          -- own case for that patient would otherwise sit beside it as a second
          -- card for one physical tube (39-HYBRID-FLOOR-PLAN.md §15).
          --
          -- So the HealthRay list is exactly what it is for: the patients Scribe
          -- does NOT already know about.
          AND NOT EXISTS (
            SELECT 1
              FROM giniflow_lab_orders o
              JOIN giniflow_visits gv ON gv.id = o.visit_id
             WHERE gv.visit_date = lc.case_date
               AND o.kind = 'lab'
               AND o.urgency = 'today'
               AND gv.patient_id = COALESCE(lc.patient_id, uid.id)
          )
          AND (
            $2::text IS NULL
            OR lc.raw_list_json->'patient'->>'patient_name' ILIKE '%' || $2 || '%'
            OR lc.raw_list_json->'patient'->>'healthray_uid' ILIKE '%' || $2 || '%'
            OR array_to_string(lc.test_names, ' ') ILIKE '%' || $2 || '%'
            OR (COALESCE(lc.raw_detail_json, lc.raw_list_json) -> 'referral_doctor')::text
                 ILIKE '%' || $2 || '%'
            OR EXISTS (
              SELECT 1 FROM patients px
               WHERE px.id = COALESCE(lc.patient_id, uid.id)
                 AND (px.name ILIKE '%' || $2 || '%' OR px.file_no ILIKE '%' || $2 || '%')
            )
          )
     )
     SELECT c.grp,
            c.pid AS patient_id,
            COALESCE(p.name, max(c.raw_list_json->'patient'->>'patient_name')) AS name,
            COALESCE(p.file_no, max(c.raw_list_json->'patient'->>'healthray_uid')) AS file_no,
            p.age, p.sex,
            v.current_status, v.results_status, v.id IS NOT NULL AS on_floor,
            v.id AS visit_id,
            ${ROOM_SOURCE_SQL("v")} AS room_source,
            -- Constant across the group (it depends only on the patient and the
            -- day), so bool_or reads it without widening the GROUP BY.
            bool_or(${labOnlyPredicate("v", "$3")}) AS lab_only,
            bool_or(${HOME_COLLECTION_SQL("v")}) AS home_collection,
            count(*)::int AS cases,
            count(*) FILTER (WHERE NOT c.results_synced)::int AS pending,
            count(*) FILTER (WHERE c.results_synced
                               AND c.raw_detail_json->>'reported_on' IS NULL)::int AS partial,
            count(*) FILTER (WHERE c.results_synced
                               AND c.raw_detail_json->>'reported_on' IS NOT NULL)::int AS reported,
            (SELECT array_agg(DISTINCT t)
               FROM cases c2, unnest(c2.test_names) AS t
              WHERE c2.grp = c.grp) AS tests,
            -- A patient with a sample today and no visit today is not a missing
            -- check-in: they were consulted on an earlier day and have come back
            -- for the sample alone. Saying WHEN they were seen answers the
            -- question the card otherwise provokes.
            (SELECT max(pv.visit_date)::text FROM giniflow_visits pv
              WHERE pv.patient_id = c.pid AND pv.visit_date < $1::date) AS prev_visit,
            (SELECT max(a.appointment_date)::text FROM appointments a
              WHERE a.patient_id = c.pid AND a.appointment_date < $1::date) AS prev_appt,
            min(c.payload->>'registered_at') AS registered_at,
            max(c.payload->>'reported_on') AS reported_on,
            (array_agg(btrim(
               COALESCE(c.payload->'referral_doctor'->>'title', '') || ' ' ||
               COALESCE(c.payload->'referral_doctor'->>'first_name', '') || ' ' ||
               COALESCE(c.payload->'referral_doctor'->>'last_name', ''))
             ORDER BY c.payload->>'registered_at'))[1] AS ordered_by,
            min(c.fetched_at) AS first_seen,
            max(c.fetched_at) AS last_seen,
            json_agg(
              json_build_object(
                'caseNo', c.case_no,
                'caseSource', c.case_source,
                'tests', COALESCE(c.test_names, ARRAY[]::text[]),
                'canCancel', ${CASE_CANCELLABLE_SQL("c")},
                'cancelStage', ${CASE_CANCEL_STAGE_SQL("c")},
                'cancelHeld', ${HELD_CASE_SQL("c")},
                'cancelledTests', COALESCE((
                  SELECT json_agg(json_build_object('name', x.test_name, 'reason', x.reason,
                                                    'note', x.note, 'at', x.cancelled_at,
                                                    'by', d.name)
                                  ORDER BY x.cancelled_at)
                    FROM giniflow_test_cancellations x
                    LEFT JOIN doctors d ON d.id = x.actor_id
                   WHERE x.visit_date = c.case_date AND x.kind = 'healthray_case'
                     AND x.case_no = c.case_no AND x.snapshot ? 'cancelledTest'), '[]'::json),
                'synced', c.results_synced,
                'reported', c.raw_detail_json->>'reported_on' IS NOT NULL,
                'hasReport', c.pdf_storage_path IS NOT NULL,
                -- The chart row the file landed on, so the pane can open it in
                -- the viewer every other screen already uses rather than
                -- inventing a second way to look at a PDF.
                'reportDocId', (
                  SELECT d.id FROM documents d
                   WHERE d.storage_path = c.pdf_storage_path
                   ORDER BY d.id DESC LIMIT 1
                ),
                -- Either kind of evidence closes a case: a file on the chart or
                -- values typed against it. "Done" must never be offered on a
                -- case carrying neither, or the doctor is told results are ready
                -- with nothing behind them.
                'hasValues', EXISTS (
                  SELECT 1 FROM lab_results lr WHERE lr.lab_case_no = c.case_no
                ),
                -- HealthRay's own clocks, which are the real ones. fetched_at
                -- is when our poller first saw the case, hours after the sample
                -- was drawn, and putting it on a card dated the work wrongly.
                'registeredAt', c.payload->>'registered_at',
                'collectedOn', c.payload->>'collected_on',
                'receivedOn', c.payload->>'received_on',
                'reportedOn', c.payload->>'reported_on',
                'resultSavedOn', c.payload->>'result_saved_on',
                'phlebotomy', c.raw_list_json->>'phlebotomy_status',
                'orderedBy', btrim(
                  COALESCE(c.payload->'referral_doctor'->>'title', '') || ' ' ||
                  COALESCE(c.payload->'referral_doctor'->>'first_name', '') || ' ' ||
                  COALESCE(c.payload->'referral_doctor'->>'last_name', '')
                ),
                'fetchedAt', c.fetched_at,
                'actions', COALESCE(act.list, '[]'::json)
              ) ORDER BY c.fetched_at DESC
            ) AS case_list
       FROM cases c
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'action', a.action,
                  'at', a.created_at,
                  'by', COALESCE(d.short_name, d.name, a.actor_role),
                  'site', a.collected_at_site,
                  'collectedAt', a.collected_at
                ) ORDER BY a.created_at) AS list
           FROM giniflow_lab_case_actions a
           LEFT JOIN doctors d ON d.id = a.actor_id
          WHERE a.case_no = c.case_no
       ) act ON TRUE
       LEFT JOIN patients p ON p.id = c.pid
       LEFT JOIN giniflow_visits v ON v.patient_id = c.pid AND v.visit_date = $1::date
      WHERE NOT COALESCE(p.is_blocked, FALSE)
        AND NOT ($4::boolean AND v.id IS NULL)
      GROUP BY c.grp, c.pid, p.id, p.name, p.file_no, p.age, p.sex, v.current_status,
               v.results_status, v.id
      ORDER BY (count(*) FILTER (WHERE NOT c.results_synced)) DESC, min(c.fetched_at)`,
    [visitDate, q, LAB_ONLY_DOCTOR, hideLabOnly],
  );

  const busy = await busyStations(
    db,
    rows.map((r) => r.visit_id),
  );
  return rows.map((r) => {
    const counts = { pending: r.pending, partial: r.partial, reported: r.reported };
    const elsewhere = r.on_floor ? busyElsewhere(busy, r.visit_id, LAB_STATION) : null;
    const cases = (r.case_list || []).map((c) => {
      const idx = stageIndex(c);
      const onFloor = idx > healthrayStage(c);
      const at = (c.actions || []).find((a) => FLOOR_ACTION_STAGE[a.action] === idx);
      return {
        ...c,
        stage: onFloor
          ? { ...CASE_STAGE[idx], label: `${CASE_STAGE[idx].label} · floor` }
          : CASE_STAGE[idx],
        stageAt: (onFloor ? at?.at : c[CASE_STAGE[idx].at]) || null,
        collected: isCollected(c),
        nextAction: (() => {
          const rung = nextOfferedFor(CASE_STAGE[idx].key, room, "actionLabel");
          if (!rung) return null;
          if (rung.action === "report_uploaded" && !hasEvidence(c)) return null;
          return { action: rung.action, label: rung.actionLabel };
        })(),
        canMarkDone: hasEvidence(c),
        canHaveReport: canHaveReport(c),
        state: !c.synced
          ? { key: "awaiting", label: "Awaiting results" }
          : !c.reported
            ? { key: "partial", label: "Partial — panels still coming in" }
            : { key: "reported", label: "Reported" },
      };
    });
    const lowest = cases.reduce(
      (worst, c) => (stageIndex(c) < stageIndex(worst) ? c : worst),
      cases[0],
    );
    const taken = cases
      .map((c) => (c.actions || []).find((a) => a.action === "sample_taken" && a.site))
      .find(Boolean);
    return {
      rowKey: r.grp,
      visitId: r.visit_id || null,
      homeCollection: !!r.home_collection,
      homeCollectable:
        !!r.home_collection &&
        !!r.visit_id &&
        (!room || room === LAB_ROOMS.COLLECTION) &&
        cases.some((c) => !c.cancelHeld && stageIndex(c) < stageIndexOf("drawing")),
      collectedAtSite: taken?.site ?? null,
      collectedBy: taken?.by ?? null,
      collectedAt: taken ? taken.collectedAt || taken.at : null,
      patientId: r.patient_id,
      name: r.name || "Unnamed patient",
      fileNo: r.file_no,
      age: r.age,
      sex: r.sex,
      tests: r.tests || [],
      cases: r.cases,
      caseList: cases,
      stage: lowest?.stage || CASE_STAGE[0],
      stageAt: lowest?.stageAt || null,
      ...counts,
      outstanding: r.pending + r.partial,
      steps: labSteps(lowest ? stageIndex(lowest) : 0),
      labOnly: !!r.lab_only,
      station: r.on_floor
        ? FINISHED.includes(r.current_status)
          ? STATUS_LABEL[r.current_status] || r.current_status
          : r.lab_only
            ? null
            : COLUMN_NAME[columnForStatus(r.current_status)] ||
              STATUS_LABEL[r.current_status] ||
              r.current_status
        : null,
      statusLabel: r.on_floor ? STATUS_LABEL[r.current_status] || r.current_status : null,
      lastSeenOn: r.on_floor ? null : r.prev_visit || r.prev_appt || null,
      waiting: r.on_floor
        ? WAIT_STATUSES.includes(r.current_status) ||
          (!inStationRoom(r) && !FINISHED.includes(r.current_status))
        : false,
      inARoom: r.on_floor ? inStationRoom(r) : false,
      finished: r.on_floor ? FINISHED.includes(r.current_status) : false,
      collectable: r.on_floor
        ? !inStationRoom(r) && !NEVER_CAME.includes(r.current_status) && !elsewhere
        : true,
      busyAt: elsewhere ? busyReason(elsewhere) : null,
      awaitingResults:
        r.on_floor &&
        !FINISHED.includes(r.current_status) &&
        !r.lab_only &&
        r.results_status !== "ready" &&
        r.pending + r.partial > 0,
      orderedBy: r.ordered_by || null,
      registeredAt: r.registered_at || null,
      reportedOn: r.reported_on || null,
      firstSeen: r.first_seen ? new Date(r.first_seen).toISOString() : null,
      lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
    };
  });
}

async function assertPatientIsFree(db, visitId, what) {
  if (!visitId) return;
  const { rows } = await db.query(
    `SELECT v.current_status, p.name,
            ${ROOM_SOURCE_SQL("v")} AS room_source,
            (SELECT string_agg(t.test_name, ', ' ORDER BY t.test_name)
               FROM giniflow_lab_orders mo
               JOIN giniflow_lab_order_tests t ON t.lab_order_id = mo.id
              WHERE mo.visit_id = v.id AND mo.kind = 'machine' AND mo.urgency = 'today'
                AND mo.sample_status = 'in_progress') AS on_machine
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) return;
  const { current_status: status, name, room_source: roomSource, on_machine: onMachine } = rows[0];
  if (onMachine) {
    throw Object.assign(
      new Error(`${name} is on the ${onMachine} right now — ${what} once the test is finished`),
      { status: 409 },
    );
  }
  if (IN_A_ROOM.includes(status) && roomSource !== "healthray") {
    throw Object.assign(
      new Error(
        `${name} is with another station right now (${STATUS_LABEL[status] || status}) — ${what} once they are free`,
      ),
      { status: 409 },
    );
  }
  if (NEVER_CAME.includes(status)) {
    throw Object.assign(new Error(`${name} has left the floor — ${what} is no longer possible`), {
      status: 409,
    });
  }
}

export function assertSampleDrawn({ kind, sample_status: status }) {
  if (kind !== "lab" || !UNDRAWN_SAMPLE_STATUSES.includes(status)) return;
  throw Object.assign(
    new Error(
      "Collect the sample first — Lab 1 taps Start collection, then Send to lab, before it can be run or reported",
    ),
    { status: 409 },
  );
}

async function resolveVisitForCase(db, caseNo) {
  const { rows: visit } = await db.query(
    `SELECT v.id FROM lab_cases lc
       JOIN giniflow_visits v
         ON v.visit_date = lc.case_date AND v.patient_id = lc.patient_id
      WHERE lc.case_no = $1 AND lc.patient_id IS NOT NULL
      LIMIT 1`,
    [caseNo],
  );
  if (visit.length) return visit[0].id;
  const { rows: sameDay } = await db.query(
    `SELECT v.id FROM lab_cases lc
       JOIN patients p ON p.file_no = lc.raw_list_json->'patient'->>'healthray_uid'
       JOIN giniflow_visits v ON v.visit_date = lc.case_date AND v.patient_id = p.id
      WHERE lc.case_no = $1 AND lc.patient_id IS NULL
      LIMIT 2`,
    [caseNo],
  );
  return sameDay.length === 1 ? sameDay[0].id : null;
}

async function isLabOnlyVisit(db, visitId) {
  if (!visitId) return false;
  const { rows } = await db.query(
    `SELECT ${labOnlyPredicate("v", "$2")} AS lab_only FROM giniflow_visits v WHERE v.id = $1`,
    [visitId, LAB_ONLY_DOCTOR],
  );
  return !!rows[0]?.lab_only;
}

async function assertLabBillingCleared(db, visitId, before = "the sample") {
  if (!visitId) {
    throw Object.assign(
      new Error(`Lab payment is not cleared — reception must clear Lab Billing before ${before}`),
      { status: 409 },
    );
  }
  const { rows } = await db.query(
    `SELECT p.name, s.status AS billing_status
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN giniflow_visit_steps s
         ON s.visit_id = v.id AND s.step_catalog_id = 'lab_billing'
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) return;
  const { name, billing_status } = rows[0];
  if (billing_status !== "done") {
    throw Object.assign(
      new Error(
        `${name}'s lab payment is not cleared — reception must clear Lab Billing before ${before}`,
      ),
      { status: 409 },
    );
  }
}

export async function cancelDrawing(
  orderId,
  { actorId = null, actorRole = "lab", reason = null, room = null },
  db = pool,
) {
  assertRoomOwns(room, "drawing");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT sample_status, visit_id, kind FROM giniflow_lab_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });
    const { sample_status: status, visit_id: visitId, kind } = rows[0];
    if (kind !== "lab") {
      throw Object.assign(new Error("That order belongs to the machine room, not the lab"), {
        status: 409,
      });
    }
    if (status !== "drawing") {
      await client.query("COMMIT");
      return { orderId, sampleStatus: status, unchanged: true };
    }
    const back = await revertStart(client, orderId, "drawing", {
      actorId,
      actorRole,
      reason,
      syncTests: true,
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

const SENDS_FROM_THE_BENCH = ["sample_sent", SENT_OUTSIDE];

export async function advanceSample(
  orderId,
  {
    to,
    actorId = null,
    reportUrl = null,
    room = null,
    thenBreak = false,
    drawnAtBench = false,
    site = null,
  },
  db = pool,
) {
  if (!LAB_SAMPLE_FLOW.includes(to)) {
    throw Object.assign(new Error(`Unknown sample status: ${to}`), { status: 400 });
  }
  if (site === "home") {
    throw Object.assign(new Error("Mark a home collection with the home collection step"), {
      status: 400,
    });
  }
  assertRoomOwns(room, SAMPLE_STATUS_TO_STAGE[to]);

  if (SENDS_FROM_THE_BENCH.includes(to)) {
    const { rows: current } = await db.query(
      `SELECT sample_status FROM giniflow_lab_orders WHERE id = $1`,
      [orderId],
    );
    if (current[0]?.sample_status === "drawing") {
      const taken = await advanceSample(
        orderId,
        { to: "sample_collected", actorId, room, thenBreak, drawnAtBench: true },
        db,
      );
      const sent = await advanceSample(orderId, { to, actorId, reportUrl, room }, db);
      return { ...sent, onBreak: taken.onBreak };
    }
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT o.sample_status, o.payment_status, o.visit_id, o.kind, o.is_outsourced,
              ${ORDER_HOME_COLLECTED_SQL("o")} AS home_collected
         FROM giniflow_lab_orders o WHERE o.id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });
    await assertNotHeld(client, { orderId });
    const {
      sample_status: from,
      payment_status: payment,
      visit_id: visitId,
      home_collected: homeCollected,
    } = rows[0];
    const visit = await homeVisit(client, visitId);
    refuseSiteForNonHome(site, visit);
    if (rows[0].kind !== "lab") {
      throw Object.assign(new Error("That order belongs to the machine room, not the lab"), {
        status: 409,
      });
    }

    if (rows[0].is_outsourced && OUTSIDE_SKIPPED_STATUSES.includes(to)) {
      throw Object.assign(
        new Error("This test goes to an outside lab — mark it sent to the outside lab instead"),
        { status: 409 },
      );
    }
    if (!rows[0].is_outsourced && to === SENT_OUTSIDE) {
      throw Object.assign(new Error("Only an outsourced test is sent to an outside lab"), {
        status: 409,
      });
    }
    if (!opensLabGateFor(payment, { homeCollected, to })) {
      throw Object.assign(
        new Error(
          homeCollected
            ? HOME_PAYMENT_PENDING
            : payment === "insurance_claim"
              ? "Insurance claim is not approved yet — the sample cannot be collected"
              : "Payment is not cleared — reception must take payment before the sample",
        ),
        { status: 409 },
      );
    }

    const fromIdx = LAB_SAMPLE_FLOW.indexOf(from);
    const toIdx = LAB_SAMPLE_FLOW.indexOf(to);
    if (toIdx <= fromIdx) {
      // Two technicians tapping the same card is a no-op, not an error and not a
      // second event.
      await client.query("COMMIT");
      return { orderId, sampleStatus: from, unchanged: true };
    }

    if (to === "drawing") {
      await assertPatientIsFree(client, visitId, "start the collection");
      await assertStationFree(client, visitId, LAB_STATION, "start the collection");
      if (visitId) await resumeVisitTx(client, visitId, { actorId, actorRole: "lab" });
    }
    if (to === "sample_collected") {
      if (from !== "drawing") {
        throw Object.assign(
          new Error(
            "Start the collection first — tap ▶ Start collection when the patient is at the bench",
          ),
          { status: 409 },
        );
      }
      if (!drawnAtBench) await assertPatientIsFree(client, visitId, "collect the sample");
    }
    if (!UNDRAWN_SAMPLE_STATUSES.includes(to) && to !== "sample_collected") {
      assertSampleDrawn({ kind: "lab", sample_status: from });
    }

    await client.query(
      `UPDATE giniflow_lab_orders
          SET sample_status = $2,
              report_file_url = COALESCE($3, report_file_url),
              uploaded_at = CASE WHEN $2 = 'uploaded' THEN NOW() ELSE uploaded_at END,
              updated_at = NOW()
        WHERE id = $1`,
      [orderId, to, reportUrl],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id, meta)
       VALUES ($1, 'sample', $2, 'lab', $3, $4)`,
      [orderId, to, actorId, to === "sample_collected" && visit?.home ? { site: "ghm" } : {}],
    );
    await client.query(`UPDATE giniflow_lab_order_tests SET status = $2 WHERE lab_order_id = $1`, [
      orderId,
      to,
    ]);

    if (to === "uploaded") {
      await client.query(
        `UPDATE giniflow_visits v
            SET results_status = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM giniflow_lab_orders o2
                     WHERE o2.visit_id = v.id AND o2.urgency = 'today' AND o2.id <> $2
                       AND o2.sample_status NOT IN ('uploaded', 'reported', 'cancelled', 'sent_outside')
                  ) THEN 'partial'
                  ELSE 'ready' END,
                updated_at = NOW()
          WHERE v.id = $1`,
        [visitId, orderId],
      );
      await client.query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
         VALUES ($1, 'results_received', 'lab', $2, $3)`,
        [visitId, actorId, { source: "lab_upload", lab_order_id: orderId }],
      );
    }

    if (visitId) await syncLabStepsFromLab(client, visitId);

    const onBreak =
      thenBreak && to === "sample_collected" && visitId
        ? await pauseVisitTx(client, visitId, {
            actorId,
            actorRole: "lab",
            reason: SAMPLE_BREAK_REASON,
            meta: { lab_order_id: orderId },
          })
        : null;

    await client.query("COMMIT");
    return { orderId, sampleStatus: to, unchanged: false, onBreak: !!onBreak };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const EXT_BY_TYPE = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
};

export async function fetchStoredReport(orderId, db = pool) {
  const { rows } = await db.query(
    `SELECT o.report_file_url, o.visit_id, v.patient_id, p.name, p.file_no
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
       JOIN patients p        ON p.id = v.patient_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });

  const url = rows[0].report_file_url;
  if (!url) throw Object.assign(new Error("No report has been uploaded yet"), { status: 404 });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw Object.assign(new Error("Storage is not configured"), { status: 503 });
  }
  const marker = "/storage/v1/object/";
  const at = url.indexOf(marker);
  if (at < 0) throw Object.assign(new Error("That report cannot be read"), { status: 409 });
  const objectPath = url.slice(at + marker.length).replace(/^public\//, "");

  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${objectPath}`, {
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!resp.ok) {
    throw Object.assign(new Error("The stored report could not be read — re-upload it"), {
      status: resp.status === 404 ? 404 : 502,
    });
  }

  const contentType = resp.headers.get("content-type") || "application/octet-stream";
  const ext = (EXT_BY_TYPE[contentType.split(";")[0].trim()] || "bin").toLowerCase();
  const who = String(rows[0].name || "patient").replace(/[^a-zA-Z0-9._-]/g, "_");

  return {
    bytes: Buffer.from(await resp.arrayBuffer()),
    contentType,
    fileName: `Lab_${who}_${rows[0].file_no}.${ext}`,
  };
}

export async function storeReportObject({
  base64,
  fileName,
  mediaType,
  kind,
  patientId,
  folder = `giniflow/${kind === "machine" ? "machine" : "lab"}`,
}) {
  const buffer = Buffer.from(base64, "base64");
  const MAX_BYTES = 5 * 1024 * 1024;
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error("Report is larger than 5 MB"), { status: 413 });
  }

  const safeName = String(fileName || "report.pdf").replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${folder}/${patientId}/${Date.now()}_${safeName}`;

  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": mediaType,
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!resp.ok) {
    throw Object.assign(new Error(`Upload failed: ${await resp.text()}`), { status: 502 });
  }

  const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`;
  return { url, storagePath, safeName, bytes: buffer.length };
}

export async function uploadReport(
  orderId,
  { base64, fileName, mediaType = "application/pdf", actorId = null, confirmAdditional = false },
  db = pool,
) {
  if (!base64) throw Object.assign(new Error("No file was sent"), { status: 400 });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw Object.assign(new Error("Storage is not configured"), { status: 503 });
  }

  const { rows } = await db.query(
    `SELECT o.payment_status, o.sample_status, o.report_file_url, o.uploaded_at, o.kind,
            v.patient_id
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (!opensLabGate(rows[0].payment_status)) {
    throw Object.assign(new Error("Payment is not cleared for this order"), { status: 409 });
  }
  assertSampleDrawn(rows[0]);
  if (rows[0].report_file_url && !confirmAdditional) {
    throw Object.assign(new Error("A report is already on this order"), {
      status: 409,
      needsConfirmation: "additional_report",
      existingUploadedAt: rows[0].uploaded_at,
    });
  }

  const { url, safeName, bytes } = await storeReportObject({
    base64,
    fileName,
    mediaType,
    kind: rows[0].kind,
    patientId: rows[0].patient_id,
  });

  if (rows[0].kind === "machine") {
    await advanceMachineTest(orderId, { to: "reported", actorId, reportUrl: url }, db);
  } else {
    await advanceSample(orderId, { to: "uploaded", actorId, reportUrl: url }, db);
  }

  promoteQuietly(promoteLabReport, orderId);

  return { orderId, reportUrl: url, fileName: safeName, bytes };
}

async function replaceOrderReport(order, { base64, fileName, mediaType, actorId }, db) {
  if (!base64) throw Object.assign(new Error("No file was sent"), { status: 400 });
  const { url, safeName, bytes } = await storeReportObject({
    base64,
    fileName,
    mediaType: mediaType || "application/pdf",
    kind: order.kind,
    patientId: order.patient_id,
  });
  await db.query(
    `UPDATE giniflow_lab_orders SET report_file_url = $2, uploaded_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [order.id, url],
  );
  await db.query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
     VALUES ($1, 'sample', 'report_replaced', 'lab', $2)`,
    [order.id, actorId],
  );
  await promoteLabReport(order.id, db);
  return { orderId: order.id, reportUrl: url, fileName: safeName, bytes, replaced: true };
}

export async function uploadOutsideReport(orderId, { replace = false, ...input }, db = pool) {
  const { rows } = await db.query(
    `SELECT o.id, o.is_outsourced, o.sample_status, o.kind, v.patient_id
       FROM giniflow_lab_orders o JOIN giniflow_visits v ON v.id = o.visit_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (!rows[0].is_outsourced) {
    throw Object.assign(new Error("Only an outsourced test's report can be uploaded here"), {
      status: 403,
    });
  }
  if (replace && rows[0].sample_status === "uploaded") {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw Object.assign(new Error("Storage is not configured"), { status: 503 });
    }
    return replaceOrderReport(rows[0], input, db);
  }
  return uploadReport(orderId, input, db);
}

export const CASE_ACTIONS = CASE_ACTION_VERBS;

async function caseLadderState(db, caseNo) {
  const { rows } = await db.query(
    `SELECT lc.raw_list_json->>'phlebotomy_status' AS phlebotomy,
            lc.raw_list_json->>'collected_on'      AS "collectedOn",
            lc.raw_list_json->>'received_on'       AS "receivedOn",
            lc.raw_list_json->>'result_saved_on'   AS "resultSavedOn",
            lc.raw_list_json->>'reported_on'       AS "reportedOn",
            COALESCE(
              (SELECT json_agg(json_build_object('action', a.action))
                 FROM giniflow_lab_case_actions a WHERE a.case_no = lc.case_no),
              '[]'::json
            ) AS actions
       FROM lab_cases lc WHERE lc.case_no = $1`,
    [caseNo],
  );
  return rows[0] || {};
}

async function caseCollectedAtHome(db, caseNo) {
  const { rows } = await db.query(
    `SELECT 1 FROM giniflow_lab_case_actions
      WHERE case_no = $1 AND action = 'sample_taken' AND collected_at_site = 'home'`,
    [caseNo],
  );
  return rows.length > 0;
}

async function assertHomePaymentCleared(db, visitId) {
  const { rows } = await db.query(
    `SELECT s.status FROM giniflow_visit_steps s
      WHERE s.visit_id = $1 AND s.step_catalog_id = 'lab_billing'`,
    [visitId],
  );
  if (rows[0]?.status !== "done") {
    throw Object.assign(new Error(HOME_PAYMENT_PENDING), { status: 409 });
  }
}

const HOME_FROM_STATUSES = UNDRAWN_SAMPLE_STATUSES.filter((s) => s !== "drawing");

const refusal = (strict, message, status = 409) => {
  if (strict) throw Object.assign(new Error(message), { status });
  return false;
};

async function heldFor(client, target, strict) {
  try {
    await assertNotHeld(client, target);
    return false;
  } catch (e) {
    if (strict || e.code !== "cancel_pending") throw e;
    return true;
  }
}

async function markOrderAtHome(client, orderId, { meta, actorId, strict }) {
  const { rows } = await client.query(
    `SELECT sample_status, kind FROM giniflow_lab_orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  if (!rows.length) return refusal(strict, "Order not found", 404);
  const { sample_status: from, kind } = rows[0];
  if (kind !== "lab") return refusal(strict, "That order belongs to the machine room, not the lab");
  if (from === "cancelled") return refusal(strict, "This test was cancelled");
  if (from === "drawing") {
    return refusal(strict, "Collection has already started at the bench — finish it there");
  }
  if (!HOME_FROM_STATUSES.includes(from)) {
    return refusal(strict, "This sample has already been collected");
  }
  if (await heldFor(client, { orderId }, strict)) return false;
  await client.query(
    `UPDATE giniflow_lab_orders SET sample_status = 'sample_collected', updated_at = NOW()
      WHERE id = $1`,
    [orderId],
  );
  await client.query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id, meta)
     VALUES ($1, 'sample', 'sample_collected', 'lab', $2, $3)`,
    [orderId, actorId, meta],
  );
  await client.query(
    `UPDATE giniflow_lab_order_tests SET status = 'sample_collected' WHERE lab_order_id = $1`,
    [orderId],
  );
  return true;
}

async function markCaseAtHome(client, caseNo, { collectedAt, actorId, strict }) {
  const { rows } = await client.query(
    `SELECT ${LIVE_LAB_CASE_SQL("lc")} AS live FROM lab_cases lc WHERE lc.case_no = $1`,
    [caseNo],
  );
  if (!rows.length) return refusal(strict, `No such lab case: ${caseNo}`, 404);
  if (!rows[0].live)
    return refusal(strict, `Case ${caseNo} was cancelled — nothing more to record`);
  if (await heldFor(client, { caseNo }, strict)) return false;
  const ladder = await caseLadderState(client, caseNo);
  if (isCollected(ladder)) return refusal(strict, "This sample has already been collected");
  if (stageIndex(ladder) >= stageIndexOf("drawing")) {
    return refusal(strict, "Collection has already started at the bench — finish it there");
  }
  await client.query(
    `INSERT INTO giniflow_lab_case_actions
       (case_no, action, actor_role, actor_id, collected_at_site, collected_at)
     VALUES ($1, 'sample_taken', 'lab', $2, 'home', $3)
     ON CONFLICT (case_no, action) DO NOTHING`,
    [caseNo, actorId, collectedAt],
  );
  return true;
}

async function otherHomeTargets(client, visit, { orderId = null, caseNo = null }) {
  const { rows: orders } = await client.query(
    `SELECT id FROM giniflow_lab_orders
      WHERE visit_id = $1 AND kind = 'lab' AND urgency = 'today'
        AND id IS DISTINCT FROM $2::uuid AND sample_status = ANY($3::text[])
      ORDER BY created_at`,
    [visit.id, orderId, HOME_FROM_STATUSES],
  );
  const { rows: today } = await client.query(
    `SELECT 1 FROM giniflow_lab_orders
      WHERE visit_id = $1 AND kind = 'lab' AND urgency = 'today' LIMIT 1`,
    [visit.id],
  );
  if (today.length) return { orders: orders.map((r) => r.id), cases: [] };
  const { rows: cases } = await client.query(
    `SELECT lc.case_no FROM lab_cases lc
      WHERE lc.case_date = $2::date
        AND (lc.patient_id = $1
             OR (lc.patient_id IS NULL
                 AND lc.raw_list_json->'patient'->>'healthray_uid' = $3))
        AND lc.case_no IS DISTINCT FROM $4
        AND ${LIVE_LAB_CASE_SQL("lc")}
      ORDER BY lc.case_no`,
    [visit.patient_id, visit.visit_date, visit.file_no, caseNo],
  );
  return { orders: [], cases: cases.map((r) => r.case_no) };
}

export async function collectAtHome(
  { orderId = null, caseNo = null },
  { collectedAt = null, alsoOthers = false, actorId = null, room = null },
  db = pool,
) {
  assertRoomOwns(room, "collected");
  let visitId = null;
  if (orderId) {
    const { rows } = await db.query(`SELECT visit_id FROM giniflow_lab_orders WHERE id = $1`, [
      orderId,
    ]);
    if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });
    visitId = rows[0].visit_id;
  } else {
    visitId = await resolveVisitForCase(db, caseNo);
  }
  if (!visitId) {
    throw Object.assign(
      new Error("Book the patient for today first, then mark the home collection"),
      { status: 409 },
    );
  }
  const visit = await homeVisit(db, visitId);
  refuseSiteForNonHome("home", visit);
  const at = cleanCollectedAt(collectedAt, visit.visit_date);
  const meta = { site: "home", collectedAt: at.toISOString() };

  const marked = await withVisitLock(db, async (client) => {
    const done = { orders: [], cases: [] };
    const options = { meta, collectedAt: at, actorId, strict: true };
    if (orderId && (await markOrderAtHome(client, orderId, options))) done.orders.push(orderId);
    if (caseNo && (await markCaseAtHome(client, caseNo, options))) done.cases.push(caseNo);
    if (alsoOthers) {
      const others = await otherHomeTargets(client, visit, { orderId, caseNo });
      const loose = { ...options, strict: false };
      for (const id of others.orders) {
        if (await markOrderAtHome(client, id, loose)) done.orders.push(id);
      }
      for (const no of others.cases) {
        if (await markCaseAtHome(client, no, loose)) done.cases.push(no);
      }
    }
    await syncLabStepsFromLab(client, visitId);
    return done;
  });
  publish({ kind: "lab_order", visitId, status: "sample_collected" });
  return { visitId, site: "home", collectedAt: meta.collectedAt, ...marked };
}

export async function markLabCaseAction(
  caseNo,
  {
    action,
    actorId = null,
    actorRole = "lab",
    note = null,
    undo = false,
    room = null,
    thenBreak = false,
    drawnAtBench = false,
    site = null,
  },
  db = pool,
) {
  if (!CASE_ACTIONS.includes(action)) throw new Error(`Unknown lab case action: ${action}`);
  if (site === "home") {
    throw Object.assign(new Error("Mark a home collection with the home collection step"), {
      status: 400,
    });
  }
  assertRoomOwns(room, STAGE_FOR_ACTION[action]);

  const { rows: known } = await db.query(
    `SELECT ${LIVE_LAB_CASE_SQL("lc")} AS live FROM lab_cases lc WHERE lc.case_no = $1 LIMIT 1`,
    [caseNo],
  );
  if (!known.length) throw Object.assign(new Error(`No such lab case: ${caseNo}`), { status: 404 });
  if (!known[0].live) {
    throw Object.assign(new Error(`Case ${caseNo} was cancelled — nothing more to record`), {
      status: 409,
    });
  }
  await assertNotHeld(db, { caseNo });

  if (action === "sample_sent" && !undo && !isCollected(await caseLadderState(db, caseNo))) {
    const taken = await markLabCaseAction(
      caseNo,
      { action: "sample_taken", actorId, actorRole, room, thenBreak, drawnAtBench: true },
      db,
    );
    const sent = await markLabCaseAction(caseNo, { action, actorId, actorRole, note, room }, db);
    return { ...sent, onBreak: taken.onBreak };
  }

  if (!undo) {
    const c = await caseLadderState(db, caseNo);
    const want = stageIndexOf(STAGE_FOR_ACTION[action]);

    if (!labStepsAreManual() && healthrayStage(c) >= want) {
      throw Object.assign(
        new Error(`The lab has already taken this case past ${ACTION_NOUN[action]}`),
        { status: 409 },
      );
    }
    const floor = action === "sample_received" ? stageIndexOf("collected") : want - 1;
    if (stageIndex(c) < floor) {
      throw Object.assign(
        new Error(`Record ${ACTION_NOUN[LAB_RUNGS[floor].action] || "the previous step"} first`),
        { status: 409 },
      );
    }
  }
  if (action === "report_uploaded" && !undo) {
    const { rows: proof } = await db.query(
      `SELECT lc.pdf_storage_path IS NOT NULL AS has_report,
              EXISTS (SELECT 1 FROM lab_results lr WHERE lr.lab_case_no = lc.case_no) AS has_values
         FROM lab_cases lc WHERE lc.case_no = $1`,
      [caseNo],
    );
    if (!proof[0]?.has_report && !proof[0]?.has_values) {
      throw Object.assign(
        new Error(
          "Nothing to mark done — type the values in, or attach the report, before closing this case",
        ),
        { status: 409 },
      );
    }
  }

  const resolvedVisitId = await resolveVisitForCase(db, caseNo);
  const visit = await homeVisit(db, resolvedVisitId);
  refuseSiteForNonHome(site, visit);

  if (action === "report_uploaded" && !undo && (await caseCollectedAtHome(db, caseNo))) {
    await assertHomePaymentCleared(db, resolvedVisitId);
  }

  if ((action === "sample_taken" || action === "drawing_started") && !undo && !drawnAtBench) {
    const what = action === "drawing_started" ? "start the collection" : "collect the sample";
    await assertPatientIsFree(db, resolvedVisitId, what);
    if (!(await isLabOnlyVisit(db, resolvedVisitId))) {
      await assertLabBillingCleared(db, resolvedVisitId);
    }
  }

  if (action === "report_uploaded" && !undo && (await isLabOnlyVisit(db, resolvedVisitId))) {
    await assertLabBillingCleared(db, resolvedVisitId, "the report");
  }

  if (undo) {
    await db.query(
      `DELETE FROM giniflow_lab_case_actions
        WHERE case_no = $1 AND action = ANY($2::text[])`,
      [caseNo, CASE_ACTIONS.slice(CASE_ACTIONS.indexOf(action))],
    );
    if (resolvedVisitId && CASE_ACTIONS.indexOf(action) <= CASE_ACTIONS.indexOf("sample_sent")) {
      await withVisitLock(db, (client) =>
        cancelPauseTx(client, resolvedVisitId, SAMPLE_BREAK_REASON, { actorId, actorRole: "lab" }),
      );
    }
    if (resolvedVisitId) publish({ kind: "lab_order", visitId: resolvedVisitId, status: action });
    return { caseNo, action, undone: true };
  }

  const benchSite = action === "sample_taken" && visit?.home ? "ghm" : null;
  // One row per case per action: tapping twice is the same statement, not two.
  const recordAction = (conn) =>
    conn.query(
      `INSERT INTO giniflow_lab_case_actions
         (case_no, action, actor_role, actor_id, note, collected_at_site, collected_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END)
       ON CONFLICT (case_no, action) DO UPDATE
         SET actor_role = EXCLUDED.actor_role,
             actor_id   = EXCLUDED.actor_id,
             note       = COALESCE(EXCLUDED.note, giniflow_lab_case_actions.note),
             collected_at_site = COALESCE(EXCLUDED.collected_at_site,
                                          giniflow_lab_case_actions.collected_at_site),
             collected_at = COALESCE(EXCLUDED.collected_at, giniflow_lab_case_actions.collected_at)
       RETURNING action, created_at`,
      [caseNo, action, actorRole, actorId, note, benchSite],
    );
  const breakAfter = thenBreak && action === "sample_taken" && !!resolvedVisitId;
  const { rows } =
    action === "drawing_started" && resolvedVisitId
      ? await withVisitLock(db, async (client) => {
          await assertStationFree(client, resolvedVisitId, LAB_STATION, "start the collection");
          await resumeVisitTx(client, resolvedVisitId, { actorId, actorRole: "lab" });
          return recordAction(client);
        })
      : breakAfter
        ? await withVisitLock(db, async (client) => {
            const recorded = await recordAction(client);
            await pauseVisitTx(client, resolvedVisitId, {
              actorId,
              actorRole: "lab",
              reason: SAMPLE_BREAK_REASON,
              meta: { case_no: caseNo },
            });
            return recorded;
          })
        : await recordAction(db);
  if (resolvedVisitId) publish({ kind: "lab_order", visitId: resolvedVisitId, status: action });

  if (resolvedVisitId) await syncLabStepsFromLab(db, resolvedVisitId);

  let markedResultsReady = false;
  if (action === "report_uploaded" && !undo) {
    const { rows: ctx } = await db.query(
      `SELECT lc.patient_id, lc.case_date,
              lc.raw_list_json->'patient'->>'healthray_uid' AS uhid
         FROM lab_cases lc WHERE lc.case_no = $1`,
      [caseNo],
    );
    if (ctx[0]?.patient_id) {
      const ready = await markCaseResultsReady(db, {
        patientId: ctx[0].patient_id,
        caseDate: ctx[0].case_date,
        caseNo,
        uhid: ctx[0].uhid,
      });
      markedResultsReady = ready.rowCount > 0;
    }
  }

  return { caseNo, ...rows[0], markedResultsReady, onBreak: breakAfter };
}

export async function deleteLabCaseReport(caseNo, db = pool) {
  const { rows } = await db.query(
    `SELECT lc.pdf_storage_path,
            EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                     WHERE a.case_no = lc.case_no AND a.action = 'report_uploaded') AS is_done
       FROM lab_cases lc WHERE lc.case_no = $1`,
    [caseNo],
  );
  if (!rows.length) throw Object.assign(new Error(`No such lab case: ${caseNo}`), { status: 404 });
  const { pdf_storage_path: storagePath, is_done: isDone } = rows[0];
  if (!storagePath) {
    throw Object.assign(new Error("There is no report on this case to remove"), { status: 409 });
  }
  if (isDone) {
    throw Object.assign(
      new Error("This case is marked done — undo that first if the report needs replacing"),
      { status: 409 },
    );
  }

  await db.query(`DELETE FROM documents WHERE storage_path = $1`, [storagePath]);
  await db.query(`UPDATE lab_cases SET pdf_storage_path = NULL WHERE case_no = $1`, [caseNo]);
  await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  }).catch(() => {});

  return { caseNo, removed: storagePath };
}
export async function markCaseResultsReady(db, { patientId, caseDate, caseNo, uhid }) {
  const { rowCount } = await db.query(
    `UPDATE giniflow_visits v
        SET results_status = 'ready', updated_at = NOW()
      WHERE v.patient_id = $1
        AND v.visit_date = $2::date
        AND v.results_status <> 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM lab_cases o
           WHERE o.case_date = v.visit_date
             AND o.case_no <> $3
             -- Match the patient properly. COALESCE(o.patient_id, $1) = $1 was
             -- here and is a trap: an unlinked case has a NULL patient_id, so it
             -- matched EVERY patient and blocked every upload. An unlinked case
             -- belongs to this patient only if its UHID says so.
             AND (o.patient_id = $1
                  OR (o.patient_id IS NULL
                      AND o.raw_list_json->'patient'->>'healthray_uid' = $4))
             AND o.raw_detail_json->>'reported_on' IS NULL
             AND o.pdf_storage_path IS NULL
             AND ${LIVE_LAB_CASE_SQL("o")}
             AND NOT EXISTS (
               SELECT 1 FROM lab_results lr WHERE lr.lab_case_no = o.case_no
             )
             AND NOT EXISTS (
               SELECT 1 FROM giniflow_lab_case_actions a
                WHERE a.case_no = o.case_no AND a.action = 'results_ready'
             )
        )
        AND NOT EXISTS (
          SELECT 1 FROM giniflow_lab_orders g
           WHERE g.visit_id = v.id AND g.sample_status NOT IN ('uploaded', 'sent_outside')
        )
      RETURNING v.id`,
    [patientId, caseDate, caseNo, uhid],
  );
  return { rowCount };
}

const OUTSIDE_CASE_SQL = `
  SELECT lc.case_no, lc.case_source, COALESCE(lc.test_names, ARRAY[]::text[]) AS test_names,
         lc.pdf_storage_path IS NOT NULL AS "hasReport",
         ${LIVE_LAB_CASE_SQL("lc")} AS live,
         lc.raw_list_json->>'phlebotomy_status' AS phlebotomy,
         COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'collected_on' AS "collectedOn",
         COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'received_on' AS "receivedOn",
         COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'result_saved_on' AS "resultSavedOn",
         COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' AS "reportedOn",
         COALESCE((SELECT json_agg(json_build_object('action', a.action))
                     FROM giniflow_lab_case_actions a WHERE a.case_no = lc.case_no),
                  '[]'::json) AS actions
    FROM lab_cases lc WHERE lc.case_no = $1`;

export async function caseIsOutsourced(db, c) {
  if (c.case_source === "outsource") return true;
  const names = [...new Set(c.test_names || [])];
  if (!names.length) return false;
  const outsourced = await outsourcedTestNames(db, names);
  return names.every((name) => outsourced.has(name));
}

const hasCaseAction = (c, action) => (c.actions || []).some((a) => a.action === action);

async function outsideCase(db, caseNo) {
  const { rows } = await db.query(OUTSIDE_CASE_SQL, [caseNo]);
  if (!rows.length) throw Object.assign(new Error(`No such lab case: ${caseNo}`), { status: 404 });
  const c = rows[0];
  if (!c.live) {
    throw Object.assign(new Error(`Case ${caseNo} was cancelled — nothing more to record`), {
      status: 409,
    });
  }
  if (!hasCaseAction(c, SENT_OUTSIDE) && !(await caseIsOutsourced(db, c))) {
    throw Object.assign(new Error("Only an outsourced test is sent to an outside lab"), {
      status: 409,
    });
  }
  return c;
}

export async function markCaseSentOutside(
  caseNo,
  { actorId = null, room = null, thenBreak = false } = {},
  db = pool,
) {
  if (room === LAB_ROOMS.PROCESSING) {
    throw Object.assign(new Error("The collection room sends samples to the outside lab"), {
      status: 403,
    });
  }
  await assertNotHeld(db, { caseNo });
  const c = await outsideCase(db, caseNo);
  if (hasCaseAction(c, SENT_OUTSIDE)) return { caseNo, action: SENT_OUTSIDE, unchanged: true };
  let onBreak = false;
  if (!isCollected(c)) {
    if (stageIndex(c) < stageIndexOf("drawing")) {
      throw Object.assign(
        new Error("Start the collection first, then send the sample to the outside lab"),
        { status: 409 },
      );
    }
    onBreak = (
      await markLabCaseAction(
        caseNo,
        { action: "sample_taken", actorId, actorRole: "lab", room, thenBreak, drawnAtBench: true },
        db,
      )
    ).onBreak;
  }
  if (c.reportedOn || c.hasReport || hasCaseAction(c, "report_uploaded")) {
    throw Object.assign(new Error("The report for this case is already in"), { status: 409 });
  }
  await db.query(
    `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role, actor_id)
     VALUES ($1, $2, 'lab', $3)
     ON CONFLICT (case_no, action) DO NOTHING`,
    [caseNo, SENT_OUTSIDE, actorId],
  );
  const visitId = await resolveVisitForCase(db, caseNo);
  if (visitId) {
    publish({ kind: "lab_order", visitId, status: SENT_OUTSIDE });
    await syncLabStepsFromLab(db, visitId);
  }
  return { caseNo, action: SENT_OUTSIDE, unchanged: false, onBreak };
}

export async function uploadOutsideCaseReport(caseNo, { replace = false, ...input }, db = pool) {
  const c = await outsideCase(db, caseNo);
  const { rows } = await db.query(`SELECT pdf_storage_path FROM lab_cases WHERE case_no = $1`, [
    caseNo,
  ]);
  const previous = rows[0]?.pdf_storage_path ?? null;
  if (!replace || !previous || !c.hasReport) return uploadLabCaseReport(caseNo, input, db);
  const result = await uploadLabCaseReport(caseNo, { ...input, confirmAdditional: true }, db);
  if (result.storagePath !== previous) {
    await db.query(`DELETE FROM documents WHERE storage_path = $1`, [previous]);
    await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${previous}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    }).catch(() => {});
  }
  return { ...result, replaced: true };
}

export async function uploadLabCaseReport(
  caseNo,
  { base64, fileName, mediaType = "application/pdf", actorId = null, confirmAdditional = false },
  db = pool,
) {
  if (!base64) throw Object.assign(new Error("No file was sent"), { status: 400 });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw Object.assign(new Error("Storage is not configured"), { status: 503 });
  }

  const { rows } = await db.query(
    `SELECT lc.case_no, lc.case_date::text AS case_date, lc.pdf_storage_path,
            COALESCE(lc.patient_id, uid.id) AS patient_id,
            COALESCE(p.file_no, lc.raw_list_json->'patient'->>'healthray_uid') AS uhid,
            array_to_string(lc.test_names, ', ') AS tests
       FROM lab_cases lc
       LEFT JOIN patients uid ON uid.file_no = lc.raw_list_json->'patient'->>'healthray_uid'
       LEFT JOIN patients p ON p.id = lc.patient_id
      WHERE lc.case_no = $1`,
    [caseNo],
  );
  if (!rows.length) throw Object.assign(new Error("Lab case not found"), { status: 404 });
  await assertNotHeld(db, { caseNo });
  const c = rows[0];
  if (!c.patient_id) {
    throw Object.assign(new Error("This case is not linked to a patient yet"), { status: 409 });
  }
  const visitId = await resolveVisitForCase(db, caseNo);
  if (await isLabOnlyVisit(db, visitId)) {
    await assertLabBillingCleared(db, visitId, "the report");
  }
  if (c.pdf_storage_path && !confirmAdditional) {
    throw Object.assign(new Error("A report is already on this case"), {
      status: 409,
      needsConfirmation: "additional_report",
      existingSource: "hospital lab",
    });
  }

  const buffer = Buffer.from(base64, "base64");
  const MAX_BYTES = 5 * 1024 * 1024;
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error("Report is larger than 5 MB"), { status: 413 });
  }

  const ext = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/png" ? "png" : "pdf";
  const safeName = String(fileName || `lab_case_${caseNo}.${ext}`).replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `patients/${c.patient_id}/lab/${safeName}`;

  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": mediaType,
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!resp.ok) {
    throw Object.assign(new Error(`Upload failed: ${await resp.text()}`), { status: 502 });
  }

  await db.query(
    `INSERT INTO documents
       (patient_id, doc_type, title, file_name, storage_path, mime_type, doc_date, source, notes)
     VALUES ($1, 'lab_report', $2, $3, $4, $5, $6::date, 'lab_healthray', $7)
     ON CONFLICT DO NOTHING`,
    [
      c.patient_id,
      clipText(c.tests ? `Lab Report - ${caseNo} — ${c.tests}` : `Lab Report - ${caseNo}`, 200),
      clipText(safeName, 200),
      storagePath,
      mediaType,
      c.case_date,
      `lab_case:${caseNo}`,
    ],
  );

  await db.query(
    `UPDATE lab_cases
        SET pdf_storage_path = $2, pdf_unavailable = FALSE, pdf_next_attempt_at = NULL
      WHERE case_no = $1`,
    [caseNo, storagePath],
  );
  const ready = await markCaseResultsReady(db, {
    patientId: c.patient_id,
    caseDate: c.case_date,
    caseNo,
    uhid: c.uhid,
  });

  return {
    caseNo,
    storagePath,
    fileName: safeName,
    bytes: buffer.length,
    markedResultsReady: ready.rowCount > 0,
  };
}
