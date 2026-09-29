import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
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
const visitLines = await import("../../../server/services/billing/visitLines.js");
const bills = await import("../../../server/services/billing/bills.js");
const removal = await import("../../../server/services/doctorRemoval.js");

const db = getPool();
const tag = newTag();
const GONE = `Dr P4C12 Gone ${tag}`;
const admin = { actorId: USERS.admin.id, ip: "10.9.12.2", role: "admin" };
const ours = {};
let ids;
let autoBefore;

const consultationName = () => `Consultation Dr New ${tag}`;

const liveLines = (visitId) =>
  query(
    `SELECT l.service_item_id, l.bill_name, l.source, b.status
       FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      WHERE l.visit_id = $1 AND l.is_live
      ORDER BY l.created_at, l.line_no`,
    [visitId],
  ).then((r) => r.rows);

const setting = async () =>
  (await one(`SELECT auto_add_consultation FROM billing_settings`)).auto_add_consultation;

const openCounter = (page, visitId) =>
  gotoReady(page, `/giniflow/station/billing?visit=${visitId}`, () =>
    page.getByRole("region", { name: "Add items" }),
  );

const results = (page) =>
  page
    .getByRole("region", { name: "Add items" })
    .getByRole("list", { name: "Item search results" });

async function dropDoctor() {
  if (!ours.gone) return;
  await query(`DELETE FROM auth_sessions WHERE doctor_id = $1`, [ours.gone]);
  await query(`DELETE FROM refresh_tokens WHERE doctor_id = $1`, [ours.gone]);
  await query(`DELETE FROM audit_log WHERE doctor_id = $1`, [ours.gone]);
  await query(`DELETE FROM audit_log WHERE entity_type = 'doctor' AND entity_id = $1`, [
    String(ours.gone),
  ]);
  await query(`DELETE FROM appointments WHERE doctor_id = $1`, [ours.gone]);
  await query(`DELETE FROM doctors WHERE id = $1`, [ours.gone]);
}

test.describe.serial("P4C-12 the consultation is not added automatically", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    const { pin } = await one(`SELECT pin FROM doctors WHERE id = $1`, [USERS.reception.id]);
    ours.gone = (
      await one(
        `INSERT INTO doctors (name, short_name, role, pin, is_active)
         VALUES ($1, $1, 'consultant', $2, TRUE) RETURNING id`,
        [GONE, pin],
      )
    ).id;
    ours.goneVisit = await extraVisit(ids, "C12Gone", { doctorId: ours.gone });
    await removal.removeDoctor(ours.gone, { reason: "Left" }, admin, db);
  });

  test.afterAll(async () => {
    try {
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
      await tearDown(ids);
    } finally {
      await dropDoctor();
    }
  });

  test("1. the setting is off unless an admin turns it on", async () => {
    const column = await one(
      `SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_name = 'billing_settings' AND column_name = 'auto_add_consultation'`,
    );
    expect(column).toEqual({ column_default: "false", is_nullable: "NO" });
  });

  test("2. off: check-in opens a draft with no consultation line", async () => {
    const result = await visitLines.draftAtCheckIn(ids.visit, desk, db);
    expect(result.ok).toBe(true);
    expect(result.consultation).toBeNull();
    expect(result.added).toEqual([]);
    const draft = await one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft'`, [
      ids.visit,
    ]);
    expect(draft?.id).toBe(result.bill_id);
    expect(await liveLines(ids.visit)).toEqual([]);
  });

  test("3. off: opening the visit at the counter adds none either", async ({ page }) => {
    await loginAs(page, "reception");
    await openCounter(page, ids.visit);
    await expect(page.getByRole("region", { name: "Bill lines" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Bill lines" })).not.toContainText(
      consultationName(),
    );
    const extra = await extraVisit(ids, "C12Desk");
    await visitLines.consultationForDesk(extra.visit, desk, db);
    const draft = await bills.openDraft(extra.visit, desk, db);
    expect(draft.lines).toEqual([]);
    expect(await liveLines(ids.visit)).toEqual([]);
  });

  test("4. off: the desk adds the consultation from Add items", async ({ page }) => {
    await loginAs(page, "reception");
    await openCounter(page, ids.visit);
    await page.getByLabel("Search items").fill(consultationName());
    const row = results(page).getByRole("listitem").filter({ hasText: consultationName() });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("table", { name: "Bill lines" })).toContainText(consultationName());
    const lines = await liveLines(ids.visit);
    expect(lines.map((line) => [line.service_item_id, line.bill_name])).toEqual([
      [ids.consultDoctorNew, consultationName()],
    ]);
  });

  test("5. off: a second consultation goes to bill-again", async ({ page }) => {
    await loginAs(page, "reception");
    await openCounter(page, ids.visit);
    await page.getByLabel("Search items").fill(consultationName());
    const row = results(page).getByRole("listitem").filter({ hasText: consultationName() });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Ask admin to bill again" })).toBeVisible();
    const draft = await one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft'`, [
      ids.visit,
    ]);
    const refused = await bills
      .addLine(draft.id, { item_id: ids.consultDoctorNew }, desk, db)
      .then(() => null)
      .catch((error) => error);
    expect(refused?.status).toBe(409);
    expect(await liveLines(ids.visit)).toHaveLength(1);
  });

  test("6. off: a removed doctor's visit shows no 'no consultation fee' note", async ({ page }) => {
    const draft = await bills.openDraft(ours.goneVisit.visit, desk, db);
    expect(draft.removed_doctor).toBeNull();
    await loginAs(page, "reception");
    await openCounter(page, ours.goneVisit.visit);
    await expect(page.getByText(`${GONE} was removed`)).toHaveCount(0);
  });

  test("7. on: check-in and the counter add the doctor's consultation, once", async () => {
    await autoConsultation(true);
    try {
      const checkedIn = await extraVisit(ids, "C12On");
      const result = await visitLines.draftAtCheckIn(checkedIn.visit, desk, db);
      expect(result.added).toEqual([consultationName()]);
      await visitLines.draftAtCheckIn(checkedIn.visit, desk, db);
      expect((await liveLines(checkedIn.visit)).map((line) => line.bill_name)).toEqual([
        consultationName(),
      ]);

      const atDesk = await extraVisit(ids, "C12OnDesk");
      await visitLines.consultationForDesk(atDesk.visit, desk, db);
      const draft = await bills.openDraft(atDesk.visit, desk, db);
      expect(draft.lines.map((line) => line.bill_name)).toEqual([consultationName()]);
      await visitLines.consultationForDesk(atDesk.visit, desk, db);
      expect(await liveLines(atDesk.visit)).toHaveLength(1);

      const gone = await bills.openDraft(ours.goneVisit.visit, desk, db);
      expect(gone.removed_doctor?.name).toBe(GONE);
    } finally {
      await autoConsultation(false);
    }
  });

  test("8. the settings checkbox saves, and only an admin can change it", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/billing", () =>
      page.getByRole("form", { name: "Bills", exact: true }),
    );
    const card = page.getByRole("form", { name: "Bills", exact: true });
    const box = card.getByRole("checkbox", {
      name: "Add the doctor's consultation to the bill automatically",
    });
    await expect(box).not.toBeChecked();
    await expect(card).toContainText("When off, the desk adds the consultation from Add items.");
    await box.check();
    await card.getByRole("button", { name: "Save" }).click();
    await expect.poll(setting).toBe(true);
    await page.reload();
    await expect(box).toBeChecked();
    await box.uncheck();
    await card.getByRole("button", { name: "Save" }).click();
    await expect.poll(setting).toBe(false);

    for (const role of ["reception", "reception_admin"]) {
      const api = await apiAs(role);
      const response = await api.patch("/api/billing/settings", {
        data: { auto_add_consultation: true },
      });
      expect(response.status(), role).toBe(403);
      await api.dispose();
    }
    expect(await setting()).toBe(false);

    const api = await apiAs("admin");
    const bad = await api.patch("/api/billing/settings", {
      data: { auto_add_consultation: "maybe" },
    });
    expect(bad.status()).toBe(400);
    const good = await api.patch("/api/billing/settings", {
      data: { auto_add_consultation: true },
    });
    expect(good.status()).toBe(200);
    expect((await good.json()).auto_add_consultation).toBe(true);
    await api.patch("/api/billing/settings", { data: { auto_add_consultation: false } });
    await api.dispose();
    expect(await setting()).toBe(false);
  });
});
