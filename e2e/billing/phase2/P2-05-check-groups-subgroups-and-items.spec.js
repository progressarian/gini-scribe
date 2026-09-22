import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { getPool } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { parseRow, sheetByName } from "../../../server/services/billing/importColumns.js";
import { templateBuffer } from "../../../server/services/billing/importTemplate.js";
import { parseUpload } from "../../../server/services/billing/importParse.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { checkMasterRows, validateUpload } =
  await import("../../../server/services/billing/importValidate.js");
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const REF = {
  groups: [
    { id: 1, code: "LAB", name: "Laboratory", is_active: true },
    { id: 2, code: "OPD", name: "OPD", is_active: true },
    { id: 3, code: "MACH", name: "Machine", is_active: true },
  ],
  subgroups: [
    { id: 11, code: "BIO", name: "Biochemistry", group_id: 1, is_active: true },
    { id: 12, code: "CONS", name: "Consultations", group_id: 2, is_active: true },
    { id: 13, code: "MROOM", name: "Machine room", group_id: 3, is_active: true },
    { id: 14, code: "OLDSUB", name: "Old", group_id: 1, is_active: false },
  ],
  items: [
    {
      id: 101,
      code: "LAB-A1C",
      name: "HbA1c",
      subgroup_id: 11,
      kind: "test",
      test_catalog_id: "t1",
      is_active: true,
    },
    {
      id: 102,
      code: "OPD-R-NEW",
      name: "Rahul New",
      subgroup_id: 12,
      kind: "consultation",
      doctor_id: 2,
      visit_type: "New",
      is_active: true,
    },
    {
      id: 103,
      code: "OPD-DEF-FU",
      name: "Default Follow Up",
      subgroup_id: 12,
      kind: "consultation",
      doctor_id: null,
      visit_type: "Follow Up",
      is_active: true,
    },
    {
      id: 104,
      code: "OLD-LIPID",
      name: "Old lipid",
      subgroup_id: 11,
      kind: "test",
      test_catalog_id: "t2",
      is_active: false,
    },
    {
      id: 105,
      code: "OPD-R-FU-OLD",
      name: "Rahul FU old",
      subgroup_id: 12,
      kind: "consultation",
      doctor_id: 2,
      visit_type: "Follow Up",
      is_active: false,
    },
  ],
  doctors: [
    { id: 1, name: "Dr Sharma", is_active: true },
    { id: 2, name: "Dr Rahul", is_active: true },
    { id: 3, name: "Dr Sharma", is_active: true },
    { id: 4, name: "Dr Gone", is_active: false },
    { id: 5, name: "Dr. Hospital Admin", is_active: true },
  ],
  tests: [
    { id: "t1", test_name: "HbA1c", category: "lab", is_active: true },
    { id: "t2", test_name: "Lipid Profile", category: "lab", is_active: true },
    { id: "t3", test_name: "ABI", category: "machine", is_active: true },
    { id: "t4", test_name: "Old Test", category: "lab", is_active: false },
    { id: "t5", test_name: "TSH", category: "lab", is_active: true },
  ],
  taxCodes: [
    { id: 1, code: "GST5", is_active: true },
    { id: 2, code: "GST0", is_active: false },
  ],
  machines: [],
};

const BASE = {
  Groups: { group_code: "G", name: "Group" },
  Subgroups: { subgroup_code: "S", group_code: "LAB", name: "Subgroup" },
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

function check(sheets) {
  return checkMasterRows(
    Object.entries(sheets).map(([name, rows]) => sheet(name, rows)),
    structuredClone(REF),
  );
}

const rowsOf = (sheets, name) => sheets.find((s) => s.name === name).rows;
const messages = (row) => row.errors.map((e) => `${e.column}: ${e.message}`);

test.describe("P2-05 check groups, subgroups and items", () => {
  test("1. codes are unique in the file, ignoring case", () => {
    const sheets = check({
      Groups: [
        { group_code: "NEW" },
        { group_code: "OTHER", name: "Other" },
        { group_code: "new", name: "Third" },
      ],
      Items: [
        { item_code: "X-1", name: "A" },
        { item_code: "x-1", name: "B" },
      ],
    });
    const [a, , c] = rowsOf(sheets, "Groups");
    expect(messages(a)).toEqual([
      "group_code: NEW is also on row 4; each group_code can appear only once",
    ]);
    expect(messages(c)).toEqual([
      "group_code: new is also on row 2; each group_code can appear only once",
    ]);
    expect(rowsOf(sheets, "Items").every((r) => r.errors[0]?.column === "item_code")).toBe(true);
  });

  test("2. a subgroup's group must exist, in the file or the database", () => {
    const sheets = check({
      Groups: [
        { group_code: "ECHO", name: "Echo" },
        { group_code: "BAD", name: "B" },
        { group_code: "bad", name: "C" },
      ],
      Subgroups: [
        { subgroup_code: "S1", group_code: "echo", name: "Echo room" },
        { subgroup_code: "S2", group_code: "LAB", name: "Haematology" },
        { subgroup_code: "S3", group_code: "NOPE", name: "Nope" },
        { subgroup_code: "S4", group_code: "BAD", name: "Bad" },
      ],
    });
    const [s1, s2, s3, s4] = rowsOf(sheets, "Subgroups");
    expect(s1.errors).toEqual([]);
    expect(s2.errors).toEqual([]);
    expect(messages(s3)).toEqual(["group_code: There is no group NOPE, in this file or in Scribe"]);
    expect(messages(s4)).toEqual([
      "group_code: The group BAD has errors on the Groups sheet (rows 3 and 4); fix those first",
    ]);
  });

  test("3. an item's subgroup must exist and be active; names are unique in their subgroup", () => {
    const sheets = check({
      Subgroups: [{ subgroup_code: "HAEM", group_code: "LAB", name: "Haematology" }],
      Items: [
        { item_code: "I1", subgroup_code: "haem", name: "CBC" },
        { item_code: "I2", subgroup_code: "NOSUB", name: "X" },
        { item_code: "I3", subgroup_code: "OLDSUB", name: "Y" },
        { item_code: "I4", subgroup_code: "BIO", name: "hba1c" },
        { item_code: "I5", subgroup_code: "OLDSUB", name: "Z", active: false },
      ],
    });
    const [i1, i2, i3, i4, i5] = rowsOf(sheets, "Items");
    expect(i1.errors).toEqual([]);
    expect(messages(i2)).toEqual([
      "subgroup_code: There is no subgroup NOSUB, in this file or in Scribe",
    ]);
    expect(messages(i3)).toEqual([
      "subgroup_code: The subgroup Old is deactivated; reactivate it first",
    ]);
    expect(messages(i4)).toEqual([
      'name: An item called "HbA1c" in Biochemistry already exists (LAB-A1C, Scribe)',
    ]);
    expect(
      messages(i5),
      "a new item can't be created in a deactivated subgroup, even inactive",
    ).toEqual(["subgroup_code: The subgroup Old is deactivated; reactivate it first"]);
  });

  test("4. a negative price and an unknown kind are errors", () => {
    const [row] = rowsOf(check({ Items: [{ base_price: -1, kind: "service" }] }), "Items");
    expect(row.errors.map((e) => e.column)).toEqual(["base_price", "kind"]);
  });

  test("5. doctors: by name or id; a shared name, an unknown, inactive or lab-only doctor is refused", () => {
    const consult = (doctor, code) => ({
      item_code: code,
      name: `Fee ${code}`,
      subgroup_code: "CONS",
      kind: "consultation",
      visit_type: "Follow Up",
      doctor,
    });
    const rows = rowsOf(
      check({
        Items: [
          consult("dr  rahul", "C1"),
          consult("Dr Sharma", "C2"),
          consult("3", "C3"),
          consult("Dr Nobody", "C4"),
          consult("Dr Gone", "C5"),
          consult("Dr. Hospital Admin", "C6"),
        ],
      }),
      "Items",
    );
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].resolved.doctor.id).toBe(2);
    expect(messages(rows[1])).toEqual([
      'doctor: 2 doctors are called "Dr Sharma"; write the doctor\'s id instead (1 or 3)',
    ]);
    expect(rows[2].errors).toEqual([]);
    expect(rows[2].resolved.doctor.id).toBe(3);
    expect(messages(rows[3])).toEqual(['doctor: There is no doctor called "Dr Nobody" in Scribe']);
    expect(messages(rows[4])).toEqual(["doctor: Dr Gone is not an active doctor"]);
    expect(messages(rows[5])).toEqual([
      "doctor: Dr. Hospital Admin is the lab-only provider; samples-only visits have no consultation fee",
    ]);
  });

  test("6. one active consultation item per doctor and visit type, and one hospital default per visit type", () => {
    const fee = (cells) => ({ subgroup_code: "CONS", kind: "consultation", ...cells });
    const rows = rowsOf(
      check({
        Items: [
          fee({ item_code: "N1", name: "Rahul New 2", doctor: "Dr Rahul", visit_type: "New" }),
          fee({
            item_code: "OPD-R-NEW",
            name: "Rahul New",
            doctor: "Dr Rahul",
            visit_type: "New",
            base_price: 950,
          }),
          fee({ item_code: "D1", name: "Default FU 2", visit_type: "Follow Up" }),
          fee({ item_code: "F1", name: "Rahul FU", doctor: "Dr Rahul", visit_type: "Follow Up" }),
          fee({ item_code: "S1", name: "Sharma New", doctor: "1", visit_type: "New" }),
          fee({
            item_code: "S2",
            name: "Sharma New 2",
            doctor: "1",
            visit_type: "New",
            active: false,
          }),
          fee({ item_code: "V0", name: "No visit" }),
        ],
      }),
      "Items",
    );
    expect(messages(rows[0])).toEqual([
      "doctor: There is already an active New consultation item for Dr Rahul: Rahul New (OPD-R-NEW, row 3)",
    ]);
    expect(messages(rows[1])).toEqual([
      "doctor: There is already an active New consultation item for Dr Rahul: Rahul New 2 (N1, row 2)",
    ]);
    expect(messages(rows[2])).toEqual([
      "visit_type: There is already an active Follow Up consultation item for the hospital default: Default Follow Up (OPD-DEF-FU, Scribe)",
    ]);
    expect(rows[3].errors, "the old Follow Up fee is inactive").toEqual([]);
    expect(rows[4].errors).toEqual([]);
    expect(rows[5].errors, "an inactive second fee is fine").toEqual([]);
    expect(messages(rows[6])).toEqual([
      "visit_type: A consultation item needs a visit_type (New or Follow Up)",
    ]);

    const update = rowsOf(
      check({
        Items: [
          fee({
            item_code: "opd-r-new",
            name: "Rahul New",
            doctor: "Dr Rahul",
            visit_type: "New",
            base_price: 1000,
          }),
        ],
      }),
      "Items",
    );
    expect(
      update[0].errors,
      "a row that updates the existing fee doesn't clash with itself",
    ).toEqual([]);
  });

  test("7. tests: must be in the test catalogue, active, and have only one item", () => {
    const t = (test_name, code, cells = {}) => ({
      item_code: code,
      name: `Item ${code}`,
      kind: "test",
      test_name,
      ...cells,
    });
    const rows = rowsOf(
      check({
        Items: [
          t("tsh", "T1"),
          t("TSH", "T2"),
          t("HbA1c", "T3"),
          t("Lipid Profile", "T4"),
          t("Vitamin Q", "T5"),
          t("Old Test", "T6"),
          t(null, "T7"),
          t("HbA1c", "LAB-A1C", { name: "HbA1c", base_price: 550 }),
        ],
      }),
      "Items",
    );
    expect(messages(rows[0])).toEqual(["test_name: TSH already has an item: Item T2 (T2, row 3)"]);
    expect(messages(rows[1])).toEqual(["test_name: TSH already has an item: Item T1 (T1, row 2)"]);
    expect(messages(rows[2])).toEqual([
      "test_name: HbA1c already has an item: HbA1c (LAB-A1C, row 9)",
    ]);
    expect(messages(rows[3]), "an inactive item still holds its test").toEqual([
      "test_name: Lipid Profile already has an item: Old lipid (OLD-LIPID, Scribe)",
    ]);
    expect(messages(rows[4])).toEqual([
      "test_name: This test isn't in the test catalogue yet — ask an admin to add it (Settings › Test catalogue), then upload again",
    ]);
    expect(messages(rows[5])).toEqual(["test_name: Old Test is retired in the test catalogue"]);
    expect(messages(rows[6])).toEqual([
      "test_name: A test item needs the test_name of a test in the test catalogue",
    ]);
  });

  test("8. a warning, not an error, when a test is filed under another group", () => {
    const rows = rowsOf(
      check({
        Items: [
          { item_code: "M1", name: "ABI", kind: "test", test_name: "ABI", subgroup_code: "BIO" },
          { item_code: "M2", name: "TSH", kind: "test", test_name: "TSH", subgroup_code: "BIO" },
          {
            item_code: "M3",
            name: "TSH in OPD",
            kind: "test",
            test_name: "TSH",
            subgroup_code: "CONS",
          },
        ],
      }),
      "Items",
    );
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].warnings).toEqual([
      {
        column: "subgroup_code",
        message:
          "ABI is a Machine test, but Biochemistry is in the Laboratory group; its revenue will count under Laboratory on the dashboards",
      },
    ]);
    expect(rows[1].warnings, "Lab fits Laboratory").toEqual([]);
    expect(rows[2].warnings).toEqual([]);
    expect(rows[2].errors[0].message).toContain("TSH already has an item");
  });

  test("9. the kind decides which of doctor, visit type, test and quantity may be filled", () => {
    const [row] = rowsOf(
      check({
        Items: [
          {
            kind: "procedure",
            doctor: "Dr Rahul",
            visit_type: "New",
            test_name: "TSH",
            max_quantity: 3,
          },
        ],
      }),
      "Items",
    );
    expect(messages(row)).toEqual([
      "doctor: Only consultation items have a doctor",
      "visit_type: Only consultation items have a visit_type",
      "test_name: Only test items are linked to the test catalogue",
      "max_quantity: max_quantity only applies when allow_quantity is yes",
    ]);
  });

  test("10. tax codes must exist and be active", () => {
    const rows = rowsOf(
      check({
        Items: [
          { item_code: "A", tax_code: "gst5" },
          { item_code: "B", name: "B", tax_code: "GST9" },
          { item_code: "C", name: "C", tax_code: "GST0" },
        ],
      }),
      "Items",
    );
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].resolved.taxCode.id).toBe(1);
    expect(messages(rows[1])).toEqual([
      "tax_code: There is no tax code GST9 in Scribe (Settings › Billing settings)",
    ]);
    expect(messages(rows[2])).toEqual(["tax_code: Tax code GST0 is deactivated"]);
  });

  test("11. deactivating a group or subgroup that keeps active children is refused", () => {
    const refused = check({
      Groups: [{ group_code: "LAB", name: "Laboratory", active: false }],
      Subgroups: [
        { subgroup_code: "CONS", group_code: "OPD", name: "Consultations", active: false },
      ],
    });
    expect(messages(rowsOf(refused, "Groups")[0])).toEqual([
      "active: Laboratory still has active subgroups: Biochemistry; set them to active = no on the Subgroups sheet too",
    ]);
    expect(messages(rowsOf(refused, "Subgroups")[0])).toEqual([
      "active: Consultations still has 2 active items: Rahul New, Default Follow Up; set them to active = no on the Items sheet too",
    ]);
    const allowed = check({
      Groups: [{ group_code: "MACH", name: "Machine", active: false }],
      Subgroups: [
        { subgroup_code: "MROOM", group_code: "MACH", name: "Machine room", active: false },
      ],
    });
    expect(rowsOf(allowed, "Groups")[0].errors).toEqual([]);
    expect(rowsOf(allowed, "Subgroups")[0].errors).toEqual([]);
  });

  test("12. group names are unique, and subgroup names unique within their group", () => {
    const sheets = check({
      Groups: [{ group_code: "LAB2", name: "laboratory" }],
      Subgroups: [
        { subgroup_code: "BIO2", group_code: "LAB", name: "Biochemistry" },
        { subgroup_code: "BIO3", group_code: "OPD", name: "Biochemistry" },
      ],
    });
    expect(messages(rowsOf(sheets, "Groups")[0])).toEqual([
      'name: A group called "Laboratory" already exists (LAB, Scribe)',
    ]);
    const [same, other] = rowsOf(sheets, "Subgroups");
    expect(messages(same)).toEqual([
      'name: A subgroup called "Biochemistry" in Laboratory already exists (BIO, Scribe)',
    ]);
    expect(other.errors).toEqual([]);
  });

  test("13. a real upload is checked against the test database", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await templateBuffer({ examples: false }));
    const items = workbook.getWorksheet("Items");
    const names = items.getRow(1).values.slice(1);
    const add = (cells) => items.addRow(names.map((n) => cells[n] ?? null));
    add({
      item_code: "P205-A",
      name: "P205 fee",
      subgroup_code: "P205_NONE",
      base_price: 1,
      kind: "consultation",
      doctor: "Dr E2E Rahul",
      visit_type: "Follow Up",
    });
    add({
      item_code: "P205-B",
      name: "P205 test",
      subgroup_code: "P205_NONE",
      base_price: 1,
      kind: "test",
      test_name: "P205 no such test",
    });
    const parsed = await parseUpload(Buffer.from(await workbook.xlsx.writeBuffer()));
    const result = await validateUpload(parsed, getPool());
    const [fee, lab] = result.sheets[0].rows;
    expect(fee.resolved.doctor).toMatchObject({ id: 9102, name: "Dr E2E Rahul" });
    expect(messages(fee)).toContain(
      "subgroup_code: There is no subgroup P205_NONE, in this file or in Scribe",
    );
    expect(messages(lab)).toContain(
      "test_name: This test isn't in the test catalogue yet — ask an admin to add it (Settings › Test catalogue), then upload again",
    );
  });

  test("14. review: a large file is checked in well under a second, not minutes", () => {
    const n = 5000;
    const ref = {
      ...structuredClone(REF),
      items: Array.from({ length: n }, (_, i) => ({
        id: i,
        code: `DB${i}`,
        name: `Db item ${i}`,
        subgroup_id: 11,
        kind: "test",
        test_catalog_id: `x${i}`,
        is_active: true,
      })),
      tests: Array.from({ length: 2 * n }, (_, i) => ({
        id: `x${i}`,
        test_name: `Test ${i}`,
        category: "lab",
        is_active: true,
      })),
    };
    const rows = Array.from({ length: n }, (_, i) => ({
      item_code: `F${i}`,
      name: `File item ${i}`,
      kind: "test",
      test_name: `Test ${n + i}`,
    }));
    const started = Date.now();
    const sheets = checkMasterRows([sheet("Items", rows)], ref);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(rowsOf(sheets, "Items").filter((r) => r.errors.length)).toEqual([]);
  });

  test("15. review: a one- or two-letter group code doesn't hide the wrong-group warning", () => {
    const ref = structuredClone(REF);
    ref.groups.push({ id: 9, code: "L", name: "Other income", is_active: true });
    ref.subgroups.push({ id: 19, code: "MISC", name: "Misc", group_id: 9, is_active: true });
    const [row] = rowsOf(
      checkMasterRows(
        [
          sheet("Items", [
            { item_code: "W1", name: "TSH", kind: "test", test_name: "TSH", subgroup_code: "MISC" },
          ]),
        ],
        ref,
      ),
      "Items",
    );
    expect(row.warnings.map((w) => w.message)).toEqual([
      "TSH is a Lab test, but Misc is in the Other income group; its revenue will count under Other income on the dashboards",
    ]);
  });

  test("16. review: a doctor name typed a little differently suggests the right one", () => {
    const fee = (doctor) => ({
      item_code: `D-${doctor.replace(/\W+/g, "")}`,
      name: `Fee ${doctor}`,
      subgroup_code: "CONS",
      kind: "consultation",
      visit_type: "Follow Up",
      doctor,
    });
    const rows = rowsOf(check({ Items: [fee("Dr. Rahul"), fee("rahul"), fee("Gone")] }), "Items");
    expect(messages(rows[0])).toEqual([
      'doctor: There is no doctor called "Dr. Rahul" in Scribe; did you mean "Dr Rahul"?',
    ]);
    expect(messages(rows[1])).toEqual([
      'doctor: There is no doctor called "rahul" in Scribe; did you mean "Dr Rahul"?',
    ]);
    expect(messages(rows[2]), "an inactive doctor is never suggested").toEqual([
      'doctor: There is no doctor called "Gone" in Scribe',
    ]);
    expect(rows[0].resolved.doctor, "a near match is never used silently").toBeUndefined();
  });
});
