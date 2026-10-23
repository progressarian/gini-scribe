import { columnReady, readiness } from "./readiness.js";

export const approvalsReady = readiness(
  "SELECT to_regclass('public.booking_approvals') IS NOT NULL AS ok",
);

export const requestReasonReady = columnReady("booking_approvals", "request_reason");
