import { BILL_CONSULTANT, CATEGORY } from "./reports.js";
import { periodOf } from "./reportsFilters.js";
import { PAID_DRAFT_SQL } from "./labCaseLines.js";

export const BILLED = `(b.status = 'final' OR ${PAID_DRAFT_SQL("b")})`;
export const PAID_DRAFT = PAID_DRAFT_SQL("b");

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

export const CATEGORY_REDUCTION = `GREATEST(l.quantity * l.base_rate - l.actual_amount, 0)`;
export const GROSS = `(l.actual_amount + ${CATEGORY_REDUCTION})`;
export const CONCESSION = `(l.discount + ${CATEGORY_REDUCTION} + l.adjustment_amount)`;
