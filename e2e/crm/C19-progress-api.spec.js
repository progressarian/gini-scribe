import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { seedCrmStaff, seedDoctors, crmApi, resetCrm } from "../helpers/crm.mjs";
import { one, query } from "../helpers/db.mjs";
import {
  addDays,
  addMonths,
  istDate,
  mondayOf,
  monthEndOf,
  monthStartOf,
} from "../../server/crm/istPeriods.js";

const SEP = { from: "2026-09-01", to: "2026-09-30" };

test.describe("CRM progress: numbers, scope and validation", () => {
  let users;
  let rajesh;
  let sandeep;
  let virender;
  let docs;
  let territories;

  const report = async (api, params = {}) => {
    const res = await api.get(`/api/crm/progress?${new URLSearchParams(params)}`);
    return { status: res.status(), body: await res.json() };
  };

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const seeded = await seedCrmStaff();
    users = seeded.users;
    const hospitalId = seeded.hospitalId;
    territories = Object.fromEntries(
      (await query(`SELECT id, name FROM crm.territories`)).rows.map((t) => [t.name, t.id]),
    );
    const mine = await seedDoctors(hospitalId, [
      { full_name: "Dr P One", territory: "Mohali", owner: users.rajesh.crmId },
      { full_name: "Dr P Two", territory: "Mohali", owner: users.rajesh.crmId },
      { full_name: "Dr P Three", territory: "Kharar", owner: users.rajesh.crmId },
      { full_name: "Dr P Four", territory: "Kharar", owner: users.rajesh.crmId },
    ]);
    const theirs = await seedDoctors(hospitalId, [
      { full_name: "Dr S One", territory: "Kharar", owner: users.sandeep.crmId },
      { full_name: "Dr S Two", territory: "Kharar", owner: users.sandeep.crmId },
    ]);
    docs = { mine, theirs };
    const visit = (doctor, rep, day, time, extra = {}) =>
      one(
        `INSERT INTO crm.visits (hospital_id, doctor_id, executive_id, occurred_at, visit_type,
                                 outcome, next_visit_date, source)
         VALUES ($1, $2, $3, ($4::date + $5::time) AT TIME ZONE 'Asia/Kolkata', $6, $7, $8, $9)
         RETURNING id`,
        [
          hospitalId,
          doctor.id,
          rep,
          day,
          time,
          extra.type ?? "in_person",
          extra.outcome ?? null,
          extra.next ?? null,
          extra.source ?? "app",
        ],
      );
    const r = users.rajesh.crmId;
    await visit(mine[0], r, "2026-09-01", "10:00", { outcome: "positive", next: "2026-09-15" });
    await visit(mine[1], r, "2026-09-01", "00:30", {
      type: "phone",
      outcome: "doctor_unavailable",
      source: "sheet",
    });
    await visit(mine[0], r, "2026-09-08", "11:00", { type: "whatsapp" });
    await visit(mine[2], r, "2026-08-31", "23:30");
    const gone = await visit(mine[3], r, "2026-09-10", "10:00");
    await query(`UPDATE crm.visits SET deleted_at = now() WHERE id = $1`, [gone.id]);
    await visit(theirs[0], users.sandeep.crmId, "2026-09-02", "10:00");

    const referral = (doctor, rep, at, status, attribution, lost) =>
      query(
        `INSERT INTO crm.doctor_referrals
           (hospital_id, source, referring_doctor_id, patient_name_raw, status, urgency,
            responsible_executive_id, referred_at, attribution_status, verified_at, lost_reason)
         VALUES ($1, 'growth_executive', $2, 'Patient', $3, 'routine', $4,
                 ($5::date + time '10:00') AT TIME ZONE 'Asia/Kolkata', $6,
                 CASE WHEN $6 = 'verified' THEN now() END, $7)`,
        [hospitalId, doctor.id, status, rep, at, attribution, lost ?? null],
      );
    await referral(mine[0], r, "2026-09-05", "consulted", "verified");
    await referral(mine[1], r, "2026-09-06", "lost", "claimed", "Went elsewhere");
    await referral(mine[2], r, "2026-08-20", "new", "claimed");
    await referral(theirs[0], users.sandeep.crmId, "2026-09-07", "new", "claimed");

    const task = (rep, status, due, completed) =>
      query(
        `INSERT INTO crm.tasks (hospital_id, title, owner_id, status, due_date, completed_at, priority)
         VALUES ($1, 'Task', $2, $3, $4,
                 CASE WHEN $5::date IS NULL THEN NULL
                      ELSE ($5::date + time '12:00') AT TIME ZONE 'Asia/Kolkata' END, 'normal')`,
        [hospitalId, rep, status, due, completed],
      );
    await task(r, "done", "2026-09-05", "2026-09-03");
    await task(r, "done", "2026-09-04", "2026-09-10");
    await task(r, "open", "2020-01-01", null);
    await task(users.sandeep.crmId, "open", "2020-01-01", null);

    rajesh = await crmApi(users.rajesh);
    sandeep = await crmApi(users.sandeep);
    virender = await crmApi(users.virender);
  });

  test.afterAll(resetCrm);

  test("1. A rep's month: visits, unique doctors, coverage, IST day edges, deleted visits ignored", async () => {
    const { status, body } = await report(rajesh, SEP);
    expect(status).toBe(200);
    expect(body.cards.visits).toMatchObject({
      visits: 3,
      unique_doctors: 2,
      assigned: 4,
      covered: 2,
      coverage_pct: 50,
      doctor_unavailable: 1,
      follow_ups: 1,
      from_sheet: 1,
      never_visited_now: 1,
    });
    expect(body.filters.previous).toEqual({ from: "2026-08-02", to: "2026-08-31" });
    expect(body.previous_cards.visits.visits).toBe(1);
  });

  test("2. Referrals and tasks for the period and as of now", async () => {
    const { body } = await report(rajesh, SEP);
    expect(body.cards.referrals).toEqual({
      logged: 2,
      verified: 1,
      claimed: 1,
      reached: 1,
      lost: 1,
      untouched_now: 1,
    });
    expect(body.cards.tasks).toEqual({ completed: 2, on_time: 1, overdue_now: 1 });
  });

  test("3. Trend buckets by day, week and month, empty days are zero", async () => {
    const day = (await report(rajesh, SEP)).body.trend;
    expect(day.group).toBe("day");
    expect(day.buckets).toHaveLength(30);
    expect(day.buckets[0]).toMatchObject({ start: "2026-09-01", visits: 2, unique_doctors: 2 });
    expect(day.buckets[1]).toMatchObject({ start: "2026-09-02", visits: 0 });
    const week = (await report(rajesh, { ...SEP, group: "week" })).body.trend;
    expect(week.buckets[0]).toMatchObject({
      start: "2026-08-31",
      visits: 2,
      label: "Week of 31 Aug",
    });
    expect(week.buckets[1]).toMatchObject({ start: "2026-09-07", visits: 1 });
    const month = (await report(virender, { ...SEP, group: "month" })).body.trend;
    expect(month.buckets).toEqual([
      expect.objectContaining({ start: "2026-09-01", label: "Sep 2026", visits: 4 }),
    ]);
    expect(month.buckets[0].by_rep[users.rajesh.crmId]).toBe(3);
    expect(month.buckets[0].by_rep[users.sandeep.crmId]).toBe(1);
  });

  test("4. Head of growth: all staff, one rep, staff rows add up", async () => {
    const all = (await report(virender, SEP)).body;
    expect(all.can_pick_staff).toBe(true);
    expect(all.filters.rep).toBe("all");
    expect(all.cards.visits).toMatchObject({
      visits: 4,
      unique_doctors: 3,
      assigned: 6,
      covered: 3,
    });
    const byName = Object.fromEntries(all.staff.map((s) => [s.full_name, s]));
    expect(byName["Rajesh Sharma"].visits).toMatchObject({ visits: 3, coverage_pct: 50 });
    expect(byName["Sandeep Sangroy"].visits).toMatchObject({ visits: 1, assigned: 2, covered: 1 });
    expect(byName["Virender Satija"].visits).toMatchObject({ visits: 0, coverage_pct: null });
    expect(all.staff.reduce((n, s) => n + s.visits.visits, 0)).toBe(all.cards.visits.visits);
    const one = (await report(virender, { ...SEP, rep: users.sandeep.crmId })).body;
    expect(one.cards.visits.visits).toBe(1);
    expect(one.staff).toEqual([]);
  });

  test("5. A rep only ever sees their own numbers", async () => {
    const res = await report(rajesh, { ...SEP, rep: users.sandeep.crmId });
    expect(res.status).toBe(200);
    expect(res.body.can_pick_staff).toBe(false);
    expect(res.body.filters.rep).toBe(users.rajesh.crmId);
    expect(res.body.cards.visits.visits).toBe(3);
    expect(res.body.staff_options).toEqual([]);
    expect(res.body.staff).toEqual([]);
    expect(res.body.trend.reps.map((r) => r.full_name)).toEqual(["Rajesh Sharma"]);
    expect(JSON.stringify(res.body)).not.toContain("Sandeep");
    const other = (await report(sandeep, SEP)).body;
    expect(other.cards.visits.visits).toBe(1);
    expect(other.cards.tasks.overdue_now).toBe(1);
    expect(JSON.stringify(other)).not.toContain("Rajesh");
  });

  test("6. Breakdowns and the territory filter", async () => {
    const { body } = await report(rajesh, SEP);
    expect(body.breakdowns.type).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "in_person", label: "In person", count: 1 }),
        expect.objectContaining({ value: "phone", count: 1 }),
        expect.objectContaining({ value: "whatsapp", count: 1 }),
      ]),
    );
    expect(body.breakdowns.source).toEqual([
      expect.objectContaining({ value: "app", count: 2 }),
      expect.objectContaining({ value: "sheet", label: "From sheet", count: 1 }),
    ]);
    expect(body.breakdowns.outcome.map((o) => [o.label, o.count])).toEqual([
      ["Doctor unavailable", 1],
      ["No outcome", 1],
      ["Positive", 1],
    ]);
    const mohali = (await report(virender, { ...SEP, territory: territories.Mohali })).body;
    expect(mohali.cards.visits).toMatchObject({ visits: 3, assigned: 2, covered: 2 });
    expect(mohali.breakdowns.territory).toEqual([
      expect.objectContaining({ label: "Mohali", count: 3 }),
    ]);
  });

  test("7. Visited and not-visited doctor lists", async () => {
    const get = async (api, params) =>
      (await api.get(`/api/crm/progress/doctors?${new URLSearchParams(params)}`)).json();
    const visited = await get(rajesh, { ...SEP, state: "visited" });
    expect(visited.rows.map((r) => [r.full_name, r.visits])).toEqual([
      ["Dr P One", 2],
      ["Dr P Two", 1],
    ]);
    expect(visited.rows[0]).toMatchObject({ rep: "Rajesh Sharma" });
    const missing = await get(rajesh, { ...SEP, state: "not_visited" });
    expect(missing.rows.map((r) => r.full_name).sort()).toEqual(["Dr P Four", "Dr P Three"]);
    const search = await get(rajesh, { ...SEP, state: "not_visited", q: "four" });
    expect(search.rows.map((r) => r.full_name)).toEqual(["Dr P Four"]);
    const team = await get(virender, { ...SEP, state: "not_visited" });
    expect(team.total).toBe(3);
    const far = await get(rajesh, { ...SEP, state: "visited", page: 99 });
    expect(far).toMatchObject({ page: 1, pages: 1 });
  });

  test("8. Bad dates, staff and territory are refused with a clear message", async () => {
    const cases = [
      [{ from: "2026-09-30", to: "2026-09-01" }, "The From date must be on or before the To date."],
      [{ from: "2026-09-01", to: addDays(istDate(), 1) }, "The To date cannot be in the future."],
      [{ from: "2025-01-01", to: "2026-09-01" }, "Choose a range of one year or less."],
      [{ from: "2026-02-30", to: "2026-03-01" }, "Choose a From and To date, like 01-10-2026."],
      [{ period: "custom" }, "Choose a From and To date, like 01-10-2026."],
      [{ ...SEP, territory: "nope" }, "Choose a territory from the list."],
    ];
    for (const [params, message] of cases) {
      const res = await report(rajesh, params);
      expect(res.status, JSON.stringify(params)).toBe(400);
      expect(res.body.error).toBe(message);
    }
    const stranger = await report(virender, {
      ...SEP,
      rep: "11111111-1111-1111-1111-111111111111",
    });
    expect(stranger.status).toBe(400);
    expect(stranger.body.error).toBe("Choose a staff member from the list.");
  });

  test("9. Period presets resolve to India-time dates", async () => {
    const today = istDate();
    const monday = mondayOf(today);
    const expectRange = async (period, from, to) => {
      const { body } = await report(rajesh, { period });
      expect(body.filters, period).toMatchObject({ period, from, to });
    };
    await expectRange("today", today, today);
    await expectRange("yesterday", addDays(today, -1), addDays(today, -1));
    await expectRange("this_week", monday, today);
    await expectRange("last_week", addDays(monday, -7), addDays(monday, -1));
    await expectRange("this_month", monthStartOf(today), today);
    await expectRange("last_month", addMonths(today, -1), monthEndOf(addMonths(today, -1)));
    const def = (await report(rajesh)).body.filters;
    expect(def).toMatchObject({ period: "this_month", from: monthStartOf(today), to: today });
    expect(def.previous.from).toBe(addMonths(today, -1));
  });

  test("10. Export: same numbers; a rep's file has no Staff tab", async () => {
    const load = async (api) => {
      const res = await api.get(`/api/crm/progress/export.xlsx?${new URLSearchParams(SEP)}`);
      expect(res.ok()).toBeTruthy();
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(await res.body());
      return { book, disposition: res.headers()["content-disposition"] };
    };
    const mine = await load(rajesh);
    expect(mine.book.worksheets.map((w) => w.name)).toEqual([
      "Summary",
      "Trend",
      "Visited doctors",
      "Not visited",
    ]);
    const summary = mine.book.getWorksheet("Summary");
    const visits = summary.getRows(2, 20).find((r) => r.getCell(1).value === "Visits");
    expect([visits.getCell(2).value, visits.getCell(3).value]).toEqual([3, 1]);
    expect(mine.disposition).toContain("crm-progress-rajesh-sharma-2026-09-01-to-2026-09-30.xlsx");
    const team = await load(virender);
    const staff = team.book.getWorksheet("Staff");
    const total = staff.getRows(2, 10).find((r) => r.getCell(1).value === "Team total");
    expect(total.getCell(2).value).toBe(4);
  });

  test("11. Odd input never breaks the report: impossible months, repeated params", async () => {
    for (const params of [
      { from: "2026-13-01", to: "2026-13-05" },
      { from: "2026-00-10", to: "2026-01-10" },
    ]) {
      const res = await report(rajesh, params);
      expect(res.status, JSON.stringify(params)).toBe(400);
      expect(res.body.error).toBe("Choose a From and To date, like 01-10-2026.");
    }
    const repeated = await rajesh.get(
      `/api/crm/progress?from=2026-09-01&from=2026-09-02&to=2026-09-30`,
    );
    expect(repeated.status()).toBe(400);
    const odd = await report(rajesh, { period: "fortnight", group: "hour", page: "x" });
    expect(odd.status).toBe(200);
    expect(odd.body.filters.period).toBe("this_month");
    const list = await rajesh.get(
      `/api/crm/progress/doctors?${new URLSearchParams({ ...SEP, state: "weird", page: "-4", q: "%_" })}`,
    );
    expect(list.status()).toBe(200);
    expect((await list.json()).rows).toEqual([]);
  });

  test("12. A rep's doctor list and export ignore another rep's id", async () => {
    const list = await (
      await rajesh.get(
        `/api/crm/progress/doctors?${new URLSearchParams({ ...SEP, state: "visited", rep: users.sandeep.crmId })}`,
      )
    ).json();
    expect(list.rows.map((r) => r.full_name)).toEqual(["Dr P One", "Dr P Two"]);
    const res = await rajesh.get(
      `/api/crm/progress/export.xlsx?${new URLSearchParams({ ...SEP, rep: "all" })}`,
    );
    expect(res.headers()["content-disposition"]).toContain("crm-progress-rajesh-sharma-");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await res.body());
    expect(book.getWorksheet("Staff")).toBeUndefined();
  });

  test("13. Trend labels carry the year when the range spans two years", async () => {
    const { body } = await report(virender, { from: "2025-12-30", to: "2026-01-02", group: "day" });
    expect(body.trend.buckets.map((b) => b.label)).toEqual([
      "30 Dec 2025",
      "31 Dec 2025",
      "1 Jan 2026",
      "2 Jan 2026",
    ]);
    const plain = (await report(virender, SEP)).body.trend.buckets[0].label;
    expect(plain).toBe("1 Sep");
  });
});
