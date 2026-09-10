// The two lab rooms and the rungs each one owns
// (docs/gini-flow/35-LAB-TWO-ROOM-SPLIT-PLAN.md §3).
//
// Pure ladder rules, no database: the whole point of `shared/labStages.js` is
// that these questions have one answer, so they can be asked without a floor.
//
//   npm run smoke:lab-rooms   (from server/)
import {
  LAB_RUNGS,
  LAB_RAIL,
  LAB_ROOMS,
  visibleRungs,
  roomOwns,
  markableRungs,
  floorActionRungs,
  nextOfferedFor,
  NEXT_SAMPLE_ACTION,
  LAB_SAMPLE_FLOW,
  SAMPLE_STATUS_TO_STAGE,
  stageIndexOf,
} from "../../shared/labStages.js";

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "  ok " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const collection = visibleRungs(LAB_ROOMS.COLLECTION).map((r) => r.key);
const processing = visibleRungs(LAB_ROOMS.PROCESSING).map((r) => r.key);

check(
  "station 1 runs ordered → collected → sent",
  collection.join(" ") === "pending collected sent",
  collection.join(" "),
);
check(
  "station 2 runs received → processing → reported, with the handoff in its inbox",
  processing.join(" ") === "collected sent received processing results reported",
  processing.join(" "),
);
check(
  "the two rooms cover every rung between them",
  new Set([...collection, ...processing]).size === LAB_RUNGS.length,
);
// Everything the collection room has drawn is visible to the analyzer room, not
// just what it has formally sent: a tube carried over without anybody tapping
// "sent" is still on the bench, and a room that cannot see a sample cannot
// record receiving it.
check(
  "the analyzer room watches every tube the collection room has drawn",
  collection.filter((k) => processing.includes(k)).join(" ") === "collected sent",
  collection.filter((k) => processing.includes(k)).join(" "),
);
check(
  "but watching is not owning — the collection room still owns both",
  ["collected", "sent"].every(
    (k) => roomOwns(LAB_ROOMS.COLLECTION, k) && !roomOwns(LAB_ROOMS.PROCESSING, k),
  ),
);
check("the patient-facing rung stays with collection alone", !processing.includes("pending"));

check("'test ordered' is never an action", !LAB_RUNGS[0].action && !LAB_RUNGS[0].actionLabel);
check(
  "no other rung is left without a way to reach it",
  LAB_RUNGS.slice(1).every((r) => r.action && r.advanceTo),
);

for (const r of LAB_RUNGS.slice(1)) {
  const owner = r.room;
  const other = owner === LAB_ROOMS.COLLECTION ? LAB_ROOMS.PROCESSING : LAB_ROOMS.COLLECTION;
  check(
    `${r.key} is owned by the ${owner} room alone`,
    roomOwns(owner, r.key) && !roomOwns(other, r.key),
  );
}
check(
  "the combined view owns everything",
  LAB_RUNGS.every((r) => roomOwns(null, r.key)),
);

// The bar for entering values or attaching a file is `results`, not `processing`
// — a tube on the machine has no numbers yet. So somebody has to say the values
// are out, and that is a step of its own rather than something the upload
// implies.
check(
  "processing leads to results ready, not straight to the upload",
  NEXT_SAMPLE_ACTION.processing?.to === "results_ready",
  NEXT_SAMPLE_ACTION.processing?.label,
);
check(
  "and results ready is what leads to the upload",
  NEXT_SAMPLE_ACTION.results_ready?.to === "uploaded",
  NEXT_SAMPLE_ACTION.results_ready?.label,
);
check(
  "results ready is offered as a button on both tracks",
  markableRungs().some((r) => r.action === "results_ready") &&
    floorActionRungs().some((r) => r.action === "results_ready"),
);

check(
  "every sample status maps to exactly one rung",
  LAB_SAMPLE_FLOW.every((s) => stageIndexOf(SAMPLE_STATUS_TO_STAGE[s]) >= 0) &&
    new Set(LAB_SAMPLE_FLOW).size === LAB_SAMPLE_FLOW.length,
);
check(
  "the sample flow never goes backwards through the rungs",
  LAB_SAMPLE_FLOW.every(
    (s, i) =>
      i === 0 ||
      stageIndexOf(SAMPLE_STATUS_TO_STAGE[s]) >=
        stageIndexOf(SAMPLE_STATUS_TO_STAGE[LAB_SAMPLE_FLOW[i - 1]]),
  ),
);
// Every button a room is shown must be one the service will accept. Both rooms
// see the handoff rungs, so without this each offers the other's next step and
// the tap answers 403.
for (const room of [LAB_ROOMS.COLLECTION, LAB_ROOMS.PROCESSING]) {
  for (const rung of visibleRungs(room)) {
    for (const field of ["advanceLabel", "actionLabel"]) {
      const next = nextOfferedFor(rung.key, room, field);
      if (!next) continue;
      check(
        `${room} at "${rung.key}" is only offered a step it owns (${next.key})`,
        roomOwns(room, next.key),
      );
    }
  }
}
check(
  "the collection room is offered nothing once it has sent the sample",
  !nextOfferedFor("sent", LAB_ROOMS.COLLECTION) &&
    !nextOfferedFor("sent", LAB_ROOMS.COLLECTION, "actionLabel"),
);
check(
  "the analyzer room offers to RECEIVE a tube that was never marked sent",
  nextOfferedFor("collected", LAB_ROOMS.PROCESSING, "actionLabel")?.action === "sample_received",
);
check(
  "the analyzer room's last offered step is the upload itself",
  nextOfferedFor("results", LAB_ROOMS.PROCESSING)?.key === "reported",
);

check(
  "every rung has a line on the case timeline",
  LAB_RUNGS.every((r) => r.timelineLabel),
  LAB_RUNGS.map((r) => r.timelineLabel).join(" · "),
);
check(
  "the two handoff steps are on it — they were the ones missing",
  ["Sent to lab", "Received by lab"].every((l) => LAB_RUNGS.some((r) => r.timelineLabel === l)),
);

check(
  "every rung points at a real rail step",
  LAB_RUNGS.every((r) => r.rail >= 1 && r.rail <= LAB_RAIL.length),
);

// The two screens, and who may open them. The frontend gates on this map and
// the backend on the same capabilities, so a page that a role can reach and
// then 403s on every call is the failure this catches.
const { PAGE_CAPABILITIES } = await import("../../src/config/routes.js");
const { CAPABILITIES: C, hasCapability } = await import("../../shared/permissions.js");

const PAGES = [
  { path: "/giniflow/station/lab/collection", cap: C.GINIFLOW_STATION_LAB_COLLECT },
  { path: "/giniflow/station/lab/processing", cap: C.GINIFLOW_STATION_LAB_PROCESS },
];
for (const page of PAGES) {
  check(`${page.path} is gated on ${page.cap}`, PAGE_CAPABILITIES[page.path] === page.cap);
}

const WHO = [
  { role: "tech", opens: "/giniflow/station/lab/collection" },
  { role: "lab", opens: "/giniflow/station/lab/collection" },
  { role: "lab_admin", opens: "/giniflow/station/lab/processing" },
];
for (const w of WHO) {
  const mine = PAGES.find((p) => p.path === w.opens);
  const theirs = PAGES.find((p) => p.path !== w.opens);
  check(
    `${w.role} may open ${w.opens} and not the other room`,
    hasCapability(w.role, mine.cap) && !hasCapability(w.role, theirs.cap),
  );
}
for (const role of ["admin", "coordinator"]) {
  check(
    `${role} may open both rooms`,
    PAGES.every((p) => hasCapability(role, p.cap)),
  );
}
check(
  "the pre-split path still resolves, so old links land in a room",
  PAGE_CAPABILITIES["/giniflow/station/lab"] === C.GINIFLOW_STATION_LAB,
);

console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
