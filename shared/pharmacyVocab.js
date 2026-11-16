export const PHARMACY_ACCOUNT = "pharmacy";
export const HOSPITAL_ACCOUNT = "hospital";
export const BILL_ACCOUNTS = [HOSPITAL_ACCOUNT, PHARMACY_ACCOUNT];

export const PHARMACY_SERIES = { bill: "PH", receipt: "PHR", credit_note: "PHCN" };

export const MAIN_LOCATION_CODE = "MAIN";
export const LOCATION_KINDS = ["main", "department"];

export const GST_PRESETS = [0, 5, 12, 18];
export const GST_MAX = 28;

export const SCHEDULE_LABEL = {
  none: "Not scheduled",
  H: "Schedule H",
  H1: "Schedule H1",
  X: "Schedule X",
  narcotic: "Narcotic",
};
export const SCHEDULES = Object.keys(SCHEDULE_LABEL);
export const REGISTER_SCHEDULES = ["H1", "X", "narcotic"];

export const UNIT_LABELS = [
  "tab",
  "cap",
  "ml",
  "g",
  "unit",
  "vial",
  "amp",
  "sachet",
  "pen",
  "dose",
];
export const PACK_LABELS = ["strip", "bottle", "box", "tube", "vial", "pack", "unit"];

export const SALE_TYPE_LABEL = {
  opd: "OPD",
  ipd: "IPD",
  walkin: "Walk-in",
  indent: "Department indent",
};
export const SALE_TYPES = Object.keys(SALE_TYPE_LABEL);
export const GST_FOLDED_SALE_TYPES = ["ipd", "indent"];

export const MOVEMENT_KIND_LABEL = {
  opening: "Opening stock",
  purchase: "Purchase",
  sale: "Sale",
  sale_return: "Sale return",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
  indent_issue: "Indent issue",
  indent_return: "Indent return",
  adjustment: "Adjustment",
  expiry_writeoff: "Expiry write-off",
  vendor_return: "Return to vendor",
};
export const MOVEMENT_KINDS = Object.keys(MOVEMENT_KIND_LABEL);
export const INBOUND_MOVEMENTS = [
  "opening",
  "purchase",
  "sale_return",
  "transfer_in",
  "indent_return",
];
export const OUTBOUND_MOVEMENTS = [
  "sale",
  "transfer_out",
  "indent_issue",
  "expiry_writeoff",
  "vendor_return",
];

export const PURCHASE_STATUS_LABEL = { draft: "Draft", posted: "Posted", cancelled: "Cancelled" };
export const PURCHASE_STATUSES = Object.keys(PURCHASE_STATUS_LABEL);

export const TRANSFER_STATUS_LABEL = {
  requested: "Waiting for approval",
  approved: "Approved",
  issued: "Issued",
  cancelled: "Cancelled",
};
export const TRANSFER_STATUSES = Object.keys(TRANSFER_STATUS_LABEL);

export const INDENT_STATUS_LABEL = {
  issued: "Issued",
  billed: "Billed",
  returned: "Returned",
  cancelled: "Cancelled",
};
export const INDENT_STATUSES = Object.keys(INDENT_STATUS_LABEL);

export const CREDIT_REQUEST_KIND = "credit_sale";

export const ADJUSTMENT_REASON_LABEL = {
  physical_count: "Physical count",
  damaged: "Damaged",
  expired: "Expired",
  lost: "Lost / missing",
  entry_error: "Entry correction",
};
export const ADJUSTMENT_REASONS = Object.keys(ADJUSTMENT_REASON_LABEL);

export const NEAR_EXPIRY_WARN_DAYS = 30;
export const EXPIRY_BUCKETS = [
  { key: "expired", label: "Expired", min: null, max: -1 },
  { key: "30", label: "Within 30 days", min: 0, max: 30 },
  { key: "60", label: "31–60 days", min: 31, max: 60 },
  { key: "90", label: "61–90 days", min: 61, max: 90 },
];

export const STOCK_LEVEL_LABEL = {
  out: "Out of stock",
  low: "Below minimum",
  ok: "In range",
  over: "Above maximum",
};

export function stockLevel(qtyUnits, minUnits, maxUnits) {
  if (qtyUnits <= 0) return "out";
  if (minUnits != null && qtyUnits < minUnits) return "low";
  if (maxUnits != null && maxUnits > 0 && qtyUnits > maxUnits) return "over";
  return "ok";
}

export function splitUnits(qtyUnits, packSize) {
  const size = Math.max(1, Number(packSize) || 1);
  const total = Math.max(0, Math.trunc(Number(qtyUnits) || 0));
  return { packs: Math.floor(total / size), loose: total % size };
}

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const HSN_PATTERN = /^[0-9]{4,8}$/;
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export const isValidGstin = (v) =>
  GSTIN_PATTERN.test(
    String(v ?? "")
      .trim()
      .toUpperCase(),
  );
export const isValidPan = (v) =>
  PAN_PATTERN.test(
    String(v ?? "")
      .trim()
      .toUpperCase(),
  );
export const isValidHsn = (v) => HSN_PATTERN.test(String(v ?? "").trim());
export const isValidIfsc = (v) =>
  IFSC_PATTERN.test(
    String(v ?? "")
      .trim()
      .toUpperCase(),
  );

export const GSTIN_HINT = "Enter the 15-character GSTIN, for example 03ABCDE1234F1Z5.";
export const PAN_HINT = "Enter the 10-character PAN, for example ABCDE1234F.";
export const HSN_HINT = "Enter a 4 to 8 digit HSN code.";
export const IFSC_HINT = "Enter the 11-character IFSC, for example HDFC0001234.";

export const WALKIN_REGISTRATION_SOURCE = "pharmacy_walkin";
