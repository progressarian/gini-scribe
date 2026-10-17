import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const patientBill = await import("../../server/services/giniflow/patientBill.js");
const journey = await import("../../server/services/giniflow/journey.js");
const { isNurseRapidTest } = await import("../../shared/nurseTests.js");
const { LIVE_LAB_CASE_SQL } = await import("../../server/services/giniflow/testsHold.js");
const testCancel = await import("../../server/services/giniflow/testCancel.js");
const machineSync = await import("../../server/services/giniflow/machineSync.js");
const { transactionsToBilling } =
  await import("../../server/services/healthray/billingExtractor.js");

const db = getPool();
const tag = newTag();
let ids;
const cases = [];
let madeCatalogId = null;

const line = (desc, amount) => ({ desc, amount, category: "lab" });
const billOf = (...items) => ({ status: "billed", items });

const raiseFromBill = async (visitId, bill) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const raised = await journey.raiseOrdersFromSteps(
      client,
      visitId,
      [
        {
          catalogId: "blood_sample",
          billedIn: "healthray",
          billedTests: patientBill.billedLabLines(bill),
        },
      ],
      USERS.reception.id,
    );
    await client.query("COMMIT");
    return raised;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

const newCase = async (made, label) => {
  const caseNo = `G100-${label}-${tag}`;
  cases.push(caseNo);
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            appointment_id, test_names, case_date, case_status, raw_list_json)
     VALUES ($1, $1, $1, 985100, $2, $3, $4, $5::date, 'Registered', $6::jsonb)`,
    [
      caseNo,
      made.patient,
      made.appointment,
      ["Glucose Fasting"],
      ids.day,
      JSON.stringify({
        case_status: "Registered",
        registered_at: new Date(Date.now() - 3600_000).toISOString(),
        patient: { healthray_uid: null },
      }),
    ],
  );
  return caseNo;
};

const storeBill = (made, items) =>
  query(
    `INSERT INTO giniflow_patient_bills (patient_id, bill_date, status, items, read_at)
     VALUES ($1, $2::date, 'billed', $3::jsonb, NOW())
     ON CONFLICT (patient_id, bill_date) DO UPDATE
        SET status = 'billed', items = EXCLUDED.items, read_at = NOW()`,
    [made.patient, ids.day, JSON.stringify(items)],
  );

const caseIsLive = async (caseNo) =>
  (
    await query(`SELECT ${LIVE_LAB_CASE_SQL("lc")} AS live FROM lab_cases lc WHERE case_no = $1`, [
      caseNo,
    ])
  ).rows[0].live;

const autoCancelPreview = async (visitId, items) => {
  const before = process.env.SCRIBE_BILL_AUTO_CANCEL;
  process.env.SCRIBE_BILL_AUTO_CANCEL = "dry";
  const client = await db.connect();
  try {
    return await testCancel.cancelDeadBillTests(client, visitId, billOf(...items), []);
  } finally {
    client.release();
    if (before === undefined) delete process.env.SCRIBE_BILL_AUTO_CANCEL;
    else process.env.SCRIBE_BILL_AUTO_CANCEL = before;
  }
};

const syncTarget = (visitId) =>
  one(
    `SELECT v.id AS visit_id, v.patient_id, v.visit_date::text AS visit_date, v.current_status,
            NULL::text AS healthray_id, 'hr-' || v.patient_id AS hr_patient_id,
            FALSE AS refundable_open, FALSE AS tests_trimmed, p.name
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );

const sugarLines = async (visitId) =>
  (
    await query(
      `SELECT l.source, l.lab_order_id, b.status
         FROM bill_lines l JOIN bills b ON b.id = l.bill_id
        WHERE l.visit_id = $1 AND l.is_live AND l.service_item_id = $2`,
      [visitId, ids.sugarItem],
    )
  ).rows;

const orderedTests = async (visitId) =>
  (
    await query(
      `SELECT t.test_name FROM giniflow_lab_orders o
         JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1 ORDER BY t.test_name`,
      [visitId],
    )
  ).rows.map((r) => r.test_name);

test.describe.serial("G100 rapid blood sugar is a nurse test, not a lab sample", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    let catalog = await one(
      `SELECT id FROM giniflow_test_catalog WHERE lower(test_name) = 'blood sugar' AND is_active`,
    );
    if (!catalog) {
      catalog = await one(
        `INSERT INTO giniflow_test_catalog (test_name, price, category)
         VALUES ('Blood Sugar', 0, 'lab') RETURNING id`,
      );
      madeCatalogId = catalog.id;
    }
    const existing = await one(
      `SELECT id FROM service_items WHERE test_catalog_id = $1 AND is_active ORDER BY id LIMIT 1`,
      [catalog.id],
    );
    ids.sugarItem =
      existing?.id ??
      (
        await one(
          `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
           VALUES ($1, 'Blood Sugar', $2, 30, 'test', $3) RETURNING id`,
          [`G100-BS-${tag}`, ids.subgroup, catalog.id],
        )
      ).id;
  });

  test.afterAll(async () => {
    if (cases.length) await query(`DELETE FROM lab_cases WHERE case_no = ANY($1)`, [cases]);
    await tearDown(ids);
    if (madeCatalogId) {
      await query(`DELETE FROM giniflow_test_catalog WHERE id = $1`, [madeCatalogId]).catch(
        () => {},
      );
    }
  });

  test("1. only the exact Blood Sugar name is a nurse rapid test", () => {
    expect(isNurseRapidTest("Blood Sugar")).toBe(true);
    expect(isNurseRapidTest("  blood   SUGAR ")).toBe(true);
    for (const name of ["Glucose Fasting", "Glucose - Random Blood", "Blood Sugar Fasting", ""]) {
      expect(isNurseRapidTest(name)).toBe(false);
    }
  });

  test("2. billed lab lines leave out Blood Sugar and keep the lab glucose tests", () => {
    const bill = billOf(line("Blood Sugar", 30), line("Glucose Fasting", 50), {
      desc: "Consultation",
      amount: 800,
      category: "consultation",
    });
    expect(patientBill.billedLabLines(bill).map((l) => l.name)).toEqual(["Glucose Fasting"]);
    expect([...patientBill.billedStepIds(billOf(line("Blood Sugar", 30)), [])]).toEqual([]);
  });

  test("3. a bill with only Blood Sugar raises no lab order", async () => {
    const { visit } = await extraVisit(ids, "BSOnly");
    const raised = await raiseFromBill(visit, billOf(line("Blood Sugar", 30)));
    expect(raised.labOrderId).toBeNull();
    expect(await orderedTests(visit)).toEqual([]);
  });

  test("4. Blood Sugar with a lab test sends only the lab test to the lab", async () => {
    const { visit } = await extraVisit(ids, "BSMixed");
    const raised = await raiseFromBill(
      visit,
      billOf(line("Blood Sugar", 30), line("Glucose Fasting", 50)),
    );
    expect(raised.labOrderId).toBeTruthy();
    expect(await orderedTests(visit)).toEqual(["Glucose Fasting"]);
  });

  test("5. a HealthRay case is not on the bill when the bill has only Blood Sugar", async () => {
    const made = await extraVisit(ids, "BSCase");
    const caseNo = await newCase(made, "only");
    await storeBill(made, [line("Blood Sugar", 30)]);
    expect(await caseIsLive(caseNo)).toBe(false);
    await storeBill(made, [line("Blood Sugar", 30), line("Glucose Fasting", 50)]);
    expect(await caseIsLive(caseNo)).toBe(true);
  });

  test("6. auto-cancel ignores Blood Sugar when deciding whether lab cases go", async () => {
    const made = await extraVisit(ids, "BSAuto");
    await newCase(made, "auto");
    await storeBill(made, [line("Blood Sugar", 30), line("Glucose Fasting", 50)]);
    const refunded = (desc, amount) => ({ ...line(desc, amount), cancelled: true });

    const onlySugarRefunded = await autoCancelPreview(made.visit, [refunded("Blood Sugar", 30)]);
    expect(onlySugarRefunded.wouldCancel).toEqual([]);

    const labRefundedSugarKept = await autoCancelPreview(made.visit, [
      line("Blood Sugar", 30),
      refunded("Glucose Fasting", 50),
    ]);
    expect(labRefundedSugarKept.wouldCancel.map((w) => w.line)).toEqual(["Glucose Fasting"]);
  });

  test("7. the patient-flow check-in suggests no Blood Sample step for Blood Sugar", () => {
    const txn = (items) => [
      {
        appointment_id: "A1",
        invoice_no: "INV-1",
        billing_date: ids.day,
        billing_items: items.map(([name, price]) => ({ name, price, category_type: "PATHOLOGY" })),
      },
    ];
    expect(
      transactionsToBilling(txn([["Blood Sugar", 30]]), { appointmentId: "A1" }).steps,
    ).toEqual([]);
    const mixed = transactionsToBilling(
      txn([
        ["Blood Sugar", 30],
        ["Glucose Fasting", 50],
      ]),
      { appointmentId: "A1" },
    );
    expect(mixed.steps).toEqual([
      { step_catalog_id: "blood_sample", step_name: "Blood Sample", tests: ["Glucose Fasting"] },
    ]);
    expect(mixed.billing.items.map((i) => i.desc)).toEqual(["Blood Sugar", "Glucose Fasting"]);
  });

  test("8. the bill sync puts Blood Sugar on the Scribe bill once, with no lab order", async () => {
    const made = await extraVisit(ids, "BSBill");
    await storeBill(made, [
      { desc: "Consultation", amount: 800, category: "consultation" },
      line("Blood Sugar", 30),
    ]);
    const visit = await syncTarget(made.visit);
    await machineSync.syncMachineOrdersForVisit(visit, db);
    await machineSync.syncMachineOrdersForVisit(visit, db);
    const lines = await sugarLines(made.visit);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ source: "added", lab_order_id: null, status: "draft" });
    expect(await orderedTests(made.visit)).toEqual([]);
  });
});
