import { createLogger } from "../logger.js";
import { tryAcquireCronLock, CRON_LOCK_KEYS } from "./lowPriority.js";
import { syncNewHealthrayPatients } from "../healthray/patientImport.js";

const { log, error } = createLogger("HealthRay Patients");

const TICK_MS = 10 * 60 * 1000;
const FIRST_RUN_MS = 60 * 1000;

let timer = null;
let firstRun = null;

export const healthrayPatientSyncEnabled = () => process.env.SCRIBE_HEALTHRAY_PATIENT_SYNC !== "0";

export async function runHealthrayPatientsSync() {
  const release = await tryAcquireCronLock("HealthRay Patients", CRON_LOCK_KEYS.HEALTHRAY_PATIENTS);
  if (!release) return { skipped: "locked" };
  try {
    return await syncNewHealthrayPatients();
  } catch (e) {
    error("Sync", e.message);
    return { error: e.message, blocked: !!e.healthrayBlocked };
  } finally {
    await release();
  }
}

export function startHealthrayPatientsCron() {
  if (timer || !healthrayPatientSyncEnabled()) return;
  const tick = () => runHealthrayPatientsSync().catch((e) => error("Tick", e.message));
  firstRun = setTimeout(tick, FIRST_RUN_MS);
  timer = setInterval(tick, TICK_MS);
  log("Start", `new HealthRay registrations every ${TICK_MS / 60000} min`);
}

export function stopHealthrayPatientsCron() {
  if (firstRun) clearTimeout(firstRun);
  if (timer) clearInterval(timer);
  firstRun = null;
  timer = null;
}
