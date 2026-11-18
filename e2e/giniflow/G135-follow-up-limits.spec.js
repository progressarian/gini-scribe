import { test, expect } from "@playwright/test";
import { query, one } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { USERS } from "../fixtures/data.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { followUpDueDate, isClosedDay } from "../../shared/followUp.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

let ids;
let made;
let other;
let seq = 0;
let D;
let D2;
let D3;

const addDays = (ymd, days) => {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

const savedPlan = async (visitId = made.visit) =>
  (
    await query(
      `SELECT next_visit_date::text AS date, next_visit_interval AS interval
         FROM giniflow_care_plans WHERE visit_id = $1`,
      [visitId],
    )
  ).rows[0] || null;

async function appointmentFollowUp(setOn, due, { status = "completed" } = {}) {
  seq += 1;
  const name = `P4 FU${seq} ${tag}`;
  const fileNo = `F4FU${seq}-${tag}`;
  const patient = (
    await one(
      `INSERT INTO patients (name, file_no, age, sex) VALUES ($1, $2, 60, 'Female') RETURNING id`,
      [name, fileNo],
    )
  ).id;
  await query(
    `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status,
                               follow_up_date, visit_type)
     VALUES ($1, $2, $3, $4::date, $5, $6::date, 'Follow Up')`,
    [patient, name, fileNo, setOn, status, due],
  );
  return patient;
}

async function carePlanFollowUp(label, due, { status } = {}) {
  const visit = await extraVisit(ids, label, { healthray: false });
  if (status) {
    await query(`UPDATE giniflow_visits SET current_status = $2 WHERE id = $1`, [
      visit.visit,
      status,
    ]);
  }
  await query(
    `INSERT INTO giniflow_care_plans (visit_id, next_visit_date, next_visit_interval)
     VALUES ($1, $2::date, NULL)`,
    [visit.visit, due],
  );
  return visit;
}

const putLimits = async (api, allowedPerDay, maxPerDay) =>
  api.put("/api/giniflow/follow-up-limits", { data: { allowedPerDay, maxPerDay } });

const load = async (api, from, to, visitId) => {
  const res = await api.get(
    `/api/giniflow/follow-up-load?${new URLSearchParams({ from, to, ...(visitId ? { visitId } : {}) })}`,
  );
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};

const saveDate = async (api, visitId, date, interval) =>
  api.put(`/api/giniflow/stations/doctor/${visitId}/care-plan`, {
    data: { treatment: "Continue", nextVisitDate: date, nextVisitInterval: interval, goals: [] },
  });

test.describe.serial("G135 follow-up limits per day and the follow-up calendar", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    ids = await setUp(tag);
    D = followUpDueDate(ids.day, "30 weeks");
    D2 = followUpDueDate(ids.day, "31 weeks");
    D3 = followUpDueDate(ids.day, "32 weeks");
    made = await extraVisit(ids, "Limits", { healthray: false });
    other = await extraVisit(ids, "Other", { healthray: false });
    for (const v of [made, other]) {
      await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [
        v.visit,
      ]);
    }
    await query(`UPDATE appointments SET status = 'completed', follow_up_date = $2 WHERE id = $1`, [
      made.appointment,
      D,
    ]);

    await appointmentFollowUp(addDays(ids.day, -20), D);
    await appointmentFollowUp(addDays(ids.day, -20), D, { status: "cancelled" });
    const cameBack = await appointmentFollowUp(addDays(ids.day, -20), D);
    await query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status, visit_type)
       SELECT id, name, file_no, $2::date, 'completed', 'Follow Up' FROM patients WHERE id = $1`,
      [cameBack, addDays(ids.day, -3)],
    );
    const moved = await appointmentFollowUp(addDays(ids.day, -30), D);
    await query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status,
                                 follow_up_date, visit_type)
       SELECT id, name, file_no, $2::date, 'completed', $3::date, 'Follow Up' FROM patients WHERE id = $1`,
      [moved, addDays(ids.day, -10), D3],
    );
    await carePlanFollowUp("Planned", D);
    await carePlanFollowUp("Gone", D, { status: "cancelled" });
    for (let i = 0; i < 3; i++) await appointmentFollowUp(addDays(ids.day, -15), D2);
    await query(
      `UPDATE giniflow_follow_up_limits SET allowed_per_day = NULL, max_per_day = NULL WHERE id = 1`,
    );
  });

  test.afterAll(async () => {
    await query(
      `UPDATE giniflow_follow_up_limits SET allowed_per_day = NULL, max_per_day = NULL WHERE id = 1`,
    ).catch(() => {});
    for (const v of [made, other].filter(Boolean)) {
      await query(`DELETE FROM documents WHERE patient_id = $1`, [v.patient]).catch(() => {});
      await query(`DELETE FROM medications WHERE patient_id = $1`, [v.patient]).catch(() => {});
      await query(`DELETE FROM consultations WHERE patient_id = $1`, [v.patient]).catch(() => {});
    }
    await tearDown(ids);
  });

  test("1. only an admin sets the limits, and allowed can't be above max", async () => {
    const admin = await apiAs("admin");
    const doctor = await apiAs("banshali");
    expect((await putLimits(doctor, 5, 10)).status()).toBe(403);
    const wrong = await putLimits(admin, 5, 3);
    expect(wrong.status()).toBe(400);
    expect((await wrong.json()).error).toBe("Allowed per day can't be more than Max per day.");
    expect((await putLimits(admin, 0, null)).status()).toBe(400);
    const open = await putLimits(admin, null, null);
    expect(open.status()).toBe(200);
    expect((await open.json()).limits).toEqual({ allowedPerDay: null, maxPerDay: null });
    const set = await putLimits(admin, 1, 3);
    expect((await set.json()).limits).toEqual({ allowedPerDay: 1, maxPerDay: 3 });
    const read = await admin.get("/api/giniflow/follow-up-limits");
    expect((await read.json()).limits).toEqual({ allowedPerDay: 1, maxPerDay: 3 });
  });

  test("2. each date counts every patient's latest follow-up once, from appointments and Gini Flow", async () => {
    const doctor = await apiAs("banshali");
    const forVisit = await load(doctor, D, D3, made.visit);
    expect(forVisit.limits).toEqual({ allowedPerDay: 1, maxPerDay: 3 });
    expect(forVisit.days[D]).toBe(2);
    expect(forVisit.days[D2]).toBe(3);
    expect(forVisit.days[D3]).toBe(1);
    expect((await load(doctor, D, D)).days[D]).toBe(3);

    const tooLong = await doctor.get(
      `/api/giniflow/follow-up-load?from=${ids.day}&to=${addDays(ids.day, 90)}`,
    );
    expect(tooLong.status()).toBe(400);
  });

  test("3. a full date is refused on save; over the allowed number still saves", async () => {
    const doctor = await apiAs("banshali");
    const first = await saveDate(doctor, made.visit, D, "30 weeks");
    expect(first.status(), await first.text()).toBe(200);
    expect(await savedPlan()).toEqual({ date: D, interval: "30 weeks" });

    const full = await saveDate(doctor, other.visit, D, "30 weeks");
    expect(full.status()).toBe(409);
    expect((await full.json()).error).toMatch(
      /is full — 3 follow-ups already booked \(max 3 a day\)/,
    );
    expect(await savedPlan(other.visit)).toBeNull();

    const fullToo = await saveDate(doctor, other.visit, D2, "31 weeks");
    expect(fullToo.status()).toBe(409);
    const ok = await saveDate(doctor, other.visit, D3, "32 weeks");
    expect(ok.status(), await ok.text()).toBe(200);

    const admin = await apiAs("admin");
    await putLimits(admin, 1, 1);
    const unchanged = await saveDate(doctor, made.visit, D, "30 weeks");
    expect(unchanged.status(), await unchanged.text()).toBe(200);
    await putLimits(admin, 1, 3);
  });

  test("4. the edit-after-finalize, suggestion and fast-path saves keep to the limit", async () => {
    const { clearFollowUpLimitsCache, firstDateWithRoom } =
      await import("../../server/services/giniflow/followUpLoad.js");
    const { saveEditNextVisit } = await import("../../server/services/giniflow/consultEdit.js");
    const { decideSuggestion } = await import("../../server/services/giniflow/planSuggestions.js");
    const { db } = await import("../billing/phase4b/p4b-refunds.mjs");
    clearFollowUpLimitsCache();

    await query(`UPDATE giniflow_visits SET editing_by = $2 WHERE id = $1`, [
      other.visit,
      USERS.admin.id,
    ]);
    const refused = await saveEditNextVisit(
      other.visit,
      { nextVisitDate: D, nextVisitInterval: "30 weeks" },
      { actorId: USERS.admin.id, isAdmin: true },
      db,
    ).catch((e) => e);
    expect(refused.status).toBe(409);
    expect((await savedPlan(other.visit)).date).toBe(D3);

    const suggestion = await one(
      `INSERT INTO giniflow_plan_suggestions (visit_id, field, value)
       VALUES ($1, 'next_visit', $2::jsonb) RETURNING id`,
      [other.visit, JSON.stringify({ date: D2, interval: "31 weeks" })],
    );
    const decided = await decideSuggestion(
      suggestion.id,
      { status: "accepted" },
      USERS.admin.id,
      db,
    ).catch((e) => e);
    expect(decided.status).toBe(409);
    expect(
      (await one(`SELECT status FROM giniflow_plan_suggestions WHERE id = $1`, [suggestion.id]))
        .status,
    ).toBe("proposed");
    await query(`UPDATE giniflow_visits SET editing_by = NULL WHERE id = $1`, [other.visit]);

    const moved = await firstDateWithRoom(other.visit, D2, db);
    expect(moved > D2).toBe(true);
    expect(isClosedDay(moved)).toBe(false);
    expect(await firstDateWithRoom(other.visit, D3, db)).toBe(D3);
  });

  test("5. the doctor sees counts in the calendar, gets the warning, and can't pick a full date", async ({
    page,
  }) => {
    await query(
      `UPDATE giniflow_care_plans SET next_visit_date = NULL, next_visit_interval = NULL
        WHERE visit_id = $1`,
      [made.visit],
    );
    await loginAs(page, "admin");
    const picker = page.getByRole("group", { name: "Next visit after" });
    await gotoReady(page, `/giniflow/station/doctor/${made.visit}`, () => picker);

    await page.getByRole("button", { name: "Follow-ups by date" }).click();
    const calendar = page.getByRole("dialog", { name: "Follow-ups booked per date" });
    await expect(calendar).toBeVisible();
    const months =
      (Number(D.slice(0, 4)) - Number(ids.day.slice(0, 4))) * 12 +
      Number(D.slice(5, 7)) -
      Number(ids.day.slice(5, 7));
    for (let i = 0; i < months; i++) {
      await calendar.getByRole("button", { name: "Next month" }).click();
    }
    const dayButton = (iso) =>
      calendar.getByRole("button", {
        name: new RegExp(`^${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}: `),
      });
    await expect(dayButton(D)).toHaveAccessibleName(/2 follow-ups — over the allowed number$/);
    if (D2.slice(0, 7) === D.slice(0, 7)) {
      await expect(dayButton(D2)).toHaveAccessibleName(/3 follow-ups — full$/);
      await expect(dayButton(D2)).toBeDisabled();
    }
    await dayButton(D).click();
    await expect(calendar).toHaveCount(0);

    await expect(page.locator(".cp-next-date")).toContainText("2 other follow-ups booked");
    await expect(
      page.getByText(
        "This date already has 2 follow-ups — the allowed number is 1 a day. You can still book it.",
      ),
    ).toBeVisible();
    await expect(picker.getByRole("combobox", { name: "Number" })).toHaveValue("30");
    await expect(picker.getByRole("combobox", { name: "Days, weeks or months" })).toHaveValue(
      "weeks",
    );
    await expect.poll(savedPlan, { timeout: 10000 }).toEqual({ date: D, interval: "30 weeks" });

    await picker.getByRole("combobox", { name: "Number" }).selectOption("31");
    await expect(page.locator(".cp-next-full")).toContainText(
      "is full (3 follow-ups, max 3 a day)",
    );
    await page.waitForTimeout(1500);
    expect(await savedPlan()).toEqual({ date: D, interval: "30 weeks" });

    await picker.getByRole("combobox", { name: "Number" }).selectOption("32");
    await expect(page.locator(".cp-next-full")).toHaveCount(0);
    await expect.poll(savedPlan, { timeout: 10000 }).toEqual({ date: D3, interval: "32 weeks" });
  });

  test("6. an admin sets and clears the limits in Settings → Flow", async ({ page }) => {
    await loginAs(page, "admin");
    const section = page.getByRole("region", { name: "Follow-ups per day" });
    await gotoReady(page, "/settings/flow", () => section);
    const allowed = section.getByRole("spinbutton", { name: "Allowed per day" });
    const max = section.getByRole("spinbutton", { name: "Max per day" });
    await expect(allowed).toHaveValue("1");
    await expect(max).toHaveValue("3");

    await allowed.fill("9");
    await max.fill("4");
    await section.getByRole("button", { name: "Save limits" }).click();
    await expect(
      section.getByText("Allowed per day can't be more than Max per day."),
    ).toBeVisible();

    await allowed.fill("40");
    await max.fill("60");
    await section.getByRole("button", { name: "Save limits" }).click();
    await expect
      .poll(async () =>
        one(`SELECT allowed_per_day, max_per_day FROM giniflow_follow_up_limits WHERE id = 1`),
      )
      .toEqual({ allowed_per_day: 40, max_per_day: 60 });

    await allowed.fill("");
    await max.fill("");
    await section.getByRole("button", { name: "Save limits" }).click();
    await expect
      .poll(async () =>
        one(`SELECT allowed_per_day, max_per_day FROM giniflow_follow_up_limits WHERE id = 1`),
      )
      .toEqual({ allowed_per_day: null, max_per_day: null });
  });
});
