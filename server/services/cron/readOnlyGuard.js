import { cronPool } from "../../config/db.js";
import { createLogger } from "../logger.js";

const { log, error } = createLogger("Read-only Guard");

const TICK_MS = 60_000;
const PROBES = 20;

const PROBE_SQL = `
  SELECT pg_backend_pid() AS pid,
         s.source,
         current_setting('default_transaction_read_only') = 'on' AS read_only,
         CASE WHEN current_setting('default_transaction_read_only') = 'on' AND s.source = 'session'
              THEN set_config('default_transaction_read_only', 'off', false)
         END AS reset_to
    FROM pg_settings s
   WHERE s.name = 'default_transaction_read_only'`;

let timer = null;

export async function healReadOnlySessions({ db = cronPool, probes = PROBES } = {}) {
  const seen = new Set();
  const healed = [];
  let databaseReadOnly = null;
  for (let i = 0; i < probes; i++) {
    const { rows } = await db.query(PROBE_SQL);
    const row = rows[0];
    seen.add(row.pid);
    if (row.reset_to) healed.push(row.pid);
    else if (row.read_only) databaseReadOnly = row.source;
  }
  if (healed.length) log("Heal", `reset leaked read-only session on backends ${healed.join(", ")}`);
  if (databaseReadOnly)
    error(
      "Check",
      `database is read-only (set at ${databaseReadOnly} level) — not overriding; check Supabase disk usage`,
    );
  return { probed: seen.size, healed, databaseReadOnly };
}

export function startReadOnlyGuardCron() {
  if (timer) return;
  timer = setInterval(() => {
    healReadOnlySessions().catch((e) => error("Tick", e.message));
  }, TICK_MS);
  timer.unref?.();
  log("Start", `probing ${PROBES} pooled connections every ${TICK_MS / 1000}s`);
}

export function stopReadOnlyGuardCron() {
  if (timer) clearInterval(timer);
  timer = null;
}
