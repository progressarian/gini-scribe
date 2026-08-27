// What a given role is allowed to see about a block.
//
// The badge goes to everyone who can see the patient at all; the reason, note,
// blocker name and date go only to ADMIN and CLINICAL_WRITE holders. Reception
// and OBT are the roles that trigger refused bookings, so this has to be
// applied to the 409 body as well as to the API responses — hence a shared
// module rather than a helper inside the router.
//
// Design: docs/PATIENT_BLOCKLIST_PLAN.md §3.4
import { hasAnyCapability, CAPABILITIES } from "../../shared/permissions.js";
import { blockReasonLabel } from "../../shared/patientBlockReasons.js";

export const canSeeBlockReason = (role) =>
  hasAnyCapability(role, [CAPABILITIES.ADMIN, CAPABILITIES.CLINICAL_WRITE]);

// row: a patients row (or any object) carrying the six block columns.
export function redactBlock(row, role) {
  if (!row?.is_blocked) return { blocked: false };
  if (!canSeeBlockReason(role)) return { blocked: true };
  return {
    blocked: true,
    reason_code: row.blocked_reason_code || null,
    label: blockReasonLabel(row.blocked_reason_code),
    note: row.blocked_note || null,
    blocked_by: row.blocked_by || null,
    blocked_at: row.blocked_at || null,
  };
}

// The message shown at the point of refusal. Redacted the same way.
export function blockDetail(row, role) {
  if (!canSeeBlockReason(role)) return "This patient is blocked. Contact administration.";
  const label = blockReasonLabel(row?.blocked_reason_code);
  return `This patient is blocked${label ? ` — ${label}` : ""}. Only an administrator can lift it.`;
}
