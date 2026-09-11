export const LAB_ROOMS = {
  COLLECTION: "collection",
  PROCESSING: "processing",
};

export const LAB_RAIL = ["Ordered", "Collect", "Send", "Receive", "Process", "Upload"];

export const LAB_RUNGS = [
  {
    key: "pending",
    timelineLabel: "Registered",
    actionNoun: "the order",
    statLabel: "Test ordered",
    statSub: "not yet collected",
    bucket: "pending",
    filter: "pending",
    room: LAB_ROOMS.COLLECTION,
    handoff: false,
    rail: 1,
    stageLabel: "Collect now",
    sectionLabel: "⏳ Test ordered — collect now",
    filterLabel: "To call",
    pill: "sp-sample",
    pillText: "Collect now",
    timerLabel: "since order",
    sinceLabel: "since order",
    healthrayAt: "registeredAt",
    sampleStatuses: ["ordered", "payment_pending", "paid"],
    advanceTo: null,
    advanceLabel: null,
    action: null,
    floorAction: false,
    actionLabel: null,
    actionDone: null,
    actionPast: null,
    actionHint: null,
    needsPatient: false,
  },
  {
    key: "collected",
    timelineLabel: "Sample collected",
    actionNoun: "collection",
    statLabel: "Collected",
    statSub: "sample taken",
    bucket: "collecting",
    filter: "collecting",
    room: LAB_ROOMS.COLLECTION,
    handoff: true,
    rail: 2,
    stageLabel: "Collected",
    sectionLabel: "🧪 Sample collected — send to the lab",
    filterLabel: "Collected",
    pill: "sp-sample",
    pillText: "Collected",
    timerLabel: "since collection",
    sinceLabel: "since collection",
    healthrayAt: "collectedOn",
    sampleStatuses: ["sample_collected"],
    advanceTo: "sample_collected",
    advanceLabel: "✓ Mark sample collected",
    action: "sample_taken",
    floorAction: true,
    actionLabel: "✓ Mark sample collected",
    actionDone: "Sample collected",
    actionPast: "Sample collected",
    actionHint: "Mark that you have collected the sample from this patient.",
    needsPatient: true,
  },
  {
    key: "sent",
    timelineLabel: "Sent to lab",
    actionNoun: "sending to the lab",
    statLabel: "Sent to lab",
    statSub: "in transit",
    bucket: "sent",
    filter: "sent",
    room: LAB_ROOMS.COLLECTION,
    handoff: true,
    rail: 3,
    stageLabel: "Sent to lab",
    sectionLabel: "📤 Sent to lab — waiting to be received",
    filterLabel: "Sent",
    pill: "sp-sample",
    pillText: "Sent to lab",
    timerLabel: "since sent",
    sinceLabel: "since sent",
    healthrayAt: null,
    sampleStatuses: ["sample_sent"],
    advanceTo: "sample_sent",
    advanceLabel: "📤 Mark sent to lab",
    action: "sample_sent",
    floorAction: true,
    actionLabel: "📤 Mark sent to lab",
    actionDone: "Sent to lab",
    actionPast: "Sent to lab",
    actionHint: "Mark that the sample has left for the lab.",
    needsPatient: false,
  },
  {
    key: "received",
    timelineLabel: "Received by lab",
    actionNoun: "receipt at the lab",
    statLabel: "Received",
    statSub: "at the bench",
    bucket: "received",
    filter: "received",
    room: LAB_ROOMS.PROCESSING,
    handoff: false,
    rail: 4,
    stageLabel: "Received",
    sectionLabel: "📥 Received at the lab",
    filterLabel: "Received",
    pill: "sp-process",
    pillText: "Received",
    timerLabel: "since receipt",
    sinceLabel: "since receipt",
    healthrayAt: "receivedOn",
    sampleStatuses: ["sample_received"],
    advanceTo: "sample_received",
    advanceLabel: "✓ Mark sample received",
    action: "sample_received",
    floorAction: true,
    actionLabel: "✓ Mark sample received",
    actionDone: "Sample received",
    actionPast: "Sample received",
    actionHint: "Mark that the sample has reached the lab bench.",
    needsPatient: false,
  },
  {
    key: "processing",
    timelineLabel: "Processing started",
    actionNoun: "processing",
    statLabel: "Processing",
    statSub: "in analyzer",
    bucket: "processing",
    filter: "processing",
    room: LAB_ROOMS.PROCESSING,
    handoff: false,
    rail: 4,
    stageLabel: "Processing",
    sectionLabel: "⚙️ Processing — samples in analyzer",
    filterLabel: "Processing",
    pill: "sp-process",
    pillText: "Processing",
    timerLabel: "in analyzer",
    sinceLabel: "in analyzer",
    healthrayAt: null,
    sampleStatuses: ["processing"],
    advanceTo: "processing",
    advanceLabel: "⚙️ Start processing",
    action: "processing",
    floorAction: true,
    actionLabel: "⚙️ Start processing",
    actionDone: "Processing",
    actionPast: "Processing started",
    actionHint: "Mark that the sample is on the analyzer.",
    needsPatient: false,
  },
  {
    key: "results",
    timelineLabel: "Results done",
    actionNoun: "results done",
    statLabel: "Ready to upload",
    statSub: "results done",
    bucket: "ready",
    filter: "ready",
    room: LAB_ROOMS.PROCESSING,
    handoff: false,
    rail: 5,
    stageLabel: "Results done",
    sectionLabel: "✅ Results ready — upload now to notify the Chief Endocrinologist",
    filterLabel: "Ready",
    pill: "sp-ready",
    pillText: "Upload now",
    timerLabel: "results waiting",
    sinceLabel: "results waiting",
    healthrayAt: "resultSavedOn",
    sampleStatuses: ["results_ready"],
    advanceTo: "results_ready",
    advanceLabel: "✓ Results done — ready to upload",
    action: "results_ready",
    floorAction: true,
    actionLabel: "✓ Results done — ready to upload",
    actionDone: "Results done",
    actionPast: "Results done",
    actionHint: "Mark that the values are out and the report can be uploaded.",
    needsPatient: false,
  },
  {
    key: "reported",
    timelineLabel: "Reported",
    actionNoun: "the report",
    statLabel: "Uploaded",
    statSub: "Chief Endo notified",
    bucket: "uploaded",
    filter: "done",
    room: LAB_ROOMS.PROCESSING,
    handoff: false,
    rail: 6,
    stageLabel: "Reported",
    sectionLabel: "📤 Reports uploaded today — Chief Endocrinologist notified",
    filterLabel: "Done",
    pill: "sp-done",
    pillText: "Done",
    timerLabel: "uploaded",
    sinceLabel: "reported",
    healthrayAt: "reportedOn",
    sampleStatuses: ["uploaded"],
    advanceTo: "uploaded",
    advanceLabel: "📤 Upload report",
    action: "report_uploaded",
    floorAction: true,
    actionLabel: "✓ Mark done",
    actionDone: "Done",
    actionPast: "Marked done",
    actionHint: "Close this case — its report is filed, or its values are typed in above.",
    needsPatient: false,
  },
];

export const LAB_STAGES = LAB_RUNGS.map((r) => ({ key: r.key, label: r.stageLabel }));

export const LAB_STAGE_KEYS = LAB_RUNGS.map((r) => r.key);

export const stageIndexOf = (key) => LAB_RUNGS.findIndex((r) => r.key === key);

export const rungFor = (key) => LAB_RUNGS.find((r) => r.key === key) || null;

// What a room can SEE, which is wider than what it owns. The analyzer bench is
// shown every tube the collection room has drawn — sent or merely collected —
// because a tube carried over without anybody tapping "sent" is still sitting in
// its rack, and a room that cannot see a sample cannot record receiving it.
export const visibleRungs = (room) =>
  room ? LAB_RUNGS.filter((r) => r.room === room || r.handoff) : LAB_RUNGS.slice();

export const roomOwns = (room, stageKey) => !room || rungFor(stageKey)?.room === room;

export const markableRungs = () => LAB_RUNGS.filter((r) => r.action && r.actionLabel);

export const floorActionRungs = () => LAB_RUNGS.filter((r) => r.floorAction);

export const LAB_SAMPLE_FLOW = LAB_RUNGS.flatMap((r) => r.sampleStatuses);

export const SAMPLE_STATUS_TO_STAGE = Object.fromEntries(
  LAB_RUNGS.flatMap((r) => r.sampleStatuses.map((s) => [s, r.key])),
);

export const SAMPLE_STATUS_TO_BUCKET = Object.fromEntries(
  LAB_RUNGS.flatMap((r) => r.sampleStatuses.map((s) => [s, r.bucket])),
);

export const BUCKET_TO_STAGE = Object.fromEntries(LAB_RUNGS.map((r) => [r.bucket, r.key]));

export const FILTER_TO_TARGETS = Object.fromEntries(
  LAB_RUNGS.map((r) => [r.filter, { bucket: r.bucket, stage: r.key }]),
);

export const NEXT_SAMPLE_ACTION = Object.fromEntries(
  LAB_RUNGS.flatMap((r, i) => {
    const next = LAB_RUNGS.slice(i + 1).find((n) => n.advanceLabel);
    if (!next) return [];
    const from = r.sampleStatuses[r.sampleStatuses.length - 1];
    return [[from, { to: next.advanceTo, label: next.advanceLabel }]];
  }),
);

// The next step THIS room can offer from where a sample is now. Both rooms can
// see the handoff rungs, so "the next rung" and "the next rung I own" are not
// the same question: the analyzer room looking at a tube the collection room
// only marked collected offers to RECEIVE it, skipping a "sent" that is not its
// to record. Rungs with no label of their own (results, which the upload writes)
// are stepped over, which is what makes Process → Upload one tap.
export const nextOfferedFor = (stageKey, room, labelField = "advanceLabel") =>
  LAB_RUNGS.slice(stageIndexOf(stageKey) + 1).find(
    (r) => r[labelField] && (!room || r.room === room),
  ) || null;

export const FLOOR_ACTION_STAGE = Object.fromEntries(
  floorActionRungs().map((r) => [r.action, stageIndexOf(r.key)]),
);

export const ACTION_NOUN = Object.fromEntries(
  LAB_RUNGS.filter((r) => r.action).map((r) => [r.action, r.actionNoun]),
);

export const CASE_ACTION_VERBS = floorActionRungs().map((r) => r.action);

export const ACTION_PAST_LABEL = Object.fromEntries(
  LAB_RUNGS.filter((r) => r.action && r.actionPast).map((r) => [r.action, r.actionPast]),
);

export const railForStage = LAB_RUNGS.map((r) => r.rail);

// A tube still in the patient — every sample status before the draw. One
// definition because more than one station now has to ask the question: the
// machine room will not start a test while blood is still owed, and the
// observation layer names Lab 1 as the desk behind.
export const UNDRAWN_SAMPLE_STATUSES = LAB_RUNGS.filter(
  (r) => stageIndexOf(r.key) < stageIndexOf("collected"),
).flatMap((r) => r.sampleStatuses);
