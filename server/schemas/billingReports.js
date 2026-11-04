import { z } from "zod";
import { cleanDate, INT_MAX } from "../services/billing/common.js";
import { CODE_MAX, FILTER_LABELS, PERIODS } from "../services/billing/reportsFilters.js";
import { DASHBOARD_PERIODS } from "../services/billing/dashboardPeriods.js";

const blank = z.literal("");

const realDate = (text) => {
  try {
    return cleanDate(text, "Date") === text;
  } catch {
    return false;
  }
};

const day = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be a date like 2026-10-01", abort: true })
  .refine(realDate, "must be a date like 2026-10-01");

const code = z.string().trim().max(CODE_MAX).regex(/^\S+$/, "must be a code without spaces");

const id = z
  .string()
  .trim()
  .regex(/^[1-9]\d*$/, { message: "must be an id", abort: true })
  .refine((v) => Number(v) <= INT_MAX, `is too large (at most ${INT_MAX})`);

const optional = (schema) => z.union([schema, blank]).optional();

export const billingReportQuerySchema = z.strictObject({
  from: optional(day),
  to: optional(day),
  period: optional(z.enum(PERIODS, { message: `must be one of: ${PERIODS.join(", ")}` })),
  category: optional(code),
  sub_category: optional(code),
  group: optional(code),
  subgroup: optional(code),
  consultant: optional(id),
  user: optional(id),
});

export const BILLING_REPORT_LABELS = FILTER_LABELS;

const dashboardFields = {
  from: optional(day),
  to: optional(day),
  period: optional(z.enum(DASHBOARD_PERIODS, { message: "must be day, week or month" })),
  category: optional(code),
  sub_category: optional(code),
  consultant: optional(id),
};

export const billingDashboardQuerySchema = z.strictObject({
  ...dashboardFields,
  refresh: optional(z.literal("1")),
});

export const BILLING_DASHBOARD_LABELS = {
  from: "From",
  to: "To",
  period: "View by",
  category: "Category",
  sub_category: "Sub-category",
  consultant: "Consultant",
  refresh: "Refresh",
};

export const billingDashboardChargesQuerySchema = z.strictObject({
  ...dashboardFields,
  group: code,
  subgroup: optional(code),
});

export const BILLING_DASHBOARD_CHARGES_LABELS = {
  ...BILLING_DASHBOARD_LABELS,
  group: "Service group",
  subgroup: "Subgroup",
};
