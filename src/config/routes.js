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
  ci: "/ci",
  visit: "/visit",
};

// RBAC: maps a frontend path to the capability required to open it. Used by
// both the nav (AppLayout) and the route guard (RequireCapability). Paths not
// listed here (e.g. "/" and "/find") require no capability — any logged-in
// staff can open them. Kept in sync with the backend ROUTE_CAPABILITIES map.
// While the master switch in shared/permissions.js is on, every role passes.
import { CAPABILITIES as CAP } from "../../shared/permissions.js";

export const PAGE_CAPABILITIES = {
  // Patient chart / read
  "/dashboard": CAP.PATIENT_READ,
  "/patient": CAP.PATIENT_READ,
  "/visit": CAP.PATIENT_READ,
  "/history": CAP.PATIENT_READ,
  "/outcomes": CAP.PATIENT_READ,
  "/docs": CAP.PATIENT_READ,
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
  "/ghm": CAP.RECEPTION_OPS,
  "/doctor-management": CAP.ADMIN,
  "/medicine-collection": CAP.MED_COLLECTION,
  "/reception-inbox": CAP.RECEPTION_OPS,
  "/messages": CAP.RECEPTION_OPS,
  // Analytics
  "/reports": CAP.ANALYTICS,
  "/ci": CAP.ANALYTICS,
};
