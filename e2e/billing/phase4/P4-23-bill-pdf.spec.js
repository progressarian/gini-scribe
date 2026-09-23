import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  discountCode,
  extraVisit,
  newTag,
  payRule,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const takings = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const settings = await import("../../../server/services/billing/billingSettings.js");
const billPdf = await import("../../../server/services/billing/billPdf.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.2", role: USERS.admin.role };
const CARD = "778899001122";
const REFERRAL = "REF20261234";
const GSTIN = "27AAPFU0939F1ZV";
const NASTY = `<script>alert(1)</script> & "quoted" 'single'`;
const ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot; &#39;single&#39;";
const CODE = `P4X${tag.toUpperCase()}`;
let ids;
let settingsWas = null;

const htmlFor = async (billId) => billPdf.buildBillHtml(await billPdf.billView(billId, db));

const LAUNCH_FAILED =
  /Could not find Chrom|Failed to launch|Browser was not found|Cannot find (module|package) 'puppeteer'|ENOENT/i;

async function rendered(print) {
  try {
    return await print();
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0];
    if (!LAUNCH_FAILED.test(String(error?.message ?? error))) throw error;
    test.skip(true, `Chrome could not be launched here, so no PDF was rendered: ${message}`);
    return null;
  }
}

const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = $1`,
    [USERS.reception.id],
  );

const totalOf = (html, label) =>
  new RegExp(`<td>${label}</td><td class="bp-num">([^<]*)</td>`).exec(html)?.[1] ?? null;

const paise = (amount) => Math.round(Number(amount) * 100);

const storedTotals = (billId) =>
  one(
    `SELECT actual_amount, discount_amount, tax_amount, patient_payable, claim_amount,
            round_off, paid_amount FROM bills WHERE id = $1`,
    [billId],
  );

async function finalise(billId) {
  const before = await bills.readBill(billId, db);
  const due = before.totals.payable - before.totals.paid;
  if (due > 0) {
    await takings.takePayments(
      billId,
      { version: before.version, payments: [{ mode: "cash", amount: due / 100 }] },
      desk,
      db,
    );
  }
  const current = await bills.readBill(billId, db);
  return bills.finaliseBill(billId, { version: current.version }, desk, db);
}

async function billOn(visit, items) {
  const id = (await bills.openDraft(visit, desk, db)).id;
  for (const item of items) await bills.addLine(id, { item_id: item }, desk, db);
  return id;
}

test.describe.serial("P4-23 bill PDF", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.paid, {
      name: "paid consults",
      service_item_id: ids.consultDoctorNew,
      visit_types: ["New", "Follow Up"],
      patient_pays: "amount",
      patient_value: 700,
    });
    await payRule(ids, ids.referral, { name: "referral all", patient_pays: "nothing" });
    await payRule(ids, ids.pensioner, { name: "pensioner pays", patient_pays: "full" });
    await discountCode(ids, CODE, {
      kind: "percent",
      value: 12.5,
      service_item_ids: [ids.dressing],
    });
    await query(`UPDATE patient_schemes SET print_category_on_bill = TRUE WHERE code = ANY($1)`, [
      [ids.paid, ids.referral],
    ]);
    await closeOpenShifts();
    await shifts.openShift({ opening_cash: 0 }, desk, db);
    settingsWas = await settings.getSettings(db);
    await settings.updateSettings({ bill_footer: `P4 footer ${tag}` }, admin, db);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await closeOpenShifts();
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(
      () => null,
    );
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

  test("1. a General bill prints its number, patient, items and totals", async () => {
    ids.general = await billOn(ids.visit, [ids.dressing, ids.brace]);
    const bill = await finalise(ids.general);
    expect(bill.status).toBe("final");
    const html = await htmlFor(ids.general);

    expect(html).toContain(bill.bill_no);
    expect(html).toContain(`P4 Patient ${tag}`);
    expect(html).toContain(`F4-${tag}`);
    expect(html).toContain(`Dressing ${tag}`);
    expect(html).toContain(`Ankle brace ${tag}`);
    expect(html).toContain(`P4 footer ${tag}`);
    expect(html).not.toContain("SAC/HSN");
    expect(html).not.toContain("GSTIN");
    expect(html).not.toContain("Category");
    expect(html).not.toContain("DRAFT");
    expect(html).not.toContain("CANCELLED");

    const stored = await storedTotals(ids.general);
    expect(totalOf(html, "Actual amount")).toBe(billPdf.money(paise(stored.actual_amount)));
    expect(totalOf(html, "Discount")).toBe(billPdf.money(paise(stored.discount_amount)));
    expect(totalOf(html, "Patient payable")).toBe(billPdf.money(paise(stored.patient_payable)));
    expect(totalOf(html, "Claimed from payer")).toBe(billPdf.money(paise(stored.claim_amount)));
    expect(totalOf(html, "Paid")).toBe(billPdf.money(paise(stored.paid_amount)));
    expect(totalOf(html, "Round-off")).toBe(billPdf.signedMoney(paise(stored.round_off)));
    expect(totalOf(html, "Balance")).toBe(
      billPdf.signedMoney(paise(stored.patient_payable) - paise(stored.paid_amount)),
    );
    expect(totalOf(html, "Balance")).toBe(billPdf.signedMoney(0));
  });

  test("2. a CGHS Paid bill prints the category and only the last four of the card", async () => {
    const visit = await extraVisit(ids, "Paid");
    ids.paidBill = await billOn(visit.visit, [ids.consultDoctorNew]);
    await bills.setCategory(ids.paidBill, { category: ids.paid, scheme_ref: CARD }, desk, db);
    const bill = await finalise(ids.paidBill);
    expect(bill.totals.payable).toBe(70000);
    expect(bill.totals.claim).toBe(130000);

    const html = await htmlFor(ids.paidBill);
    expect(html).toContain(`P4 CGHS ${tag} › Paid`);
    expect(html).toContain("XXXX1122");
    expect(html).not.toContain(CARD);
    expect(html).not.toContain("7788990011");
    expect(html).toContain(`CGHS ${tag}`);
    expect(html).toContain(billPdf.money(130000));
  });

  test("3. a CGHS Referral bill prints the referral number masked, with nothing to pay", async () => {
    const visit = await extraVisit(ids, "Ref");
    const doc = await one(
      `INSERT INTO documents (patient_id, doc_type, title) VALUES ($1, 'referral', 'Referral')
       RETURNING id`,
      [visit.patient],
    );
    ids.referralBill = await billOn(visit.visit, [ids.consultDoctorNew]);
    await bills.setCategory(
      ids.referralBill,
      {
        category: ids.referral,
        scheme_ref: CARD,
        referral_no: REFERRAL,
        referral_doc_id: doc.id,
      },
      desk,
      db,
    );
    const bill = await finalise(ids.referralBill);
    expect(bill.totals.payable).toBe(0);
    expect(bill.totals.claim).toBe(200000);

    const html = await htmlFor(ids.referralBill);
    expect(html).toContain(`P4 CGHS ${tag} › Referral`);
    expect(html).toContain("XXXX1234");
    expect(html).not.toContain(REFERRAL);
    expect(html).not.toContain(CARD);
    expect(html).toContain(billPdf.money(200000));
  });

  test("4. the category is left off when the category doesn't print on the bill", async () => {
    const visit = await extraVisit(ids, "Pens");
    const id = await billOn(visit.visit, [ids.dressing]);
    await bills.setCategory(id, { category: ids.pensioner, scheme_ref: CARD }, desk, db);
    await finalise(id);
    const html = await htmlFor(id);
    expect(html).not.toContain("Category");
    expect(html).not.toContain("Pensioner");
    expect(html).not.toContain("XXXX1122");

    await query(`UPDATE patient_schemes SET print_category_on_bill = TRUE WHERE code = $1`, [
      ids.pensioner,
    ]);
    const printed = await htmlFor(id);
    expect(printed).toContain(`P4 CGHS ${tag} › Pensioner`);
    expect(printed).toContain("XXXX1122");
    await query(`UPDATE patient_schemes SET print_category_on_bill = FALSE WHERE code = $1`, [
      ids.pensioner,
    ]);

    await query(`UPDATE patient_schemes SET print_category_on_bill = TRUE WHERE code = $1`, [
      ids.parent,
    ]);
    const inherited = await htmlFor(id);
    expect(inherited).toContain(`P4 CGHS ${tag} › Pensioner`);
    expect(inherited).toContain("XXXX1122");
    await query(`UPDATE patient_schemes SET print_category_on_bill = FALSE WHERE code = $1`, [
      ids.parent,
    ]);
    expect(await htmlFor(id)).not.toContain("XXXX1122");
  });

  test("5. tax columns, SAC/HSN and the GSTIN appear only when GST is on", async () => {
    const off = await htmlFor(ids.general);
    expect(off).not.toContain("CGST");
    expect(off).not.toContain("SGST");
    expect(off).not.toContain(GSTIN);

    await settings.updateSettings(
      { gstin: GSTIN, legal_name: `P4 Hospital ${tag}`, gst_enabled: true },
      admin,
      db,
    );
    const on = await htmlFor(ids.general);
    expect(on).toContain("SAC/HSN");
    expect(on).toContain("GST %");
    expect(on).toContain("CGST");
    expect(on).toContain("SGST");
    expect(on).toContain("Tax (CGST + SGST)");
    expect(on).toContain(GSTIN);
    expect(on).toContain(`P4 Hospital ${tag}`);
    const line = await one(
      `SELECT tax_rate_pct FROM bill_lines WHERE bill_id = $1 ORDER BY line_no LIMIT 1`,
      [ids.general],
    );
    expect(on).toContain(billPdf.percentText(line.tax_rate_pct));

    await settings.updateSettings({ gst_enabled: false }, admin, db);
    const back = await htmlFor(ids.general);
    expect(back).not.toContain("SAC/HSN");
    expect(back).not.toContain(GSTIN);
  });

  test("6. every entered name, label and footer is escaped, never markup", async () => {
    const visit = await extraVisit(ids, "Xss");
    await query(`UPDATE patients SET name = $2 WHERE id = $1`, [visit.patient, `P4 ${NASTY}`]);
    const item = await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
       VALUES ($1, $2, $3, 300, 'procedure') RETURNING id`,
      [`P4-XSS-${tag}`, `P4 item ${NASTY}`, ids.subgroup],
    );
    await query(
      `UPDATE patient_schemes SET label = $2, print_category_on_bill = TRUE
                  WHERE code = $1`,
      [ids.pensioner, `P4 label ${NASTY}`],
    );
    await settings.updateSettings({ bill_footer: `P4 footer ${NASTY}` }, admin, db);

    const id = await billOn(visit.visit, [item.id]);
    await bills.setCategory(id, { category: ids.pensioner }, desk, db);
    await finalise(id);

    const html = await htmlFor(id);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)</script>");
    expect(html).toContain(ESCAPED);
    const seen = html.match(new RegExp(ESCAPED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? [];
    expect(seen.length).toBeGreaterThanOrEqual(4);

    await settings.updateSettings({ bill_footer: `P4 footer ${tag}` }, admin, db);
    await query(
      `UPDATE patient_schemes SET label = 'Pensioner', print_category_on_bill = FALSE
                  WHERE code = $1`,
      [ids.pensioner],
    );
  });

  test("7. a draft says it is not a bill, and a cancelled bill says it is cancelled", async () => {
    const visit = await extraVisit(ids, "Draft");
    const draft = await billOn(visit.visit, [ids.brace]);
    const draftHtml = await htmlFor(draft);
    expect(draftHtml).toContain("DRAFT — NOT A BILL");
    expect(draftHtml).toContain("it is not a bill");
    expect(draftHtml).toContain("Not issued yet");
    expect(draftHtml).toContain(`Ankle brace ${tag}`);

    const dead = await extraVisit(ids, "Dead");
    const id = await billOn(dead.visit, [ids.consultDoctorNew]);
    await bills.setCategory(id, { category: ids.referral, referral_no: REFERRAL }, desk, db);
    const doc = await one(
      `INSERT INTO documents (patient_id, doc_type, title) VALUES ($1, 'referral', 'Referral')
       RETURNING id`,
      [dead.patient],
    );
    await bills.setCategory(id, { referral_doc_id: doc.id }, desk, db);
    const final = await finalise(id);
    await bills.cancelBill(id, { reason: `P4 wrong patient ${NASTY}` }, desk, db);
    const html = await htmlFor(id);
    expect(html).toContain("CANCELLED BILL");
    expect(html).toContain(`P4 wrong patient ${ESCAPED}`);
    expect(html).not.toContain("<script>");
    expect(html).toContain(final.bill_no);
  });

  test("8. a bill with a round-off and a claim prints both, matching what is stored", async () => {
    const visit = await extraVisit(ids, "Round");
    const id = await billOn(visit.visit, [ids.consultDoctorNew, ids.dressing]);
    await bills.setCategory(id, { category: ids.paid, scheme_ref: CARD }, desk, db);
    await bills.addCode(id, { code: CODE }, desk, db);
    const ready = await bills.readBill(id, db);
    expect(ready.totals.round_off).not.toBe(0);
    expect(ready.totals.claim).toBeGreaterThan(0);
    await finalise(id);

    const stored = await storedTotals(id);
    const html = await htmlFor(id);
    expect(totalOf(html, "Round-off")).toBe(billPdf.signedMoney(paise(stored.round_off)));
    expect(totalOf(html, "Claimed from payer")).toBe(billPdf.money(paise(stored.claim_amount)));
    expect(totalOf(html, "Patient payable")).toBe(billPdf.money(paise(stored.patient_payable)));
    expect(totalOf(html, "Discount")).toBe(billPdf.money(paise(stored.discount_amount)));
    expect(totalOf(html, "Actual amount")).toBe(billPdf.money(paise(stored.actual_amount)));
    expect(totalOf(html, "Balance")).toBe(
      billPdf.signedMoney(paise(stored.patient_payable) - paise(stored.paid_amount)),
    );
  });

  test("9. the three bills render as real PDFs", async () => {
    for (const billId of [ids.general, ids.paidBill, ids.referralBill]) {
      const printed = await rendered(() => billPdf.generateBillPdf(billId, desk, db));
      expect(Buffer.isBuffer(printed.pdf)).toBe(true);
      expect(printed.pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(printed.pdf.length).toBeGreaterThan(2000);
      expect(printed.filename).toMatch(/^Bill_.+\.pdf$/);
    }
  });
});
