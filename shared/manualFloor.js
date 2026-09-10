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
