import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import {
  desk as billCtx,
  extraVisit,
  newTag,
  setUp,
  tearDown,
} from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const mo = await import("../../server/services/giniflow/moStation.js");
const reception = await import("../../server/services/giniflow/receptionStation.js");
const records = await import("../../server/services/giniflow/homeSampleRecords.js");
const labSite = await import("../../server/services/giniflow/labSite.js");
const bills = await import("../../server/services/billing/bills.js");
const { istClock } = await import("../../shared/homeCollection.js");

const db = getPool();
const tag = newTag();
const desk = { actorId: USERS.reception.id, actorName: "Reception" };
let ids;
const patients = [];
const cases = [];

const visitFor = async (label, { home = false, booking = true, bloodTest = true } = {}) => {
  const made = await extraVisit(ids, label, {
    healthray: false,
    ...(booking ? {} : { visitType: null }),
  });
  patients.push(made.patient);
  if (home) {
    await query(`UPDATE appointments SET home_collection = TRUE WHERE id = $1`, [made.appointment]);
  }
  if (bloodTest) {
    await mo.orderTests(
      made.visit,
      { urgency: "today", tests: [ids.looseName], actorId: USERS.admin.id },
      db,
    );
  }
  return { ...made, name: `P4 ${label} ${tag}` };
};

const paidOrder = async (visitId) => {
  const { id } = await one(
    `SELECT id FROM giniflow_lab_orders WHERE visit_id = $1 AND kind = 'lab' ORDER BY created_at DESC LIMIT 1`,
    [visitId],
  );
  await query(
    `UPDATE giniflow_lab_orders
        SET payment_status = 'paid', sample_status = 'paid', amount_paid = amount_total
      WHERE id = $1`,
    [id],
  );
  await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [visitId]);
  return id;
};

const homeNow = async (visitId) => {
  const day = await reception.getArrivals(ids.day, "", new Date(), db);
  const row = [...day.expected, ...day.onFloor].find((a) => a.visitId === visitId);
  return row?.homeCollection;
};

const bookingTag = async (appointmentId) =>
  (await one(`SELECT home_collection FROM appointments WHERE id = $1`, [appointmentId]))
    .home_collection;

const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { status: error.status, message: error.message };
  }
  return null;
};

const pastClock = () => {
  const at = new Date(Date.now() - 20 * 60 * 1000);
  return istClock(at) > istClock(new Date()) ? "00:00" : istClock(at);
};

const control = (scope) => scope.getByRole("group", { name: "Lab sample" });

test.describe.serial("G106 reception and the lab set the lab sample category", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM giniflow_lab_case_actions WHERE case_no = ANY($1)`, [cases]);
    await query(`DELETE FROM lab_cases WHERE case_no = ANY($1)`, [cases]);
    await query(`DELETE FROM lab_test_requests WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM giniflow_home_samples WHERE patient_id = ANY($1)`, [patients]);
    await query(
      `DELETE FROM appointment_change_log WHERE appointment_id IN
         (SELECT id FROM appointments WHERE patient_id = ANY($1))`,
      [patients],
    );
    await tearDown(ids);
  });

  test("1. on the Bill tab a booked patient is switched to home collection, and every screen follows", async ({
    page,
  }) => {
    const made = await visitFor("LsBill");
    expect(await homeNow(made.visit)).toBe(false);
    await loginAs(page, "reception");
    await gotoReady(
      page,
      `/giniflow/station/reception?tab=bill&visit=${made.visit}`,
      () => control(page),
      { timeout: 30000 },
    );
    const box = control(page);
    await expect(box.getByRole("radio", { name: "🏥 At GHM" })).toBeChecked();
    await box.getByRole("radio", { name: "🏠 Home collection" }).check();
    const ask = page.getByRole("group", { name: "Confirm lab sample" });
    await expect(ask).toContainText(
      `Mark ${made.name} (F4LsBill-${tag}) as 🏠 Home collection for today?`,
    );
    await ask.getByRole("button", { name: "Confirm" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "lab sample set to 🏠 Home collection" }),
    ).toBeVisible();
    await expect(box.getByRole("radio", { name: "🏠 Home collection" })).toBeChecked();
    await expect(box).toContainText("set by Reception");

    expect(await homeNow(made.visit)).toBe(true);
    expect(await bookingTag(made.appointment)).toBe(true);
    const visit = await one(`SELECT lab_site, lab_site_by FROM giniflow_visits WHERE id = $1`, [
      made.visit,
    ]);
    expect(visit).toEqual({ lab_site: "home", lab_site_by: USERS.reception.id });
    const logged = await one(
      `SELECT field_label, old_value, new_value, changed_by_id FROM appointment_change_log
        WHERE appointment_id = $1 AND field = 'home_collection'`,
      [made.appointment],
    );
    expect(logged).toEqual({
      field_label: "Home Collection",
      old_value: "No",
      new_value: "Yes",
      changed_by_id: USERS.reception.id,
    });

    const admin = await apiAs("admin");
    const res = await admin.get("/api/ghm-appointments", {
      params: { date: ids.day, limit: 100, page: 1, calls: "all", q: `LsBill ${tag}` },
    });
    expect(res.status(), await res.text()).toBe(200);
    const ghm = (await res.json()).data.find((r) => r.id === made.appointment);
    expect(ghm.home_collection).toBe(true);
    expect(ghm.home_sample_status).toBe("not_collected");
    await admin.dispose();
  });

  test("2. at the lab collection station a home patient is switched to GHM; bills and orders stay as they were", async ({
    page,
  }) => {
    const made = await visitFor("LsLab", { home: true });
    const order = await paidOrder(made.visit);
    const before = await one(
      `SELECT (SELECT COUNT(*)::int FROM bills WHERE visit_id = $1) AS bills,
              (SELECT row_to_json(o)::text FROM giniflow_lab_orders o WHERE o.id = $2) AS orderRow`,
      [made.visit, order],
    );
    expect(await homeNow(made.visit)).toBe(true);
    await loginAs(page, "lab");
    await page.goto("/giniflow/station/lab");
    await page.getByText(made.name).first().click();
    const pane = page.getByRole("dialog", { name: "Lab order" });
    const box = control(pane);
    await expect(box.getByRole("radio", { name: "🏠 Home collection" })).toBeChecked();
    await box.getByRole("radio", { name: "🏥 At GHM" }).check();
    await pane
      .getByRole("group", { name: "Confirm lab sample" })
      .getByRole("button", { name: "Confirm" })
      .click();
    await expect(
      pane.getByRole("status").filter({ hasText: "lab sample set to 🏥 At GHM" }),
    ).toBeVisible();

    expect(await homeNow(made.visit)).toBe(false);
    expect(await bookingTag(made.appointment)).toBe(false);
    const after = await one(
      `SELECT (SELECT COUNT(*)::int FROM bills WHERE visit_id = $1) AS bills,
              (SELECT row_to_json(o)::text FROM giniflow_lab_orders o WHERE o.id = $2) AS orderRow`,
      [made.visit, order],
    );
    expect(after).toEqual(before);
  });

  test("3. a patient-app home request is overruled by GHM for today, and the request is untouched", async () => {
    const made = await visitFor("LsApp");
    await query(
      `INSERT INTO lab_test_requests (patient_id, test_names, collection_type, address_house,
                                      address_street, address_landmark, address_pincode, status)
       VALUES ($1, $2, 'home', '12', 'Phase 7', 'Near park', '160062', 'approved')`,
      [made.patient, [ids.looseName]],
    );
    expect(await homeNow(made.visit)).toBe(true);
    const done = await labSite.setLabSite(made.visit, "ghm", desk, db);
    expect(done).toMatchObject({ site: "ghm", setOnFloor: true });
    expect(await homeNow(made.visit)).toBe(false);
    const request = await one(
      `SELECT collection_type, status FROM lab_test_requests WHERE patient_id = $1`,
      [made.patient],
    );
    expect(request).toEqual({ collection_type: "home", status: "approved" });
  });

  test("4. a walk-in without a booking can be set to home collection", async () => {
    const made = await visitFor("LsWalk", { booking: false });
    expect(made.appointment).toBeNull();
    const done = await labSite.setLabSite(made.visit, "home", desk, db);
    expect(done.site).toBe("home");
    const day = await reception.getArrivals(ids.day, "", new Date(), db);
    expect(
      [...day.expected, ...day.onFloor].find((a) => a.visitId === made.visit).homeCollection,
    ).toBe(true);
  });

  test("5. once the sample is collected — by the lab at GHM, at home, or reception's record — it is locked", async ({
    page,
  }) => {
    const locked = {
      status: 409,
      message: "The sample is already collected — the category can't change",
    };

    const atGhm = await visitFor("LsLockGhm");
    const order = await paidOrder(atGhm.visit);
    await query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id, meta)
       VALUES ($1, 'sample', 'sample_collected', 'lab', $2, '{"site":"ghm"}'::jsonb)`,
      [order, USERS.lab.id],
    );
    expect(await refusal(labSite.setLabSite(atGhm.visit, "home", desk, db))).toEqual(locked);

    const atHome = await visitFor("LsLockHome", { home: true });
    const caseNo = `G106-${tag}`;
    cases.push(caseNo);
    await query(
      `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                              appointment_id, test_names, case_date, case_status, raw_list_json)
       VALUES ($1, $1, $1, 985106, $2, $3, $4, $5::date, 'Registered', '{}'::jsonb)`,
      [caseNo, atHome.patient, atHome.appointment, [ids.looseName], ids.day],
    );
    await query(
      `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role, actor_id, collected_at_site)
       VALUES ($1, 'sample_taken', 'lab', $2, 'home')`,
      [caseNo, USERS.lab.id],
    );
    expect(await refusal(labSite.setLabSite(atHome.visit, "ghm", desk, db))).toEqual(locked);

    const recorded = await visitFor("LsLockRec", { home: true });
    await records.saveHomeSample(
      recorded.visit,
      {
        sample: "collected",
        collectedTime: pastClock(),
        collectedBy: "Harwinder",
        payment: "pending",
      },
      { actorId: USERS.reception.id, role: "reception" },
      db,
    );
    expect(await labSite.labSiteOf(recorded.visit, db)).toMatchObject({
      locked: true,
      editable: false,
    });
    expect(await refusal(labSite.setLabSite(recorded.visit, "ghm", desk, db))).toEqual(locked);

    const desk2 = await apiAs("reception");
    const res = await desk2.post(`/api/giniflow/stations/lab-site/${recorded.visit}`, {
      data: { site: "ghm" },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(locked.message);
    await desk2.dispose();

    await loginAs(page, "reception");
    await gotoReady(
      page,
      `/giniflow/station/reception?tab=bill&visit=${recorded.visit}`,
      () => control(page),
      { timeout: 30000 },
    );
    await expect(control(page).getByRole("radio", { name: "🏥 At GHM" })).toBeDisabled();
    await expect(control(page).getByRole("radio", { name: "🏠 Home collection" })).toBeChecked();
    await expect(
      page.getByText("Sample already collected — the category can't change"),
    ).toBeVisible();
  });

  test("6. other roles, another day and a closed visit are refused", async () => {
    const made = await visitFor("LsRules");
    const obt = await apiAs("obt_one");
    const res = await obt.post(`/api/giniflow/stations/lab-site/${made.visit}`, {
      data: { site: "home" },
    });
    expect(res.status()).toBe(403);
    await obt.dispose();

    const past = await visitFor("LsPast");
    await query(`UPDATE giniflow_visits SET visit_date = visit_date - 1 WHERE id = $1`, [
      past.visit,
    ]);
    expect(await refusal(labSite.setLabSite(past.visit, "home", desk, db))).toEqual({
      status: 400,
      message: "The lab sample can only be set for today's visit",
    });

    const gone = await visitFor("LsGone");
    await query(`UPDATE giniflow_visits SET current_status = 'no_show' WHERE id = $1`, [
      gone.visit,
    ]);
    expect(await refusal(labSite.setLabSite(gone.visit, "home", desk, db))).toEqual({
      status: 409,
      message: "This visit is marked no-show or cancelled — undo that first",
    });
  });

  test("7. the OBT team changing the booking tick afterwards wins again", async () => {
    const made = await visitFor("LsObt");
    await labSite.setLabSite(made.visit, "home", desk, db);
    const admin = await apiAs("admin");
    const res = await admin.patch(`/api/ghm-appointments/${made.appointment}`, {
      data: { home_collection: false },
    });
    expect(res.status(), await res.text()).toBe(200);
    await admin.dispose();
    const visit = await one(`SELECT lab_site FROM giniflow_visits WHERE id = $1`, [made.visit]);
    expect(visit.lab_site).toBeNull();
    expect(await homeNow(made.visit)).toBe(false);
  });

  test("8. the control fits at 1366 and 390 px and works from the keyboard", async ({ page }) => {
    const made = await visitFor("LsWidth With A Long Patient Name");
    await loginAs(page, "reception");
    await page.setViewportSize({ width: 1366, height: 900 });
    await gotoReady(
      page,
      `/giniflow/station/reception?tab=bill&visit=${made.visit}`,
      () => control(page),
      { timeout: 30000 },
    );
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(control(page)).toBeVisible();
      const box = await control(page).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
    }
    const ghm = control(page).getByRole("radio", { name: "🏥 At GHM" });
    await ghm.focus();
    await page.keyboard.press("ArrowRight");
    await expect(control(page).getByRole("radio", { name: "🏠 Home collection" })).toBeChecked();
    const ask = page.getByRole("group", { name: "Confirm lab sample" });
    await ask.getByRole("button", { name: "Back" }).press("Enter");
    await expect(ask).toHaveCount(0);
    await expect(ghm).toBeChecked();
  });

  test("9. a patient with no blood test gets no choice until one is ordered", async ({ page }) => {
    const made = await visitFor("LsNoTest", { bloodTest: false });
    expect(await labSite.labSiteOf(made.visit, db)).toMatchObject({
      applies: false,
      editable: false,
    });
    expect(await refusal(labSite.setLabSite(made.visit, "home", desk, db))).toEqual({
      status: 400,
      message: "This patient has no lab test today",
    });

    await loginAs(page, "reception");
    await gotoReady(
      page,
      `/giniflow/station/reception?tab=bill&visit=${made.visit}`,
      () => page.getByRole("heading", { name: made.name }),
      { timeout: 30000 },
    );
    await expect(page.getByRole("button", { name: "Change consultant" })).toBeVisible();
    await expect(control(page)).toHaveCount(0);

    await mo.orderTests(
      made.visit,
      { urgency: "today", tests: [ids.looseName], actorId: USERS.admin.id },
      db,
    );
    await page.reload();
    await expect(control(page)).toBeVisible({ timeout: 30000 });
    await expect(control(page).getByRole("radio", { name: "🏥 At GHM" })).toBeChecked();

    const billed = await visitFor("LsBillTest", { bloodTest: false });
    const draft = await bills.openDraft(billed.visit, billCtx, db);
    await bills.addLine(draft.id, { item_id: ids.abi }, billCtx, db);
    expect(await labSite.labSiteOf(billed.visit, db)).toMatchObject({ applies: false });
    await bills.addLine(draft.id, { item_id: ids.hba1c }, billCtx, db);
    expect(await labSite.labSiteOf(billed.visit, db)).toMatchObject({
      applies: true,
      editable: true,
    });

    const tagged = await visitFor("LsNoTestHome", { bloodTest: false, home: true });
    expect(await labSite.labSiteOf(tagged.visit, db)).toMatchObject({
      applies: true,
      site: "home",
    });
    await labSite.setLabSite(tagged.visit, "ghm", desk, db);
    expect(await labSite.labSiteOf(tagged.visit, db)).toMatchObject({
      applies: false,
      site: "ghm",
    });
  });
});
