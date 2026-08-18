// ============================================================================
// RBAC single source of truth — shared by the Node server and the Vite client.
//
// Dependency-free pure data + pure functions so it can be imported by both
// `server/` (run directly by Node) and `src/` (bundled by Vite).
//
// ── ENFORCEMENT IS ON ────────────────────────────────────────────────────────
// `GRANT_ALL_CAPABILITIES` is FALSE: access is decided per role by the
// ROLE_CAPABILITIES matrix below — the single place that says who-can-do-what.
// Both the API guards (server/middleware/auth.js) and the frontend nav +
// route guard (src/config/routes.js) read it from this file.
//
// Setting it back to TRUE is the emergency bypass: it makes hasCapability()
// return true for everyone and reopens the whole app. Use it to unblock a
// production lockout, then fix the matrix and turn it off again.
//
// Two things follow from the matrix being live:
//   - Adding a route or page WITHOUT a capability mapping now leaves it open to
//     every logged-in role. Add the mapping in the same change.
//   - normalizeRole() fails closed, so an unrecognized doctors.role silently
//     becomes `guest` (zero capabilities) and that account sees nothing.
//     `node server/scripts/audit-doctor-roles.mjs` checks stored roles for this.
//
// Assert the matrix itself with `node server/scripts/verify-rbac.mjs`.
// ============================================================================

// Master switch. While true, hasCapability() returns true for any role
// (everyone sees/does everything). False — the ROLE_CAPABILITIES matrix is
// active. Flip back to true only as an emergency bypass.
export const GRANT_ALL_CAPABILITIES = false;

// Canonical, lowercase role identifiers stored in doctors.role.
export const ROLES = {
  ADMIN: "admin",
  CONSULTANT: "consultant",
  MO: "mo",
  NURSE: "nurse",
  LAB: "lab",
  TECH: "tech",
  RECEPTION: "reception",
  COORDINATOR: "coordinator",
  PHARMACY: "pharmacy",
  OBT: "obt", // outbound booking / call team — works tomorrow's appointment list
  GUEST: "guest",
};

// Capability keys. A capability is a coarse permission gating a group of API
// route prefixes and frontend pages.
export const CAPABILITIES = {
  // Identity-level lookup: find a patient, see who they are (name, phone, file
  // no, age/sex) and their appointments. Does NOT imply the clinical record.
  PATIENT_READ: "PATIENT_READ",
  // The clinical record itself: labs, medications, biomarkers, documents,
  // outcomes, visit history. Split out from PATIENT_READ so a non-clinical role
  // (the OBT call team) can look a patient up to phone them without being shown
  // 71 lab results and an active-medication list.
  PATIENT_CHART: "PATIENT_CHART",
  CLINICAL_WRITE: "CLINICAL_WRITE", // create/edit visits, intake, exam, plan, notes
  AI_TOOLS: "AI_TOOLS", // /ai, genie-chats, reasoning
  VITALS: "VITALS", // record vitals
  LAB_PORTAL: "LAB_PORTAL", // upload lab results
  LAB_REQUESTS: "LAB_REQUESTS", // view/manage lab test requests
  REFILLS: "REFILLS", // medication refills
  DOSE_REVIEWS: "DOSE_REVIEWS", // dose change requests
  SIDE_EFFECTS: "SIDE_EFFECTS", // patient-reported side effects
  RECEPTION_OPS: "RECEPTION_OPS", // OPD queue, appointments, GHM ops, walk-ins
  ANALYTICS: "ANALYTICS", // reports, clinical intelligence, dashboards
  MED_COLLECTION: "MED_COLLECTION", // pharmacy: mark medicine collection at the counter
  ADMIN: "ADMIN", // manage doctors/roles
  // Patient Flow Management module (docs/FLOW_MANAGEMENT_PLAN.md)
  FLOW_RECEPTION: "FLOW_RECEPTION", // check-in + journey builder
  FLOW_COORDINATOR: "FLOW_COORDINATOR", // live floor dashboard
  FLOW_STATION: "FLOW_STATION", // role station queues (vitals/mo/lab/dietitian/rx)
  FLOW_PHARMACY: "FLOW_PHARMACY", // pharmacy dispense + confirm-exit (stops the clock)
  FLOW_REPORTS: "FLOW_REPORTS", // wait-time / bottleneck analytics
  OBT_OPS: "OBT_OPS", // OBT outbound call team: tomorrow's appointment call list (/api/obt-status)
};

const C = CAPABILITIES;

// Wildcard sentinel — a role holding "*" passes every capability check.
export const ALL = "*";

// ── The matrix ──────────────────────────────────────────────────────────────
// role -> array of capabilities (or ALL for everything). This is the one place
// to adjust who-can-do-what once GRANT_ALL_CAPABILITIES is set to false.
//
// These arrays are LIVE — editing one immediately changes what that role can
// reach, on both the API and the frontend. Re-run
// `node server/scripts/verify-rbac.mjs` after any change here.
export const ROLE_CAPABILITIES = {
  [ROLES.ADMIN]: ALL,
  [ROLES.CONSULTANT]: [
    C.PATIENT_READ,
    C.PATIENT_CHART,
    C.CLINICAL_WRITE,
    C.AI_TOOLS,
    C.VITALS,
    C.LAB_REQUESTS,
    C.REFILLS,
    C.DOSE_REVIEWS,
    C.SIDE_EFFECTS,
    C.RECEPTION_OPS,
    C.ANALYTICS,
    C.FLOW_STATION,
    C.FLOW_REPORTS,
  ],
  [ROLES.MO]: [
    C.PATIENT_READ,
    C.PATIENT_CHART,
    C.CLINICAL_WRITE,
    C.AI_TOOLS,
    C.VITALS,
    C.LAB_REQUESTS,
    C.REFILLS,
    C.DOSE_REVIEWS,
    C.SIDE_EFFECTS,
    C.RECEPTION_OPS,
    C.FLOW_STATION,
  ],
  // No REFILLS: working the refill queue is a prescribing decision, so nurses
  // don't approve them. They can still see a patient's refill history in the
  // chart — /api/patients/:id/refill-requests resolves to /api/patients,
  // not to the top-level /api/refill-requests queue.
  [ROLES.NURSE]: [
    C.PATIENT_READ,
    C.PATIENT_CHART,
    C.VITALS,
    C.LAB_REQUESTS,
    C.SIDE_EFFECTS,
    C.FLOW_STATION,
  ],
  // Lab/tech need PATIENT_READ so they can look up whose report they're
  // uploading (Find + chart), on top of the lab upload/request capabilities.
  [ROLES.LAB]: [C.PATIENT_READ, C.PATIENT_CHART, C.LAB_PORTAL, C.LAB_REQUESTS, C.FLOW_STATION],
  [ROLES.TECH]: [C.PATIENT_READ, C.PATIENT_CHART, C.LAB_PORTAL, C.LAB_REQUESTS, C.FLOW_STATION],
  [ROLES.RECEPTION]: [
    C.PATIENT_READ,
    C.PATIENT_CHART,
    C.LAB_REQUESTS,
    C.REFILLS,
    C.RECEPTION_OPS,
    C.MED_COLLECTION,
    C.FLOW_RECEPTION,
    C.FLOW_COORDINATOR,
    C.OBT_OPS,
  ],
  // Coordinators run GHM ops/calling and need Genie Chats with patients.
  [ROLES.COORDINATOR]: [
    C.PATIENT_READ,
    C.PATIENT_CHART,
    C.AI_TOOLS,
    C.RECEPTION_OPS,
    C.FLOW_RECEPTION,
    C.FLOW_COORDINATOR,
    C.FLOW_REPORTS,
    C.OBT_OPS,
  ],
  [ROLES.PHARMACY]: [
    C.PATIENT_READ,
    C.PATIENT_CHART,
    C.REFILLS,
    C.DOSE_REVIEWS,
    C.MED_COLLECTION,
    C.FLOW_PHARMACY,
    C.FLOW_STATION,
  ],
  // OBT outbound call team. The ONLY role without PATIENT_CHART: they phone
  // patients to confirm tomorrow's appointment, which needs identity and phone
  // (PATIENT_READ) but not labs, medications or documents. /find and /ghm reach
  // them through those pages' own any-of gates, not through RECEPTION_OPS, so
  // /opd and the reception inbox stay closed. Doctor roles (consultant/mo) are
  // intentionally excluded from OBT_OPS.
  [ROLES.OBT]: [C.PATIENT_READ, C.OBT_OPS],
  [ROLES.GUEST]: [],
};

// Legacy / mis-cased aliases mapped to canonical roles.
const ROLE_ALIASES = {
  md: ROLES.CONSULTANT,
};

// Normalize a stored role to a known canonical value. Unknown roles fail
// closed to GUEST (no capabilities) rather than silently inheriting access.
export function normalizeRole(role) {
  if (!role || typeof role !== "string") return ROLES.GUEST;
  const lower = role.trim().toLowerCase();
  if (ROLE_ALIASES[lower]) return ROLE_ALIASES[lower];
  return Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, lower) ? lower : ROLES.GUEST;
}

// True if the given role holds the capability. Admin / ALL short-circuits true.
// (If the master switch is ever flipped back on, everyone is granted everything.)
export function hasCapability(role, capability) {
  if (GRANT_ALL_CAPABILITIES) return true;
  const caps = ROLE_CAPABILITIES[normalizeRole(role)];
  if (!caps) return false;
  if (caps === ALL) return true;
  return caps.includes(capability);
}

// True if the role holds ANY of the given capabilities. Accepts a bare
// capability or an array of them, so callers can pass a route/page gate
// straight through without checking its shape first.
//
// Needed because some surfaces are legitimately reached by several roles that
// arrive from different capabilities — every FLOW_* role reads and advances the
// same /api/flow/visits, but no single capability is common to all of them
// (reception/coordinator have FLOW_RECEPTION, clinicians have FLOW_STATION,
// pharmacy has FLOW_PHARMACY). An any-of gate expresses that without inventing
// a synthetic "can touch flow" capability that duplicates the other four.
export function hasAnyCapability(role, capabilities) {
  if (GRANT_ALL_CAPABILITIES) return true;
  const list = Array.isArray(capabilities) ? capabilities : [capabilities];
  return list.some((c) => hasCapability(role, c));
}
