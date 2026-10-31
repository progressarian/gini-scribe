import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

async function appointment(patient, { daysAhead, bookedDaysAgo }) {
  return one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        status, visit_type, created_at)
     VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date + $5::int, '12:30 PM to 1 PM',
             'scheduled', 'Follow-Up', NOW() - make_interval(days => $6::int))
     RETURNING id, appointment_date::text AS day`,
    [patient.id, patient.file_no, patient.name, patient.phone, daysAhead, bookedDaysAgo],
  );
}

test.describe("GHM Booked 10+ Days Ago: every upcoming appointment booked 10+ days ago", () => {
  let patients;
  let appts;
  let admin;

  test.beforeAll(async () => {
    patients = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => buildPatient()));
    appts = {
      soon: await appointment(patients[0], { daysAhead: 3, bookedDaysAgo: 15 }),
      exactlyTen: await appointment(patients[5], { daysAhead: 7, bookedDaysAgo: 10 }),
      bookedRecentlyFarAhead: await appointment(patients[6], { daysAhead: 15, bookedDaysAgo: 2 }),
      later: await appointment(patients[1], { daysAhead: 20, bookedDaysAgo: 12 }),
      nineDays: await appointment(patients[2], { daysAhead: 6, bookedDaysAgo: 9 }),
      today: await appointment(patients[3], { daysAhead: 0, bookedDaysAgo: 30 }),
      past: await appointment(patients[4], { daysAhead: -2, bookedDaysAgo: 30 }),
    };
    admin = await apiAs("admin");
  });

  test.afterAll(async () => {
    const ids = patients.map((p) => p.id);
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [ids]);
    await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
    await admin.dispose();
  });

  const listed = async (params) => {
    const res = await admin.get(`/api/ghm-appointments?limit=500&page=1&${params}`);
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    const mine = new Set(Object.values(appts).map((a) => a.id));
    return { body, ids: body.data.map((r) => r.id).filter((id) => mine.has(id)) };
  };

  test("1. lists every future appointment booked 10+ days ago, oldest booking first", async () => {
    const { ids } = await listed("booked_before_days=10&upcoming=1");
    expect(ids).toEqual([appts.soon.id, appts.later.id, appts.exactlyTen.id]);
    expect(ids).not.toContain(appts.nineDays.id);
    expect(ids).not.toContain(appts.bookedRecentlyFarAhead.id);
    expect(ids).not.toContain(appts.today.id);
    expect(ids).not.toContain(appts.past.id);
  });

  test("2. the date sent with it is ignored, and the summary counts the same rows", async () => {
    const { ids, body } = await listed(
      `booked_before_days=10&upcoming=1&date=${appts.today.day}&q=${encodeURIComponent(patients[1].name)}`,
    );
    expect(ids).toEqual([appts.later.id]);
    expect(body.summary.total).toBe(body.total);
    const row = body.data.find((r) => r.id === appts.later.id);
    expect(row.appointment_date.slice(0, 10)).toBe(appts.later.day);
    expect(row.booking_gap_days).toBe(32);
    expect(row.booked_days_ago).toBe(12);
  });

  test("3. without upcoming=1 the old one-date list still works", async () => {
    const { ids } = await listed(`booked_before_days=10&date=${appts.soon.day}`);
    expect(ids).toEqual([appts.soon.id]);
  });

  test("4. the tab has no date filter and shows the appointment date of each row", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await page.goto("/ghm?tab=booked10");
    await expect(page.getByText(patients[0].name).first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(patients[1].name).first()).toBeVisible();
    await expect(page.getByText(patients[2].name)).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Appointment" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Gap/ })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Booked Ago" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "15 days", exact: true })).toBeVisible();
    await expect(page.getByText(patients[6].name)).toHaveCount(0);
    const tab = page.getByRole("button", { name: /^Booked 10\+ Days Ago/ });
    await expect(tab).toBeVisible();
    await expect(tab.locator(".ghm__tab-date")).toHaveCount(0);
  });
});
