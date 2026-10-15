import { z } from "zod";
import {
  BIOMARKER_KEYS,
  BIOMARKER_STATUSES,
  REPORT_PERIODS,
} from "../services/reports/clinicalReport.js";

const blankToUndefined = (v) => (v === "" ? undefined : v);
const choice = (values) =>
  z.preprocess(
    blankToUndefined,
    z.enum(values, { message: `must be one of: ${values.join(", ")}` }).optional(),
  );
const text = (max) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const count = (label, max) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^[1-9]\d{0,6}$/, "must be a whole number from 1")
      .transform(Number)
      .refine((v) => v <= max, `${label} is too large (at most ${max})`)
      .optional(),
  );
const flag = z.preprocess(blankToUndefined, z.enum(["1"]).optional()).transform((v) => v === "1");

const scope = {
  period: choice(REPORT_PERIODS),
  doctor: text(200),
};

const paging = { q: text(100), page: count("Page", 100000), limit: count("Rows", 10000) };

export const reportSummaryQuerySchema = z.strictObject({ ...scope, refresh: flag });

export const biomarkerPatientsQuerySchema = z.strictObject({
  ...scope,
  ...paging,
  status: choice(BIOMARKER_STATUSES),
});

export const scorecardQuerySchema = z.strictObject({ ...scope, ...paging });

export const diagnosesQuerySchema = z.strictObject({
  limit: count("Rows", 1000),
  refresh: flag,
});

export const doctorsQuerySchema = z.strictObject({ refresh: flag });

export const biomarkerKeySchema = z.enum(BIOMARKER_KEYS);

export const CLINICAL_REPORT_LABELS = {
  period: "Period",
  doctor: "Doctor",
  q: "Search",
  page: "Page",
  limit: "Rows",
  status: "Status",
  refresh: "Refresh",
};
