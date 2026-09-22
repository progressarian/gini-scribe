import { z } from "zod";
import {
  CATEGORY_RULE_MODES,
  CONSULTATION_VISIT_TYPES,
  GENDERS,
  ITEM_KINDS,
} from "../services/billing/importColumns.js";
import { STACKING_MODES } from "../services/billing/billingSettings.js";
import { cleanDate, INT_MAX, MONEY_MAX } from "../services/billing/common.js";
import { IMPORT_HISTORY_PAGE_MAX } from "../services/billing/importHistory.js";
import { MAX_BILL_CODES, MAX_BILL_LINES } from "../services/billing/priceBill.js";
import {
  BILLING_ROLES,
  DISCOUNT_KINDS,
  DISCOUNT_METHODS,
  PATIENT_PAYS,
  REMAINDERS,
  VISIT_TYPES,
} from "../../shared/billingVocab.js";

const MONEY_TEXT = /^\d+(\.\d{1,2})?$/;
const WHOLE_TEXT = /^\d+$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const twoDecimals = (n) => Number(n.toFixed(2)) === n;
const withinInt = (v) => Math.abs(Number(v)) <= INT_MAX;
const withinMoney = (v) => Number(v) <= MONEY_MAX;
const TOO_BIG = `is too large (at most ${INT_MAX})`;
const TOO_MUCH = `is too large (at most ${MONEY_MAX})`;

export const money = z.union([
  z
    .number()
    .nonnegative("must be 0 or more")
    .refine(twoDecimals, "can have at most 2 decimals (paise)")
    .refine(withinMoney, TOO_MUCH),
  z
    .string()
    .trim()
    .regex(MONEY_TEXT, { message: "must be an amount like 1200 or 1200.50", abort: true })
    .refine(withinMoney, TOO_MUCH),
]);

const percent = z.union([
  z.number().min(0).max(100).refine(twoDecimals, "can have at most 2 decimals"),
  z.string().trim().regex(MONEY_TEXT, "must be a percentage like 18 or 12.5"),
]);

const whole = z.union([
  z.number().int("must be a whole number").nonnegative("must be 0 or more").max(INT_MAX, TOO_BIG),
  z
    .string()
    .trim()
    .regex(WHOLE_TEXT, { message: "must be a whole number", abort: true })
    .refine(withinInt, TOO_BIG),
]);

const bigWhole = z.union([
  z.number().int("must be a whole number").nonnegative("must be 0 or more"),
  z.string().trim().regex(WHOLE_TEXT, "must be a whole number"),
]);

const id = z.union([
  z.number().int("must be a whole number").positive("must be 1 or more").max(INT_MAX, TOO_BIG),
  z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/, { message: "must be an id", abort: true })
    .refine(withinInt, TOO_BIG),
]);

const blank = z.literal("");
const code = z
  .string()
  .trim()
  .min(1, { message: "can't be blank", abort: true })
  .max(40)
  .regex(/^\S+$/, "can't contain spaces");
const name = z.string().trim().min(1, "can't be blank").max(200);
const text = (max) => z.string().max(max);
const date = z.string().trim().regex(DATE_TEXT, "must be a date like 2026-10-01");
const flag = z.boolean();

const atLeastOne = (schema) =>
  schema.refine((body) => Object.keys(body).length > 0, "send at least one field to change");

const groupFields = {
  code,
  name,
  sort_order: z.union([
    z.number().int().min(-INT_MAX, TOO_BIG).max(INT_MAX, TOO_BIG),
    blank,
    z
      .string()
      .trim()
      .regex(/^-?\d+$/, { message: "must be a whole number", abort: true })
      .refine(withinInt, TOO_BIG),
  ]),
};

export const billingGroupCreateSchema = z.strictObject({
  code,
  name,
  sort_order: groupFields.sort_order.optional(),
});
export const billingGroupUpdateSchema = atLeastOne(z.strictObject(groupFields).partial());

export const billingSubgroupCreateSchema = z.strictObject({
  group_id: id,
  code,
  name,
  sort_order: groupFields.sort_order.optional(),
});
export const billingSubgroupUpdateSchema = atLeastOne(
  z.strictObject({ ...groupFields, group_id: id }).partial(),
);

export const billingActiveSchema = z.strictObject({ is_active: flag });

const taxFields = {
  code,
  sac_hsn: z.union([
    z
      .string()
      .trim()
      .regex(/^(\d{4}|\d{6}|\d{8})?$/, "must be 4, 6 or 8 digits"),
    z.null(),
  ]),
  rate_pct: z.union([percent, blank]),
};
export const billingTaxCodeCreateSchema = z.strictObject({
  code,
  sac_hsn: taxFields.sac_hsn.optional(),
  rate_pct: taxFields.rate_pct.optional(),
});
export const billingTaxCodeUpdateSchema = atLeastOne(z.strictObject(taxFields).partial());

const itemFields = {
  code,
  name,
  subgroup_id: id,
  base_price: money,
  unit: z.string().trim().min(1).max(30),
  allow_quantity: flag,
  max_quantity: z.union([whole, z.null(), blank]),
  tax_code_id: z.union([id, z.null()]),
  price_includes_tax: flag,
  kind: z.enum(ITEM_KINDS),
  doctor_id: z.union([id, z.null()]),
  visit_type: z.union([z.enum(CONSULTATION_VISIT_TYPES), z.null()]),
  test_catalog_id: z.union([
    z.string().trim().regex(UUID_TEXT, "must be a catalogue test id"),
    z.null(),
  ]),
};
export const billingItemCreateSchema = z.strictObject({
  code: itemFields.code,
  name: itemFields.name,
  subgroup_id: itemFields.subgroup_id,
  base_price: itemFields.base_price,
  kind: itemFields.kind,
  unit: itemFields.unit.optional(),
  allow_quantity: itemFields.allow_quantity.optional(),
  max_quantity: itemFields.max_quantity.optional(),
  tax_code_id: itemFields.tax_code_id.optional(),
  price_includes_tax: itemFields.price_includes_tax.optional(),
  doctor_id: itemFields.doctor_id.optional(),
  visit_type: itemFields.visit_type.optional(),
  test_catalog_id: itemFields.test_catalog_id.optional(),
});
export const billingItemUpdateSchema = atLeastOne(
  z.strictObject({ ...itemFields, reason: text(500) }).partial(),
);

const categoryFields = {
  label: name,
  color: z.string().trim().max(30),
  parent_code: z.union([code, z.null(), blank]),
  payer_name: z.union([text(200), z.null()]),
  requires_ref: flag,
  requires_referral: flag,
  requires_referral_doc: flag,
  print_category_on_bill: flag,
  allow_pay_later: z.union([flag, z.null(), blank]),
  daily_cap: z.union([whole, z.null(), blank]),
  sort_order: groupFields.sort_order,
};
export const billingCategoryCreateSchema = z.strictObject({
  code,
  ...Object.fromEntries(
    Object.entries(categoryFields).map(([key, schema]) => [
      key,
      key === "label" ? schema : schema.optional(),
    ]),
  ),
});
export const billingCategoryUpdateSchema = atLeastOne(
  z.strictObject({ ...categoryFields, is_active: flag }).partial(),
);

const ruleFields = {
  scheme_code: code,
  name,
  min_age: z.union([whole, z.null(), blank]),
  max_age: z.union([whole, z.null(), blank]),
  gender: z.union([z.enum(GENDERS), z.null(), blank]),
  requires_card: flag,
  mode: z.enum(CATEGORY_RULE_MODES),
  priority: z.union([whole, blank]),
};
export const billingCategoryRuleCreateSchema = z.strictObject({
  scheme_code: ruleFields.scheme_code,
  name: ruleFields.name,
  min_age: ruleFields.min_age.optional(),
  max_age: ruleFields.max_age.optional(),
  gender: ruleFields.gender.optional(),
  requires_card: ruleFields.requires_card.optional(),
  mode: ruleFields.mode.optional(),
  priority: ruleFields.priority.optional(),
});
export const billingCategoryRuleUpdateSchema = atLeastOne(z.strictObject(ruleFields).partial());

export const billingCategoryRateSaveSchema = z.strictObject({
  scheme_code: code,
  service_item_id: id,
  valid_from: z.union([date, blank]).optional(),
  valid_to: z.union([date, z.null(), blank]).optional(),
  rate: z.union([money, z.null(), blank]).optional(),
  bill_name: z.union([text(200), z.null()]).optional(),
  bill_code: z
    .union([z.string().trim().max(40).regex(/^\S*$/, "can't contain spaces"), z.null()])
    .optional(),
});

export const billingSettingsUpdateSchema = atLeastOne(
  z
    .strictObject({
      discount_stacking: z.enum(STACKING_MODES),
      allow_pay_later: flag,
      max_codes_per_bill: z.union([whole, z.null(), blank]),
      gst_enabled: flag,
      gstin: z.union([z.string().trim().max(15), z.null()]),
      state_code: z.union([
        z
          .string()
          .trim()
          .regex(/^\d{2}$/, "must be 2 digits"),
        z.null(),
        blank,
      ]),
      legal_name: z.union([text(200), z.null()]),
      bill_footer: z.union([text(1000), z.null()]),
    })
    .partial(),
);

export const billingSeriesSaveSchema = z.strictObject({
  series: code,
  fy: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, "must look like 2026-27"),
  prefix: z.string().max(30).optional(),
  number_width: z.union([whole, blank]).optional(),
  next_no: z.union([bigWhole, blank]).optional(),
});

const trueFalse = z
  .enum(["true", "false"], { message: "must be true or false" })
  .transform((v) => v === "true");
const queryId = z
  .string()
  .trim()
  .regex(/^[1-9]\d*$/, "must be an id")
  .refine(withinInt, TOO_BIG);

export const billingItemListQuerySchema = z.strictObject({
  q: z.string().max(100).optional(),
  groupId: queryId.optional(),
  subgroupId: queryId.optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  doctorId: queryId.optional(),
  active: trueFalse.optional(),
  limit: z.string().regex(WHOLE_TEXT).optional(),
  offset: z.string().regex(WHOLE_TEXT).optional(),
});

export const billingListQuerySchema = z.strictObject({
  activeOnly: trueFalse.optional(),
  schemeCode: code.optional(),
});

export const billingCategoryRateDeleteQuerySchema = z.strictObject({
  reopen_previous: trueFalse.optional(),
});

export const billingRateGridQuerySchema = z.strictObject({
  date: date.optional(),
  groupId: queryId.optional(),
  subgroupId: queryId.optional(),
});

export const IMPORT_FILE_NAME_MAX = 200;

export const billingImportFileQuerySchema = z.strictObject({
  fileName: z
    .string({ error: "is required" })
    .trim()
    .min(1, { message: "can't be blank", abort: true })
    .max(IMPORT_FILE_NAME_MAX)
    .regex(/\.xlsx$/i, "must end in .xlsx — upload the Excel template"),
});

export const billingImportHistoryQuerySchema = z.strictObject({
  limit: z
    .string()
    .trim()
    .regex(WHOLE_TEXT, { message: "must be a whole number", abort: true })
    .refine(
      (v) => Number(v) >= 1 && Number(v) <= IMPORT_HISTORY_PAGE_MAX,
      `must be between 1 and ${IMPORT_HISTORY_PAGE_MAX}`,
    )
    .optional(),
  offset: z
    .string()
    .trim()
    .regex(WHOLE_TEXT, { message: "must be a whole number", abort: true })
    .refine(withinInt, TOO_BIG)
    .optional(),
});

const OLDEST_AGE = 150;

const pricedId = (what) =>
  z.union(
    [
      z
        .number()
        .int(`${what} must be an id`)
        .positive(`${what} must be an id`)
        .max(INT_MAX, TOO_BIG),
      z
        .string()
        .trim()
        .regex(/^[1-9]\d*$/, { message: `${what} must be an id`, abort: true })
        .refine(withinInt, TOO_BIG),
    ],
    {
      error: (issue) =>
        issue.input === undefined ? `${what} is required` : `${what} must be an id`,
    },
  );

const pricedQuantity = z.union([
  z
    .number()
    .int("quantity must be a whole number")
    .positive("quantity must be 1 or more")
    .max(INT_MAX, TOO_BIG),
  z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/, { message: "quantity must be a whole number of 1 or more", abort: true })
    .refine(withinInt, TOO_BIG),
]);

const pricedVisitType = z.enum(VISIT_TYPES, {
  message: `must be one of: ${VISIT_TYPES.join(", ")}`,
});

const objectOnly = (message) => ({
  error: (issue) => (issue.code === "invalid_type" ? message : undefined),
});

const realDate = (text) => {
  try {
    return cleanDate(text, "Date") === text;
  } catch {
    return false;
  }
};

const pricedLine = z.strictObject(
  {
    item_id: pricedId("item"),
    quantity: pricedQuantity.optional(),
    visit_type: z
      .enum(VISIT_TYPES, { message: `visit type must be one of: ${VISIT_TYPES.join(", ")}` })
      .optional(),
    doctor_id: pricedId("doctor").optional(),
  },
  objectOnly("must be an item, like { item_id: 12 }"),
);

const pricingFields = {
  category: z.string({ error: "must be a category code" }).pipe(code).optional(),
  date: date.refine(realDate, "must be a date like 2026-10-01").optional(),
  visit_type: pricedVisitType.optional(),
  doctor_id: id.optional(),
  lines: z
    .array(pricedLine, { error: "must be a list of items" })
    .min(1, "list is empty: choose at least one item")
    .max(MAX_BILL_LINES, `list can have at most ${MAX_BILL_LINES} items`),
  codes: z
    .array(z.string({ error: "must be a list of codes" }).pipe(code), {
      error: "must be a list of codes",
    })
    .max(MAX_BILL_CODES, `can be at most ${MAX_BILL_CODES}`)
    .optional(),
};

const WHOLE_BILL = objectOnly("Send the bill as an object");

export const billingPreviewSchema = z
  .strictObject(
    {
      patient_id: id.optional(),
      appointment_id: id.optional(),
      ...pricingFields,
    },
    WHOLE_BILL,
  )
  .refine((body) => body.patient_id !== undefined || body.appointment_id !== undefined, {
    message: "Choose the patient or the appointment to bill",
  });

const noRealPatient = z.undefined({
  error: "can't be sent: a rule test uses an age, gender and category, not a real patient",
});

export const billingRuleTestSchema = z.strictObject(
  {
    patient_id: noRealPatient,
    appointment_id: noRealPatient,
    age: z
      .number({ error: "must be a whole number" })
      .int("must be a whole number")
      .min(0, "must be 0 or more")
      .max(OLDEST_AGE, `must be at most ${OLDEST_AGE}`)
      .nullable()
      .optional(),
    gender: z.union([z.enum(GENDERS), z.null()]).optional(),
    role: z
      .enum(BILLING_ROLES, { message: `must be one of: ${BILLING_ROLES.join(", ")}` })
      .optional(),
    ...pricingFields,
  },
  WHOLE_BILL,
);

export const BILLING_PRICING_LABELS = {
  patient_id: "Patient",
  appointment_id: "Appointment",
  category: "Category",
  date: "Bill date",
  visit_type: "Visit type",
  doctor_id: "Consultant",
  lines: "Line",
  codes: "Discount codes",
  age: "Age",
  gender: "Gender",
  role: "Role",
};

const numberValue = z.union([
  z.number().refine(Number.isFinite, "must be a number"),
  z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/, "must be a number"),
  z.null(),
  blank,
]);
const optionalId = z.union([id, z.null(), blank]);
const fromDate = z.union([date.refine(realDate, "must be a date like 2026-10-01"), blank]);
const toDate = z.union([date.refine(realDate, "must be a date like 2026-10-01"), z.null(), blank]);
const visitTypes = z.union([
  z.array(z.enum(VISIT_TYPES, { message: `must be from: ${VISIT_TYPES.join(", ")}` })).max(3),
  z.null(),
]);
const remainder = z.union([z.enum(REMAINDERS), z.null(), blank]);
const priority = z.union([whole, blank]);

const paymentRuleFields = {
  scheme_code: code,
  name,
  group_id: optionalId,
  subgroup_id: optionalId,
  service_item_id: optionalId,
  visit_types: visitTypes,
  patient_pays: z.enum(PATIENT_PAYS),
  patient_value: numberValue,
  remainder,
  valid_from: fromDate,
  valid_to: toDate,
  priority,
};
export const billingPaymentRuleCreateSchema = z.strictObject({
  ...Object.fromEntries(
    Object.entries(paymentRuleFields).map(([key, schema]) => [
      key,
      ["scheme_code", "name", "patient_pays"].includes(key) ? schema : schema.optional(),
    ]),
  ),
});
export const billingPaymentRuleUpdateSchema = atLeastOne(
  z.strictObject(paymentRuleFields).partial(),
);

const idList = z.union([z.array(id).max(1000), z.null()]);
const limit = z.union([whole, z.null(), blank]);
const discountFields = {
  code: z.union([code, z.null(), blank]),
  name,
  method: z.enum(DISCOUNT_METHODS),
  kind: z.enum(DISCOUNT_KINDS),
  value: numberValue,
  max_discount: numberValue,
  group_ids: idList,
  subgroup_ids: idList,
  service_item_ids: idList,
  doctor_ids: idList,
  visit_types: visitTypes,
  scheme_codes: z.union([z.array(code).max(200), z.null()]),
  min_age: z.union([whole, z.null(), blank]),
  max_age: z.union([whole, z.null(), blank]),
  gender: z.union([z.enum(GENDERS), z.null(), blank]),
  valid_from: toDate,
  valid_to: toDate,
  max_uses_total: limit,
  max_uses_per_patient: limit,
  max_uses_per_day: limit,
  max_uses_per_doctor_per_day: limit,
  applies_per: z.enum(["line", "bill"]),
  priority,
  stackable: flag,
  applies_on_scheme_rate: flag,
  allowed_roles: z.union([
    z.array(z.enum(BILLING_ROLES, { message: `must be from: ${BILLING_ROLES.join(", ")}` })),
    z.null(),
  ]),
};
export const billingDiscountCreateSchema = z.strictObject({
  ...Object.fromEntries(
    Object.entries(discountFields).map(([key, schema]) => [
      key,
      ["name", "method", "kind", "value"].includes(key) ? schema : schema.optional(),
    ]),
  ),
});
export const billingDiscountUpdateSchema = atLeastOne(z.strictObject(discountFields).partial());

export const billingDiscountListQuerySchema = z.strictObject({
  activeOnly: trueFalse.optional(),
  method: z.enum(DISCOUNT_METHODS).optional(),
});

export const billingConsultantFeeGridQuerySchema = z.strictObject({
  doctorId: queryId.optional(),
  schemeCode: code.optional(),
  date: date.refine(realDate, "must be a date like 2026-10-01").optional(),
});

export const billingConsultantFeeSaveSchema = z.strictObject({
  scheme_code: code,
  service_item_id: id,
  fee: z.union([money, z.null(), blank]).optional(),
  bill_name: z.union([text(200), z.null()]).optional(),
  bill_code: z
    .union([z.string().trim().max(40).regex(/^\S*$/, "can't contain spaces"), z.null()])
    .optional(),
  patient_pays: z.enum(PATIENT_PAYS).optional(),
  patient_value: z.union([money, z.null(), blank]).optional(),
  remainder: remainder.optional(),
  valid_from: fromDate.optional(),
  valid_to: toDate.optional(),
});

export const billingConsultantFeeClearQuerySchema = z.strictObject({
  date: date.refine(realDate, "must be a date like 2026-10-01").optional(),
});

export const billingConsultantFeeCopySchema = z.strictObject({
  from_scheme_code: code,
  to_scheme_code: code,
  valid_from: fromDate.optional(),
  date: date.refine(realDate, "must be a date like 2026-10-01").optional(),
});

export const BILLING_FIELD_LABELS = {
  code: "Code",
  name: "Name",
  sort_order: "Order",
  group_id: "Group",
  subgroup_id: "Subgroup",
  is_active: "Active",
  sac_hsn: "SAC/HSN",
  rate_pct: "Rate %",
  base_price: "Price",
  unit: "Unit",
  allow_quantity: "Quantity can be more than 1",
  max_quantity: "Max quantity",
  tax_code_id: "Tax code",
  price_includes_tax: "Price includes tax",
  kind: "Kind",
  doctor_id: "Consultant",
  visit_type: "Visit type",
  test_catalog_id: "Catalogue test",
  reason: "Reason for the price change",
  label: "Label",
  color: "Colour",
  parent_code: "Parent category",
  payer_name: "Payer name",
  requires_ref: "Card number required",
  requires_referral: "Needs a referral",
  requires_referral_doc: "Needs the referral scanned",
  print_category_on_bill: "Print the category on the bill",
  allow_pay_later: "Pay later",
  daily_cap: "Patients per day",
  scheme_code: "Category",
  min_age: "From age",
  max_age: "To age",
  gender: "Gender",
  requires_card: "Has a card",
  mode: "How it applies",
  priority: "Priority",
  service_item_id: "Item",
  valid_from: "From",
  valid_to: "To",
  rate: "Rate",
  bill_name: "Bill name",
  bill_code: "Bill code",
  discount_stacking: "When several discounts apply",
  max_codes_per_bill: "Most codes on one bill",
  gst_enabled: "Charge GST on bills",
  gstin: "GSTIN",
  state_code: "State code",
  legal_name: "Legal name",
  bill_footer: "Bill footer",
  series: "Series",
  fy: "Financial year",
  prefix: "Prefix",
  number_width: "Digits",
  next_no: "Next number",
  q: "Search",
  date: "As of",
  fileName: "File name",
  limit: "Page size",
  offset: "Offset",
  activeOnly: "Active only",
  schemeCode: "Category",
  doctorId: "Doctor",
  patient_pays: "Patient pays",
  patient_value: "Value",
  remainder: "The rest goes to",
  visit_types: "Visit types",
  method: "Automatic or code",
  value: "Value",
  max_discount: "Largest discount",
  group_ids: "Groups",
  subgroup_ids: "Subgroups",
  service_item_ids: "Items",
  doctor_ids: "Doctors",
  scheme_codes: "Categories",
  max_uses_total: "Total uses",
  max_uses_per_patient: "Uses per patient",
  max_uses_per_day: "Uses per day",
  max_uses_per_doctor_per_day: "Uses per doctor per day",
  applies_per: "Applies per",
  stackable: "Stackable",
  applies_on_scheme_rate: "Also on payment-rule lines",
  allowed_roles: "Roles",
  fee: "Fee",
  from_scheme_code: "Copy from",
  to_scheme_code: "Copy to",
};

export const BILLING_SCHEMAS = {
  billingGroupCreateSchema,
  billingGroupUpdateSchema,
  billingSubgroupCreateSchema,
  billingSubgroupUpdateSchema,
  billingActiveSchema,
  billingTaxCodeCreateSchema,
  billingTaxCodeUpdateSchema,
  billingItemCreateSchema,
  billingItemUpdateSchema,
  billingCategoryCreateSchema,
  billingCategoryUpdateSchema,
  billingCategoryRuleCreateSchema,
  billingCategoryRuleUpdateSchema,
  billingCategoryRateSaveSchema,
  billingCategoryRateDeleteQuerySchema,
  billingSettingsUpdateSchema,
  billingSeriesSaveSchema,
  billingItemListQuerySchema,
  billingListQuerySchema,
  billingRateGridQuerySchema,
  billingImportFileQuerySchema,
  billingImportHistoryQuerySchema,
};
