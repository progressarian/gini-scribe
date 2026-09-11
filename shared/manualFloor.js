// Scribe is the system of record for the OPD floor
// (docs/gini-flow/38-MANUAL-FLOOR-PLAN.md).
//
// HealthRay supplies ONE thing: the day's patient list, so reception has
// somebody to check in. Everything after that — arrival, vitals, the workup, the
// lab, the machines, the prescription, the exit — is recorded by the person who
// did it, on their own station.
//
// A flag rather than deleted code, deliberately. Turning the sync off is a
// change to how the whole floor works, and the honest way to make it is
// reversible: setting SCRIBE_MANUAL_FLOOR="0" brings the old behaviour back
// intact. Nothing here removes data that has already arrived.
//
// It is ON unless that variable says "0", so a deploy needs no environment
// change to get the manual floor, and forgetting one cannot quietly hand the
// floor back to HealthRay. The default is the safe direction: the worst a
// missing variable can do is make the floor record its own work.
export const manualFloor = () => process.env.SCRIBE_MANUAL_FLOOR !== "0";

// What the flag stops, named so a log line can say which of them refused.
export const MANUAL_FLOOR_STOPS = [
  "lab cases, results and report PDFs",
  "HealthRay status mirroring onto our rows",
  "HealthRay vitals observation",
  "advancing a visit somebody is already working",
];

// The two steps no human works, and so the only ones the sync may still write
// (docs/gini-flow/39-HYBRID-FLOOR-PLAN.md §4).
//
// No MO or consultant uses Scribe, so the consultation is the one part of the
// journey HealthRay knows about and the floor does not. Everything else belongs
// to a station: a poll that wrote it would either undo the person who did the
// work or fill in a step nobody performed.
//
// `ready_for_doctor` and `with_doctor` are both here because they are one step —
// the sync parks the patient in the consultant's queue and only moves them into
// the room when the room is free, so that one doctor is not shown seeing four
// patients at once.
//
// `no_show` and `cancelled` stay because they are not steps anybody performs —
// they are the absence of an arrival, and HealthRay is the only thing that knows
// (39 §7 D2).
export const HEALTHRAY_MAY_WRITE = [
  // The Chief Endocrinologist Station — the floor's first doctor stop, and the
  // one the Chief works entirely in HealthRay. Both rungs, because the sync
  // parks the patient in the queue and moves them into the room only when the
  // room is free.
  "sd_pending",
  "with_sd",
  "ready_for_doctor",
  "with_doctor",
  "rx_pending",
  "no_show",
  "cancelled",
];

export const healthrayMayWrite = (status) => !manualFloor() || HEALTHRAY_MAY_WRITE.includes(status);

// The hold (39-HYBRID-FLOOR-PLAN.md §5.2), in the floor's own words: "if pt is
// with mo or chief in healthray that should struck in scribe if previous step is
// not done by the station head".
//
// So a patient HealthRay has moved on stays where the floor left them until
// every station before that point has recorded its own step. The gap is then
// visible on the board and in the Behind panel, and it names the desk.
//
// Its own switch rather than part of `manualFloor`, because this is the one rule
// that can strand a real patient on a working morning: if the floor cannot keep
// up, `SCRIBE_HOLD_ON_UNRECORDED="0"` releases it in one environment change
// while everything else about the manual floor stays exactly as it is.
export const holdOnUnrecorded = () =>
  manualFloor() && process.env.SCRIBE_HOLD_ON_UNRECORDED !== "0";

// The lab's one exception (39-HYBRID-FLOOR-PLAN.md §15).
//
// The Chief and the consultants order lab tests in HealthRay, not here, so with
// the lab sync fully off those patients reached no bench at all — 40 tests a day
// ordered, none visible. So the case LIST comes back on, and nothing else does:
//
//   in   the patient, and which tests the hospital raised for them
//   out  HealthRay's step timestamps, its results, and its report PDFs
//
// The list answers "who is the lab waiting on". Every step after that — drawn,
// sent, received, run, reported — is the bench's own tap, which is what
// `labStepsAreManual` enforces on the ladder.
export const labCaseListOnly = () => manualFloor() && process.env.SCRIBE_LAB_CASE_LIST !== "0";

// And whether the lab SCREEN shows them. The two go together on purpose: a
// station worked manually must not also list work it did not receive — with the
// case list off, a row the floor never ordered is a patient the bench cannot
// bill, collect against or close, and the queue stops being a worklist.
//
// Historical cases stay on the patient's chart either way. This is only about
// what the two lab rooms are asked to work today.
export const labShowsHealthrayCases = () => labCaseListOnly();

// HealthRay's lab clocks are not steps anybody on this floor performed. With the
// list-only sync there is no detail payload to read them from anyway, but the
// list row still carries `phlebotomy_status`, which would silently lift a case
// to "collected" — a step from the hospital's record by the back door.
export const labStepsAreManual = () => manualFloor();

// Where HealthRay's status lands on our chain.
//
// One departure from the raw map: HealthRay's `completed` means the CONSULTATION
// finished, and on a manual floor the prescription counter and the pharmacy come
// after it and are worked by people. Writing `exited` there would close the
// visit in a single event and those two desks would never see a queue — so the
// furthest the sync may take a finished consultation is the Rx desk's door.
//
// Resolved here rather than in `shared/giniflowStatus.js` because that module is
// bundled into the browser, where `process.env` does not exist — and because
// keeping the raw map untouched is what makes the flag reversible.
export const healthrayTarget = (healthrayStatus, statusMap) => {
  const target = statusMap[healthrayStatus];
  if (manualFloor() && target === "exited") return "rx_pending";
  // HealthRay's `in_visit` means "the patient has reached a doctor" and says no
  // more than that. On this floor the first doctor is the Chief Endocrinologist,
  // so that is where the patient lands — the raw map's `ready_for_doctor` sent
  // every one of them to the consultant's queue and left the Chief's screen
  // permanently empty, which is not what the floor does.
  if (manualFloor() && target === "ready_for_doctor") return "sd_pending";
  return target;
};

// The machine room's one exception, and it is the lab's exception exactly
// (39-HYBRID-FLOOR-PLAN.md §15 applied to §16).
//
// The Chief and the consultants raise ABI, VPT, Fundus, TMT and ECG in
// HealthRay, where they are billed as a "Machine Test" line. With nothing
// syncing, the station's five machines read "nothing today" while the machines
// themselves ran all day: 12 tests on 4 patients on 11 Sep 2026, none of them
// ever on the screen.
//
//   in   the patient, and which machines the hospital billed for them
//   out  HealthRay's reports, its timestamps, and any notion of a step
//
// Every rung after the order — start, done, report — is the technician's own
// tap, which is what `machineShowsHealthrayReports` refuses to do for them.
export const machineCaseListOnly = () =>
  manualFloor() && process.env.SCRIBE_MACHINE_CASE_LIST !== "0";

// Whether a report that arrived through the document sync may stand in for work
// the station never recorded.
//
// It may not. The reconciliation list was the only thing the machine screen
// showed, and it showed finished tests under a heading that read "Done today" —
// so a station nobody had used looked like a station doing its work. A PDF is
// evidence that a machine ran; it is not a record of who ran it, when it
// started, or how long the patient waited, and those are the only things this
// station exists to record.
export const machineShowsHealthrayReports = () => !machineCaseListOnly();
