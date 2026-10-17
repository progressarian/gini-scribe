import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { apiAs, loginAs, userFor } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";
import { gotoReady } from "../helpers/browser.mjs";

const RUN = `Chg${Date.now().toString(36)}`;
const made = [];

const istDay = async (offset = 0) =>
  (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS d`, [offset]))
    .d;

async function patientWithVisit(extra = {}) {
  const patient = await buildPatient({ name: `E2E ${RUN} ${made.length}` });
  made.push(patient);
  const visit = await one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, status,
        visit_type, time_slot, booked_by_name, source)
     VALUES ($1, $2, $3, $4, $5, (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 5, 'scheduled',
             'Follow Up', $6, $7, $8)
     RETURNING id`,
    [
      patient.id,
      patient.file_no,
      patient.name,
      patient.phone,
      extra.doctor || "Dr E2E Banshali",
      extra.time_slot ?? "11 AM to 12 PM",
      extra.booked_by_name ?? null,
      extra.source ?? null,
    ],
  );
  return { patient, id: visit.id };
}

const staff = () => userFor("reception_admin");

async function cleanupMade() {
  for (const p of made.splice(0)) {
    await query(
      `DELETE FROM appointment_change_log WHERE appointment_id IN
         (SELECT id FROM appointments WHERE file_no = $1)`,
      [p.file_no],
    );
    await query(`DELETE FROM appointments WHERE file_no = $1`, [p.file_no]);
    await query(`DELETE FROM patients WHERE id = $1`, [p.id]);
  }
}

async function logChange(id, field, oldValue, newValue, at = "NOW()", actor = staff()) {
  await query(
    `INSERT INTO appointment_change_log
       (appointment_id, field, field_label, old_value, new_value, changed_by, changed_by_id, changed_at)
     VALUES ($1, $2, $2, $3, $4, $5, $6, ${at})`,
    [id, field, oldValue, newValue, actor.short_name ?? actor.name, actor.id ?? null],
  );
}

async function changes(api, params) {
  const res = await api.get(
    `/api/ghm-appointments?${new URLSearchParams({ mode: "changes", ...params })}`,
  );
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test.describe("G25 Status Changes tab", () => {
  let api;
  let today;

  test.beforeAll(async () => {
    api = await apiAs("reception_admin");
    today = await istDay(0);
  });

  test.afterAll(async () => {
    await api.dispose();
    await cleanupMade();
  });

  test("1. a Booking Status set on the sheet is listed, by the logged-in user", async () => {
    const { patient, id } = await patientWithVisit();
    const res = await api.patch(`/api/ghm-appointments/${id}`, {
      data: { booking_status: "not_connected" },
    });
    expect(res.ok()).toBeTruthy();
    const out = await changes(api, { from: today, to: today, q: patient.file_no });
    expect(out.data).toHaveLength(1);
    expect(out.data[0]).toMatchObject({
      id,
      kind: "not_connected",
      changed_by: staff().short_name,
      file_no: patient.file_no,
    });
    expect(out.summary.not_connected).toBe(1);
  });

  test("2. a preferred date and time set together count as Booked; moving the date is Rescheduled", async () => {
    const booked = await patientWithVisit();
    await logChange(booked.id, "preferred_date", null, "2026-12-07");
    await logChange(booked.id, "preferred_time_slot", null, "5 PM to 6 PM");
    const moved = await patientWithVisit();
    await logChange(moved.id, "preferred_date", null, "2026-12-07", "NOW() - INTERVAL '3 days'");
    await logChange(moved.id, "preferred_date", "2026-12-07", "2026-12-09");

    const a = await changes(api, { from: today, to: today, q: booked.patient.file_no });
    expect(a.data.map((r) => r.kind)).toEqual(["booked"]);
    const b = await changes(api, { from: today, to: today, q: moved.patient.file_no });
    expect(b.data[0]).toMatchObject({ kind: "rescheduled", was_date: "2026-12-07" });
  });

  test("3. booked then cancelled the same day is one Cancelled row; an undo the same day is not listed", async () => {
    const both = await patientWithVisit();
    await logChange(both.id, "booking_status", null, "booked", "NOW() - INTERVAL '2 minutes'");
    await logChange(both.id, "booking_status", "booked", "cancelled");
    const undone = await patientWithVisit();
    await logChange(undone.id, "booking_status", null, "booked", "NOW() - INTERVAL '2 minutes'");
    await logChange(undone.id, "booking_status", "booked", null);

    const a = await changes(api, { from: today, to: today, q: both.patient.file_no });
    expect(a.data).toHaveLength(1);
    expect(a.data[0]).toMatchObject({ kind: "cancelled", changes: 2 });
    const b = await changes(api, { from: today, to: today, q: undone.patient.file_no });
    expect(b.data).toHaveLength(0);
  });

  test("4. automatic changes and non-OBT bookings are not listed; GHM and sheet bookings are", async () => {
    const system = await patientWithVisit();
    await logChange(system.id, "booking_status", null, "booked", "NOW()", {
      name: "System (slot allocated = booked)",
    });
    const healthray = await patientWithVisit();
    await logChange(healthray.id, "booking_created", null, "x");
    const ghm = await patientWithVisit({ booked_by_name: "Jaspreet" });
    await logChange(ghm.id, "booking_created", null, "x");
    const sheet = await patientWithVisit({ source: "sheets" });
    await logChange(sheet.id, "booking_created", null, "x", "NOW()", {
      name: "Booking sheet sync",
    });

    const kindsOf = async (p) =>
      (await changes(api, { from: today, to: today, q: p.patient.file_no })).data.map(
        (r) => r.kind,
      );
    expect(await kindsOf(system)).toEqual([]);
    expect(await kindsOf(healthray)).toEqual([]);
    expect(await kindsOf(ghm)).toEqual(["booked"]);
    expect(await kindsOf(sheet)).toEqual(["booked"]);
  });

  test("5. the date filter uses the Indian day the change was made", async () => {
    const late = await patientWithVisit();
    await logChange(
      late.id,
      "booking_status",
      null,
      "cancelled",
      `((NOW() AT TIME ZONE 'Asia/Kolkata')::date::timestamp + INTERVAL '30 minutes') AT TIME ZONE 'Asia/Kolkata'`,
    );
    const old = await patientWithVisit();
    await logChange(old.id, "booking_status", null, "booked", "NOW() - INTERVAL '1 day'");

    const yesterday = await istDay(-1);
    expect((await changes(api, { from: today, to: today, q: late.patient.file_no })).total).toBe(1);
    expect((await changes(api, { from: today, to: today, q: old.patient.file_no })).total).toBe(0);
    const y = await changes(api, { from: yesterday, to: yesterday, q: old.patient.file_no });
    expect(y.data[0]).toMatchObject({ kind: "booked", change_day: yesterday, since_kind: null });
  });

  test("6. a later change shows on the older row", async () => {
    const p = await patientWithVisit();
    await logChange(p.id, "booking_status", null, "booked", "NOW() - INTERVAL '1 day'");
    await logChange(p.id, "booking_status", "booked", "cancelled");
    const yesterday = await istDay(-1);
    const y = await changes(api, { from: yesterday, to: yesterday, q: p.patient.file_no });
    expect(y.data[0]).toMatchObject({ kind: "booked", since_kind: "cancelled", since_day: today });
  });

  test("7. kind, doctor, changed-by and search filters; pills follow the filters", async () => {
    const a = await patientWithVisit({ doctor: "Dr E2E Other" });
    await logChange(a.id, "booking_status", null, "rescheduled");
    const b = await patientWithVisit();
    await logChange(b.id, "booking_status", null, "booked", "NOW()", { name: "Nancy", id: 9002 });

    const all = await changes(api, { from: today, to: today, q: RUN });
    expect(all.summary.all).toBe(all.total);
    expect(all.actors).toContain("Nancy");
    const resched = await changes(api, { from: today, to: today, q: RUN, kind: "rescheduled" });
    expect(resched.data.every((r) => r.kind === "rescheduled")).toBeTruthy();
    expect(resched.summary.all).toBe(all.summary.all);
    const doc = await changes(api, { from: today, to: today, q: RUN, doctor: "E2E Other" });
    expect(doc.data.map((r) => r.id)).toEqual([a.id]);
    const byNancy = await changes(api, { from: today, to: today, q: RUN, by: "Nancy" });
    expect(byNancy.data.map((r) => r.id)).toEqual([b.id]);
    const byPhone = await changes(api, { from: today, to: today, q: b.patient.phone });
    expect(byPhone.data.map((r) => r.id)).toContain(b.id);
  });

  test("8. pages neither repeat nor skip rows", async () => {
    const all = await changes(api, { from: today, to: today, q: RUN, limit: 100 });
    expect(all.total).toBeGreaterThan(3);
    const seen = [];
    for (let page = 1; page <= Math.ceil(all.total / 2); page++) {
      const out = await changes(api, { from: today, to: today, q: RUN, limit: 2, page });
      seen.push(...out.data.map((r) => r.id));
    }
    expect(seen).toEqual(all.data.map((r) => r.id));
  });

  test("9. blocked and lab-only patients are left out", async () => {
    const blocked = await patientWithVisit();
    await query(`UPDATE patients SET is_blocked = TRUE WHERE id = $1`, [blocked.patient.id]);
    await logChange(blocked.id, "booking_status", null, "cancelled");
    const lab = await patientWithVisit({ doctor: "Dr. Hospital Admin" });
    await logChange(lab.id, "booking_status", null, "booked");
    for (const p of [blocked, lab]) {
      expect((await changes(api, { from: today, to: today, q: p.patient.file_no })).total).toBe(0);
    }
  });

  test("10. the range is capped at 90 days and never reaches the future", async () => {
    const out = await changes(api, { from: "2020-01-01", to: "2099-01-01", q: RUN });
    expect(out.range.to).toBe(today);
    expect(out.range.from).toBe(await istDay(-89));
  });
});

test.describe("G25 Status Changes tab — screen", () => {
  let booked;
  let cancelled;

  test.beforeAll(async () => {
    booked = await patientWithVisit();
    await logChange(booked.id, "booking_status", null, "booked");
    cancelled = await patientWithVisit();
    await logChange(cancelled.id, "booking_status", null, "cancelled");
  });

  test.afterAll(cleanupMade);

  const open = async (page) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, `/ghm?tab=changes&cq=${RUN}`, () =>
      page.getByRole("cell", { name: new RegExp(booked.patient.name) }),
    );
  };

  test("11. the tab lists today's changes and a pill narrows them", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("button", { name: "Status Changes" })).toBeVisible();
    await expect(
      page.getByRole("cell", { name: new RegExp(cancelled.patient.name) }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^1 Cancelled$/ }).click();
    await expect(page.getByRole("cell", { name: new RegExp(booked.patient.name) })).toHaveCount(0);
    await expect(
      page.getByRole("cell", { name: new RegExp(cancelled.patient.name) }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("ckind")).toBe("cancelled");
  });

  test("12. export gives one sheet per kind with the right patients", async ({ page }) => {
    await open(page);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Export Excel/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^ghm-status-changes_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const mod = await import("xlsx-js-style");
    const XLSX = mod?.default?.utils ? mod.default : mod;
    const wb = XLSX.read(fs.readFileSync(await download.path()));
    expect(wb.SheetNames).toEqual(["Booked", "Cancelled", "Rescheduled", "Not Connected"]);
    const names = (sheet) =>
      XLSX.utils
        .sheet_to_json(wb.Sheets[sheet], { header: 1 })
        .slice(2)
        .map((r) => r[0]);
    expect(names("Booked")).toContain(booked.patient.name);
    expect(names("Cancelled")).toEqual([cancelled.patient.name]);
  });

  test("13. at phone width the table scrolls with the patient column kept in view", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page);
    const wrap = page.locator(".chg-view .tbl-wrap");
    expect(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth)).toBeTruthy();
    const cell = page.locator("td.chg-tbl__pt").first();
    expect(await cell.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
    await expect(page.getByRole("button", { name: /Export Excel/ })).toBeVisible();
  });
});
