export const PATIENT_TYPES = ["new", "followup", "walkin"];

export const PATIENT_TYPE_LABELS = { new: "New", followup: "Follow-up", walkin: "Walk-in" };

export const CAP_MAX = 99;

export const patientTypeOf = (row) => {
  if (row?.is_walkin) return "walkin";
  if (row?.patient_id == null)
    return /follow/i.test(String(row?.visit_type || "")) ? "followup" : "new";
  return row?.came_before ? "followup" : "new";
};

export const patientTypeSql = (alias = "a") =>
  `CASE WHEN COALESCE(${alias}.is_walkin, FALSE) THEN 'walkin'
        WHEN ${alias}.patient_id IS NULL
          THEN CASE WHEN LOWER(COALESCE(${alias}.visit_type, '')) LIKE '%follow%'
                    THEN 'followup' ELSE 'new' END
        WHEN appointment_patient_came_before(${alias}.patient_id, ${alias}.appointment_date)
          THEN 'followup'
        ELSE 'new' END`;

export const emptyCounts = () => ({ new: 0, followup: 0, walkin: 0, pending: 0 });

export const capsOf = (hour) => ({
  new: hour?.capNew ?? null,
  followup: hour?.capFollowup ?? null,
  walkin: hour?.capWalkin ?? null,
});

export const hasCaps = (caps) => PATIENT_TYPES.some((t) => caps?.[t] != null);

export const isFull = (caps, counts, type) => caps?.[type] != null && counts[type] >= caps[type];

export const overLimitFor = (slot, type, minus = 0) => {
  const limit = slot?.caps?.[type];
  if (limit == null) return null;
  const count = Math.max(0, (slot.counts?.[type] ?? 0) - minus);
  return count >= limit ? { patient_type: type, limit, count } : null;
};

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
