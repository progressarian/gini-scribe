// The provider HealthRay books a samples-only registration under. It is a real
// row in `doctors` — role 'consultant', which is why the flow sync used to
// resolve it and hand the visit a consultant nobody would ever consult.
//
// Already treated as the lab-only marker in src/lib/flowAppointmentType.js,
// components/opd/TriageViewV3.jsx, components/visit/VisitHistoryPanel.jsx,
// routes/opd.js and routes/ghm-appointments.js. Named here so Gini Flow does
// not become the sixth copy.
export const LAB_ONLY_DOCTOR = "Dr. Hospital Admin";

export const CONSULT_STATUSES = [
  "vitals_pending",
  "with_vitals",
  "vitals_done",
  "sd_pending",
  "with_sd",
  "ready_for_doctor",
  "with_doctor",
  "doctor_done",
  "rx_pending",
  "with_rx",
  "pharmacy_pending",
  "dispensed",
];

export const labOnlyKeepsStep = (step) =>
  step.catalogId !== "billing" && !CONSULT_STATUSES.includes(step.chainStatus);

export const LAB_ONLY_STEP_NAMES = {
  lab_billing: "Lab Billing",
  check_in: "Check-in",
  blood_sample: "Lab Collection",
  lab_processing_2: "Lab Processing",
  report_upload: "Report Upload",
};

const LAB_LEG = ["blood_sample", "lab_processing_2", "report_upload"];

export const labOnlyName = (step) => LAB_ONLY_STEP_NAMES[step.catalogId] || step.name;

export function labOnlyJourney(
  steps,
  catalog = [],
  { hasBilling = false, withLeg = false, saved = false } = {},
) {
  const entry = (id) => catalog.find((c) => c.id === id);
  const chainOf = (s) => s.chainStatus ?? entry(s.catalogId)?.chain_status ?? null;
  const kept = steps.filter((s) => labOnlyKeepsStep({ ...s, chainStatus: chainOf(s) }));
  if (saved)
    return kept
      .filter((s) => !(hasBilling && s.catalogId === "lab_billing"))
      .map((s) => ({ ...s, name: labOnlyName(s) }));
  const own = (id) => kept.find((s) => s.catalogId === id);
  const fromCatalog = (id) => {
    const c = entry(id);
    return c
      ? {
          catalogId: id,
          name: c.name,
          minutes: c.default_duration_min,
          station: c.station,
          role: c.assigned_role,
          chainStatus: c.chain_status ?? null,
          source: "template",
        }
      : null;
  };
  const head = [
    hasBilling ? null : own("lab_billing") || fromCatalog("lab_billing"),
    own("check_in") || fromCatalog("check_in"),
  ];
  const leg =
    own("blood_sample") || withLeg
      ? LAB_LEG.map((id) => own(id) || fromCatalog(id))
          .filter(Boolean)
          .map((s) => (withLeg && s.source === "template" ? { ...s, source: "lab_only" } : s))
      : [];
  const rest = kept.filter((s) => !LAB_ONLY_STEP_NAMES[s.catalogId]);
  return [...head, ...leg]
    .filter(Boolean)
    .map((s) => ({ ...s, name: LAB_ONLY_STEP_NAMES[s.catalogId] }))
    .concat(rest);
}

export const isLabOnlyDoctor = (name) =>
  (name || "").trim().toLowerCase() === LAB_ONLY_DOCTOR.toLowerCase();

export const isInvestigationVisit = (row) =>
  String(row?.visit_type || "")
    .trim()
    .toLowerCase() === "investigation" || isLabOnlyDoctor(row?.doctor_name);

export const PROCEDURE_STEP = "procedure";

export const procedureStep = (catalogRow, names) =>
  catalogRow && names?.length
    ? {
        catalogId: PROCEDURE_STEP,
        name: names.join(" + "),
        minutes: catalogRow.default_duration_min,
        station: catalogRow.station,
        role: catalogRow.assigned_role,
        chainStatus: null,
        source: "template",
        billedIn: "healthray",
      }
    : null;

export function withProcedure(steps, procedure, { only = false } = {}) {
  if (!procedure) return steps;
  const rest = steps.filter((s) => s.catalogId !== PROCEDURE_STEP);
  const kept = only
    ? rest.filter((s) => s.catalogId === "check_in" || (s.source && s.source !== "template"))
    : rest;
  const at = kept.findIndex((s) => s.catalogId === "check_in") + 1;
  return [...kept.slice(0, at), procedure, ...kept.slice(at)];
}
