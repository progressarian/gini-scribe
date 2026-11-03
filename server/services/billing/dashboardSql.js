import { BILL_CONSULTANT, CATEGORY } from "./reports.js";
import { periodOf } from "./reportsFilters.js";

export const BILL_COLUMNS = {
  day: { date: "b.bill_date" },
  category: CATEGORY,
  sub_category: "b.scheme_code",
  consultant: BILL_CONSULTANT,
};

export const PAYMENT_COLUMNS = { ...BILL_COLUMNS, day: { instant: "m.received_at" } };

export const narrowed = (filters) =>
  Boolean(filters.category || filters.sub_category || filters.consultant);

export const bucketOf = (period, column) => periodOf({ period }, column);
