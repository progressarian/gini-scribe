import { test, expect } from "@playwright/test";
import { getPool } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { parseRow, sheetByName } from "../../../server/services/billing/importColumns.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { checkMasterRows, loadReference } =
  await import("../../../server/services/billing/importValidate.js");

const REF = {
  groups: [{ id: 1, code: "LAB", name: "Laboratory", is_active: true }],
  subgroups: [{ id: 11, code: "BIO", name: "Biochemistry", group_id: 1, is_active: true }],
  items: [
    { id: 101, code: "LAB-A1C", name: "HbA1c", subgroup_id: 11, kind: "other", is_active: true },
    {
      id: 102,
      code: "LAB-OLD",
      name: "Old test",
      subgroup_id: 11,
      kind: "other",
      is_active: false,
    },
  ],
  doctors: [],
  tests: [],
  taxCodes: [],
  machines: [],
  categories: [
    {
      code: "cghs",
      label: "CGHS",
      parent_code: null,
      is_active: true,
      requires_ref: true,
      daily_cap: null,
    },
    {
      code: "cghs_paid",
      label: "CGHS Paid",
      parent_code: "cghs",
      is_active: true,
      requires_ref: false,
      daily_cap: null,
    },
    {
      code: "pensioner",
      label: "Pensioner",
      parent_code: "cghs",
      is_active: true,
      requires_ref: false,
      daily_cap: null,
    },
    {
      code: "echs",
      label: "ECHS",
      parent_code: null,
      is_active: true,
      requires_ref: false,
      daily_cap: 30,
    },
    {
      code: "senior",
      label: "Senior Citizen",
      parent_code: null,
      is_active: true,
      requires_ref: false,
      daily_cap: null,
    },
    {
      code: "old_cat",
      label: "Old category",
      parent_code: null,
      is_active: false,
      requires_ref: false,
      daily_cap: null,
    },
  ],
  rules: [
    { id: 1, scheme_code: "senior", name: "Age 60+" },
    { id: 2, scheme_code: "old_cat", name: "Old rule" },
  ],
  rates: [
    { scheme_code: "cghs", service_item_id: 101, valid_from: "2026-04-01", valid_to: null },
    { scheme_code: "echs", service_item_id: 101, valid_from: "2026-04-01", valid_to: "2026-09-30" },
  ],
};

const BASE = {
  Categories: { category_code: "new_cat", label: "New category" },
  "Category rules": { category_code: "senior", rule_name: "Rule", min_age: 60, mode: "suggest" },
  "Category rates": {
    category_code: "senior",
    item_code: "LAB-A1C",
    valid_from: "2027-01-01",
    rate: 400,
  },
  Items: { item_code: "I", name: "Item", subgroup_code: "BIO", base_price: 100, kind: "other" },
};

function sheet(name, rows) {
  return {
    name,
    later: false,
    notImported: 0,
    rows: rows.map((cells, i) => ({
      row: i + 2,
      input: {},
      ...parseRow(sheetByName(name), { ...BASE[name], ...cells }),
    })),
  };
}

function check(sheets, options = {}) {
  return checkMasterRows(
    Object.entries(sheets).map(([name, rows]) => sheet(name, rows)),
    structuredClone(REF),
    options,
  );
}

const rowsOf = (sheets, name) => sheets.find((s) => s.name === name).rows;
const messages = (row) => row.errors.map((e) => `${e.column}: ${e.message}`);
const admin = { canChangeDailyCap: true };

test.describe("P2-06 check categories, category rules and category rates", () => {
  test("1. a sub-category's parent must exist, in the file or the database", () => {
    const rows = rowsOf(
      check(
        {
          Categories: [
            { category_code: "ins", label: "Insurance" },
            { category_code: "ins_a", label: "Insurer A", parent_code: "INS" },
            { category_code: "cghs_ref", label: "CGHS Referral", parent_code: "cghs" },
            { category_code: "orphan", label: "Orphan", parent_code: "nope" },
          ],
        },
        admin,
      ),
      "Categories",
    );
    expect(rows.slice(0, 3).map((r) => r.errors)).toEqual([[], [], []]);
    expect(rows[1].values.parent_code, "codes are kept in lower case").toBe("ins");
    expect(messages(rows[3])).toEqual([
      "parent_code: There is no category nope, in this file or in Scribe",
    ]);
  });

  test("2. only two levels: nothing under a sub-category, and a category with sub-categories can't move under another", () => {
    const rows = rowsOf(
      check(
        {
          Categories: [
            { category_code: "deep", label: "Too deep", parent_code: "pensioner" },
            { category_code: "cghs", label: "CGHS", parent_code: "echs", requires_ref: true },
            { category_code: "self", label: "Self", parent_code: "self" },
          ],
        },
        admin,
      ),
      "Categories",
    );
    expect(messages(rows[0])).toEqual([
      "parent_code: Pensioner is already a sub-category, so nothing can go under it: only two levels are allowed",
    ]);
    expect(messages(rows[1])).toEqual([
      "parent_code: CGHS has sub-categories (CGHS Paid, Pensioner), so it can't go under another category: only two levels are allowed",
    ]);
    expect(messages(rows[2])).toEqual(["parent_code: A category can't be its own parent"]);
  });

  test("3. codes: the right shape, general is reserved, unique in the file ignoring case", () => {
    const rows = rowsOf(
      check(
        {
          Categories: [
            { category_code: "general", label: "General" },
            { category_code: "a", label: "Too short" },
            { category_code: "CGHS-X", label: "Dash" },
            { category_code: "Dup", label: "One" },
            { category_code: "dup", label: "Two" },
          ],
        },
        admin,
      ),
      "Categories",
    );
    expect(messages(rows[0])).toEqual([
      'category_code: "general" is reserved: it means patients with no category',
    ]);
    expect(messages(rows[1])).toEqual([
      "category_code: category_code must be 2–32 characters: a–z, 0–9 and _ only",
    ]);
    expect(messages(rows[2])).toEqual([
      "category_code: category_code must be 2–32 characters: a–z, 0–9 and _ only",
    ]);
    expect(messages(rows[3])).toEqual([
      "category_code: dup is also on row 6; each category_code can appear only once",
    ]);
  });

  test("4. labels are unique under the same parent; retiring needs the sub-categories retired too", () => {
    const sheets = check(
      {
        Categories: [
          { category_code: "cghs2", label: "cghs" },
          { category_code: "paid2", label: "CGHS Paid", parent_code: "cghs" },
          { category_code: "paid3", label: "CGHS Paid", parent_code: "echs" },
        ],
      },
      admin,
    );
    const [label, sub, elsewhere] = rowsOf(sheets, "Categories");
    expect(messages(label)).toEqual([
      'label: A category called "CGHS" already exists (cghs, Scribe)',
    ]);
    expect(messages(sub)).toEqual([
      'label: A sub-category called "CGHS Paid" under CGHS already exists (cghs_paid, Scribe)',
    ]);
    expect(elsewhere.errors).toEqual([]);

    const [retire] = rowsOf(
      check(
        {
          Categories: [{ category_code: "cghs", label: "CGHS", requires_ref: true, active: false }],
        },
        admin,
      ),
      "Categories",
    );
    expect(messages(retire)).toEqual([
      "active: CGHS still has active sub-categories: CGHS Paid, Pensioner; set them to active = no too",
    ]);
    const retiredTogether = check(
      {
        Categories: [
          { category_code: "cghs", label: "CGHS", requires_ref: true, active: false },
          { category_code: "cghs_paid", label: "CGHS Paid", parent_code: "cghs", active: false },
          { category_code: "pensioner", label: "Pensioner", parent_code: "cghs", active: false },
          { category_code: "cghs_new", label: "CGHS New", parent_code: "cghs" },
        ],
      },
      admin,
    );
    const together = rowsOf(retiredTogether, "Categories");
    expect(messages(together[0])).toEqual([
      "active: CGHS still has active sub-categories: CGHS New; set them to active = no too",
    ]);
    expect(together.slice(1, 3).map((r) => r.errors)).toEqual([[], []]);
    expect(messages(together[3])).toEqual(["parent_code: CGHS is retired; bring it back first"]);
  });

  test("5. only an admin may change the patients-per-day limit", () => {
    const rows = [
      { category_code: "echs", label: "ECHS", daily_cap: 30 },
      { category_code: "echs2", label: "ECHS Two" },
      { category_code: "echs3", label: "ECHS Three", daily_cap: 5 },
    ];
    const asReception = rowsOf(
      check({
        Categories: [...rows, { category_code: "senior", label: "Senior Citizen", daily_cap: 10 }],
      }),
      "Categories",
    );
    expect(asReception[0].errors, "the same limit is not a change").toEqual([]);
    expect(asReception[1].errors).toEqual([]);
    expect(messages(asReception[2])).toEqual([
      "daily_cap: Only an admin can change a category's patients-per-day limit (it is no limit now)",
    ]);
    expect(messages(asReception[3])).toEqual([
      "daily_cap: Only an admin can change a category's patients-per-day limit (it is no limit now)",
    ]);
    const blanked = rowsOf(
      check({ Categories: [{ category_code: "echs", label: "ECHS" }] }),
      "Categories",
    );
    expect(messages(blanked[0]), "a blank cell means no limit, which is a change").toEqual([
      "daily_cap: Only an admin can change a category's patients-per-day limit (it is 30 now)",
    ]);
    expect(rowsOf(check({ Categories: rows }, admin), "Categories").map((r) => r.errors)).toEqual([
      [],
      [],
      [],
    ]);
  });

  test("6. rules: a valid age range, at least one condition, a live category without sub-categories", () => {
    const rows = rowsOf(
      check({
        "Category rules": [
          { rule_name: "Backwards", min_age: 70, max_age: 60 },
          { rule_name: "Ancient", min_age: 151 },
          { rule_name: "Everyone", min_age: null },
          { rule_name: "On parent", category_code: "cghs", requires_card: true },
          { rule_name: "Retired", category_code: "old_cat" },
          { rule_name: "Old rule", category_code: "old_cat", active: false },
          { rule_name: "Nowhere", category_code: "nope" },
          { rule_name: "Age 60+", category_code: "SENIOR", min_age: 65 },
        ],
      }),
      "Category rules",
    );
    expect(messages(rows[0])).toEqual(["max_age: min_age can't be more than max_age"]);
    expect(messages(rows[1])).toEqual(["min_age: min_age must be 150 or less"]);
    expect(messages(rows[2])).toEqual([
      "rule_name: A rule needs at least one condition (an age, a gender or a card), or it would match every patient",
    ]);
    expect(messages(rows[3])).toEqual([
      "category_code: CGHS has sub-categories, so it can't be billed on its own: put the rule on one of its sub-categories",
    ]);
    expect(messages(rows[4])).toEqual([
      "category_code: Old category is retired; bring it back first",
    ]);
    expect(rows[5].errors, "an existing rule on a retired category can be set inactive").toEqual(
      [],
    );
    expect(messages(rows[6])).toEqual([
      "category_code: There is no category nope, in this file or in Scribe",
    ]);
    expect(rows[7].errors, "an existing rule is updated, matched ignoring case").toEqual([]);
  });

  test("7. rules: a rule name appears once per category; an automatic rule on a card category needs a card", () => {
    const rows = rowsOf(
      check({
        "Category rules": [
          { rule_name: "Same", category_code: "senior" },
          { rule_name: "same", category_code: "Senior" },
          { rule_name: "Same", category_code: "echs" },
          { rule_name: "Auto", category_code: "pensioner", mode: "auto" },
          { rule_name: "Auto card", category_code: "pensioner", mode: "auto", requires_card: true },
          { rule_name: "Suggest", category_code: "pensioner", mode: "suggest" },
        ],
      }),
      "Category rules",
    );
    expect(messages(rows[0])).toEqual([
      "category_code: senior + Same is also on row 3; each category_code + rule_name can appear only once",
    ]);
    expect(rows[2].errors).toEqual([]);
    expect(messages(rows[3])).toEqual([
      "requires_card: CGHS › Pensioner needs a card number, so an automatic rule for it must also require a card: set requires_card to yes, or make the rule mode suggest",
    ]);
    expect(rows[4].errors).toEqual([]);
    expect(rows[5].errors).toEqual([]);
  });

  test("8. rates: an unknown or deactivated item, a negative rate, and a row that changes nothing", () => {
    const sheets = check({
      Items: [{ item_code: "NEW-ITEM", name: "New item" }],
      "Category rates": [
        { item_code: "NOPE" },
        { item_code: "lab-old" },
        { item_code: "new-item" },
        { rate: -5, valid_from: "2027-02-01", valid_to: "2027-02-10" },
        { rate: null, valid_from: "2027-03-01", valid_to: "2027-03-10" },
        { rate: null, bill_code: "CC02", valid_from: "2027-04-01", valid_to: "2027-04-30" },
        { category_code: "old_cat" },
      ],
    });
    const rows = rowsOf(sheets, "Category rates");
    expect(messages(rows[0])).toEqual([
      "item_code: There is no item NOPE, in this file or in Scribe",
    ]);
    expect(messages(rows[1])).toEqual(["item_code: Old test is deactivated"]);
    expect(rows[2].errors, "an item added in the same file").toEqual([]);
    expect(rows[3].errors.map((e) => e.column)).toContain("rate");
    expect(messages(rows[4])).toEqual([
      "rate: Give a rate, a bill_name or a bill_code — a rate row must change something",
    ]);
    expect(rows[5].errors).toEqual([]);
    expect(messages(rows[6])).toEqual([
      "category_code: Old category is retired; bring it back first",
    ]);
  });

  test("9. rates: dates must be in order and must not overlap, in the file or in Scribe", () => {
    const rows = rowsOf(
      check({
        "Category rates": [
          { valid_from: "2027-05-01", valid_to: "2027-04-01" },
          { category_code: "echs", valid_from: "2026-09-01", valid_to: "2026-09-15" },
          { category_code: "senior", valid_from: "2027-06-01", valid_to: "2027-06-30" },
          { category_code: "senior", valid_from: "2027-06-15" },
          { category_code: "echs", valid_from: "2026-10-01" },
        ],
      }),
      "Category rates",
    );
    expect(messages(rows[0])).toEqual(["valid_to: valid_to can't be before valid_from"]);
    expect(messages(rows[1])).toEqual([
      "valid_from: These dates overlap another rate for ECHS / HbA1c: 2026-04-01 to 2026-09-30 (Scribe); change the dates or end that rate first",
    ]);
    expect(messages(rows[2])).toEqual([
      "valid_from: These dates overlap another rate for Senior Citizen / HbA1c: 2027-06-15 to open-ended (row 5); change the dates or end that rate first",
    ]);
    expect(messages(rows[3])).toEqual([
      "valid_from: These dates overlap another rate for Senior Citizen / HbA1c: 2027-06-01 to 2027-06-30 (row 4); change the dates or end that rate first",
    ]);
    expect(rows[4].errors, "starts the day after the ECHS rate ends").toEqual([]);
  });

  test("10. rates: a new open-ended rate ends Scribe's current one the day before, with a warning", () => {
    const rows = rowsOf(
      check({
        "Category rates": [{ category_code: "cghs", valid_from: "2027-04-01", rate: 450 }],
      }),
      "Category rates",
    );
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].warnings).toEqual([
      {
        column: "valid_from",
        message: "The rate from 2026-04-01 in Scribe will end on 2027-03-31",
      },
    ]);
  });

  test("11. the same category, item and start date twice in the file is refused", () => {
    const rows = rowsOf(
      check({
        "Category rates": [{ rate: 1 }, { category_code: "SENIOR", item_code: "lab-a1c", rate: 2 }],
      }),
      "Category rates",
    );
    expect(messages(rows[0])).toEqual([
      "category_code: senior + LAB-A1C + 2027-01-01 is also on row 3; each category_code + item_code + valid_from can appear only once",
    ]);
  });

  test("12. the reference data loads categories, rules and rates from the test database", async () => {
    const ref = await loadReference(getPool());
    expect(ref.categories.map((c) => c.code)).toEqual(expect.arrayContaining(["cghs", "echs"]));
    expect(Array.isArray(ref.rules)).toBe(true);
    expect(Array.isArray(ref.rates)).toBe(true);
  });

  test("13. two open-ended rates for one item in the file say exactly which valid_to to add", () => {
    const rows = rowsOf(
      check({
        "Category rates": [
          { category_code: "cghs", valid_from: "2026-04-01", rate: 420 },
          { category_code: "cghs", valid_from: "2027-04-01", rate: 450 },
        ],
      }),
      "Category rates",
    );
    const fix = "give the rate from 2026-04-01 a valid_to of 2027-03-31";
    expect(messages(rows[0])).toEqual([
      `valid_from: These dates overlap another rate for CGHS / HbA1c: 2027-04-01 to open-ended (row 3); ${fix}`,
    ]);
    expect(messages(rows[1])).toEqual([
      `valid_from: These dates overlap another rate for CGHS / HbA1c: 2026-04-01 to open-ended (row 2); ${fix}`,
    ]);
    const fixed = rowsOf(
      check({
        "Category rates": [
          { category_code: "cghs", valid_from: "2026-04-01", valid_to: "2027-03-31", rate: 420 },
          { category_code: "cghs", valid_from: "2027-04-01", rate: 450 },
        ],
      }),
      "Category rates",
    );
    expect(fixed.map((r) => r.errors)).toEqual([[], []]);
  });

  test("14. review: rules and rates on a category row the file gets wrong point back to that row", () => {
    const sheets = check(
      {
        Categories: [
          { category_code: "general", label: "General" },
          { category_code: "cg-hs", label: "CGHS dash" },
        ],
        "Category rules": [
          { category_code: "general", rule_name: "All" },
          { category_code: "cg-hs", rule_name: "Dash" },
        ],
        "Category rates": [{ category_code: "general" }],
      },
      admin,
    );
    expect(messages(rowsOf(sheets, "Category rules")[0])).toEqual([
      "category_code: The category general has errors on the Categories sheet (row 2); fix those first",
    ]);
    expect(messages(rowsOf(sheets, "Category rules")[1])).toEqual([
      "category_code: The category cg-hs has errors on the Categories sheet (row 3); fix those first",
    ]);
    expect(messages(rowsOf(sheets, "Category rates")[0])).toEqual([
      "category_code: The category general has errors on the Categories sheet (row 2); fix those first",
    ]);
  });

  test("15. review: a first sub-category under a category with rules warns that those rules stop applying", () => {
    const withRules = { ...structuredClone(REF) };
    withRules.rules = [
      { id: 1, scheme_code: "senior", name: "Age 60+", is_active: true },
      { id: 2, scheme_code: "senior", name: "Old rule", is_active: false },
    ];
    const run = (sheets) =>
      checkMasterRows(
        Object.entries(sheets).map(([name, rows]) => sheet(name, rows)),
        structuredClone(withRules),
        admin,
      );
    const leftBehind = rowsOf(
      run({
        Categories: [
          { category_code: "senior_70", label: "Over 70", parent_code: "senior" },
          { category_code: "senior_60", label: "60 to 69", parent_code: "senior" },
        ],
      }),
      "Categories",
    );
    expect(leftBehind.map((r) => r.errors)).toEqual([[], []]);
    expect(leftBehind[0].warnings).toEqual([
      {
        column: "parent_code",
        message:
          "Senior Citizen has rules (Age 60+) that stop applying once it has sub-categories; add them for its sub-categories on the Category rules sheet, and set the old ones to active = no there",
      },
    ]);
    expect(leftBehind[1].warnings, "warned once per category").toEqual([]);

    const moved = run({
      Categories: [{ category_code: "senior_70", label: "Over 70", parent_code: "senior" }],
      "Category rules": [
        { category_code: "senior", rule_name: "Age 60+", active: false },
        { category_code: "senior_70", rule_name: "Age 70+", min_age: 70 },
      ],
    });
    expect(rowsOf(moved, "Categories")[0].warnings).toEqual([]);
    expect(
      rowsOf(moved, "Category rules").map((r) => r.errors),
      "retiring the parent's rule is allowed once it has sub-categories",
    ).toEqual([[], []]);

    const existingChildren = rowsOf(
      check(
        {
          Categories: [{ category_code: "cghs_ref", label: "CGHS Referral", parent_code: "cghs" }],
        },
        admin,
      ),
      "Categories",
    );
    expect(existingChildren[0].warnings, "CGHS already had sub-categories").toEqual([]);
  });

  test("16. a new rule or sub-category is refused on a retired category even when it is inactive", () => {
    const sub = check(
      {
        Categories: [
          { category_code: "old_sub", label: "Old sub", parent_code: "old_cat", active: false },
        ],
      },
      admin,
    );
    expect(messages(rowsOf(sub, "Categories")[0])).toEqual([
      "parent_code: Old category is retired; bring it back first",
    ]);
    const rule = check({
      "Category rules": [{ rule_name: "New but off", category_code: "old_cat", active: false }],
    });
    expect(messages(rowsOf(rule, "Category rules")[0])).toEqual([
      "category_code: Old category is retired; bring it back first",
    ]);
  });
});
