import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { anonymousApi, apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { PIN, USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const visitLines = await import("../../../server/services/billing/visitLines.js");
const removal = await import("../../../server/services/doctorRemoval.js");

const db = getPool();
const tag = crypto.randomBytes(3).toString("hex");
const API_DOCTOR = `Dr P4C08 Api ${tag}`;
const PAGE_DOCTOR = `Dr P4C08 Page ${tag}`;
const COUNTER_DOCTOR = `Dr P4C08 Counter ${tag}`;
const ours = {};

async function doctor(name) {
  const { pin } = await one(`SELECT pin FROM doctors WHERE id = $1`, [USERS.reception.id]);
  return (
    await one(
      `INSERT INTO doctors (name, short_name, role, pin, is_active)
       VALUES ($1, $1, 'consultant', $2, TRUE) RETURNING id`,
      [name, pin],
    )
  ).id;
}

async function futureAppointment(doctorId, name) {
  await query(
    `INSERT INTO appointments (patient_name, file_no, appointment_date, visit_type, doctor_id,
                               doctor_name)
     VALUES ($1, $2, (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 2, 'Follow Up', $3, $4)`,
    [`P4C08 Patient ${tag}`, `F4C8-${tag}`, doctorId, name],
  );
}

async function dropDoctors() {
  const doctors = [ours.api, ours.page, ours.counter].filter(Boolean);
  if (!doctors.length) return;
  await query(`DELETE FROM auth_sessions WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM refresh_tokens WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM audit_log WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM audit_log WHERE entity_type = 'doctor' AND entity_id = ANY($1)`, [
    doctors,
  ]);
  await query(`DELETE FROM appointments WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM doctors WHERE id = ANY($1)`, [doctors]);
}

async function logIn(api, id) {
  return api.post("/api/auth/login", { data: { doctor_id: id, pin: PIN } });
}

let autoBefore;

test.describe.serial("P4C-08 delete a doctor from Doctor Management", () => {
  test.beforeAll(async () => {
    ours.api = await doctor(API_DOCTOR);
    ours.page = await doctor(PAGE_DOCTOR);
    await futureAppointment(ours.api, API_DOCTOR);
    await futureAppointment(ours.page, PAGE_DOCTOR);
  });

  test.afterAll(async () => {
    await dropDoctors();
  });

  test("1. only an admin can see, delete or restore", async () => {
    const anonymous = await anonymousApi();
    const desk = await apiAs("reception_admin");
    try {
      for (const api of [anonymous, desk]) {
        const expected = api === anonymous ? 401 : 403;
        expect((await api.get("/api/doctors/removed")).status()).toBe(expected);
        expect((await api.get(`/api/doctors/${ours.api}/removal`)).status()).toBe(expected);
        expect(
          (await api.post(`/api/doctors/${ours.api}/removal`, { data: { reason: "No" } })).status(),
        ).toBe(expected);
        expect((await api.delete(`/api/doctors/${ours.api}/removal`)).status()).toBe(expected);
      }
      const row = await one(`SELECT is_active FROM doctors WHERE id = $1`, [ours.api]);
      expect(row.is_active).toBe(true);
    } finally {
      await anonymous.dispose();
      await desk.dispose();
    }
  });

  test("2. delete signs the doctor out everywhere and refuses their login", async () => {
    const anonymous = await anonymousApi();
    const admin = await apiAs("admin");
    try {
      const login = await logIn(anonymous, ours.api);
      expect(login.status()).toBe(200);
      const { access_token: access, refresh_token: refresh } = await login.json();
      const me = () =>
        anonymous.get("/api/auth/me", { headers: { Authorization: `Bearer ${access}` } });
      expect((await (await me()).json()).authenticated).toBe(true);

      const blank = await admin.post(`/api/doctors/${ours.api}/removal`, { data: {} });
      expect(blank.status()).toBe(400);
      const preview = await admin.get(`/api/doctors/${ours.api}/removal`);
      expect(await preview.json()).toMatchObject({ future_appointments: 1, open_drafts: 0 });

      const removed = await admin.post(`/api/doctors/${ours.api}/removal`, {
        data: { reason: "Moved to another city" },
      });
      expect(removed.status()).toBe(200);
      expect(await removed.json()).toMatchObject({
        future_appointments: 1,
        open_drafts: 0,
        sessions_revoked: 1,
        refresh_tokens_revoked: 1,
      });

      expect((await (await me()).json()).authenticated).toBe(false);
      const refreshed = await anonymous.post("/api/auth/refresh", {
        data: { refresh_token: refresh },
      });
      expect(refreshed.ok()).toBe(false);
      expect((await logIn(anonymous, ours.api)).ok()).toBe(false);
      const list = await (await anonymous.get("/api/doctors")).json();
      expect(list.map((d) => d.id)).not.toContain(ours.api);
      const removedList = await (await admin.get("/api/doctors/removed")).json();
      expect(removedList.find((d) => d.id === ours.api)).toMatchObject({
        name: API_DOCTOR,
        removed_reason: "Moved to another city",
        removed_by_name: USERS.admin.name,
      });
    } finally {
      await anonymous.dispose();
      await admin.dispose();
    }
  });

  test("3. restore lets the doctor log in again", async () => {
    const anonymous = await anonymousApi();
    const admin = await apiAs("admin");
    try {
      const restored = await admin.delete(`/api/doctors/${ours.api}/removal`);
      expect(restored.status()).toBe(200);
      expect((await restored.json()).doctor).toMatchObject({ is_active: true, removed_at: null });
      expect((await logIn(anonymous, ours.api)).status()).toBe(200);
      const list = await (await anonymous.get("/api/doctors")).json();
      expect(list.map((d) => d.id)).toContain(ours.api);
    } finally {
      await anonymous.dispose();
      await admin.dispose();
    }
  });

  test("4. the page deletes with a reason, lists the doctor as removed, and restores", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/doctor-management", () =>
      page.getByRole("heading", { name: "Doctor Management" }),
    );
    const picker = page.locator(".docmgmt-head select");
    await expect(picker.locator(`option[value="${ours.page}"]`)).toHaveCount(1);
    await picker.selectOption(String(ours.page));

    await page.locator(".docmgmt-head").getByRole("button", { name: "Delete doctor" }).click();
    const dialog = page.getByRole("dialog", { name: `Delete ${PAGE_DOCTOR}?` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("future appointment still booked with them")).toContainText("1");
    await expect(dialog.getByText("open draft bills still charging")).toContainText("0");
    const confirm = dialog.getByRole("button", { name: "Delete doctor" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Reason (required)").fill("   ");
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Reason (required)").fill("Left in September");
    await confirm.click();
    await expect(dialog).toBeHidden();

    await expect(picker.locator(`option[value="${ours.page}"]`)).toHaveCount(0);
    const removed = page.getByRole("region", { name: "🗑️ Removed doctors" });
    const row = removed.getByRole("row").filter({ hasText: PAGE_DOCTOR });
    await expect(row).toContainText("Left in September");
    await expect(row).toContainText(USERS.admin.name);
    const stored = await one(
      `SELECT is_active, removed_reason, removed_by FROM doctors WHERE id = $1`,
      [ours.page],
    );
    expect(stored).toEqual({
      is_active: false,
      removed_reason: "Left in September",
      removed_by: USERS.admin.id,
    });

    await row.getByRole("button", { name: "Restore" }).click();
    await expect(row).toHaveCount(0);
    await expect(picker.locator(`option[value="${ours.page}"]`)).toHaveCount(1);
    const back = await one(`SELECT is_active FROM doctors WHERE id = $1`, [ours.page]);
    expect(back.is_active).toBe(true);
  });

  test("5. an admin can't delete their own account from the page", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/doctor-management", () =>
      page.getByRole("heading", { name: "Doctor Management" }),
    );
    await page.locator(".docmgmt-head select").selectOption(String(USERS.admin.id));
    await expect(
      page.locator(".docmgmt-head").getByRole("button", { name: "Delete doctor" }),
    ).toBeDisabled();
  });
});

test.describe.serial("P4C-08 the billing counter under a removed doctor", () => {
  const fixtureTag = newTag();
  let ids;

  test.beforeAll(async () => {
    ids = await setUp(fixtureTag);
    autoBefore = await autoConsultation(true);
    ours.counter = await doctor(COUNTER_DOCTOR);
    ours.item = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, visit_type,
                                    doctor_id)
         VALUES ($1, $2, $3, 1300, 'consultation', 'New', $4) RETURNING id`,
        [`P4-C8C-${fixtureTag}`, `P4 Consult Counter ${fixtureTag}`, ids.subgroup, ours.counter],
      )
    ).id;
    ours.before = await extraVisit(ids, "C8B", { doctorId: ours.counter });
    await visitLines.draftAtCheckIn(ours.before.visit, desk, db);
    await removal.removeDoctor(
      ours.counter,
      { reason: "Left" },
      { actorId: USERS.admin.id, ip: "10.9.8.3", role: "admin" },
      db,
    );
    ours.after = await extraVisit(ids, "C8After", { doctorId: ours.counter });
  });

  test.afterAll(async () => {
    try {
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
      await tearDown(ids);
    } finally {
      await dropDoctors();
    }
  });

  const open = (page, visitId) =>
    gotoReady(page, `/giniflow/station/billing?visit=${visitId}`, () =>
      page.getByRole("region", { name: "Bill actions" }),
    );

  test("6. a draft with the removed doctor's fee can't be finalised and says why", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await open(page, ours.before.visit);
    const actions = page.getByRole("region", { name: "Bill actions" });
    await expect(
      actions.getByRole("list", { name: "Before this bill can be made final" }),
    ).toContainText(
      `${COUNTER_DOCTOR} was removed; remove P4 Consult Counter ${fixtureTag} from this bill first.`,
    );
    await expect(actions.getByRole("button", { name: "Finalise & print" })).toBeDisabled();
  });

  test("7. a visit checked in after the delete has no fee and the counter says why", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await open(page, ours.after.visit);
    await expect(
      page.getByText(`${COUNTER_DOCTOR} was removed, so this visit has no consultation fee.`),
    ).toBeVisible();
    const lines = await one(
      `SELECT count(*)::int AS n FROM bill_lines l JOIN bills b ON b.id = l.bill_id
        WHERE b.visit_id = $1`,
      [ours.after.visit],
    );
    expect(lines.n).toBe(0);
  });
});
