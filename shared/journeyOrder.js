import { CHAIN, TERMINAL_STATUSES } from "./giniflowStatus.js";

const LAB_STEP_IDS = ["lab_billing", "blood_sample"];

const DOCTOR_COLUMNS = ["with_sd", "ready_for_doctor", "with_doctor"];

const testRank = (id) => (id === "lab_billing" ? 0 : id === "blood_sample" ? 1 : 2);

export const isTestStep = (catalogId, isMachine) => LAB_STEP_IDS.includes(catalogId) || !!isMachine;

export function testsBeforeDoctors(
  steps,
  {
    idOf = (s) => s.catalogId,
    chainOf = (s) => s.chainStatus,
    statusOf = (s) => s.status,
    machineOf = (s) => s.machine,
  } = {},
) {
  const isTest = (s) => isTestStep(idOf(s), machineOf(s));
  const tests = steps.filter(isTest);
  if (!tests.length) return steps;
  const rest = steps.filter((s) => !isTest(s));
  const doctorAt = rest.findIndex((s) => DOCTOR_COLUMNS.includes(chainOf(s)));
  if (doctorAt < 0 || (statusOf(rest[doctorAt]) ?? "pending") !== "pending") return steps;

  const orderedTests = tests
    .map((s, i) => [s, i])
    .sort(([a, ai], [b, bi]) => testRank(idOf(a)) - testRank(idOf(b)) || ai - bi)
    .map(([s]) => s);
  const next = [...rest.slice(0, doctorAt), ...orderedTests, ...rest.slice(doctorAt)];
  return next.every((s, i) => s === steps[i]) ? steps : next;
}

export function requiredStepsFirst(
  steps,
  { idOf = (s) => s.catalogId, requiresOf = () => null, statusOf = (s) => s.status } = {},
) {
  const pending = (s) => (statusOf(s) ?? "pending") === "pending";
  let next = steps;
  for (let pass = 0; pass < steps.length; pass++) {
    const at = next.findIndex((s, i) => {
      const needed = pending(s) && requiresOf(s);
      return needed && next.findIndex((r, j) => j > i && idOf(r) === needed && pending(r)) > i;
    });
    if (at < 0) break;
    const needed = requiresOf(next[at]);
    const from = next.findIndex((r, j) => j > at && idOf(r) === needed && pending(r));
    const moved = next[from];
    const without = next.filter((_, j) => j !== from);
    next = [...without.slice(0, at), moved, ...without.slice(at)];
  }
  return next;
}

const QUEUE_STATUSES = [
  "vitals_pending",
  "sd_pending",
  "ready_for_doctor",
  "doctor_done",
  "rx_pending",
  "pharmacy_pending",
];

const rankOf = (status) => CHAIN.indexOf(status);

const OPEN = ["pending", "in_progress"];

export function journeyProgress(steps, currentStatus, resumeStatus = null) {
  const stops = (steps || []).filter((s) => !s.background);
  if (!stops.length) return null;
  if (TERMINAL_STATUSES.includes(currentStatus)) {
    return { done: stops.length, total: stops.length, next: null, nextStarted: false };
  }

  const current = rankOf(currentStatus) >= 0 ? currentStatus : resumeStatus;
  const doctorDone = rankOf("doctor_done");
  let lastStation = null;
  const ranked = stops.map((s) => {
    const isStation = s.chain && !QUEUE_STATUSES.includes(s.chain);
    const isQueue = s.chain && !isStation;
    let rank;
    if (s.chain) {
      rank = rankOf(s.chain);
      if (isStation) lastStation = Math.max(lastStation ?? rank, rank);
    } else {
      rank = lastStation === null ? rankOf("checked_in") - 0.5 : lastStation + 1.5;
    }
    return { ...s, rank, isStation, isQueue };
  });

  const reached = Math.max(
    rankOf(current),
    ...ranked.filter((s) => s.status === "done" && s.isStation).map((s) => s.rank),
  );
  const beforeDoctor = reached < doctorDone;

  const isAhead = (s) => {
    if (!OPEN.includes(s.status) || s.isQueue) return false;
    if (s.test) return beforeDoctor;
    return s.rank > reached || (s.isStation && s.chain === current);
  };

  const ahead = ranked.filter(isAhead);
  const here = ahead.find((s) => s.isStation && s.chain === current);
  const nextTest = ahead.find((s) => s.test);
  const next =
    here ||
    (nextTest && !ahead.some((s) => s.status === "in_progress" && !s.test) ? nextTest : null) ||
    [...ahead].sort((a, b) => a.rank - b.rank || a.order - b.order)[0] ||
    null;

  const queued = ranked.filter((s) => s.isQueue && OPEN.includes(s.status) && s.rank > reached);

  return {
    done: stops.length - ahead.length - queued.length,
    total: stops.length,
    next: next?.name || null,
    nextStarted: !!next && (next === here || next.status === "in_progress"),
  };
}
