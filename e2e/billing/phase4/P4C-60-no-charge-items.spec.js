import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  extraVisit,
  healthrayBill,
  newTag,
  refused,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const { healthrayLinesForDesk } =
  await import("../../../server/services/billing/healthrayBillLines.js");
const items = await import("../../../server/services/billing/serviceItems.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.60", role: "admin" };
let ids;
let unpriced;
let free;
let visit;

const addItem = (code, name, noCharge) =>
  one(
    `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, no_charge)
     VALUES ($1, $2, $3, 0, 'procedure', $4) RETURNING id`,
    [code, name, ids.subgroup, noCharge],
  ).then((row) => row.id);

const linesOf = async (visitId) =>
  Object.fromEntries(
    (await bills.openDraft(visitId, desk, db)).lines.map((line) => [line.service_item_id, line]),
  );

test.describe.serial("P4C-60 a no-charge item stays at ₹0", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    unpriced = await addItem(`P4-UNPRICED-${tag}`, `Unpriced index ${tag}`, false);
    free = await addItem(`P4-FREE-${tag}`, `Free index ${tag}`, true);
    visit = await extraVisit(ids, "C60", { visitType: "Follow Up" });
    await healthrayBill(ids, visit.patient, [
      { desc: `Unpriced index ${tag}`, amount: 1, category: "procedure" },
      { desc: `Free index ${tag}`, amount: 1, category: "procedure" },
    ]);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. HealthRay's amount is copied onto a ₹0 item, but not onto a no-charge one", async () => {
    const result = await healthrayLinesForDesk(visit.visit, desk, db);
    expect(result.ok).toBe(true);
    const lines = await linesOf(visit.visit);
    expect(lines[unpriced]).toMatchObject({ actual: 100, no_charge: false });
    expect(lines[unpriced].agreed_rate).toBe(100);
    expect(lines[free]).toMatchObject({ actual: 0, patient_payable: 0, no_charge: true });
    expect(lines[free].agreed_rate).toBeNull();
  });

  test("2. the desk can't give a no-charge line a price", async () => {
    const draft = await bills.openDraft(visit.visit, desk, db);
    const line = draft.lines.find((l) => l.service_item_id === free);
    await refused(
      bills.setLinePrice(
        draft.id,
        line.id,
        { agreed_rate: "50", reason: "Trying a price" },
        desk,
        db,
      ),
      400,
      /fixed price/,
      "price on a no-charge line",
    );
  });

  test("3. a no-charge item must be ₹0 and can't be priced per patient", async () => {
    await refused(
      items.updateItem(free, { base_price: "100", reason: "Price it" }, admin, db),
      400,
      /base price of ₹0/,
      "no-charge with a price",
    );
    await refused(
      items.updateItem(free, { price_per_patient: true }, admin, db),
      400,
      /priced per patient/,
      "no-charge priced per patient",
    );
    const saved = await items.updateItem(unpriced, { no_charge: true }, admin, db);
    expect(saved.no_charge).toBe(true);
    const audit = await one(
      `SELECT after->>'no_charge' AS now FROM billing_audit
        WHERE entity = 'service_items' AND entity_id = $1::text ORDER BY id DESC LIMIT 1`,
      [unpriced],
    );
    expect(audit.now).toBe("true");
    await query(`UPDATE service_items SET no_charge = FALSE WHERE id = $1`, [unpriced]);
  });
});
