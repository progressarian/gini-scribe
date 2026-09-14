import { MACHINES } from "./machineStages.js";

export const TEST_STEP_IDS = new Set(["lab_billing", "blood_sample", ...MACHINES.map((m) => m.id)]);

const DOCTOR_COLUMNS = ["with_sd", "ready_for_doctor", "with_doctor"];

const testRank = (id) => (id === "lab_billing" ? 0 : id === "blood_sample" ? 1 : 2);

export function testsBeforeDoctors(
  steps,
  { idOf = (s) => s.catalogId, chainOf = (s) => s.chainStatus, statusOf = (s) => s.status } = {},
) {
  const tests = steps.filter((s) => TEST_STEP_IDS.has(idOf(s)));
  if (!tests.length) return steps;
  const rest = steps.filter((s) => !TEST_STEP_IDS.has(idOf(s)));
  const doctorAt = rest.findIndex((s) => DOCTOR_COLUMNS.includes(chainOf(s)));
  if (doctorAt < 0 || (statusOf(rest[doctorAt]) ?? "pending") !== "pending") return steps;

  const orderedTests = tests
    .map((s, i) => [s, i])
    .sort(([a, ai], [b, bi]) => testRank(idOf(a)) - testRank(idOf(b)) || ai - bi)
    .map(([s]) => s);
  const next = [...rest.slice(0, doctorAt), ...orderedTests, ...rest.slice(doctorAt)];
  return next.every((s, i) => s === steps[i]) ? steps : next;
}
