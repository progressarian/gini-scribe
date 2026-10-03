import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  healthrayBill,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const { healthrayLinesForDesk, healthrayBillSuggestion } =
  await import("../../../server/services/billing/healthrayBillLines.js");
const { notPricedList } = await import("../../../server/services/billing/serviceItems.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");

const db = getPool();
const tag = newTag();
const TAG = tag.toUpperCase();
let ids;
let autoBefore;
let visit;
let perPatient;

const mystery = `Mystery scan ${tag}`;
const reviewCode = `HR-MYSTERY-SCAN-${TAG}`;

const draftOf = (visitId) => bills.openDraft(visitId, desk, db);
const byItem = (draft) =>
  Object.fromEntries(draft.lines.map((line) => [line.service_item_id, line]));
const reviewItem = () =>
  one(
    `SELECT i.id, i.kind, i.base_price::float AS base_price, i.price_per_patient, s.code AS subgroup
       FROM service_items i JOIN service_subgroups s ON s.id = i.subgroup_id
      WHERE i.code = $1`,
    [reviewCode],
  );

test.describe.serial("P4C-25 every HealthRay bill line reaches the bill", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    visit = await extraVisit(ids, "C25", { visitType: "Follow Up" });
    perPatient = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, price_per_patient)
         VALUES ($1, $2, $3, 0, 'procedure', TRUE) RETURNING id`,
        [`P4-PP-${tag}`, `Wound care ${tag}`, ids.subgroup],
      )
    ).id;
    await healthrayBill(ids, visit.patient, [
      { desc: `Dressing ${tag}`, amount: 650, category: "procedure" },
      { desc: `Ankle brace ${tag}`, amount: 900, category: "procedure" },
      { desc: `Wound care ${tag}`, amount: 1200, category: "procedure" },
      { desc: mystery, amount: 3000, category: "radiology" },
      { desc: `HbA1c ${tag}`, amount: 400, category: "lab", cancelled: true },
      { desc: "Follow-up Appointment", amount: 1000, category: "consultation" },
    ]);
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`HR-%-${TAG}`]);
  });

  test("1. every live line lands: Scribe's price when it has one, HealthRay's amount otherwise", async () => {
    const result = await healthrayLinesForDesk(visit.visit, desk, db);
    expect(result.ok).toBe(true);
    expect(result.added.sort()).toEqual(
      [`Ankle brace ${tag}`, `Dressing ${tag}`, mystery, `Wound care ${tag}`].sort(),
    );

    const review = await reviewItem();
    expect(review).toMatchObject({
      kind: "other",
      base_price: 0,
      price_per_patient: true,
      subgroup: "HR-REVIEW",
    });

    const lines = byItem(await draftOf(visit.visit));
    expect(Object.keys(lines).map(Number).sort()).toEqual(
      [ids.brace, ids.dressing, perPatient, review.id].sort(),
    );
    expect(lines[ids.dressing].actual).toBe(50000);
    expect(lines[ids.brace].actual).toBe(80000);
    expect(lines[perPatient].actual).toBe(120000);
    expect(lines[perPatient].agreed_by).toBeNull();
    expect(lines[review.id].actual).toBe(300000);
    expect(lines[review.id].bill_name).toBe(mystery);

    const card = await healthrayBillSuggestion((await draftOf(visit.visit)).id, desk, db);
    expect(card.lines).toEqual([]);
    expect(card.not_matched).toEqual([]);
  });

  test("2. opening again adds nothing twice", async () => {
    const again = await healthrayLinesForDesk(visit.visit, desk, db);
    expect(again.added).toEqual([]);
    expect((await draftOf(visit.visit)).lines).toHaveLength(4);
  });

  test("3. a line the cashier removed is not put back", async () => {
    const draft = await draftOf(visit.visit);
    const brace = draft.lines.find((line) => line.service_item_id === ids.brace);
    await bills.removeLine(draft.id, brace.id, { reason: "Patient declined" }, desk, db);
    const again = await healthrayLinesForDesk(visit.visit, desk, db);
    expect(again.added).toEqual([]);
    expect(byItem(await draftOf(visit.visit))[ids.brace]).toBeUndefined();
  });

  test("4. the same unknown name on another patient reuses the review service at their own amount", async () => {
    const other = await extraVisit(ids, "C25Again", { visitType: "Follow Up" });
    await healthrayBill(ids, other.patient, [
      { desc: mystery, amount: 2500, category: "radiology" },
    ]);
    const result = await healthrayLinesForDesk(other.visit, desk, db);
    expect(result.added).toEqual([mystery]);
    const { n } = await one(`SELECT COUNT(*)::int AS n FROM service_items WHERE code LIKE $1`, [
      `HR-MYSTERY-SCAN-${TAG}%`,
    ]);
    expect(n).toBe(1);
    const review = await reviewItem();
    expect(byItem(await draftOf(other.visit))[review.id].actual).toBe(250000);
  });

  test("5. a ₹0 HealthRay line is not added and creates nothing", async () => {
    const free = await extraVisit(ids, "C25Free", { visitType: "Follow Up" });
    await healthrayBill(ids, free.patient, [
      { desc: `Free leaflet ${tag}`, amount: 0, category: "other" },
    ]);
    const result = await healthrayLinesForDesk(free.visit, desk, db);
    expect(result.added).toEqual([]);
    const made = await one(`SELECT COUNT(*)::int AS n FROM service_items WHERE code = $1`, [
      `HR-FREE-LEAFLET-${TAG}`,
    ]);
    expect(made.n).toBe(0);
  });

  test("6. an unknown name already paid at reception is not charged again", async () => {
    const paid = await extraVisit(ids, "C25Paid", { visitType: "Follow Up" });
    const rare = `Rare panel ${tag}`;
    const order = await one(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                        amount_paid, sample_status, kind)
       VALUES ($1, 'today', 'pending', 700, 0, 'payment_pending', 'lab') RETURNING id`,
      [paid.visit],
    );
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 700)`,
      [order.id, rare],
    );
    await reception.clearPayment(
      order.id,
      { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true },
      db,
    );
    await healthrayBill(ids, paid.patient, [{ desc: rare, amount: 700, category: "lab" }]);
    const result = await healthrayLinesForDesk(paid.visit, desk, db);
    expect(result.added).toEqual([]);
    const made = await one(`SELECT COUNT(*)::int AS n FROM service_items WHERE code = $1`, [
      `HR-RARE-PANEL-${TAG}`,
    ]);
    expect(made.n).toBe(0);
  });

  test("7. a visit with no HealthRay bill adds nothing and opens no bill", async () => {
    const quiet = await extraVisit(ids, "C25Quiet", { visitType: "Follow Up", healthray: false });
    const result = await healthrayLinesForDesk(quiet.visit, desk, db);
    expect(result).toMatchObject({ ok: true, added: [] });
    const { n } = await one(`SELECT COUNT(*)::int AS n FROM bills WHERE visit_id = $1`, [
      quiet.visit,
    ]);
    expect(n).toBe(0);
  });

  test("8. the review list shows the added service with how often HealthRay billed it", async () => {
    const list = await notPricedList(db);
    const row = list.fromHealthray.find((r) => r.item_code === reviewCode);
    expect(row).toMatchObject({ name: mystery, kind: "other", times_billed: 2 });
    expect(row.amounts.map((a) => a.amount).sort()).toEqual([2500, 3000]);
  });

  test("9. the same words in another order match the existing service, not a new one", async () => {
    const reordered = await extraVisit(ids, "C25Order", { visitType: "Follow Up" });
    await healthrayBill(ids, reordered.patient, [
      { desc: `${tag} Brace - Ankle`, amount: 900, category: "procedure" },
    ]);
    const result = await healthrayLinesForDesk(reordered.visit, desk, db);
    expect(result.created ?? []).toEqual([]);
    expect(Object.keys(byItem(await draftOf(reordered.visit))).map(Number)).toEqual([ids.brace]);
    const made = await one(
      `SELECT COUNT(*)::int AS n FROM service_items WHERE code LIKE 'HR-%' AND code LIKE $1`,
      [`%${TAG}%BRACE%`],
    );
    expect(made.n).toBe(0);
  });

  test("10. a real service named like an auto-created one wins over it", async () => {
    const review = await reviewItem();
    const real = await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
       VALUES ($1, $2, $3, 2800, 'procedure') RETURNING id`,
      [`P4-MS-${tag}`, `Scan mystery ${tag}`, ids.subgroup],
    );
    const later = await extraVisit(ids, "C25Real", { visitType: "Follow Up" });
    await healthrayBill(ids, later.patient, [
      { desc: mystery, amount: 3000, category: "radiology" },
    ]);
    await healthrayLinesForDesk(later.visit, desk, db);
    const lines = byItem(await draftOf(later.visit));
    expect(Object.keys(lines).map(Number)).toEqual([real.id]);
    expect(lines[real.id].actual).toBe(280000);
    expect(lines[review.id]).toBeUndefined();
  });
});
