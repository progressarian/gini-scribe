import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { PATIENTS } from "../fixtures/data.mjs";
import { one, query } from "../helpers/db.mjs";
import { newTag } from "./opd-fixture.mjs";

const FROM = "2020-03-01";
const TO = "2020-03-31";
const tag = newTag();
const NOTE = `opd-times-${tag}`;
const docA = `Dr. Time A ${tag}`;
const docB = `Dr. Time B ${tag}`;
const PATH = "/reports/opd-dashboard";
let admin;
let target;
const visitIds = [];

const at = (day, minutes) =>
  new Date(Date.parse(`${day}T04:00:00Z`) + minutes * 60000).toISOString();

async function visit(patient, doctor, day, visitType, marks, status = "completed") {
  const appt = await one(
    `INSERT INTO appointments (patient_id, patient_name, file_no, doctor_name, appointment_date,
                               time_slot, visit_type, status, notes)
     VALUES ($1, $2, $3, $4, $5, '10:00', $6, $7, $8) RETURNING id`,
    [patient.id, patient.name, patient.file_no, doctor, day, visitType, status, NOTE],
  );
  if (!marks) return appt.id;
  const made = await one(
    `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, current_status)
     VALUES ($1, $2, $3, 'exited') RETURNING id`,
    [patient.id, day, appt.id],
  );
  visitIds.push(made.id);
  for (const [state, minutes] of marks) {
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, $2, 'test', $3)`,
      [made.id, state, at(day, minutes)],
    );
  }
  return appt.id;
}

const times = async (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of [value].flat()) search.append(key, item);
  }
  const res = await admin.get(`/api/reports/opd/dashboard/times?${search}`);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};

const journey = (wait, length) => [
  ["checked_in", 0],
  ["with_doctor", wait],
  ["exited", length],
];

test.describe.serial("R05 OPD dashboard floor times", () => {
  test.beforeAll(async () => {
    admin = await apiAs("admin");
    target = (
      await one(`SELECT budget_minutes FROM giniflow_sla_config WHERE station = 'total_journey'`)
    ).budget_minutes;
    const p = PATIENTS;
    await visit(p.general, docA, "2020-03-02", "Follow-Up", journey(10, 60));
    await visit(p.senior, docA, "2020-03-02", "Follow-Up", journey(20, target + 30));
    await visit(p.cghsPaid, docA, "2020-03-03", "New Patient", journey(30, 80));
    await visit(p.cghsReferral, docA, "2020-03-04", "Tele", journey(5, 10));
    await visit(p.pensioner, docA, "2020-03-05", "Follow-Up", null);
    await visit(p.general, docA, "2020-03-06", "Follow-Up", [
      ["checked_in", 0],
      ["with_doctor", 15],
      ["back_for_tests", 40],
      ["exited", 70],
    ]);
    await visit(p.senior, docA, "2020-02-10", "Follow-Up", journey(10, 40));
    for (let i = 0; i < 20; i++) {
      const day = `2020-04-${String(i + 1).padStart(2, "0")}`;
      await visit(p.general, docB, day, "Follow-Up", journey(10, 50));
    }
  });

  test.afterAll(async () => {
    if (visitIds.length) {
      await query(`DELETE FROM giniflow_visits WHERE id = ANY($1::uuid[])`, [visitIds]);
    }
    await query(`DELETE FROM appointments WHERE notes = $1`, [NOTE]);
    await admin?.dispose();
  });

  test("1. medians, on-time and coverage follow the Flow Reports rules", async () => {
    const t = await times({ from: FROM, to: TO, doctor: docA });
    expect(t.target).toBe(target);
    expect(t.visits).toBe(5);
    expect(t.tracked).toBe(4);
    expect(t.timed).toBe(3);
    expect(t.visitLength).toBe(80);
    expect(t.waiting).toBe(18);
    expect(t.onTime).toBe(2);
    expect(t.onTimePct).toBe(67);
    expect(t.enough).toBe(false);
    expect(t.compare).toMatchObject({ from: "2020-02-01", to: "2020-02-29" });
    expect(t.previous.visitLength).toBe(40);
  });

  test("2. tele is never timed, and buckets follow the group", async () => {
    const tele = await times({ from: FROM, to: TO, doctor: docA, type: "tele" });
    expect(tele).toMatchObject({ visits: 0, timed: 0, visitLength: null });
    const week = await times({ from: FROM, to: TO, doctor: docA, group: "week" });
    const filled = week.trend.filter((b) => b.tracked);
    expect(filled.map((b) => b.bucket)).toEqual(["2020-03-02"]);
    expect(filled[0].timed).toBe(3);
  });

  test("3. twenty timed visits is enough, and stations list planned against typical", async () => {
    const t = await times({ from: "2020-04-01", to: "2020-04-30", doctor: docB });
    expect(t).toMatchObject({
      timed: 20,
      enough: true,
      visitLength: 50,
      waiting: 10,
      onTimePct: 100,
    });
    expect(t.stations.length).toBeGreaterThan(0);
    expect(t.stations[0]).toEqual(
      expect.objectContaining({ step_name: expect.any(String), total_count: expect.any(Number) }),
    );
  });

  test("4. the visit list shows waited and visit length where they are known", async () => {
    const res = await admin.get(
      `/api/reports/opd/visits?from=${FROM}&to=${TO}&doctor=${encodeURIComponent(docA)}&state=came&sort=date_asc`,
    );
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      waitingMin: expect.any(Number),
      visitMin: expect.any(Number),
    });
    const untracked = body.data.find((v) => v.day === "2020-03-05");
    expect(untracked.visitMin).toBeUndefined();
    const monthly = await admin.get(
      `/api/reports/opd/visits?month=2020-03&doctor=${encodeURIComponent(docA)}`,
    );
    expect((await monthly.json()).data[0].visitMin).toBeUndefined();
  });

  test("4b. Flow Reports still gives the same answer after sharing its rules", async () => {
    const res = await admin.get(`/api/giniflow/reports?start=2020-04-01&end=2020-04-30`);
    expect(res.status(), await res.text()).toBe(200);
    const flow = await res.json();
    expect(flow.summary).toMatchObject({ total_visits: 20, completed: 20, avg_visit_min: 50 });
    expect(flow.daily).toHaveLength(20);
    const dash = await times({ from: "2020-04-01", to: "2020-04-30", doctor: docB });
    expect(dash.timed).toBe(flow.summary.completed);
    expect(dash.onTime).toBe(flow.summary.completed - flow.summary.breached);
    const march = await admin.get(`/api/giniflow/reports?start=2020-03-06&end=2020-03-06`);
    expect((await march.json()).summary).toMatchObject({ total_visits: 1, completed: 0 });
  });

  test("4c. a visit closed by the midnight sweep has no exit time, on both pages", async () => {
    const day = "2020-05-04";
    const doctor = `Dr. Time Swept ${tag}`;
    await visit(PATIENTS.general, doctor, day, "Follow-Up", journey(10, 60));
    const swept = await visit(PATIENTS.senior, doctor, day, "Follow-Up", [
      ["checked_in", 0],
      ["with_doctor", 20],
      ["rx_pending", 50],
    ]);
    const sweptVisit = await one(`SELECT id FROM giniflow_visits WHERE appointment_id = $1`, [
      swept,
    ]);
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at, meta)
       VALUES ($1, 'exited', 'system', ($2::date + time '23:59:59') AT TIME ZONE 'Asia/Kolkata',
               '{"backfill": "cron", "from": "rx_pending"}')`,
      [sweptVisit.id, day],
    );
    const t = await times({ from: day, to: day, doctor });
    expect(t).toMatchObject({ visits: 2, tracked: 2, timed: 1, visitLength: 60, onTime: 1 });
    expect(t.waiting).toBe(15);
    const res = await admin.get(`/api/giniflow/reports?start=${day}&end=${day}`);
    const flow = await res.json();
    expect(flow.summary).toMatchObject({
      total_visits: 2,
      completed: 1,
      breached: 0,
      avg_visit_min: 60,
    });
    const rxWait = flow.bottlenecks.find((b) => b.station === "wait_rx");
    expect(rxWait).toBeUndefined();
    const list = await admin.get(
      `/api/reports/opd/visits?from=${day}&to=${day}&doctor=${encodeURIComponent(doctor)}&state=came`,
    );
    const rows = (await list.json()).data;
    const row = rows.find((v) => v.id === swept);
    expect(row.visitMin).toBeNull();
    expect(row.waitingMin).toBe(20);
  });

  test("5. reception is refused", async () => {
    const reception = await apiAs("reception");
    try {
      expect((await reception.get("/api/reports/opd/dashboard/times")).status()).toBe(403);
    } finally {
      await reception.dispose();
    }
  });

  test("6. the page shows the too-few message, then the charts and the heatmap", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    const few = `${PATH}?range=custom&from=${FROM}&to=${TO}&doctor=${encodeURIComponent(docA)}`;
    await gotoReady(page, few, () => page.getByRole("region", { name: "Time on the floor" }));
    const card = page.getByRole("region", { name: "Time on the floor" });
    await expect(card).toContainText("Too few visits were tracked on the floor");
    await expect(card).toContainText("closed automatically at midnight");
    await expect(page.getByRole("link", { name: /^Typical visit length: —/ })).toBeVisible();
    const heat = page.getByRole("table", { name: "Visits by weekday and hour" });
    await expect(heat.getByRole("link", { name: "Mon 10:00: 2 visits" })).toBeVisible();
    await heat.getByRole("link", { name: "Mon 10:00: 2 visits" }).click();
    await expect(page).toHaveURL(/weekday=1.*hour=10|hour=10.*weekday=1/);
    await expect(page.getByRole("table", { name: "Visits" }).getByRole("row")).toHaveCount(3);
    await expect(page.getByRole("table", { name: "Visits" })).toContainText("60 min");

    await page.goto(
      `${PATH}?range=custom&from=2020-04-01&to=2020-04-30&doctor=${encodeURIComponent(docB)}`,
    );
    await expect(page.getByRole("link", { name: /^Typical visit length: 50 min/ })).toBeVisible();
    await expect(card).toContainText("Timed 20 of 20 visits");
    await expect(card).toContainText("Where the time goes");
    await card.getByText("Show as table").click();
    await expect(page.getByRole("table", { name: "Floor times by period" })).toContainText(
      "50 min",
    );
  });

  test("7. times failing leaves the counts on screen with its own Try again", async ({ page }) => {
    await loginAs(page, "admin");
    await page.route("**/api/reports/opd/dashboard/times**", (route) =>
      route.fulfill({ status: 400, json: { error: "Could not work out times" } }),
    );
    await page.goto(
      `${PATH}?range=custom&from=${FROM}&to=${TO}&doctor=${encodeURIComponent(docA)}`,
    );
    await expect(
      page.getByRole("region", { name: "Headline figures" }).getByRole("link", { name: /^Visits/ }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Time on the floor" })
        .getByRole("button", { name: "Try again" }),
    ).toBeVisible();
  });

  test("8. phone width still has no sideways page scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "admin");
    await gotoReady(
      page,
      `${PATH}?range=custom&from=2020-04-01&to=2020-04-30&doctor=${encodeURIComponent(docB)}`,
      () => page.getByRole("table", { name: "Visits by weekday and hour" }),
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  });
});
