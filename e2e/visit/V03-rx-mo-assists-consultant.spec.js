import { test, expect, request } from "@playwright/test";
import { query, one } from "../helpers/db.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { buildPatient } from "../helpers/builders.mjs";
import { CONSULTANTS, PIN } from "../fixtures/data.mjs";
import { API_URL } from "../setup/testEnv.mjs";

const assisted = CONSULTANTS.banshali;
const other = CONSULTANTS.rahul;
const RX_MO = { id: 9871, name: "Dr E2E Rx MO", short_name: "Dr RxMO" };
const OTHER_MO = { id: 9873, name: "Dr E2E Rx MO Two", short_name: "Dr RxMO3" };
const UNLINKED = { id: 9872, name: "Dr E2E Rx MO Unlinked", short_name: "Dr RxMO2" };
const NOT_ASSIGNED = "This patient isn't assigned to you";
const patients = [];

const istDay = (offset = 0) =>
  new Date(Date.now() + 330 * 60 * 1000 + offset * 86400000).toISOString().slice(0, 10);

const booking = async (doctor, { day = istDay(), visitType = "New Patient", rxMo = null } = {}) => {
  const patient = await buildPatient();
  patients.push(patient.id);
  const appt = await one(
    `INSERT INTO appointments (patient_id, patient_name, appointment_date, doctor_name, visit_type, status)
     VALUES ($1, $2, $3::date, $4, $5, 'checkedin') RETURNING id`,
    [patient.id, patient.name, day, doctor.name, visitType],
  );
  const visit = await one(
    `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, current_status, rx_mo_id)
     VALUES ($1, $2::date, $3, 'checked_in', $4) RETURNING id`,
    [patient.id, day, appt.id, rxMo?.id ?? null],
  );
  return { patient: patient.id, name: patient.name, appointment: appt.id, visit: visit.id };
};

const login = async (doctor) => {
  const ctx = await request.newContext({ baseURL: API_URL });
  const res = await ctx.post("/api/auth/login", { data: { doctor_id: doctor.id, pin: PIN } });
  const body = await res.json();
  await ctx.dispose();
  return body;
};

const apiWith = (token) =>
  request.newContext({ baseURL: API_URL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

const expectRefused = async (res) => {
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.code).toBe("not_assisted_patient");
  expect(body.error).toContain(NOT_ASSIGNED);
};

test.describe.serial("V03 MO — prescriptions works only the patients assigned to them", () => {
  let mo;
  let session;

  test.beforeAll(async () => {
    for (const [doc, assists] of [
      [RX_MO, assisted.id],
      [OTHER_MO, assisted.id],
      [UNLINKED, null],
    ]) {
      await query(
        `INSERT INTO doctors (id, name, short_name, role, pin, is_active, assists_doctor_id)
         VALUES ($1, $2, $3, 'rx_mo', $4, TRUE, $5)
         ON CONFLICT (id) DO UPDATE SET name = $2, short_name = $3, role = 'rx_mo', is_active = TRUE,
           pin = $4, assists_doctor_id = $5`,
        [doc.id, doc.name, doc.short_name, PIN, assists],
      );
    }
    await query(`UPDATE doctors SET new_patient_workup = true WHERE id = $1`, [assisted.id]);
    session = await login(RX_MO);
    mo = await apiWith(session.access_token);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM new_patient_workups WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM giniflow_visits WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM patients WHERE id = ANY($1)`, [patients]);
    await query(`UPDATE doctors SET new_patient_workup = false WHERE id = $1`, [assisted.id]);
    await query(`UPDATE doctors SET is_active = false WHERE id = ANY($1)`, [
      [RX_MO.id, OTHER_MO.id, UNLINKED.id],
    ]);
    await mo?.dispose();
  });

  test("1. login says whom the MO assists, and never sends the PIN", async () => {
    expect(session.doctor.role).toBe("rx_mo");
    expect(session.doctor.assists).toMatchObject({ id: assisted.id, name: assisted.name });
    expect(session.doctor.pin).toBeUndefined();
    const me = await (await mo.get("/api/auth/me")).json();
    expect(me.doctor.assists.id).toBe(assisted.id);
  });

  test("2. today's list and counts are only the patients assigned to this MO", async () => {
    const mine = await booking(assisted, { rxMo: RX_MO });
    const unassigned = await booking(assisted);
    const colleague = await booking(assisted, { rxMo: OTHER_MO });
    const list = await (
      await mo.get(
        `/api/appointments?date=${istDay()}&doctor=${encodeURIComponent(other.name)}&limit=100`,
      )
    ).json();
    const ids = (list.data || list.appointments || list.rows || list).map((a) => a.id);
    expect(ids).toContain(mine.appointment);
    expect(ids).not.toContain(unassigned.appointment);
    expect(ids).not.toContain(colleague.appointment);

    const stats = await (await mo.get(`/api/home-stats?date=${istDay()}`)).json();
    expect(stats.stats.total).toBe(ids.length);
  });

  test("3. an assigned patient opens and saves; anyone else is refused", async () => {
    const mine = await booking(assisted, { rxMo: RX_MO });
    const unassigned = await booking(assisted);
    const colleague = await booking(assisted, { rxMo: OTHER_MO });
    expect((await mo.get(`/api/visit/${mine.patient}`)).status()).toBe(200);
    const saved = await mo.put(`/api/visit/${mine.patient}/workup`, {
      data: { appointment_id: mine.appointment, history: { complaints: "Polyuria" } },
    });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).workup.prepared_by).toBe(RX_MO.name);

    for (const v of [unassigned, colleague]) {
      await expectRefused(await mo.get(`/api/visit/${v.patient}`));
      await expectRefused(await mo.get(`/api/patients/${v.patient}`));
      await expectRefused(await mo.get(`/api/appointments/${v.appointment}`));
      await expectRefused(
        await mo.put(`/api/visit/${v.patient}/workup`, {
          data: { appointment_id: v.appointment, history: { complaints: "x" } },
        }),
      );
    }
  });

  test("3b. the block warning and scheme list load only for assigned patients", async () => {
    const mine = await booking(assisted, { rxMo: RX_MO });
    const unassigned = await booking(assisted);
    expect((await mo.get(`/api/patient-block-status?patient_ids=${mine.patient}`)).status()).toBe(
      200,
    );
    expect(
      (
        await mo.get(`/api/patient-block-status?patient_ids=${mine.patient},${unassigned.patient}`)
      ).status(),
    ).toBe(403);
    expect((await mo.get("/api/patient-schemes")).status()).toBe(200);
  });

  test("3c. the coordinator assigns and unassigns an MO on the triage board", async () => {
    const coordinator = await apiAs("care_coordinator");
    const v = await booking(assisted);
    await expectRefused(await mo.get(`/api/visit/${v.patient}`));

    const staff = await (
      await coordinator.get(`/api/giniflow/triage/staff?date=${istDay()}`)
    ).json();
    expect(staff.staff.find((p) => p.id === RX_MO.id)).toMatchObject({ role: "rx_mo" });

    const wrong = await coordinator.patch(`/api/giniflow/triage/${v.visit}`, {
      data: { rxMoId: other.id },
    });
    expect(wrong.status()).toBe(400);

    const ok = await coordinator.patch(`/api/giniflow/triage/${v.visit}`, {
      data: { rxMoId: RX_MO.id },
    });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).rxMo).toEqual({ rxMoId: RX_MO.id, rxMoName: RX_MO.short_name });
    expect((await mo.get(`/api/visit/${v.patient}`)).status()).toBe(200);

    const board = await (await coordinator.get(`/api/giniflow/board?date=${istDay()}`)).json();
    const cards = JSON.stringify(board);
    expect(cards).toContain(`"rxMoId":${RX_MO.id}`);
    expect(cards).toContain(`"rxMoName":"${RX_MO.short_name}"`);

    const audit = await one(
      `SELECT details FROM audit_log WHERE action = 'rx_mo_assigned' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.details).toEqual({ visit_id: v.visit, rx_mo_id: RX_MO.id });

    await coordinator.patch(`/api/giniflow/triage/${v.visit}`, { data: { rxMoId: null } });
    await expectRefused(await mo.get(`/api/visit/${v.patient}`));
    await coordinator.dispose();
  });

  test("4. yesterday's assigned patient can be read but not written to", async () => {
    const past = await booking(assisted, { day: istDay(-1), rxMo: RX_MO });
    expect((await mo.get(`/api/visit/${past.patient}`)).status()).toBe(200);
    await expectRefused(
      await mo.post(`/api/visit/${past.patient}/symptom`, { data: { name: "Fatigue" } }),
    );
  });

  test("5. floor screens, all-patient lists and the SQL agent are closed", async () => {
    for (const path of [
      "/api/giniflow/board",
      "/api/giniflow/triage",
      "/api/flow/visits",
      "/api/genie-patients",
      "/api/app-patients",
      "/api/ghm-appointments",
      "/api/opd/appointments",
      "/api/patients?q=a",
      "/api/messages/unread-count",
    ]) {
      expect((await mo.get(path)).status(), path).toBe(403);
    }
    expect((await mo.post("/api/ai/agent", { data: { message: "list patients" } })).status()).toBe(
      403,
    );
  });

  test("6. an MO login not linked to a consultant can do nothing", async () => {
    const unlinked = await login(UNLINKED);
    const api = await apiWith(unlinked.access_token);
    const v = await booking(assisted, { rxMo: UNLINKED });
    const res = await api.get(`/api/visit/${v.patient}`);
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toContain("isn't linked to a consultant");
    expect((await api.get("/api/auth/me")).status()).toBe(200);
    await api.dispose();
  });

  test("7. only an rx_mo can assist, and only a consultant can be assisted", async () => {
    const admin = await apiAs("admin");
    expect(
      (
        await admin.patch(`/api/doctors/${other.id}`, { data: { assists_doctor_id: assisted.id } })
      ).status(),
    ).toBe(400);
    expect(
      (
        await admin.patch(`/api/doctors/${RX_MO.id}`, { data: { assists_doctor_id: 9001 } })
      ).status(),
    ).toBe(400);
    const ok = await admin.patch(`/api/doctors/${RX_MO.id}`, {
      data: { assists_doctor_id: assisted.id },
    });
    expect(ok.status()).toBe(200);
    expect(
      (
        await admin.post("/api/doctors", {
          data: { name: "Dr No Link", role: "rx_mo", pin: "1234" },
        })
      ).status(),
    ).toBe(400);
    const flag = await admin.patch(`/api/doctors/${other.id}`, {
      data: { new_patient_workup: true },
    });
    expect((await flag.json()).new_patient_workup).toBe(true);
    await admin.patch(`/api/doctors/${other.id}`, { data: { new_patient_workup: false } });
    await admin.dispose();
  });

  test("8. in the browser the MO sees only their assigned patients and writes the workup", async ({
    page,
  }) => {
    const mine = await booking(assisted, { rxMo: RX_MO });
    const unassigned = await booking(assisted);
    await page.addInitScript(
      ([token, refresh]) => {
        window.localStorage.setItem("gini_auth_token", token);
        window.localStorage.setItem("gini_refresh_token", refresh);
      },
      [session.access_token, session.refresh_token],
    );
    const refused = [];
    page.on("response", (r) => {
      if (r.status() === 403 && r.url().includes("/api/")) refused.push(new URL(r.url()).pathname);
    });
    await gotoReady(page, `/visit?patient=${mine.patient}&appt=${mine.appointment}`, () =>
      page.locator(".sct", { hasText: "New patient History & Examination" }),
    );
    await page.getByLabel("C/O (chief complaints)").fill("Written by the MO");
    await expect(page.getByText(/^Saved \d/)).toBeVisible();
    const nav = page.getByRole("navigation").first();
    await expect(nav.getByRole("link", { name: /OPD|GF Stations|Find/ })).toHaveCount(0);
    expect([...new Set(refused)].sort()).toEqual(["/api/conversations", "/api/lab-requests"]);

    await gotoReady(page, "/", () => page.getByText(mine.name).first());
    await expect(page.getByText(unassigned.name)).toHaveCount(0);
  });
});
