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

export const nextMachineStep = (stageKey) =>
  MACHINE_RUNGS.slice(machineStageIndexOf(stageKey) + 1).find((r) => r.advanceLabel) || null;

const flatten = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const uniqueNames = (names) => {
  const seen = new Set();
  return names.filter((n) => {
    const key = String(n || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const shapeMachine = (row) => ({
  id: row.id,
  name: row.machine_short_name || row.name,
  fullName: row.machine_full_name || row.name,
  icon: row.machine_icon || "🩺",
  durationMin: Number(row.default_duration_min) || 0,
  tests: uniqueNames([row.order_test_name, ...(row.bill_names || [])]),
  values: row.value_fields || [],
  docTypes: row.report_doc_types || [],
  handover: !!row.hands_over,
  station: row.machine_station || "machine_room",
  // Another machine's id this one can't start until it's reported — Echo
  // requires X-ray (46-XRAY-STATION-PLAN.md). Set by migration only, not
  // admin-editable; see assertReadyToStart in machineStation.js.
  requiresBefore: row.machine_requires_before || null,
});

export const machineFor = (machines, id) => (machines || []).find((m) => m.id === id) || null;

// Which machines a station may see/operate. Additive to the per-machine
// `machine` filter, not a replacement — a station's screen always calls with
// its own `station` and the catalogue is narrowed before anything else runs.
export const machinesForStation = (machines, station) =>
  (machines || []).filter((m) => (m.station || "machine_room") === station);

export const machineHandsOver = (machines, id) => !!machineFor(machines, id)?.handover;

export const machineForTest = (machines, testName) => {
  const flat = flatten(testName);
  if (!flat) return null;
  const list = machines || [];
  return (
    list.find((m) => m.tests.some((t) => flatten(t) === flat)) ||
    list.find((m) => m.tests.some((t) => flat.includes(flatten(t)))) ||
    null
  );
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const phraseMatcher = (name) => {
  const words = String(name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!words.length) return null;
  return new RegExp(`(^|[^a-z0-9])${words.map(escapeRegex).join("[^a-z0-9]+")}($|[^a-z0-9])`, "i");
};

export const machinesOnBillLine = (machines, lineName) => {
  const line = String(lineName || "");
  const found = [];
  for (const m of machines || []) {
    let at = -1;
    for (const test of m.tests) {
      const hit = phraseMatcher(test)?.exec(line);
      if (hit && (at < 0 || hit.index < at)) at = hit.index;
    }
    if (at >= 0) found.push([at, m.id]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, id]) => id);
};

export const machineDocTypes = (machines) => (machines || []).flatMap((m) => m.docTypes);

export const machineIdForDocType = (machines, docType) =>
  (machines || []).find((m) => m.docTypes.includes(docType))?.id || null;

export const waitMinutesFor = (machines, machineId, aheadCount) => {
  const m = machineFor(machines, machineId);
  return m ? aheadCount * m.durationMin : 0;
};
