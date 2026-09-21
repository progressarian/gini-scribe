export const README_TITLE = "Gini Scribe — billing data template";

export const README_INTRO =
  "Fill the sheets, then upload the file in Settings › Billing › Bulk import. Nothing is saved until every row passes the checks.";

export const GENERAL_RULES = [
  "One row = one thing: one group, one item, one category, one rule, one fee, one discount.",
  "Do not rename or delete sheets or header cells (column order does not matter). Orange headers are required; blue headers are optional. The 'if left blank' column below says what an empty cell means.",
  "Every test is its own item (HbA1c, Lipid Profile, ABI, VPT, 2D Echo…). There is no general 'lab test' item.",
  "There are no packages. Each ordered test is always billed on its own line at its own price.",
  "Dates are written YYYY-MM-DD, for example 2026-10-01.",
  "Amounts are plain numbers: write the digits only, without a ₹ sign or commas (1200, not 1,200).",
  "Codes are unique and have no spaces. Category codes use lower-case letters, digits and _ only. The category code general is reserved: it means patients with no category.",
  "A discount code may never be the same as a bill code.",
  "A payment rule's amount may not be higher than the price of any item it covers. Make a separate rule for cheaper items.",
  "Columns that take several values (visit_types, groups, doctors, categories, allowed_roles…) are comma-separated: New, Follow Up",
  "On the Consultant fees sheet, a blank visit_type means the fee is for both New and Follow Up visits of that doctor. Investigation visits have no consultation fee.",
  "The upload only adds and updates. To retire a row, set active to no; rows are never deleted by an upload.",
  "Uploading the same file twice changes nothing the second time. A blank start date (valid_from) is set to the upload day only when the row is first created; later uploads keep it.",
  "Any error stops the whole upload: fix the rows listed in the error file and upload again.",
];

export const VALUE_GLOSSARY = [
  ["patient_pays", "full", "The patient pays the whole price."],
  [
    "patient_pays",
    "amount",
    "The patient pays the rupees in patient_value, whatever the price. Never more than the price.",
  ],
  ["patient_pays", "percent", "The patient pays patient_value percent of the price."],
  ["patient_pays", "nothing", "The patient pays ₹0 (e.g. Pensioner, CGHS Referral)."],
  [
    "remainder",
    "claim",
    "The rest is claimed from the category's payer. The bill shows Pending in the CGHS register until the payer pays.",
  ],
  ["remainder", "adjustment", "The rest is written off by the hospital."],
  ["method", "auto", "The discount applies by itself when its conditions match."],
  ["method", "code", "The discount applies only when the desk types its code."],
  [
    "mode",
    "suggest",
    "The desk is shown the category as a one-tap suggestion when the patient matches.",
  ],
  [
    "mode",
    "auto",
    "The category is applied by itself when the patient matches and has no category saved.",
  ],
  ["kind (Items)", "consultation / test / procedure / medicine / other", "What the item is."],
  ["kind (Discounts)", "percent / flat / fixed_price", "% off, rupees off, or a set price."],
  [
    "visit_type",
    "New / Follow Up / Investigation",
    "The type of visit. Consultation fees exist only for New and Follow Up: an Investigation visit has no consultation fee.",
  ],
  ["gender", "Male / Female / Other", "As patients are recorded in Scribe."],
  [
    "yes / no columns",
    "yes / no",
    "An empty cell means what the 'if left blank' column says for that column.",
  ],
];

export const EXAMPLE_NOTICE =
  "Example only. Nothing here is saved or used by Scribe: the admin enters every real category, doctor, fee and code.";

export const CGHS_CATEGORY_EXAMPLE = {
  title: "Example only: how a category and its sub-categories are laid out (Categories sheet)",
  columns: [
    "category_code",
    "label",
    "parent_code",
    "payer_name",
    "requires_ref",
    "requires_referral",
    "requires_referral_doc",
    "print_on_bill",
    "allow_pay_later",
    "daily_cap",
    "active",
  ],
  rows: [
    ["[main code]", "[Main category]", "", "[payer name]", "yes", "no", "no", "yes", "", "", "yes"],
    [
      "[sub code 1]",
      "[Sub-category 1]",
      "[main code]",
      "",
      "yes",
      "no",
      "no",
      "yes",
      "",
      "",
      "yes",
    ],
    [
      "[sub code 2]",
      "[Sub-category 2]",
      "[main code]",
      "",
      "yes",
      "yes",
      "no",
      "yes",
      "",
      "",
      "yes",
    ],
    [
      "[sub code 3]",
      "[Sub-category 3]",
      "[main code]",
      "",
      "yes",
      "no",
      "no",
      "yes",
      "",
      "",
      "yes",
    ],
  ],
  note: "Each sub-category names the main category in parent_code and uses its payer name. For CGHS, the main row is CGHS and the sub-categories are CGHS Paid, CGHS Referral and Pensioner; a bill is always made under a sub-category. Example only: the admin enters the real codes and names.",
};

export const CONSULTANT_FEES_EXAMPLE = {
  title: "Example only: how doctors' fees are laid out (Consultant fees sheet)",
  columns: [
    "doctor",
    "visit_type",
    "category_code",
    "fee",
    "patient_pays",
    "patient_value",
    "remainder",
    "bill_name",
    "bill_code",
    "valid_from",
    "valid_to",
  ],
  rows: [
    ["[Doctor A]", "", "[sub code 3]", "[fee]", "nothing", "", "claim", "", "", "", ""],
    ["[Doctor B]", "", "[sub code 3]", "[fee]", "nothing", "", "claim", "", "[bill code]", "", ""],
    [
      "[Doctor B]",
      "New",
      "[sub code 1]",
      "[fee]",
      "amount",
      "[amount]",
      "claim",
      "",
      "[bill code]",
      "",
      "",
    ],
    [
      "[Doctor B]",
      "Follow Up",
      "[sub code 1]",
      "[fee]",
      "amount",
      "[amount]",
      "claim",
      "",
      "[bill code]",
      "",
      "",
    ],
  ],
  note: "Row 1: the patient pays nothing, gets the printout, and the whole fee stays Pending until the payer pays. Rows 3–4: the patient pays [amount] and the rest of the fee is claimed. Example only: every doctor, fee and code is entered by the admin.",
};

export const LATER_SHEET_NOTE =
  "Available after Phase 3: rows on this sheet are not imported yet. You can fill it in now; it is read once payment rules and discounts are switched on.";

const listed = (names) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];

export const laterSheetsRule = (names) =>
  `The ${listed(names)} ${names.length > 1 ? "sheets are" : "sheet is"} available after Phase 3. ${names.length > 1 ? "Their tabs are" : "Its tab is"} grey and rows on ${names.length > 1 ? "them" : "it"} are not imported yet; fill ${names.length > 1 ? "them" : "it"} in now if you like, and upload again once ${names.length > 1 ? "they are" : "it is"} switched on.`;
