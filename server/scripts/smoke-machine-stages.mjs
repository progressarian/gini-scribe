// The machine ladder and the machines on it, with no database
// (docs/gini-flow/36-MACHINE-TEST-STATION-PLAN.md §4, §6.1).
//
//   npm run smoke:machine-stages   (from server/)
import {
  MACHINE_RUNGS,
  MACHINE_RAIL,
  MACHINES,
  MACHINE_SAMPLE_FLOW,
  MACHINE_STATUS_TO_STAGE,
  MACHINE_DOC_TYPES,
  machineStageIndexOf,
  machineForTest,
  nextMachineStep,
  waitMinutesFor,
} from "../../shared/machineStages.js";
import { CAPABILITIES as C, hasCapability } from "../../shared/permissions.js";
import { PAGE_CAPABILITIES } from "../../src/config/routes.js";

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "  ok " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

check(
  "the ladder is ordered → in progress → done → reported",
  MACHINE_RUNGS.map((r) => r.key).join(" ") === "ordered in_progress done reported",
  MACHINE_RUNGS.map((r) => r.key).join(" "),
);
check("the arriving rung is never an action", !MACHINE_RUNGS[0].advanceLabel);
check(
  "every other rung has a way to reach it",
  MACHINE_RUNGS.slice(1).every((r) => r.advanceTo && r.advanceLabel),
);
check(
  "the patient is needed for the two working rungs, not the ends",
  MACHINE_RUNGS.filter((r) => r.needsPatient)
    .map((r) => r.key)
    .join(" ") === "in_progress done",
);
check(
  "every rung points at a real rail step",
  MACHINE_RUNGS.every((r) => r.rail >= 1 && r.rail <= MACHINE_RAIL.length),
);
check(
  "every rung has a timeline label and a stat label",
  MACHINE_RUNGS.every((r) => r.timelineLabel && r.statLabel),
);
check(
  "every status maps to exactly one rung",
  MACHINE_SAMPLE_FLOW.every((s) => MACHINE_STATUS_TO_STAGE[s]) &&
    new Set(MACHINE_SAMPLE_FLOW).size === MACHINE_SAMPLE_FLOW.length,
);
check(
  "the flow never runs backwards through the rungs",
  MACHINE_SAMPLE_FLOW.every(
    (s, i) =>
      i === 0 ||
      machineStageIndexOf(MACHINE_STATUS_TO_STAGE[s]) >=
        machineStageIndexOf(MACHINE_STATUS_TO_STAGE[MACHINE_SAMPLE_FLOW[i - 1]]),
  ),
);

console.log("\n── The machines ────────────────────────────────────────────");
check(
  "five machines, Echo and X-Ray excluded",
  MACHINES.map((m) => m.id).join(" ") === "abi vpt fundus tmt ecg",
  MACHINES.map((m) => m.id).join(" "),
);
check(
  "each has a duration, an icon and a doc type",
  MACHINES.every((m) => m.durationMin > 0 && m.icon && m.docTypes.length),
);
check(
  "no two machines claim the same doc type",
  new Set(MACHINE_DOC_TYPES).size === MACHINE_DOC_TYPES.length,
);
check(
  "only ABI and VPT produce values",
  MACHINES.filter((m) => m.values.length)
    .map((m) => m.id)
    .join(" ") === "abi vpt",
);
for (const [name, id] of [
  ["ABI", "abi"],
  ["abi test", "abi"],
  ["VPT", "vpt"],
  ["Fundus", "fundus"],
  ["TMT", "tmt"],
  ["ECG", "ecg"],
]) {
  check(`"${name}" matches ${id}`, machineForTest(name)?.id === id);
}
for (const name of ["HbA1c", "Complete Blood Count(CBC)", "Microalbumin / Creatinine Ratio"]) {
  check(`"${name}" matches no machine`, machineForTest(name) === null);
}
check("a 3-deep TMT queue is an hour", waitMinutesFor("tmt", 3) === 60);
check("an unknown machine has no wait", waitMinutesFor("nope", 3) === 0);

console.log("\n── The step offered next ───────────────────────────────────");
check("from ordered → start", nextMachineStep("ordered")?.advanceTo === "in_progress");
check("from in progress → done", nextMachineStep("in_progress")?.advanceTo === "done");
check("from done → file the report", nextMachineStep("done")?.advanceTo === "reported");
check("from reported → nothing", nextMachineStep("reported") === null);

console.log("\n── Who may open it ─────────────────────────────────────────");
const PAGE = "/giniflow/station/machine";
check(
  `${PAGE} is gated on GINIFLOW_STATION_MACHINE`,
  PAGE_CAPABILITIES[PAGE] === C.GINIFLOW_STATION_MACHINE,
);
check(
  "machine_tech and admin hold it",
  ["machine_tech", "admin"].every((r) => hasCapability(r, C.GINIFLOW_STATION_MACHINE)),
);
check(
  "no lab role holds it",
  ["lab", "lab_admin", "tech", "coordinator", "nurse", "reception"].every(
    (r) => !hasCapability(r, C.GINIFLOW_STATION_MACHINE),
  ),
);
check(
  "machine_tech can reach the API at all",
  hasCapability("machine_tech", C.GINIFLOW_VIEW),
  "GINIFLOW_VIEW — without it the page opens and every call 403s",
);
check(
  "machine_tech holds neither lab room",
  !hasCapability("machine_tech", C.GINIFLOW_STATION_LAB_COLLECT) &&
    !hasCapability("machine_tech", C.GINIFLOW_STATION_LAB_PROCESS),
);
check(
  "tech keeps blood collection, untouched by this work",
  hasCapability("tech", C.GINIFLOW_STATION_LAB_COLLECT),
);

console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
