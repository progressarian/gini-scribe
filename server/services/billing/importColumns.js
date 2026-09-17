export const YES_NO = ["yes", "no"];
export const ITEM_KINDS = ["consultation", "test", "procedure", "medicine", "other"];
export const DISCOUNT_KINDS = ["percent", "flat", "fixed_price"];
export const PATIENT_PAYS = ["full", "amount", "percent", "nothing"];
export const REMAINDERS = ["claim", "adjustment"];
export const DISCOUNT_METHODS = ["auto", "code"];
export const CATEGORY_RULE_MODES = ["suggest", "auto"];
export const VISIT_TYPES = ["New", "Follow Up", "Investigation"];
export const CONSULTATION_VISIT_TYPES = ["New", "Follow Up"];
export const GENDERS = ["Male", "Female", "Other"];
export const BILLING_ROLES = ["reception", "reception_admin", "admin"];
export const RESERVED_CATEGORY_CODES = ["general"];

export const TODAY_ON_CREATE = "today_on_create";

export const blank = (value, text) => ({ value, text });

const NONE = blank(null, "nothing (left empty)");
const NO_LIMIT = blank(null, "no limit");
const NO_END = blank(null, "no end date");
const ANY = blank(null, "any");
const ALL = blank(null, "all");
const ACTIVE = blank(true, "yes");
const NO = blank(false, "no");
const PRIORITY = blank(100, "100");
const START_TODAY = blank(
  TODAY_ON_CREATE,
  "the upload day when the row is first created; later uploads keep the start date it already has",
);

const exampleOf = (example) => (example === "" || example == null ? "(blank)" : example);

const column = (type, name, meaning, example, extra = {}) => {
  const def = { name, type, meaning, example: exampleOf(example), ...extra };
  if (def.required) delete def.blank;
  else if (!def.blank) def.blank = NONE;
  return def;
};
const text = (name, meaning, example, extra) => column("text", name, meaning, example, extra);
const number = (name, meaning, example, extra) => column("number", name, meaning, example, extra);
const date = (name, meaning, example, extra) => column("date", name, meaning, example, extra);
const list = (name, values, meaning, example, extra = {}) =>
  column("list", name, meaning, example, { values, ...extra });
const yesNo = (name, meaning, example, extra = {}) =>
  list(name, YES_NO, meaning, example, { blank: NO, ...extra, type: "boolean" });

const active = () =>
  yesNo("active", "yes = in use. no = retired (kept for old bills).", "yes", { blank: ACTIVE });

export const IMPORT_SHEETS = [
  {
    name: "Groups",
    key: ["group_code"],
    purpose: "Top-level revenue heads used in reports (OPD, Lab, Machine, ECHO, X-ray).",
    columns: [
      text("group_code", "Short unique code for the group. No spaces.", "LAB", {
        required: true,
      }),
      text("name", "Name shown on screens and reports.", "Lab", { required: true }),
      number("sort_order", "Order on screens; smaller numbers come first.", 20, {
        blank: blank(0, "0"),
      }),
      active(),
    ],
  },
  {
    name: "Subgroups",
    key: ["subgroup_code"],
    purpose: "The second level inside a group (e.g. Lab › Biochemistry).",
    columns: [
      text("subgroup_code", "Short unique code for the subgroup. No spaces.", "LAB_BIOCHEM", {
        required: true,
      }),
      text(
        "group_code",
        "The group it belongs to: a group_code from the Groups sheet or already in Scribe.",
        "LAB",
        { required: true },
      ),
      text("name", "Name shown on screens and reports.", "Biochemistry", { required: true }),
      number("sort_order", "Order inside the group; smaller numbers come first.", 10, {
        blank: blank(0, "0"),
      }),
      active(),
    ],
  },
  {
    name: "Items",
    key: ["item_code"],
    purpose:
      "Every billable thing with its General (normal) price: one row per consultation per doctor per visit type, one row per test.",
    columns: [
      text("item_code", "Unique code for this item. No spaces.", "LAB-HBA1C", { required: true }),
      text("name", "Name printed on the bill for General patients.", "HbA1c", {
        required: true,
      }),
      text(
        "subgroup_code",
        "The subgroup it belongs to: a subgroup_code from the Subgroups sheet or already in Scribe.",
        "LAB_BIOCHEM",
        { required: true },
      ),
      number("base_price", "General price in rupees. Plain number: no ₹ sign, no commas.", 500, {
        required: true,
      }),
      text("unit", "How it is counted.", "each", { blank: blank("each", "each") }),
      yesNo(
        "allow_quantity",
        "yes = the desk may bill more than 1 on one line (e.g. dressings).",
        "no",
      ),
      number("max_quantity", "Highest quantity allowed when allow_quantity is yes.", 5, {
        blank: NO_LIMIT,
      }),
      text("tax_code", "Leave blank. GST is switched off.", "", {
        blank: blank(null, "no tax (exempt)"),
      }),
      list(
        "kind",
        ITEM_KINDS,
        "consultation = a doctor's fee; test = a lab, machine, ECHO or X-ray test; procedure, medicine or other for anything else.",
        "test",
        { required: true },
      ),
      text(
        "doctor",
        "Consultation items only: the doctor's name exactly as in Scribe, or the doctor's id if two doctors share a name. Leave it blank on one consultation item per visit type to make the hospital's default fee, used for any doctor who has no fee of their own.",
        "[doctor name]",
        { blank: blank(null, "the hospital's default consultation fee (consultation items)") },
      ),
      list(
        "visit_type",
        CONSULTATION_VISIT_TYPES,
        "Consultation items only (required for them): which visit this fee is for — New or Follow Up. Investigation visits have no consultation fee.",
        "Follow Up",
        { blank: blank(null, "not a consultation item") },
      ),
      text(
        "test_name",
        "Test items only (required for them): the test's name exactly as in the test catalogue list you were given.",
        "HbA1c",
        { blank: blank(null, "not a test item") },
      ),
      active(),
    ],
  },
  {
    name: "Categories",
    key: ["category_code"],
    purpose:
      "Patient categories and sub-categories (CGHS › CGHS Paid, CGHS Referral, Pensioner). See the CGHS example below.",
    columns: [
      text(
        "category_code",
        "Unique code: 2–32 characters, lower-case letters, digits and _ only. The code general is reserved: it means patients with no category.",
        "pensioner",
        { required: true },
      ),
      text("label", "Name shown to the desk and on the bill.", "Pensioner", { required: true }),
      text(
        "parent_code",
        "For a sub-category, the parent's category_code. Only two levels: a sub-category can't have its own sub-categories.",
        "cghs",
        { blank: blank(null, "a main category") },
      ),
      text("payer_name", "Who the claimed amount is collected from.", "[CGHS payer name]", {
        blank: blank(null, "the parent category's payer (sub-categories)"),
      }),
      yesNo("requires_ref", "yes = the desk must enter the patient's card number.", "yes"),
      yesNo(
        "requires_referral",
        "yes = the desk must enter the referral / form number on the bill.",
        "yes",
      ),
      yesNo("requires_referral_doc", "yes = a scan of the referral form must be attached.", "no"),
      yesNo(
        "print_on_bill",
        "yes = the category name and card number (last 4 digits) are printed on the bill.",
        "yes",
      ),
      yesNo("allow_pay_later", "yes / no overrides the hospital's pay-later setting.", "", {
        blank: blank(null, "follow the hospital's pay-later setting"),
      }),
      number("daily_cap", "Most patients of this category per day.", "", { blank: NO_LIMIT }),
      active(),
    ],
  },
  {
    name: "Category rules",
    key: ["category_code", "rule_name"],
    purpose:
      "Who falls into a category automatically. A category saved on the patient's record always wins over these rules.",
    columns: [
      text("category_code", "The category the rule puts patients into.", "senior_citizen", {
        required: true,
      }),
      text("rule_name", "A name for the rule, unique inside its category.", "Age 60 and over", {
        required: true,
      }),
      number("min_age", "Youngest age that matches.", 60, {
        blank: blank(null, "no lower limit"),
      }),
      number("max_age", "Oldest age that matches.", "", { blank: blank(null, "no upper limit") }),
      list("gender", GENDERS, "Only this gender.", "", { blank: ANY }),
      yesNo("requires_card", "yes = only patients who have a card number saved.", "no"),
      list(
        "mode",
        CATEGORY_RULE_MODES,
        "suggest = the desk is shown a one-tap suggestion; auto = applied by itself.",
        "suggest",
        { required: true },
      ),
      number("priority", "When two rules match, the smaller number wins.", 100, {
        blank: PRIORITY,
      }),
      active(),
    ],
  },
  {
    name: "Category rates",
    key: ["category_code", "item_code", "valid_from"],
    purpose:
      "A category's own price, bill name or bill code for one item. For doctors' fees the Consultant fees sheet is easier.",
    columns: [
      text("category_code", "The category or sub-category.", "cghs", { required: true }),
      text("item_code", "The item from the Items sheet.", "LAB-HBA1C", { required: true }),
      date(
        "valid_from",
        "Date this rate starts. Using the same date again updates the same row.",
        "2026-10-01",
        { required: true },
      ),
      number(
        "rate",
        "Price for this category in rupees. Leave blank to keep the General price and only change the bill name or code.",
        180,
        { blank: blank(null, "the item's General price") },
      ),
      text("bill_name", "Name printed on the bill for this category.", "", {
        blank: blank(null, "the item's name"),
      }),
      text(
        "bill_code",
        "Code printed on the bill for this category. Must not be the same as any discount code.",
        "[bill code]",
        { blank: blank(null, "no code printed") },
      ),
      date("valid_to", "Last day of this rate.", "", { blank: NO_END }),
    ],
  },
  {
    name: "Payment rules",
    key: ["category_code", "rule_name"],
    purpose:
      "What a category's patient pays at the counter, for a whole group, a subgroup or one item. No rule = the patient pays in full.",
    columns: [
      text("category_code", "The category or sub-category the rule is for.", "cghs_paid", {
        required: true,
      }),
      text("rule_name", "A name for the rule, unique inside its category.", "Lab 20%", {
        required: true,
      }),
      text(
        "group_code",
        "Fill at most one of group_code, subgroup_code, item_code. All three blank = every item.",
        "LAB",
        { blank: blank(null, "see group_code") },
      ),
      text("subgroup_code", "See group_code.", "", { blank: blank(null, "see group_code") }),
      text("item_code", "See group_code. One item beats a subgroup, which beats a group.", "", {
        blank: blank(null, "see group_code"),
      }),
      text("visit_types", "Comma-separated visit types this rule is for.", "New, Follow Up", {
        blank: blank(null, "every visit type"),
      }),
      list(
        "patient_pays",
        PATIENT_PAYS,
        "What the patient pays. See the value list above.",
        "percent",
        { required: true },
      ),
      number(
        "patient_value",
        "Rupees for amount, percent for percent. Leave blank for full and nothing.",
        20,
        { blank: blank(null, "nothing (full and nothing need no value)") },
      ),
      list(
        "remainder",
        REMAINDERS,
        "Where the rest of the price goes. See the value list above.",
        "claim",
        { required: true },
      ),
      date("valid_from", "Date the rule starts.", "", { blank: START_TODAY }),
      date("valid_to", "Last day of the rule.", "", { blank: NO_END }),
      number("priority", "When two rules match at the same level, the smaller number wins.", "", {
        blank: PRIORITY,
      }),
      active(),
    ],
  },
  {
    name: "Consultant fees",
    key: ["doctor", "visit_type", "category_code"],
    purpose: "Each doctor's fee in each category and what the patient pays. See the example below.",
    columns: [
      text(
        "doctor",
        "The doctor's name exactly as in Scribe, or the doctor's id if two doctors share a name.",
        "[doctor name]",
        { required: true },
      ),
      list(
        "visit_type",
        CONSULTATION_VISIT_TYPES,
        "Which visit this fee is for — New or Follow Up. Investigation visits have no consultation fee.",
        "",
        { blank: blank(null, "both New and Follow Up for this doctor") },
      ),
      text("category_code", "The category or sub-category.", "pensioner", { required: true }),
      number("fee", "The doctor's fee in this category, in rupees.", "[fee]", { required: true }),
      list(
        "patient_pays",
        PATIENT_PAYS,
        "What the patient pays at the counter. See the value list above.",
        "nothing",
        { required: true },
      ),
      number(
        "patient_value",
        "Rupees for amount, percent for percent. Leave blank for full and nothing.",
        "",
        { blank: blank(null, "nothing (full and nothing need no value)") },
      ),
      list(
        "remainder",
        REMAINDERS,
        "Where the rest of the fee goes. See the value list above.",
        "claim",
        { required: true },
      ),
      text("bill_name", "Name printed on the bill.", "", {
        blank: blank(null, "the consultation item's name"),
      }),
      text("bill_code", "Code printed on the bill, e.g. for CGHS.", "[bill code]", {
        blank: blank(null, "no code printed"),
      }),
      date("valid_from", "Date this fee starts.", "", { blank: START_TODAY }),
      date("valid_to", "Last day of this fee.", "", { blank: NO_END }),
    ],
  },
  {
    name: "Discounts",
    key: ["rule_name"],
    purpose:
      "Coupon codes the desk types, and discounts that apply by themselves. Reception can never type a discount amount.",
    columns: [
      text("rule_name", "Unique name for the discount.", "[discount name]", {
        required: true,
      }),
      text(
        "code",
        "What the desk types. Required when method is code, blank when auto. Unique, no spaces, never the same as a bill code.",
        "BANSHALI20",
        { blank: blank(null, "no code (only for method auto)") },
      ),
      list("method", DISCOUNT_METHODS, "See the value list above.", "code", {
        required: true,
      }),
      list(
        "kind",
        DISCOUNT_KINDS,
        "percent = % off; flat = rupees off; fixed_price = the line costs this amount.",
        "percent",
        { required: true },
      ),
      number("value", "The percent, or the rupees, depending on kind.", 20, { required: true }),
      number("max_discount", "Largest discount in rupees for a percent discount.", 300, {
        blank: blank(null, "no cap"),
      }),
      text("groups", "Comma-separated group codes it applies to.", "OPD", { blank: ALL }),
      text("subgroups", "Comma-separated subgroup codes.", "", { blank: ALL }),
      text("items", "Comma-separated item codes.", "", { blank: ALL }),
      text(
        "doctors",
        "Comma-separated doctor names or ids. Makes it a coupon for these doctors only.",
        "[doctor name], [doctor name]",
        { blank: blank(null, "all doctors") },
      ),
      text("visit_types", "Comma-separated visit types.", "", { blank: ALL }),
      text(
        "categories",
        "Comma-separated category codes. general = patients with no category. A main category also covers its sub-categories.",
        "general",
        { blank: blank(null, "all categories") },
      ),
      number("min_age", "Youngest age that gets it.", "", {
        blank: blank(null, "no lower limit"),
      }),
      number("max_age", "Oldest age that gets it.", "", { blank: blank(null, "no upper limit") }),
      list("gender", GENDERS, "Only this gender.", "", { blank: ANY }),
      date("valid_from", "First day it can be used.", "2026-10-01", { blank: START_TODAY }),
      date("valid_to", "Last day it can be used.", "2026-12-31", { blank: NO_END }),
      number("max_uses_total", "Most uses ever.", "", { blank: NO_LIMIT }),
      number("max_uses_per_patient", "Most uses by one patient.", 1, { blank: NO_LIMIT }),
      number("max_uses_per_day", "Most uses in one day across all doctors (India time).", 10, {
        blank: NO_LIMIT,
      }),
      number("max_uses_per_doctor_per_day", "Most uses in one day for each doctor.", "", {
        blank: NO_LIMIT,
      }),
      number("priority", "When two discounts compete, the smaller number wins a tie.", "", {
        blank: PRIORITY,
      }),
      yesNo(
        "stackable",
        "yes = may be added on top of other stackable discounts (if the hospital setting allows).",
        "no",
      ),
      yesNo(
        "applies_on_scheme_rate",
        "yes = also applies to CGHS and other category patients, and reduces what they pay.",
        "no",
      ),
      text(
        "allowed_roles",
        "Comma-separated roles that may use the code: reception, reception_admin, admin.",
        "reception, reception_admin",
        { blank: blank(BILLING_ROLES, "all three roles") },
      ),
      active(),
    ],
  },
];

export const README_SHEET = "Read me";

export const TEMPLATE_SHEET_NAMES = [...IMPORT_SHEETS.map((sheet) => sheet.name), README_SHEET];

export function sheetByName(name) {
  return IMPORT_SHEETS.find((sheet) => sheet.name === name) ?? null;
}

export function blankValue(sheetName, columnName) {
  const found = sheetByName(sheetName)?.columns.find((c) => c.name === columnName);
  if (!found || found.required) return undefined;
  return found.blank.value;
}
