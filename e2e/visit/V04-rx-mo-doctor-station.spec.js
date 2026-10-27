import { test, expect, request } from "@playwright/test";
import { query, one } from "../helpers/db.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { buildPatient } from "../helpers/builders.mjs";
import { CONSULTANTS, PIN } from "../fixtures/data.mjs";
import { API_URL } from "../setup/testEnv.mjs";

const consultant = CONSULTANTS.rahul;
const RX_MO = { id: 9874, name: "Dr E2E Station MO", short_name: "Dr StationMO" };
const patients = [];
const STATION = "/api/giniflow/stations/doctor";

const istDay = (offset = 0) =>
  new Date(Date.now() + 330 * 60 * 1000 + offset * 86400000).toISOString().slice(0, 10);

const waitingVisit = async ({ rxMo = RX_MO } = {}) => {
  const patient = await buildPatient();
  patients.push(patient.id);
  const appt = await one(
    `INSERT INTO appointments (patient_id, patient_name, appointment_date, doctor_name, doctor_id, visit_type, status)
     VALUES ($1, $2, $3::date, $4, $5, 'New Patient', 'checkedin') RETURNING id`,
    [patient.id, patient.name, istDay(), consultant.name, consultant.id],
  );
  const visit = await one(
    `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, current_status, assigned_doctor_id, rx_mo_id)
     VALUES ($1, $2::date, $3, 'ready_for_doctor', $4, $5) RETURNING id`,
    [patient.id, istDay(), appt.id, consultant.id, rxMo?.id ?? null],
  );
  return { patient: patient.id, appointment: appt.id, visit: visit.id };
};

const queueVisitIds = (queue) =>
  Object.values(queue.groups || {})
    .flat()
    .map((c) => c.visitId);

test.describe.serial("V04 MO — prescriptions on the Gini Flow doctor station", () => {
  let mo;

  test.beforeAll(async () => {
    await query(
      `INSERT INTO doctors (id, name, short_name, role, pin, is_active, assists_doctor_id)
       VALUES ($1, $2, $3, 'rx_mo', $4, TRUE, $5)
       ON CONFLICT (id) DO UPDATE SET name = $2, short_name = $3, role = 'rx_mo', is_active = TRUE,
         pin = $4, assists_doctor_id = $5`,
      [RX_MO.id, RX_MO.name, RX_MO.short_name, PIN, consultant.id],
    );
    await query(`UPDATE doctors SET new_patient_workup = true WHERE id = $1`, [consultant.id]);
    const ctx = await request.newContext({ baseURL: API_URL });
    const login = await (
      await ctx.post("/api/auth/login", { data: { doctor_id: RX_MO.id, pin: PIN } })
    ).json();
    await ctx.dispose();
    mo = await request.newContext({
      baseURL: API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${login.access_token}` },
    });
  });

  test.afterAll(async () => {
    await query(`DELETE FROM new_patient_workups WHERE patient_id = ANY($1)`, [patients]);
    await query(
      `DELETE FROM giniflow_visit_events WHERE visit_id IN
      (SELECT id FROM giniflow_visits WHERE patient_id = ANY($1))`,
      [patients],
    );
    await query(
      `DELETE FROM giniflow_visit_steps WHERE visit_id IN
      (SELECT id FROM giniflow_visits WHERE patient_id = ANY($1))`,
      [patients],
    );
    await query(
      `DELETE FROM giniflow_rx_items WHERE visit_id IN
      (SELECT id FROM giniflow_visits WHERE patient_id = ANY($1))`,
      [patients],
    );
    await query(`DELETE FROM medications WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM consultations WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM giniflow_visits WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM patients WHERE id = ANY($1)`, [patients]);
    await query(`UPDATE doctors SET new_patient_workup = false WHERE id = $1`, [consultant.id]);
    await query(`UPDATE doctors SET is_active = false WHERE id = $1`, [RX_MO.id]);
    await mo?.dispose();
  });

  test("1. the MO's station queue and launcher count only their assigned visits", async () => {
    const mine = await waitingVisit();
    const other = await waitingVisit({ rxMo: null });
    const queue = await (await mo.get(`${STATION}/queue?scope=all`)).json();
    const ids = queueVisitIds(queue);
    expect(ids).toContain(mine.visit);
    expect(ids).not.toContain(other.visit);

    const summary = await (await mo.get("/api/giniflow/stations/summary")).json();
    expect(Object.keys(summary.stations)).toEqual(["doctor"]);
    expect(summary.stations.doctor.count).toBe(ids.length);
    expect(summary.bottleneck).toBeNull();
  });

  test("2. an assigned visit opens editable; anyone else's is refused", async () => {
    const mine = await waitingVisit();
    const other = await waitingVisit({ rxMo: null });
    const consult = await (await mo.get(`${STATION}/${mine.visit}`)).json();
    expect(consult).toMatchObject({ readOnly: false, appointmentId: mine.appointment });
    expect((await mo.get(`/api/giniflow/referrals/visit/${mine.visit}`)).status()).toBe(200);

    for (const res of [
      await mo.get(`${STATION}/${other.visit}`),
      await mo.post(`${STATION}/${other.visit}/start`),
      await mo.get(`/api/giniflow/referrals/visit/${other.visit}`),
    ]) {
      expect(res.status()).toBe(403);
    }
  });

  test("3. the MO starts and finalizes on the consultant's behalf", async () => {
    const v = await waitingVisit();
    expect((await mo.post(`${STATION}/${v.visit}/start`)).status()).toBe(200);
    expect(
      await one(`SELECT current_status, assigned_doctor_id FROM giniflow_visits WHERE id = $1`, [
        v.visit,
      ]),
    ).toEqual({ current_status: "with_doctor", assigned_doctor_id: consultant.id });

    const workup = await mo.put(`/api/visit/${v.patient}/workup`, {
      data: { appointment_id: v.appointment, history: { complaints: "Station C/O" } },
    });
    expect(workup.status()).toBe(200);

    expect(
      (
        await mo.put(`${STATION}/${v.visit}/care-plan`, {
          data: { nextVisitDate: istDay(90), nextVisitInterval: "~3 months" },
        })
      ).status(),
    ).toBe(200);
    const fin = await mo.post(`${STATION}/${v.visit}/finalize`, { data: { confirm: true } });
    expect(fin.status()).toBe(200);

    expect(
      await one(`SELECT con_doctor_id, mo_doctor_id FROM consultations WHERE patient_id = $1`, [
        v.patient,
      ]),
    ).toEqual({ con_doctor_id: consultant.id, mo_doctor_id: RX_MO.id });
    const events = await query(
      `SELECT status, actor_id FROM giniflow_visit_events WHERE visit_id = $1 ORDER BY occurred_at`,
      [v.visit],
    );
    expect(events.rows.map((e) => e.actor_id)).toEqual(events.rows.map(() => RX_MO.id));
    expect(events.rows.map((e) => e.status)).toContain("rx_pending");
  });

  test("4. the consultant still opens and owns the same visit", async () => {
    const v = await waitingVisit();
    const doc = await apiAs("rahul");
    const consult = await (await doc.get(`${STATION}/${v.visit}`)).json();
    expect(consult.readOnly).toBe(false);
    const queue = await (await doc.get(`${STATION}/queue`)).json();
    expect(queueVisitIds(queue)).toContain(v.visit);
    await doc.dispose();
  });

  test("5. the rest of Gini Flow stays closed to the MO", async () => {
    for (const path of [
      "/api/giniflow/board",
      "/api/giniflow/triage",
      "/api/giniflow/stations/vitals/queue",
      "/api/giniflow/stations/mo/queue",
      "/api/giniflow/stations/pharmacy/queue",
      "/api/giniflow/realtime-token",
      "/api/giniflow/referrals",
    ]) {
      expect((await mo.get(path)).status(), path).toBe(403);
    }
  });
});
