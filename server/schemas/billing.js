import { z } from "zod";
import {
  CATEGORY_RULE_MODES,
  CONSULTATION_VISIT_TYPES,
  GENDERS,
  ITEM_KINDS,
} from "../services/billing/importColumns.js";
import { STACKING_MODES } from "../services/billing/billingSettings.js";
import { INT_MAX, MONEY_MAX } from "../services/billing/common.js";
import { IMPORT_HISTORY_PAGE_MAX } from "../services/billing/importHistory.js";

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
