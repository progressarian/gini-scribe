export const ROUTE_MAP = {
  home: "/",
  dashboard: "/dashboard",
  quick: "/quick",
  patient: "/patient",
  intake: "/intake",
  fu_load: "/fu-load",
  fu_review: "/fu-review",
  fu_edit: "/fu-edit",
  fu_symptoms: "/fu-symptoms",
  fu_gen: "/fu-gen",
  hxclinical: "/history-clinical",
  exam: "/exam",
  assess: "/assess",
  vitals: "/vitals",
  mo: "/mo",
  consultant: "/consultant",
  plan: "/plan",
  docs: "/docs",
  messages: "/messages",
  labportal: "/lab-portal",
  history: "/history",
  outcomes: "/outcomes",
  ai: "/ai",
  reports: "/reports",
  analytics: "/analytics",
  ci: "/ci",
  visit: "/visit",
  obt_dashboard: "/obt-dashboard",
};

// RBAC: maps a frontend path to the capability required to open it. Used by
// both the nav (AppLayout) and the route guard (RequireCapability). Paths not
// listed here (only "/" now) require no capability — any logged-in staff can
// open them. Kept in sync with the backend ROUTE_CAPABILITIES map.
// These gates are ENFORCED — an unlisted page is open to every logged-in role,
// so add the entry in the same change that adds the page.
//
// Gate a page on the capability its OWN API calls need. A page listed more
// loosely than its endpoints renders for a role that then 403s on every fetch;
// listed more tightly, the API stays reachable to roles the UI hides it from.
import {
  CAPABILITIES as CAP,
  ROLES,
  STATION_CAPABILITY,
  normalizeRole,
} from "../../shared/permissions.js";

export const PAGE_CAPABILITIES = {
  // Patient identity — reachable with lookup alone, because clicking a result in
  // /find navigates here. The clinical sections inside /dashboard are gated
  // separately on PATIENT_CHART within the page itself.
  "/dashboard": CAP.PATIENT_READ,
  "/patient": CAP.PATIENT_READ,
  // The clinical record. PATIENT_CHART, not PATIENT_READ — these are labs,
  // documents, outcomes and visit history, which a call team has no use for.
  "/visit": CAP.PATIENT_CHART,
  "/history": CAP.PATIENT_CHART,
  "/outcomes": CAP.PATIENT_CHART,
  "/docs": CAP.PATIENT_CHART,
  // Patient conversation threads. PATIENT_CHART: clinical correspondence, not
  // identity. The API stays PATIENT_READ because the AppLayout unread badge
  // polls /api/messages for every logged-in role.
  "/messages": CAP.PATIENT_CHART,
  // Clinical documentation / visit workflow
  "/quick": CAP.CLINICAL_WRITE,
  "/intake": CAP.CLINICAL_WRITE,
  "/history-clinical": CAP.CLINICAL_WRITE,
  "/exam": CAP.CLINICAL_WRITE,
  "/assess": CAP.CLINICAL_WRITE,
  "/mo": CAP.CLINICAL_WRITE,
  "/consultant": CAP.CLINICAL_WRITE,
  "/plan": CAP.CLINICAL_WRITE,
  "/fu-load": CAP.CLINICAL_WRITE,
  "/fu-review": CAP.CLINICAL_WRITE,
  "/fu-edit": CAP.CLINICAL_WRITE,
  "/fu-symptoms": CAP.CLINICAL_WRITE,
  "/fu-gen": CAP.CLINICAL_WRITE,
  // Companion — separate layout, but the same clinical capture surface. The
  // prefix also covers its /record/:id, /capture/:id, /multi-capture/:id children.
  "/companion": CAP.CLINICAL_WRITE,
  // Vitals
  "/vitals": CAP.VITALS,
  // AI tools
  "/ai": CAP.AI_TOOLS,
  "/genie-chats": CAP.AI_TOOLS,
  "/app-patients": CAP.AI_TOOLS,
  // Lab
  "/lab-portal": CAP.LAB_PORTAL,
  "/lab-requests": CAP.LAB_REQUESTS,
  "/lab-inbox": CAP.LAB_REQUESTS,
  // Medication
  "/refills": CAP.REFILLS,
  "/dose-change-requests": CAP.DOSE_REVIEWS,
  "/side-effects": CAP.SIDE_EFFECTS,
  // Reception / operations
  "/opd": CAP.RECEPTION_OPS,
  // Find and GHM are shared with the OBT call team (any-of). Deliberately NOT
  // done by giving `obt` RECEPTION_OPS, which would also open /opd and
  // /reception-inbox. /opd above stays reception-only.
  "/ghm": [CAP.RECEPTION_OPS, CAP.OBT_OPS],
  "/obt-dashboard": CAP.OBT_OPS,
  "/doctor-management": CAP.ADMIN,
  "/medicine-collection": CAP.MED_COLLECTION,
  "/reception-inbox": CAP.RECEPTION_OPS,
  // Appointment search + Quick Book (it POSTs /api/appointments — not read-only).
  // Shared with OBT so they can rebook a patient who reschedules on the call.
  "/find": [CAP.RECEPTION_OPS, CAP.OBT_OPS],
  // Analytics
  "/reports": CAP.ANALYTICS,
  "/analytics": CAP.ANALYTICS,
  "/ci": CAP.ANALYTICS,
  // Patient Flow Management
  "/flow/checkin": CAP.FLOW_RECEPTION,
  "/flow/coordinator": CAP.FLOW_FLOOR_VIEW,
  "/flow/my-patients": CAP.FLOW_MY_PATIENTS,
  "/flow/consultants": CAP.FLOW_CONSULTANTS,
  // Consultants have no station desk — the bare path redirects them to their
  // own worklist, which is the desk they do have.
  "/flow/station": [CAP.FLOW_STATION, CAP.FLOW_MY_PATIENTS],
  ...Object.fromEntries(
    Object.entries(STATION_CAPABILITY).map(([slug, cap]) => [`/flow/station/${slug}`, cap]),
  ),
  "/flow/reports": CAP.FLOW_REPORTS,
  "/flow/admin": CAP.ADMIN,
};

export const ROLE_NAV_ALLOWLIST = {
  [ROLES.OBT]: ["/obt-dashboard", "/ghm"],
};

export const ROLE_HOME = {
  [ROLES.OBT]: "/obt-dashboard",
};

export function navAllowlistForRole(role) {
  return ROLE_NAV_ALLOWLIST[normalizeRole(role)] || null;
}

export function homeForRole(role) {
  return ROLE_HOME[normalizeRole(role)] || null;
}
