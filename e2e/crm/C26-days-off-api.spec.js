import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { seedCrmStaff, seedDoctors, crmApi, resetCrm } from "../helpers/crm.mjs";
import { one, query } from "../helpers/db.mjs";
import { addDays, istDate } from "../../server/crm/istPeriods.js";
import { isSunday } from "../../server/crm/daysOff.js";

const json = async (res) => ({ status: res.status(), body: await res.json() });
const today = istDate();
const nextWeekday = (day) => (isSunday(day) ? addDays(day, 1) : day);
const SEP = { from: "2026-09-01", to: "2026-09-30" };
const septemberWeekdays = () => {
  let n = 0;
  for (let d = SEP.from; d <= SEP.to; d = addDays(d, 1)) if (!isSunday(d)) n += 1;
  return n;
};

test.describe("CRM holidays and leave: rules, approval and working-day averages", () => {
  let users;
  let rajesh;
  let sandeep;
  let virender;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const seeded = await seedCrmStaff();
    users = seeded.users;
    const [mine, theirs] = await seedDoctors(seeded.hospitalId, [
      { full_name: "Dr Off One", owner: users.rajesh.crmId },
      { full_name: "Dr Off Two", owner: users.sandeep.crmId },
    ]);
    const visit = (doctor, rep, day) =>
      one(
        `INSERT INTO crm.visits (hospital_id, doctor_id, executive_id, occurred_at, visit_type, source)
         VALUES ($1, $2, $3, ($4::date + time '11:00') AT TIME ZONE 'Asia/Kolkata', 'in_person', 'app')
         RETURNING id`,
        [seeded.hospitalId, doctor.id, rep, day],
      );
    await visit(mine, users.rajesh.crmId, "2026-09-01");
    await visit(mine, users.rajesh.crmId, "2026-09-08");
    await visit(mine, users.rajesh.crmId, "2026-09-20");
    await visit(theirs, users.sandeep.crmId, "2026-09-02");
    rajesh = await crmApi(users.rajesh);
    sandeep = await crmApi(users.sandeep);
    virender = await crmApi(users.virender);
  });

  test.afterAll(resetCrm);

  test("1. Only an admin adds holidays; Sundays and repeats are refused", async () => {
    const byRep = await json(
      await rajesh.post("/api/crm/holidays", { data: { from: "2026-09-15", title: "Festival" } }),
    );
    expect(byRep.status).toBe(403);

    const noName = await json(
      await virender.post("/api/crm/holidays", { data: { from: "2026-09-15" } }),
    );
    expect(noName.status).toBe(400);
    expect(noName.body.fields.title).toMatch(/holiday name/);

    const sunday = await json(
      await virender.post("/api/crm/holidays", { data: { from: "2026-09-13", title: "Sunday" } }),
    );
    expect(sunday.status).toBe(400);
    expect(sunday.body.error).toMatch(/not a Sunday/);

    const added = await json(
      await virender.post("/api/crm/holidays", {
        data: { from: "2026-09-15", to: "2026-09-15", title: "Test Festival" },
      }),
    );
    expect(added.status).toBe(200);
    expect(added.body.days).toBe(1);

    const again = await json(
      await virender.post("/api/crm/holidays", { data: { from: "2026-09-15", title: "Again" } }),
    );
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already a holiday \(Test Festival\)/);

    const list = await json(await rajesh.get("/api/crm/days-off"));
    expect(list.body.holidays.map((h) => h.title)).toContain("Test Festival");
  });

  test("2. A rep's leave waits for approval and stays inside the allowed window", async () => {
    const start = nextWeekday(addDays(today, 10));
    const tooFar = await json(
      await rajesh.post("/api/crm/leave", { data: { from: addDays(today, 100) } }),
    );
    expect(tooFar.status).toBe(400);
    expect(tooFar.body.error).toMatch(/Leave can be requested from/);

    const halfRange = await json(
      await rajesh.post("/api/crm/leave", {
        data: { from: start, to: addDays(start, 1), half_day: true },
      }),
    );
    expect(halfRange.status).toBe(400);
    expect(halfRange.body.fields.half_day).toMatch(/one date/);

    const asked = await json(
      await rajesh.post("/api/crm/leave", {
        data: { from: start, to: start, note: "Family function" },
      }),
    );
    expect(asked.status).toBe(200);
    expect(asked.body.status).toBe("pending");

    const clash = await json(await rajesh.post("/api/crm/leave", { data: { from: start } }));
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/You already have leave/);

    const selfApprove = await json(
      await rajesh.post(`/api/crm/leave/${asked.body.request_id}/approve`, { data: {} }),
    );
    expect(selfApprove.status).toBe(403);

    const noNote = await json(
      await virender.post(`/api/crm/leave/${asked.body.request_id}/reject`, { data: {} }),
    );
    expect(noNote.status).toBe(400);

    const lead = await json(await virender.get("/api/crm/days-off"));
    expect(lead.body.pending).toBe(1);
    expect(lead.body.leave[0]).toMatchObject({ full_name: "Rajesh Sharma", status: "pending" });

    const ok = await json(
      await virender.post(`/api/crm/leave/${asked.body.request_id}/approve`, { data: {} }),
    );
    expect(ok.status).toBe(200);
    const twice = await json(
      await virender.post(`/api/crm/leave/${asked.body.request_id}/approve`, { data: {} }),
    );
    expect(twice.status).toBe(409);

    const cancelApproved = await json(
      await rajesh.post(`/api/crm/leave/${asked.body.request_id}/cancel`, { data: {} }),
    );
    expect(cancelApproved.status).toBe(409);
    expect(cancelApproved.body.error).toMatch(/Ask your admin/);

    const byAdmin = await json(
      await virender.post(`/api/crm/leave/${asked.body.request_id}/cancel`, { data: {} }),
    );
    expect(byAdmin.status).toBe(200);
  });

  test("3. A rep sees only their own leave and can cancel a pending request", async () => {
    const day = nextWeekday(addDays(today, 20));
    const theirs = await json(await sandeep.post("/api/crm/leave", { data: { from: day } }));
    expect(theirs.status).toBe(200);

    const mine = await json(await rajesh.get("/api/crm/days-off?status=all"));
    expect(mine.body.leave.every((l) => l.full_name === "Rajesh Sharma")).toBe(true);

    const rows = await query(`SELECT count(*)::int AS n FROM crm.days_off WHERE request_id = $1`, [
      theirs.body.request_id,
    ]);
    expect(rows.rows[0].n).toBe(1);
    const notYours = await json(
      await rajesh.post(`/api/crm/leave/${theirs.body.request_id}/cancel`, { data: {} }),
    );
    expect(notYours.status).toBe(404);

    const cancelled = await json(
      await sandeep.post(`/api/crm/leave/${theirs.body.request_id}/cancel`, { data: {} }),
    );
    expect(cancelled.status).toBe(200);
    const after = await one(`SELECT status FROM crm.days_off WHERE request_id = $1`, [
      theirs.body.request_id,
    ]);
    expect(after.status).toBe("cancelled");
  });

  test("4. Visits per working day leaves out Sundays, holidays and approved leave", async () => {
    const full = await json(
      await virender.post("/api/crm/leave", {
        data: { from: "2026-09-16", user_id: users.rajesh.crmId },
      }),
    );
    expect(full.body.status).toBe("approved");
    const half = await json(
      await virender.post("/api/crm/leave", {
        data: { from: "2026-09-17", half_day: true, user_id: users.rajesh.crmId },
      }),
    );
    expect(half.body.days).toBe(0.5);
    const ownList = await json(await rajesh.get("/api/crm/days-off?status=all"));
    expect(ownList.body.leave.find((l) => l.from_day === "2026-09-16")).toMatchObject({
      status: "approved",
      added_by_admin: true,
    });
    const pending = await json(
      await rajesh.post("/api/crm/leave", { data: { from: nextWeekday(addDays(today, 30)) } }),
    );
    expect(pending.status).toBe(200);

    const weekdays = septemberWeekdays();
    const own = await json(await rajesh.get(`/api/crm/progress?${new URLSearchParams(SEP)}`));
    expect(own.status).toBe(200);
    const working = weekdays - 1 - 1 - 0.5;
    expect(own.body.cards.visits).toMatchObject({
      visits: 3,
      working_days: working,
      days_off: 2.5,
      per_working_day: Math.round((3 / working) * 10) / 10,
    });

    const days = own.body.trend.buckets;
    expect(days.find((b) => b.start === "2026-09-13")).toBeUndefined();
    expect(days.find((b) => b.start === "2026-09-20")).toMatchObject({
      visits: 1,
      off: { kind: "sunday" },
    });
    expect(days.find((b) => b.start === "2026-09-15").off).toEqual({
      kind: "holiday",
      title: "Test Festival",
    });
    expect(days.find((b) => b.start === "2026-09-16").off).toEqual({ kind: "leave", half: false });
    expect(days.find((b) => b.start === "2026-09-17").off).toEqual({ kind: "leave", half: true });

    const team = await json(
      await virender.get(`/api/crm/progress?${new URLSearchParams({ ...SEP, rep: "all" })}`),
    );
    const teamWorking = 2 * (weekdays - 1) - 1.5;
    expect(team.body.cards.visits.working_days).toBe(teamWorking);
    expect(team.body.cards.visits.per_working_day).toBe(Math.round((4 / teamWorking) * 10) / 10);
    const rajeshRow = team.body.staff.find((s) => s.id === users.rajesh.crmId);
    expect(rajeshRow.visits.working_days).toBe(working);
    expect(team.body.trend.buckets.find((b) => b.start === "2026-09-16").off).toBeNull();

    const weekly = await json(
      await rajesh.get(`/api/crm/progress?${new URLSearchParams({ ...SEP, group: "week" })}`),
    );
    const week = weekly.body.trend.buckets.find((b) => b.start === "2026-09-14");
    expect(week.working_days).toBe(6 - 1 - 1 - 0.5);

    const res = await rajesh.get(`/api/crm/progress/export.xlsx?${new URLSearchParams(SEP)}`);
    expect(res.status()).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await res.body());
    const summary = book.getWorksheet("Summary");
    const labels = summary.getColumn(1).values;
    expect(labels).toContain("Visits per working day");
  });

  test("5. Home shows this month's visits per working day", async () => {
    const home = await json(await rajesh.get("/api/crm/home?lists=0"));
    expect(home.status).toBe(200);
    expect(home.body.performance).toHaveProperty("working_days_month");
    expect(home.body.performance).toHaveProperty("per_working_day_month");
  });

  test("6. Removing a holiday is soft and admin-only", async () => {
    const list = await json(await virender.get("/api/crm/days-off"));
    const festival = list.body.holidays.find((h) => h.title === "Test Festival");
    const byRep = await json(await rajesh.post(`/api/crm/holidays/${festival.request_id}/remove`));
    expect(byRep.status).toBe(403);
    const removed = await json(
      await virender.post(`/api/crm/holidays/${festival.request_id}/remove`),
    );
    expect(removed.status).toBe(200);
    const row = await one(`SELECT deleted_at FROM crm.days_off WHERE request_id = $1`, [
      festival.request_id,
    ]);
    expect(row.deleted_at).not.toBeNull();
    const own = await json(await rajesh.get(`/api/crm/progress?${new URLSearchParams(SEP)}`));
    expect(own.body.cards.visits.working_days).toBe(septemberWeekdays() - 1.5);
  });
});
