import { test, expect, request } from "@playwright/test";
import { query, one } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";
import { CONSULTANTS, PIN } from "../fixtures/data.mjs";
import { API_URL } from "../setup/testEnv.mjs";

const chief = CONSULTANTS.banshali;
const plain = CONSULTANTS.rahul;
const CHIEF_MO = { id: 9875, name: "Dr E2E Chief MO", short_name: "Dr ChiefMO" };
const PLAIN_MO = { id: 9876, name: "Dr E2E Plain MO", short_name: "Dr PlainMO" };
const STATION = "/api/giniflow/stations/mo";
const patients = [];

const istDay = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

const chiefVisit = async ({ rxMo = CHIEF_MO, status = "vitals_done" } = {}) => {
  const patient = await buildPatient();
  patients.push(patient.id);
  const appt = await one(
    `INSERT INTO appointments (patient_id, patient_name, appointment_date, doctor_name, doctor_id, visit_type, status)
     VALUES ($1, $2, $3::date, $4, $5, 'Follow-Up', 'checkedin') RETURNING id`,
    [patient.id, patient.name, istDay(), chief.name, chief.id],
  );
  const visit = await one(
    `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, current_status, assigned_doctor_id, rx_mo_id)
     VALUES ($1, $2::date, $3, $4, $5, $6) RETURNING id`,
    [patient.id, istDay(), appt.id, status, chief.id, rxMo?.id ?? null],
  );
  return { patient: patient.id, visit: visit.id };
};

const queueIds = (queue) =>
  [
    "withMe",
    "waitingForMe",
    "awaitingResults",
    "missingReports",
    "inPipeline",
    "done",
    "withOtherSd",
  ]
    .flatMap((g) => queue[g] || [])
    .map((c) => c.visitId);

async function loginAs(mo, assists) {
  await query(
    `INSERT INTO doctors (id, name, short_name, role, pin, is_active, assists_doctor_id)
     VALUES ($1, $2, $3, 'rx_mo', $4, TRUE, $5)
     ON CONFLICT (id) DO UPDATE SET name = $2, short_name = $3, role = 'rx_mo', is_active = TRUE,
       pin = $4, assists_doctor_id = $5`,
    [mo.id, mo.name, mo.short_name, PIN, assists.id],
  );
  const ctx = await request.newContext({ baseURL: API_URL });
  const login = await (
    await ctx.post("/api/auth/login", { data: { doctor_id: mo.id, pin: PIN } })
  ).json();
  await ctx.dispose();
  return request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${login.access_token}` },
  });
}

test.describe.serial("V05 the Rx MO of a Chief works the Chief Endocrinologist station", () => {
  let mo;
  let plainMo;
  let chiefFlags;

  test.beforeAll(async () => {
    chiefFlags = await one(
      `SELECT is_chief, (to_jsonb(doctors)->>'chief_step')::boolean AS chief_step
         FROM doctors WHERE id = $1`,
      [chief.id],
    );
    await query(`UPDATE doctors SET is_chief = TRUE WHERE id = $1`, [chief.id]);
    await query(`UPDATE doctors SET is_chief = FALSE, chief_step = FALSE WHERE id = $1`, [
      plain.id,
    ]);
    mo = await loginAs(CHIEF_MO, chief);
    plainMo = await loginAs(PLAIN_MO, plain);
  });

  test.afterAll(async () => {
    const visits = `(SELECT id FROM giniflow_visits WHERE patient_id = ANY($1))`;
    await query(`DELETE FROM giniflow_visit_events WHERE visit_id IN ${visits}`, [patients]);
    await query(`DELETE FROM giniflow_visit_steps WHERE visit_id IN ${visits}`, [patients]);
    await query(`DELETE FROM giniflow_rx_items WHERE visit_id IN ${visits}`, [patients]);
    await query(`DELETE FROM giniflow_sd_notes WHERE visit_id IN ${visits}`, [patients]);
    await query(`DELETE FROM giniflow_visits WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM patients WHERE id = ANY($1)`, [patients]);
    await query(`UPDATE doctors SET is_chief = $2 WHERE id = $1`, [
      chief.id,
      chiefFlags.is_chief ?? false,
    ]);
    await query(`UPDATE doctors SET is_active = FALSE WHERE id = ANY($1)`, [
      [CHIEF_MO.id, PLAIN_MO.id],
    ]);
    await mo?.dispose();
    await plainMo?.dispose();
  });

  test("1. the launcher gives one Chief tile counting the patient in the room", async () => {
    await chiefVisit({ status: "with_sd" });
    const me = await (await mo.get("/api/auth/me")).json();
    expect(me.doctor.assists).toMatchObject({ id: chief.id, chief: true });
    const summary = await (await mo.get("/api/giniflow/stations/summary")).json();
    expect(Object.keys(summary.stations)).toEqual(["mo_sd"]);
    expect(summary.stations.mo_sd.count).toBeGreaterThanOrEqual(1);
    expect(summary.stations.mo_sd.label).toMatch(/assigned to you/);
  });

  test("2. the Chief queue holds only the visits assigned to this MO", async () => {
    const mine = await chiefVisit();
    const other = await chiefVisit({ rxMo: null });
    const queue = await (await mo.get(`${STATION}/queue`)).json();
    const ids = queueIds(queue);
    expect(ids).toContain(mine.visit);
    expect(ids).not.toContain(other.visit);
    expect(queue.total).toBe(ids.length);
  });

  test("3. the MO starts the workup as the Chief's desk, recorded as the MO", async () => {
    const v = await chiefVisit();
    expect((await mo.post(`${STATION}/${v.visit}/start`)).status()).toBe(200);
    expect(
      await one(`SELECT current_status, assigned_sd_id FROM giniflow_visits WHERE id = $1`, [
        v.visit,
      ]),
    ).toEqual({ current_status: "with_sd", assigned_sd_id: chief.id });
    const event = await one(
      `SELECT actor_id FROM giniflow_visit_events
        WHERE visit_id = $1 AND status = 'with_sd' ORDER BY occurred_at DESC LIMIT 1`,
      [v.visit],
    );
    expect(event.actor_id).toBe(CHIEF_MO.id);
    expect((await mo.get(`${STATION}/${v.visit}`)).status()).toBe(200);
    expect((await mo.post(`${STATION}/${v.visit}/release`)).status()).toBe(200);
  });

  test("4. a patient the Chief already holds is the MO's to work too", async () => {
    const v = await chiefVisit({ status: "with_sd" });
    await query(`UPDATE giniflow_visits SET assigned_sd_id = $2 WHERE id = $1`, [
      v.visit,
      chief.id,
    ]);
    expect((await mo.post(`${STATION}/${v.visit}/start`)).status()).toBe(200);
    const queue = await (await mo.get(`${STATION}/queue`)).json();
    expect((queue.withMe || []).map((c) => c.visitId)).toContain(v.visit);
  });

  test("4b. a patient who has gone on to the pharmacy stays under passed on", async () => {
    const v = await chiefVisit({ status: "pharmacy_pending" });
    const queue = await (await mo.get(`${STATION}/queue`)).json();
    expect((queue.done || []).map((c) => c.visitId)).toContain(v.visit);
    expect(queue.counters.closedByMe).toBeGreaterThanOrEqual(1);
  });

  test("5. a visit not assigned to the MO is refused", async () => {
    const v = await chiefVisit({ rxMo: null });
    expect((await mo.get(`${STATION}/${v.visit}`)).status()).toBe(403);
    expect((await mo.post(`${STATION}/${v.visit}/start`)).status()).toBe(403);
  });

  test("6. the rest of Gini Flow stays closed", async () => {
    for (const path of [
      "/api/giniflow/board",
      "/api/giniflow/triage",
      "/api/giniflow/stations/vitals/queue",
      "/api/giniflow/stations/pharmacy/queue",
    ]) {
      expect((await mo.get(path)).status(), path).toBe(403);
    }
  });

  test("7. an MO of an ordinary consultant keeps the Consultant station only", async () => {
    const summary = await (await plainMo.get("/api/giniflow/stations/summary")).json();
    expect(Object.keys(summary.stations)).toEqual(["doctor"]);
    expect((await plainMo.get(`${STATION}/queue`)).status()).toBe(403);
  });
});
