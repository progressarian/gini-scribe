import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const SHOTS = process.env.DM_SHOTS;
const doctor = CONSULTANTS.beant;
const istDay = (offset = 0) =>
  new Date(Date.now() + offset * 86400000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
const mondayAhead = () => {
  for (let i = 7; ; i += 1) {
    const d = istDay(i);
    if (new Date(`${d}T00:00:00Z`).getUTCDay() === 1) return d;
  }
};
const MONDAY = mondayAhead();
const longDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const cleanUp = async () => {
  await query(`DELETE FROM appointment_reassignments WHERE file_no LIKE 'G117-%'`);
  await query(`DELETE FROM appointments WHERE file_no LIKE 'G117-%'`);
  await query(
    `DELETE FROM doctor_slot_templates WHERE doctor_id = ANY($1) AND effective_from > '2026-01-01'`,
    [[doctor.id, CONSULTANTS.rahul.id, CONSULTANTS.banshali.id]],
  );
};

test.describe
  .serial("G117 Schedule tab: build a weekly schedule, preview it, save and withdraw", () => {
  test.beforeAll(async () => {
    await cleanUp();
    await query(
      `INSERT INTO appointments (patient_name, file_no, doctor_name, appointment_date, time_slot, status, healthray_id)
       VALUES ('G117 Late patient', 'G117-1', $1, $2, '16:30', 'booked', 990000201),
              ('G117 Morning patient', 'G117-2', $1, $2, '9:20 AM to 9:40 AM', 'booked', NULL)`,
      [doctor.name, MONDAY],
    );
  });
  test.afterAll(cleanUp);

  test.beforeEach(async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/staff-management", () =>
      page.getByRole("heading", { name: "Staff Management" }),
    );
    await page
      .getByRole("list", { name: "Staff list" })
      .getByRole("button")
      .filter({ hasText: doctor.name })
      .click();
    await page.getByRole("tab", { name: "Schedule" }).click();
    await expect(page.getByRole("heading", { name: "Weekly schedule" })).toBeVisible();
  });

  const edit = (page) => page.getByRole("button", { name: "Edit schedule" }).click();

  const buildMondays = async (page) => {
    await edit(page);
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
      await page.getByRole("checkbox", { name: day, exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "Mon", exact: true }).check();
    await page.getByLabel("Mon hours 1 to").fill("13:00");
    await page.getByLabel("Mon hours 1 slot length").selectOption("20");
    await page.getByRole("button", { name: "+ Add hours on Mon" }).click();
    await page.getByLabel("Mon hours 2 to").fill("16:00");
    await page.getByLabel("Mon hours 2 slot length").selectOption("60");
    await page.getByRole("button", { name: "+ Add break" }).click();
    await page.getByLabel("Break 1 name").fill("Lunch");
    await page.getByLabel("Lunch from").fill("11:00");
    await page.getByLabel("Lunch to").fill("11:20");
  };

  test("1. the tab shows the schedule in use and the preview follows every edit", async ({
    page,
  }) => {
    await expect(page.getByText("In use since 1 Jan 2026")).toBeVisible();
    const week = page.getByRole("table", { name: "Working hours by day" });
    await expect(week.getByRole("row", { name: /Sun/ })).toContainText("Not working");
    await expect(week.getByRole("row", { name: /Mon/ })).toContainText("9 AM–5 PM · 30 min slots");
    await expect(page.getByRole("checkbox", { name: "Mon", exact: true })).toHaveCount(0);
    await buildMondays(page);
    await page.getByLabel("Applies from").fill(MONDAY);
    await page.getByLabel("Schedule preview day").selectOption(MONDAY);
    await expect(page.getByText("14 slots · Lunch 11 AM–11:20 AM skipped")).toBeVisible();
    const pills = page.getByLabel("Slots on the preview day").locator(".slotpill");
    await expect(pills).toHaveCount(15);
    await expect(pills.first()).toHaveText("9 AM to 9:20 AM");
    await expect(pills.nth(6)).toContainText("Lunch");
    await expect(pills.last()).toHaveText("3 PM to 4 PM");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/schedule-editor.png`, fullPage: true });
  });

  test("2. a break outside the hours is explained next to it and blocks saving", async ({
    page,
  }) => {
    await buildMondays(page);
    await page.getByLabel("Lunch to").fill("18:00");
    await expect(
      page.getByText("Lunch (11 AM–6 PM) runs past the working hours on Mon."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save schedule" })).toBeDisabled();
    await expect(page.getByText("Fix 1 problem before saving.")).toBeVisible();
    await page.getByLabel("Lunch to").fill("11:20");
    await expect(page.getByRole("button", { name: "Save schedule" })).toBeEnabled();
  });

  test("3. checking bookings lists who falls outside; saving starts it on the chosen date", async ({
    page,
  }) => {
    await buildMondays(page);
    await page.getByLabel("Applies from").fill(MONDAY);
    await page.getByRole("button", { name: "Check bookings" }).click();
    const impact = page.getByRole("status").filter({ hasText: "falls outside this schedule" });
    await expect(impact).toContainText("1 booked patient");
    await expect(impact.getByRole("row", { name: /G117 Late patient/ })).toContainText(
      "Outside working hours",
    );
    await expect(impact.getByRole("row", { name: /G117 Late patient/ })).toContainText("HealthRay");
    await expect(impact).toContainText("must be moved in HealthRay too");

    await page.getByRole("button", { name: "Save — 1 booked patient falls outside" }).click();
    await expect(
      page.getByText(`Saved. Booking follows this schedule from ${longDate(MONDAY)}`),
    ).toBeVisible();
    await expect(page.getByText(`A new schedule starts on ${longDate(MONDAY)}`)).toBeVisible();
    const saved = await one(
      `SELECT count(*)::int AS n FROM doctor_slot_templates
        WHERE doctor_id = $1 AND effective_from = $2 AND status = 'active'`,
      [doctor.id, MONDAY],
    );
    expect(saved.n).toBe(1);
    await expect(page.getByText(/In use since 1 Jan 2026/)).toBeVisible();
  });

  test("4. the upcoming schedule can be withdrawn and stays in the history", async ({ page }) => {
    await page.getByRole("button", { name: /^Version history/ }).click();
    const history = page.getByRole("table", { name: "Schedule version history" });
    await expect(history.getByRole("row").nth(1)).toContainText("Starts later");
    await page.getByRole("button", { name: "Withdraw it" }).click();
    await expect(page.getByRole("dialog")).toContainText("Booking keeps using the schedule");
    await page.getByRole("button", { name: "Withdraw schedule" }).click();
    await expect(page.getByText(/A new schedule starts on/)).toHaveCount(0);
    await expect(history.getByRole("row").nth(1)).toContainText("Withdrawn");
    await expect(history.getByRole("button", { name: "Withdraw" })).toHaveCount(0);
  });
  test("5. one schedule saved for chosen doctors, then an affected Scribe patient is moved", async ({
    page,
  }) => {
    await query(
      `INSERT INTO appointments (patient_name, file_no, doctor_name, appointment_date, time_slot, status)
       VALUES ('G117 Evening patient', 'G117-3', $1, $2, '5 PM to 6 PM', 'booked')`,
      [doctor.name, MONDAY],
    );
    await buildMondays(page);
    await page.getByLabel("Applies from").fill(MONDAY);
    await page.getByRole("radio", { name: "Choose doctors" }).check();
    await page.getByRole("checkbox", { name: CONSULTANTS.rahul.name }).check();
    await page.getByRole("button", { name: "Check bookings" }).click();
    const byDoctor = page.getByRole("table", { name: "Bookings outside the schedule by doctor" });
    await expect(byDoctor.getByRole("row", { name: new RegExp(doctor.name) })).toContainText("2");
    await expect(
      byDoctor.getByRole("row", { name: new RegExp(CONSULTANTS.rahul.name) }),
    ).toContainText("New version");

    if (SHOTS) await page.screenshot({ path: `${SHOTS}/apply-many.png`, fullPage: true });
    await page.getByRole("button", { name: "Save for 2 doctors" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Starts ${longDate(MONDAY)}`);
    await dialog.getByRole("button", { name: "Save schedule" }).click();
    await expect(page.getByText(/Saved for 2 doctors from/)).toBeVisible();
    const saved = await one(
      `SELECT count(*)::int AS n FROM doctor_slot_templates
        WHERE doctor_id = ANY($1) AND effective_from = $2 AND status = 'active'`,
      [[doctor.id, CONSULTANTS.rahul.id], MONDAY],
    );
    expect(saved.n).toBe(2);

    await page.getByRole("button", { name: "Move patients" }).click();
    const modal = page.getByRole("dialog");
    await expect(modal).toContainText("G117 Evening patient");
    await expect(modal).not.toContainText("G117 Late patient");
    await modal.getByRole("combobox").selectOption(String(CONSULTANTS.banshali.id));
    await modal.getByRole("button", { name: "Reassign all" }).click();
    await expect(page.getByText("Reassignment complete")).toBeVisible();
    const row = await one(
      `SELECT doctor_name, time_slot FROM appointments WHERE file_no = 'G117-3'`,
    );
    expect(row).toEqual({ doctor_name: CONSULTANTS.banshali.name, time_slot: "5 PM to 6 PM" });
  });
  test("6. Bulk schedule builds one schedule and saves it for chosen doctors from next Monday", async ({
    page,
  }) => {
    let nextMonday;
    for (let i = 1; !nextMonday; i += 1) {
      const d = istDay(i);
      if (new Date(`${d}T00:00:00Z`).getUTCDay() === 1) nextMonday = d;
    }
    await page.getByRole("button", { name: "Bulk schedule" }).click();
    const bulk = page.getByRole("region", { name: "Bulk schedule" });
    await expect(bulk.getByRole("heading", { name: "Bulk schedule" })).toBeVisible();
    await expect(bulk.getByLabel("Start from")).toHaveValue("");
    await expect(bulk.getByText("Off").first()).toBeVisible();
    await bulk.getByRole("checkbox", { name: "Mon", exact: true }).check();
    await expect(bulk.getByLabel("Mon hours 1 from")).toHaveValue("09:00");
    await bulk.getByRole("button", { name: "Next Monday" }).click();
    await expect(bulk.getByLabel("Applies from")).toHaveValue(nextMonday);
    await expect(bulk.getByRole("radio", { name: /only$/ })).toHaveCount(0);
    await bulk.getByRole("radio", { name: "Choose doctors" }).check();
    await bulk.getByRole("checkbox", { name: CONSULTANTS.rahul.name }).check();
    await bulk.getByRole("checkbox", { name: CONSULTANTS.banshali.name }).check();
    await bulk.getByRole("button", { name: "Save for 2 doctors" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save schedule" }).click();
    await expect(bulk.getByText(/Saved for 2 doctors from/)).toBeVisible();
    const saved = await one(
      `SELECT count(*)::int AS n FROM doctor_slot_templates
        WHERE doctor_id = ANY($1) AND effective_from = $2 AND status = 'active'`,
      [[CONSULTANTS.rahul.id, CONSULTANTS.banshali.id], nextMonday],
    );
    expect(saved.n).toBe(2);
  });
  test("7. Bulk schedule for next month only ends on its own and the doctor goes back to the usual schedule", async ({
    page,
  }) => {
    const rahul = CONSULTANTS.rahul;
    await query(
      `DELETE FROM doctor_slot_templates WHERE doctor_id = $1 AND effective_from > '2026-01-01'`,
      [rahul.id],
    );
    const [y, m] = istDay().split("-").map(Number);
    const first = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
    const dayAfter = new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0, 10);

    await page.getByRole("button", { name: "Bulk schedule" }).click();
    const bulk = page.getByRole("region", { name: "Bulk schedule" });
    await bulk.getByRole("checkbox", { name: "Mon", exact: true }).check();
    await bulk.getByRole("button", { name: "Next month only" }).click();
    await expect(bulk.getByLabel("Applies from")).toHaveValue(first);
    await expect(bulk.getByRole("radio", { name: "Until" })).toBeChecked();
    await expect(bulk.getByLabel("Last day of this schedule")).toHaveValue(last);
    await expect(bulk.getByText(`From ${longDate(dayAfter)} each doctor goes back`)).toBeVisible();

    await bulk.getByRole("radio", { name: "Choose doctors" }).check();
    await bulk.getByRole("checkbox", { name: rahul.name }).check();
    await bulk.getByRole("button", { name: "Check bookings" }).click();
    await expect(
      bulk.getByRole("table", { name: "Bookings outside the schedule by doctor" }),
    ).toContainText("back to usual on");
    await bulk.getByRole("button", { name: "Save for 1 doctor" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`and ends ${longDate(last)}`);
    await dialog.getByRole("button", { name: "Save schedule" }).click();
    await expect(bulk.getByText(/then each goes back to their usual schedule/)).toBeVisible();

    const versions = await query(
      `SELECT effective_from::text FROM doctor_slot_templates
        WHERE doctor_id = $1 AND status = 'active' AND effective_from > '2026-01-01'
        ORDER BY effective_from`,
      [rahul.id],
    );
    expect(versions.rows.map((r) => r.effective_from)).toEqual([first, dayAfter]);
  });
  test("8. limits per slot are typed per block of hours and shown in the saved schedule", async ({
    page,
  }) => {
    await buildMondays(page);
    await page.getByLabel("Mon hours 1 new per slot").fill("3");
    await page.getByLabel("Mon hours 1 follow-up per slot").fill("2");
    await page.getByLabel("Mon hours 1 walk-in per slot").fill("120");
    await expect(
      page.getByText(
        "Mon: walk-ins per slot must be a whole number from 0 to 99, or blank for no limit.",
      ),
    ).toBeVisible();
    await page.getByLabel("Mon hours 1 walk-in per slot").fill("5");
    await page.getByLabel("Applies from").fill(istDay());
    await page.getByRole("button", { name: /^Save/ }).click();
    await expect(
      page.getByRole("table", { name: "Working hours by day" }).getByRole("row", { name: /Mon/ }),
    ).toContainText("9 AM–1 PM · 20 min slots · per slot 3 new, 2 follow-up, 5 walk-in");
  });
});
