import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  discountCode,
  extraVisit,
  labOrder,
  newTag,
  setUp,
  tearDown,
} from "../phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const creditNotes = await import("../../../server/services/billing/creditNotes.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const billPdf = await import("../../../server/services/billing/billPdf.js");
const requests = await import("../../../server/services/billing/billingRequests.js");

const db = getPool();
const tag = newTag();
const PRICES = { ABI: 500, VPT: 300, Fundus: 500 };
let ids;
let autoBefore;
const part = {};
const pkg = {};

const newItem = async (code, name, price, kind, test) =>
  (
    await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
       VALUES ($1, $2, $3, $4, $5,
               (SELECT c.id FROM giniflow_test_catalog c WHERE c.test_name = $6 LIMIT 1))
       RETURNING id`,
      [code, name, ids.subgroup, price, kind, test],
    )
  ).id;

const parts = (packageId, members) =>
  query(
    `INSERT INTO service_item_package_parts (package_item_id, part_item_id)
     SELECT $1, unnest($2::int[])`,
    [packageId, members],
  );

const machineVisit = async (label, machines) => {
  const visit = await extraVisit(ids, label, { visitType: "Follow Up", healthray: false });
  let billId = null;
  for (const name of machines) {
    const order = await labOrder({ ...ids, visit: visit.visit }, [name], "machine");
    await query(`UPDATE giniflow_lab_orders SET amount_total = $2 WHERE id = $1`, [
      order,
      PRICES[name],
    ]);
    await query(`UPDATE giniflow_lab_order_tests SET price = $2 WHERE lab_order_id = $1`, [
      order,
      PRICES[name],
    ]);
    const raised = await visitLines.linesForOrder(
      visit.visit,
      { labOrderId: order, testNames: [name] },
      desk,
      db,
    );
    expect(raised.added).toEqual([name]);
    billId = raised.bill_id;
  }
  return { ...visit, billId };
};

const machineLines = (bill) =>
  bill.lines.filter((line) => Object.values(part).includes(line.service_item_id));

const payAndFinalise = async (billId) => {
  const draft = await bills.readBill(billId, db);
  const paid = await payments.takePayments(
    draft.id,
    { version: draft.version, mode: "cash", amount: draft.totals.payable / 100 },
    desk,
    db,
  );
  const ready = await bills.readBill(billId, db);
  const final =
    ready.status === "final"
      ? ready
      : await bills.finaliseBill(billId, { version: ready.version }, desk, db);
  return { paid, final };
};

const lineOfItem = (bill, itemId) => bill.lines.find((line) => line.service_item_id === itemId);

const refundFor = async (bill, machines) =>
  creditNotes.previewCredit(
    bill.id,
    {
      lines: machines.map((name) => ({ line_id: lineOfItem(bill, part[name]).id })),
    },
    db,
  );

test.describe.serial("P5-17 a machine package is one bill line", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    for (const name of Object.keys(PRICES)) {
      part[name] = await newItem(
        `P4-M${name.toUpperCase()}-${tag}`,
        `${name} ${tag}`,
        PRICES[name],
        "test",
        name,
      );
    }
    pkg.three = await newItem(`P4-PKG3-${tag}`, "ABI,VPT,Fundus", 800, "procedure", null);
    pkg.two = await newItem(`P4-PKG2-${tag}`, "ABI,VPT", 600, "procedure", null);
    await parts(pkg.three, [part.ABI, part.VPT, part.Fundus]);
    await parts(pkg.two, [part.ABI, part.VPT]);
    await query(
      `UPDATE cash_shifts SET closed_at = NOW(), expected_cash = opening_cash,
              counted_cash = opening_cash, difference = 0
        WHERE closed_at IS NULL AND user_id = $1`,
      [USERS.reception.id],
    );
    await shifts.openShift({ opening_cash: 0 }, desk, db);
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
  });

  test("1. ABI, VPT and Fundus on one bill are the ₹800 package with no discount", async () => {
    const visit = await machineVisit("Three", ["ABI", "VPT", "Fundus"]);
    const bill = await bills.readBill(visit.billId, db);
    const lines = machineLines(bill);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.package_item_id).toBe(pkg.three);
      expect(line.package_name).toBe("ABI,VPT,Fundus");
      expect(line.discount).toBe(0);
      expect(line.lab_order_id).not.toBeNull();
    }
    expect(lines.reduce((sum, line) => sum + line.patient_payable, 0)).toBe(80000);
    expect(bill.totals.payable).toBe(80000);
    expect(bill.totals.discount).toBe(0);
    expect(bill.discounts).toEqual([]);
  });

  test("2. the old package discount rule never applies on top of the package", async () => {
    await discountCode(ids, null, {
      name: `P4 old package ${tag}`,
      method: "auto",
      kind: "fixed_price",
      value: 800,
      applies_per: "bill",
      service_item_ids: [part.ABI, part.VPT, part.Fundus],
      requires_all_items: true,
    });
    const visit = await machineVisit("Rule", ["ABI", "VPT", "Fundus"]);
    const bill = await bills.readBill(visit.billId, db);
    expect(bill.totals.payable).toBe(80000);
    expect(bill.totals.discount).toBe(0);
    expect(bill.discounts).toEqual([]);
  });

  test("3. ABI and VPT are the ₹600 package; ABI alone is a normal line", async () => {
    const two = await bills.readBill((await machineVisit("Two", ["ABI", "VPT"])).billId, db);
    expect(machineLines(two).map((line) => line.package_item_id)).toEqual([pkg.two, pkg.two]);
    expect(two.totals.payable).toBe(60000);
    const one = await bills.readBill((await machineVisit("One", ["ABI"])).billId, db);
    expect(machineLines(one)[0].package_item_id).toBeNull();
    expect(one.totals.payable).toBe(50000);
  });

  test("4. removing Fundus from the package leaves the ₹600 ABI,VPT package", async () => {
    const visit = await machineVisit("Drop", ["ABI", "VPT", "Fundus"]);
    const bill = await bills.readBill(visit.billId, db);
    const after = await bills.removeLine(
      bill.id,
      lineOfItem(bill, part.Fundus).id,
      { reason: "Patient refused fundus" },
      desk,
      db,
    );
    expect(machineLines(after).map((line) => line.package_item_id)).toEqual([pkg.two, pkg.two]);
    expect(after.totals.payable).toBe(60000);
  });

  test("5. removing the whole package takes all three lines off", async () => {
    const visit = await machineVisit("Whole", ["ABI", "VPT", "Fundus"]);
    const after = await bills.removePackage(
      visit.billId,
      pkg.three,
      { reason: "Patient left before the tests" },
      desk,
      db,
    );
    expect(machineLines(after)).toHaveLength(0);
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM billing_audit a
        WHERE a.entity = 'bill_lines' AND a.action = 'delete'
          AND a.before->>'bill_id' = $1::text`,
      [visit.billId],
    );
    expect(rows[0].n).toBe(3);
  });

  test("6. a 10% discount on the package row takes ₹80 across the three tests", async () => {
    const visit = await machineVisit("Disc", ["ABI", "VPT", "Fundus"]);
    const after = await bills.setPackageDiscount(
      visit.billId,
      pkg.three,
      { kind: "percent", value: 10, reason: "Staff family" },
      desk,
      db,
    );
    expect(after.totals.payable).toBe(72000);
    expect(machineLines(after).every((line) => line.package_item_id === pkg.three)).toBe(true);
    const flat = await bills.setPackageDiscount(
      visit.billId,
      pkg.three,
      { kind: "flat", value: 100, reason: "Staff family" },
      desk,
      db,
    );
    expect(flat.totals.payable).toBe(70000);
  });

  test("7. paying the package clears all three machine orders", async () => {
    const visit = await machineVisit("Pay", ["ABI", "VPT", "Fundus"]);
    const { paid, final } = await payAndFinalise(visit.billId);
    expect(paid.orders).toHaveLength(3);
    expect(final.status).toBe("final");
    const { rows } = await query(
      `SELECT payment_status FROM giniflow_lab_orders WHERE visit_id = $1`,
      [visit.visit],
    );
    expect(rows.map((row) => row.payment_status)).toEqual(["paid", "paid", "paid"]);
    ids.paidBill = final.id;
  });

  test("8. refunds reprice what stays as the smaller package", async () => {
    const bill = await bills.readBill(ids.paidBill, db);
    expect((await refundFor(bill, ["Fundus"])).totals.payable).toBe(20000);
    expect((await refundFor(bill, ["ABI"])).totals.payable).toBe(0);
    expect((await refundFor(bill, ["VPT", "Fundus"])).totals.payable).toBe(30000);
    expect((await refundFor(bill, ["ABI", "VPT", "Fundus"])).totals.payable).toBe(80000);
    const whole = await creditNotes.previewCredit(bill.id, { whole_bill: true }, db);
    expect(whole.totals.payable).toBe(80000);
  });

  test("9. the printed bill has one ABI,VPT,Fundus line for ₹800", async () => {
    const view = await billPdf.billView(ids.paidBill, db);
    const html = billPdf.itemsTableHtml(view, false);
    expect(html.match(/ABI,VPT,Fundus/g)).toHaveLength(1);
    expect(html).not.toContain(`Fundus ${tag}`);
    expect(html).not.toContain(`ABI ${tag}`);
    expect(html).toContain("800.00");
    const line = view.bill.lines.find((entry) => entry.bill_name === "ABI,VPT,Fundus");
    expect(line).toMatchObject({ quantity: 1, rate: 80000, actual: 80000, discount: 0 });
  });

  test("10. Fundus not done: the refund request is ₹200 and names Fundus", async () => {
    const bill = await bills.readBill(ids.paidBill, db);
    const request = await requests.requestLineRefund(
      { line_ids: [lineOfItem(bill, part.Fundus).id], reason_code: "billed_by_mistake" },
      desk,
      db,
    );
    const preview = await creditNotes.previewCredit(bill.id, { lines: request.refund.lines }, db);
    expect(preview.totals.payable).toBe(20000);
    expect(preview.lines.map((line) => line.bill_name)).toEqual([`Fundus ${tag}`]);
  });
});
