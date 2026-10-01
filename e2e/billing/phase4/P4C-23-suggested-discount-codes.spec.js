import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, discountCode, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
const code = (name) => `${name}${tag}`.toUpperCase();
let ids;

const suggested = async () =>
  (await bills.suggestCodes(ids.bill, desk, db)).codes.filter((entry) =>
    entry.code.endsWith(tag.toUpperCase()),
  );

test.describe.serial("P4C-23 suggested discount codes", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    ids.bill = (await bills.openDraft(ids.visit, desk, db)).id;
    await bills.addLine(ids.bill, { item_id: ids.dressing }, desk, db);
    await bills.addLine(ids.bill, { item_id: ids.brace }, desk, db);

    await discountCode(ids, code("OVER50"), { kind: "percent", value: 20, min_age: 50 });
    await discountCode(ids, code("DRESS"), {
      kind: "percent",
      value: 10,
      service_item_ids: [ids.dressing],
    });
    await discountCode(ids, code("OVER70"), { kind: "percent", value: 50, min_age: 70 });
    await discountCode(ids, code("WOMEN"), { kind: "percent", value: 30, gender: "Female" });
    await discountCode(ids, code("HBA1C"), {
      kind: "percent",
      value: 40,
      service_item_ids: [ids.hba1c],
    });
    ids.staff = `p4c23_${tag}`;
    await query(`INSERT INTO patient_schemes (code, label, parent_code) VALUES ($1, 'Staff', $2)`, [
      ids.staff,
      ids.parent,
    ]);
    await discountCode(ids, code("STAFF"), {
      kind: "percent",
      value: 25,
      scheme_codes: [ids.staff],
    });
    await discountCode(ids, code("OFF"), { kind: "percent", value: 90, is_active: false });
  });

  test.afterAll(async () => tearDown(ids));

  test("1. only codes this patient, category and these services qualify for are suggested, best saving first", async () => {
    const offers = await suggested();
    expect(offers.map((offer) => offer.code)).toEqual([code("OVER50"), code("DRESS")]);
    const [over50, dress] = offers;
    expect(over50.saves).toBe(26000);
    expect(over50.because).toEqual(["Age 50+"]);
    expect(dress.saves).toBe(5000);
    expect(dress.because).toEqual([`On Dressing ${tag}`]);
  });

  test("2. the suggestion matches what applying the code really takes off", async () => {
    const before = await bills.readBill(ids.bill, db);
    const [best] = await suggested();
    const after = await bills.addCode(ids.bill, { code: best.code }, desk, db);
    expect(before.totals.payable - after.totals.payable).toBe(best.saves);
  });

  test("3. a code already on the bill is no longer suggested", async () => {
    const offers = await suggested();
    expect(offers.map((offer) => offer.code)).not.toContain(code("OVER50"));
  });

  test("4. a category code is suggested once the bill takes that category", async () => {
    await bills.setCategory(ids.bill, { category: ids.staff }, desk, db);
    const offers = await suggested();
    expect(offers.map((offer) => offer.code)).toContain(code("STAFF"));
    const staff = offers.find((offer) => offer.code === code("STAFF"));
    expect(staff.because).toEqual([`P4 CGHS ${tag} › Staff`]);
  });
});
