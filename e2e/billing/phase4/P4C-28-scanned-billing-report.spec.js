import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
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
const bills = await import("../../../server/services/billing/bills.js");
const { scannedBillSuggestion } =
  await import("../../../server/services/billing/scannedBillReports.js");

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;
let visit;
let other;
const patients = [];

const draftOf = (visitId) => bills.openDraft(visitId, desk, db);

async function storedScan(target, items, extra = {}) {
  const { id } = await one(
    `INSERT INTO documents (patient_id, doc_type, title, file_name, storage_path, mime_type,
                            doc_date, source, extracted_data)
     VALUES ($1, 'billing_report', 'Billing report', $2, $3, 'application/pdf', CURRENT_DATE,
             'billing_counter', $4)
     RETURNING id`,
    [
      target.patient,
      `scan-${tag}.pdf`,
      `billing/reports/${target.patient}/scan-${tag}.pdf`,
      JSON.stringify({ visit_id: target.visit, items, warning: null, ...extra }),
    ],
  );
  return id;
}

async function call(method, url, options) {
  const api = await apiAs("reception");
  const response = await api[method](url, options);
  const text = await response.text();
  await api.dispose();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status(), body };
}

test.describe.serial("P4C-28 scanning a billing report onto the bill", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    visit = await extraVisit(ids, "C28", { visitType: "Follow Up" });
    other = await extraVisit(ids, "C28Other", { visitType: "Follow Up" });
    patients.push(visit.patient, other.patient);
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM documents WHERE doc_type = 'billing_report' AND patient_id = ANY($1)`,
      [patients],
    );
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
  });

  test("1. a scanned report suggests its matched items, skips the consultation, and lists unknown names", async () => {
    await storedScan(visit, [
      { desc: `Dressing ${tag}`, amount: 650, unit: 1, rate: 650, category: "procedure" },
      { desc: `Ankle brace ${tag}`, amount: 900, unit: 1, rate: 900, category: "procedure" },
      {
        desc: "Follow-up Appointment",
        amount: 1000,
        unit: 1,
        rate: 1000,
        category: "consultation",
      },
      { desc: `Unknown gadget ${tag}`, amount: 300, unit: 1, rate: 300, category: "other" },
    ]);
    const draft = await draftOf(visit.visit);
    const card = await scannedBillSuggestion(draft.id, desk, db);
    expect(card.shown).toBe(true);
    expect(card.reports).toHaveLength(1);
    expect(card.lines.map((line) => line.item_id).sort()).toEqual([ids.brace, ids.dressing].sort());
    expect(card.lines.find((line) => line.item_id === ids.dressing).amount).toBe(65000);
    expect(card.not_matched).toEqual([{ desc: `Unknown gadget ${tag}`, amount: 30000 }]);
  });

  test("2. an item added to the bill drops off the suggestions", async () => {
    const draft = await draftOf(visit.visit);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const card = await scannedBillSuggestion(draft.id, desk, db);
    expect(card.lines.map((line) => line.item_id)).toEqual([ids.brace]);
  });

  test("3. a report scanned for another visit is not suggested here", async () => {
    const draft = await draftOf(other.visit);
    const card = await scannedBillSuggestion(draft.id, desk, db);
    expect(card.shown).toBe(false);
    expect(card.lines).toEqual([]);
  });

  test("4. the desk API lists the suggestions and refuses a file that is not a PDF or photo", async () => {
    const draft = await draftOf(visit.visit);
    const listed = await call("get", "/api/billing/scanned-bill-lines", {
      params: { bill_id: draft.id },
    });
    expect(listed.status).toBe(200);
    expect(listed.body.lines.map((line) => line.item_id)).toEqual([ids.brace]);

    const wrong = await call("post", `/api/billing/bills/${draft.id}/scanned-reports`, {
      data: { base64: "aGVsbG8=", mediaType: "text/plain", fileName: "notes.txt" },
    });
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(wrong.body)).toContain("PDF or a photo");
  });

  test("5. without file storage the scan fails safely and nothing is stored", async () => {
    const draft = await draftOf(other.visit);
    const before = await one(
      `SELECT COUNT(*)::int AS n FROM documents WHERE doc_type = 'billing_report' AND patient_id = $1`,
      [other.patient],
    );
    const scan = await call("post", `/api/billing/bills/${draft.id}/scanned-reports`, {
      data: { base64: "JVBERi0xLjQK", mediaType: "application/pdf", fileName: "bill.pdf" },
    });
    expect(scan.status).toBe(500);
    expect(scan.body.error).toMatch(/^Something went wrong/);
    const after = await one(
      `SELECT COUNT(*)::int AS n FROM documents WHERE doc_type = 'billing_report' AND patient_id = $1`,
      [other.patient],
    );
    expect(after.n).toBe(before.n);
  });

  test("6. the report file endpoint serves billing reports only", async () => {
    const { id } = await one(
      `INSERT INTO documents (patient_id, doc_type, title, source)
       VALUES ($1, 'lab_report', 'Not a bill', 'upload') RETURNING id`,
      [visit.patient],
    );
    try {
      const refused = await call("get", `/api/billing/scanned-reports/${id}/file`);
      expect(refused.status).toBe(404);
    } finally {
      await query(`DELETE FROM documents WHERE id = $1`, [id]);
    }
  });

  test("7. the counter shows the upload button and adds a scanned item", async ({ page }) => {
    await loginAs(page, "reception");
    const card = page.getByRole("region", { name: "Scanned billing reports" });
    await gotoReady(page, `/giniflow/station/reception?tab=bill&visit=${visit.visit}`, () => card);
    await expect(card.getByRole("button", { name: "Upload billing report" })).toBeVisible();
    await expect(card.getByText(`Ankle brace ${tag}`)).toBeVisible();
    await card.getByRole("button", { name: /^Add / }).first().click();
    await expect(card.getByText(`Ankle brace ${tag}`)).toHaveCount(0);
    await expect(card.getByText(`Unknown gadget ${tag}`)).toBeVisible();
    await expect(card.getByText(/not in billing/)).toBeVisible();
  });

  test("8. deleting a scanned report removes it, audits it, and keeps lines already on the bill", async () => {
    const id = await storedScan(other, [
      { desc: `Dressing ${tag}`, amount: 650, unit: 1, rate: 650, category: "procedure" },
    ]);
    const draft = await draftOf(other.visit);
    expect((await scannedBillSuggestion(draft.id, desk, db)).lines).toHaveLength(1);
    const removed = await call("delete", `/api/billing/scanned-reports/${id}`);
    expect(removed.status).toBe(200);
    expect(await one(`SELECT id FROM documents WHERE id = $1`, [id])).toBeNull();
    const audit = await one(
      `SELECT action, before, actor_id FROM billing_audit
        WHERE entity = 'documents' AND entity_id = $1`,
      [String(id)],
    );
    expect(audit).toMatchObject({ action: "delete" });
    expect(audit.before.items).toHaveLength(1);
    expect((await scannedBillSuggestion(draft.id, desk, db)).shown).toBe(false);
    const again = await call("delete", `/api/billing/scanned-reports/${id}`);
    expect(again.status).toBe(404);
  });

  test("9. the counter asks before deleting a report, then it is gone", async ({ page }) => {
    await loginAs(page, "reception");
    const card = page.getByRole("region", { name: "Scanned billing reports" });
    await gotoReady(page, `/giniflow/station/reception?tab=bill&visit=${visit.visit}`, () => card);
    await card.getByRole("button", { name: `Delete scan-${tag}.pdf` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Anything already added to this bill stays on it.");
    await dialog.getByRole("button", { name: "Delete report" }).click();
    await expect(card.getByText(`scan-${tag}.pdf was deleted.`)).toBeVisible();
    await expect(card.getByRole("button", { name: `Delete scan-${tag}.pdf` })).toHaveCount(0);
  });
});
