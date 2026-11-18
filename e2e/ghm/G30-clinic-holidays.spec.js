import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { USERS } from "../fixtures/data.mjs";
import { addDays, istDate } from "../../server/crm/istPeriods.js";
import { isSunday } from "../../server/crm/daysOff.js";

const json = async (res) => ({ status: res.status(), body: await res.json() });
const sundayAfter = (day) => {
  let d = day;
  while (!isSunday(d)) d = addDays(d, 1);
  return d;
};
const SUNDAY = sundayAfter(addDays(istDate(), 40));
const SATURDAY = addDays(SUNDAY, -1);
const MONDAY = addDays(SUNDAY, 1);
const LONE = addDays(SUNDAY, 3);

test.describe.serial("G30 clinic holidays are set once in Slot settings", () => {
  let admin;
  let reception;

  const cleanUp = () =>
    query(`DELETE FROM clinic_holidays WHERE holiday_date BETWEEN $1::date AND $2::date`, [
      SATURDAY,
      LONE,
    ]);

  test.beforeAll(async () => {
    await cleanUp();
    admin = await apiAs("admin");
    reception = await apiAs("reception");
  });

  test.afterAll(async () => {
    await query(`DELETE FROM appointments WHERE patient_name = 'G30 Holiday Patient'`);
    await cleanUp();
  });

  test("1. only an admin adds holidays, and Sundays are left out of a range", async () => {
    const byReception = await json(
      await reception.post("/api/clinic-holidays", {
        data: { from: SATURDAY, to: MONDAY, title: "G30 Festival" },
      }),
    );
    expect(byReception.status).toBe(403);

    const added = await json(
      await admin.post("/api/clinic-holidays", {
        data: { from: SATURDAY, to: MONDAY, title: "G30 Festival" },
      }),
    );
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ days: 2, booked: 0 });

    const rows = await query(
      `SELECT holiday_date::text AS day, remarks, created_by_id FROM clinic_holidays
        WHERE holiday_date BETWEEN $1::date AND $2::date ORDER BY holiday_date`,
      [SATURDAY, MONDAY],
    );
    expect(rows.rows.map((r) => r.day)).toEqual([SATURDAY, MONDAY]);
    expect(rows.rows[0]).toMatchObject({ remarks: "G30 Festival", created_by_id: USERS.admin.id });

    const audit = await one(
      `SELECT action, title, actor_id, actor_name FROM clinic_holiday_audit
        WHERE holiday_date = $1 ORDER BY id DESC LIMIT 1`,
      [SATURDAY],
    );
    expect(audit).toMatchObject({
      action: "added",
      title: "G30 Festival",
      actor_id: USERS.admin.id,
      actor_name: USERS.admin.name,
    });
  });

  test("2. repeats, blank names, Sunday-only and long ranges are refused", async () => {
    const again = await json(
      await admin.post("/api/clinic-holidays", { data: { from: MONDAY, title: "Again" } }),
    );
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already a holiday \(G30 Festival\)/);

    const noName = await json(
      await admin.post("/api/clinic-holidays", { data: { from: LONE, title: " " } }),
    );
    expect(noName.status).toBe(400);
    expect(noName.body.error).toBe("Enter the holiday name, like Diwali.");

    const sunday = await json(
      await admin.post("/api/clinic-holidays", { data: { from: SUNDAY, title: "Sunday" } }),
    );
    expect(sunday.status).toBe(400);
    expect(sunday.body.error).toMatch(/not a Sunday/);

    const long = await json(
      await admin.post("/api/clinic-holidays", {
        data: { from: LONE, to: addDays(LONE, 40), title: "Too long" },
      }),
    );
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/31 days or fewer/);
  });

  test("3. adding a holiday reports patients already booked that day", async () => {
    await query(
      `INSERT INTO appointments (patient_name, appointment_date, visit_type, status)
       VALUES ('G30 Holiday Patient', $1::date, 'Follow Up', 'scheduled')`,
      [LONE],
    );
    const added = await json(
      await admin.post("/api/clinic-holidays", { data: { from: LONE, title: "G30 Lone Day" } }),
    );
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ days: 1, booked: 1 });
  });

  test("4. every staff login can read the calendar", async () => {
    const list = await json(await reception.get("/api/clinic-holidays"));
    expect(list.status).toBe(200);
    const mine = list.body.holidays.filter((h) => h.day >= SATURDAY && h.day <= LONE);
    expect(mine.map((h) => [h.day, h.title])).toEqual([
      [SATURDAY, "G30 Festival"],
      [MONDAY, "G30 Festival"],
      [LONE, "G30 Lone Day"],
    ]);
    expect(mine[0].added_by).toBe(USERS.admin.name);
    expect(mine[2].booked).toBe(1);
    expect(list.body.limits.from < list.body.today).toBe(true);
  });

  test("5. removing is admin-only and written to the audit trail", async () => {
    const { id } = await one(`SELECT id FROM clinic_holidays WHERE holiday_date = $1`, [LONE]);
    const byReception = await json(await reception.delete(`/api/clinic-holidays/${id}`));
    expect(byReception.status).toBe(403);

    const removed = await json(await admin.delete(`/api/clinic-holidays/${id}`));
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ day: LONE, title: "G30 Lone Day" });

    const audit = await one(
      `SELECT action, previous_title, actor_id FROM clinic_holiday_audit
        WHERE holiday_date = $1 ORDER BY id DESC LIMIT 1`,
      [LONE],
    );
    expect(audit).toMatchObject({
      action: "removed",
      previous_title: "G30 Lone Day",
      actor_id: USERS.admin.id,
    });

    const twice = await json(await admin.delete(`/api/clinic-holidays/${id}`));
    expect(twice.status).toBe(404);
  });
});
