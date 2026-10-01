import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  db,
  dropShifts,
  finalBill,
  inCash,
  lineFor,
  openDeskShift,
  prepareCategory,
  refundApproved,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");

const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
let ids;
let payLaterBefore;

async function get(url, params, role = "reception") {
  const api = await apiAs(role);
  const response = await api.get(url, params ? { params } : undefined);
  const body = await response.json();
  await api.dispose();
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body;
}

const counterRow = async (label) => {
  const body = await get("/api/billing/counter/patients", { q: tag });
  const name = `P4 ${label} ${tag}`;
  return [...body.toBill, ...body.billed, ...body.waiting].find((row) => row.name === name);
};

test.describe.serial("P4B-12 dues and bill views show credits and refunds", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    ({ allow_pay_later: payLaterBefore } = await one(
      `SELECT allow_pay_later FROM billing_settings`,
    ));
    await query(`UPDATE billing_settings SET allow_pay_later = TRUE`);
    await openDeskShift(0);
    ids.later = (
      await finalBill(ids, "ViewLater", [{ item: ids.brace }, { item: ids.dressing }], {
        pay: [{ mode: "cash", amount: 300 }],
        payLater: true,
      })
    ).bill;
    ids.paid = (
      await finalBill(ids, "ViewPaid", [{ item: ids.brace }, { item: ids.dressing }], {
        pay: inCash,
      })
    ).bill;
    await dropShifts();
  });

  test.afterAll(async () => {
    try {
      if (payLaterBefore !== undefined) {
        await query(`UPDATE billing_settings SET allow_pay_later = $1`, [payLaterBefore]);
      }
    } finally {
      await tearDown(ids);
      await dropShifts();
    }
  });

  test("1. dues show the balance after a credit, on the list, today's dues, the register and the Dues tab", async ({
    page,
  }) => {
    const approved = await refundApproved(ids.later.id, [
      { line_id: lineFor(ids.later, ids.brace).id },
    ]);
    expect(approved.credit_note.refund.due).toBe(0);
    const due = (await get("/api/billing/dues", { patient_id: ids.later.patient_id }))[0];
    expect(due).toMatchObject({
      payable: 130000,
      credited: 80000,
      paid: 30000,
      outstanding: 20000,
    });
    const today = await get("/api/billing/dues/today");
    expect(today.rows.find((row) => row.bill_id === ids.later.id).outstanding).toBe(20000);
    const register = await get(
      "/api/billing/dues-register",
      { q: ids.later.bill_no },
      "reception_admin",
    );
    expect(register.rows.map((row) => [row.bill_id, row.outstanding])).toEqual([
      [ids.later.id, 20000],
    ]);
    const bill = await get(`/api/billing/bills/${ids.later.id}`);
    expect(bill.credits).toMatchObject({
      credited: 80000,
      refunded: 0,
      balance: 20000,
      to_pay_back: 0,
    });

    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=dues`, () =>
      page.getByRole("region", { name: "Dues" }),
    );
    const row = page
      .getByRole("table", { name: "Due today" })
      .getByRole("row")
      .filter({ hasText: ids.later.bill_no });
    await expect(row).toContainText("₹500");
    await expect(row).toContainText("₹800 credited");
    await expect(row).toContainText("₹200");
  });

  test("2. a paid bill with an approved credit shows what is to pay back on the counter list, then the refund on its bill", async ({
    page,
  }) => {
    const approved = await refundApproved(ids.paid.id, [
      { line_id: lineFor(ids.paid, ids.brace).id },
    ]);
    const note = approved.credit_note;
    expect((await counterRow("ViewPaid")).payBack).toBe(80000);
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill`, () =>
      page.getByRole("searchbox", { name: "Search today's patients" }),
    );
    await page.getByRole("searchbox", { name: "Search today's patients" }).fill(`ViewPaid ${tag}`);
    await expect(
      page.getByRole("button", { name: new RegExp(`P4 ViewPaid ${tag}`) }),
    ).toContainText("₹800 to pay back");

    const shift = await openDeskShift(1000);
    try {
      await payments.payOut(
        note.id,
        { version: note.version, payments: [{ mode: "cash", amount: 800 }] },
        desk,
        db,
      );
      expect((await counterRow("ViewPaid")).payBack).toBe(0);
      const view = await shifts.currentShift(desk, db);
      expect(view.id).toBe(shift.id);
      expect(view.refunded.cash).toBe(800);
      expect(view.expected_cash).toBe(200);

      await gotoReady(page, `${RECEPTION}?tab=shift`, () =>
        page.getByRole("table", { name: "Drawer" }),
      );
      const drawer = page.getByRole("table", { name: "Drawer" });
      await expect(drawer.getByRole("row", { name: /Cash paid back/ })).toContainText("₹800");
      await expect(drawer.getByRole("row", { name: /Expected in the drawer/ })).toContainText(
        "₹200",
      );
      await expect(page.getByRole("region", { name: "Shift" })).toContainText("1 refund paid out");
    } finally {
      await dropShifts();
    }

    const listed = await get(`/api/billing/visits/${ids.paid.visit_id}/bills`);
    const invoice = listed.find((b) => b.id === ids.paid.id);
    expect(invoice.credits.notes).toEqual([
      expect.objectContaining({
        id: note.id,
        bill_no: note.bill_no,
        payable: 80000,
        refunded: 80000,
      }),
    ]);

    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${ids.paid.visit_id}`, () =>
      page.getByRole("region", { name: "Earlier bills on this visit" }),
    );
    const earlier = page.getByRole("region", { name: "Earlier bills on this visit" });
    await expect(earlier.getByRole("row")).toHaveCount(2);
    await expect(earlier).toContainText(`Refunded ₹800 on ${note.bill_no}`);
    await expect(
      earlier.getByRole("button", { name: `Refund on bill ${ids.paid.bill_no}` }),
    ).toBeVisible();
  });
});
