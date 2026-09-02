import {
  canTransition,
  chainIndex,
  isChainStatus,
  isKnownStatus,
  isWaitStatus,
  slaKeyForStatus,
  STATUS_LABEL,
} from "../../../shared/giniflowStatus.js";

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
  return event.rows[0];
}

// The one place durations are computed. Card timers, the timeline modal and the
// station averages all read from here so they can never disagree.
export async function getStationTimes(
  db,
  visitId,
  slaConfig,
  now = new Date(),
  { slaConfig: slaRows = null, category = null } = {},
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

  const raw = rows.map((row, i) => {
    const enteredAt = new Date(row.occurred_at);
    const next = rows[i + 1];
    const leftAt = next ? new Date(next.occurred_at) : null;
    return {
      status: row.status,
      label: STATUS_LABEL[row.status] || row.status,
      actorRole: row.actor_role,
      meta: row.meta,
      enteredAt,
      leftAt,
      minutes: minutesBetween(enteredAt, leftAt || now),
      isCurrent: !next,
      isWait: isWaitStatus(row.status),
      budgetMinutes:
        overrideFor(slaKeyForStatus(row.status)) ?? slaConfig[slaKeyForStatus(row.status)] ?? null,
    };
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
    const waitBudget = wait?.budgetMinutes ?? (entry.isWait ? entry.budgetMinutes : null);
    const stationMinutes = entry.isWait ? 0 : entry.minutes;
    const stationBudget = entry.isWait ? null : entry.budgetMinutes;
    const overBy =
      Math.max(0, waitBudget ? waitMinutes - waitBudget : 0) +
      Math.max(0, stationBudget ? stationMinutes - stationBudget : 0);
    steps.push({
      status: entry.status,
      label: entry.label,
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

  for (const entry of raw) {
    // A queue the patient is still sitting in is a step in its own right — it is
    // the one the board is timing, so it must not be folded into a station.
    if (entry.isWait && !entry.isCurrent) {
      wait = wait
        ? {
            ...wait,
            minutes: wait.minutes + entry.minutes,
            budgetMinutes: entry.budgetMinutes ?? wait.budgetMinutes,
          }
        : entry;
      continue;
    }
    emit(entry);
  }
  if (wait) emit({ ...wait, minutes: 0, isCurrent: true, isWait: true, leftAt: null });

  return steps;
}
