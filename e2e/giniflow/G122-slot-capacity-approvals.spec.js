import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const doctor = CONSULTANTS.banshali;
const other = CONSULTANTS.beant;
const istDay = (offset = 0) =>
  new Date(Date.now() + offset * 86400000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
const weekdayAhead = (from) => {
  for (let i = from; ; i += 1) {
    const d = istDay(i);
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) return d;
  }
};
const DAY = weekdayAhead(40);
const TEN = "10 AM to 10:30 AM";
const HALF = "10:30 AM to 11 AM";

const template = {
  partialLast: "drop",
  hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    start: "10:00",
    end: "11:00",
    slotMinutes: 30,
    capNew: 1,
    capFollowup: 1,
    capWalkin: null,
  })),
  breaks: [],
};

let admin;
let reception;
const patients = {};

const book = (api, fileNo, slot = TEN, who = doctor) =>
  api.post("/api/appointments", {
    data: {
      patient_name: `G122 ${fileNo}`,
      file_no: fileNo,
      doctor_name: who.name,
      appointment_date: DAY,
      time_slot: slot,
    },
  });

const slotOf = async (label, who = doctor) => {
  const r = await admin.get(
    `/api/availability/day?doctor=${encodeURIComponent(who.name)}&date=${DAY}`,
  );
  return (await r.json()).slots.find((s) => s.slot_label === label);
};

const cleanUp = async () => {
  await query(`DELETE FROM appointment_reassignments WHERE file_no LIKE 'G122-%'`);
  await query(`DELETE FROM appointments WHERE file_no LIKE 'G122-%' OR patient_name LIKE 'G122 %'`);
  await query(`DELETE FROM patients WHERE file_no LIKE 'G122-%'`);
  await query(
    `DELETE FROM doctor_slot_templates WHERE doctor_id = ANY($1) AND effective_from > '2026-01-01'`,
    [[doctor.id, other.id]],
  );
};

test.describe.serial("G122 patients per slot by type; over the limit waits for approval", () => {
  test.beforeAll(async () => {
    await cleanUp();
    admin = await apiAs("admin");
    reception = await apiAs("reception");
    for (const key of ["new1", "new2", "new3", "new4", "new5", "new6", "back1", "back2"]) {
      const row = await one(`INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`, [
        `G122 ${key}`,
        `G122-${key}`,
      ]);
      patients[key] = row.id;
    }
    for (const key of ["back1", "back2"])
      await query(
        `INSERT INTO appointments (patient_id, patient_name, file_no, doctor_name, appointment_date, status)
         VALUES ($1, $2, $3, $4, $5, 'completed')`,
        [patients[key], `G122 ${key}`, `G122-${key}`, doctor.name, istDay(-30)],
      );
    for (const who of [doctor, other]) {
      const r = await admin.post(`/api/doctors/${who.id}/slot-templates`, {
        data: { effective_from: istDay(), template },
      });
      expect(r.status()).toBe(201);
    }
  });

  test.afterAll(async () => {
    await admin.patch("/api/giniflow/floor-settings/ghm_slots_from_schedule", {
      data: { value: false },
    });
    await cleanUp();
    await admin?.dispose();
    await reception?.dispose();
  });

  test("1. the first new patient fits; a second new patient in that slot waits for approval", async () => {
    const first = await (await book(reception, "G122-new1")).json();
    expect(first.approval).toBeNull();

    const second = await (await book(reception, "G122-new2")).json();
    expect(second.approval).toMatchObject({ status: "pending", patient_type: "new", limit: 1 });
    expect(second.time_slot).toBe(TEN);

    const latest = await (
      await reception.get(`/api/booking-approvals/latest?ids=${first.id},${second.id}`)
    ).json();
    expect(latest.map((a) => [a.appointment_id, a.status])).toEqual([[second.id, "pending"]]);
    expect((await slotOf(TEN)).counts).toEqual({ new: 2, followup: 0, walkin: 0, pending: 1 });
  });

  test("2. a patient seen before counts as a follow-up, whatever the visit type says", async () => {
    const back = await (await book(reception, "G122-back1")).json();
    expect(back.visit_type).toBe("OPD");
    expect(back.approval).toBeNull();
    expect((await slotOf(TEN)).counts.followup).toBe(1);
  });

  test("3. someone who can approve is approved straight away, with a record", async () => {
    const r = await (await book(admin, "G122-new3")).json();
    expect(r.approval).toMatchObject({ status: "approved", patient_type: "new" });
    const row = await one(
      `SELECT status, decided_by, reason FROM booking_approvals WHERE appointment_id = $1`,
      [r.id],
    );
    expect(row.decided_by).toBe(9001);
    expect(row.reason).toMatch(/over the limit/);
  });

  test("4. moving a pending booking to a free slot withdraws its request", async () => {
    const pending = await one(
      `SELECT appointment_id FROM booking_approvals WHERE status = 'pending' AND slot_label = $1
         AND appointment_id IN (SELECT id FROM appointments WHERE file_no = 'G122-new2')`,
      [TEN],
    );
    const moved = await (
      await reception.put(`/api/appointments/${pending.appointment_id}`, {
        data: { time_slot: HALF },
      })
    ).json();
    expect(moved.approval).toBeNull();
    const old = await one(
      `SELECT status, reason FROM booking_approvals WHERE appointment_id = $1`,
      [pending.appointment_id],
    );
    expect(old).toEqual({
      status: "withdrawn",
      reason: "Booking moved to another date, time or doctor",
    });
  });

  test("5. cancelling a pending booking withdraws its request", async () => {
    const r = await (await book(reception, "G122-new4", HALF)).json();
    expect(r.approval.status).toBe("pending");
    await reception.put(`/api/appointments/${r.id}`, { data: { status: "cancelled" } });
    const row = await one(
      `SELECT status, reason FROM booking_approvals WHERE appointment_id = $1`,
      [r.id],
    );
    expect(row).toEqual({ status: "withdrawn", reason: "Booking cancelled" });
  });

  test("6. a HealthRay booking counts but is never held for approval", async () => {
    await query(
      `INSERT INTO appointments (patient_name, file_no, doctor_name, appointment_date, time_slot, status, healthray_id)
       VALUES ('G122 HealthRay', 'G122-hr', $1, $2, '10:40', 'booked', 990000301)`,
      [doctor.name, DAY],
    );
    const half = await slotOf(HALF);
    expect(half.counts.new).toBe(2);
    const held = await one(
      `SELECT count(*)::int AS n FROM booking_approvals
        WHERE appointment_id IN (SELECT id FROM appointments WHERE file_no = 'G122-hr')`,
    );
    expect(held.n).toBe(0);
  });

  test("7. reassigning into a slot already full for that type is allowed, and recorded", async () => {
    const r = await (await book(reception, "G122-back2", TEN, other)).json();
    expect(r.approval).toBeNull();
    const offered = await (
      await admin.get(
        `/api/availability/doctors-for-slot?date=${DAY}&slot=${encodeURIComponent(TEN)}&exclude=${other.id}&appointment=${r.id}`,
      )
    ).json();
    const target = offered.find((d) => d.doctor_id === doctor.id);
    expect(target.over_limit).toEqual({ patient_type: "followup", limit: 1, count: 1 });
    expect(offered.at(-1).doctor_id).toBe(doctor.id);

    const moved = await admin.put(`/api/appointments/${r.id}/reassign`, {
      data: { to_doctor_id: doctor.id, to_doctor_name: doctor.name, trigger: "manual" },
    });
    expect(moved.ok()).toBe(true);
    expect((await moved.json()).approval).toMatchObject({
      status: "approved",
      patient_type: "followup",
    });
    const now = await one(`SELECT doctor_name FROM appointments WHERE id = $1`, [r.id]);
    expect(now.doctor_name).toBe(doctor.name);
  });

  test("8. only admins and reception admins can see and decide requests", async () => {
    const pending = await (await book(reception, "G122-new5")).json();
    expect(pending.approval.status).toBe("pending");
    expect((await reception.get("/api/booking-approvals")).status()).toBe(403);
    const desk = await apiAs("reception_admin");
    const list = await (await desk.get("/api/booking-approvals")).json();
    const row = list.find((a) => a.appointment_id === pending.id);
    expect(row).toMatchObject({
      patient_name: "G122 G122-new5",
      doctor_name: doctor.name,
      slot_label: TEN,
      patient_type: "new",
      limit: 1,
      count: 2,
      requested_by: "E2E Reception",
    });
    expect((await (await desk.get("/api/booking-approvals/count")).json()).pending).toBeGreaterThan(
      0,
    );
    await desk.dispose();
  });

  test("9. reject needs a reason, clears the slot and is logged; it can't be decided twice", async () => {
    const appt = await one(`SELECT id FROM appointments WHERE file_no = 'G122-new5'`);
    const req = await one(
      `SELECT id FROM booking_approvals WHERE appointment_id = $1 AND status = 'pending'`,
      [appt.id],
    );
    const empty = await admin.post(`/api/booking-approvals/${req.id}/reject`, {
      data: { reason: "  " },
    });
    expect(empty.status()).toBe(400);
    const r = await admin.post(`/api/booking-approvals/${req.id}/reject`, {
      data: { reason: "Doctor full, offer 11 AM" },
    });
    expect(r.ok()).toBe(true);
    const booking = await one(
      `SELECT time_slot, appointment_date::text FROM appointments WHERE id = $1`,
      [appt.id],
    );
    expect(booking).toEqual({ time_slot: null, appointment_date: DAY });
    const latest = await (
      await reception.get(`/api/booking-approvals/latest?ids=${appt.id}`)
    ).json();
    expect(latest[0]).toMatchObject({ status: "rejected", reason: "Doctor full, offer 11 AM" });
    const log = await query(
      `SELECT field, old_value, new_value FROM appointment_change_log WHERE appointment_id = $1 ORDER BY id`,
      [appt.id],
    );
    expect(log.rows.map((l) => l.field)).toEqual(
      expect.arrayContaining(["time_slot", "booking_approval"]),
    );
    const again = await admin.post(`/api/booking-approvals/${req.id}/approve`);
    expect(again.status()).toBe(409);
  });

  test("10. the Approvals page lists the request with the patient's identity and approves it", async ({
    page,
  }) => {
    const pending = await (
      await reception.post("/api/appointments", {
        data: {
          patient_name: "G122 G122-new6",
          file_no: "G122-new6",
          doctor_name: doctor.name,
          appointment_date: DAY,
          time_slot: TEN,
          over_limit_reason: "Coming from Shimla, only morning bus",
        },
      })
    ).json();
    expect(pending.approval.status).toBe("pending");
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/booking-approvals", () =>
      page.getByRole("heading", { name: "Desk requests" }),
    );
    await expect(page).toHaveURL(/\/desk-requests\?tab=bookings/);
    const tab = page.getByRole("tab", { name: /Booking limits/ });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("link", { name: /Approvals/ })).toHaveCount(0);
    const row = page
      .getByRole("table", { name: "Pending approvals" })
      .getByRole("row")
      .filter({ hasText: "G122 G122-new6" });
    await expect(row).toContainText("G122-new6");
    await expect(row).toContainText("3rd new patient · limit 1");
    await expect(row).toContainText("E2E Reception");
    await expect(row).toContainText("Reason: Coming from Shimla, only morning bus");
    await row.getByRole("button", { name: /^Approve/ }).click();
    await expect(page.getByText(`G122 G122-new6 approved for ${TEN}`)).toBeVisible();
    await expect(row).toHaveCount(0);
    await page.getByRole("button", { name: "Decided (last 30 days)" }).click();
    await expect(
      page
        .getByRole("table", { name: "Decided approvals" })
        .getByRole("row")
        .filter({ hasText: "G122 G122-new6" }),
    ).toContainText("Approved");
  });
  test("11. the slot list knows the chosen patient's type and marks slots full for it", async () => {
    const day = async (who, extra) =>
      (
        await (
          await reception.get(
            `/api/availability/day?doctor=${encodeURIComponent(who.name)}&date=${DAY}${extra}`,
          )
        ).json()
      ).slots.find((s) => s.slot_label === TEN);
    const back = await day(doctor, "&file_no=G122-back1");
    expect(back.patient_type).toBe("followup");
    expect(back.over_limit).toEqual({ patient_type: "followup", limit: 1, count: 2 });
    const fresh = await day(doctor, "&file_no=G122-nobody");
    expect(fresh.patient_type).toBe("new");
    expect(fresh.over_limit.patient_type).toBe("new");
    const walkin = await day(doctor, "&walkin=1");
    expect(walkin).toMatchObject({ patient_type: "walkin", over_limit: null });

    const own = await one(
      `SELECT id FROM appointments WHERE file_no = 'G122-back1' AND appointment_date = $1`,
      [DAY],
    );
    const editing = await day(doctor, `&file_no=G122-back1&exclude=${own.id}`);
    expect(editing.over_limit.count).toBe(1);

    const unlimited = await (
      await reception.get(
        `/api/availability/day?doctor=${encodeURIComponent(CONSULTANTS.rahul.name)}&date=${DAY}&file_no=G122-back1`,
      )
    ).json();
    expect(unlimited.slots.every((s) => s.over_limit === null)).toBe(true);
  });

  test("12. picking a full slot at the desk asks first, then books it as pending approval", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await gotoReady(page, "/find", () => page.getByRole("button", { name: "+ Book" }));
    await page.getByRole("button", { name: "+ Book" }).click();
    await page.getByPlaceholder("Patient name *").fill("G122 Quick");
    await page.getByPlaceholder("File No").fill("G122-quick");
    await page
      .locator("select")
      .filter({ has: page.locator("option", { hasText: "Select Doctor *" }) })
      .selectOption(doctor.short_name);
    await page.locator('input[type="date"]').first().fill(DAY);
    const slotSelect = page
      .locator("select")
      .filter({ has: page.locator("option", { hasText: "Time slot" }) });
    await expect(slotSelect.locator("option", { hasText: TEN })).toContainText(
      "full · over the limit",
    );

    await slotSelect.selectOption(TEN);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`${TEN} is full for new patients`);
    if (process.env.DM_SHOTS)
      await page.screenshot({ path: `${process.env.DM_SHOTS}/overlimit-dialog.png` });
    await dialog.getByRole("button", { name: "Choose another slot" }).click();
    await expect(slotSelect).toHaveValue("");

    await slotSelect.selectOption(TEN);
    const send = page
      .getByRole("dialog")
      .getByRole("button", { name: "Book and send for approval" });
    await expect(send).toBeDisabled();
    await page
      .getByRole("dialog")
      .getByLabel(/Why does the patient need this slot/)
      .fill("Patient works nights and can only come at 10");
    await send.click();
    await expect(slotSelect).toHaveValue(TEN);
    await page.getByRole("button", { name: "Book", exact: true }).click();
    await expect(page.getByText(/Booked, pending admin approval/)).toBeVisible();
    const row = await one(
      `SELECT ba.status, ba.request_reason FROM booking_approvals ba
         JOIN appointments a ON a.id = ba.appointment_id
        WHERE a.file_no = 'G122-quick'`,
    );
    expect(row).toEqual({
      status: "pending",
      request_reason: "Patient works nights and can only come at 10",
    });
  });
  test("13. with the setting on, GHM's Time Slot lists the consultant's own slots", async ({
    page,
  }) => {
    const off = await (await reception.get("/api/ghm-appointments/display-settings")).json();
    expect(off).toEqual({ slots_from_schedule: false });
    const days = await (
      await reception.get(
        `/api/availability/days?pairs=${encodeURIComponent(`${doctor.name}|${DAY},Nobody|${DAY}`)}`,
      )
    ).json();
    expect(days[`${doctor.name}|${DAY}`].map((s) => s.slot_label)).toEqual([TEN, HALF]);
    expect(days[`Nobody|${DAY}`]).toBeNull();

    await book(reception, "G122-ghm", HALF);
    const r = await admin.patch("/api/giniflow/floor-settings/ghm_slots_from_schedule", {
      data: { value: true },
    });
    expect(r.ok()).toBe(true);
    expect(await (await reception.get("/api/ghm-appointments/display-settings")).json()).toEqual({
      slots_from_schedule: true,
    });

    await loginAs(page, "reception");
    await gotoReady(page, `/ghm?tab=by_date&date=${DAY}`, () =>
      page.getByRole("row").filter({ hasText: "G122 G122-ghm" }),
    );
    const row = page.getByRole("row").filter({ hasText: "G122 G122-ghm" });
    await row.getByRole("button", { name: "Preferred time" }).click();
    const list = page.getByRole("listbox");
    await expect(list.getByRole("option", { name: new RegExp(`^${TEN}`) })).toBeVisible();
    await expect(list.getByRole("option", { name: new RegExp(`^${HALF}`) })).toBeVisible();
    await expect(list.getByRole("option", { name: /^8 AM to 9 AM/ })).toHaveCount(0);
    if (process.env.DM_SHOTS)
      await page.screenshot({ path: `${process.env.DM_SHOTS}/ghm-slots.png` });
  });
  test("14. GHM's Consultant slots panel shows a consultant's day with counts and limits", async ({
    page,
  }) => {
    await loginAs(page, "obt_one");
    await gotoReady(page, `/ghm?tab=by_date&date=${DAY}`, () =>
      page.getByRole("button", { name: /Consultant slots/ }),
    );
    await page.getByRole("button", { name: /Consultant slots/ }).click();
    const panel = page.getByRole("dialog", { name: "Consultant slots" });
    await expect(panel).toContainText("Choose a consultant to see their slots");
    await panel.getByLabel("Search consultant").fill("zzz-nobody");
    await expect(panel).toContainText('No consultant matches "zzz-nobody"');
    await panel.getByLabel("Search consultant").fill(doctor.name.toLowerCase());
    await expect(panel.getByRole("combobox")).toHaveValue(doctor.name);
    await expect(panel.getByLabel("Date")).toHaveValue(DAY);
    const table = panel.getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(3);
    const ten = table.getByRole("row", { name: new RegExp(`^${TEN}`) });
    await expect(ten).toContainText(/New \d+\/1 full/);
    await expect(ten).toContainText(/Follow-up \d+\/1/);
    await expect(panel.getByRole("status")).toContainText("of 2 slots open");
    if (process.env.DM_SHOTS)
      await page.screenshot({ path: `${process.env.DM_SHOTS}/ghm-panel.png` });
    await panel.getByRole("button", { name: "Next day" }).click();
    await expect(panel.getByLabel("Date")).not.toHaveValue(DAY);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  });
});
