// ── Per-appointment OPD backfill listener ──────────────────────────────────
// LISTENs on Postgres NOTIFY channel 'appt_inserted' (fired by the AFTER
// INSERT trigger trg_appt_notify_insert on the appointments table). For
// every new appointment, fires a fire-and-forget backfillPatientOpd to
// re-parse the patient's latest clinical notes and refresh the JSONB +
// normalised diagnoses / medications tables.
//
// Skips:
//   - source='healthray' inserts (syncAppointment already parses + syncs
//     inline at server/services/cron/healthraySync.js:641-657)
//   - duplicate fires for the same patient within a 30s window (e.g. when
//     the Google Sheets sync inserts several rows in one tick)

import pg from "pg";
import { dbUrl, needsSsl } from "../../config/db.js";
import { backfillPatientOpd } from "./healthraySync.js";

const CHANNEL = "appt_inserted";
const DEDUP_WINDOW_MS = 30 * 1000;
const RECONNECT_DELAY_MS = 5 * 1000;

let client = null;
let started = false;
let reconnectTimer = null;
const inflight = new Map(); // patient_id → setTimeout handle

async function handleNotification(msg) {
  if (msg.channel !== CHANNEL) return;
  let payload;
  try {
    payload = JSON.parse(msg.payload);
  } catch {
    return;
  }
  const { patient_id, source, appt_id, healthray_id } = payload || {};
  if (!patient_id) return;

  // HealthRay sync already runs the full parse + JSONB write + normalised
  // table sync inline when it inserts the row. Skipping here avoids burning
  // Claude tokens on every realtime-sync tick (10-15 s loop).
  //
  // The INSERT branch of upsertAppointment (server/services/healthray/db.js)
  // does NOT write `source='healthray'` (only the UPDATE branch does), so we
  // use `healthray_id` as the definitive signal that HealthRay sync created
  // the row.
  if (source === "healthray" || (healthray_id && healthray_id !== "")) return;

  if (inflight.has(patient_id)) return;
  const handle = setTimeout(() => inflight.delete(patient_id), DEDUP_WINDOW_MS);
  inflight.set(patient_id, handle);

  console.log(
    `[ApptInsert] backfill kick patient=${patient_id} appt=${appt_id} source=${source || "(null)"}`,
  );

  backfillPatientOpd(patient_id)
    .then((result) => {
      console.log(
        `[ApptInsert] patient=${patient_id} → ${result.status}${result.apptId ? ` (appt ${result.apptId})` : ""}`,
      );
    })
    .catch((e) => {
      console.error(`[ApptInsert] patient=${patient_id} backfill failed: ${e.message}`);
    });
}

function scheduleReconnect() {
  if (!started || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!started) return;
    connect().catch((e) => {
      console.error(`[ApptInsert] reconnect failed: ${e.message}`);
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

async function connect() {
  if (client) {
    try {
      await client.end();
    } catch {}
    client = null;
  }
  const c = new pg.Client({
    connectionString: dbUrl || undefined,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
    keepAlive: true,
  });
  c.on("notification", handleNotification);
  c.on("error", (e) => {
    console.error(`[ApptInsert] listener client error: ${e.message}`);
    if (started) scheduleReconnect();
  });
  c.on("end", () => {
    if (started) {
      console.warn("[ApptInsert] listener connection ended — scheduling reconnect");
      scheduleReconnect();
    }
  });
  await c.connect();
  await c.query(`LISTEN ${CHANNEL}`);
  client = c;
  console.log(`[Cron] Appointment-insert listener active (channel=${CHANNEL})`);
}

export async function startAppointmentInsertListener() {
  if (started) return;
  started = true;
  try {
    await connect();
  } catch (e) {
    console.error(`[ApptInsert] failed to start: ${e.message}`);
    scheduleReconnect();
    throw e;
  }
}

export async function stopAppointmentInsertListener() {
  if (!started) return;
  started = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  for (const handle of inflight.values()) clearTimeout(handle);
  inflight.clear();
  if (client) {
    try {
      await client.query(`UNLISTEN ${CHANNEL}`);
    } catch {}
    try {
      await client.end();
    } catch {}
    client = null;
  }
  console.log("[Cron] Appointment-insert listener stopped");
}
