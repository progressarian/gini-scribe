export const STAFF_ROLE_LABELS = {
  admin: "Admin",
  consultant: "Consultant",
  mo: "Medical officer",
  nurse: "Nurse",
  coordinator: "Coordinator",
  care_coordinator: "Care coordinator",
  lab: "Lab",
  lab_admin: "Lab admin",
  machine_tech: "Machine test station",
  echo_tech: "Echo station",
  xray_tech: "X-ray station",
  tech: "Technician",
  pharmacy: "Pharmacy",
  pharmacy_admin: "Pharmacy admin",
  rx: "Prescription explainer",
  reception: "Reception",
  reception_admin: "Reception admin",
  obt: "OBT team",
  head_of_growth: "Head of growth",
  growth_manager: "Growth manager",
  growth_executive: "Growth executive",
  guest: "Guest",
};

export const staffRoleLabel = (role) =>
  STAFF_ROLE_LABELS[role] || String(role || "").replace(/_/g, " ");

export const SCHEDULED_ROLES = ["consultant", "mo"];
