import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, loginCrm, resetCrm } from "../helpers/crm.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one } from "../helpers/db.mjs";
import { addDays, istDate } from "../../server/crm/istPeriods.js";

const json = async (res) => ({ status: res.status(), body: await res.json() });
const today = istDate();

test.describe("CRM visit time: morning or evening on the visit, filter on the home lists", () => {
  let users;
  let rajesh;
  let docs;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const s = await seedCrmStaff();
    users = s.users;
    docs = await seedDoctors(
      s.hospitalId,
      ["Dr Slot Morning", "Dr Slot Evening", "Dr Slot Default", "Dr Slot Past", "Dr Slot UI"].map(
        (full_name, i) => ({
          full_name,
          mobile: `98444000${String(i).padStart(2, "0")}`,
          territory: "Mohali",
          owner: users.rajesh.crmId,
        }),
      ),
    );
    rajesh = await crmApi(users.rajesh);
  });

  test.afterAll(resetCrm);

  const logVisit = (doctor, extra = {}) =>
    rajesh
      .post("/api/crm/visits", {
        data: { id: crypto.randomUUID(), doctor_id: doctor.id, visit_type: "in_person", ...extra },
      })
      .then(json);
  const slotOf = (id) =>
    one(`SELECT visit_slot FROM crm.visits WHERE id = $1`, [id]).then((r) => r.visit_slot);
  const list = (path, params = {}) =>
    rajesh.get(`${path}?${new URLSearchParams(params)}`).then((r) => r.json());

  test("1. The visit keeps the chosen time; a missing time is filled from the clock", async () => {
    const morning = await logVisit(docs[0], { visit_slot: "morning" });
    expect(morning.status).toBe(200);
    expect(await slotOf(morning.body.id)).toBe("morning");

    const evening = await logVisit(docs[1], { visit_slot: "evening" });
    expect(await slotOf(evening.body.id)).toBe("evening");

    const at = new Date(`${today}T04:30:00Z`);
    const defaulted = await logVisit(docs[2], {
      occurred_at: (at > new Date() ? new Date() : at).toISOString(),
    });
    expect(["morning", "evening"]).toContain(await slotOf(defaulted.body.id));

    const past = await logVisit(docs[3], { visit_date: addDays(today, -2) });
    expect(past.status).toBe(200);
    expect(await slotOf(past.body.id)).toBeNull();
  });

  test("2. An unknown time is refused with a clear message", async () => {
    const bad = await logVisit(docs[4], { visit_slot: "night" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Choose Morning or Evening.");
  });

  test("3. The time can be changed later, and the change is validated", async () => {
    const past = await one(`SELECT id FROM crm.visits WHERE doctor_id = $1`, [docs[3].id]);
    const virender = await crmApi(users.virender);
    const wrong = await json(
      await virender.put(`/api/crm/visits/${past.id}`, {
        data: { visit_slot: "noon", reason: "Wrong time" },
      }),
    );
    expect(wrong.status).toBe(400);
    const ok = await json(
      await virender.put(`/api/crm/visits/${past.id}`, {
        data: { visit_slot: "evening", reason: "Forgot the time" },
      }),
    );
    expect(ok.status).toBe(200);
    expect(await slotOf(past.id)).toBe("evening");
  });

  test("4. Home lists filter by the time of the last visit", async () => {
    const mornings = await list("/api/crm/home/doctors", { slot: "morning" });
    expect(mornings.rows.map((r) => r.full_name)).toContain("Dr Slot Morning");
    expect(mornings.rows.every((r) => r.last_visit_slot === "morning")).toBe(true);

    const evenings = await list("/api/crm/home/doctors", { slot: "evening" });
    expect(evenings.rows.map((r) => r.full_name)).toEqual(
      expect.arrayContaining(["Dr Slot Evening", "Dr Slot Past"]),
    );
    expect(evenings.rows.every((r) => r.last_visit_slot === "evening")).toBe(true);

    const all = await list("/api/crm/home/doctors");
    expect(all.total).toBe(5);
    expect((await list("/api/crm/home/doctors", { slot: "night" })).total).toBe(5);
    const due = await list("/api/crm/home/due", { slot: "morning" });
    expect(due.rows.every((r) => r.last_visit_slot === "morning")).toBe(true);
  });

  test("5. In the browser: pick Evening when logging, then filter My doctors by it", async ({
    page,
  }) => {
    await loginCrm(page, rajesh);
    await gotoReady(
      page,
      `/crm/visit/${docs[4].id}?name=${encodeURIComponent(docs[4].full_name)}`,
      () => page.getByText("Time of visit"),
    );
    await page.getByRole("button", { name: "Evening", exact: true }).click();
    await expect(page.getByRole("button", { name: "Evening", exact: true })).toHaveClass(
      /rep__chip--on/,
    );
    await page.getByRole("button", { name: "Save visit" }).click();
    await expect(page).toHaveURL(/\/crm\/home/);
    await expect
      .poll(() =>
        one(`SELECT visit_slot FROM crm.visits WHERE doctor_id = $1`, [docs[4].id]).then(
          (r) => r?.visit_slot,
        ),
      )
      .toBe("evening");

    await page.getByRole("button", { name: "My doctors" }).click();
    const mine = page.getByRole("region", { name: "My doctors" });
    await mine.getByRole("button", { name: "Visit time", exact: true }).click();
    await page.getByRole("option", { name: "Evening visits" }).click();
    await expect(
      mine
        .locator(".rep__row", { hasText: "Dr Slot UI" })
        .locator(".rep__flag", { hasText: /^Evening$/ }),
    ).toBeVisible();
    await expect(mine.locator(".rep__row", { hasText: "Dr Slot Morning" })).toHaveCount(0);
    await mine.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(mine.getByText("5 doctors")).toBeVisible();
  });

  test("6. Each doctor shows this month's visit count, and the lists sort by it", async () => {
    const again = await logVisit(docs[0], { visit_slot: "evening" });
    expect(again.body).toMatchObject({ duplicate: true, reason: "already_logged_today" });
    const yesterday = addDays(today, -1);
    const sameMonth = yesterday.slice(0, 7) === today.slice(0, 7);
    const earlier = await logVisit(docs[0], { visit_date: yesterday });
    expect(earlier.body.duplicate).toBe(false);

    const all = await list("/api/crm/home/doctors");
    const row = (name) => all.rows.find((r) => r.full_name === name);
    expect(row("Dr Slot Morning")).toMatchObject({
      visits_this_month: sameMonth ? 2 : 1,
      last_visit_slot: "morning",
    });
    expect(row("Dr Slot Evening").visits_this_month).toBe(1);

    const most = await list("/api/crm/home/doctors", { sort: "visits_most" });
    const counts = most.rows.map((r) => r.visits_this_month);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    if (sameMonth) expect(most.rows[0].full_name).toBe("Dr Slot Morning");
    const least = await list("/api/crm/home/doctors", { sort: "visits_least" });
    const leastCounts = least.rows.map((r) => r.visits_this_month);
    expect(leastCounts).toEqual([...leastCounts].sort((a, b) => a - b));
    expect((await list("/api/crm/home/due", { sort: "nonsense" })).rows).toBeInstanceOf(Array);
  });

  test("7. In the browser: a Morning visit shows under Morning with its count, and sorting works", async ({
    page,
  }) => {
    await one(
      `UPDATE crm.visits SET deleted_at = now() WHERE doctor_id = $1 AND deleted_at IS NULL RETURNING id`,
      [docs[2].id],
    );
    await loginCrm(page, rajesh);
    await gotoReady(
      page,
      `/crm/visit/${docs[2].id}?name=${encodeURIComponent(docs[2].full_name)}`,
      () => page.getByText("Time of visit"),
    );
    await page.getByRole("button", { name: "Morning", exact: true }).click();
    await page.getByRole("button", { name: "Save visit" }).click();
    await expect(page).toHaveURL(/\/crm\/home/);
    await expect
      .poll(() =>
        one(`SELECT visit_slot FROM crm.visits WHERE doctor_id = $1 AND deleted_at IS NULL`, [
          docs[2].id,
        ]).then((r) => r?.visit_slot),
      )
      .toBe("morning");

    await page.getByRole("button", { name: "My doctors" }).click();
    const mine = page.getByRole("region", { name: "My doctors" });
    await mine.getByRole("button", { name: "Visit time", exact: true }).click();
    await page.getByRole("option", { name: "Morning visits" }).click();
    const row = mine.locator(".rep__row", { hasText: "Dr Slot Default" });
    await expect(row.locator(".rep__flag", { hasText: /^Morning$/ })).toBeVisible();
    await expect(row.locator(".rep__visits")).toHaveText("1 visit this month");
    await expect(mine.locator(".rep__row", { hasText: "Dr Slot Evening" })).toHaveCount(0);

    await mine.getByRole("button", { name: "Visit time", exact: true }).click();
    await page.getByRole("option", { name: "Evening visits" }).click();
    await expect(mine.locator(".rep__row", { hasText: "Dr Slot Default" })).toHaveCount(0);
    await expect(mine.locator(".rep__row", { hasText: "Dr Slot Evening" })).toHaveCount(1);

    await mine.getByRole("button", { name: "Clear filters" }).first().click();
    await mine.getByRole("button", { name: "Sort", exact: true }).click();
    await page.getByRole("option", { name: "Most visits this month" }).click();
    const top = await list("/api/crm/home/doctors", { sort: "visits_most" });
    await expect(mine.locator(".rep__row").first()).toContainText(top.rows[0].full_name);
    await expect(mine.locator(".rep__row").first().locator(".rep__visits")).toHaveText(
      `${top.rows[0].visits_this_month} visit${top.rows[0].visits_this_month === 1 ? "" : "s"} this month`,
    );
  });
});
