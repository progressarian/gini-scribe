import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const reception = await import("../../server/services/giniflow/receptionStation.js");
const records = await import("../../server/services/giniflow/homeSampleRecords.js");
const { istClock } = await import("../../shared/homeCollection.js");

const db = getPool();
const tag = newTag();
const desk = { actorId: USERS.reception.id, role: "reception" };
let ids;
const patients = [];

const pastClock = (minutes = 30) => {
  const at = new Date(Date.now() - minutes * 60 * 1000);
  return istClock(at) > istClock(new Date()) ? "00:00" : istClock(at);
};

const futureClock = () => {
  const at = new Date(Date.now() + 90 * 60 * 1000);
  return istClock(at) < istClock(new Date()) ? null : istClock(at);
};

const homeVisit = async (label, { home = true } = {}) => {
  const made = await extraVisit(ids, label, { healthray: false });
  patients.push(made.patient);
  if (home) {
    await query(`UPDATE appointments SET home_collection = TRUE WHERE id = $1`, [made.appointment]);
  }
  return { ...made, name: `P4 ${label} ${tag}` };
};

const savedRows = async (visitId) =>
  (
    await query(
      `SELECT sample, collected_by, payment, amount::numeric AS amount, mode, entered_by, entered_role
         FROM giniflow_home_samples WHERE visit_id = $1 ORDER BY entered_at`,
      [visitId],
    )
  ).rows;

const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { status: error.status, message: error.message };
  }
  return null;
};

const rowOf = (page, name) => page.locator(".ar-row").filter({ hasText: name });

async function openArrivals(page) {
  await loginAs(page, "reception");
  await gotoReady(page, "/giniflow/station/reception", () =>
    page.getByRole("tab", { name: /^Arrivals/ }),
  );
}

const saveDirect = (visitId, body) => records.saveHomeSample(visitId, body, desk, db);

test.describe.serial("G105 reception records the home sample", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM giniflow_home_samples WHERE patient_id = ANY($1)`, [patients]);
    await tearDown(ids);
  });

  test("1. a home-tag patient shows the home line and button; a normal patient shows neither", async ({
    page,
  }) => {
    const home = await homeVisit("HsTag");
    const plain = await homeVisit("HsPlain", { home: false });
    await openArrivals(page);
    const row = rowOf(page, home.name);
    await expect(row.getByLabel("Home collection")).toContainText(
      "🏠 Home collectionSample: Not recordedPayment: Not recorded",
    );
    await expect(row.getByRole("button", { name: "🏠 Home sample" })).toBeVisible();
    const other = rowOf(page, plain.name);
    await expect(other).toBeVisible();
    await expect(other.getByLabel("Home collection")).toHaveCount(0);
    await expect(other.getByRole("button", { name: "🏠 Home sample" })).toHaveCount(0);
  });

  test("2. before arrival: collected by Harwinder, paid ₹1,260 cash — the row says so and nothing is billed", async ({
    page,
  }) => {
    const made = await homeVisit("HsBefore");
    const time = pastClock();
    await openArrivals(page);
    await rowOf(page, made.name).getByRole("button", { name: "🏠 Home sample" }).click();
    const dialog = page.getByRole("dialog", { name: `🏠 Home sample — ${made.name}` });
    await dialog.getByRole("radio", { name: "Collected at home" }).check();
    await dialog.getByLabel("Time (required)").fill(time);
    await dialog.getByLabel("Collected by (required)").selectOption("Harwinder");
    await dialog.getByRole("radio", { name: "Paid at home" }).check();
    await dialog.getByLabel("Amount in ₹ (required)").fill("1260");
    await dialog.getByLabel("Mode (required)").selectOption("cash");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`🏠 Home sample saved for ${made.name}`)).toBeVisible();

    const line = rowOf(page, made.name).getByLabel("Home collection");
    await expect(line).toContainText(`Sample: Collected at home ${time} (Harwinder)`);
    await expect(line).toContainText("Payment: Paid at home (reported) ₹1,260 · Cash");
    const status = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
      made.visit,
    ]);
    expect(status.current_status).toBe("booked");
    const rows = await savedRows(made.visit);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sample: "collected",
      collected_by: "Harwinder",
      payment: "paid",
      mode: "cash",
      entered_by: USERS.reception.id,
      entered_role: "reception",
    });
    expect(Number(rows[0].amount)).toBe(1260);
    const billed = await one(
      `SELECT (SELECT COUNT(*)::int FROM bills WHERE visit_id = $1) AS bills,
              (SELECT COUNT(*)::int FROM payments p JOIN bills b ON b.id = p.bill_id
                WHERE b.visit_id = $1) AS payments`,
      [made.visit],
    );
    expect(billed).toEqual({ bills: 0, payments: 0 });
  });

  test("3. ✓ Arrived with nothing recorded asks first, saves the answer, then checks in", async ({
    page,
  }) => {
    const made = await homeVisit("HsArrive");
    let checkedIn = 0;
    await page.route(`**/api/giniflow/stations/reception/${made.visit}/checkin`, async (route) => {
      checkedIn++;
      await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
        made.visit,
      ]);
      return route.fulfill({ json: { totalCount: 1, plannedTotalMin: 5, raised: null } });
    });
    await openArrivals(page);
    await rowOf(page, made.name).getByRole("button", { name: "✓ Arrived" }).click();
    const panel = page.getByRole("dialog", { name: "Check in" });
    const box = panel.getByRole("region", { name: "Home collection — ask the patient" });
    await expect(box).toBeVisible();
    const need = panel.getByRole("status").filter({ hasText: "Home sample — still needed" });
    await expect(need).toHaveText("Home sample — still needed: collected at home or not");
    const arrive = panel.getByRole("button", { name: "Check in only — bill later" });
    await expect(arrive).toBeDisabled();

    await box.getByRole("radio", { name: "Collected at home" }).check();
    await box.getByLabel("Collected by (required)").focus();
    await expect(box.getByText("Enter the time the sample was collected")).toHaveCount(0);
    await expect(box.getByText(/Choose who collected it/)).toHaveCount(0);
    await expect(box.getByText("Choose whether the payment was made at home")).toHaveCount(0);
    await expect(need).toHaveText(
      "Home sample — still needed: collection time, collected by, paid at home or pending",
    );
    await box.getByLabel("Time (required)").fill(pastClock());
    await box.getByLabel("Collected by (required)").selectOption("Pratham");
    await expect(need).toHaveText("Home sample — still needed: paid at home or pending");
    await expect(arrive).toBeDisabled();
    await box.getByRole("radio", { name: "Pending" }).check();
    await expect(need).toHaveCount(0);
    await expect(arrive).toBeEnabled({ timeout: 15000 });
    await arrive.click();

    await expect.poll(() => checkedIn).toBe(1);
    const rows = await savedRows(made.visit);
    expect(rows.map((r) => [r.sample, r.collected_by, r.payment])).toEqual([
      ["collected", "Pratham", "pending"],
    ]);
  });

  test("4. not collected hides the payment questions and the patient checks in as normal", async ({
    page,
  }) => {
    const made = await homeVisit("HsNot");
    await openArrivals(page);
    await rowOf(page, made.name).getByRole("button", { name: "🏠 Home sample" }).click();
    const dialog = page.getByRole("dialog", { name: `🏠 Home sample — ${made.name}` });
    await dialog.getByRole("radio", { name: "Collected at home" }).check();
    await expect(dialog.getByRole("group", { name: "Payment" })).toBeVisible();
    await dialog.getByRole("radio", { name: /^Not collected/ }).check();
    await expect(dialog.getByRole("group", { name: "Payment" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    const line = rowOf(page, made.name).getByLabel("Home collection");
    await expect(line).toContainText("Sample: Not collected");
    await expect(line).not.toContainText("Payment");

    await rowOf(page, made.name).getByRole("button", { name: "✓ Arrived" }).click();
    const panel = page.getByRole("dialog", { name: "Check in" });
    await expect(panel.getByText("What is this visit?")).toBeVisible();
    await expect(
      panel.getByRole("region", { name: "Home collection — ask the patient" }),
    ).toHaveCount(0);
  });

  test("5. pending shows the yellow pill; changing to paid clears it and history lists both saves", async ({
    page,
  }) => {
    const made = await homeVisit("HsPend");
    const time = pastClock(45);
    await saveDirect(made.visit, {
      sample: "collected",
      collectedTime: time,
      collectedBy: "Harwinder",
      payment: "pending",
    });
    await openArrivals(page);
    const row = rowOf(page, made.name);
    await expect(row.locator(".badge.b-amb", { hasText: "Payment pending" })).toBeVisible();

    await row.getByRole("button", { name: "🏠 Home sample" }).click();
    const dialog = page.getByRole("dialog", { name: `🏠 Home sample — ${made.name}` });
    await expect(dialog.getByLabel("Time (required)")).toHaveValue(time);
    await dialog.getByRole("radio", { name: "Paid at home" }).check();
    await dialog.getByLabel("Amount in ₹ (required)").fill("900");
    await dialog.getByLabel("Mode (required)").selectOption("upi");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(row.locator(".badge.b-amb", { hasText: "Payment pending" })).toHaveCount(0);
    await expect(row.getByLabel("Home collection")).toContainText(
      "Paid at home (reported) ₹900 · UPI",
    );

    await row.getByRole("button", { name: "🏠 Home sample" }).click();
    await dialog.getByRole("button", { name: "History (2)" }).click();
    const items = dialog.getByRole("list", { name: "Home sample history" }).getByRole("listitem");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("Paid at home (reported) ₹900 · UPI");
    await expect(items.nth(1)).toContainText("Payment pending");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("6. bad answers, the wrong patient, another day and other roles are refused", async ({
    page,
  }) => {
    const made = await homeVisit("HsRules");
    const time = pastClock();
    const base = {
      sample: "collected",
      collectedTime: time,
      collectedBy: "Harwinder",
      payment: "pending",
    };
    const future = futureClock();
    if (future) {
      expect(await refusal(saveDirect(made.visit, { ...base, collectedTime: future }))).toEqual({
        status: 400,
        message: "The collection time can't be in the future",
      });
    }
    expect(await refusal(saveDirect(made.visit, { ...base, collectedBy: "" }))).toEqual({
      status: 400,
      message: "Choose who collected it: Harwinder or Pratham",
    });
    expect(await refusal(saveDirect(made.visit, { ...base, collectedBy: "Someone Else" }))).toEqual(
      {
        status: 400,
        message: "Choose who collected it: Harwinder or Pratham",
      },
    );
    expect(
      await refusal(saveDirect(made.visit, { ...base, payment: "paid", amount: 0, mode: "cash" })),
    ).toEqual({ status: 400, message: "Enter the amount in whole rupees, from ₹1 to ₹1,00,000" });

    const plain = await homeVisit("HsRulesPlain", { home: false });
    expect(await refusal(saveDirect(plain.visit, base))).toEqual({
      status: 400,
      message: "This patient did not opt for home collection",
    });

    const past = await homeVisit("HsRulesPast");
    await query(`UPDATE appointments SET appointment_date = appointment_date - 1 WHERE id = $1`, [
      past.appointment,
    ]);
    await query(`UPDATE giniflow_visits SET visit_date = visit_date - 1 WHERE id = $1`, [
      past.visit,
    ]);
    expect(await refusal(saveDirect(past.visit, base))).toEqual({
      status: 400,
      message: "A home sample can only be recorded for today's visit",
    });
    expect(await savedRows(made.visit)).toHaveLength(0);

    for (const role of ["lab", "obt_one"]) {
      const api = await apiAs(role);
      const res = await api.post(`/api/giniflow/stations/reception/${made.visit}/home-sample`, {
        data: base,
      });
      expect(res.status(), role).toBe(403);
      await api.dispose();
    }
    const desk = await apiAs("reception");
    const bad = await desk.post(`/api/giniflow/stations/reception/${made.visit}/home-sample`, {
      data: { ...base, collectedBy: "Someone Else" },
    });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toBe("Choose who collected it: Harwinder or Pratham");
    await desk.dispose();

    await openArrivals(page);
    await rowOf(page, made.name).getByRole("button", { name: "🏠 Home sample" }).click();
    const dialog = page.getByRole("dialog", { name: `🏠 Home sample — ${made.name}` });
    await dialog.getByRole("radio", { name: "Collected at home" }).check();
    await dialog.getByRole("radio", { name: "Paid at home" }).check();
    await dialog.getByLabel("Amount in ₹ (required)").fill("0");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText("Enter the time the sample was collected")).toBeVisible();
    await expect(dialog.getByText("Choose who collected it: Harwinder or Pratham")).toBeVisible();
    await expect(
      dialog.getByText("Enter the amount in whole rupees, from ₹1 to ₹1,00,000"),
    ).toBeVisible();
    await expect(dialog.getByText("Choose how the patient paid")).toBeVisible();
    await expect(dialog.getByLabel("Collected by (required)")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(await savedRows(made.visit)).toHaveLength(0);
  });

  test("7. the GHM ops chip shows reception's record", async () => {
    const made = await homeVisit("HsGhm");
    const time = pastClock(20);
    const api = await apiAs("admin");
    const listed = async () => {
      const response = await api.get("/api/ghm-appointments", {
        params: { date: ids.day, limit: 100, page: 1, calls: "all", q: `HsGhm ${tag}` },
      });
      expect(response.status(), await response.text()).toBe(200);
      return (await response.json()).data.find((row) => row.id === made.appointment);
    };
    expect((await listed()).home_sample_status).toBe("not_collected");
    await saveDirect(made.visit, {
      sample: "collected",
      collectedTime: time,
      collectedBy: "Harwinder",
      payment: "pending",
    });
    const row = await listed();
    expect(row.home_sample_status).toBe("home");
    expect(row.home_sample.by).toBe("Harwinder");
    expect(istClock(row.home_sample.at)).toBe(time);
    await api.dispose();
  });

  test("8. a second reception screen shows the new record without reloading", async ({ page }) => {
    const made = await homeVisit("HsLive");
    await openArrivals(page);
    const line = rowOf(page, made.name).getByLabel("Home collection");
    await expect(line).toContainText("Sample: Not recorded");
    const api = await apiAs("reception");
    const res = await api.post(`/api/giniflow/stations/reception/${made.visit}/home-sample`, {
      data: { sample: "not_collected" },
    });
    expect(res.status(), await res.text()).toBe(200);
    await api.dispose();
    await expect(line).toContainText("Sample: Not collected", { timeout: 20000 });
  });

  test("9. without the table, arrivals still load with no home record and a save is refused", async () => {
    const made = await homeVisit("HsNoTable");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE giniflow_home_samples RENAME TO giniflow_home_samples_off`);
      records.forgetHomeSamplesReady();
      const day = await reception.getArrivals(ids.day, `HsNoTable ${tag}`, new Date(), client);
      const row = day.expected.find((a) => a.visitId === made.visit);
      expect(row).toMatchObject({ homeCollection: true, homeRecordsOn: false, homeRecord: null });
      expect(
        await refusal(
          records.saveHomeSample(made.visit, { sample: "not_collected" }, desk, client),
        ),
      ).toEqual({ status: 503, message: "Home sample recording isn't switched on yet" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      records.forgetHomeSamplesReady();
    }
  });

  test("10. the row and the window fit at 1366 and 390 px, and the keyboard works", async ({
    page,
  }) => {
    const made = await homeVisit("HsWidth With A Long Patient Name");
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await openArrivals(page);
      const row = rowOf(page, made.name);
      await expect(row.getByRole("button", { name: "🏠 Home sample" })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      await row.getByRole("button", { name: "🏠 Home sample" }).click();
      const dialog = page.getByRole("dialog", { name: `🏠 Home sample — ${made.name}` });
      await expect(dialog.getByRole("radio", { name: "Collected at home" })).toBeFocused();
      const box = await dialog.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("radio", { name: "Collected at home" })).not.toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(row.getByRole("button", { name: "🏠 Home sample" })).toBeFocused();
    }
  });
});
