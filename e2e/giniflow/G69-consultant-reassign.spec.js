import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../fixtures/data.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { desk, failure, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import {
  db,
  draftWith,
  dropShifts,
  finalBill,
  openDeskShift,
  prepareCategory,
} from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const triage = await import("../../server/services/giniflow/triage.js");
const change = await import("../../server/services/billing/consultantChange.js");
const healthray = await import("../../server/services/healthray/db.js");

const tag = newTag();
let ids;
const coordinator = USERS.admin.id;
const rupees = (paise) => paise * 100;

const reassign = (visit, doctor) => triage.assign(visit, { doctorId: doctor.id }, coordinator, db);

const pending = (visit) =>
  query(`SELECT * FROM consultant_changes WHERE visit_id = $1 AND status = 'pending'`, [
    visit,
  ]).then((r) => r.rows[0] ?? null);

const deposit = (patient) =>
  one(
    `SELECT COALESCE((SELECT balance FROM deposit_accounts WHERE patient_id = $1), 0)::numeric AS balance`,
    [patient],
  ).then((r) => Math.round(Number(r.balance) * 100));

const draftOf = (visit) =>
  one(
    `SELECT id, patient_payable, paid_amount FROM bills
      WHERE visit_id = $1 AND status = 'draft' AND bill_type = 'invoice'`,
    [visit],
  );

const liveConsultItems = (visit) =>
  query(
    `SELECT l.service_item_id FROM bill_lines l JOIN bills b ON b.id = l.bill_id
       JOIN service_items i ON i.id = l.service_item_id
      WHERE l.visit_id = $1 AND l.is_live AND i.kind = 'consultation' AND b.status <> 'cancelled'`,
    [visit],
  ).then((r) => r.rows.map((row) => row.service_item_id));

const paidConsult = (label, extra = {}) =>
  finalBill(ids, label, [{ item: ids.consultDoctorNew }], {
    pay: (bill) => [{ mode: "cash", amount: bill.totals.payable / 100 }],
    ...extra,
  });

test.describe.serial("G69 reassigning the consultant moves the bill with them", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    ids.rahulNew = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, visit_type, doctor_id)
         VALUES ($1, $2, $3, 2500, 'consultation', 'New', $4) RETURNING id`,
        [`P4-CRN-${tag}`, `Consultation Dr Rahul New ${tag}`, ids.subgroup, CONSULTANTS.rahul.id],
      )
    ).id;
    await openDeskShift(0);
  });

  test.afterAll(async () => {
    await dropShifts();
    await tearDown(ids);
  });

  test("1. the menu's preview shows the difference before anything changes", async () => {
    const { visit } = await paidConsult("Preview");
    const fee = await change.consultFeeDifference(visit, CONSULTANTS.rahul.id, desk, db);
    expect(fee).toMatchObject({
      bill_state: "final",
      charged: rupees(2000),
      new_fee: rupees(2500),
      difference: rupees(500),
      fee_missing: false,
    });
    expect(fee.from.id).toBe(CONSULTANTS.banshali.id);
    expect(await pending(visit)).toBeNull();
  });

  test("2. costs more: the paid fee goes into the deposit, pays the new fee, ₹500 left to collect", async () => {
    const { visit, bill } = await paidConsult("More");
    const moved = await reassign(visit, CONSULTANTS.rahul);
    expect(moved.billing.change_id).toBeTruthy();

    const appt = await one(
      `SELECT a.doctor_id, a.doctor_name, a.doctor_set_manually_at
         FROM appointments a JOIN giniflow_visits v ON v.appointment_id = a.id WHERE v.id = $1`,
      [visit],
    );
    expect(appt.doctor_id).toBe(CONSULTANTS.rahul.id);
    expect(appt.doctor_name).toBe(CONSULTANTS.rahul.name);
    expect(appt.doctor_set_manually_at).toBeTruthy();
    const logged = await one(
      `SELECT COUNT(*)::int AS n FROM appointment_change_log l
         JOIN giniflow_visits v ON v.appointment_id = l.appointment_id
        WHERE v.id = $1 AND l.field = 'doctor_name' AND l.new_value = $2`,
      [visit, CONSULTANTS.rahul.name],
    );
    expect(logged.n).toBe(1);

    const open = await pending(visit);
    expect(open).toMatchObject({
      from_doctor_id: CONSULTANTS.banshali.id,
      to_doctor_id: CONSULTANTS.rahul.id,
    });

    const sameHand = await failure(
      change.confirmConsultantChange(open.id, {}, { actorId: coordinator, role: "admin" }, db),
    );
    expect(sameHand?.status).toBe(409);
    expect(sameHand?.message).toMatch(/Someone other than the person who changed the consultant/);

    const shown = await change.consultantChangeForVisit(visit, desk, db);
    expect(shown.preview).toMatchObject({
      to_deposit: rupees(2000),
      applied_from_deposit: rupees(2000),
      to_collect: rupees(500),
      left_in_deposit: 0,
    });

    const done = await change.confirmConsultantChange(open.id, {}, desk, db);
    expect(done).toMatchObject({
      charged: rupees(2000),
      new_fee: rupees(2500),
      to_deposit: rupees(2000),
      applied_from_deposit: rupees(2000),
      left_in_deposit: 0,
    });
    const note = await one(
      `SELECT credit_kind, patient_payable FROM bills WHERE original_bill_id = $1`,
      [bill.id],
    );
    expect(note.credit_kind).toBe("consultant_change");
    expect(Number(note.patient_payable)).toBe(2000);
    const draft = await draftOf(visit);
    expect(Number(draft.patient_payable)).toBe(2500);
    expect(Number(draft.paid_amount)).toBe(2000);
    expect(await liveConsultItems(visit)).toEqual([ids.rahulNew]);
    expect(await deposit(bill.patient_id)).toBe(0);
    expect(
      (await one(`SELECT status FROM consultant_changes WHERE id = $1`, [open.id])).status,
    ).toBe("done");
  });

  test("3. costs less: the leftover can go back as a refund waiting for a second person", async () => {
    const { visit, bill } = await paidConsult("Less");
    await reassign(visit, CONSULTANTS.beant);
    const open = await pending(visit);
    const done = await change.confirmConsultantChange(
      open.id,
      { leftover: "refund", refund_mode: "cash" },
      desk,
      db,
    );
    expect(done).toMatchObject({
      new_fee: rupees(1500),
      applied_from_deposit: rupees(1500),
      refund_requested: rupees(500),
    });
    const refund = await one(
      `SELECT kind, status, amount, requested_mode FROM billing_requests WHERE id = $1`,
      [done.refund_request_id],
    );
    expect(refund).toMatchObject({
      kind: "deposit_refund",
      status: "pending",
      requested_mode: "cash",
    });
    expect(Number(refund.amount)).toBe(500);
    expect(await deposit(bill.patient_id)).toBe(rupees(500));
    expect(await liveConsultItems(visit)).toEqual([ids.consultNew]);
  });

  test("4. a draft bill just swaps the line — nothing for the counter to confirm", async () => {
    const { visit } = await draftWith(ids, "Draft", [{ item: ids.consultDoctorNew }]);
    const moved = await reassign(visit, CONSULTANTS.rahul);
    expect(moved.billing.draft.swapped).toBe(1);
    expect(moved.billing.change_id).toBeNull();
    expect(await liveConsultItems(visit)).toEqual([ids.rahulNew]);
    expect(Number((await draftOf(visit)).patient_payable)).toBe(2500);
    expect(await pending(visit)).toBeNull();
  });

  test("5. moved back before the counter acts: the waiting item is withdrawn", async () => {
    const { visit } = await paidConsult("Back");
    await reassign(visit, CONSULTANTS.rahul);
    const first = await pending(visit);
    await reassign(visit, CONSULTANTS.banshali);
    expect(await pending(visit)).toBeNull();
    expect(
      (await one(`SELECT status FROM consultant_changes WHERE id = $1`, [first.id])).status,
    ).toBe("void");
  });

  test("6. a pay-later bill: the credit comes off what is owed, nothing goes into the deposit", async () => {
    const { visit, bill } = await finalBill(ids, "Later", [{ item: ids.consultDoctorNew }], {
      payLater: true,
    });
    await reassign(visit, CONSULTANTS.rahul);
    const done = await change.confirmConsultantChange((await pending(visit)).id, {}, desk, db);
    expect(done.to_deposit).toBe(0);
    expect(done.applied_from_deposit).toBe(0);
    expect(Number((await draftOf(visit)).patient_payable)).toBe(2500);
    expect(await deposit(bill.patient_id)).toBe(0);
  });

  test("7. once the consultant has started, the patient can't be moved", async () => {
    const { visit } = await paidConsult("Started");
    await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [visit]);
    const refused = await failure(reassign(visit, CONSULTANTS.rahul));
    expect(refused?.status).toBe(409);
    expect(refused?.message).toMatch(/already started this consult/);
    const row = await one(`SELECT assigned_doctor_id FROM giniflow_visits WHERE id = $1`, [visit]);
    expect(row.assigned_doctor_id).toBe(CONSULTANTS.banshali.id);
    expect(await pending(visit)).toBeNull();
  });

  test("8. the HealthRay sync does not put the old consultant back", async () => {
    const { visit } = await draftWith(ids, "Sync", [{ item: ids.consultDoctorNew }]);
    await reassign(visit, CONSULTANTS.rahul);
    const { appointment_id: appointment } = await one(
      `SELECT appointment_id FROM giniflow_visits WHERE id = $1`,
      [visit],
    );
    await healthray.upsertAppointment(appointment, {
      localDoctorName: CONSULTANTS.banshali.name,
      biomarkers: {},
      compliance: {},
    });
    const after = await one(`SELECT doctor_name FROM appointments WHERE id = $1`, [appointment]);
    expect(after.doctor_name).toBe(CONSULTANTS.rahul.name);
  });

  test("9. the counter shows the change, and keeping the bill needs a reason", async ({ page }) => {
    const { visit } = await paidConsult("Counter");
    await reassign(visit, CONSULTANTS.rahul);
    await loginAs(page, "reception");
    await gotoReady(page, `/giniflow/station/reception?tab=bill&visit=${visit}`, () =>
      page.getByRole("status", { name: "Consultant changed" }),
    );
    const box = page.getByRole("status", { name: "Consultant changed" });
    await expect(box).toContainText("Dr Banshali → Dr Rahul");
    await expect(box).toContainText("₹500 more to collect");
    await expect(
      page.getByRole("button", { name: new RegExp(`P4 Counter ${tag}`) }).first(),
    ).toContainText("Consultant changed — fee to settle");
    await box.getByRole("button", { name: "Keep the bill as it is" }).click();
    const keep = page.getByRole("button", { name: "Keep the bill", exact: true });
    await expect(keep).toBeDisabled();
    await page.getByLabel("Why the bill stays as it is (required)").fill("Agreed at the old fee");
    await keep.click();
    await expect(page.getByText("The bill stays as it is")).toBeVisible();
    expect(await pending(visit)).toBeNull();
  });

  test("10. the Assign menu shows the fee difference before saving", async ({ page }) => {
    await paidConsult("Menu");
    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/triage", () => page.getByLabel("Search this day's patients"));
    await page.getByLabel("Search this day's patients").fill(`Menu ${tag}`);
    const card = page.locator("article.pt-card", { hasText: `P4 Menu ${tag}` });
    await card.getByRole("button", { name: "↺ Change" }).click();
    const dialog = page.getByRole("dialog", { name: `Triage P4 Menu ${tag}` });
    await dialog
      .getByRole("button", { name: /Dr Rahul/ })
      .last()
      .click();
    await expect(dialog.getByRole("status")).toContainText("₹500 more to collect");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("11. the OPD Triage tab reassigns through the same action, with the same preview", async () => {
    const { visit } = await paidConsult("Opd");
    const { appointment_id: appointment } = await one(
      `SELECT appointment_id FROM giniflow_visits WHERE id = $1`,
      [visit],
    );
    const api = await apiAs("reception");
    try {
      const fee = await api.get(
        `/api/appointments/${appointment}/consult-fee?doctorId=${CONSULTANTS.rahul.id}`,
      );
      expect(fee.status()).toBe(200);
      expect(await fee.json()).toMatchObject({ visit: true, difference: rupees(500) });
      const moved = await api.post(`/api/appointments/${appointment}/consultant`, {
        data: { doctorId: CONSULTANTS.rahul.id },
      });
      expect(moved.status()).toBe(200);
      const body = await moved.json();
      expect(body.appointment.doctor_name).toBe(CONSULTANTS.rahul.name);
      expect(body.billing.change_id).toBeTruthy();
      const row = await one(`SELECT assigned_doctor_id FROM giniflow_visits WHERE id = $1`, [
        visit,
      ]);
      expect(row.assigned_doctor_id).toBe(CONSULTANTS.rahul.id);
    } finally {
      await api.dispose();
    }
  });

  test("12. an appointment not on the floor yet changes the consultant only", async () => {
    const { appointment } = await one(
      `INSERT INTO appointments (patient_id, patient_name, appointment_date, visit_type,
                                 doctor_id, doctor_name)
       SELECT patient_id, patient_name, appointment_date + 1, visit_type, doctor_id, doctor_name
         FROM appointments WHERE id = $1
       RETURNING id AS appointment`,
      [ids.appointment],
    );
    const api = await apiAs("reception");
    try {
      const fee = await api.get(
        `/api/appointments/${appointment}/consult-fee?doctorId=${CONSULTANTS.rahul.id}`,
      );
      expect(await fee.json()).toMatchObject({ visit: false, bill_state: "none" });
      const moved = await api.post(`/api/appointments/${appointment}/consultant`, {
        data: { doctorId: CONSULTANTS.rahul.id },
      });
      expect(moved.status()).toBe(200);
      const body = await moved.json();
      expect(body.billing).toBeNull();
      expect(body.appointment).toMatchObject({
        doctor_id: CONSULTANTS.rahul.id,
        doctor_name: CONSULTANTS.rahul.name,
      });
      expect(body.appointment.doctor_set_manually_at).toBeTruthy();
    } finally {
      await api.dispose();
    }
  });

  test("13. the OPD Manager shows the Triage tab again", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/opd", () => page.getByRole("button", { name: "🔴🟡✅ Triage" }));
    await page.getByRole("button", { name: "🔴🟡✅ Triage" }).click();
    await expect(page.getByRole("button", { name: "🧪 Triage v3" })).toBeVisible();
  });
});
