export const PATIENT_TYPES = ["walkin", "new", "followup", "within3"];

export const PATIENT_TYPE_LABELS = {
  new: "New",
  followup: "Follow-up",
  walkin: "Walk-in",
  within3: "Within 3 days",
};

export const CAP_KEYS = {
  walkin: "capWalkin",
  new: "capNew",
  followup: "capFollowup",
  within3: "capWithin3",
};

export const WITHIN3_VISIT_TYPE = "fu within 3 days";

export const isWithin3VisitType = (visitType) =>
  String(visitType || "")
    .trim()
    .toLowerCase() === WITHIN3_VISIT_TYPE;

export const CAP_MAX = 99;

export const patientTypeOf = (row) => {
  if (row?.is_walkin) return "walkin";
  if (isWithin3VisitType(row?.visit_type)) return "within3";
  if (row?.patient_id == null)
    return /follow/i.test(String(row?.visit_type || "")) ? "followup" : "new";
  return row?.came_before ? "followup" : "new";
};

export const patientTypeSql = (alias = "a") =>
  `CASE WHEN COALESCE(${alias}.is_walkin, FALSE) THEN 'walkin'
        WHEN LOWER(BTRIM(COALESCE(${alias}.visit_type, ''))) = '${WITHIN3_VISIT_TYPE}' THEN 'within3'
        WHEN ${alias}.patient_id IS NULL
          THEN CASE WHEN LOWER(COALESCE(${alias}.visit_type, '')) LIKE '%follow%'
                    THEN 'followup' ELSE 'new' END
        WHEN appointment_patient_came_before(${alias}.patient_id, ${alias}.appointment_date)
          THEN 'followup'
        ELSE 'new' END`;

export const emptyCounts = () => ({ new: 0, followup: 0, walkin: 0, within3: 0, pending: 0 });

export const capsOf = (hour) =>
  Object.fromEntries(PATIENT_TYPES.map((t) => [t, hour?.[CAP_KEYS[t]] ?? null]));

export const hasCapFields = (row) => PATIENT_TYPES.some((t) => row?.[CAP_KEYS[t]] != null);

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
