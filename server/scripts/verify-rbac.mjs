// Asserts the RBAC wiring without flipping GRANT_ALL_CAPABILITIES.
//
// While that master switch is true, hasCapability() returns true for everyone,
// so you cannot confirm a permission mapping by observing that access works —
// everything works. This script re-implements the capability check WITHOUT the
// switch and runs it against the real ROUTE_CAPABILITIES table, so the matrix
// can be validated as it will behave once the switch is flipped off.
//
//   node server/scripts/verify-rbac.mjs
//
// Add a case here whenever you add a route prefix or change the role matrix.

import { capabilityForPath, requireAuth } from "../middleware/auth.js";
import { ROLE_CAPABILITIES, ALL, normalizeRole } from "../../shared/permissions.js";

// The capability check with the master switch deliberately bypassed.
const can = (role, required) => {
  if (!required) return true; // unmapped path → any authenticated doctor
  const caps = ROLE_CAPABILITIES[normalizeRole(role)];
  if (caps === ALL) return true;
  return (Array.isArray(required) ? required : [required]).some((c) => caps.includes(c));
};

// [path, role, expected]
const ROUTE_CASES = [
  // Flow: the base any-of gate lets every flow role advance a visit...
  ["/api/flow/visits/12/advance", "nurse", true],
  ["/api/flow/visits/12/advance", "pharmacy", true],
  ["/api/flow/visits/12/advance", "reception", true],
  ["/api/flow/visits/12/advance", "obt", false],
  // ...while the narrower sub-prefixes stay owned by one part of the floor.
  ["/api/flow/checkin", "reception", true],
  ["/api/flow/checkin", "nurse", false],
  ["/api/flow/queue/vitals", "nurse", true],
  ["/api/flow/queue/vitals", "reception", true], // holds FLOW_COORDINATOR
  ["/api/flow/queue/vitals", "obt", false],
  ["/api/flow/reports", "coordinator", true],
  ["/api/flow/reports", "reception", false],
  ["/api/flow/demo/seed", "coordinator", false],
  ["/api/flow/visit-types", "reception", true], // GET reference data for check-in
  // Admin backfills — previously reachable with no token at all.
  ["/api/admin/backfill-healthray-docs", "reception", false],
  ["/api/admin/backfill-healthray-docs", "admin", true],
  // Pharmacy worklist / AI utility / scheduling.
  ["/api/pharmacy/collection/today", "pharmacy", true],
  ["/api/pharmacy/collection/today", "nurse", false],
  ["/api/extract", "mo", true],
  ["/api/extract", "lab", false],
  ["/api/availability/day", "reception", true],
  ["/api/availability/day", "pharmacy", false],
  ["/api/doctors/7/profile", "reception", true],
  ["/api/slot-catalog", "coordinator", true],
  ["/api/app-installs", "coordinator", true],
  ["/api/companion/mismatch-reviews", "lab", true],
  ["/api/push-tokens", "guest", false],
  // OBT is scoped to its call list, and doctors are kept out of it.
  ["/api/obt-status", "obt", true],
  ["/api/obt-status", "consultant", false],
  // OBT was additionally given /find and /ghm, so it reaches what those pages
  // call — appointments, the GHM sheet, availability and call logging...
  ["/api/appointments", "obt", true],
  ["/api/ghm-appointments", "obt", true],
  ["/api/ghm-appointments/biomarkers", "obt", true],
  ["/api/appointment-changes", "obt", true],
  ["/api/availability/day", "obt", true],
  ["/api/call-attempts", "obt", true],
  ["/api/cc-calling/agents", "obt", true],
  // ...but NOT the rest of the reception surface. These must stay closed, or
  // the grant has silently become RECEPTION_OPS by another name.
  ["/api/opd/appointments", "obt", false],
  ["/api/walkins", "obt", false],
  ["/api/cancellations", "obt", false],
  ["/api/station-tracking", "obt", false],
  ["/api/clinic-holidays", "obt", false],
  ["/api/diabetes-champions", "obt", false],
  ["/api/appointment-slots", "obt", false],
  ["/api/doctors/7/profile", "obt", false],
  // Reception keeps everything it had — the any-of rows must not narrow it.
  ["/api/appointments", "reception", true],
  ["/api/ghm-appointments", "reception", true],
  ["/api/call-attempts", "coordinator", true],
  // PATIENT_CHART split: OBT looks patients up but must not get the record.
  ["/api/documents/55", "obt", false],
  ["/api/outcomes", "obt", false],
  ["/api/documents/55", "nurse", true],
  ["/api/documents/55", "reception", true],
  ["/api/outcomes", "pharmacy", true],
  // Regression: the /api/patient row must not shadow /api/patients.
  ["/api/patients/55", "obt", true],
  ["/api/patient/app/avatar", "obt", true],
  // Nurses do not work the refill queue (a prescribing decision)...
  ["/api/refill-requests", "nurse", false],
  ["/api/refill-requests", "consultant", true],
  // ...but the chart's own refill history stays readable: the nested path
  // resolves to /api/patients (PATIENT_READ), not the top-level queue.
  ["/api/patients/55/refill-requests", "nurse", true],
  // Messaging is PATIENT_READ on both sides — the AppLayout unread badge polls
  // /api/messages for every role, so the page gate had to match, not the API.
  ["/api/messages/unread-count", "nurse", true],
  ["/api/messages/unread-count", "pharmacy", true],
  ["/api/conversations/9/messages", "lab", true],
  ["/api/messages/unread-count", "guest", false],
  // Unknown roles normalize to guest and hold nothing.
  ["/api/patients/55/labs", "guest", false],
];

// [path, doctorSession, expected] — "allow" means next() was called.
// Exercises requireAuth itself, where the public allowlists are tested BEFORE
// the capability map. A regression here would either expose a private endpoint
// or break the login screen / public patient tracker.
const AUTH_CASES = [
  ["/api/flow/track/abc123", undefined, "allow"],
  ["/api/flow/track/abc123/verify", undefined, "allow"],
  ["/api/flow/visits", undefined, 403], // flow is otherwise doctor-only
  ["/api/admin/backfill-healthray-docs", undefined, 401],
  ["/api/health", undefined, "allow"],
  ["/api/doctors", undefined, "allow"], // login picker stays public
];

const runAuth = (path, doctor) => {
  let code = null;
  let nexted = false;
  const res = {
    status(c) {
      code = c;
      return this;
    },
    json() {
      return this;
    },
  };
  requireAuth({ path, doctor }, res, () => {
    nexted = true;
  });
  return nexted ? "allow" : code;
};

let failed = 0;
const check = (ok, line) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${line}`);
};

for (const [path, role, want] of ROUTE_CASES) {
  const required = capabilityForPath(path);
  const got = can(role, required);
  check(
    got === want,
    `${role.padEnd(11)} ${path.padEnd(40)} → ${got}  [${required ?? "unmapped"}]`,
  );
}
for (const [path, doctor, want] of AUTH_CASES) {
  const got = runAuth(path, doctor);
  check(got === want, `requireAuth ${path.padEnd(38)} → ${got} (want ${want})`);
}

console.log(
  failed ? `\n${failed} FAILED` : `\nall ${ROUTE_CASES.length + AUTH_CASES.length} passed`,
);
process.exit(failed ? 1 : 0);
