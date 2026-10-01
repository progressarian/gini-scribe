import { test, expect } from "@playwright/test";
import { getPool, one } from "../../helpers/db.mjs";
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

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;
let visit;
let perPatient;

const liveItems = async (billId) =>
  (await bills.readBill(billId, db)).lines.map((line) => line.service_item_id).sort();

test.describe.serial("P4C-25 HealthRay bill lines go straight onto the bill", () => {
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
      { desc: `Mystery scan ${tag}`, amount: 3000, category: "radiology" },
      { desc: `HbA1c ${tag}`, amount: 400, category: "lab", cancelled: true },
      { desc: "Follow-up Appointment", amount: 1000, category: "consultation" },
    ]);
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
  });

  test("1. matched, priced lines are added at Scribe's price; the rest stay in the card", async () => {
    const result = await healthrayLinesForDesk(visit.visit, desk, db);
    expect(result.ok).toBe(true);
    expect(result.added.sort()).toEqual([`Ankle brace ${tag}`, `Dressing ${tag}`]);

    const draft = await bills.openDraft(visit.visit, desk, db);
    expect(await liveItems(draft.id)).toEqual([ids.brace, ids.dressing].sort());
    const priced = Object.fromEntries(
      draft.lines.map((line) => [line.service_item_id, line.actual]),
    );
    expect(priced[ids.dressing]).toBe(50000);
    expect(priced[ids.brace]).toBe(80000);

    const card = await healthrayBillSuggestion(draft.id, desk, db);
    expect(card.lines.map((line) => line.item_id)).toEqual([perPatient]);
    expect(card.not_matched.map((line) => line.desc)).toEqual([`Mystery scan ${tag}`]);
  });

  test("2. opening again adds nothing twice", async () => {
    const again = await healthrayLinesForDesk(visit.visit, desk, db);
    expect(again.added).toEqual([]);
    const draft = await bills.openDraft(visit.visit, desk, db);
    expect(await liveItems(draft.id)).toEqual([ids.brace, ids.dressing].sort());
  });

  test("3. a line the cashier removed is not put back", async () => {
    const draft = await bills.openDraft(visit.visit, desk, db);
    const brace = draft.lines.find((line) => line.service_item_id === ids.brace);
    await bills.removeLine(draft.id, brace.id, { reason: "Patient declined" }, desk, db);
    const again = await healthrayLinesForDesk(visit.visit, desk, db);
    expect(again.added).toEqual([]);
    expect(await liveItems(draft.id)).toEqual([ids.dressing]);
  });

  test("4. a visit with no HealthRay bill adds nothing and opens no bill", async () => {
    const quiet = await extraVisit(ids, "C25Quiet", { visitType: "Follow Up", healthray: false });
    const result = await healthrayLinesForDesk(quiet.visit, desk, db);
    expect(result).toMatchObject({ ok: true, added: [] });
    const { n } = await one(`SELECT COUNT(*)::int AS n FROM bills WHERE visit_id = $1`, [
      quiet.visit,
    ]);
    expect(n).toBe(0);
  });
});
