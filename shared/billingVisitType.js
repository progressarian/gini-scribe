import { isNewVisitType } from "./patientLists.js";

export function billingVisitType(visitType) {
  const text = typeof visitType === "string" ? visitType.trim().toLowerCase() : "";
  if (text.startsWith("invest")) return null;
  return isNewVisitType(text) ? "New" : "Follow Up";
}

export const billingVisitTypeSql = (expr) => `(CASE
    WHEN lower(btrim(COALESCE(${expr}, ''))) LIKE 'invest%' THEN NULL
    WHEN btrim(COALESCE(${expr}, '')) = '' OR lower(btrim(${expr})) LIKE 'new%' THEN 'New'
    ELSE 'Follow Up' END)`;
