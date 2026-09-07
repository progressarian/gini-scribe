export const CHAIN = [
  "booked",
  "confirmed",
  "checked_in",
  "vitals_pending",
  "with_vitals",
  "vitals_done",
  "sd_pending",
  "with_sd",
  "ready_for_doctor",
  "with_doctor",
  "doctor_done",
  "rx_pending",
  "with_rx",
  "pharmacy_pending",
  "dispensed",
  "exited",
];
export const EXCEPTION_STATUSES = ["no_show", "cancelled", "blocked_reports", "abandoned"];
export const LAB_TRACK = [
  "ordered",
  "payment_pending",
  "paid",
  "sample_collected",
  "processing",
  "results_ready",
  "uploaded",
];

export const PAYMENT_STATUSES = ["pending", "paid", "insurance_claim"];

export const RESULTS_STATUSES = ["none", "partial", "ready"];

export const CATEGORIES = [
  "worse_out_of_range",
  "worse_in_range",
  "getting_better",
  "in_control",
  "no_reports",
];

export const ACTOR_ROLES = [
  "reception",
  "vitals",
  "mo_sd",
  "doctor",
  "lab",
  "nurse",
  "pharmacy",
  // The floor manager moving a card on the board is a real actor, not the
  // system: an event they caused must be attributable to them in the log.
  "coordinator",
  "system",
];

// Urgent and high are exceptions a manager declares; normal is everyone else,
// so it is the column default and never needs setting.
export const PRIORITIES = ["urgent", "high", "normal"];

export const PRIORITY_LABEL = { urgent: "Urgent", high: "High", normal: "Normal" };

export const PRIORITY_ICON = { urgent: "❗", high: "⬆", normal: "" };

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2 };

export const priorityRank = (priority) => PRIORITY_RANK[priority] ?? 2;

export const STATUS_LABEL = {
  booked: "Booked",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  vitals_pending: "Waiting for vitals",
  with_vitals: "At vitals",
  vitals_done: "Waiting for Chief Endocrinologist",
  sd_pending: "Waiting for Chief Endocrinologist",
  with_sd: "With Chief Endocrinologist",
  ready_for_doctor: "Waiting for consultant",
  with_doctor: "With consultant",
  // Not a status any visit holds — an event the lab writes when a report lands,
  // shown on the timeline as a dated marker.
  results_received: "Reports arrived",
  // The MO's recorded reading of those reports. Same shape: a fact with a
  // timestamp, not a place the patient stood. Without a label here the timeline
  // rendered the raw key.
  reports_reviewed: "Reports read by the MO",
  doctor_done: "Waiting for Prescription Explain",
  rx_pending: "Waiting for Prescription Explain",
  with_rx: "Prescription being explained",
  pharmacy_pending: "At pharmacy",
  dispensed: "Dispensed",
  exited: "Exited",
  no_show: "No show",
  cancelled: "Cancelled",
  blocked_reports: "Blocked — reports",
  abandoned: "Never closed on the floor",
};
export const STATUS_TO_SLA_KEY = {
  checked_in: "checkin_to_vitals",
  vitals_pending: "checkin_to_vitals",
  with_vitals: "vitals",
  vitals_done: "wait_sd",
  sd_pending: "wait_sd",
  with_sd: "sd",
  ready_for_doctor: "wait_doctor",
  with_doctor: "doctor",
  rx_pending: "wait_rx",
  with_rx: "rx_explain",
  pharmacy_pending: "pharmacy",
  blocked_reports: "checkin_to_vitals",
};

export const WAIT_STATUSES = [
  "checked_in",
  "vitals_pending",
  "sd_pending",
  "ready_for_doctor",
  "rx_pending",
];
export const TERMINAL_STATUSES = ["dispensed", "exited"];
export const BOARD_COLUMNS = [
  {
    key: "checked_in",
    name: "Checked in",
    icon: "🏥",
    slaKey: "checkin_to_vitals",
    statuses: ["checked_in", "vitals_pending", "blocked_reports"],
  },
  { key: "vitals", name: "At vitals", icon: "🩺", slaKey: "vitals", statuses: ["with_vitals"] },
  {
    key: "sd",
    name: "With Chief Endocrinologist",
    icon: "👨‍⚕️",
    slaKey: "sd",
    statuses: ["vitals_done", "sd_pending", "with_sd"],
  },
  {
    key: "wait_doctor",
    name: "Waiting — consultant",
    icon: "⏳",
    slaKey: "wait_doctor",
    statuses: ["ready_for_doctor"],
  },
  {
    key: "doctor",
    name: "With consultant",
    icon: "🧑‍⚕️",
    slaKey: "doctor",
    statuses: ["with_doctor"],
  },
  {
    key: "rx",
    name: "Prescription Explain",
    icon: "🗒️",
    slaKey: "rx_explain",
    statuses: ["doctor_done", "rx_pending", "with_rx"],
  },
  {
    key: "pharmacy",
    name: "At pharmacy",
    icon: "💊",
    slaKey: "pharmacy",
    statuses: ["pharmacy_pending"],
  },
  { key: "lab", name: "Lab track", icon: "🧪", slaKey: "lab_total", statuses: null },
  {
    key: "done",
    name: "Done today",
    icon: "✅",
    slaKey: "total_journey",
    statuses: ["dispensed", "exited"],
  },
];

export const OFF_BOARD_STATUSES = ["booked", "confirmed", "no_show", "cancelled", "abandoned"];
export const HEALTHRAY_STATUS_TO_CHAIN = {
  scheduled: "booked",
  checkedin: "checked_in",
  in_visit: "ready_for_doctor",
  completed: "exited",
  seen: "exited",
  cancelled: "cancelled",
  no_show: "no_show",
};

const CHAIN_INDEX = new Map(CHAIN.map((s, i) => [s, i]));

export const isChainStatus = (status) => CHAIN_INDEX.has(status);

export const isExceptionStatus = (status) => EXCEPTION_STATUSES.includes(status);

export const isKnownStatus = (status) => isChainStatus(status) || isExceptionStatus(status);

// Events that are FACTS, not places. They live in giniflow_visit_events beside
// the real statuses because the log is one sequence, but a patient is never
// "in" them: they have no duration, they end no wait and they start none.
//
// Every query that asks "what happened last" or "how long has this hop taken"
// has to skip them, or a report landing mid-wait resets the clock on a patient
// who has been waiting ninety minutes — turning them green at the moment they
// are most overdue — and splits one hop into two in the SLA figures.
export const MARKER_STATUSES = ["results_received", "reports_reviewed"];

export const isMarkerStatus = (status) => MARKER_STATUSES.includes(status);

// For the SQL that has to exclude them. Inlined rather than parameterised
// because these queries are built as template strings and a marker list that
// drifted from this one is exactly the bug it prevents.
export const NOT_A_MARKER_SQL = (col) =>
  `${col} <> ALL (ARRAY[${MARKER_STATUSES.map((m) => `'${m}'`).join(", ")}])`;

// What the wait clock may read as "waiting since". Two kinds of event are not an
// arrival:
//
//   · a marker, which is a fact rather than a place;
//   · a RELEASE — a consultant stepping out, an MO pressing "not my patient".
//     The patient is handed back to the queue they were already in, and their
//     wait did not restart: they never stopped waiting. Reading it reset a
//     patient who had waited two and a half hours to "0m", at the exact moment
//     somebody had looked at them and put them back.
// The rooms a patient is physically taken into, as opposed to the queues they
// wait in. A room they were taken into and handed straight back out of did not
// end their wait.
export const STATION_STATUSES = ["with_vitals", "with_sd", "with_doctor", "with_rx"];

const IN_LIST = (col, list) => `${col} = ANY (ARRAY[${list.map((v) => `'${v}'`).join(", ")}])`;

// What the wait clock may read as "here since". `e` is the events alias, `v` the
// visit's.
//
// Three kinds of event are not an arrival:
//   · a marker — a fact, not a place;
//   · a RELEASE — "not my patient", a consultant stepping out. The patient goes
//     back to the queue they were already in and their wait never stopped;
//   · while they are WAITING, the room that took them and handed them back. A
//     two-minute look does not restart a two-hour wait.
//
// Read together, a patient waiting since 12:17, taken at 13:26 and released at
// 13:28 still reads as waiting since 12:17 — not "0m", which is what the board
// showed at the exact moment somebody had looked at them and put them back.
// A patient actually IN a room is timed from entering it, which is what the
// station's own "at my desk" clock means.
export const WAIT_SINCE_SQL = (alias, visitAlias = "v") =>
  `${NOT_A_MARKER_SQL(`${alias}.status`)}
       AND NOT COALESCE((${alias}.meta->>'released')::boolean, FALSE)
       AND (${IN_LIST(`${visitAlias}.current_status`, STATION_STATUSES)}
            OR NOT ${IN_LIST(`${alias}.status`, STATION_STATUSES)})`;

export const chainIndex = (status) => CHAIN_INDEX.get(status) ?? -1;

export const nextStatus = (status) => {
  const i = chainIndex(status);
  return i === -1 || i === CHAIN.length - 1 ? null : CHAIN[i + 1];
};

export const columnForStatus = (status) =>
  BOARD_COLUMNS.find((c) => c.statuses?.includes(status))?.key ?? null;

export const slaKeyForStatus = (status) => STATUS_TO_SLA_KEY[status] ?? null;

export const isWaitStatus = (status) => WAIT_STATUSES.includes(status);

export const isTerminalStatus = (status) => TERMINAL_STATUSES.includes(status);

export const MAX_FORWARD_JUMP = 2;
export const canTransition = (from, to, resumeFrom = null) => {
  if (!isKnownStatus(to)) return false;
  if (from === null || from === undefined) return isChainStatus(to);
  if (isExceptionStatus(to)) return to !== from;
  if (isExceptionStatus(from)) {
    if (!isChainStatus(to)) return false;
    return resumeFrom ? chainIndex(to) >= chainIndex(resumeFrom) : true;
  }
  if (!isChainStatus(from)) return false;
  const jump = chainIndex(to) - chainIndex(from);
  return jump > 0 && jump <= MAX_FORWARD_JUMP;
};

export const COLUMN_ENTRY_STATUS = {
  checked_in: "checked_in",
  vitals: "with_vitals",
  sd: "sd_pending",
  wait_doctor: "ready_for_doctor",
  doctor: "with_doctor",
  rx: "rx_pending",
  pharmacy: "pharmacy_pending",
  lab: null,
  done: "dispensed",
};

export const ORDERED_COLUMNS = [
  "checked_in",
  "vitals",
  "sd",
  "wait_doctor",
  "doctor",
  "rx",
  "pharmacy",
  "done",
];

export const nextColumn = (key) => {
  const i = ORDERED_COLUMNS.indexOf(key);
  return i === -1 ? null : (ORDERED_COLUMNS[i + 1] ?? null);
};

export const canDropInColumn = (card, columnKey) => {
  const to = COLUMN_ENTRY_STATUS[columnKey];
  if (!to || !card || card.column === columnKey) return false;
  if (nextColumn(card.column) !== columnKey) return false;
  if (isExceptionStatus(card.status)) return false;
  return isChainStatus(card.status) && chainIndex(to) > chainIndex(card.status);
};

export const compareQueue = (a, b) => {
  const ap = a.queuePosition ?? null;
  const bp = b.queuePosition ?? null;
  if (ap !== null && bp !== null && ap !== bp) return ap - bp;
  if (ap !== null && bp === null) return -1;
  if (ap === null && bp !== null) return 1;
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  return (b.statusMinutes ?? 0) - (a.statusMinutes ?? 0);
};

export const CATEGORY_META = {
  worse_out_of_range: {
    icon: "🔴",
    label: "Getting worse — out of range",
    short: "Worse — out of range",
    lead: "Chief consultant leads",
    tone: "red",
  },
  worse_in_range: {
    icon: "🟠",
    label: "Getting worse — in range",
    short: "Worse — in range",
    lead: "SD leads · chief validates",
    tone: "amb",
  },
  getting_better: {
    icon: "🟡",
    label: "Getting better",
    short: "Getting better",
    lead: "SD closes · chief async",
    tone: "byet",
  },
  in_control: {
    icon: "✅",
    label: "In control",
    short: "In control",
    lead: "SD closes independently",
    tone: "grn",
  },
  no_reports: {
    icon: "🔵",
    label: "No reports",
    short: "No reports",
    lead: "Chase reports · send phlebotomist",
    tone: "pu",
  },
};

export const isCategory = (value) => Object.hasOwn(CATEGORY_META, String(value));

export const CATEGORY_SOURCES = ["auto", "coordinator"];

export const TRIAGE_PIPELINE = [
  { key: "total", label: "Total", sub: "Appointments this day", tone: "dim" },
  {
    key: "lab_reports_in",
    label: "Lab reports in",
    sub: "From the lab · auto-synced",
    tone: "warn",
  },
  {
    key: "reports_uploaded",
    label: "Reports uploaded",
    sub: "By patient or coordinator",
    tone: "dim",
  },
  { key: "data_complete", label: "Data complete", sub: "Can be categorised", tone: "ok" },
  { key: "categorised", label: "Categorised", sub: "Sorted into a column", tone: "ok" },
  { key: "assigned", label: "Assigned", sub: "Has a doctor or SD", tone: "ok" },
  { key: "checked_in", label: "Checked in", sub: "Already in the building", tone: "dim" },
  { key: "no_show_cancel", label: "No-show / cancel", sub: "Not coming", tone: "crit" },
];

export const TRIAGE_FILTERS = TRIAGE_PIPELINE.map((s) => s.key);

export const isTriageFilter = (value) => TRIAGE_FILTERS.includes(String(value));
