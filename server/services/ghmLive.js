import pool from "../config/db.js";
import { createHub } from "./giniflow/eventHub.js";
import { assignToEditor } from "./obtAssignments.js";

const BATCH = 200;
const KEEP_DAYS = 2;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export const ghmHub = createHub({
  eventName: "ghm",
  shape: ({ kind, appointmentId = null, patientId = null }) => ({ kind, appointmentId, patientId }),
});

export async function signalGhm({ kind, appointmentId = null, patientId = null, actorId = null }) {
  try {
    await pool.query(
      `INSERT INTO ghm_live_events (kind, appointment_id, patient_id, actor_id)
       VALUES ($1, $2, $3, $4)`,
      [kind, Number(appointmentId) > 0 ? Number(appointmentId) : null, patientId || null, actorId],
    );
  } catch (e) {
    console.error("[ghm] live signal:", e.message);
  }
}

let watermark = null;
let prunedAt = 0;

export async function primeGhmWatermark(db = pool) {
  try {
    const { rows } = await db.query(`SELECT COALESCE(max(seq), 0) AS seq FROM ghm_live_events`);
    watermark = Number(rows[0].seq);
  } catch (e) {
    watermark = null;
    console.error("[ghm] live events unavailable:", e.message);
  }
  return watermark;
}

export async function tailGhm(db = pool) {
  if (watermark === null && (await primeGhmWatermark(db)) === null) return;
  try {
    const { rows } = await db.query(
      `SELECT m.top, e.seq, e.kind, e.appointment_id, e.patient_id
         FROM (SELECT COALESCE(max(seq), 0) AS top FROM ghm_live_events) m
         LEFT JOIN LATERAL (
           SELECT seq, kind, appointment_id, patient_id FROM ghm_live_events
            WHERE seq > $1 ORDER BY seq LIMIT ${BATCH}
         ) e ON TRUE
        ORDER BY e.seq`,
      [watermark],
    );
    if (Number(rows[0]?.top ?? 0) < watermark) {
      watermark = 0;
      return;
    }
    const events = rows.filter((r) => r.seq !== null);
    for (const r of events) {
      ghmHub.publish({ kind: r.kind, appointmentId: r.appointment_id, patientId: r.patient_id });
    }
    if (events.length) watermark = Number(events[events.length - 1].seq);
    if (Date.now() - prunedAt > PRUNE_EVERY_MS) {
      prunedAt = Date.now();
      await db.query(
        `DELETE FROM ghm_live_events WHERE at < NOW() - make_interval(days => ${KEEP_DAYS})`,
      );
    }
  } catch (e) {
    console.error("[ghm] live tailer:", e.message);
  }
}

export async function noteGhmEdit(rawAppointmentId, actor, kind = "row") {
  let patientId = null;
  try {
    patientId = await assignToEditor(rawAppointmentId, actor);
  } catch (e) {
    console.error("[ghm] assign to editor:", e.message);
  }
  await signalGhm({ kind, appointmentId: rawAppointmentId, patientId, actorId: actor?.id ?? null });
}
