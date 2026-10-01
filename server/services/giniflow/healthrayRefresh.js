import pool from "../../config/db.js";
import { createLogger } from "../logger.js";
import { IGNORE_SHARED_BLOCK, KV_BILL_COOLDOWN, ownBillPauseUntil } from "../healthray/client.js";

const { log, error } = createLogger("Reception Refresh");

const MIN_GAP_MS = Number(process.env.RECEPTION_REFRESH_GAP_MS) || 2 * 60 * 1000;
const WORKER_LATE_MS = 60 * 1000;
const RUN_STALE_MS = 10 * 60 * 1000;
const KV_REFRESH = "reception_healthray_refresh";
const KV_SYNC_OK = "healthray_sync_last_ok";
const KV_NOT_IN_SCRIBE = "healthray_not_in_scribe";
const NOT_IN_SCRIBE_AFTER_MS = 5 * 60 * 1000;
const NOT_IN_SCRIBE_MAX = 50;
const QUIET_AFTER_MS = 15 * 60 * 1000;
const OPD_START_HOUR_IST = 8;
const OPD_END_HOUR_IST = 20;

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

const BLOCK_SQL = `
  SELECT (SELECT max(updated_at) FROM appointments WHERE healthray_id IS NOT NULL) AS last_synced_at,
         kv.value AS cooldown, kv.updated_at AS cooldown_at,
         (SELECT value FROM app_kv WHERE key = '${KV_REFRESH}') AS refresh,
         (SELECT value FROM app_kv WHERE key = '${KV_SYNC_OK}') AS sync_ok
    FROM (SELECT 1) one
    LEFT JOIN app_kv kv ON kv.key = 'healthray_login_cooldown'`;

const istHour = () =>
  Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  );

const isQuiet = (lastOkMs) => {
  const hour = istHour();
  if (hour < OPD_START_HOUR_IST || hour >= OPD_END_HOUR_IST) return false;
  return !lastOkMs || Date.now() - lastOkMs > QUIET_AFTER_MS;
};

const readState = async (db) => {
  const { rows } = await db.query(BLOCK_SQL);
  const r = rows[0] || {};
  const until = Number(r.cooldown?.until) || 0;
  const lastOkMs = Number(r.sync_ok?.at) || 0;
  const lastSyncedAt = lastOkMs
    ? iso(lastOkMs)
    : r.last_synced_at
      ? new Date(r.last_synced_at).toISOString()
      : null;
  const dataSinceBlock =
    lastSyncedAt && r.cooldown_at && new Date(lastSyncedAt) > new Date(r.cooldown_at);
  const blocked = until > Date.now() && !dataSinceBlock;
  return {
    lastSyncedAt,
    blockedUntil: blocked ? iso(until) : null,
    blockedReason: blocked ? r.cooldown?.reason || null : null,
    syncQuiet: !blocked && isQuiet(lastOkMs),
    kv: r.refresh || {},
  };
};

export async function recordHealthraySyncOk(db = pool) {
  await db.query(
    `INSERT INTO app_kv (key, value, updated_at)
     VALUES ($1, jsonb_build_object('at', $2::bigint), NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KV_SYNC_OK, Date.now()],
  );
}

const shapeRefresh = (kv) => {
  const requestedAt = Number(kv.requestedAt) || 0;
  const startedAt = Number(kv.startedAt) || 0;
  const finishedAt = Number(kv.finishedAt) || 0;
  const queued = requestedAt > startedAt;
  const running =
    !queued && startedAt > 0 && finishedAt < startedAt && Date.now() - startedAt < RUN_STALE_MS;
  const nextAllowed = requestedAt ? requestedAt + MIN_GAP_MS : 0;
  return {
    queued,
    running,
    workerLate: queued && Date.now() - requestedAt > WORKER_LATE_MS,
    requestedAt: iso(requestedAt),
    startedAt: iso(startedAt),
    finishedAt: iso(finishedAt),
    outcome: kv.outcome || null,
    error: kv.error || null,
    nextAllowedAt: nextAllowed > Date.now() ? iso(nextAllowed) : null,
  };
};

export async function healthrayBlockedUntil(db = pool) {
  return (await readState(db)).blockedUntil;
}

export async function billReadsBlockedUntil(db = pool) {
  if (IGNORE_SHARED_BLOCK) return ownBillPauseUntil();
  const blocked = await healthrayBlockedUntil(db);
  if (blocked) return blocked;
  const { rows } = await db.query(`SELECT value FROM app_kv WHERE key = $1`, [KV_BILL_COOLDOWN]);
  const until = Number(rows[0]?.value?.until) || 0;
  return until > Date.now() ? iso(until) : null;
}

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export async function recordHealthrayNotInScribe(date, items, db = pool) {
  const { rows } = await db.query(`SELECT value FROM app_kv WHERE key = $1`, [KV_NOT_IN_SCRIBE]);
  const previous = rows[0]?.value?.date === date ? rows[0].value.items || [] : [];
  const firstSeen = new Map(previous.map((i) => [i.healthrayId, i.firstSeenAt]));
  const now = Date.now();
  const merged = items
    .slice(0, NOT_IN_SCRIBE_MAX)
    .map((i) => ({ ...i, firstSeenAt: firstSeen.get(i.healthrayId) || now }));
  await db.query(
    `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KV_NOT_IN_SCRIBE, JSON.stringify({ date, at: now, items: merged })],
  );
}

const readNotInScribe = async (db) => {
  const { rows } = await db.query(`SELECT value FROM app_kv WHERE key = $1`, [KV_NOT_IN_SCRIBE]);
  const value = rows[0]?.value;
  if (value?.date !== todayIst()) return { checkedAt: null, items: [] };
  const waiting = (value.items || []).filter(
    (i) => Date.now() - Number(i.firstSeenAt) >= NOT_IN_SCRIBE_AFTER_MS,
  );
  if (!waiting.length) return { checkedAt: iso(value.at), items: [] };
  const { rows: arrived } = await db.query(
    `SELECT healthray_id::text AS id FROM appointments WHERE healthray_id = ANY($1::bigint[])`,
    [waiting.map((i) => i.healthrayId)],
  );
  const synced = new Set(arrived.map((r) => r.id));
  return {
    checkedAt: iso(value.at),
    items: waiting
      .filter((i) => !synced.has(String(i.healthrayId)))
      .map((i) => ({ ...i, firstSeenAt: iso(i.firstSeenAt) })),
  };
};

export async function getHealthrayStatus(db = pool) {
  const { kv, ...block } = await readState(db);
  return { ...block, notInScribe: await readNotInScribe(db), refresh: shapeRefresh(kv) };
}

export async function requestHealthrayRefresh(db = pool) {
  const status = await getHealthrayStatus(db);
  if (status.blockedUntil) return { started: false, reason: "blocked", ...status };
  if (status.refresh.queued || status.refresh.running) {
    return { started: false, reason: "running", ...status };
  }

  const now = Date.now();
  const { rows } = await db.query(
    `INSERT INTO app_kv (key, value, updated_at)
     VALUES ($1, jsonb_build_object('requestedAt', $2::bigint), NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = app_kv.value
                   || jsonb_build_object('requestedAt', $2::bigint, 'outcome', NULL, 'error', NULL),
           updated_at = NOW()
     WHERE COALESCE((app_kv.value->>'requestedAt')::bigint, 0) <= $2::bigint - $3::bigint
     RETURNING value`,
    [KV_REFRESH, now, MIN_GAP_MS],
  );
  const after = await getHealthrayStatus(db);
  if (!rows.length) return { started: false, reason: "too_soon", ...after };
  return { started: true, reason: null, ...after };
}

export async function runRequestedHealthrayRefresh({ syncToday, syncFlow }, db = pool) {
  const { rows } = await db.query(
    `UPDATE app_kv
        SET value = value || jsonb_build_object('startedAt', $2::bigint, 'finishedAt', NULL),
            updated_at = NOW()
      WHERE key = $1
        AND COALESCE((value->>'requestedAt')::bigint, 0) > COALESCE((value->>'startedAt')::bigint, 0)
      RETURNING value`,
    [KV_REFRESH, Date.now()],
  );
  if (!rows.length) return null;

  let outcome = null;
  let failure = null;
  try {
    const hr = await syncToday();
    const flow = await syncFlow();
    outcome = {
      alreadyRunning: !!hr?.skippedRun,
      appointments: hr?.totalCreated ?? 0,
      errors: hr?.totalErrors ?? 0,
      addedToFloor: flow?.created ?? 0,
    };
    log("done", JSON.stringify(outcome));
  } catch (e) {
    failure = e.message;
    error("failed", e.message);
  }
  await db.query(
    `UPDATE app_kv
        SET value = value || jsonb_build_object('finishedAt', $2::bigint, 'outcome', $3::jsonb, 'error', $4::text),
            updated_at = NOW()
      WHERE key = $1`,
    [KV_REFRESH, Date.now(), outcome ? JSON.stringify(outcome) : null, failure],
  );
  return { outcome, error: failure };
}
