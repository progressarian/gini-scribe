import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { CONSULTANTS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { consultationItem, consultationForDesk, draftAtCheckIn } =
  await import("../../../server/services/billing/visitLines.js");
const bills = await import("../../../server/services/billing/bills.js");
const { consultantFeeGrid } = await import("../../../server/services/billing/consultantFees.js");
const { itemChoices } = await import("../../../server/services/billing/serviceItems.js");
const { RECENT_FOLLOW_UP } = await import("../../../shared/billingVocab.js");

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;
let freeItem;
let ownItem;

async function seenBefore(patient, daysAgo, doctorId = CONSULTANTS.banshali.id) {
  await query(
    `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type,
                               doctor_id, status)
     SELECT p.id, p.name, p.file_no, $2::date - $3::int, 'Follow Up', $4, 'completed'
       FROM patients p WHERE p.id = $1`,
    [patient, ids.day, daysAgo, doctorId],
  );
}

async function visitOf(made) {
  return one(
    `SELECT v.id, v.patient_id, v.appointment_id, v.assigned_doctor_id,
            v.visit_date::text AS visit_date, a.visit_type, a.doctor_id AS appointment_doctor_id,
            NULL::int AS journey_doctor_id, NULL::text AS journey_visit_type
       FROM giniflow_visits v JOIN appointments a ON a.id = v.appointment_id
      WHERE v.id = $1`,
    [made.visit],
  );
}

const chosen = async (made) => consultationItem(db, await visitOf(made));

test.describe.serial("P4C-53 follow-up within 3 days is a ₹0 consultation", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(true);
    freeItem = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, visit_type, doctor_id)
         VALUES ($1, $2, $3, 0, 'consultation', $4, NULL) RETURNING id`,
        [`P4-FU3-${tag}`, `Follow-up within 3 days ${tag}`, ids.subgroup, RECENT_FOLLOW_UP],
      )
    ).id;
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
    await query(`DELETE FROM service_items WHERE id = ANY($1)`, [
      [freeItem, ownItem].filter(Boolean),
    ]).catch(() => {});
  });

  test("1. seen by the same consultant 2 days ago: the ₹0 follow-up", async () => {
    const made = await extraVisit(ids, "Fu2", { visitType: "Follow Up", healthray: false });
    await seenBefore(made.patient, 2);
    expect(await chosen(made)).toMatchObject({ id: freeItem, visit_type: RECENT_FOLLOW_UP });
  });

  test("2. exactly 3 days ago is free; 4 days ago pays the normal follow-up", async () => {
    const three = await extraVisit(ids, "Fu3", { visitType: "Follow Up", healthray: false });
    await seenBefore(three.patient, 3);
    expect((await chosen(three)).id).toBe(freeItem);

    const four = await extraVisit(ids, "Fu4", { visitType: "Follow Up", healthray: false });
    await seenBefore(four.patient, 4);
    expect(await chosen(four)).toMatchObject({ id: ids.consultFu, visit_type: "Follow Up" });
  });

  test("3. a different consultant yesterday does not count", async () => {
    const made = await extraVisit(ids, "FuOther", { visitType: "Follow Up", healthray: false });
    await seenBefore(made.patient, 1, CONSULTANTS.rahul.id);
    expect((await chosen(made)).id).toBe(ids.consultFu);
  });

  test("4. booked as New but seen by the same consultant yesterday: still ₹0", async () => {
    const made = await extraVisit(ids, "FuNew", { visitType: "New Patient", healthray: false });
    await seenBefore(made.patient, 1);
    expect((await chosen(made)).id).toBe(freeItem);
  });

  test("5. a seen-today visit or a cancelled one earlier does not count", async () => {
    const made = await extraVisit(ids, "FuToday", { visitType: "Follow Up", healthray: false });
    await seenBefore(made.patient, 0);
    await query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type,
                                 doctor_id, status)
       SELECT id, name, file_no, $2::date - 1, 'Follow Up', $3, 'cancelled' FROM patients WHERE id = $1`,
      [made.patient, ids.day, CONSULTANTS.banshali.id],
    );
    expect((await chosen(made)).id).toBe(ids.consultFu);
  });

  test("6. a consultant's own 3-day item wins over the ₹0 default", async () => {
    ownItem = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, visit_type, doctor_id)
         VALUES ($1, $2, $3, 200, 'consultation', $4, $5) RETURNING id`,
        [
          `P4-FU3D-${tag}`,
          `Dr follow-up 3 days ${tag}`,
          ids.subgroup,
          RECENT_FOLLOW_UP,
          CONSULTANTS.banshali.id,
        ],
      )
    ).id;
    const made = await extraVisit(ids, "FuOwn", { visitType: "Follow Up", healthray: false });
    await seenBefore(made.patient, 1);
    expect((await chosen(made)).id).toBe(ownItem);
    await query(`UPDATE service_items SET is_active = FALSE WHERE id = $1`, [ownItem]);
    expect((await chosen(made)).id).toBe(freeItem);
  });

  test("7. on the bill: the line is the ₹0 follow-up and nothing is due for it", async () => {
    const made = await extraVisit(ids, "FuBill", { visitType: "Follow Up" });
    await seenBefore(made.patient, 2);
    await consultationForDesk(made.visit, desk, db);
    const draft = await bills.openDraft(made.visit, desk, db);
    const bill = await bills.readBill(draft.id, db);
    const line = bill.lines.find((l) => l.service_item_id === freeItem);
    expect(line).toBeTruthy();
    expect(Number(line.patient_payable)).toBe(0);
    expect(bill.lines.some((l) => l.service_item_id === ids.consultFu)).toBe(false);
  });

  test("7a. no HealthRay consultation needed: the ₹0 line is added at check-in", async () => {
    const made = await extraVisit(ids, "FuNoHr", { visitType: "Follow Up", healthray: false });
    await seenBefore(made.patient, 1);
    await draftAtCheckIn(made.visit, desk, db);
    const draft = await bills.openDraft(made.visit, desk, db);
    const bill = await bills.readBill(draft.id, db);
    expect(bill.lines.map((l) => l.service_item_id)).toContain(freeItem);
  });

  test("7b. the ₹0 follow-up can't be added by hand for a patient not seen in the last 3 days", async () => {
    const made = await extraVisit(ids, "FuHand", { visitType: "Follow Up", healthray: false });
    await seenBefore(made.patient, 5);
    const draft = await bills.openDraft(made.visit, desk, db);
    await expect(
      bills.addLine(draft.id, { item_id: freeItem, doctor_id: CONSULTANTS.banshali.id }, desk, db),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("8. Settings → Services and Consultant fees both offer the 3-day type", async () => {
    expect((await itemChoices(db)).visitTypes).toContain(RECENT_FOLLOW_UP);
    const grid = await consultantFeeGrid({ doctorId: CONSULTANTS.banshali.id }, db);
    expect(grid.visit_types).toContain(RECENT_FOLLOW_UP);
  });
});
