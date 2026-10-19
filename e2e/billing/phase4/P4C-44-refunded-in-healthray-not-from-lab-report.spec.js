import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, healthrayBill, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const labCaseLines = await import("../../../server/services/billing/labCaseLines.js");
const { counterPatients } = await import("../../../server/services/billing/counterPatients.js");

const db = getPool();
const tag = newTag();
let ids;
let labCaseBefore;
const patients = [];

async function labCase(patient, names) {
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            test_names, case_date, case_status, raw_list_json)
     VALUES ($1, $1, $1, $2, $3, $4, $5::date, 'Registered', '{}'::jsonb)`,
    [`P4C44-${patient}-${tag}`, 994400 + patients.length, patient, names, ids.day],
  );
}

const itemsOn = (visit) =>
  query(`SELECT service_item_id FROM bill_lines WHERE visit_id = $1 AND is_live`, [visit]).then(
    (r) => r.rows.map((row) => row.service_item_id).sort(),
  );

test.describe
  .serial("P4C-44 a test refunded in HealthRay is not billed from the lab report", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    labCaseBefore = (await one(`SELECT auto_add_lab_case_tests FROM billing_settings`))
      .auto_add_lab_case_tests;
    await query(`UPDATE billing_settings SET auto_add_lab_case_tests = TRUE`);
  });

  test.afterAll(async () => {
    await query(`UPDATE billing_settings SET auto_add_lab_case_tests = $1`, [labCaseBefore]);
    await query(`DELETE FROM lab_cases WHERE case_no LIKE $1`, [`P4C44-%-${tag}`]);
    await tearDown(ids);
  });

  test("1. the refunded test is left off; one refunded and billed again is still billed", async () => {
    const made = await extraVisit(ids, "Refund", { healthray: false });
    patients.push(made.patient);
    await labCase(made.patient, [ids.hba1cName, ids.abiName]);
    await healthrayBill(ids, made.patient, [
      { desc: ids.hba1cName, amount: 350, category: "lab", refunded: 350 },
      { desc: ids.hba1cName, amount: 350, category: "lab" },
      { desc: ids.abiName, amount: 400, category: "lab", refunded: 400 },
    ]);
    await bills.openDraft(made.visit, desk, db);

    const added = await labCaseLines.labCaseTestsForDesk(made.visit, desk, db);
    expect(added.added).toEqual([ids.hba1cName]);
    expect(await itemsOn(made.visit)).toEqual([ids.hba1c]);

    const draft = await one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft'`, [
      made.visit,
    ]);
    const offered = await labCaseLines.labCaseSuggestion(draft.id, desk, db);
    expect(offered.tests.map((t) => [t.item_id, t.refunded])).toEqual([[ids.abi, true]]);
    expect(offered.refunded_on_bill).toEqual([]);
  });

  test("2. a refunded test already on the bill from the lab report is flagged for removal", async () => {
    const made = await extraVisit(ids, "RefundOn", { healthray: false });
    patients.push(made.patient);
    await labCase(made.patient, [ids.abiName]);
    const draft = await bills.openDraft(made.visit, desk, db);
    await labCaseLines.addLabCaseTests(draft.id, { item_ids: [ids.abi] }, desk, db);
    await healthrayBill(ids, made.patient, [
      { desc: ids.abiName, amount: 400, category: "lab", refunded: 400 },
    ]);

    const offered = await labCaseLines.labCaseSuggestion(draft.id, desk, db);
    expect(offered.shown).toBe(true);
    expect(offered.refunded_on_bill.map((line) => line.bill_name)).toHaveLength(1);
  });

  test("3. lab-report tests refunded in HealthRay don't leave the patient under Pending bill", async () => {
    const made = await extraVisit(ids, "RefundList", { healthray: false });
    patients.push(made.patient);
    await labCase(made.patient, [ids.hba1cName, ids.abiName]);
    const hintsOf = async () =>
      Object.values(await counterPatients(ids.day, "", new Date(), db))
        .filter(Array.isArray)
        .flat()
        .find((row) => row.visitId === made.visit)?.hints;

    await healthrayBill(ids, made.patient, [
      { desc: ids.hba1cName, amount: 350, category: "lab" },
      { desc: ids.abiName, amount: 400, category: "lab", refunded: 400 },
    ]);
    expect((await hintsOf()).tests).toBe(1);

    await healthrayBill(ids, made.patient, [
      { desc: ids.hba1cName, amount: 350, category: "lab", refunded: 350 },
      { desc: ids.abiName, amount: 400, category: "lab", refunded: 400 },
    ]);
    expect((await hintsOf()).tests).toBe(0);
  });
});
