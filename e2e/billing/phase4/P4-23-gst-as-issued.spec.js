import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";
import {
  db,
  draftWith,
  dropShifts,
  finalBill,
  inCash,
  openDeskShift,
  payOn,
  prepareCategory,
  refundApproved,
} from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const settings = await import("../../../server/services/billing/billingSettings.js");
const billPdf = await import("../../../server/services/billing/billPdf.js");
const creditNotes = await import("../../../server/services/billing/creditNotes.js");

const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.23", role: USERS.admin.role };
const OLD_GSTIN = "27AAPFU0939F1ZV";
const NEW_GSTIN = `03AAPFU0939F1Z${settings.gstinCheckCharacter("03AAPFU0939F1Z")}`;
const OLD_NAME = `P4 Old Hospital ${tag}`;
const NEW_NAME = `P4 New Hospital ${tag}`;
const MIGRATION = path.join(repoRoot, "server/migrations/2026-10-23_billing_bill_gst_snapshot.sql");
let ids;
let settingsWas = null;

const htmlFor = async (billId) => billPdf.buildBillHtml(await billPdf.billView(billId, db));

const snapshotOf = (billId) =>
  one(`SELECT issued_gst, issued_gstin, issued_legal_name FROM bills WHERE id = $1`, [billId]);

const gstOn = (gstin, legal_name) =>
  settings.updateSettings(
    { gstin, state_code: gstin.slice(0, 2), legal_name, gst_enabled: true },
    admin,
    db,
  );

const gstOff = () => settings.updateSettings({ gst_enabled: false }, admin, db);

function expectTaxBlock(html, { gstin, name }) {
  expect(html).toContain("SAC/HSN");
  expect(html).toContain("CGST");
  expect(html).toContain("Tax (CGST + SGST)");
  expect(html).toContain(gstin);
  expect(html).toContain(name);
}

function expectNoTaxBlock(html) {
  expect(html).not.toContain("SAC/HSN");
  expect(html).not.toContain("CGST");
  expect(html).not.toContain("GSTIN");
  expect(html).not.toContain("Billed by");
}

async function taxedItem(code, rate) {
  const tax = await one(
    `INSERT INTO tax_codes (code, sac_hsn, rate_pct) VALUES ($1, '999312', $2) RETURNING id`,
    [`P4TAX${code}-${tag}`, rate],
  );
  return (
    await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, tax_code_id)
       VALUES ($1, $2, $3, 1000, 'procedure', $4) RETURNING id`,
      [`P4-${code}-${tag}`, `P4 ${code} ${tag}`, ids.subgroup, tax.id],
    )
  ).id;
}

test.describe.serial("P4-23 GST prints as the bill was issued", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    settingsWas = await settings.getSettings(db);
    await gstOn(OLD_GSTIN, OLD_NAME);
    await gstOff();
    ids.taxed = await taxedItem("TX", 18);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
    await query(`DELETE FROM tax_codes WHERE code LIKE $1`, [`P4TAX%-${tag}`]).catch(() => null);
    if (settingsWas) {
      await query(
        `UPDATE billing_settings SET gst_enabled = $1, gstin = $2, state_code = $3,
                legal_name = $4, bill_footer = $5`,
        [
          settingsWas.gst_enabled,
          settingsWas.gstin,
          settingsWas.state_code,
          settingsWas.legal_name,
          settingsWas.bill_footer,
        ],
      );
    }
  });

  test("1. a draft carries no snapshot, and a bill finalised with GST off records that", async () => {
    const { bill } = await finalBill(ids, "Before", [{ item: ids.dressing }, { item: ids.brace }], {
      pay: inCash,
    });
    ids.before = bill.id;
    expect(await snapshotOf(bill.id)).toEqual({
      issued_gst: false,
      issued_gstin: null,
      issued_legal_name: null,
    });
    const { visit } = await extraVisit(ids, "Draft");
    ids.draft = (await bills.openDraft(visit, desk, db)).id;
    await bills.addLine(ids.draft, { item_id: ids.dressing }, desk, db);
    expect(await snapshotOf(ids.draft)).toEqual({
      issued_gst: null,
      issued_gstin: null,
      issued_legal_name: null,
    });
  });

  test("2. a bill finalised before GST registration prints no tax block after GST is switched on", async () => {
    await gstOn(OLD_GSTIN, OLD_NAME);
    expectNoTaxBlock(await htmlFor(ids.before));
    expectTaxBlock(await htmlFor(ids.draft), { gstin: OLD_GSTIN, name: OLD_NAME });
    const printed = await billPdf.generateBillPdf(ids.before, desk, db).catch((error) => {
      if (/Could not find Chrom|Failed to launch|Browser was not found/i.test(error.message)) {
        return null;
      }
      throw error;
    });
    if (printed) expect(printed.pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("3. a bill finalised with GST on keeps its tax block, GSTIN and name after GST is switched off", async () => {
    await gstOn(OLD_GSTIN, OLD_NAME);
    const taxed = await finalBill(ids, "Taxed", [{ item: ids.taxed }], { pay: inCash });
    ids.taxedBill = taxed.bill.id;
    expect(taxed.bill.totals.tax).toBe(18000);
    const untaxed = await finalBill(ids, "Exempt", [{ item: ids.dressing }], { pay: inCash });
    ids.exempt = untaxed.bill.id;
    expect(untaxed.bill.totals.tax).toBe(0);
    for (const id of [ids.taxedBill, ids.exempt]) {
      expect(await snapshotOf(id)).toEqual({
        issued_gst: true,
        issued_gstin: OLD_GSTIN,
        issued_legal_name: OLD_NAME,
      });
    }

    await gstOff();
    expectTaxBlock(await htmlFor(ids.taxedBill), { gstin: OLD_GSTIN, name: OLD_NAME });
    expectTaxBlock(await htmlFor(ids.exempt), { gstin: OLD_GSTIN, name: OLD_NAME });
    expectNoTaxBlock(await htmlFor(ids.before));
    expectNoTaxBlock(await htmlFor(ids.draft));
  });

  test("4. a GSTIN and legal name changed later never reach a bill already issued", async () => {
    await gstOn(NEW_GSTIN, NEW_NAME);
    for (const id of [ids.taxedBill, ids.exempt]) {
      const html = await htmlFor(id);
      expectTaxBlock(html, { gstin: OLD_GSTIN, name: OLD_NAME });
      expect(html).not.toContain(NEW_GSTIN);
      expect(html).not.toContain(NEW_NAME);
    }
    const fresh = await finalBill(ids, "After", [{ item: ids.taxed }], { pay: inCash });
    ids.after = fresh.bill.id;
    const html = await htmlFor(ids.after);
    expectTaxBlock(html, { gstin: NEW_GSTIN, name: NEW_NAME });
    expect(html).not.toContain(OLD_GSTIN);
    expectNoTaxBlock(await htmlFor(ids.before));
  });

  test("5. a credit note takes the snapshot of the bill it credits, not today's settings", async () => {
    const approved = await refundApproved(ids.taxedBill, "whole");
    const note = approved.credit_note;
    expect(note.bill_type).toBe("credit_note");
    expect(await snapshotOf(note.id)).toEqual({
      issued_gst: true,
      issued_gstin: OLD_GSTIN,
      issued_legal_name: OLD_NAME,
    });
    const html = await htmlFor(note.id);
    expect(html).toContain(OLD_GSTIN);
    expect(html).not.toContain(NEW_GSTIN);

    await gstOff();
    const plain = await finalBill(ids, "Plain", [{ item: ids.brace }], { pay: inCash });
    await gstOn(NEW_GSTIN, NEW_NAME);
    const plainNote = (await refundApproved(plain.bill.id, "whole")).credit_note;
    expect(await snapshotOf(plainNote.id)).toEqual({
      issued_gst: false,
      issued_gstin: null,
      issued_legal_name: null,
    });
    expectNoTaxBlock(await htmlFor(plainNote.id));
  });

  test("6. a bill with no snapshot falls back to today's rule, and the migration fills it from the settings history", async () => {
    await query(
      `UPDATE bills SET issued_gst = NULL, issued_gstin = NULL, issued_legal_name = NULL
        WHERE id = ANY($1)`,
      [[ids.before, ids.exempt, ids.taxedBill]],
    );
    expectTaxBlock(await htmlFor(ids.before), { gstin: NEW_GSTIN, name: NEW_NAME });
    expectTaxBlock(await htmlFor(ids.exempt), { gstin: NEW_GSTIN, name: NEW_NAME });

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(fs.readFileSync(MIGRATION, "utf8"));
      const { rows } = await client.query(
        `SELECT id, issued_gst, issued_gstin, issued_legal_name FROM bills WHERE id = ANY($1)`,
        [[ids.before, ids.exempt, ids.taxedBill]],
      );
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(byId[ids.before]).toMatchObject({ issued_gst: false, issued_gstin: null });
      for (const id of [ids.exempt, ids.taxedBill]) {
        expect(byId[id]).toMatchObject({
          issued_gst: true,
          issued_gstin: OLD_GSTIN,
          issued_legal_name: OLD_NAME,
        });
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await query(`UPDATE bills SET issued_gst = FALSE WHERE id = $1`, [ids.before]);
    await query(
      `UPDATE bills SET issued_gst = TRUE, issued_gstin = $2, issued_legal_name = $3
        WHERE id = ANY($1)`,
      [[ids.exempt, ids.taxedBill], OLD_GSTIN, OLD_NAME],
    );
    expectNoTaxBlock(await htmlFor(ids.before));
    expectTaxBlock(await htmlFor(ids.exempt), { gstin: OLD_GSTIN, name: OLD_NAME });
  });

  test("7. the database refuses a snapshot on a draft, and a GSTIN without GST", async () => {
    const onDraft = await query(`UPDATE bills SET issued_gst = TRUE WHERE id = $1`, [ids.draft])
      .then(() => null)
      .catch((error) => error);
    expect(onDraft?.constraint).toBe("bills_issued_gst_draft_check");
    const stray = await query(`UPDATE bills SET issued_gstin = $2 WHERE id = $1`, [
      ids.before,
      OLD_GSTIN,
    ])
      .then(() => null)
      .catch((error) => error);
    expect(stray?.constraint).toBe("bills_issued_gst_details_check");
  });

  test("8. code deployed before the migration still finalises, prints and credits a bill", async () => {
    const { bill: draft } = await draftWith(ids, "Early", [{ item: ids.brace }]);
    const paid = await payOn(draft.id, inCash(draft));
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(
        `ALTER TABLE bills DROP COLUMN issued_gst CASCADE, DROP COLUMN issued_gstin CASCADE,
                           DROP COLUMN issued_legal_name CASCADE`,
      );
      const bill = await bills.finaliseBill(draft.id, { version: paid.version }, desk, client);
      expect(bill.status).toBe("final");
      const view = await billPdf.billView(bill.id, client);
      expect(view.issued).toBeNull();
      expect(billPdf.buildBillHtml(view)).toContain(bill.bill_no);
      const note = await creditNotes.creditNoteIn(
        client,
        { billId: bill.id, lines: [{ line_id: bill.lines[0].id, quantity: 1 }] },
        desk,
      );
      expect(note.credit_note_no).toMatch(/^C/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(
      await one(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'bills' AND column_name LIKE 'issued\\_%'`,
      ),
    ).toEqual({ n: 3 });
  });
});
