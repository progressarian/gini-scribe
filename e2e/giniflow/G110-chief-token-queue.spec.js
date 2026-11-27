import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { query, one } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = crypto.randomBytes(3).toString("hex");
const BANSHALI = CONSULTANTS.banshali.id;
const RAHUL = CONSULTANTS.rahul.id;
const made = [];
let day;
let tokenQueueBefore;
let reception;

async function seedVisit(label, doctorId, status, arrivedMinutesAgo, time) {
  const name = `G110 ${label} ${tag}`;
  const fileNo = `G110${label}-${tag}`;
  const patient = (
    await one(
      `INSERT INTO patients (name, file_no, age, sex) VALUES ($1, $2, 58, 'Female') RETURNING id`,
      [name, fileNo],
    )
  ).id;
  const appointment = (
    await one(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type, doctor_id)
       VALUES ($1, $2, $3, $4::date, 'Follow Up', $5) RETURNING id`,
      [patient, name, fileNo, day, doctorId],
    )
  ).id;
  const visit = (
    await one(
      `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, appointment_time,
                                    assigned_doctor_id, current_status)
       VALUES ($1, $2::date, $3, $4::time, $5, $6) RETURNING id`,
      [patient, day, appointment, time, doctorId, status],
    )
  ).id;
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'checked_in', 'reception', NOW() - make_interval(mins => $2)),
            ($1, $3, 'nurse', NOW() - make_interval(mins => 2))`,
    [visit, arrivedMinutesAgo, status],
  );
  made.push({ patient, appointment, visit });
  return { id: visit, name };
}

const ours = (ids) => (list) => list.filter((id) => ids.includes(id));

async function setToken(api, visitId, token) {
  return api.patch(`/api/giniflow/visits/${visitId}/token`, { data: { token } });
}

async function chiefColumn() {
  const res = await reception.get("/api/giniflow/board", { params: { date: day } });
  expect(res.status()).toBe(200);
  const board = await res.json();
  return board.columns.find((c) => c.key === "sd").cards;
}

test.describe.serial("G110 Chief Endocrinologist token queue", () => {
  let t5, t2late, t2early, none, rahul;

  test.beforeAll(async () => {
    day = (await one(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
    tokenQueueBefore = (await one(`SELECT token_queue FROM doctors WHERE id = $1`, [BANSHALI]))
      .token_queue;
    await query(`UPDATE doctors SET token_queue = true WHERE id = $1`, [BANSHALI]);
    await query(`UPDATE doctors SET token_queue = false WHERE id = $1`, [RAHUL]);
    t5 = await seedVisit("Five", BANSHALI, "sd_pending", 60, "09:00");
    t2late = await seedVisit("TwoLate", BANSHALI, "sd_pending", 20, "09:15");
    t2early = await seedVisit("TwoEarly", BANSHALI, "vitals_done", 40, "10:00");
    none = await seedVisit("NoToken", BANSHALI, "sd_pending", 90, "08:30");
    rahul = await seedVisit("Rahul", RAHUL, "sd_pending", 30, "09:30");
    reception = await apiAs("reception");
  });

  test.afterAll(async () => {
    await reception?.dispose();
    const patients = made.map((m) => m.patient);
    const visits = (
      await query(`SELECT id::text FROM giniflow_visits WHERE patient_id = ANY($1::int[])`, [
        patients,
      ])
    ).rows.map((r) => r.id);
    if (visits.length) {
      await query(
        `DELETE FROM audit_log WHERE action = 'giniflow_token_set' AND details->>'visitId' = ANY($1::text[])`,
        [visits],
      );
      await query(`DELETE FROM giniflow_visit_events WHERE visit_id = ANY($1::uuid[])`, [visits]);
      await query(`DELETE FROM giniflow_visits WHERE id = ANY($1::uuid[])`, [visits]);
    }
    if (patients.length) {
      await query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [patients]);
      await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [patients]);
    }
    await query(`UPDATE doctors SET token_queue = $2 WHERE id = $1`, [
      BANSHALI,
      tokenQueueBefore ?? false,
    ]);
  });

  test("1. reception orders the Chief column by token, ties by arrival, untokened after", async () => {
    expect((await setToken(reception, t5.id, 5)).status()).toBe(200);
    expect((await setToken(reception, t2late.id, 2)).status()).toBe(200);
    expect((await setToken(reception, t2early.id, 2)).status()).toBe(200);

    const tokened = [t2early.id, t2late.id, t5.id];
    const cards = await chiefColumn();
    const order = ours([...tokened, none.id, rahul.id])(cards.map((c) => c.id));
    expect(order.slice(0, 3)).toEqual(tokened);
    expect(cards.find((c) => c.id === rahul.id).token).toBeNull();

    const list = await (
      await reception.get("/api/giniflow/tokens", { params: { date: day, q: tag } })
    ).json();
    expect(list.rows.map((r) => r.visitId)).toEqual([...tokened, none.id]);
    expect(list.rows.filter((r) => r.tokenShared).map((r) => r.visitId)).toEqual([
      t2early.id,
      t2late.id,
    ]);
  });

  test("2. the Chief station queue follows the same order", async () => {
    const admin = await apiAs("admin");
    const res = await admin.get("/api/giniflow/stations/mo/queue", { params: { date: day } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = Object.values(body)
      .filter(Array.isArray)
      .flat()
      .map((c) => c.visitId);
    expect(ours([t2early.id, t2late.id, t5.id, none.id])(ids).slice(0, 3)).toEqual([
      t2early.id,
      t2late.id,
      t5.id,
    ]);
    await admin.dispose();
  });

  test("3. changing and clearing a token re-sorts the column", async () => {
    expect((await setToken(reception, t5.id, 1)).status()).toBe(200);
    let order = ours([t5.id, t2early.id, t2late.id])((await chiefColumn()).map((c) => c.id));
    expect(order[0]).toBe(t5.id);

    expect((await setToken(reception, t5.id, null)).status()).toBe(200);
    order = ours([t5.id, t2early.id, t2late.id, none.id])((await chiefColumn()).map((c) => c.id));
    expect(order.slice(0, 2)).toEqual([t2early.id, t2late.id]);
    expect(order.indexOf(t5.id)).toBeGreaterThan(1);

    const audit = await query(
      `SELECT details FROM audit_log WHERE action = 'giniflow_token_set' AND details->>'visitId' = $1 ORDER BY id`,
      [t5.id],
    );
    expect(audit.rows.map((r) => [r.details.from, r.details.to])).toEqual([
      [null, 5],
      [5, 1],
      [1, null],
    ]);
  });

  test("4. reception admin and admin may set tokens; a role without the capability may not", async () => {
    for (const role of ["reception_admin", "admin"]) {
      const api = await apiAs(role);
      expect((await setToken(api, t5.id, 7)).status()).toBe(200);
      await api.dispose();
    }
    const lab = await apiAs("lab");
    expect((await setToken(lab, t5.id, 3)).status()).toBe(403);
    expect((await lab.get("/api/giniflow/tokens", { params: { date: day } })).status()).toBe(403);
    await lab.dispose();
  });

  test("5. invalid input and a consultant without the token queue are refused", async () => {
    const zero = await setToken(reception, t5.id, 0);
    expect(zero.status()).toBe(400);
    const fraction = await setToken(reception, t5.id, 2.5);
    expect(fraction.status()).toBe(400);
    const other = await setToken(reception, rahul.id, 4);
    expect(other.status()).toBe(409);
    expect((await other.json()).error).toMatch(/does not use the token queue/);
    const unknown = await setToken(reception, crypto.randomUUID(), 4);
    expect(unknown.status()).toBe(404);
  });

  test("6. the token page lets reception type a token and shows the new order", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await page.goto("/giniflow/tokens");
    await expect(page.getByRole("heading", { name: "Chief Endocrinologist tokens" })).toBeVisible();

    await page.getByRole("button", { name: "Search patients" }).click();
    await page.getByPlaceholder("Search by patient name, UHID or phone").fill(tag);
    const input = page.getByRole("textbox", { name: `Token for ${none.name}` });
    await expect(input).toBeVisible();
    await input.fill("1");
    await input.press("Enter");
    await expect(page.getByText(`Token 1 set for ${none.name}`)).toBeVisible();

    const firstRow = page.locator(".tq-table tbody tr").first();
    await expect(firstRow).toContainText(none.name);
    await expect(firstRow.locator(".tq-doctor")).toHaveText(CONSULTANTS.banshali.short_name);

    await input.fill("abc");
    await input.press("Enter");
    await expect(page.getByRole("alert")).toContainText("Enter the token as a whole number.");
  });

  test("7. the same list opens from the Reception tab and the Flow board drawer", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await page.goto("/giniflow/station/reception?tab=tokens");
    await expect(page.getByRole("tab", { name: "Chief tokens" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const tab = page.getByRole("region", { name: "Chief Endocrinologist tokens" });
    await expect(tab).toBeVisible();
    await expect(tab.getByRole("button", { name: "Day: Today" })).toBeVisible();

    await page.goto("/giniflow/manager");
    await page.getByRole("button", { name: "🎫 Chief tokens" }).click();
    const drawer = page.getByRole("dialog", { name: "Chief Endocrinologist tokens" });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("region", { name: "Chief Endocrinologist tokens" }),
    ).toBeVisible();
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toBeHidden();
  });

  test("8. a booking for a later day appears before its visit exists and takes a token", async () => {
    const later = (await one(`SELECT ($1::date + 3)::text AS d`, [day])).d;
    const name = `G110 Later ${tag}`;
    const fileNo = `G110Later-${tag}`;
    const patient = (
      await one(
        `INSERT INTO patients (name, file_no, age, sex) VALUES ($1, $2, 61, 'Male') RETURNING id`,
        [name, fileNo],
      )
    ).id;
    const appointment = (
      await one(
        `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type,
                                   doctor_name, time_slot)
         VALUES ($1, $2, $3, $4::date, 'Follow Up', $5, '10:30') RETURNING id`,
        [patient, name, fileNo, later, CONSULTANTS.banshali.name],
      )
    ).id;
    made.push({ patient, appointment, visit: null });
    expect(
      (await one(`SELECT count(*)::int AS n FROM giniflow_visits WHERE patient_id = $1`, [patient]))
        .n,
    ).toBe(0);

    const res = await reception.get("/api/giniflow/tokens", { params: { date: later, q: tag } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.stages).toBeUndefined();
    const row = body.rows.find((r) => r.name === name);
    expect(row).toBeTruthy();
    expect(row.doctorId).toBe(BANSHALI);
    expect(row.stage).toBe("not_arrived");

    expect((await setToken(reception, row.visitId, 3)).status()).toBe(200);
    const again = await (
      await reception.get("/api/giniflow/tokens", { params: { date: later, q: tag } })
    ).json();
    expect(again.rows.find((r) => r.visitId === row.visitId).token).toBe(3);
  });
});
