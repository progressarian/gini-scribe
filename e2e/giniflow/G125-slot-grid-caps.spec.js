import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const doctor = CONSULTANTS.rahul;
const istDay = (offset = 0) =>
  new Date(Date.now() + offset * 86400000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
const mondayAhead = (from) => {
  for (let i = from; ; i += 1) {
    const d = istDay(i);
    if (new Date(`${d}T00:00:00Z`).getUTCDay() === 1) return d;
  }
};
const MONDAY = mondayAhead(14);
const NEXT_MONDAY = mondayAhead(21);
const TEN = "10 AM to 11 AM";

const template = {
  partialLast: "drop",
  hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    start: "09:00",
    end: "19:00",
    slotMinutes: 60,
    capNew: 3,
  })),
  breaks: [],
  slotCaps: [{ weekday: 1, start: "10:00", capNew: 1, capWithin3: 1 }],
};

let admin;
let reception;

const slotOn = async (date, label = TEN) => {
  const r = await admin.get(`/api/doctors/${doctor.id}/availability?date=${date}`);
  return (await r.json()).slots.find((s) => s.slot_label === label);
};

const book = async (fileNo) => {
  const res = await reception.post("/api/ghm-appointments", {
    data: {
      patient_name: `G125 ${fileNo}`,
      file_no: fileNo,
      doctor_name: doctor.name,
      appointment_date: MONDAY,
      time_slot: TEN,
      visit_type: "FU within 3 days",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return res;
};

const cleanUp = async () => {
  await query(`DELETE FROM appointments WHERE file_no LIKE 'G125-%' OR patient_name LIKE 'G125 %'`);
  await query(`DELETE FROM patients WHERE file_no LIKE 'G125-%'`);
  await query(`DELETE FROM doctor_slot_date_caps WHERE doctor_id = $1`, [doctor.id]);
  await query(
    `DELETE FROM doctor_slot_templates WHERE doctor_id = $1 AND effective_from > '2026-01-01'`,
    [doctor.id],
  );
};

test.describe.serial("G125 hourly slots with four patient-type limits per slot", () => {
  test.beforeAll(async () => {
    await cleanUp();
    admin = await apiAs("admin");
    reception = await apiAs("reception");
    for (const key of ["a", "b"])
      await query(`INSERT INTO patients (name, file_no) VALUES ($1, $2)`, [
        `G125 G125-${key}`,
        `G125-${key}`,
      ]);
    const r = await admin.post(`/api/doctors/${doctor.id}/slot-templates`, {
      data: { effective_from: istDay(), template },
    });
    expect(r.status(), await r.text()).toBe(201);
  });

  test.afterAll(async () => {
    await cleanUp();
    await admin?.dispose();
    await reception?.dispose();
  });

  test("1. a slot's own numbers beat the hours default", async () => {
    const nine = await slotOn(MONDAY, "9 AM to 10 AM");
    expect(nine).toMatchObject({
      cap_source: "hours",
      caps: { walkin: null, new: 3, followup: null, within3: null },
    });
    expect(await slotOn(MONDAY)).toMatchObject({
      cap_source: "slot",
      caps: { walkin: null, new: 1, followup: null, within3: 1 },
    });
  });

  test("2. a 'FU within 3 days' booking counts as Within 3 days and waits over its limit", async () => {
    const first = await (await book("G125-a")).json();
    expect(first.approval).toBeNull();
    const second = await (await book("G125-b")).json();
    expect(second.approval).toMatchObject({ status: "pending", patient_type: "within3", limit: 1 });
    expect((await slotOn(MONDAY)).counts).toMatchObject({ within3: 2, new: 0, pending: 1 });
  });

  test("3. a one-date change wins on that date only, and can be undone", async () => {
    const put = await admin.put(`/api/doctors/${doctor.id}/slot-caps/${MONDAY}`, {
      data: { reason: "Extra review clinic", slots: [{ start: "10:00", capWithin3: 5 }] },
    });
    expect(put.status(), await put.text()).toBe(200);
    expect(await slotOn(MONDAY)).toMatchObject({
      cap_source: "date",
      date_cap_reason: "Extra review clinic",
      caps: { new: null, within3: 5 },
    });
    expect(await slotOn(NEXT_MONDAY)).toMatchObject({ cap_source: "slot", caps: { within3: 1 } });

    const undo = await admin.delete(`/api/doctors/${doctor.id}/slot-caps/${MONDAY}/10:00`);
    expect(undo.status()).toBe(200);
    expect(await slotOn(MONDAY)).toMatchObject({ cap_source: "slot", caps: { within3: 1 } });
  });

  test("4. a past date or a missing reason is refused", async () => {
    const past = await admin.put(`/api/doctors/${doctor.id}/slot-caps/${istDay(-1)}`, {
      data: { reason: "Too late", slots: [{ start: "10:00", capNew: 1 }] },
    });
    expect(past.status()).toBe(400);
    const noReason = await admin.put(`/api/doctors/${doctor.id}/slot-caps/${MONDAY}`, {
      data: { reason: " ", slots: [{ start: "10:00", capNew: 1 }] },
    });
    expect(noReason.status()).toBe(400);
    const notASlot = await admin.put(`/api/doctors/${doctor.id}/slot-caps/${MONDAY}`, {
      data: { reason: "Odd time", slots: [{ start: "10:30", capNew: 1 }] },
    });
    expect(notASlot.status()).toBe(400);
  });

  test("5. on screen: click a slot, set its numbers for the week, save", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/slots", () =>
      page.getByRole("heading", { name: "Slot settings" }),
    );
    await page
      .getByRole("list", { name: "Staff list" })
      .getByRole("button")
      .filter({ hasText: doctor.name })
      .click();
    await page.getByRole("tab", { name: "Schedule" }).click();
    await expect(page).toHaveURL(
      new RegExp(`doctor=${doctor.id}.*tab=schedule|tab=schedule.*doctor=${doctor.id}`),
    );
    await page.reload();
    await expect(page.getByRole("tab", { name: "Schedule" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("heading", { name: doctor.name })).toBeVisible();
    const shown = page.getByRole("table", { name: "Patients per slot, by day" });
    await expect(shown.getByRole("row", { name: /^10 AM/ })).toContainText("N 1 · 3D 1");

    await page.getByRole("button", { name: "Edit schedule" }).click();
    await page.getByRole("button", { name: /Set patients per slot for Tue 9 AM to 10 AM/ }).click();
    const panel = page.getByRole("dialog", { name: /Patients per slot · Tue 9 AM to 10 AM/ });
    await expect(panel).toContainText(doctor.name);
    await panel.getByLabel("Walk-in", { exact: true }).fill("2");
    await panel.getByRole("button", { name: "More within 3 days" }).click();
    await expect(panel.getByLabel("Within 3 days", { exact: true })).toHaveValue("1");
    await panel.getByLabel("Within 3 days", { exact: true }).fill("4");
    await panel.getByLabel(/9 AM on every day/).check();
    if (process.env.DM_SHOTS)
      await page.screenshot({ path: `${process.env.DM_SHOTS}/slot-popup.png` });
    await panel.getByRole("button", { name: "Apply to 6 slots" }).click();
    await expect(panel).toBeHidden();
    await expect(
      page.getByRole("button", { name: /Set patients per slot for Sat 9 AM to 10 AM/ }),
    ).toHaveText("W 2 · N 3 · 3D 4");

    await page.getByRole("button", { name: "Save schedule" }).click();
    await expect(page.getByRole("button", { name: "Edit schedule" })).toBeVisible();
    const { slotCaps } = (
      await (await admin.get(`/api/doctors/${doctor.id}/slot-templates`)).json()
    ).versions[0];
    expect(slotCaps.filter((c) => c.start === "09:00").map((c) => c.weekday)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(slotCaps.find((c) => c.weekday === 1 && c.start === "10:00")).toMatchObject({
      capNew: 1,
      capWithin3: 1,
    });
  });
});
