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
  // `allowSkip` exists for one caller: the HealthRay sync, which observes a
  // patient at a later point in the chain without knowing how they got there.
  // A station screen must never set it — a human skipping steps is a mis-tap,
  // whereas an external system genuinely cannot report what it does not track.
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

  const event = await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, occurred_at, meta)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6)
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
            updated_at     = NOW()
      WHERE id = $1`,
    [visitId, toStatus, fromStatus, blockedReason],
  );

  return { from: fromStatus, ...event.rows[0] };
}

// The one place durations are computed. Card timers, the timeline modal and the
// station averages all read from here so they can never disagree.
export async function getStationTimes(db, visitId, slaConfig, now = new Date()) {
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
      budgetMinutes: slaConfig[slaKeyForStatus(row.status)] ?? null,
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
