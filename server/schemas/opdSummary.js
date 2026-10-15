import { z } from "zod";
import { OPD_SORTS, OPD_STATUS_OPTIONS, OPD_TYPE_SETS } from "../../shared/opdSummary.js";

const IST_MONTH = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
});

export const currentMonth = () => IST_MONTH.format(new Date()).slice(0, 7);

const isRealDate = (text) => {
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
};

const TYPES = Object.keys(OPD_TYPE_SETS);
const STATUSES = OPD_STATUS_OPTIONS.map((o) => o.value);
const blankToUndefined = (v) => (v === "" ? undefined : v);
const choice = (values) =>
  z.preprocess(
    blankToUndefined,
    z.enum(values, { message: `must be one of: ${values.join(", ")}` }).optional(),
  );

const month = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: "must be a month like 2026-10", abort: true })
    .refine((v) => v >= "2015-01", "must be January 2015 or later")
    .refine((v) => v <= currentMonth(), "cannot be a future month")
    .optional(),
);

const count = (label, max) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^[1-9]\d{0,6}$/, `must be a whole number from 1`)
      .transform(Number)
      .refine((v) => v <= max, `${label} is too large (at most ${max})`)
      .optional(),
  );

const base = {
  month,
  doctor: z.preprocess(blankToUndefined, z.string().trim().min(1).max(200).optional()),
  type: choice(TYPES),
};

const withMonth = (value) => ({ ...value, month: value.month || currentMonth() });

export const opdSummaryQuerySchema = z.strictObject(base).transform(withMonth);

export const opdFiltersQuerySchema = z.strictObject({ month }).transform(withMonth);

const visitFields = {
  ...base,
  status: choice(STATUSES),
  day: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be a date like 2026-10-01", abort: true })
      .refine(isRealDate, "must be a real date like 2026-10-01")
      .optional(),
  ),
  q: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
  sort: choice(OPD_SORTS),
};

const dayInMonth = (value) => !value.day || value.day.slice(0, 7) === value.month;
const DAY_RULE = { message: "must be a day inside the chosen month", path: ["day"] };

export const opdVisitsQuerySchema = z
  .strictObject({ ...visitFields, page: count("Page", 100000), limit: count("Rows", 10000) })
  .transform(withMonth)
  .refine(dayInMonth, DAY_RULE);

export const opdExportQuerySchema = z
  .strictObject(visitFields)
  .transform(withMonth)
  .refine(dayInMonth, DAY_RULE);

export const OPD_SUMMARY_LABELS = {
  month: "Month",
  doctor: "Doctor",
  type: "Visit type",
  status: "Status",
  day: "Day",
  q: "Search",
  sort: "Sort",
  page: "Page",
  limit: "Rows",
};
