import { z } from "zod";
import { OPD_SORTS, OPD_STATUS_OPTIONS, OPD_TYPE_SETS } from "../../shared/opdSummary.js";
import { OPD_DASHBOARD_STATES, OPD_DOCTORS_MAX, OPD_GROUPS } from "../../shared/opdMetrics.js";

const IST_MONTH = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
});

export const currentMonth = () => IST_MONTH.format(new Date()).slice(0, 7);

const IST_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const istToday = () => IST_DAY.format(new Date());

export const OPD_RANGE_DAYS_MAX = 366;
export const OPD_DAY_BUCKETS_MAX = 92;

const DAY_MS = 86400000;
const daysIn = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
const autoGroup = (days) => (days <= 31 ? "day" : days <= 120 ? "week" : "month");

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

const day = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be a date like 2026-10-01", abort: true })
    .refine(isRealDate, { message: "must be a real date like 2026-10-01", abort: true })
    .refine((v) => v >= "2015-01-01", "must be 2015 or later")
    .refine((v) => v <= istToday(), "can't be after today")
    .optional(),
);

const doctors = z.preprocess(
  (v) => {
    const many = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [v];
    const list = many.filter((d) => d !== undefined && d !== "");
    return list.length ? list : undefined;
  },
  z
    .array(z.string().trim().min(1).max(200))
    .max(OPD_DOCTORS_MAX, `choose at most ${OPD_DOCTORS_MAX} doctors`)
    .optional(),
);

const whole = (min, max) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^\d{1,2}$/, `must be a whole number from ${min} to ${max}`)
      .transform(Number)
      .refine((v) => v >= min && v <= max, `must be a whole number from ${min} to ${max}`)
      .optional(),
  );

function checkRange(value, ctx) {
  if (value.from > value.to) {
    ctx.addIssue({ code: "custom", path: ["from"], message: "is after the end date" });
  }
  const days = daysIn(value.from, value.to);
  if (days > OPD_RANGE_DAYS_MAX) {
    ctx.addIssue({
      code: "custom",
      path: ["to"],
      message: `is too far from the start — choose at most ${OPD_RANGE_DAYS_MAX} days`,
    });
  }
  if (value.group === "day" && days > OPD_DAY_BUCKETS_MAX) {
    ctx.addIssue({
      code: "custom",
      path: ["group"],
      message: `day by day covers at most ${OPD_DAY_BUCKETS_MAX} days — group by week or month`,
    });
  }
}

const withRange = (value) => {
  const to = value.to || istToday();
  const from = value.from || `${to.slice(0, 8)}01`;
  return { ...value, from, to, group: value.group || autoGroup(daysIn(from, to)) };
};

export const opdDashboardQuerySchema = z
  .strictObject({
    from: day,
    to: day,
    group: choice(OPD_GROUPS),
    doctor: doctors,
    type: choice(TYPES),
    fresh: choice(["1"]),
  })
  .transform(withRange)
  .superRefine(checkRange);

export const opdFiltersQuerySchema = z
  .strictObject({ month, from: day, to: day })
  .refine((v) => !(v.from && v.month), { message: "can't be used with From/To", path: ["month"] })
  .transform((v) => (v.from || v.to ? withRange(v) : withMonth(v)))
  .superRefine((v, ctx) => {
    if (v.from) checkRange({ ...v, group: undefined }, ctx);
  });

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

const dashboardFields = {
  doctor: doctors,
  from: day,
  to: day,
  state: choice(Object.keys(OPD_DASHBOARD_STATES)),
  weekday: whole(1, 7),
  hour: whole(0, 23),
  group: choice(OPD_GROUPS),
  bucket_start: day,
};

const BOTH_DATES = {
  message: "must be given together with From",
  path: ["to"],
};

export const opdVisitsQuerySchema = z
  .strictObject({
    ...visitFields,
    ...dashboardFields,
    page: count("Page", 100000),
    limit: count("Rows", 10000),
  })
  .refine((v) => Boolean(v.from) === Boolean(v.to), BOTH_DATES)
  .refine((v) => !(v.from && v.month), { message: "can't be used with From/To", path: ["month"] })
  .refine((v) => !v.bucket_start === !v.group, {
    message: "must be given together with Group",
    path: ["bucket_start"],
  })
  .transform((v) => (v.from ? { ...v, group: v.group } : withMonth(v)))
  .superRefine((v, ctx) => {
    if (v.from) checkRange({ ...v, group: undefined }, ctx);
  })
  .refine((v) => v.from || dayInMonth(v), DAY_RULE)
  .refine((v) => !v.from || !v.day || (v.day >= v.from && v.day <= v.to), {
    message: "must be a day inside From and To",
    path: ["day"],
  });

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
  from: "From",
  to: "To",
  group: "Group by",
  state: "Status",
  weekday: "Weekday",
  hour: "Hour",
  bucket_start: "Period start",
  fresh: "Refresh",
};
