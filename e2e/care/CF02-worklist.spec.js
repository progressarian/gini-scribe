import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { CONSULTANTS, USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const mo = await import("../../server/services/giniflow/moStation.js");
const collect = await import("../../server/services/careFollowups/collect.js");

const db = getPool();
const tag = newTag();
let ids;
const patients = [];

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const nameOf = (label) => `P4 ${label} ${tag}`;

async function referred(label, specialty, { to = null, phone = null } = {}) {
  const made = await extraVisit(ids, label, { healthray: false });
  patients.push(made.patient);
  if (phone) await query(`UPDATE patients SET phone = $2 WHERE id = $1`, [made.patient, phone]);
  await query(
    `INSERT INTO giniflow_referrals (visit_id, patient_id, specialty, to_doctor, reason, created_by)
     VALUES ($1, $2, $3, $4, 'Please review', $5)`,
    [made.visit, made.patient, specialty, to, USERS.admin.id],
  );
  await collect.collectFollowups({ db });
  const item = await one(
    `SELECT id FROM care_followups WHERE patient_id = $1 ORDER BY created_at LIMIT 1`,
    [made.patient],
  );
  return { ...made, item: item.id, name: nameOf(label) };
}

const table = (page) => page.getByRole("table", { name: "Follow-ups" });
const rowOf = (page, name) => table(page).getByRole("row").filter({ hasText: name });

async function openPage(page, role = "care_coordinator") {
  await loginAs(page, role);
  await gotoReady(
    page,
    "/care-followups",
    () => page.getByRole("heading", { name: "Follow-ups" }),
    {
      timeout: 30000,
    },
  );
}

async function search(page, text) {
  await page.getByLabel("Search").fill(text);
  await expect(rowOf(page, text).first()).toBeVisible({ timeout: 15000 });
}

test.describe.serial("CF02 care follow-ups: the worklist", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await query(
      `INSERT INTO app_kv (key, value, updated_at) VALUES ('care_followups_since', to_jsonb($1::text), NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [ids.day],
    );
  });

  test.afterAll(async () => {
    await query(`DELETE FROM care_followups WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM giniflow_referrals WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1) AND booking_source = 'OBT'`, [
      patients,
    ]).catch(() => {});
    await query(`DELETE FROM app_kv WHERE key = 'care_followups_since'`);
    await tearDown(ids);
  });

  test("1. only the care coordinator reaches Follow-ups and the Referrals desk; the floor coordinator and other roles are kept out", async ({
    page,
  }) => {
    await loginAs(page, "care_coordinator");
    await page.goto("/");
    await expect(page).toHaveURL(/\/care-followups$/, { timeout: 20000 });
    await expect(page.getByRole("heading", { name: "Follow-ups" })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("link", { name: /Follow-ups/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Reception|OPD/ })).toHaveCount(0);
    await page.goto("/giniflow/station/referrals");
    await expect(page.getByText("Today's referrals")).toBeVisible({ timeout: 30000 });
    const care = await apiAs("care_coordinator");
    expect((await care.get("/api/care-followups")).status()).toBe(200);
    expect((await care.get("/api/giniflow/referrals")).status()).toBe(200);
    expect((await care.get("/api/giniflow/stations/rx/queue")).status()).toBe(403);
    expect((await care.get("/api/giniflow/stations/vitals/queue")).status()).toBe(403);
    await care.dispose();

    await loginAs(page, "coordinator");
    await page.goto("/");
    await expect(page.getByRole("link", { name: /Follow-ups/ })).toHaveCount(0);
    for (const role of ["coordinator", "reception", "obt_one", "lab"]) {
      const api = await apiAs(role);
      expect((await api.get("/api/care-followups")).status(), role).toBe(403);
      expect((await api.get("/api/giniflow/referrals")).status(), role).toBe(403);
      await api.dispose();
    }
  });

  test("2. search by name or phone and the status counts match the database", async ({ page }) => {
    const a = await referred("CfwFind", "Ophthalmology", { phone: "9811122233" });
    await openPage(page);
    await search(page, a.name);
    await expect(rowOf(page, a.name)).toContainText("Ophthalmology");
    await page.getByLabel("Search").fill("98111222");
    await expect(rowOf(page, a.name)).toBeVisible({ timeout: 15000 });
    const api = await apiAs("care_coordinator");
    const body = await (await api.get("/api/care-followups", { params: { q: a.name } })).json();
    await api.dispose();
    expect(body.total).toBe(1);
    expect(body.counts.open).toBe(1);
    expect(body.rows[0].patient.phone).toBe("9811122233");
  });

  test("3. the call status is set on the row like the call sheet; three unanswered calls are flagged", async ({
    page,
  }) => {
    const a = await referred("CfwCall", "Neurology", { phone: "9811100011" });
    await openPage(page);
    await search(page, a.name);
    const row = rowOf(page, a.name);
    await expect(row.getByRole("link", { name: "98111 00011" })).toHaveAttribute(
      "href",
      "tel:9811100011",
    );
    for (let i = 0; i < 3; i += 1) {
      await row.getByRole("button", { name: `Call status for ${a.name}` }).click();
      await page.getByRole("option", { name: "Not Picked Up" }).click();
      await expect(row).toContainText(`${i + 1} call`);
    }
    await expect(row).toContainText("3 calls");
    await expect(row).toContainText("3 tries — no answer");
    await expect(row.getByRole("columnheader")).toHaveCount(0);
    await expect(table(page).getByRole("columnheader", { name: "Due" })).toHaveCount(0);
    const events = await query(
      `SELECT COUNT(*)::int AS n FROM care_followup_events WHERE followup_id = $1 AND kind = 'call'`,
      [a.item],
    );
    expect(events.rows[0].n).toBe(3);
  });

  test("4. Book a consultant: the GHM form opens prefilled, and saving links the booking", async ({
    page,
  }) => {
    const a = await referred("CfwBook", "Endocrinology", { to: "Dr E2E Banshali" });
    await openPage(page);
    await search(page, a.name);
    await rowOf(page, a.name)
      .getByRole("button", { name: /^Book / })
      .click();
    await expect(page.getByLabel("Doctor *")).toHaveValue(CONSULTANTS.banshali.name);
    await expect(page.getByText("Book Appointment").last()).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Cancel" })
      .last()
      .click()
      .catch(() => {});

    const api = await apiAs("care_coordinator");
    const day = addDays(ids.day, 3);
    const res = await api.post("/api/ghm-appointments", {
      data: {
        patient_name: a.name,
        file_no: `F4CfwBook-${tag}`,
        doctor_name: CONSULTANTS.banshali.name,
        appointment_date: day,
        time_slot: "12:30 PM to 1 PM",
        visit_type: "Follow Up",
        notes: "Follow-up: Endocrinology",
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const booking = await res.json();
    const linked = await api.post(`/api/care-followups/${a.item}/booked`, {
      data: { appointment_id: booking.id },
    });
    expect(linked.status(), await linked.text()).toBe(200);
    const other = await api.post(`/api/care-followups/${a.item}/booked`, {
      data: { appointment_id: ids.appointment },
    });
    expect(other.status()).toBe(400);
    await api.dispose();
    await page.reload();
    await page.getByLabel("Status", { exact: true }).selectOption("booked");
    await search(page, a.name);
    await expect(rowOf(page, a.name)).toContainText("Booked");
    await expect(rowOf(page, a.name)).toContainText(CONSULTANTS.banshali.name);
  });

  test("5. a next-visit test is not a referral and never shows on the list", async ({ page }) => {
    const made = await extraVisit(ids, "CfwTest", { healthray: false });
    patients.push(made.patient);
    await mo.orderTests(
      made.visit,
      { urgency: "next_visit", tests: [ids.looseName], actorId: USERS.admin.id },
      db,
    );
    await query(`UPDATE appointments SET healthray_investigations = $2::jsonb WHERE id = $1`, [
      made.appointment,
      JSON.stringify([ids.looseName]),
    ]);
    await collect.collectFollowups({ db });
    await openPage(page);
    await page.getByLabel("Status", { exact: true }).selectOption("all");
    await page.getByLabel("Search").fill(nameOf("CfwTest"));
    await expect(page.getByText("No follow-ups match the current filters.")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByLabel("Type").locator("option")).toHaveText([
      "All",
      "Consultant / MO / Chief",
      "Department / specialty",
    ]);
  });

  test("6. Not available needs a reason, on screen and from the API", async ({ page }) => {
    const a = await referred("CfwNa", "Oncology");
    const api = await apiAs("care_coordinator");
    const bad = await api.post(`/api/care-followups/${a.item}/outcome`, {
      data: { status: "not_available", reason: "" },
    });
    expect(bad.status()).toBe(400);
    await api.dispose();

    await openPage(page);
    await search(page, a.name);
    await rowOf(page, a.name)
      .getByRole("button", { name: `Close the follow-up for ${a.name}` })
      .click();
    const dialog = page.getByRole("dialog", { name: `Close follow-up — ${a.name}` });
    await dialog.getByRole("button", { name: "Save outcome" }).click();
    await expect(dialog.getByText("Choose what happened")).toBeVisible();
    await dialog.getByRole("radio", { name: "Not available here" }).check();
    await dialog.getByRole("button", { name: "Save outcome" }).click();
    await expect(dialog.getByText("Write the reason — at least 3 characters")).toBeVisible();
    await dialog.getByRole("radio", { name: "No such specialist at GHM" }).check();
    await dialog.getByRole("button", { name: "Save outcome" }).click();
    await expect(dialog).toBeHidden();
    const saved = await one(`SELECT status, outcome_reason FROM care_followups WHERE id = $1`, [
      a.item,
    ]);
    expect(saved).toEqual({
      status: "not_available",
      outcome_reason: "No such specialist at GHM",
    });
  });

  test("7. Reopen needs a reason, and the drawer shows both entries and the patient's other items", async ({
    page,
  }) => {
    const a = await referred("CfwOpen", "Urology");
    await query(
      `INSERT INTO giniflow_referrals (visit_id, patient_id, specialty, reason, created_by)
       VALUES ($1, $2, 'Dental', 'Teeth', $3)`,
      [a.visit, a.patient, USERS.admin.id],
    );
    await collect.collectFollowups({ db });
    const api = await apiAs("care_coordinator");
    await api.post(`/api/care-followups/${a.item}/outcome`, {
      data: { status: "declined", reason: "Will go to own urologist" },
    });
    expect(
      (await api.post(`/api/care-followups/${a.item}/reopen`, { data: { reason: "" } })).status(),
    ).toBe(400);
    expect(
      (
        await api.post(`/api/care-followups/${a.item}/reopen`, {
          data: { reason: "Changed their mind" },
        })
      ).status(),
    ).toBe(200);
    await api.dispose();

    await openPage(page);
    await search(page, a.name);
    await rowOf(page, a.name)
      .filter({ hasText: "Urology" })
      .getByRole("button", { name: `History for ${a.name}` })
      .click();
    const drawer = page.getByRole("dialog", { name: a.name });
    await expect(drawer).toContainText("Will go to own urologist");
    await expect(drawer).toContainText("Changed their mind");
    await expect(drawer.getByRole("region", { name: "Other open follow-ups" })).toContainText(
      "Dental",
    );
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });

  test("8. fits at 390 px and the dialogs work from the keyboard", async ({ page }) => {
    const a = await referred("CfwNarrow With A Long Patient Name", "Cardiology");
    await page.setViewportSize({ width: 390, height: 900 });
    await openPage(page);
    await search(page, a.name);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await rowOf(page, a.name)
      .getByRole("button", { name: `Close the follow-up for ${a.name}` })
      .click();
    const dialog = page.getByRole("dialog", { name: `Close follow-up — ${a.name}` });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("9. Referred on: step through days, and an earlier day's referrals are fetched when picked", async ({
    page,
  }) => {
    const fresh = await referred("CfwDayNew", "Cardiology");
    const made = await extraVisit(ids, "CfwDayOld", { healthray: false });
    patients.push(made.patient);
    const twoDaysAgo = addDays(ids.day, -2);
    await query(`UPDATE giniflow_visits SET visit_date = $2::date WHERE id = $1`, [
      made.visit,
      twoDaysAgo,
    ]);
    await query(
      `INSERT INTO giniflow_referrals (visit_id, patient_id, specialty, reason, created_by)
       VALUES ($1, $2, 'Cardiology', 'Chest pain on walking', $3)`,
      [made.visit, made.patient, USERS.admin.id],
    );
    await collect.collectFollowups({ db });
    const oldName = nameOf("CfwDayOld");
    expect(
      (await query(`SELECT 1 FROM care_followups WHERE patient_id = $1`, [made.patient])).rowCount,
    ).toBe(0);

    await openPage(page);
    const day = page.getByRole("group", { name: "Referred on" });
    await day.getByRole("button", { name: "Today" }).click();
    await expect(rowOf(page, fresh.name)).toBeVisible({ timeout: 15000 });

    await day.getByRole("button", { name: "Previous day" }).click();
    await expect(page.getByText(`No open referrals made on`)).toBeVisible({ timeout: 15000 });
    await expect(rowOf(page, fresh.name)).toHaveCount(0);

    await day.getByRole("button", { name: "Previous day" }).click();
    await expect(rowOf(page, oldName)).toBeVisible({ timeout: 20000 });
    await expect(rowOf(page, oldName)).toContainText("Chest pain on walking");
    const saved = await query(
      `SELECT ordered_on::text AS day FROM care_followups WHERE patient_id = $1`,
      [made.patient],
    );
    expect(saved.rows).toEqual([{ day: twoDaysAgo }]);

    await day.getByRole("button", { name: "All dates" }).click();
    await page.getByLabel("Search").fill("CfwDay");
    await expect(rowOf(page, fresh.name)).toBeVisible({ timeout: 15000 });
    await expect(rowOf(page, oldName)).toBeVisible();

    const api = await apiAs("care_coordinator");
    const future = await api.post("/api/care-followups/day", {
      data: { day: addDays(ids.day, 1) },
    });
    expect(future.status()).toBe(400);
    await api.dispose();
  });

  test("10. the care coordinator opens Triage, Flow Coordinator, Consultant and Referrals with nothing refused", async ({
    page,
  }) => {
    const refused = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/") && r.status() === 403) refused.push(r.url());
    });
    await loginAs(page, "care_coordinator");
    await gotoReady(page, "/giniflow/stations", () => page.getByText("Referrals").first());
    for (const name of ["Triage", "Flow Coordinator", "Consultant", "Referrals"])
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    for (const name of ["Reception", "Vitals", "Prescription Explain", "Pharmacy"])
      await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    for (const path of [
      "/giniflow/triage",
      "/giniflow/manager",
      "/giniflow/station/doctor",
      "/giniflow/station/referrals",
    ]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(new RegExp(path.replace(/\//g, "\\/")));
      await expect(page.getByText(/not allowed|no access|don't have access/i)).toHaveCount(0);
    }
    expect(refused).toEqual([]);
  });
});
