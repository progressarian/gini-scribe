// ============================================================================
// Gini Flow status vocabulary — shared by the Node server and the Vite client.
//
// Dependency-free pure data + pure functions so it can be imported by both
// `server/` (run directly by Node) and `src/` (bundled by Vite).
//
// This is the ONLY definition of the journey. The board's columns, the SLA
// budget each status is measured against, and the transitions the status engine
// will accept all derive from the tables below.
//
// Deliberately unrelated to the older `flow_step_catalog` / `flow_step_templates`
// module: Gini Flow owns its own fixed chain. See docs/gini-flow/00-OVERVIEW.md §2.3.
// ============================================================================

// The main chain, in order. A visit moves down this list; each transition is one
// append-only row in giniflow_visit_events.
export const CHAIN = [
  "booked",
  "confirmed",
  "checked_in",
  "vitals_pending",
  // `with_vitals` is ours, not the brief's. The brief goes vitals_pending →
  // vitals_done, which leaves no state meaning "on the chair having BP taken" —
  // so the board's "At vitals" column and the 5-minute vitals budget would have
  // nothing to measure. The queue and the station are different waits.
  "with_vitals",
  "vitals_done",
  "sd_pending",
  "with_sd",
  "ready_for_doctor",
  "with_doctor",
  "doctor_done",
  "pharmacy_pending",
  "dispensed",
  "exited",
];

// States a visit can enter from outside the chain. `blocked_reports` is
// recoverable — the visit unblocks back to whatever it was doing.
export const EXCEPTION_STATUSES = ["no_show", "cancelled", "blocked_reports"];

// The lab track runs parallel to the chain and does not block it.
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

export const ACTOR_ROLES = ["reception", "vitals", "mo_sd", "doctor", "lab", "pharmacy", "system"];

export const STATUS_LABEL = {
  booked: "Booked",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  vitals_pending: "Waiting for vitals",
  with_vitals: "At vitals",
  vitals_done: "Vitals done",
  sd_pending: "Waiting for SD / MO",
  with_sd: "With SD / MO",
  ready_for_doctor: "Ready for doctor",
  with_doctor: "With doctor",
  doctor_done: "Consultation done",
  pharmacy_pending: "At pharmacy",
  dispensed: "Dispensed",
  exited: "Exited",
  no_show: "No show",
  cancelled: "Cancelled",
  blocked_reports: "Blocked — reports",
};

// Which giniflow_sla_config.station budget a status is measured against.
// A status absent from this map has no budget and its timer renders neutral.
// `vitals_done` and `doctor_done` are transitional — a visit passes through them
// on its way to the next queue and is never parked there, so they carry no budget.
export const STATUS_TO_SLA_KEY = {
  checked_in: "checkin_to_vitals",
  vitals_pending: "checkin_to_vitals",
  with_vitals: "vitals",
  sd_pending: "wait_sd",
  with_sd: "sd",
  ready_for_doctor: "wait_doctor",
  with_doctor: "doctor",
  pharmacy_pending: "pharmacy",
  blocked_reports: "checkin_to_vitals",
};

// Statuses that are a queue rather than a station. The timeline pairs each wait
// with the station that follows it ("8m wait + 12m station").
export const WAIT_STATUSES = ["checked_in", "vitals_pending", "sd_pending", "ready_for_doctor"];

// Board columns, in render order. `statuses` is what collapses into each column;
// `lab` and `done` are computed differently (parallel track / completed visits)
// and carry no status list.
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
    name: "With SD / MO",
    icon: "👨‍⚕️",
    slaKey: "sd",
    statuses: ["vitals_done", "sd_pending", "with_sd"],
  },
  {
    key: "wait_doctor",
    name: "Waiting — doctor",
    icon: "⏳",
    slaKey: "wait_doctor",
    statuses: ["ready_for_doctor"],
  },
  { key: "doctor", name: "With doctor", icon: "🧑‍⚕️", slaKey: "doctor", statuses: ["with_doctor"] },
  {
    key: "pharmacy",
    name: "At pharmacy",
    icon: "💊",
    slaKey: "pharmacy",
    statuses: ["doctor_done", "pharmacy_pending"],
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

// Statuses that keep a patient off the board entirely — they are not in the
// building. They still count in the day's stats.
export const OFF_BOARD_STATUSES = ["booked", "confirmed", "no_show", "cancelled"];

// ── HealthRay ───────────────────────────────────────────────────────────────
// HealthRay is authoritative for the day's list and for four transitions; it
// knows nothing about vitals, the SD workup, the lab or the pharmacy. So it can
// place a patient at a point in the chain but cannot describe the steps in
// between — the sync says "they are here now", it does not walk the journey.
//
// `in_visit` is deliberately mapped to the QUEUE, not the room. HealthRay reports
// it when the patient reaches the consultation stage, which is not the same as a
// doctor having started; the older module learned this the hard way ("one doctor
// showed four consultations at once") and holds the step until the station is
// free. The same rule applies here — see appointmentSync.
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

export const chainIndex = (status) => CHAIN_INDEX.get(status) ?? -1;

export const nextStatus = (status) => {
  const i = chainIndex(status);
  return i === -1 || i === CHAIN.length - 1 ? null : CHAIN[i + 1];
};

export const columnForStatus = (status) =>
  BOARD_COLUMNS.find((c) => c.statuses?.includes(status))?.key ?? null;

export const slaKeyForStatus = (status) => STATUS_TO_SLA_KEY[status] ?? null;

export const isWaitStatus = (status) => WAIT_STATUSES.includes(status);

// How far ahead a single transition may jump. One step is the normal case; two
// allows the legitimate skips the floor actually performs — an SD closing a
// green-category patient straight to doctor_done, or a station marking its own
// queue and work in one action. Anything further is a bug or a mis-click, not a
// journey, and is rejected so the log cannot record a patient who teleported.
export const MAX_FORWARD_JUMP = 2;

// A transition is legal when it steps forward along the chain (by no more than
// MAX_FORWARD_JUMP), enters an exception state, or recovers from
// `blocked_reports`. Backwards moves are rejected: a correction is a new forward
// event, never an edit of history.
//
// `resumeFrom` is the status the visit held before it was blocked. Recovery may
// only re-enter the chain at or after that point — otherwise unblocking would
// walk a patient backwards, which every duration in the system would then
// misreport.
export const canTransition = (from, to, resumeFrom = null) => {
  if (!isKnownStatus(to)) return false;
  if (from === null || from === undefined) return isChainStatus(to);
  if (isExceptionStatus(to)) return to !== from;
  // Every exception state is recoverable, not just `blocked_reports`. A patient
  // marked no-show who turns up late is re-checked-in by HealthRay, and a
  // cancelled appointment can be reinstated — both happen on a real floor, and
  // treating them as terminal made the sync error on every late arrival.
  if (isExceptionStatus(from)) {
    if (!isChainStatus(to)) return false;
    return resumeFrom ? chainIndex(to) >= chainIndex(resumeFrom) : true;
  }
  if (!isChainStatus(from)) return false;
  const jump = chainIndex(to) - chainIndex(from);
  return jump > 0 && jump <= MAX_FORWARD_JUMP;
};
