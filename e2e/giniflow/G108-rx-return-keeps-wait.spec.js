import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
let ids;
let api;

async function waitingFor(label, minutesAgo) {
  const v = await extraVisit(ids, label, { healthray: false });
  await query(
    `UPDATE giniflow_visits SET current_status = 'rx_pending', visit_date = $2::date WHERE id = $1`,
    [v.visit, ids.day],
  );
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'rx_pending', 'doctor', NOW() - make_interval(mins => $2))`,
    [v.visit, minutesAgo],
  );
  return v;
}

async function queue() {
  const res = await api.get("/api/giniflow/stations/rx/queue");
  expect(res.status()).toBe(200);
  return res.json();
}

test.describe.serial("G108 Rx desk: 'Not this patient' keeps the patient's wait", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    api = await apiAs("admin");
  });

  test.afterAll(async () => {
    await api?.dispose();
    await tearDown(ids);
  });

  test("1. a patient called and sent back keeps their wait and their place at the top", async () => {
    const long = await waitingFor("G108Long", 30);
    const short = await waitingFor("G108Short", 10);

    expect((await api.post(`/api/giniflow/stations/rx/${long.visit}/start`)).status()).toBe(200);
    const atDesk = await queue();
    expect(atDesk.atDesk.map((r) => r.visitId)).toContain(long.visit);

    expect((await api.post(`/api/giniflow/stations/rx/${long.visit}/return`)).status()).toBe(200);
    const back = await queue();
    const mine = back.waiting.filter((r) => [long.visit, short.visit].includes(r.visitId));
    expect(mine.map((r) => r.visitId)).toEqual([long.visit, short.visit]);
    expect(mine[0].minutes).toBeGreaterThanOrEqual(29);
    expect(mine[1].minutes).toBeGreaterThanOrEqual(9);
    expect(mine[1].minutes).toBeLessThan(15);

    const res = await api.get("/api/giniflow/stations/pharmacy/queue");
    expect(res.status()).toBe(200);
    const card = (await res.json()).toDispense.find((c) => c.visitId === long.visit);
    expect(card?.waitMinutes).toBeGreaterThanOrEqual(29);
  });

  test("2. a patient at the desk is timed from when they were called", async () => {
    const v = await waitingFor("G108Desk", 20);
    expect((await api.post(`/api/giniflow/stations/rx/${v.visit}/start`)).status()).toBe(200);
    const row = (await queue()).atDesk.find((r) => r.visitId === v.visit);
    expect(row.minutes).toBeLessThan(2);
  });
});
