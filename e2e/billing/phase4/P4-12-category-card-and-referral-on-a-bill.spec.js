import { spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { assertTestDatabase, TEST_DATABASE_URL } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { desk, newTag, payRule, refused, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
const CARD = "778899001122";
const REFERRAL = "REF20261234";
let ids;

test.describe.serial("P4-12 category, card and referral on a bill", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.paid, {
      name: "paid consults",
      service_item_id: ids.consultDoctorNew,
      visit_types: ["New", "Follow Up"],
      patient_pays: "amount",
      patient_value: 700,
    });
    await payRule(ids, ids.referral, {
      name: "referral consults",
      service_item_id: ids.consultDoctorNew,
      patient_pays: "nothing",
    });
    ids.bill = (await bills.openDraft(ids.visit, desk, db)).id;
    await bills.addLine(ids.bill, { item_id: ids.consultDoctorNew }, desk, db);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. choosing a sub-category reprices the bill", async () => {
    const before = await bills.readBill(ids.bill, db);
    expect(before.totals.payable).toBe(200000);
    const bill = await bills.setCategory(ids.bill, { category: ids.paid }, desk, db);
    expect(bill.category).toBe(ids.paid);
    expect(bill.category_label).toBe(`P4 CGHS ${tag} › Paid`);
    expect(bill.payer_name).toBe(`CGHS ${tag}`);
    expect(bill.totals.payable).toBe(70000);
    expect(bill.totals.claim).toBe(130000);
  });

  test("2. a bill can't be made under the bare parent once it has sub-categories", async () => {
    const refusal = await refused(
      bills.setCategory(ids.bill, { category: ids.parent }, desk, db),
      409,
      /has sub-categories/,
      "the bare parent category",
    );
    expect(refusal.needs_sub_category).toBe(true);
    expect(refusal.suggestions.map((s) => s.category.code).sort()).toEqual(
      [ids.paid, ids.pensioner, ids.referral].sort(),
    );
    expect((await bills.readBill(ids.bill, db)).category).toBe(ids.paid);
  });

  test("3. a retired or unknown category is refused", async () => {
    await query(`UPDATE patient_schemes SET is_active = FALSE WHERE code = $1`, [ids.pensioner]);
    await refused(
      bills.setCategory(ids.bill, { category: ids.pensioner }, desk, db),
      409,
      /retired/,
      "a retired category",
    );
    await query(`UPDATE patient_schemes SET is_active = TRUE WHERE code = $1`, [ids.pensioner]);
    await refused(
      bills.setCategory(ids.bill, { category: "p4-nothing-here" }, desk, db),
      404,
      /doesn't exist/,
      "an unknown category",
    );
    expect((await bills.readBill(ids.bill, db)).category).toBe(ids.paid);
  });

  test("4. the card and referral numbers are stored encrypted and returned masked", async () => {
    const bill = await bills.setCategory(
      ids.bill,
      { category: ids.referral, scheme_ref: CARD, referral_no: REFERRAL },
      desk,
      db,
    );
    expect(bill.scheme_ref).toBe("XXXX1122");
    expect(bill.referral_no).toBe("XXXX1234");
    expect(JSON.stringify(bill)).not.toContain(CARD);
    const stored = await one(`SELECT scheme_ref_enc, referral_no_enc FROM bills WHERE id = $1`, [
      ids.bill,
    ]);
    expect(stored.scheme_ref_enc).not.toBe(CARD);
    expect(stored.referral_no_enc).not.toBe(REFERRAL);
    expect(stored.scheme_ref_enc.split(":")).toHaveLength(3);
    expect(stored.referral_no_enc.split(":")).toHaveLength(3);
    expect(bill.totals.payable).toBe(0);
    expect(bill.totals.claim).toBe(200000);
  });

  test("5. the referral scan is a document of this patient's", async () => {
    const other = await one(
      `INSERT INTO patients (name, file_no, age) VALUES ($1, $2, 30) RETURNING id`,
      [`P4 Other ${tag}`, `F4O-${tag}`],
    );
    const theirs = await one(
      `INSERT INTO documents (patient_id, doc_type, title) VALUES ($1, 'referral', 'Theirs')
       RETURNING id`,
      [other.id],
    );
    await refused(
      bills.setCategory(ids.bill, { referral_doc_id: theirs.id }, desk, db),
      409,
      /another patient/,
      "another patient's scan",
    );
    await refused(
      bills.setCategory(ids.bill, { referral_doc_id: 987654321 }, desk, db),
      404,
      /doesn't exist/,
      "a scan that isn't there",
    );
    const mine = await one(
      `INSERT INTO documents (patient_id, doc_type, title) VALUES ($1, 'referral', 'Referral')
       RETURNING id`,
      [ids.patient],
    );
    const bill = await bills.setCategory(ids.bill, { referral_doc_id: mine.id }, desk, db);
    expect(bill.referral_doc_id).toBe(mine.id);
    await query(`DELETE FROM documents WHERE id = $1`, [theirs.id]);
    await query(`DELETE FROM patients WHERE id = $1`, [other.id]);
  });

  test("6. with no encryption key the card number is refused, not stored in the clear", async () => {
    const script = `
      const { assertTestDatabase } = await import(${JSON.stringify(`${repoRoot}/e2e/setup/guard.mjs`)});
      assertTestDatabase(process.env.DATABASE_URL);
      const bills = await import(${JSON.stringify(`${repoRoot}/server/services/billing/bills.js`)});
      const pool = (await import(${JSON.stringify(`${repoRoot}/server/config/db.js`)})).default;
      const out = await bills
        .setCategory(${JSON.stringify(ids.bill)}, { scheme_ref: ${JSON.stringify(CARD)} },
          ${JSON.stringify(desk)})
        .then(() => ({ allowed: true }))
        .catch((error) => ({ status: error.status, message: error.message }));
      console.log("RESULT " + JSON.stringify(out));
      await pool.end();
    `;
    const { AADHAAR_ENCRYPTION_KEY: _key, ...env } = process.env;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...env, DATABASE_URL: TEST_DATABASE_URL },
      encoding: "utf8",
    });
    const result = JSON.parse(run.stdout.split("RESULT ")[1] ?? "{}");
    expect(result.status).toBe(409);
    expect(result.message).toMatch(/encryption key/);
    const stored = await one(`SELECT scheme_ref_enc FROM bills WHERE id = $1`, [ids.bill]);
    expect(stored.scheme_ref_enc).not.toBe(CARD);
    expect(stored.scheme_ref_enc.split(":")).toHaveLength(3);
  });

  test("7. the change is audited and nothing is changed on a final bill", async () => {
    const { rows } = await query(
      `SELECT action FROM billing_audit WHERE entity = 'bills' AND entity_id = $1 ORDER BY id`,
      [ids.bill],
    );
    expect(rows.filter((r) => r.action === "update").length).toBeGreaterThan(0);
    await query(
      `UPDATE bills SET status = 'final', bill_no = $2, series = 'MAIN', fy = $3,
              finalised_at = NOW() WHERE id = $1`,
      [ids.bill, `P4/${tag}/000012`, ids.fy],
    );
    await refused(
      bills.setCategory(ids.bill, { category: ids.paid }, desk, db),
      409,
      /already final/,
      "the category on a final bill",
    );
  });
});
