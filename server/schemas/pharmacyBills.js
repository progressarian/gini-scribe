import { z } from "zod";
import { UPI_APPS } from "../../shared/billingVocab.js";
import {
  COUNTER_SALE_TYPES,
  PAYMENTS_AT_ONCE,
  PAYMENT_MODES,
  RX_NOT_GIVEN_REASON_LABEL,
  RX_OUTCOMES,
} from "../../shared/pharmacyVocab.js";
import { blankToNull, optionalText, phoneField } from "./pharmacyFields.js";

const id = z.coerce.number().int().min(1);
const version = z.coerce.number().int().min(1);
const uuid = z.uuid("must be a valid id");

const twoDecimals = (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

const ipdNumber = optionalText(40);

export const pharmacyBillLabels = {
  patient_id: "Patient",
  sale_type: "Sale type",
  ipd_number: "IPD number",
  prescriber_name: "Prescribed by",
  qty_units: "Quantity",
  amount: "Amount",
  reference: "Reference",
  upi_app: "UPI app",
  payments: "Payments",
  name: "Name",
  phone: "Mobile number",
  age: "Age",
  sex: "Sex",
  discount_pct: "Discount %",
  discount_value: "Bill discount",
};

const needsIpdNumber = (b) => b.sale_type !== "ipd" || Boolean(b.ipd_number);
const ipdRule = { path: ["ipd_number"], message: "is needed for an IPD sale" };

export const pharmacyBillCreateSchema = z
  .strictObject({
    patient_id: id,
    sale_type: z.enum(COUNTER_SALE_TYPES),
    visit_id: z.preprocess(blankToNull, uuid.nullish()),
    ipd_number: ipdNumber,
    prescriber_name: optionalText(120),
  })
  .refine(needsIpdNumber, ipdRule);

const pct = z.coerce
  .number()
  .min(0, "cannot be below 0")
  .max(100, "cannot be more than 100")
  .refine(twoDecimals, "can have at most 2 decimal places");

const billLine = z.strictObject({
  batch_id: id,
  qty_units: z.coerce.number().int().min(1, "must be at least 1").max(100000),
  near_expiry_ok: z.boolean().optional(),
  discount_pct: z.preprocess(blankToNull, pct.nullish()),
});

export const pharmacyBillUpdateSchema = z
  .strictObject({
    version,
    sale_type: z.enum(COUNTER_SALE_TYPES),
    ipd_number: ipdNumber,
    prescriber_name: optionalText(120),
    notes: optionalText(500),
    discount_kind: z.preprocess(blankToNull, z.enum(["percent", "amount"]).nullish()),
    discount_value: z.preprocess(
      blankToNull,
      z.coerce
        .number()
        .min(0, "cannot be below 0")
        .max(10000000)
        .refine(twoDecimals, "can have at most 2 decimal places")
        .nullish(),
    ),
    lines: z.array(billLine).max(200, "can have at most 200 medicines"),
  })
  .refine(needsIpdNumber, ipdRule)
  .refine((b) => b.discount_kind !== "percent" || !b.discount_value || b.discount_value <= 100, {
    path: ["discount_value"],
    message: "cannot be more than 100%",
  });

const payment = z
  .strictObject({
    mode: z.enum([...PAYMENT_MODES, "deposit"]),
    amount: z.coerce
      .number()
      .positive("must be more than 0")
      .max(10000000)
      .refine(twoDecimals, "can have at most 2 decimal places"),
    reference: optionalText(60),
    upi_app: z.preprocess(blankToNull, z.enum(UPI_APPS).nullish()),
  })
  .refine((p) => p.mode === "cash" || p.mode === "deposit" || Boolean(p.reference), {
    path: ["reference"],
    message: "is needed for a card, UPI or NEFT payment",
  })
  .refine((p) => p.mode !== "upi" || Boolean(p.upi_app), {
    path: ["upi_app"],
    message: "is needed for a UPI payment",
  });

export const pharmacyBillFinaliseSchema = z.strictObject({
  version,
  payments: z.array(payment).max(PAYMENTS_AT_ONCE, `can have at most ${PAYMENTS_AT_ONCE} parts`),
});

export const pharmacyBillVersionSchema = z.strictObject({ version });

export const pharmacyBillListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(["draft", "final", "cancelled", "all"]).default("all"),
  sale_type: z.enum(COUNTER_SALE_TYPES).optional(),
  from: z.preprocess(blankToNull, z.iso.date().nullish()),
  to: z.preprocess(blankToNull, z.iso.date().nullish()),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyBillPatientQuerySchema = z.object({
  q: z.string().trim().min(2, "must be at least 2 characters").max(80),
  limit: z.coerce.number().int().min(1).max(51).default(20),
  offset: z.coerce.number().int().min(0).max(5000).default(0),
});

export const pharmacyWalkinSchema = z.strictObject({
  name: z.string().trim().min(2, "must be at least 2 characters").max(120),
  phone: phoneField,
  age: z.preprocess(blankToNull, z.coerce.number().int().min(0).max(130).nullish()),
  sex: z.preprocess(blankToNull, z.enum(["Male", "Female", "Other"]).nullish()),
  address: optionalText(300),
});

const refund = z
  .strictObject({
    mode: z.enum(PAYMENT_MODES),
    reference: optionalText(60),
    upi_app: z.preprocess(blankToNull, z.enum(UPI_APPS).nullish()),
  })
  .refine((p) => p.mode === "cash" || Boolean(p.reference), {
    path: ["reference"],
    message: "is needed for a card, UPI or NEFT refund",
  })
  .refine((p) => p.mode !== "upi" || Boolean(p.upi_app), {
    path: ["upi_app"],
    message: "is needed for a UPI refund",
  });

export const pharmacySaleReturnSchema = z.strictObject({
  version,
  reason: z.string().trim().min(3, "must say why the medicines came back").max(300),
  lines: z
    .array(
      z.strictObject({
        line_id: uuid,
        qty_units: z.coerce.number().int().min(1, "must be at least 1").max(100000),
      }),
    )
    .min(1, "must have at least one medicine")
    .max(200),
  refund,
});

const money = z.coerce
  .number()
  .positive("must be more than 0")
  .max(10000000)
  .refine(twoDecimals, "can have at most 2 decimal places");

export const pharmacyCreditLabels = {
  amount: "Credit amount",
  approved_amount: "Approved credit",
  reason: "Reason",
  note: "Note",
  payments: "Payments",
};

export const pharmacyCreditRequestSchema = z.strictObject({
  version,
  amount: money,
  reason: z.string().trim().min(3, "must say why the patient cannot pay now").max(300),
});

export const pharmacyCreditDecisionSchema = z
  .strictObject({
    decision: z.enum(["approve", "reject"]),
    approved_amount: z.preprocess(blankToNull, money.nullish()),
    note: optionalText(300),
  })
  .refine((d) => d.decision === "approve" || Boolean(d.note), {
    path: ["note"],
    message: "must say why the credit is refused",
  });

export const pharmacyCreditListQuerySchema = z.object({
  status: z
    .enum(["pending", "approved", "rejected", "withdrawn", "used", "all"])
    .default("pending"),
  bill_id: z.string().uuid().optional(),
  patient_id: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyDuesQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyCollectDueSchema = z.strictObject({
  version,
  payments: z
    .array(payment)
    .min(1, "must have at least one payment")
    .max(PAYMENTS_AT_ONCE, `can have at most ${PAYMENTS_AT_ONCE} parts`),
});

const moneyIn = z.strictObject({
  mode: z.enum(PAYMENT_MODES),
  amount: money,
  reference: optionalText(60),
  upi_app: z.preprocess(blankToNull, z.enum(UPI_APPS).nullish()),
  reason: optionalText(300),
});

const needsReference = (p) => p.mode === "cash" || Boolean(p.reference);
const referenceRule = { path: ["reference"], message: "is needed for a card, UPI or NEFT payment" };
const needsUpiApp = (p) => p.mode !== "upi" || Boolean(p.upi_app);
const upiRule = { path: ["upi_app"], message: "is needed for a UPI payment" };
const reason = z.string().trim().min(3, "must say why").max(300);

export const pharmacyAccountLabels = {
  amount: "Amount",
  reason: "Reason",
  reference: "Reference",
  upi_app: "UPI app",
};

export const pharmacyDepositSchema = moneyIn
  .refine(needsReference, referenceRule)
  .refine(needsUpiApp, upiRule);

export const pharmacyDepositRefundSchema = moneyIn
  .extend({ reason })
  .refine(needsReference, referenceRule)
  .refine(needsUpiApp, upiRule);

export const pharmacyWriteOffSchema = z.strictObject({
  amount: z.preprocess(blankToNull, money.nullish()),
  reason,
});

export const pharmacyLedgerQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  sort: z.string().trim().max(30).optional(),
  dir: z.enum(["asc", "desc"]).default("desc"),
  only: z.enum(["all", "due", "balance"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date like 2026-11-18");

export const pharmacyRxQueueQuerySchema = z.object({
  date: isoDate.optional(),
  q: z.string().trim().max(80).optional(),
  category: z.enum(["ready", "coming", "done", "all"]).default("ready"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

const rxOutcome = z
  .strictObject({
    medication_id: id,
    outcome: z.enum([...RX_OUTCOMES, "pending"]),
    medicine_id: z.preprocess(blankToNull, id.nullish()),
    reason: z.preprocess(blankToNull, z.enum(Object.keys(RX_NOT_GIVEN_REASON_LABEL)).nullish()),
    note: z.preprocess(blankToNull, z.string().trim().max(300).nullish()),
  })
  .refine((o) => o.outcome !== "not_given" || Boolean(o.reason), {
    path: ["reason"],
    message: "is needed when a medicine is not given",
  })
  .refine((o) => o.reason !== "other" || Boolean(o.note), {
    path: ["note"],
    message: "need a written reason when the reason is Other",
  })
  .refine((o) => o.outcome !== "substitute" || Boolean(o.medicine_id), {
    path: ["medicine_id"],
    message: "is needed for a substitute",
  });

export const pharmacyRxOutcomesSchema = z.strictObject({
  bill_id: uuid,
  outcomes: z.array(rxOutcome).min(1, "needs at least one medicine").max(200),
});

export const pharmacyRxRequestSchema = z.strictObject({ medication_id: id });

export const pharmacyRxPatientQuerySchema = z.object({ date: isoDate.optional() });

export const pharmacyRxLabels = {
  ...pharmacyBillLabels,
  lines: "Medicines",
  outcomes: "Prescription lines",
  reason: "Reason",
  note: "Reason note",
  medicine_id: "Substitute",
  medication_id: "Prescribed medicine",
  date: "Date",
};
