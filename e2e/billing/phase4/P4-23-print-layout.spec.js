import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";
import { db } from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const settings = await import("../../../server/services/billing/billingSettings.js");
const billPdf = await import("../../../server/services/billing/billPdf.js");
const { renderHtmlToPdf } = await import("../../../server/services/prescriptionHtmlPdf.js");

const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.24", role: USERS.admin.role };
const GSTIN = "27AAPFU0939F1ZV";
const ROWS = 46;
const PRINTABLE_WIDTH = 658;
const LONG = [
  "Continuous Glucose Monitoring Sensor Application and Fourteen-Day Reading Review",
  "Diabetic Foot Examination with Monofilament, Tuning Fork and Biothesiometry",
  "Comprehensive Nutrition Counselling Session for Gestational Diabetes Mellitus",
];
const LAUNCH_FAILED =
  /Could not find Chrom|Failed to launch|Browser was not found|Cannot find (module|package) 'puppeteer'|ENOENT/i;
let ids;
let settingsWas = null;
let longBill;
let wideBill;

const hasPdfTools = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const gstOn = () =>
  settings.updateSettings(
    {
      gstin: GSTIN,
      state_code: "27",
      legal_name: `P4 Hospital ${tag}`,
      gst_enabled: true,
      bill_footer: `P4 footer ${tag}`,
    },
    admin,
    db,
  );

const rowNo = (i) => String(i + 1).padStart(2, "0");

async function item(code, name, price, taxCodeId) {
  return (
    await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, tax_code_id)
       VALUES ($1, $2, $3, $4, 'procedure', $5) RETURNING id`,
      [`P4-${code}-${tag}`, name, ids.subgroup, price, taxCodeId],
    )
  ).id;
}

async function draftOf(label, items, patientName) {
  const visit = await extraVisit(ids, label);
  if (patientName) {
    await query(`UPDATE patients SET name = $2 WHERE id = $1`, [visit.patient, patientName]);
  }
  const id = (await bills.openDraft(visit.visit, desk, db)).id;
  for (const itemId of items) await bills.addLine(id, { item_id: itemId }, desk, db);
  return id;
}

async function pdfPages(billId) {
  return printedPages(async () => (await billPdf.generateBillPdf(billId, desk, db)).pdf);
}

async function printedPages(render) {
  let pdf;
  try {
    pdf = await render();
  } catch (error) {
    if (!LAUNCH_FAILED.test(String(error?.message ?? error))) throw error;
    test.skip(true, "Chrome could not be launched here, so no PDF was rendered");
  }
  test.skip(!hasPdfTools, "pdftotext is not installed, so the pages can't be read back");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-print-"));
  try {
    const file = path.join(dir, "bill.pdf");
    fs.writeFileSync(file, pdf);
    const count = Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [file]).toString())[1]);
    const pages = [];
    for (let page = 1; page <= count; page += 1) {
      pages.push(
        execFileSync("pdftotext", ["-f", String(page), "-l", String(page), file, "-"]).toString(),
      );
    }
    return pages;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const pagesWith = (pages, text) =>
  pages.map((page, index) => (page.includes(text) ? index : -1)).filter((index) => index >= 0);

test.describe.serial("P4-23 the printed bill lays out on paper", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    settingsWas = await settings.getSettings(db);
    await gstOn();
    const tax = await one(
      `INSERT INTO tax_codes (code, sac_hsn, rate_pct) VALUES ($1, '30049099', 18) RETURNING id`,
      [`P4TAXL-${tag}`],
    );
    const many = [];
    for (let i = 0; i < ROWS; i += 1) {
      const words = i % 3 === 2 ? "Service item" : LONG[i % LONG.length];
      many.push(
        await item(
          `L${i}`,
          `P4 Row${rowNo(i)} ${words} Fin${rowNo(i)} ${tag}`,
          100 + i * 37,
          i % 2 ? tax.id : null,
        ),
      );
    }
    longBill = await draftOf(
      "Long",
      many,
      `P4 Sukhwinderjit Kaur Randhawa-Grewal Venkatanarasimharajuvaripeta ${tag}`,
    );
    const wide = [
      await item(
        "W1",
        `P4 ${"Supercalifragilisticexpialidocious".repeat(3)} ${tag}`,
        350000,
        tax.id,
      ),
      await item("W2", `P4 Insulin pump with continuous glucose sensor kit ${tag}`, 125050, tax.id),
      await item("W3", `P4 Dressing ${tag}`, 50000, null),
    ];
    wideBill = await draftOf(
      "Wide",
      wide,
      `P4 ${"Randhawagrewalvenkatanarasimharajuvaripeta".repeat(3)} ${tag}`,
    );
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await query(`DELETE FROM tax_codes WHERE code = $1`, [`P4TAXL-${tag}`]).catch(() => null);
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

  test("1. the wide GST table with lakh amounts and unbroken words stays inside the page", async ({
    page,
  }) => {
    await page.setViewportSize({ width: PRINTABLE_WIDTH, height: 1100 });
    await page.emulateMedia({ media: "print" });
    await gstOn();
    const wide = await billPdf.billView(wideBill, db);
    const wordsOnly = { ...wide, bill: { ...wide.bill, lines: wide.bill.lines.slice(1) } };
    for (const view of [wide, wordsOnly, await billPdf.billView(longBill, db)]) {
      const html = billPdf.buildBillHtml(view);
      expect(html).toContain("SAC/HSN");
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const fit = await page.evaluate(() => {
        const card = document.querySelector(".rx-page");
        const table = document.querySelector("table.bp-lines");
        const section = table.parentElement;
        const inner = section.clientWidth - 44;
        const cells = [
          ...table.querySelectorAll(":scope > thead th, :scope > tbody > tr:not(.bp-closing) > td"),
        ];
        const cardBox = card.getBoundingClientRect();
        const split = [];
        for (const cell of table.querySelectorAll("td.bp-item")) {
          const node = cell.firstChild;
          if (!node) continue;
          for (const match of node.textContent.matchAll(/\S+/g)) {
            if (match[0].length > 16) continue;
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            const tops = new Set([...range.getClientRects()].map((box) => Math.round(box.top)));
            if (tops.size > 1) split.push(match[0]);
          }
        }
        return {
          split,
          card: card.scrollWidth - card.clientWidth,
          table: Math.ceil(table.getBoundingClientRect().width) - inner,
          outside: cells.filter((cell) => cell.getBoundingClientRect().right > cardBox.right + 0.5)
            .length,
          clipped: cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length,
          meta: [...document.querySelectorAll(".bp-value")].filter(
            (value) => value.scrollWidth > value.clientWidth + 1,
          ).length,
        };
      });
      expect(fit.split, "no ordinary word in the item column is broken in the middle").toEqual([]);
      expect(fit.card, "the card does not scroll sideways").toBe(0);
      expect(fit.table, "the table fits inside its section").toBeLessThanOrEqual(0);
      expect(fit.outside, "no cell reaches past the card edge").toBe(0);
      expect(fit.clipped, "no cell clips its own text").toBe(0);
      expect(fit.meta, "no header value clips its own text").toBe(0);
    }
  });

  test("2. a 46-line bill runs onto more pages, repeats the header and never splits a row", async () => {
    for (const gst of [false, true]) {
      await (gst ? gstOn() : settings.updateSettings({ gst_enabled: false }, admin, db));
      expectPagesHold(await pdfPages(longBill));
    }
  });

  function expectPagesHold(pages) {
    expect(pages.length).toBeGreaterThanOrEqual(2);
    pages.forEach((text, index) => {
      expect(text, `page ${index + 1} has the table header`).toContain("Patient pays");
      expect(text, `page ${index + 1} is numbered`).toContain(
        `Page ${index + 1} of ${pages.length}`,
      );
    });
    expect(pagesWith(pages, "DRAFT — NOT A BILL")).toEqual([0]);
    expect(pagesWith(pages, "Venkatanarasimharajuvaripeta")).toEqual([0]);
    for (let i = 0; i < ROWS; i += 1) {
      const start = pagesWith(pages, `Row${rowNo(i)}`);
      const end = pagesWith(pages, `Fin${rowNo(i)}`);
      expect(start, `row ${i + 1} is printed once`).toHaveLength(1);
      expect(end, `row ${i + 1} is not split across a page break`).toEqual(start);
    }
  }

  test("3. the totals stay together, beside the last rows, with the footer after them", async () => {
    await gstOn();
    const pages = await pdfPages(longBill);
    const last = pages.length - 1;
    for (const label of ["Actual amount", "Tax (CGST + SGST)", "Patient payable", "Balance"]) {
      expect(pagesWith(pages, label), label).toEqual([last]);
    }
    expect(pages[last]).toContain(`Row${rowNo(ROWS - 1)}`);
    expect(pagesWith(pages, `P4 footer ${tag}`)).toEqual([last]);
  });

  test("4. at every length the totals and footer print on the page of the last row", async () => {
    test.setTimeout(600000);
    await gstOn();
    const view = await billPdf.billView(longBill, db);
    const misplaced = [];
    for (let count = 1; count <= ROWS; count += 1) {
      const html = billPdf.buildBillHtml({
        ...view,
        bill: { ...view.bill, lines: view.bill.lines.slice(0, count) },
      });
      const pages = await printedPages(() => renderHtmlToPdf(html));
      const last = pagesWith(pages, `Fin${rowNo(count - 1)}`);
      expect(last, `${count} lines: the last row is printed once`).toHaveLength(1);
      for (const label of ["Actual amount", "Balance", `P4 footer ${tag}`]) {
        if (pagesWith(pages, label).join() !== last.join()) {
          misplaced.push(`${count} lines: ${label}`);
        }
      }
    }
    expect(misplaced, "the closing block never leaves the last row's page").toEqual([]);
  });
});
