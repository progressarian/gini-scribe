import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, loginCrm, resetCrm } from "../helpers/crm.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { query } from "../helpers/db.mjs";

const name = (i) => `Dr Home ${String(i).padStart(2, "0")}`;

test.describe("CRM home: paged and filtered lists", () => {
  let users;
  let api;
  const get = async (path, params = {}) =>
    (await api.get(`${path}?${new URLSearchParams(params)}`)).json();

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const seeded = await seedCrmStaff();
    users = seeded.users;
    const hospitalId = seeded.hospitalId;
    const mine = await seedDoctors(
      hospitalId,
      Array.from({ length: 55 }, (_, i) => ({
        full_name: name(i),
        mobile: i < 4 ? null : `98880${String(i).padStart(5, "0")}`,
        territory: "Mohali",
        owner: users.rajesh.crmId,
      })),
    );
    await seedDoctors(
      hospitalId,
      Array.from({ length: 3 }, (_, i) => ({
        full_name: `Dr Other ${i}`,
        mobile: `98881${String(i).padStart(5, "0")}`,
        territory: "Kharar",
        owner: users.sandeep.crmId,
      })),
    );
    await query(`UPDATE crm.doctors SET priority = 'A' WHERE id = ANY($1::uuid[])`, [
      mine.slice(0, 3).map((d) => d.id),
    ]);
    const visit = (doctor, ago) =>
      query(
        `INSERT INTO crm.visits (hospital_id, doctor_id, executive_id, occurred_at)
         VALUES ($1, $2, $3, now() - $4::interval)`,
        [hospitalId, doctor.id, users.rajesh.crmId, ago],
      );
    await visit(mine[0], "30 days");
    await visit(mine[1], "1 hour");
    await visit(mine[5], "61 days");
    const task = (title, status, due) =>
      query(
        `INSERT INTO crm.tasks (hospital_id, title, owner_id, status, due_date, priority)
         VALUES ($1, $2, $3, $4, $5, 'normal')`,
        [hospitalId, title, users.rajesh.crmId, status, due],
      );
    await task("Send brochure", "open", "2020-01-01");
    await task("Book lunch meeting", "in_progress", null);
    await task("Share OPD timings", "open", "2099-01-01");
    const referral = (doctor, patient, status, urgency) =>
      query(
        `INSERT INTO crm.doctor_referrals
           (hospital_id, source, referring_doctor_id, patient_name_raw, status, urgency,
            responsible_executive_id)
         VALUES ($1, 'growth_executive', $2, $3, $4, $5, $6)`,
        [hospitalId, doctor.id, patient, status, urgency, users.rajesh.crmId],
      );
    await referral(mine[10], "Patient Urgent One", "new", "urgent");
    await referral(mine[11], "Patient Routine Two", "contacted", "routine");
    api = await crmApi(users.rajesh);
  });

  test.afterAll(resetCrm);

  test("1. To visit: counts by state, paging, filters", async () => {
    const all = await get("/api/crm/home/due");
    expect(all.counts).toEqual({ all: 54, overdue: 1, due: 1, never_visited: 52 });
    expect(all).toMatchObject({ total: 54, pages: 2 });
    expect(all.rows).toHaveLength(50);
    expect(all.rows[0].full_name).toBe(name(0));
    expect((await get("/api/crm/home/due", { page: 2 })).rows).toHaveLength(4);
    const overdue = await get("/api/crm/home/due", { state: "overdue" });
    expect(overdue.rows.map((r) => r.full_name)).toEqual([name(0)]);
    expect(overdue.counts.all).toBe(54);
    expect((await get("/api/crm/home/due", { priority: "A" })).total).toBe(2);
    expect((await get("/api/crm/home/due", { q: name(7) })).total).toBe(1);
    expect((await get("/api/crm/home/due", { territory: "Kharar" })).total).toBe(0);
  });

  test("2. My doctors: server paging and filters, own doctors only", async () => {
    const all = await get("/api/crm/home/doctors");
    expect(all).toMatchObject({ total: 55, pages: 2, territories: ["Mohali"] });
    expect(all.counts.incomplete).toBe(4);
    expect((await get("/api/crm/home/doctors", { page: 2 })).rows).toHaveLength(5);
    expect((await get("/api/crm/home/doctors", { incomplete: "1" })).total).toBe(4);
    expect((await get("/api/crm/home/doctors", { due: "ok" })).total).toBe(1);
    expect((await get("/api/crm/home/doctors", { q: "9888000054" })).rows[0].full_name).toBe(
      name(54),
    );
    const mohali = await get("/api/crm/home/doctors", { territory: "Mohali", q: name(9) });
    expect(mohali.counts.territory).toBe(55);
    const head = await crmApi(users.virender);
    const everyone = await (await head.get("/api/crm/home/doctors")).json();
    expect(everyone.total).toBe(58);
  });

  test("3. Tasks: buckets", async () => {
    const due = await get("/api/crm/tasks");
    expect(due.counts).toEqual({ due: 1, overdue: 1, upcoming: 2, done: 0 });
    expect(due.rows.map((t) => t.title)).toEqual(["Send brochure"]);
    const upcoming = await get("/api/crm/tasks", { bucket: "upcoming" });
    expect(upcoming.rows.map((t) => t.title)).toEqual(["Share OPD timings", "Book lunch meeting"]);
  });

  test("4. Referrals: status, urgency and search", async () => {
    const all = await get("/api/crm/referrals");
    expect(all).toMatchObject({ total: 2, summary: { open: 2, untouched: 1 } });
    expect(all.counts.by_status).toEqual({ new: 1, contacted: 1 });
    expect((await get("/api/crm/referrals", { status: "contacted" })).rows).toHaveLength(1);
    expect((await get("/api/crm/referrals", { urgency: "urgent" })).rows[0].patient_name_raw).toBe(
      "Patient Urgent One",
    );
    expect((await get("/api/crm/referrals", { q: "routine two" })).total).toBe(1);
  });

  test("5. home summary skips the lists but keeps the counts", async () => {
    const home = await get("/api/crm/home", { lists: 0 });
    expect(home.my_doctors).toEqual([]);
    expect(home.due_summary.total).toBe(54);
    expect(home.performance).toMatchObject({ doctors_assigned: 55, doctors_incomplete: 4 });
  });

  test("5b. bad input is ignored or refused safely", async () => {
    const past = await get("/api/crm/home/doctors", { page: 99 });
    expect(past).toMatchObject({ page: 2, pages: 2 });
    expect(past.rows).toHaveLength(5);
    expect((await get("/api/crm/home/due", { page: "-3" })).page).toBe(1);
    expect((await get("/api/crm/home/due", { page: "abc", state: "nonsense" })).total).toBe(54);
    expect((await get("/api/crm/home/doctors", { priority: "Z", due: "x" })).total).toBe(55);
    expect((await get("/api/crm/home/doctors", { q: "%" })).total).toBe(0);
    expect((await get("/api/crm/home/doctors", { q: "Dr_Home" })).total).toBe(0);
    expect((await get("/api/crm/home/doctors", { q: "x".repeat(5000) })).total).toBe(0);
    expect((await get("/api/crm/tasks", { bucket: "done", page: 7 })).page).toBe(1);
    expect((await get("/api/crm/referrals", { status: "bogus", urgency: "x" })).total).toBe(2);

    const head = await crmApi(users.virender);
    const badOwner = await head.get("/api/crm/assignments?owner=not-a-uuid");
    expect(badOwner.status()).toBe(400);
    expect((await badOwner.json()).error).toBe("Choose an owner from the list");
    for (const data of [
      { doctor_ids: ["nope"], executive_id: users.rajesh.crmId },
      { doctor_ids: "x", executive_id: users.rajesh.crmId },
      { doctor_ids: [crypto.randomUUID()], executive_id: "nope" },
    ]) {
      const r = await head.post("/api/crm/assignments", { data });
      expect(r.status(), JSON.stringify(data)).toBe(400);
    }
    const lastPage = await (await head.get("/api/crm/assignments?owner=all&page=50")).json();
    expect(lastPage).toMatchObject({ page: 2, pages: 2 });
  });

  test("6. in the browser: chips, paging, search, filters kept across tabs", async ({ page }) => {
    await loginCrm(page, api);
    await gotoReady(page, "/crm/home", () => page.getByRole("button", { name: "My doctors" }));
    const due = page.getByRole("region", { name: "Doctors to visit" });
    await expect(due.getByText("54 doctors")).toBeVisible();
    await due.getByRole("button", { name: "Overdue 1" }).click();
    await expect(due.getByText("1 doctor", { exact: true })).toBeVisible();
    await due.getByRole("button", { name: /^All waiting/ }).click();
    await due.getByRole("button", { name: "Next" }).click();
    await expect(due.getByText("Page 2 of 2")).toBeVisible();

    await page.getByRole("button", { name: "My doctors" }).click();
    const mine = page.getByRole("region", { name: "My doctors" });
    await expect(mine.getByText("55 doctors")).toBeVisible();
    await mine.getByRole("searchbox").fill(name(7));
    await expect(mine.getByText("1 doctor", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Tasks" }).click();
    const tasks = page.getByRole("region", { name: "Tasks" });
    await expect(tasks.getByRole("button", { name: /Due now 1/ })).toBeVisible();
    await expect(tasks.getByText("Send brochure")).toBeVisible();
    await tasks.getByRole("button", { name: /Upcoming 2/ }).click();
    await expect(tasks.getByText("Share OPD timings")).toBeVisible();
    await page.getByRole("button", { name: "My doctors" }).click();
    await expect(mine.getByRole("searchbox")).toHaveValue(name(7));
    await mine.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(mine.getByText("55 doctors")).toBeVisible();
    await expect(mine.getByRole("searchbox")).toHaveValue("");
    await mine.getByRole("combobox", { name: "Territory" }).selectOption("Mohali");
    await expect(mine.getByText("Set all 55 in Mohali to")).toBeVisible();
  });
});
