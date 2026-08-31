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
  FLOW_STATION: "FLOW_STATION", // umbrella: holds at least one station desk
  FLOW_STATION_VITALS: "FLOW_STATION_VITALS",
  FLOW_STATION_MO: "FLOW_STATION_MO",
  FLOW_STATION_LAB: "FLOW_STATION_LAB",
  FLOW_STATION_DIET: "FLOW_STATION_DIET",
  FLOW_STATION_RX: "FLOW_STATION_RX",
  FLOW_STATION_PHARM: "FLOW_STATION_PHARM",
  FLOW_STATION_REPORTS: "FLOW_STATION_REPORTS",
  FLOW_FLOOR_VIEW: "FLOW_FLOOR_VIEW", // read the live floor board (no management)
  // A consultant's own worklist + hand-over offers. Consultants only: SD is
  // always a consultant (2,802) or admin (73), never an MO, so an MO's list
  // would always be empty.
  FLOW_MY_PATIENTS: "FLOW_MY_PATIENTS",
  // Consultant Station: the floor-wide view of who is seeing whom. Managers get
  // the hand-over controls on top; consultants get the read-only roll-call.
  FLOW_CONSULTANTS: "FLOW_CONSULTANTS",
  FLOW_PHARMACY: "FLOW_PHARMACY", // pharmacy dispense + confirm-exit (stops the clock)
  FLOW_REPORTS: "FLOW_REPORTS", // wait-time / bottleneck analytics

  // Gini Flow — the replacement floor system (docs/gini-flow/). Deliberately its
  // own keys rather than reusing FLOW_*: access to the two boards is granted
  // independently while both run, and retiring the old module means deleting
  // every FLOW_* key without touching these.
  GINIFLOW_VIEW: "GINIFLOW_VIEW", // read the Gini Flow manager board
  GINIFLOW_SLA_ADMIN: "GINIFLOW_SLA_ADMIN", // edit the Gini Flow time budgets
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
    // No station desk: a consultant's work is the SD/Chief consultation, done
    // from /consultant. In 2,837 MO steps not one was ever worked by a
    // consultant, and putting them on the MO desk only invited confusion
    // between the MO workup and their own consultation.
    C.FLOW_FLOOR_VIEW,
    // My Patients only. The floor-wide roll-call is folded into that page as a
    // second column, so a consultant has one desk, not two.
    C.FLOW_MY_PATIENTS,
    C.FLOW_REPORTS,
    C.GINIFLOW_VIEW,
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
    C.FLOW_STATION_MO,
    C.FLOW_FLOOR_VIEW,
    C.GINIFLOW_VIEW,
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
    C.FLOW_STATION_VITALS,
    C.FLOW_STATION_DIET,
    C.FLOW_STATION_RX,
    C.FLOW_FLOOR_VIEW,
    C.GINIFLOW_VIEW,
  ],
  // Lab/tech need PATIENT_READ so they can look up whose report they're
  // uploading (Find + chart), on top of the lab upload/request capabilities.
  [ROLES.LAB]: [
    C.PATIENT_READ,
    C.PATIENT_CHART,
    C.LAB_PORTAL,
    C.LAB_REQUESTS,
    C.FLOW_STATION,
    C.FLOW_STATION_LAB,
    C.FLOW_FLOOR_VIEW,
    C.GINIFLOW_VIEW,
  ],
  [ROLES.TECH]: [
    C.PATIENT_READ,
    C.PATIENT_CHART,
    C.LAB_PORTAL,
    C.LAB_REQUESTS,
    C.FLOW_STATION,
    C.FLOW_STATION_LAB,
    C.FLOW_FLOOR_VIEW,
  ],
  [ROLES.RECEPTION]: [
    C.PATIENT_READ,
    C.PATIENT_CHART,
    C.LAB_REQUESTS,
    C.REFILLS,
    C.RECEPTION_OPS,
    C.MED_COLLECTION,
    C.FLOW_RECEPTION,
    C.FLOW_COORDINATOR,
    C.FLOW_FLOOR_VIEW,
    C.FLOW_CONSULTANTS,
    C.FLOW_STATION,
    C.FLOW_STATION_VITALS,
    C.OBT_OPS,
    C.GINIFLOW_VIEW,
  ],
  // Coordinators run GHM ops/calling and need Genie Chats with patients.
  // The GDA works two desks: Vitals and the Assistant Station. Dietitian was
  // never theirs — 4 steps ever, none worked by hand, no dietitian accounts —
  // and re-assigning patients between consultants (FLOW_CONSULTANTS) is an
  // admin/reception job. FLOW_COORDINATOR is separate and still lets them
  // override anything from the floor screens.
  [ROLES.COORDINATOR]: [
    C.PATIENT_READ,
    C.PATIENT_CHART,
    C.AI_TOOLS,
    C.RECEPTION_OPS,
    C.FLOW_RECEPTION,
    C.FLOW_COORDINATOR,
    C.FLOW_REPORTS,
    C.FLOW_FLOOR_VIEW,
    C.FLOW_STATION,
    C.FLOW_STATION_VITALS,
    C.FLOW_STATION_REPORTS,
    C.OBT_OPS,
    C.GINIFLOW_VIEW,
    C.GINIFLOW_SLA_ADMIN,
  ],
  [ROLES.PHARMACY]: [
    C.PATIENT_READ,
    C.PATIENT_CHART,
    C.REFILLS,
    C.DOSE_REVIEWS,
    C.MED_COLLECTION,
    C.FLOW_PHARMACY,
    C.FLOW_STATION,
    C.FLOW_STATION_PHARM,
    C.FLOW_FLOOR_VIEW,
    C.GINIFLOW_VIEW,
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

const OWN_LIST_ROLES = [ROLES.CONSULTANT, ROLES.MO];

// Roles that actually hold a personal consultation queue. Admin holds ALL, so a
// plain capability check puts "My Patients" in their switcher too — but admin
// runs the floor, they do not consult, so the desk is meaningless to them.
const OWN_CONSULT_QUEUE_ROLES = [ROLES.CONSULTANT];

export function hasOwnConsultQueue(role) {
  return OWN_CONSULT_QUEUE_ROLES.includes(normalizeRole(role));
}

export function hasOwnPatientList(role) {
  return OWN_LIST_ROLES.includes(normalizeRole(role));
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

// ── Flow stations ───────────────────────────────────────────────────────────
// Each of the six station desks has its own capability, so a role only reaches
// the desk it actually works. STATION_CAPABILITY is keyed by the URL slug
// (/flow/station/:slug); STATION_ROLE_CAPABILITY by the assigned_role stored on
// flow_visit_steps, which is what the queue API and the step guards match on.
export const STATION_CAPABILITY = {
  vitals: CAPABILITIES.FLOW_STATION_VITALS,
  mo: CAPABILITIES.FLOW_STATION_MO,
  lab: CAPABILITIES.FLOW_STATION_LAB,
  dietitian: CAPABILITIES.FLOW_STATION_DIET,
  rx: CAPABILITIES.FLOW_STATION_RX,
  pharmacy: CAPABILITIES.FLOW_STATION_PHARM,
  assistant: CAPABILITIES.FLOW_STATION_REPORTS,
};

export const STATION_ROLE_CAPABILITY = {
  vitals_associate: CAPABILITIES.FLOW_STATION_VITALS,
  mo: CAPABILITIES.FLOW_STATION_MO,
  lab_tech: CAPABILITIES.FLOW_STATION_LAB,
  dietitian: CAPABILITIES.FLOW_STATION_DIET,
  nurse: CAPABILITIES.FLOW_STATION_RX,
  pharmacist: CAPABILITIES.FLOW_STATION_PHARM,
  report_desk: CAPABILITIES.FLOW_STATION_REPORTS,
};

// sd/chief and billing have no station queue — they're worked from the
// clinical screens (/consultant, /flow/my-patients) or the floor — but a step
// assigned to them still needs a real check in canWorkStationRole below, or
// any authenticated role could start/complete someone else's consultation or
// billing step by calling the API directly. SD/Chief is always a consultant
// or admin (never an MO); billing is worked from the floor, i.e. a coordinator.
// Kept separate from STATION_ROLE_CAPABILITY (rather than adding to it) because
// ownsStationRole must keep failing closed here — journey editing on these
// steps stays FLOW_COORDINATOR-only, never granted by holding the desk.
const DESKLESS_ROLE_CAPABILITY = {
  sd: CAPABILITIES.FLOW_MY_PATIENTS,
  chief: CAPABILITIES.FLOW_MY_PATIENTS,
  billing: CAPABILITIES.FLOW_COORDINATOR,
};

// Can this role work a step assigned to `assignedRole`? True waiting-area
// steps (assigned_role 'flow_coordinator', never a doctors.role) stay
// unrestricted — nobody is ever "called in" to a wait step.
export function canWorkStationRole(role, assignedRole) {
  const cap = STATION_ROLE_CAPABILITY[assignedRole];
  if (cap) return hasCapability(role, cap);
  const desklessCap = DESKLESS_ROLE_CAPABILITY[assignedRole];
  if (desklessCap) return hasCapability(role, desklessCap);
  return true;
}

// Stricter form, for editing a journey rather than working a step: the role must
// hold a real station desk for `assignedRole`. Unlike canWorkStationRole this
// fails closed on the desk-less roles (sd, chief, billing, waiting areas), so a
// nurse can add or remove their own Vitals step but not an SD Consultation.
export function ownsStationRole(role, assignedRole) {
  const cap = STATION_ROLE_CAPABILITY[assignedRole];
  return cap ? hasCapability(role, cap) : false;
}

// ── Analytics: per-person gate ───────────────────────────────────────────────
// /analytics (the Population page) and its /api/analytics endpoints are narrower
// than CAP.ANALYTICS, which several roles hold for /reports and /ci. This page
// is restricted to one named admin, so the check is identity-level, not
// role-level: admin role AND a name on the allowlist.
//
// Matched on name because doctors.id is environment-specific. Names are
// compared lowercase as a substring, so "Dr. Gurjot Singh" and a bare short_name
// both match. Add an entry here to widen access.
export const ANALYTICS_ALLOWED_NAMES = ["gurjot"];

// Accepts either shape of the session object: the frontend's currentDoctor
// (doctors row — name/short_name) or the server's req.doctor (JWT claims —
// doctor_name/short_name).
export function canViewAnalytics(doctor) {
  if (!doctor) return false;
  if (normalizeRole(doctor.role) !== ROLES.ADMIN) return false;
  const names = [doctor.name, doctor.doctor_name, doctor.short_name];
  return names.some(
    (n) =>
      typeof n === "string" &&
      ANALYTICS_ALLOWED_NAMES.some((allowed) => n.toLowerCase().includes(allowed)),
  );
}
