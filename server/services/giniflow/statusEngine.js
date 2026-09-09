import {
  JOURNEY_START_SQL,
  WAIT_SINCE_SQL,
  hasNotStarted,
  canTransition,
  isMarkerStatus,
  chainIndex,
  isChainStatus,
  isKnownStatus,
  isWaitStatus,
  isTerminalStatus,
  slaKeyForStatus,
  STATUS_LABEL,
} from "../../../shared/giniflowStatus.js";

import { syncFromStatus } from "./journey.js";
import pool from "../../config/db.js";

export const IST_TODAY = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

export const budgetColour = (minutes, budget) => {
  if (!budget) return "neutral";
  const pct = (minutes / budget) * 100;
  if (pct > 100) return "red";
  if (pct >= 80) return "amber";
  return "green";
};

const minutesBetween = (from, to) => Math.max(0, Math.round((to - from) / 60000));

// Appends one event and moves the visit's denormalised status. Caller supplies
// the client so the write joins whatever transaction it belongs to — the fan-out
// triggers that land with the station screens must be atomic with the status change.
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
  // Blocking without saying why gives the coordinator a red card and no action to
  // take, so the reason is required rather than optional (GF-18).
  if (toStatus === "blocked_reports" && !blockedReason) {
    throw new Error("Blocking a visit requires a reason");
  }

  const current = await client.query(
    `SELECT current_status, resume_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
    [visitId],
  );
  if (!current.rows.length) throw new Error(`No such visit: ${visitId}`);

  const fromStatus = current.rows[0].current_status;
  // `allowSkip` says: the caller knows the patient is HERE, and does not claim
  // to know every step they took to arrive. That is the real rule (CS-12) — an
  // earlier comment here said "never a station screen", which four callers now
  // contradict. What is actually forbidden is a station skipping steps it could
  // have observed: each caller below is bounded so it cannot.
  //
  //   1. the HealthRay sync — observes a patient at a later point in the chain
  //      without knowing how they got there;
  //   2. a floor manager's drag on the board — crosses one COLUMN, a distance
  //      the chain cannot express because the SD column alone holds three
  //      statuses. queue.moveToColumn bounds it to a single adjacent column
  //      first, so the skip never exceeds one station (BQ-02);
  //   3. the vitals station and the consultant — a walk-in, or a patient the
  //      floor moved by hand, is physically at the station whatever the board
  //      believes. Both write their OWN station's status, which is the bound:
  //      neither can advance a patient past itself.
  //
  // The rail on every screen is drawn from the events, not from the current
  // status, so a skipped step stays visibly un-ticked rather than being filled
  // in retrospectively.
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

  // clock_timestamp(), NOT now(). `now()` is the TRANSACTION timestamp: it is
  // frozen for the whole transaction, so two events written in one — Finalize
  // writes doctor_done and pharmacy_pending together — land on the identical
  // occurred_at. Every ordering in this module then falls through to `id`, a
  // random uuid, and the patient's timeline shows the two steps in whichever
  // order the uuids happened to sort. clock_timestamp() advances mid-transaction,
  // so consecutive events keep the order they were written in.
  const event = await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, occurred_at, meta)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, clock_timestamp()), $6)
     RETURNING id, status, actor_role, actor_id, occurred_at, meta`,
    [visitId, toStatus, actorRole, actorId, occurredAt, meta],
  );

  // Blocking remembers where the patient was so recovery cannot walk them
  // backwards; leaving the blocked state clears both the reason and the memory.
  await client.query(
    `UPDATE giniflow_visits
        SET current_status = $2,
            resume_status  = CASE WHEN $2 = 'blocked_reports' THEN $3 ELSE NULL END,
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

  // The patient's journey follows the status in the same transaction, so the
  // plan and the board can never disagree about where someone is. It only ever
  // UPDATEs giniflow_visit_steps for this visit and matches no rows when the
  // visit has no plan (29-RECEPTION-JOURNEY-PLAN.md).
  await syncFromStatus(client, visitId, toStatus);

  return { from: fromStatus, ...event.rows[0] };
}

// Returning a patient to the queue they were called from — a consultant who
// steps out, an MO who hands a patient back. The chain has no backward step, so
// this is NOT a transition: it is recorded as a new event (the log only ever
// grows) and the denormalised status is corrected to match.
//
// It lives here so the rule "current_status is written in one place" stays true
// (CS-09), and so a release clears the manual queue position exactly as
// advanceStatus does — a position belongs to the queue it was set in.
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
  // A release moves the patient as surely as an advance does. Without this the
  // step they were released from stays "in progress" and the patient's own
  // tracker says they are with the nurse while the board says they are waiting.
  await syncFromStatus(client, visitId, toStatus);
  return event.rows[0];
}

// STATUS_LABEL names the COLUMN a status feeds, which is what makes
// `vitals_done` read "Waiting for SD / MO". On a lab-only visit that queue does
// not exist for the patient, so the timeline named a station they will never
// reach. These name the observation itself instead.
const LAB_ONLY_LABEL = {
  vitals_done: "Vitals done",
  sd_pending: "Waiting",
  ready_for_doctor: "Waiting",
};

// The one place durations are computed. Card timers, the timeline modal and the
// station averages all read from here so they can never disagree.
const SKIPPED_STATION_NAME = {
  with_vitals: "Vitals",
  with_sd: "Chief Endocrinologist",
  with_doctor: "Consultant",
  with_rx: "Prescription Explain",
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
  } = {},
) {
  // `slaConfig` here is the flat station→minutes map every existing caller
  // passes. When the caller also knows whose timeline this is, it passes the
  // rows and the category so per-category overrides apply (brief §3, Phase 4).
  const overrideFor = (station) => {
    if (!slaRows || !category) return null;
    const v = slaRows.find((r) => r.station === station)?.categoryOverrides?.[category];
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const { rows } = await db.query(
    `SELECT status, actor_role, occurred_at, meta
       FROM giniflow_visit_events
      WHERE visit_id = $1
      ORDER BY occurred_at, id`,
    [visitId],
  );

  // The rooms a patient is physically in. A step that ends at an event further
  // down the chain than one of these has swallowed a room nobody recorded.
  const STATION_STATUSES = ["with_vitals", "with_sd", "with_doctor", "with_rx"];
  const stationsSkipped = (from, to) =>
    isChainStatus(from) && isChainStatus(to)
      ? STATION_STATUSES.filter(
          (st) => chainIndex(st) > chainIndex(from) && chainIndex(st) < chainIndex(to),
        )
      : [];
  const skipsAStation = (from, to) => stationsSkipped(from, to).length > 0;

  // Markers are pulled out before the walk below, not skipped inside it. Left in
  // the sequence, a report arriving at 10:20 became `rows[i + 1]` for the wait
  // that started at 10:00 — so a patient who waited an hour for the MO showed
  // 20 minutes, and the rest of that wait belonged to nothing. They are put back
  // afterwards as the dated facts they are.
  const statusRows = rows.filter((r) => !isMarkerStatus(r.status));
  const markerRows = rows.filter((r) => isMarkerStatus(r.status));

  const raw = statusRows.map((row, i) => {
    const enteredAt = new Date(row.occurred_at);
    const next = statusRows[i + 1];
    const leftAt = next ? new Date(next.occurred_at) : null;
    const ended = !next && isTerminalStatus(row.status);
    // A row that is not a status at all — `results_received` — is a fact that
    // arrived, not a place the patient stood. It carries no duration and is
    // rendered as a dated marker, the way the lab track's milestones are.
    // A status the vocabulary does not know is still not a place with a
    // duration — an unknown one is a bug, not a station.
    const marker = !isKnownStatus(row.status);
    const minutes =
      isTerminalStatus(row.status) || marker ? 0 : minutesBetween(enteredAt, leftAt || now);
    return {
      timestampOnly: marker,
      // HealthRay reports only checked-in and completed, so a patient whose MO
      // and consultant were never tapped onto a screen leaves ONE step covering
      // all of it, filed under whatever queue was recorded last. Judging that
      // against the queue's budget invented a 230-minute overrun for a station
      // nobody sat in. Unrecorded time is judged against nothing.
      unrecorded: !!next && minutes >= 1 && skipsAStation(row.status, next.status),
      status: row.status,
      label:
        (unbudgeted ? LAB_ONLY_LABEL[row.status] : null) || STATUS_LABEL[row.status] || row.status,
      actorRole: row.actor_role,
      meta: row.meta,
      enteredAt,
      leftAt,
      // Exiting is an instant, not a station. When a visit is reopened — a
      // correction, or a patient put back on the floor — the exit acquired the
      // whole gap until the next event and the timeline read "Exited · 102m
      // station" for a patient who had gone home.
      minutes,
      isCurrent: !next && !ended,
      isWait: isWaitStatus(row.status),
      // A lab-only visit is judged against nothing. Its statuses are the ones
      // the sync happened to observe on the way to the lab — the patient is not
      // in the SD / MO queue and never will be, so scoring 123 minutes against
      // that station's 10-minute budget invents an overrun nobody can act on.
      budgetMinutes: unbudgeted
        ? null
        : (overrideFor(slaKeyForStatus(row.status)) ??
          slaConfig[slaKeyForStatus(row.status)] ??
          null),
    };
  });

  // The MO cannot see a patient whose bloods are still at the lab, so the wait
  // before the reports land is judged against nothing, not against the MO queue.
  const AWAITING_LAB_LABEL = "Waiting for lab reports";
  const blockedByLab = (entry) =>
    entry.isWait && slaKeyForStatus(entry.status) === "wait_sd" && !entry.unrecorded;

  const withLabSplit = raw.flatMap((entry) => {
    if (!blockedByLab(entry)) return [entry];
    const endsAt = entry.leftAt || now;
    if (labPending && !labReadyAt)
      return [{ ...entry, label: AWAITING_LAB_LABEL, budgetMinutes: null, awaitingLab: true }];
    if (!labReadyAt) return [entry];
    if (labReadyAt >= endsAt)
      return [{ ...entry, label: AWAITING_LAB_LABEL, budgetMinutes: null, awaitingLab: true }];
    if (labReadyAt <= entry.enteredAt) return [entry];
    return [
      {
        ...entry,
        label: AWAITING_LAB_LABEL,
        budgetMinutes: null,
        awaitingLab: true,
        leftAt: labReadyAt,
        minutes: minutesBetween(entry.enteredAt, labReadyAt),
        isCurrent: false,
      },
      {
        ...entry,
        enteredAt: labReadyAt,
        minutes: minutesBetween(labReadyAt, endsAt),
      },
    ];
  });

  // Pair each queue with the station it fed, so the timeline reads
  // "8m wait + 12m station" rather than listing two half-steps. Consecutive
  // queue statuses (checked_in → vitals_pending, both "waiting for vitals")
  // accumulate into one wait rather than the later one replacing the earlier.
  const steps = [];
  let wait = null;

  // A queue and the station it feeds have separate budgets, so they are judged
  // separately and the step takes the worse of the two colours. Summing them and
  // comparing the total against the station budget alone would mark a step red
  // for a long wait the station had no control over.
  const WORST = { red: 3, amber: 2, green: 1, neutral: 0 };
  const worse = (a, b) => (WORST[a] >= WORST[b] ? a : b);

  const emit = (entry) => {
    const waitMinutes = (wait ? wait.minutes : 0) + (entry.isWait ? entry.minutes : 0);
    // Time the chain skipped over is judged against nothing. It is not the queue
    // it happens to be filed under — HealthRay reports only checked-in and
    // completed, so a patient whose MO and consultant were never tapped onto a
    // screen leaves one gap covering all of it, and scoring that against the MO
    // queue invented a 230-minute overrun for a station nobody sat in.
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
      actorRole: entry.actorRole,
      meta: entry.meta,
      enteredAt: (wait?.enteredAt ?? entry.enteredAt).toISOString(),
      leftAt: entry.leftAt ? entry.leftAt.toISOString() : null,
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

  // A queue may only be folded into the station it actually feeds.
  //
  // Merging it into whatever came next was wrong twice over. `vitals_done` is
  // not a station at all — it is the sync noticing HealthRay holds a vitals row,
  // and its own label is another queue's name — so a check-in absorbed into it
  // produced a step headed "Waiting for SD / MO" timestamped at the arrival.
  // And when the chain SKIPS, as it does whenever HealthRay reports a patient
  // straight from checked-in to completed, the whole undocumented middle of the
  // journey was relabelled as a queue for the station at the far end: one
  // patient's consultation with a second doctor was shown as 129 minutes of
  // "wait" for the pharmacy, judged against the 10-minute check-in budget.
  //
  // Unpaired, the wait stands as its own step under its own name, which is the
  // honest description of time nobody recorded a station for.
  const QUEUE_FEEDS = {
    checked_in: "with_vitals",
    vitals_pending: "with_vitals",
    vitals_done: "with_sd",
    sd_pending: "with_sd",
    ready_for_doctor: "with_doctor",
    rx_pending: "with_rx",
  };

  for (const entry of withLabSplit) {
    // A queue the patient is still sitting in is a step in its own right — it is
    // the one the board is timing, so it must not be folded into a station.
    if (entry.isWait && !entry.isCurrent) {
      // Only queues for the same station accumulate, and never across the lab
      // split: `checked_in` waits for vitals, `vitals_done` for the MO.
      if (
        wait &&
        (QUEUE_FEEDS[wait.status] !== QUEUE_FEEDS[entry.status] ||
          !!wait.awaitingLab !== !!entry.awaitingLab)
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
    if (wait && QUEUE_FEEDS[wait.status] !== entry.status) {
      const pending = wait;
      wait = null;
      emit({ ...pending, isCurrent: false, leftAt: entry.enteredAt });
    }
    emit(entry);
  }
  if (wait) emit({ ...wait, minutes: 0, isCurrent: true, isWait: true, leftAt: null });

  // A card opened and let go in the same minute is a glance, not a visit: it
  // split one continuous wait into two and reset the clock the floor is judged on.
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

  // A patient sent back to a station they have already been at is one step with
  // two visits, not two steps. The Rx desk makes this ordinary: opening a card
  // puts the patient at the desk and "not this patient" returns them, so a
  // mis-click wrote a fresh pair of steps and a timeline read as five visits to
  // one desk. Merged, the time still counts in full and `visits` says how often
  // they came back.
  const merged = [];
  for (const step of collapsed) {
    const prev = merged[merged.length - 1];
    if (!prev || prev.status !== step.status) {
      merged.push({ ...step, visits: 1 });
      continue;
    }
    prev.waitMinutes += step.waitMinutes;
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

  // The markers, back in time order: dated facts between the steps rather than
  // steps of their own. They carry no minutes and no budget, so nothing is
  // judged against them and nothing they interrupt loses its time.
  const skipped = statusRows.flatMap((row, i) => {
    const next = statusRows[i + 1];
    if (!next) return [];
    return stationsSkipped(row.status, next.status).map((station) => ({
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

  const withMarkers = [
    ...skipped,
    ...merged,
    ...markerRows.map((row) => ({
      status: row.status,
      timestampOnly: true,
      label: STATUS_LABEL[row.status] || row.status,
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
  ].sort((a, b) => new Date(a.enteredAt) - new Date(b.enteredAt));

  return withMarkers;
}

// ── Pause / resume ──────────────────────────────────────────────────────────
//
// The patient has stepped out. current_status is untouched — they resume at the
// same stop, in the same column, holding their queue position — so this only
// stops their clocks.
//
// While the pause is open the live timers freeze against paused_at (the board
// and the station queues pass it as their "now"). On resume the anchor events
// are shifted FORWARD by the length of the break, which is what makes every
// other duration in the system correct without knowing pause exists: the board
// JS, the six station services, the SQL averages and the patient tracker all
// measure from those anchors.
//
// The true time is kept in the event's meta.original_occurred_at, and the
// paused/resumed pair is logged, so the shift never loses what really happened.
export async function pauseVisit(
  visitId,
  { actorId = null, actorRole = "reception", reason = null } = {},
  db = pool,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
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
    // Idempotent: a second press on an already-paused visit must not restart the
    // pause clock, or the first part of the break is silently lost.
    if (alreadyPaused) {
      await client.query("COMMIT");
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
      [visitId, actorRole, actorId, { source: "scribe", pausedFrom: status, reason }],
    );
    await client.query("COMMIT");
    return { ok: true, paused: true, pausedAt: ev.rows[0].occurred_at, status };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function resumeVisit(
  visitId,
  { actorId = null, actorRole = "reception" } = {},
  db = pool,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT current_status, paused_at FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    const { current_status: status, paused_at: pausedAt } = rows[0];
    if (!pausedAt) {
      await client.query("COMMIT");
      return { ok: true, paused: false, status, unchanged: true };
    }

    // Two shapes, decided by whether the patient had actually started.
    //
    //   underway    — shift the anchors FORWARD by the break, so the work
    //                 already done keeps its elapsed time and only the break
    //                 drops out.
    //   not started — move the anchors TO NOW, so the clock restarts at zero.
    //                 They left the queue before anyone saw them; keeping the
    //                 wait they accrued before walking off would hold a place
    //                 the floor has already given away, and it is what a
    //                 HealthRay re-check-in does to them anyway.
    const restart = hasNotStarted(status);

    // Each anchor at most once: the journey start (the visit's total) and the
    // latest wait event (the current status timer). They are the same row when
    // the patient never left the check-in column, which is why this dedupes.
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

    // A step the patient was in the middle of moves with them.
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
    await client.query("COMMIT");
    return {
      ok: true,
      paused: false,
      restarted: restart,
      status,
      pausedMsTotal: Number(upd.rows[0].paused_ms_total),
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
