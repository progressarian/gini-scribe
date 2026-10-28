import {
  JOURNEY_START_SQL,
  JOURNEY_START_STATUSES,
  WAIT_SINCE_SQL,
  hasNotStarted,
  isSampleBreak,
  canTransition,
  isMarkerStatus,
  chainIndex,
  isChainStatus,
  isKnownStatus,
  isWaitStatus,
  isTerminalStatus,
  isExceptionStatus,
  slaKeyForStatus,
  STATION_STATUSES,
  STATUS_LABEL,
  TERMINAL_STATUSES,
  VITALS_REST_MINUTES,
} from "../../../shared/giniflowStatus.js";
import {
  NOT_ON_BILL_REASON,
  testCancelReasonLabel,
  urgentCancelReasonLabel,
} from "../../../shared/testCancelReasons.js";

import { TESTS_HOLD_SQL } from "./testsHold.js";

import { skipsChiefStop, syncFromStatus } from "./journey.js";
import { assertCoordinatorDone, syncHoldIn } from "./coordinatorHold.js";
import { ARRIVED_FOR_APPOINTMENT, LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import { CONSULT_STATUSES } from "../../../shared/labOnly.js";
import { FLOOR_DONE_LAB_STATUSES } from "../../../shared/labStages.js";
import { MACHINE_RUNGS } from "../../../shared/machineStages.js";
import pool from "../../config/db.js";

export const IST_TODAY = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

const HOLD_ARRIVAL_STATUSES = ["doctor_done", "rx_pending"];

const CANCEL_REQUEST_MARKERS = ["cancel_requested", "cancel_rejected", "cancel_withdrawn"];

export const budgetColour = (minutes, budget) => {
  if (!budget) return "neutral";
  const pct = (minutes / budget) * 100;
  if (pct > 100) return "red";
  if (pct >= 80) return "amber";
  return "green";
};

const minutesBetween = (from, to) => Math.max(0, Math.round((to - from) / 60000));
const isLabOnlyVisit = async (client, visitId) => {
  const { rows } = await client.query(
    `SELECT ${labOnlyPredicate("v", "$2")} AS lab_only
       FROM giniflow_visits v WHERE v.id = $1`,
    [visitId, LAB_ONLY_DOCTOR],
  );
  return !!rows[0]?.lab_only;
};

async function assertNotLabOnly(client, visitId, toStatus) {
  if (!CONSULT_STATUSES.includes(toStatus)) return;
  if (await isLabOnlyVisit(client, visitId)) {
    throw new Error(
      `Samples-only visit cannot enter the consultation flow: ${toStatus}. ` +
        `Assign a consultant to this patient first.`,
    );
  }
}

export const NO_CHIEF_STEP_REASON = "plan_has_no_chief_step";

const DOCTOR_STATUSES = ["sd_pending", "with_sd", "ready_for_doctor", "with_doctor"];
const REPORTED_SAMPLE_STATUSES = [
  ...new Set([
    ...FLOOR_DONE_LAB_STATUSES,
    ...MACHINE_RUNGS.filter((r) => r.key === "reported").flatMap((r) => r.sampleStatuses),
  ]),
];

const QUEUED_WITHOUT_CHIEF_SQL = `COALESCE(meta->>'reason', '') <> '${NO_CHIEF_STEP_REASON}'`;

async function assertReportsAreIn(client, visitId, toStatus, meta) {
  if (!DOCTOR_STATUSES.includes(toStatus)) return;
  if (toStatus === "ready_for_doctor" && meta?.reason === NO_CHIEF_STEP_REASON) return;
  const { rows: been } = await client.query(
    `SELECT 1 FROM giniflow_visit_events
      WHERE visit_id = $1 AND status = ANY($2::text[]) AND ${QUEUED_WITHOUT_CHIEF_SQL} LIMIT 1`,
    [visitId, DOCTOR_STATUSES],
  );
  if (been.length) return;

  const { rows } = await client.query(
    `SELECT count(*)::int AS outstanding,
            string_agg(DISTINCT t.test_name, ', ') AS tests
       FROM giniflow_lab_orders o
       LEFT JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1
        AND o.urgency = 'today'
        AND o.sample_status <> ALL($2::text[])`,
    [visitId, REPORTED_SAMPLE_STATUSES],
  );
  const { outstanding, tests } = rows[0];
  if (outstanding > 0) {
    throw Object.assign(
      new Error(
        `${outstanding} test${outstanding === 1 ? "" : "s"} still waiting on a report` +
          `${tests ? ` (${tests})` : ""} — the patient sees the doctor once every report is in`,
      ),
      { status: 409 },
    );
  }
}

const SYNC_MAY_MOVE_WITH_TESTS_OPEN = ["checked_in", "vitals_done"];

const openTestCount = async (client, visitId) => {
  const { rows } = await client.query(
    `SELECT h.tests_pending
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       CROSS JOIN LATERAL (${TESTS_HOLD_SQL("v", "p")}) h
      WHERE v.id = $1`,
    [visitId],
  );
  return rows[0]?.tests_pending ?? 0;
};

async function assertNoExitWithTestsOpen(client, visitId, toStatus, actorRole) {
  if (!TERMINAL_STATUSES.includes(toStatus) || actorRole === "system") return;
  const pending = await openTestCount(client, visitId);
  if (pending > 0) {
    throw Object.assign(
      new Error(
        `${pending} test${pending === 1 ? "" : "s"} still open — finish or remove ${pending === 1 ? "it" : "them"} before the patient leaves`,
      ),
      { status: 409, testsOpen: pending },
    );
  }
}

async function assertSyncLeavesTestsAlone(client, visitId, toStatus, meta) {
  if (meta?.source !== "healthray") return;
  if (isExceptionStatus(toStatus) || SYNC_MAY_MOVE_WITH_TESTS_OPEN.includes(toStatus)) return;
  const pending = await openTestCount(client, visitId);
  if (pending > 0) {
    throw Object.assign(
      new Error(
        `HealthRay may not move this patient to ${toStatus}: ${pending} test${pending === 1 ? "" : "s"} still open in Scribe`,
      ),
      { status: 409 },
    );
  }
}
export async function advanceStatus(
  client,
  {
    visitId,
    toStatus,
    actorRole = "system",
    actorId = null,
    meta = {},
    occurredAt = null,
    blockedReason = null,
    allowSkip = false,
  },
) {
  if (!isKnownStatus(toStatus)) {
    throw new Error(`Unknown status: ${toStatus}`);
  }
  if (toStatus === "blocked_reports" && !blockedReason) {
    throw new Error("Blocking a visit requires a reason");
  }

  const current = await client.query(
    `SELECT current_status, resume_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
    [visitId],
  );
  if (!current.rows.length) throw new Error(`No such visit: ${visitId}`);

  const fromStatus = current.rows[0].current_status;
  await assertNotLabOnly(client, visitId, toStatus);
  if (
    !isChainStatus(fromStatus) ||
    !isChainStatus(toStatus) ||
    chainIndex(toStatus) > chainIndex(fromStatus)
  ) {
    await assertReportsAreIn(client, visitId, toStatus, meta);
    await assertCoordinatorDone(client, visitId, toStatus);
  }
  await assertSyncLeavesTestsAlone(client, visitId, toStatus, meta);
  await assertNoExitWithTestsOpen(client, visitId, toStatus, actorRole);
  const skipping =
    allowSkip && isChainStatus(fromStatus) && isChainStatus(toStatus)
      ? chainIndex(toStatus) > chainIndex(fromStatus)
      : false;
  if (!skipping && !canTransition(fromStatus, toStatus, current.rows[0].resume_status)) {
    throw new Error(
      `Illegal transition: ${fromStatus} → ${toStatus}` +
        (current.rows[0].resume_status ? ` (blocked from ${current.rows[0].resume_status})` : ""),
    );
  }

  const patientIsHere =
    [...STATION_STATUSES, "dispensed"].includes(toStatus) ||
    (actorRole !== "system" && hasNotStarted(fromStatus));
  if (patientIsHere && !occurredAt && !isExceptionStatus(toStatus)) {
    await resumeVisitTx(client, visitId, { actorId, actorRole });
  }

  const event = await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, occurred_at, meta)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, clock_timestamp()), $6)
     RETURNING id, status, actor_role, actor_id, occurred_at, meta`,
    [visitId, toStatus, actorRole, actorId, occurredAt, meta],
  );

  await client.query(
    `UPDATE giniflow_visits
        SET current_status = $2,
            resume_status  = CASE WHEN $2 = 'blocked_reports' THEN $3
                                  WHEN $2 = 'back_for_tests' THEN 'exited' ELSE NULL END,
            blocked_reason = CASE WHEN $2 = 'blocked_reports' THEN $4 ELSE NULL END,
            -- A manual queue position means "call this one next AT THIS
            -- STATION". Once the patient has moved on it describes a queue they
            -- are no longer in, so it is dropped and they rejoin the next column
            -- on priority and waiting time. Priority is a property of the
            -- patient and deliberately survives.
            queue_position = NULL,
            queue_column   = NULL,
            updated_at     = NOW()
      WHERE id = $1`,
    [visitId, toStatus, fromStatus, blockedReason],
  );
  if (TERMINAL_STATUSES.includes(toStatus)) {
    await client.query(
      `UPDATE giniflow_visits
          SET paused_ms_total = paused_ms_total
                + GREATEST(0, (EXTRACT(EPOCH FROM (NOW() - paused_at)) * 1000)::bigint),
              paused_at = NULL, paused_by = NULL, paused_reason = NULL
        WHERE id = $1 AND paused_at IS NOT NULL`,
      [visitId],
    );
  }

  await syncFromStatus(client, visitId, toStatus, meta);
  if (HOLD_ARRIVAL_STATUSES.includes(toStatus)) await syncHoldIn(client, visitId);

  if (
    toStatus === "vitals_done" &&
    (await skipsChiefStop(client, visitId)) &&
    !(await isLabOnlyVisit(client, visitId))
  ) {
    const next = await advanceStatus(client, {
      visitId,
      toStatus: "ready_for_doctor",
      actorRole: "system",
      allowSkip: true,
      meta: { reason: NO_CHIEF_STEP_REASON, after: "vitals_done" },
    });
    return { ...next, from: fromStatus };
  }

  return { from: fromStatus, ...event.rows[0] };
}
export async function returnToQueue(
  client,
  { visitId, toStatus, actorRole = "system", actorId = null, meta = {} },
) {
  const event = await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, status, actor_role, occurred_at, meta`,
    [visitId, toStatus, actorRole, actorId, { ...meta, released: true }],
  );
  await client.query(
    `UPDATE giniflow_visits
        SET current_status = $2, queue_position = NULL, queue_column = NULL, updated_at = NOW()
      WHERE id = $1`,
    [visitId, toStatus],
  );
  await syncFromStatus(client, visitId, toStatus);
  return event.rows[0];
}
const LAB_ONLY_LABEL = {
  vitals_done: "Vitals done",
  sd_pending: "Waiting",
  ready_for_doctor: "Waiting",
};

const SKIPPED_STATION_NAME = {
  with_vitals: "Vitals",
  with_sd: "Chief Endocrinologist",
  with_doctor: "Consultant",
  with_rx: "Prescription Explain",
};

const markerLabel = (row) => {
  const base = STATUS_LABEL[row.status] || row.status;
  if (row.status === "paused" && isSampleBreak(row.meta?.reason)) return "On break — sample given";
  if (row.status === "resumed" && row.meta?.cancelled) return "Break cancelled — sample undone";
  if (row.status === "test_restored") {
    return row.meta?.tests?.length ? `${base} — ${row.meta.tests.join(", ")}` : base;
  }
  const what = [...(row.meta?.tests || []), ...(row.meta?.cases || []).map((c) => `case ${c}`)];
  const head = what.length ? `${base} — ${what.join(", ")}` : base;
  if (CANCEL_REQUEST_MARKERS.includes(row.status)) {
    const why =
      row.status === "cancel_requested"
        ? urgentCancelReasonLabel(row.meta?.reason)
        : row.meta?.note;
    return why ? `${head} · ${why}` : head;
  }
  if (row.status !== "test_cancelled") return base;
  const reason = testCancelReasonLabel(row.meta?.reason);
  const kept =
    row.meta?.charge !== undefined
      ? ` · ₹${(row.meta.charge / 100).toLocaleString("en-IN")} kept`
      : "";
  return reason ? `${head} · ${reason}${kept}` : head;
};

export async function getStationTimes(
  db,
  visitId,
  slaConfig,
  now = new Date(),
  {
    slaConfig: slaRows = null,
    category = null,
    unbudgeted = false,
    labReadyAt = null,
    labPending = false,
    labOrderedAt = null,
    segments = [],
    orderTimes = [],
    restSkipped = false,
    vitalsPlannedAt = null,
  } = {},
) {
  const overrideFor = (station) => {
    if (!slaRows || !category) return null;
    const v = slaRows.find((r) => r.station === station)?.categoryOverrides?.[category];
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const { rows: allRows } = await db.query(
    `SELECT status, actor_role, occurred_at, meta
       FROM giniflow_visit_events
      WHERE visit_id = $1
      ORDER BY date_trunc('milliseconds', occurred_at), seq`,
    [visitId],
  );
  const appointmentArrival = allRows.findLast(
    (r) => r.status === "checked_in" && r.meta?.reason === ARRIVED_FOR_APPOINTMENT,
  );
  const rows = appointmentArrival
    ? allRows.filter((r) => new Date(r.occurred_at) >= new Date(appointmentArrival.occurred_at))
    : allRows;

  const stationsSkipped = (from, to) =>
    isChainStatus(from) && isChainStatus(to)
      ? STATION_STATUSES.filter(
          (st) => chainIndex(st) > chainIndex(from) && chainIndex(st) < chainIndex(to),
        )
      : [];
  const chiefNotPlanned = (next) => next?.meta?.reason === NO_CHIEF_STEP_REASON;
  const skippedBetween = (row, next) =>
    stationsSkipped(row.status, next.status).filter(
      (st) =>
        !(st === "with_vitals" && next.status === "vitals_done" && next.actor_role !== "system") &&
        !(st === "with_sd" && chiefNotPlanned(next)),
    );

  const statusRows = rows.filter((r) => !isMarkerStatus(r.status));
  const markerRows = rows.filter(
    (r) =>
      isMarkerStatus(r.status) &&
      !(r.status === "test_cancelled" && r.meta?.reason === NOT_ON_BILL_REASON),
  );

  const raw = statusRows.map((row, i) => {
    const enteredAt = new Date(row.occurred_at);
    const next = statusRows[i + 1];
    const leftAt = next ? new Date(next.occurred_at) : null;
    const ended = !next && isTerminalStatus(row.status);
    const marker = !isKnownStatus(row.status);
    const minutes =
      isTerminalStatus(row.status) || marker ? 0 : minutesBetween(enteredAt, leftAt || now);
    return {
      timestampOnly: marker,
      unrecorded: !!next && minutes >= 1 && skippedBetween(row, next).length > 0,
      status: row.status,
      label:
        (unbudgeted ? LAB_ONLY_LABEL[row.status] : null) ||
        (row.status === "vitals_done" && chiefNotPlanned(next) ? "Vitals done" : null) ||
        STATUS_LABEL[row.status] ||
        row.status,
      actorRole: row.actor_role,
      meta: row.meta,
      enteredAt,
      leftAt,
      minutes,
      isCurrent: !next && !ended,
      isWait: isWaitStatus(row.status),
      budgetMinutes: unbudgeted
        ? null
        : (overrideFor(slaKeyForStatus(row.status)) ??
          slaConfig[slaKeyForStatus(row.status)] ??
          null),
    };
  });

  const AWAITING_LAB_LABEL = "Waiting for test reports";
  const blockedByLab = (entry) =>
    entry.isWait && slaKeyForStatus(entry.status) === "wait_sd" && !entry.unrecorded;

  const ROOMS_THAT_ORDER = ["with_sd", "with_doctor"];
  const cut = (intervals, holes) =>
    holes.reduce(
      (acc, [hs, he]) =>
        acc.flatMap(([s, e]) =>
          he <= s || hs >= e
            ? [[s, e]]
            : [...(hs > s ? [[s, hs]] : []), ...(he < e ? [[he, e]] : [])],
        ),
      intervals,
    );
  const consults = raw.flatMap((entry) => {
    if (!ROOMS_THAT_ORDER.includes(entry.status) || entry.timestampOnly) return [];
    const end = entry.leftAt || now;
    const ordered = orderTimes.filter((t) => t > entry.enteredAt && t <= end);
    return ordered.length ? [[entry.enteredAt, new Date(Math.max(...ordered))]] : [];
  });
  const atVitals = raw
    .filter((entry) => entry.status === "with_vitals" && !entry.timestampOnly)
    .map((entry) => [entry.enteredAt, entry.leftAt || now]);
  const awaySteps = segments.flatMap((seg) =>
    cut([[seg.from, seg.to || now]], [...consults, ...atVitals])
      .filter(([a, b]) => b > a)
      .map(([a, b]) => ({
        timestampOnly: false,
        unrecorded: false,
        status: seg.status,
        label: seg.label,
        actorRole: null,
        meta: null,
        enteredAt: a,
        leftAt: seg.to && b >= seg.to ? seg.to : b < now ? b : null,
        minutes: minutesBetween(a, b),
        isCurrent: !seg.to && b >= now,
        isWait: !!seg.isWait,
        budgetMinutes: seg.budgetMinutes ?? null,
      })),
  );
  const awayIntervals = awaySteps.map((a) => [a.enteredAt, a.leftAt || now]);
  const withAway = [
    ...raw.flatMap((entry) => {
      if (entry.timestampOnly || !awayIntervals.length || entry.status === "with_vitals")
        return [entry];
      const end = entry.leftAt || now;
      return cut([[entry.enteredAt, end]], awayIntervals)
        .filter(([a, b]) => b > a)
        .map(([a, b]) => ({
          ...entry,
          enteredAt: a,
          leftAt: b >= end ? entry.leftAt : b,
          minutes: minutesBetween(a, b),
          isCurrent: b >= end ? entry.isCurrent : false,
        }));
    }),
    ...awaySteps,
  ].sort((a, b) => a.enteredAt - b.enteredAt);

  const withLabSplit = withAway.flatMap((entry) => {
    if (!blockedByLab(entry)) return [entry];
    if (!labPending && !labReadyAt) return [entry];
    const endsAt = entry.leftAt || now;
    const holdFrom =
      labOrderedAt && labOrderedAt > entry.enteredAt ? labOrderedAt : entry.enteredAt;
    const holdTo = labPending ? endsAt : labReadyAt < endsAt ? labReadyAt : endsAt;
    if (holdFrom >= endsAt || holdTo <= holdFrom) return [entry];
    const piece = (from, to, extra = {}) => ({
      ...entry,
      enteredAt: from,
      leftAt: to >= endsAt ? entry.leftAt : to,
      minutes: minutesBetween(from, to),
      isCurrent: to >= endsAt ? entry.isCurrent : false,
      ...extra,
    });
    return [
      holdFrom > entry.enteredAt ? piece(entry.enteredAt, holdFrom) : null,
      piece(holdFrom, holdTo, {
        label: AWAITING_LAB_LABEL,
        budgetMinutes: null,
        awaitingLab: true,
      }),
      holdTo < endsAt ? piece(holdTo, endsAt) : null,
    ].filter(Boolean);
  });

  const LAB_COLLECTION_LABEL = "At the lab — sample collection";
  const VITALS_NOT_PLANNED_LABEL = "Not recorded — Vitals was not on the journey yet";
  const VITALS_QUEUES = ["checked_in", "vitals_pending"];
  const beforeVitalsPlanned = (entry) =>
    vitalsPlannedAt &&
    entry.isWait &&
    !entry.timestampOnly &&
    !entry.awaitingLab &&
    VITALS_QUEUES.includes(entry.status) &&
    entry.enteredAt < vitalsPlannedAt;
  const withVitalsPlan = withLabSplit.flatMap((entry) => {
    if (!beforeVitalsPlanned(entry)) return [entry];
    const endsAt = entry.leftAt || now;
    const cutAt = endsAt < vitalsPlannedAt ? endsAt : vitalsPlannedAt;
    const toLab = awaySteps.some((a) => a.enteredAt.getTime() === cutAt.getTime());
    return [
      {
        ...entry,
        label: toLab ? LAB_COLLECTION_LABEL : VITALS_NOT_PLANNED_LABEL,
        unrecorded: !toLab,
        beforePlan: true,
        budgetMinutes: null,
        leftAt: cutAt >= endsAt ? entry.leftAt : cutAt,
        minutes: minutesBetween(entry.enteredAt, cutAt),
        isCurrent: cutAt >= endsAt ? entry.isCurrent : false,
      },
      cutAt < endsAt
        ? {
            ...entry,
            status: "vitals_pending",
            label: STATUS_LABEL.vitals_pending || entry.label,
            afterPlan: true,
            enteredAt: cutAt,
            minutes: minutesBetween(cutAt, endsAt),
          }
        : null,
    ].filter(Boolean);
  });

  const steps = [];
  let wait = null;
  const WORST = { red: 3, amber: 2, green: 1, neutral: 0 };
  const worse = (a, b) => (WORST[a] >= WORST[b] ? a : b);

  const arrivedRow = statusRows.find((r) => JOURNEY_START_STATUSES.includes(r.status));
  const arrivedAt = arrivedRow ? new Date(arrivedRow.occurred_at) : null;
  const restFrom =
    arrivedAt && !restSkipped
      ? vitalsPlannedAt && vitalsPlannedAt > arrivedAt
        ? vitalsPlannedAt
        : arrivedAt
      : null;
  const restTo = restFrom ? new Date(restFrom.getTime() + VITALS_REST_MINUTES * 60000) : null;
  const restInWait = (entry) => {
    const status = wait?.status ?? (entry.isWait ? entry.status : null);
    if (!restFrom || QUEUE_FEEDS[status] !== "with_vitals") return 0;
    if ((wait ?? entry).beforePlan) return 0;
    const from = wait?.enteredAt ?? entry.enteredAt;
    const to = entry.isWait ? entry.leftAt || now : entry.enteredAt;
    const overlapFrom = from > restFrom ? from : restFrom;
    const overlapTo = to < restTo ? to : restTo;
    return overlapTo > overlapFrom ? minutesBetween(overlapFrom, overlapTo) : 0;
  };

  const emit = (entry) => {
    const restMinutes = restInWait(entry);
    const waitMinutes = Math.max(
      0,
      (wait ? wait.minutes : 0) + (entry.isWait ? entry.minutes : 0) - restMinutes,
    );
    const waitBudget = entry.unrecorded
      ? null
      : (wait?.budgetMinutes ?? (entry.isWait ? entry.budgetMinutes : null));
    const stationMinutes = entry.isWait ? 0 : entry.minutes;
    const stationBudget = entry.isWait || entry.unrecorded ? null : entry.budgetMinutes;
    const overBy =
      Math.max(0, waitBudget ? waitMinutes - waitBudget : 0) +
      Math.max(0, stationBudget ? stationMinutes - stationBudget : 0);
    steps.push({
      status: entry.status,
      timestampOnly: !!entry.timestampOnly,
      label: entry.label,
      unrecorded: !!entry.unrecorded,
      awaitingLab: !!entry.awaitingLab,
      actorRole: entry.actorRole,
      meta: entry.meta,
      enteredAt: (wait?.enteredAt ?? entry.enteredAt).toISOString(),
      stationAt: entry.isWait ? null : entry.enteredAt.toISOString(),
      waitStatus: wait?.afterPlan ? null : (wait?.status ?? null),
      leftAt: entry.leftAt ? entry.leftAt.toISOString() : null,
      restMinutes,
      restUntil: restMinutes && restTo ? restTo.toISOString() : null,
      waitMinutes,
      waitBudget,
      stationMinutes,
      stationBudget,
      totalMinutes: waitMinutes + stationMinutes,
      budgetMinutes: (waitBudget || 0) + (stationBudget || 0) || null,
      overBy,
      colour: worse(
        budgetColour(waitMinutes, waitBudget),
        budgetColour(stationMinutes, stationBudget),
      ),
      isCurrent: entry.isCurrent,
    });
    wait = null;
  };

  const QUEUE_FEEDS = {
    checked_in: "with_vitals",
    vitals_pending: "with_vitals",
    vitals_done: "with_sd",
    sd_pending: "with_sd",
    ready_for_doctor: "with_doctor",
    rx_pending: "with_rx",
  };

  for (const entry of withVitalsPlan) {
    if (entry.isWait && !entry.isCurrent) {
      if (
        wait &&
        (QUEUE_FEEDS[wait.status] !== QUEUE_FEEDS[entry.status] ||
          !QUEUE_FEEDS[entry.status] ||
          !!wait.awaitingLab !== !!entry.awaitingLab ||
          !!wait.beforePlan !== !!entry.beforePlan)
      ) {
        const pending = wait;
        wait = null;
        emit({ ...pending, isCurrent: false, leftAt: entry.enteredAt });
      }
      wait = wait
        ? {
            ...wait,
            minutes: wait.minutes + entry.minutes,
            budgetMinutes: entry.budgetMinutes ?? wait.budgetMinutes,
          }
        : entry;
      continue;
    }
    // Nothing to pair with: the wait stands as its own step, named for itself.
    const sameQueue =
      wait &&
      entry.isWait &&
      !!QUEUE_FEEDS[entry.status] &&
      QUEUE_FEEDS[wait.status] === QUEUE_FEEDS[entry.status] &&
      !!wait.awaitingLab === !!entry.awaitingLab;
    if (
      wait &&
      !sameQueue &&
      (QUEUE_FEEDS[wait.status] !== entry.status || wait.awaitingLab || wait.beforePlan)
    ) {
      const pending = wait;
      wait = null;
      emit({ ...pending, isCurrent: false, leftAt: entry.enteredAt });
    }
    emit(entry);
  }
  if (wait) emit({ ...wait, minutes: 0, isCurrent: true, isWait: true, leftAt: null });

  const collapsed = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const next = steps[i + 1];
    const glance =
      STATION_STATUSES.includes(step.status) &&
      step.stationMinutes === 0 &&
      next &&
      QUEUE_FEEDS[next.status] === step.status;
    if (!glance) {
      collapsed.push(step);
      continue;
    }
    next.waitMinutes += step.waitMinutes;
    next.restMinutes += step.restMinutes;
    next.restUntil = next.restUntil || step.restUntil;
    next.enteredAt = step.enteredAt;
    next.totalMinutes = next.waitMinutes + next.stationMinutes;
    next.overBy =
      Math.max(0, next.waitBudget ? next.waitMinutes - next.waitBudget : 0) +
      Math.max(0, next.stationBudget ? next.stationMinutes - next.stationBudget : 0);
    next.colour = worse(
      budgetColour(next.waitMinutes, next.waitBudget),
      budgetColour(next.stationMinutes, next.stationBudget),
    );
    collapsed.push({
      ...step,
      timestampOnly: true,
      label: `${SKIPPED_STATION_NAME[step.status] || step.label} — opened, then returned to the queue`,
      enteredAt: step.leftAt || step.enteredAt,
      waitMinutes: 0,
      stationMinutes: 0,
      totalMinutes: 0,
      waitBudget: null,
      stationBudget: null,
      budgetMinutes: null,
      overBy: 0,
      colour: "neutral",
    });
  }

  const merged = [];
  for (const step of collapsed) {
    const prev = merged[merged.length - 1];
    if (!prev || prev.status !== step.status || prev.awaitingLab !== step.awaitingLab) {
      merged.push({ ...step, visits: 1 });
      continue;
    }
    prev.waitMinutes += step.waitMinutes;
    prev.restMinutes += step.restMinutes;
    prev.stationMinutes += step.stationMinutes;
    prev.totalMinutes = prev.waitMinutes + prev.stationMinutes;
    prev.overBy =
      Math.max(0, prev.waitBudget ? prev.waitMinutes - prev.waitBudget : 0) +
      Math.max(0, prev.stationBudget ? prev.stationMinutes - prev.stationBudget : 0);
    prev.colour = worse(
      budgetColour(prev.waitMinutes, prev.waitBudget),
      budgetColour(prev.stationMinutes, prev.stationBudget),
    );
    prev.leftAt = step.leftAt;
    prev.isCurrent = step.isCurrent;
    prev.visits += 1;
  }
  const skipped = statusRows.flatMap((row, i) => {
    const next = statusRows[i + 1];
    if (!next) return [];
    return skippedBetween(row, next).map((station) => ({
      rank: i + 0.5,
      status: `skipped:${station}`,
      timestampOnly: true,
      skipped: true,
      label: `${SKIPPED_STATION_NAME[station] || STATUS_LABEL[station] || station} — not recorded on a station screen`,
      actorRole: null,
      meta: null,
      enteredAt: new Date(next.occurred_at).toISOString(),
      leftAt: null,
      waitMinutes: 0,
      waitBudget: null,
      stationMinutes: 0,
      stationBudget: null,
      totalMinutes: 0,
      budgetMinutes: null,
      overBy: 0,
      colour: "neutral",
      isCurrent: false,
      visits: 1,
    }));
  });

  const vitalsSavedDirectly = statusRows.flatMap((row, i) => {
    const next = statusRows[i + 1];
    if (!next || next.status !== "vitals_done" || next.actor_role === "system") return [];
    if (!stationsSkipped(row.status, next.status).includes("with_vitals")) return [];
    return [
      {
        rank: i + 0.5,
        status: "vitals_recorded",
        timestampOnly: true,
        label: "Vitals recorded",
        actorRole: next.actor_role,
        meta: next.meta,
        enteredAt: new Date(next.occurred_at).toISOString(),
        leftAt: null,
        waitMinutes: 0,
        waitBudget: null,
        stationMinutes: 0,
        stationBudget: null,
        totalMinutes: 0,
        budgetMinutes: null,
        overBy: 0,
        colour: "neutral",
        isCurrent: false,
        visits: 1,
      },
    ];
  });

  const eventRank = new Map(
    statusRows.map((row, i) => [`${row.status}|${new Date(row.occurred_at).getTime()}`, i]),
  );
  const rankOf = (entry) =>
    entry.rank ?? eventRank.get(`${entry.status}|${new Date(entry.enteredAt).getTime()}`) ?? null;

  const arrivedBeforeBreak = statusRows
    .filter((row) => JOURNEY_START_STATUSES.includes(row.status) && row.meta?.original_occurred_at)
    .map((row) => ({
      status: "arrived_before_break",
      timestampOnly: true,
      label: "Arrived — break time is not counted",
      actorRole: row.actor_role,
      meta: row.meta,
      enteredAt: new Date(row.meta.original_occurred_at).toISOString(),
      leftAt: null,
      waitMinutes: 0,
      waitBudget: null,
      stationMinutes: 0,
      stationBudget: null,
      totalMinutes: 0,
      budgetMinutes: null,
      overBy: 0,
      colour: "neutral",
      isCurrent: false,
      visits: 1,
    }));

  const firstPiece = withVitalsPlan.find((entry) => !entry.timestampOnly);
  const arrivalBeforePlan =
    firstPiece?.beforePlan && arrivedRow
      ? [
          {
            status: "arrived",
            timestampOnly: true,
            label: STATUS_LABEL[arrivedRow.status] || arrivedRow.status,
            actorRole: arrivedRow.actor_role,
            meta: arrivedRow.meta,
            enteredAt: new Date(arrivedRow.occurred_at).toISOString(),
            leftAt: null,
            waitMinutes: 0,
            waitBudget: null,
            stationMinutes: 0,
            stationBudget: null,
            totalMinutes: 0,
            budgetMinutes: null,
            overBy: 0,
            colour: "neutral",
            isCurrent: false,
            visits: 1,
          },
        ]
      : [];

  const withMarkers = [
    ...skipped,
    ...vitalsSavedDirectly,
    ...merged,
    ...arrivedBeforeBreak,
    ...arrivalBeforePlan,
    ...markerRows.map((row) => ({
      status: row.status,
      timestampOnly: true,
      label: markerLabel(row),
      actorRole: row.actor_role,
      meta: row.meta,
      enteredAt: new Date(row.occurred_at).toISOString(),
      leftAt: null,
      waitMinutes: 0,
      waitBudget: null,
      stationMinutes: 0,
      stationBudget: null,
      totalMinutes: 0,
      budgetMinutes: null,
      overBy: 0,
      colour: "neutral",
      isCurrent: false,
      visits: 1,
    })),
  ]
    .sort((a, b) => {
      const byTime = new Date(a.enteredAt) - new Date(b.enteredAt);
      if (byTime) return byTime;
      const [ra, rb] = [rankOf(a), rankOf(b)];
      if (ra !== null && rb !== null && ra !== rb) return ra - rb;
      return Number(!!b.timestampOnly) - Number(!!a.timestampOnly);
    })
    .map(({ rank, ...entry }) => entry);

  return withMarkers;
}

export async function pauseVisitTx(
  client,
  visitId,
  { actorId = null, actorRole = "reception", reason = null, meta = {} } = {},
) {
  const { rows } = await client.query(
    `SELECT current_status, paused_at FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
    [visitId],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  const { current_status: status, paused_at: alreadyPaused } = rows[0];

  if (isTerminalStatus(status)) {
    throw Object.assign(new Error("This visit has already finished for the day"), {
      status: 409,
      reason: "finished",
    });
  }
  if (alreadyPaused) {
    return { ok: true, paused: true, pausedAt: alreadyPaused, status, unchanged: true };
  }

  await client.query(
    `UPDATE giniflow_visits
        SET paused_at = NOW(), paused_by = $2, paused_reason = $3, updated_at = NOW()
      WHERE id = $1`,
    [visitId, actorId, reason],
  );
  const ev = await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
     VALUES ($1, 'paused', $2, $3, $4)
     RETURNING occurred_at`,
    [visitId, actorRole, actorId, { source: "scribe", pausedFrom: status, reason, ...meta }],
  );
  return { ok: true, paused: true, pausedAt: ev.rows[0].occurred_at, status };
}

const inVisitTransaction = async (db, work) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

export const pauseVisit = (visitId, options = {}, db = pool) =>
  inVisitTransaction(db, (client) => pauseVisitTx(client, visitId, options));

export async function resumeVisitTx(
  client,
  visitId,
  { actorId = null, actorRole = "reception" } = {},
) {
  const { rows } = await client.query(
    `SELECT current_status, paused_at FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
    [visitId],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  const { current_status: status, paused_at: pausedAt } = rows[0];
  if (!pausedAt) {
    return { ok: true, paused: false, status, unchanged: true };
  }

  const restart = hasNotStarted(status);

  const shifted = await client.query(
    `WITH gap AS (SELECT NOW() - $2::timestamptz AS d),
     anchors AS (
       SELECT id FROM (
         SELECT id FROM giniflow_visit_events
          WHERE visit_id = $1 AND ${JOURNEY_START_SQL("status")}
          ORDER BY occurred_at DESC LIMIT 1
       ) j
       UNION
       SELECT id FROM (
         SELECT e.id FROM giniflow_visit_events e
          JOIN giniflow_visits v ON v.id = e.visit_id
          WHERE e.visit_id = $1 AND ${WAIT_SINCE_SQL("e", "v")}
          ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
       ) w
     )
     UPDATE giniflow_visit_events e
        SET occurred_at = CASE WHEN $3::boolean THEN NOW()
                               ELSE e.occurred_at + (SELECT d FROM gap) END,
            meta = e.meta || jsonb_build_object(
              'original_occurred_at', COALESCE(e.meta->>'original_occurred_at', e.occurred_at::text),
              'shifted_for_pause_ms', (EXTRACT(EPOCH FROM (SELECT d FROM gap)) * 1000)::bigint)
      WHERE e.id IN (SELECT id FROM anchors)
      RETURNING e.id, e.status`,
    [visitId, pausedAt, restart],
  );

  await client.query(
    `UPDATE giniflow_visit_steps
        SET started_at = started_at + (NOW() - $2::timestamptz)
      WHERE visit_id = $1 AND status = 'in_progress' AND started_at IS NOT NULL`,
    [visitId, pausedAt],
  );

  const upd = await client.query(
    `UPDATE giniflow_visits
        SET paused_at = NULL, paused_by = NULL, paused_reason = NULL,
            paused_ms_total = paused_ms_total
              + GREATEST(0, (EXTRACT(EPOCH FROM (NOW() - $2::timestamptz)) * 1000)::bigint),
            updated_at = NOW()
      WHERE id = $1
      RETURNING paused_ms_total`,
    [visitId, pausedAt],
  );
  await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
     VALUES ($1, 'resumed', $2, $3, $4)`,
    [
      visitId,
      actorRole,
      actorId,
      {
        source: "scribe",
        resumedAt: status,
        restarted: restart,
        pausedMsTotal: Number(upd.rows[0].paused_ms_total),
        anchorsShifted: shifted.rows.map((r) => r.status),
      },
    ],
  );
  return {
    ok: true,
    paused: false,
    restarted: restart,
    status,
    pausedMsTotal: Number(upd.rows[0].paused_ms_total),
  };
}

export const resumeVisit = (visitId, options = {}, db = pool) =>
  inVisitTransaction(db, (client) => resumeVisitTx(client, visitId, options));

export async function cancelPauseTx(client, visitId, reason, { actorId = null, actorRole } = {}) {
  const { rows } = await client.query(
    `UPDATE giniflow_visits
        SET paused_at = NULL, paused_by = NULL, paused_reason = NULL, updated_at = NOW()
      WHERE id = $1 AND paused_at IS NOT NULL AND paused_reason = $2
      RETURNING current_status`,
    [visitId, reason],
  );
  if (!rows.length) return false;
  await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
     VALUES ($1, 'resumed', $2, $3, $4)`,
    [
      visitId,
      actorRole,
      actorId,
      { source: "scribe", resumedAt: rows[0].current_status, cancelled: true, reason },
    ],
  );
  return true;
}

export const reopenResultsForNewOrder = (db, visitId) =>
  db.query(
    `UPDATE giniflow_visits SET results_status = 'partial', updated_at = NOW()
      WHERE id = $1 AND results_status = 'ready'`,
    [visitId],
  );
