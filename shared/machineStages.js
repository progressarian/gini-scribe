// The machine room's ladder, and the machines on it
// (docs/gini-flow/36-MACHINE-TEST-STATION-PLAN.md).
//
// Shaped like `shared/labStages.js` deliberately: one table that every screen,
// route and schema derives from. Four separate enum-drift bugs came out of the
// lab station being written the other way round, and each one read as a
// malformed request rather than as the missing step it was.
//
// What it is NOT is a copy of the lab ladder. A machine test has no specimen:
// nothing leaves the patient, nothing travels, nothing waits on a bench. The
// patient IS the sample, which is why there is no handoff here and why the
// patient must be present for two rungs rather than one.

export const MACHINE_ROOM = "machine";

export const MACHINE_RAIL = ["Ordered", "On the machine", "Done", "Report"];

export const MACHINE_RUNGS = [
  {
    key: "ordered",
    bucket: "ordered",
    filter: "ordered",
    rail: 1,
    stageLabel: "Waiting for the machine",
    sectionLabel: "⏳ Waiting for the machine",
    filterLabel: "Waiting",
    statLabel: "Waiting",
    statSub: "not started",
    pill: "sp-sample",
    pillText: "Call now",
    timerLabel: "since order",
    timelineLabel: "Ordered",
    sampleStatuses: ["ordered", "payment_pending", "paid"],
    advanceTo: null,
    advanceLabel: null,
    actionNoun: "the order",
    actionHint: null,
    // R1, as in the lab: the rung a test arrives on is never something anybody
    // clicks. It is a state, not an act.
    needsPatient: false,
  },
  {
    key: "in_progress",
    bucket: "in_progress",
    filter: "in_progress",
    rail: 2,
    stageLabel: "On the machine",
    sectionLabel: "▶️ On the machine now",
    filterLabel: "On the machine",
    statLabel: "On the machine",
    statSub: "in progress",
    pill: "sp-process",
    pillText: "On the machine",
    timerLabel: "on the machine",
    timelineLabel: "Started",
    sampleStatuses: ["in_progress"],
    advanceTo: "in_progress",
    advanceLabel: "▶️ Start test",
    actionNoun: "starting the test",
    actionHint: "Mark that the patient is at the machine and the test has begun.",
    // P1: unlike a blood draw, the patient is needed for the whole test — so
    // both this rung and the next refuse to move while somebody else has them.
    needsPatient: true,
  },
  {
    key: "done",
    bucket: "done",
    filter: "done",
    rail: 3,
    stageLabel: "Test done",
    sectionLabel: "✅ Test done — waiting for the report",
    filterLabel: "Done",
    statLabel: "Test done",
    statSub: "report pending",
    pill: "sp-ready",
    pillText: "Done",
    timerLabel: "since the test",
    timelineLabel: "Test done",
    sampleStatuses: ["done"],
    advanceTo: "done",
    advanceLabel: "✓ Test done",
    actionNoun: "finishing the test",
    actionHint: "Mark that the test is finished and the patient can leave the machine.",
    needsPatient: true,
  },
  {
    key: "reported",
    bucket: "reported",
    filter: "reported",
    rail: 4,
    stageLabel: "Report filed",
    sectionLabel: "📤 Reports filed today",
    filterLabel: "Reported",
    statLabel: "Reported",
    statSub: "on the chart",
    pill: "sp-done",
    pillText: "Reported",
    timerLabel: "reported",
    timelineLabel: "Report filed",
    sampleStatuses: ["reported"],
    advanceTo: "reported",
    advanceLabel: "📤 Upload report",
    actionNoun: "the report",
    actionHint: "Close this test — its report is filed, or its values are typed in.",
    needsPatient: false,
  },
];

// The machines themselves. Durations come from `flow_step_catalog`, so the SLA
// this station shows and the journey the patient is given cannot disagree.
//
// `docTypes` is how a report that arrived through the HealthRay sync is
// recognised — these tests produce no lab case, only a document, so the document
// is the only evidence the test happened at all.
export const MACHINES = [
  {
    id: "abi",
    name: "ABI",
    fullName: "Ankle–Brachial Index",
    icon: "🦵",
    durationMin: 10,
    docTypes: ["abi"],
    tests: ["ABI"],
    values: ["ABI Right", "ABI Left"],
  },
  {
    id: "vpt",
    name: "VPT",
    fullName: "Vibration Perception Threshold",
    icon: "🦶",
    durationMin: 5,
    docTypes: ["vpt"],
    tests: ["VPT"],
    values: ["VPT Right", "VPT Left"],
  },
  {
    id: "fundus",
    name: "Fundus",
    fullName: "Fundus photography",
    icon: "👁️",
    durationMin: 10,
    docTypes: ["eye"],
    tests: ["Fundus"],
    values: [],
  },
  {
    id: "tmt",
    name: "TMT",
    fullName: "Treadmill test",
    icon: "🏃",
    durationMin: 20,
    docTypes: ["tmt"],
    tests: ["TMT"],
    values: [],
  },
  {
    id: "ecg",
    name: "ECG",
    fullName: "Electrocardiogram",
    icon: "💓",
    durationMin: 5,
    docTypes: ["ecg"],
    tests: ["ECG"],
    values: [],
    // The strip is printed at the machine and goes home in the patient's hand.
    // Nothing is filed here, so asking for a report before the test can be
    // closed asks for a file that does not exist — an ECG could never be
    // finished on this screen.
    handover: true,
  },
];

export const MACHINE_STAGES = MACHINE_RUNGS.map((r) => ({ key: r.key, label: r.stageLabel }));

export const machineStageIndexOf = (key) => MACHINE_RUNGS.findIndex((r) => r.key === key);

export const machineRungFor = (key) => MACHINE_RUNGS.find((r) => r.key === key) || null;

export const MACHINE_SAMPLE_FLOW = MACHINE_RUNGS.flatMap((r) => r.sampleStatuses);

export const MACHINE_STATUS_TO_STAGE = Object.fromEntries(
  MACHINE_RUNGS.flatMap((r) => r.sampleStatuses.map((s) => [s, r.key])),
);

export const MACHINE_FILTER_TO_STAGE = Object.fromEntries(
  MACHINE_RUNGS.map((r) => [r.filter, r.key]),
);

// The next step this room can offer from where a test is now. Rungs with no
// label of their own are stepped over, the same way the lab's upload steps over
// a rung nobody clicks.
export const nextMachineStep = (stageKey) =>
  MACHINE_RUNGS.slice(machineStageIndexOf(stageKey) + 1).find((r) => r.advanceLabel) || null;

export const machineFor = (id) => MACHINES.find((m) => m.id === id) || null;

// A machine whose report is handed straight to the patient. The test being over
// IS the whole record: there is no file to attach and no value to type, so the
// evidence gate does not apply to it.
export const machineHandsOver = (id) => !!machineFor(id)?.handover;

// Which machine a test name belongs to. Matched on a flattened name because the
// catalogue, the order line and HealthRay all spell the same test differently —
// "ABI", "ABI Test", "abi" are one machine.
const flatten = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

export const machineForTest = (testName) => {
  const flat = flatten(testName);
  if (!flat) return null;
  return (
    MACHINES.find((m) => m.tests.some((t) => flatten(t) === flat)) ||
    MACHINES.find((m) => m.tests.some((t) => flat.includes(flatten(t)))) ||
    null
  );
};

export const MACHINE_DOC_TYPES = MACHINES.flatMap((m) => m.docTypes);

export const docTypeToMachine = Object.fromEntries(
  MACHINES.flatMap((m) => m.docTypes.map((d) => [d, m.id])),
);

// How long the queue in front of a machine will take, in minutes. The only
// question this station can answer that nothing else on the floor can.
export const waitMinutesFor = (machineId, aheadCount) => {
  const m = machineFor(machineId);
  return m ? aheadCount * m.durationMin : 0;
};
