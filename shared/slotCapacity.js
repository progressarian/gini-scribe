import { isNewVisitType } from "./patientLists.js";

export const PATIENT_TYPES = ["new", "followup", "walkin"];

export const PATIENT_TYPE_LABELS = { new: "New", followup: "Follow-up", walkin: "Walk-in" };

export const CAP_MAX = 99;

export const patientTypeOf = (row) =>
  row?.is_walkin ? "walkin" : isNewVisitType(row?.visit_type) ? "new" : "followup";

export const patientTypeSql = (alias = "a") =>
  `CASE WHEN COALESCE(${alias}.is_walkin, FALSE) THEN 'walkin'
        WHEN COALESCE(${alias}.visit_type, '') = '' OR LOWER(${alias}.visit_type) LIKE 'new%' THEN 'new'
        ELSE 'followup' END`;

export const emptyCounts = () => ({ new: 0, followup: 0, walkin: 0, pending: 0 });

export const capsOf = (hour) => ({
  new: hour?.capNew ?? null,
  followup: hour?.capFollowup ?? null,
  walkin: hour?.capWalkin ?? null,
});

export const hasCaps = (caps) => PATIENT_TYPES.some((t) => caps?.[t] != null);

export const isFull = (caps, counts, type) => caps?.[type] != null && counts[type] >= caps[type];

export const capacityNote = (slot) => {
  const caps = slot?.caps;
  if (!hasCaps(caps)) return "";
  const counts = slot.counts || emptyCounts();
  return PATIENT_TYPES.filter((t) => caps[t] != null)
    .map(
      (t) =>
        `${PATIENT_TYPE_LABELS[t]} ${counts[t] ?? 0}/${caps[t]}${isFull(caps, counts, t) ? " full" : ""}`,
    )
    .join(" · ");
};
