import { cronPool } from "../../config/db.js";
import { createLogger } from "../logger.js";
import { tryAcquireCronLock, CRON_LOCK_KEYS } from "./lowPriority.js";
import { purgeStaleSessions } from "../billing/importSessions.js";

const { log, error } = createLogger("Import Session Sweep");

export async function runImportSessionSweep() {
  const release = await tryAcquireCronLock(
    "import-session-sweep",
    CRON_LOCK_KEYS.IMPORT_SESSION_SWEEP,
  );
  if (!release) return { skipped: "locked" };
  try {
    const removed = await purgeStaleSessions(cronPool);
    if (removed) log(`removed ${removed} expired/abandoned billing import sessions`);
    return { removed };
  } catch (e) {
    error("sweep failed:", e.message);
    return { error: e.message };
  } finally {
    await release();
  }
}
