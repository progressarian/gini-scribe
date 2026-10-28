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
