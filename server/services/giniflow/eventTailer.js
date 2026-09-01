import pool from "../../config/db.js";
import { publish } from "./eventHub.js";

// Everything that happens on the Gini Flow floor is already written to an
// append-only table: `advanceStatus` writes every status move, the lab order
// track writes every payment and sample, and the vitals station writes every
// reading. Nothing new has to be published anywhere — something only has to
// read them.
//
// That is what makes this cheap. One indexed `seq > watermark` lookup per table
// per second replaces every open browser re-running the queue SQL every fifteen,
// and it cannot miss an event: the tables are insert-only and the watermark is
// monotonic.
//
// It also means the API hears about work done by the worker process — the
// HealthRay sync moving a patient to checked_in — without the two processes
// talking. The transaction pooler on port 6543 rules out LISTEN/NOTIFY, and the
// events table is a better bus anyway, because it is durable.

const TICK_MS = Number(process.env.GINIFLOW_TAIL_MS || 1000);
const BATCH = 200;

const STREAMS = [
  {
    kind: "visit",
    sql: `SELECT e.seq, e.visit_id, e.status, v.visit_date::text AS date
            FROM giniflow_visit_events e
            JOIN giniflow_visits v ON v.id = e.visit_id
           WHERE e.seq > $1 ORDER BY e.seq LIMIT ${BATCH}`,
    map: (r) => ({ kind: "visit", visitId: r.visit_id, status: r.status, date: r.date }),
  },
  {
    kind: "lab_order",
    sql: `SELECT e.seq, e.status, o.id AS order_id, o.visit_id, v.visit_date::text AS date
            FROM giniflow_lab_order_events e
            JOIN giniflow_lab_orders o ON o.id = e.lab_order_id
            JOIN giniflow_visits v ON v.id = o.visit_id
           WHERE e.seq > $1 ORDER BY e.seq LIMIT ${BATCH}`,
    map: (r) => ({
      kind: "lab_order",
      visitId: r.visit_id,
      orderId: r.order_id,
      status: r.status,
      date: r.date,
    }),
  },
  {
    kind: "vitals",
    sql: `SELECT g.seq, g.visit_id, v.visit_date::text AS date
            FROM giniflow_vitals g
            JOIN giniflow_visits v ON v.id = g.visit_id
           WHERE g.seq > $1 ORDER BY g.seq LIMIT ${BATCH}`,
    map: (r) => ({ kind: "vitals", visitId: r.visit_id, date: r.date }),
  },
];

let timer = null;
let running = false;
const watermarks = new Map();

// Start from where the tables are now, not from the beginning of time: a
// restart must not replay the whole day into every screen.
async function primeWatermarks(db) {
  const { rows } = await db.query(
    `SELECT COALESCE((SELECT max(seq) FROM giniflow_visit_events), 0)     AS visit,
            COALESCE((SELECT max(seq) FROM giniflow_lab_order_events), 0) AS lab_order,
            COALESCE((SELECT max(seq) FROM giniflow_vitals), 0)           AS vitals`,
  );
  for (const s of STREAMS) watermarks.set(s.kind, Number(rows[0][s.kind]));
}

async function tick(db) {
  if (running) return;
  running = true;
  try {
    for (const stream of STREAMS) {
      const from = watermarks.get(stream.kind) ?? 0;
      const { rows } = await db.query(stream.sql, [from]);
      if (!rows.length) continue;
      for (const row of rows) publish(stream.map(row));
      watermarks.set(stream.kind, Number(rows[rows.length - 1].seq));
    }
  } catch (e) {
    // A blip must not kill the loop; the next tick picks up from the same
    // watermark, so nothing is lost by failing.
    console.error("[giniflow] event tailer:", e.message);
  } finally {
    running = false;
  }
}

export async function startEventTailer(db = pool) {
  if (timer) return { started: false };
  await primeWatermarks(db);
  timer = setInterval(() => tick(db), TICK_MS);
  timer.unref?.();
  return { started: true, watermarks: Object.fromEntries(watermarks) };
}

export function stopEventTailer() {
  clearInterval(timer);
  timer = null;
}

// Exposed for the smoke suite, which drives ticks itself rather than waiting.
export const tailerTick = tick;
export const tailerWatermarks = () => Object.fromEntries(watermarks);
