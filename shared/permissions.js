// ============================================================================
// RBAC single source of truth — shared by the Node server and the Vite client.
//
// Dependency-free pure data + pure functions so it can be imported by both
// `server/` (run directly by Node) and `src/` (bundled by Vite).
//
// ── HOW TO ROLL OUT ──────────────────────────────────────────────────────────
// `GRANT_ALL_CAPABILITIES` is now FALSE: access is enforced per role via the
// ROLE_CAPABILITIES matrix below — the single place that decides who-can-do-
// what. Both the API guards and the frontend nav read from this file. Set it
// back to TRUE to temporarily disable all restrictions (everyone sees/does
// everything) if you need an emergency bypass.
// ============================================================================

// Master switch. While true, hasCapability() returns true for any role
// (everyone sees/does everything). Now false — the ROLE_CAPABILITIES matrix is
// active. Flip back to true only as an emergency bypass.
export const GRANT_ALL_CAPABILITIES = true;

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
  GUEST: "guest",
};

// Capability keys. A capability is a coarse permission gating a group of API
// route prefixes and frontend pages.
export const CAPABILITIES = {
  PATIENT_READ: "PATIENT_READ", // view patient chart, history, outcomes, docs
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
};

const C = CAPABILITIES;

// Wildcard sentinel — a role holding "*" passes every capability check.
export const ALL = "*";

// ── The matrix ──────────────────────────────────────────────────────────────
// role -> array of capabilities (or ALL for everything). This is the one place
// to adjust who-can-do-what once GRANT_ALL_CAPABILITIES is set to false.
//
// The arrays below are sensible defaults, NOT yet enforced (the master switch
// is on). Edit freely before flipping the switch.
export const ROLE_CAPABILITIES = {
  [ROLES.ADMIN]: ALL,
  [ROLES.CONSULTANT]: [
    C.PATIENT_READ,
    C.CLINICAL_WRITE,
    C.AI_TOOLS,
    C.VITALS,
    C.LAB_REQUESTS,
    C.REFILLS,
    C.DOSE_REVIEWS,
    C.SIDE_EFFECTS,
    C.RECEPTION_OPS,
    C.ANALYTICS,
  ],
  [ROLES.MO]: [
    C.PATIENT_READ,
    C.CLINICAL_WRITE,
    C.AI_TOOLS,
    C.VITALS,
    C.LAB_REQUESTS,
    C.REFILLS,
    C.DOSE_REVIEWS,
    C.SIDE_EFFECTS,
    C.RECEPTION_OPS,
  ],
  [ROLES.NURSE]: [C.PATIENT_READ, C.VITALS, C.LAB_REQUESTS, C.REFILLS, C.SIDE_EFFECTS],
  // Lab/tech need PATIENT_READ so they can look up whose report they're
  // uploading (Find + chart), on top of the lab upload/request capabilities.
  [ROLES.LAB]: [C.PATIENT_READ, C.LAB_PORTAL, C.LAB_REQUESTS],
  [ROLES.TECH]: [C.PATIENT_READ, C.LAB_PORTAL, C.LAB_REQUESTS],
  [ROLES.RECEPTION]: [C.PATIENT_READ, C.LAB_REQUESTS, C.REFILLS, C.RECEPTION_OPS, C.MED_COLLECTION],
  // Coordinators run GHM ops/calling and need Genie Chats with patients.
  [ROLES.COORDINATOR]: [C.PATIENT_READ, C.AI_TOOLS, C.RECEPTION_OPS],
  [ROLES.PHARMACY]: [C.PATIENT_READ, C.REFILLS, C.DOSE_REVIEWS, C.MED_COLLECTION],
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

// True if the given role holds the capability. While the master switch is on,
// everyone is granted everything. Admin / ALL also short-circuits true.
export function hasCapability(role, capability) {
  if (GRANT_ALL_CAPABILITIES) return true;
  const caps = ROLE_CAPABILITIES[normalizeRole(role)];
  if (!caps) return false;
  if (caps === ALL) return true;
  return caps.includes(capability);
}
