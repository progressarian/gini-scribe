import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { apiAs } from "../../helpers/auth.mjs";
import {
  HAS_COMMENTS,
  SEEDS_ROWS,
  openFreshCopy,
  readMigration,
} from "../../helpers/migration.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, refused, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  db,
  dropShifts,
  finalBill,
  inCash,
  lineFor,
  openDeskShift,
  prepareCategory,
} from "./p4b-refunds.mjs";
import {
  REFUND_REASONS,
  REFUND_REASON_VALUES,
  refundReasonText,
} from "../../../shared/refundReasons.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const requests = await import("../../../server/services/billing/billingRequests.js");
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");

const SQL = readMigration("2026-10-29_refund_reasons.sql");
const tag = newTag();
let ids;

const ask = (billId, extra) =>
  requests.createRefundRequest({ bill_id: billId, whole_bill: true, ...extra }, desk, db);

async function post(url, data, role = "reception") {
  const api = await apiAs(role);
  const response = await api.post(url, { data });
  const body = await response.json();
  await api.dispose();
  return { status: response.status(), body };
}

test.describe.serial("P4B-14 refund reasons", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    ids.bill = (
      await finalBill(ids, "Reasons", [{ item: ids.dressing }, { item: ids.brace }], {
        pay: inCash,
      })
    ).bill;
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. the migration adds a checked reason_code, runs twice, and leaves old rows valid", async () => {
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
    const fresh = await openFreshCopy(SQL, {
      undo: `ALTER TABLE billing_requests DROP COLUMN IF EXISTS reason_code CASCADE`,
      before: async (client) => {
        const { rows } = await client.query(
          `SELECT id FROM billing_requests WHERE kind = 'refund' LIMIT 5`,
        );
        return rows;
      },
    });
    try {
      const column = await fresh.client.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_name = 'billing_requests' AND column_name = 'reason_code'`,
      );
      expect(column.rows[0].data_type).toBe("text");
      const { rows: nulls } = await fresh.client.query(
        `SELECT count(*)::int AS n FROM billing_requests WHERE reason_code IS NOT NULL`,
      );
      expect(nulls[0].n).toBe(0);
      const request = await fresh.client.query(
        `INSERT INTO billing_requests (kind, patient_id, proposed_name, reason)
         VALUES ('new_item', $1, 'Probe', 'Probe') RETURNING id`,
        [ids.patient],
      );
      expect(
        await fresh.refused(`UPDATE billing_requests SET reason_code = 'long_wait' WHERE id = $1`, [
          request.rows[0].id,
        ]),
        "a reason code on a new-item request",
      ).toBe("23514");
    } finally {
      await fresh.close();
    }
    const constraint = await one(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'billing_requests_reason_code_check'`,
    );
    for (const value of REFUND_REASON_VALUES) expect(constraint.def).toContain(`'${value}'`);
  });

  test("2. every reason is taken, stored as its code and a readable reason", async () => {
    expect(REFUND_REASONS.map((r) => r.value)).toEqual([
      "long_wait",
      "doctor_cancelled",
      "station_unavailable",
      "patient_declined",
      "billed_by_mistake",
      "other",
    ]);
    for (const reason of REFUND_REASONS) {
      const note = reason.value === "other" ? "Patient moved to another city" : "";
      const request = await ask(ids.bill.id, { reason_code: reason.value, note });
      await expect(
        query(`UPDATE billing_requests SET reason_code = 'angry' WHERE id = $1`, [request.id]),
      ).rejects.toMatchObject({ code: "23514" });
      const stored = await one(`SELECT reason, reason_code FROM billing_requests WHERE id = $1`, [
        request.id,
      ]);
      expect(stored.reason_code).toBe(reason.value);
      expect(stored.reason).toBe(reason.value === "other" ? note : reason.label);
      expect(request.refund.reason_code).toBe(reason.value);
      expect(request.refund.reason_label).toBe(reason.label);
      await requests.rejectRequest(request.id, { note: "Probe" }, admin, db);
    }
    const noted = await ask(ids.bill.id, { reason_code: "long_wait", note: "  Waited 3 hours  " });
    expect(noted.reason).toBe("Long waiting time — Waited 3 hours");
    expect(refundReasonText("long_wait", "Waited 3 hours")).toBe(noted.reason);
    await requests.rejectRequest(noted.id, { note: "Probe" }, admin, db);
  });

  test("3. a reason is required, must be on the list, and Other needs a note — in the service and over HTTP", async () => {
    await refused(ask(ids.bill.id, {}), 400, /Choose why the money is going back/, "no reason");
    await refused(
      ask(ids.bill.id, { reason_code: "angry" }),
      400,
      /must be one of/,
      "an unknown reason",
    );
    await refused(
      ask(ids.bill.id, { reason_code: "other", note: "   " }),
      400,
      /Write the reason when you choose Other/,
      "Other with no note",
    );
    const url = "/api/billing/requests/refund";
    const base = { bill_id: ids.bill.id, whole_bill: true };
    const missing = await post(url, base);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/Reason/);
    expect((await post(url, { ...base, reason_code: "angry" })).status).toBe(400);
    const other = await post(url, { ...base, reason_code: "other" });
    expect(other.status).toBe(400);
    expect(other.body.error).toMatch(/Other/);
    const made = await post(url, { ...base, reason_code: "other", note: "Doctor said no" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ kind: "refund", reason: "Doctor said no" });
    expect(made.body.refund.reason_code).toBe("other");
    await requests.rejectRequest(made.body.id, { note: "Probe" }, admin, db);
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM billing_requests WHERE bill_id = $1 AND status = 'pending'`,
      [ids.bill.id],
    );
    expect(rows[0].n).toBe(0);
  });

  test("4. the floor can ask for a line's refund by its test order or line, with its reason", async () => {
    const { visit } = await extraVisit(ids, "FloorAsk");
    const order = await one(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                        sample_status, kind)
       VALUES ($1, 'today', 'pending', 250, 'payment_pending', 'lab') RETURNING id`,
      [visit],
    );
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 250)`,
      [order.id, ids.hba1cName],
    );
    const raised = await visitLines.linesForOrder(
      visit,
      { labOrderId: order.id, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    await bills.addLine(raised.bill_id, { item_id: ids.brace }, desk, db);
    const ready = await bills.setCategory(raised.bill_id, { category: ids.pensioner }, desk, db);
    const taken = await payments.takePayments(
      ready.id,
      { version: ready.version, payments: inCash(ready) },
      desk,
      db,
    );
    const bill = await bills.finaliseBill(ready.id, { version: taken.version }, desk, db);
    const hba1c = lineFor(bill, ids.hba1c);
    const brace = lineFor(bill, ids.brace);
    await refused(
      requests.requestLineRefund({ reason_code: "doctor_cancelled" }, desk, db),
      400,
      /Name the bill lines or the test order/,
      "nothing named",
    );
    const byOrder = await requests.requestLineRefund(
      { lab_order_id: order.id, reason_code: "doctor_cancelled" },
      desk,
      db,
    );
    expect(byOrder).toMatchObject({ kind: "refund", status: "pending", bill_id: bill.id });
    expect(byOrder.refund.lines).toEqual([{ line_id: hba1c.id, quantity: 1 }]);
    expect(byOrder.reason).toBe("Doctor cancelled the test");
    await requests.rejectRequest(byOrder.id, { note: "Probe" }, admin, db);

    const byLine = await requests.requestLineRefund(
      { line_ids: [brace.id], reason_code: "station_unavailable", note: "ECG machine down" },
      desk,
      db,
    );
    expect(byLine.refund.lines).toEqual([{ line_id: brace.id, quantity: 1 }]);
    expect(byLine.reason).toBe("Machine / station not available — ECG machine down");
    const approved = await requests.approveRequest(byLine.id, {}, admin, db);
    expect(approved.status).toBe("approved");
    await refused(
      requests.requestLineRefund({ line_ids: [brace.id], reason_code: "long_wait" }, desk, db),
      409,
      /Nothing on a final bill is left to refund/,
      "a line already credited",
    );
    await refused(
      requests.requestLineRefund(
        { line_ids: [lineFor(ids.bill, ids.brace).id, hba1c.id], reason_code: "long_wait" },
        desk,
        db,
      ),
      409,
      /different bills/,
      "lines on two bills",
    );
  });
});
