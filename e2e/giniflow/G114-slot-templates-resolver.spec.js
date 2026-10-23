import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const doctor = CONSULTANTS.beant;
const other = CONSULTANTS.rahul;
const istDay = (offset = 0) =>
  new Date(Date.now() + offset * 86400000).toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
const weekdayAhead = () => {
  for (let i = 7; ; i += 1) {
    const d = istDay(i);
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) return d;
  }
};
const DAY = weekdayAhead();
const HR_IDS = [990000101, 990000102, 990000103];

let admin;
const dayView = async () => {
  const r = await admin.get(
    `/api/availability/day?doctor=${encodeURIComponent(doctor.name)}&date=${DAY}`,
  );
  expect(r.ok()).toBe(true);
  return r.json();
};
const slot = (view, label) => view.slots.find((s) => s.slot_label === label);

test.describe.serial("G114 booking slots come from the doctor's schedule template", () => {
  test.beforeAll(async () => {
    admin = await apiAs("admin");
    await query(
      `INSERT INTO appointments (patient_name, file_no, doctor_name, appointment_date, time_slot, status, healthray_id)
       VALUES ('G114 Label', 'G114-1', $1, $2, '10 AM to 10:30 AM', 'booked', NULL),
              ('G114 HealthRay', 'G114-2', $1, $2, '10:15', 'booked', $3),
              ('G114 After hours', 'G114-3', $1, $2, '15:00', 'booked', $4),
              ('G114 In lunch', 'G114-4', $1, $2, '11:10', 'booked', $5)`,
      [doctor.name, DAY, ...HR_IDS],
    );
  });

  test.afterAll(async () => {
    await query(`DELETE FROM appointments WHERE file_no LIKE 'G114-%'`);
    await query(`DELETE FROM doctor_unavailability WHERE doctor_id = $1`, [doctor.id]);
    await query(`DELETE FROM appointment_reassignments WHERE file_no LIKE 'G114-%'`);
    await query(
      `DELETE FROM doctor_slot_templates WHERE doctor_id = ANY($1) AND effective_from > '2026-01-01'`,
      [[doctor.id, other.id, CONSULTANTS.banshali.id]],
    );
    await admin?.dispose();
  });

  test("1. the seeded 24-hour template gives today's 32 slots and counts every booking by its time", async () => {
    const view = await dayView();
    expect(view.from_template).toBe(true);
    expect(view.slots).toHaveLength(32);
    expect(view.slots.every((s) => s.blocked_by === null)).toBe(true);
    expect(slot(view, "10 AM to 10:30 AM").booked).toBe(2);
    expect(slot(view, "3 PM to 3:30 PM").booked).toBe(1);
    expect(view.warnings).toEqual([]);
  });

  const weekdays = (start, end) =>
    [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start, end, slotMinutes: 30 }));
  const saveToday = (template) =>
    admin.post(`/api/doctors/${doctor.id}/slot-templates`, {
      data: { effective_from: istDay(), template },
    });

  test("2. saving a schedule from today makes a new template version that booking follows", async () => {
    const r = await saveToday({
      hours: weekdays("09:30", "13:30"),
      breaks: [{ weekday: null, name: "Lunch", start: "11:00", end: "11:30" }],
    });
    expect(r.status()).toBe(201);
    const versions = await one(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE effective_from = $2::date AND status = 'active')::int AS today
         FROM doctor_slot_templates WHERE doctor_id = $1`,
      [doctor.id, istDay()],
    );
    expect(versions).toEqual({ active: 2, today: 1 });

    const view = await dayView();
    expect(view.slots.map((s) => [s.slot_label, s.blocked_by])).toEqual([
      ["9:30 AM to 10 AM", null],
      ["10 AM to 10:30 AM", null],
      ["10:30 AM to 11 AM", null],
      ["11 AM to 11:30 AM", "break"],
      ["11:30 AM to 12 PM", null],
      ["12 PM to 12:30 PM", null],
      ["12:30 PM to 1 PM", null],
      ["1 PM to 1:30 PM", null],
    ]);
    expect(slot(view, "11 AM to 11:30 AM").detail).toBe("Lunch");
    expect(view.warnings.map((w) => w.message)).toEqual([
      "Booked in HealthRay at 11:10 AM — inside Lunch",
      "Booked in HealthRay at 3 PM — outside working hours",
    ]);
  });

  test("3. saving again the same day replaces today's version instead of stacking a second", async () => {
    const r = await saveToday({ hours: weekdays("09:30", "12:00"), breaks: [] });
    expect(r.status()).toBe(201);
    const versions = await one(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status = 'withdrawn')::int AS withdrawn
         FROM doctor_slot_templates WHERE doctor_id = $1`,
      [doctor.id],
    );
    expect(versions).toEqual({ active: 2, withdrawn: 1 });
    const view = await dayView();
    expect(view.slots.at(-1).slot_label).toBe("11:30 AM to 12 PM");
    expect(view.slots.some((s) => s.blocked_by === "break")).toBe(false);
  });

  test("4. a single-slot check reads a HealthRay time, not only a label", async () => {
    const r = await admin.get(
      `/api/availability/doctors-for-slot?date=${DAY}&slot=${encodeURIComponent("10:15")}`,
    );
    expect(r.ok()).toBe(true);
    const ids = (await r.json()).map((d) => d.doctor_id);
    expect(ids).toContain(doctor.id);
    const late = await admin.get(
      `/api/availability/doctors-for-slot?date=${DAY}&slot=${encodeURIComponent("4 PM to 4:30 PM")}`,
    );
    expect((await late.json()).map((d) => d.doctor_id)).not.toContain(doctor.id);
  });

  test("5. 'only the rest of today' is refused for leave running past today", async () => {
    const r = await admin.post(`/api/doctors/${doctor.id}/emergency-leave`, {
      data: { start_date: istDay(), end_date: istDay(1), from_now: true, slot_labels: null },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe("from_now_today_only");
    const none = await one(
      `SELECT count(*)::int AS n FROM doctor_unavailability WHERE doctor_id = $1`,
      [doctor.id],
    );
    expect(none.n).toBe(0);
  });
  const morning = {
    partialLast: "drop",
    hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      start: "09:30",
      end: "10:30",
      slotMinutes: 30,
    })),
    breaks: [],
  };

  test("6. the version list shows who saved what, and which version applies today", async () => {
    const r = await admin.get(`/api/doctors/${doctor.id}/slot-templates`);
    expect(r.ok()).toBe(true);
    const body = await r.json();
    expect(body.today).toBe(istDay());
    expect(body.versions.map((v) => [v.effectiveFrom, v.status])).toEqual([
      [istDay(), "active"],
      [istDay(), "withdrawn"],
      ["2026-01-01", "active"],
    ]);
    expect(body.current_id).toBe(body.versions[0].id);
    expect(body.versions[0].hours[0]).toEqual({
      weekday: 1,
      start: "09:30",
      end: "12:00",
      slotMinutes: 30,
    });
  });

  test("7. checking a new schedule lists the bookings that would fall outside it, nothing saved", async () => {
    const before = await one(
      `SELECT count(*)::int AS n FROM doctor_slot_templates WHERE doctor_id = $1`,
      [doctor.id],
    );
    const r = await admin.post(`/api/doctors/${doctor.id}/slot-templates/check`, {
      data: { effective_from: DAY, template: morning },
    });
    expect(r.ok()).toBe(true);
    const { affected } = await r.json();
    expect(affected.map((a) => [a.patient_name, a.reason, a.healthray])).toEqual([
      ["G114 After hours", "outside working hours", true],
      ["G114 In lunch", "outside working hours", true],
    ]);
    const after = await one(
      `SELECT count(*)::int AS n FROM doctor_slot_templates WHERE doctor_id = $1`,
      [doctor.id],
    );
    expect(after.n).toBe(before.n);
  });

  test("8. a schedule starting later applies from its date only, and can be withdrawn before it starts", async () => {
    const saved = await admin.post(`/api/doctors/${doctor.id}/slot-templates`, {
      data: { effective_from: DAY, template: morning, note: "Mornings only" },
    });
    expect(saved.status()).toBe(201);
    const { id, affected } = await saved.json();
    expect(affected).toHaveLength(2);
    expect((await dayView()).slots.map((s) => s.slot_label)).toEqual([
      "9:30 AM to 10 AM",
      "10 AM to 10:30 AM",
    ]);

    const withdrawn = await admin.post(`/api/doctors/${doctor.id}/slot-templates/${id}/withdraw`);
    expect(withdrawn.ok()).toBe(true);
    const again = await admin.post(`/api/doctors/${doctor.id}/slot-templates/${id}/withdraw`);
    expect(again.status()).toBe(409);
    expect((await dayView()).slots.at(-1).slot_label).toBe("11:30 AM to 12 PM");
  });

  test("9. a past start date, a break outside hours and today's version withdraw are refused", async () => {
    const past = await admin.post(`/api/doctors/${doctor.id}/slot-templates`, {
      data: { effective_from: istDay(-1), template: morning },
    });
    expect(past.status()).toBe(400);
    expect((await past.json()).errors[0].field).toBe("effective_from");

    const bad = await admin.post(`/api/doctors/${doctor.id}/slot-templates`, {
      data: {
        effective_from: DAY,
        template: {
          ...morning,
          breaks: [{ weekday: null, name: "Lunch", start: "13:00", end: "14:00" }],
        },
      },
    });
    expect(bad.status()).toBe(400);
    const body = await bad.json();
    expect(body.errors[0]).toEqual({
      field: "breaks.0.start",
      message: "Lunch (1 PM–2 PM) is outside the working hours on every day.",
    });

    const list = await (await admin.get(`/api/doctors/${doctor.id}/slot-templates`)).json();
    const r = await admin.post(
      `/api/doctors/${doctor.id}/slot-templates/${list.current_id}/withdraw`,
    );
    expect(r.status()).toBe(409);
  });
  test("10. one schedule applied to several doctors: dry run first, then saved, and a rerun skips them", async () => {
    const body = { effective_from: DAY, template: morning, doctor_ids: [doctor.id, other.id] };
    const dry = await admin.post(`/api/doctor-slot-templates/apply`, { data: body });
    expect(dry.ok()).toBe(true);
    const preview = (await dry.json()).doctors;
    expect(preview.map((d) => [d.doctor_id, d.unchanged, d.affected.length]).sort()).toEqual(
      [
        [doctor.id, false, 2],
        [other.id, false, 0],
      ].sort(),
    );
    const none = await one(
      `SELECT count(*)::int AS n FROM doctor_slot_templates WHERE doctor_id = $1 AND effective_from = $2`,
      [other.id, DAY],
    );
    expect(none.n).toBe(0);

    const saved = await admin.post(`/api/doctor-slot-templates/apply`, {
      data: { ...body, dry_run: false },
    });
    expect(await saved.json()).toEqual({
      saved: expect.arrayContaining([doctor.id, other.id]),
      skipped: [],
      failed: null,
    });
    const again = await admin.post(`/api/doctor-slot-templates/apply`, {
      data: { ...body, dry_run: false },
    });
    expect((await again.json()).skipped.sort()).toEqual([doctor.id, other.id].sort());
    const rerun = await admin.post(`/api/doctor-slot-templates/apply`, { data: body });
    expect((await rerun.json()).doctors.every((d) => d.unchanged)).toBe(true);
  });

  test("11. a moved booking takes the new doctor's slot that holds its time", async () => {
    const twenty = {
      ...morning,
      hours: morning.hours.map((h) => ({ ...h, start: "09:00", end: "12:00", slotMinutes: 20 })),
    };
    const r = await admin.post(`/api/doctor-slot-templates/apply`, {
      data: { effective_from: DAY, template: twenty, doctor_ids: [other.id], dry_run: false },
    });
    expect((await r.json()).saved).toEqual([other.id]);
    const appt = await one(
      `INSERT INTO appointments (patient_name, file_no, doctor_name, appointment_date, time_slot, status)
       VALUES ('G114 Moved', 'G114-5', $1, $2, '10 AM to 10:30 AM', 'booked') RETURNING id`,
      [doctor.name, DAY],
    );
    const moved = await admin.put(`/api/appointments/${appt.id}/reassign`, {
      data: { to_doctor_id: other.id, to_doctor_name: other.name, trigger: "schedule_change" },
    });
    expect(moved.ok()).toBe(true);
    const row = await one(`SELECT doctor_name, time_slot FROM appointments WHERE id = $1`, [
      appt.id,
    ]);
    expect(row).toEqual({ doctor_name: other.name, time_slot: "10 AM to 10:20 AM" });
  });

  test("12. writing many doctors at once is refused; the screen sends them in batches", async () => {
    const r = await admin.post(`/api/doctor-slot-templates/apply`, {
      data: { effective_from: DAY, template: morning, all: true, dry_run: false },
    });
    expect(r.status()).toBe(400);
  });
  test("13. a bulk schedule with an end date goes back to each doctor's usual schedule", async () => {
    const third = CONSULTANTS.banshali;
    const plus = (iso, n) => {
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const from = plus(DAY, 14);
    const until = plus(DAY, 20);
    const body = {
      effective_from: from,
      effective_until: until,
      template: morning,
      doctor_ids: [third.id],
    };
    const dry = await (await admin.post(`/api/doctor-slot-templates/apply`, { data: body })).json();
    expect(dry.doctors[0]).toMatchObject({ doctor_id: third.id, conflict: null, unchanged: false });

    const saved = await admin.post(`/api/doctor-slot-templates/apply`, {
      data: { ...body, dry_run: false },
    });
    expect(await saved.json()).toEqual({ saved: [third.id], skipped: [], failed: null });
    const versions = await query(
      `SELECT effective_from::text, note FROM doctor_slot_templates
        WHERE doctor_id = $1 AND status = 'active' AND effective_from > '2026-01-01'
        ORDER BY effective_from`,
      [third.id],
    );
    expect(versions.rows.map((v) => v.effective_from)).toEqual([from, plus(until, 1)]);
    expect(versions.rows[1].note).toMatch(/^Back to the usual schedule after/);

    const dayOf = async (date) =>
      (
        await (
          await admin.get(
            `/api/availability/day?doctor=${encodeURIComponent(third.name)}&date=${date}`,
          )
        ).json()
      ).slots.filter((s) => s.blocked_by !== "day_off").length;
    const weekday = (iso) => {
      for (let i = 0; ; i += 1) {
        const d = plus(iso, i);
        if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) return d;
      }
    };
    expect(await dayOf(weekday(from))).toBe(2);
    expect(await dayOf(weekday(plus(until, 1)))).toBe(32);

    const again = await admin.post(`/api/doctor-slot-templates/apply`, {
      data: { ...body, dry_run: false },
    });
    expect((await again.json()).skipped).toEqual([third.id]);
  });

  test("14. a planned change inside the period is replaced, and the doctor goes back to it after the end date", async () => {
    const nextDay = (iso) => {
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const planned = await one(
      `SELECT id FROM doctor_slot_templates
        WHERE doctor_id = $1 AND status = 'active' AND effective_from = $2::date`,
      [other.id, DAY],
    );
    const body = {
      effective_from: istDay(1),
      effective_until: DAY,
      template: morning,
      doctor_ids: [other.id],
    };
    const dry = await (await admin.post(`/api/doctor-slot-templates/apply`, { data: body })).json();
    expect(dry.doctors[0]).toMatchObject({
      conflict: null,
      unchanged: false,
      replaces: [{ effectiveFrom: DAY, clears: false }],
    });
    const r = await (
      await admin.post(`/api/doctor-slot-templates/apply`, { data: { ...body, dry_run: false } })
    ).json();
    expect(r).toEqual({ saved: [other.id], skipped: [], failed: null });
    const gone = await one(`SELECT status FROM doctor_slot_templates WHERE id = $1`, [planned.id]);
    expect(gone.status).toBe("withdrawn");
    const active = await query(
      `SELECT effective_from::text FROM doctor_slot_templates
        WHERE doctor_id = $1 AND status = 'active' AND effective_from >= $2::date
        ORDER BY effective_from`,
      [other.id, istDay(1)],
    );
    expect(active.rows.map((v) => v.effective_from)).toEqual([istDay(1), nextDay(DAY)]);
  });

  test("14b. a schedule with no end date replaces every later planned change", async () => {
    const later = await admin.post(`/api/doctors/${other.id}/slot-templates`, {
      data: { effective_from: istDay(30), template: morning, note: "Planned later" },
    });
    expect(later.status()).toBe(201);
    const check = await (
      await admin.post(`/api/doctors/${other.id}/slot-templates/check`, {
        data: { effective_from: istDay(2), template: morning },
      })
    ).json();
    expect(check.replaces.map((v) => v.effectiveFrom)).toContain(istDay(30));
    const saved = await admin.post(`/api/doctors/${other.id}/slot-templates`, {
      data: { effective_from: istDay(2), template: morning },
    });
    expect(saved.status()).toBe(201);
    expect((await saved.json()).replaced).toBeGreaterThan(0);
    const left = await one(
      `SELECT count(*)::int AS n FROM doctor_slot_templates
        WHERE doctor_id = $1 AND status = 'active' AND effective_from > $2::date`,
      [other.id, istDay(2)],
    );
    expect(left.n).toBe(0);
  });
  test("15. per-slot limits by patient type are saved and every slot reports its counts", async () => {
    const capped = {
      ...morning,
      hours: morning.hours.map((h) => ({ ...h, capNew: 1, capFollowup: 0, capWalkin: null })),
    };
    const r = await admin.post(`/api/doctors/${doctor.id}/slot-templates`, {
      data: { effective_from: DAY, template: capped },
    });
    expect(r.status()).toBe(201);
    const list = await (await admin.get(`/api/doctors/${doctor.id}/slot-templates`)).json();
    const saved = list.versions.find((v) => v.effectiveFrom === DAY && v.status === "active");
    expect(saved.hours[0]).toMatchObject({ capNew: 1, capFollowup: 0, capWalkin: null });

    const ten = slot(await dayView(), "10 AM to 10:30 AM");
    expect(ten.caps).toEqual({ new: 1, followup: 0, walkin: null, within3: null });
    expect(ten.counts).toEqual({ new: 2, followup: 0, walkin: 0, within3: 0, pending: 0 });
    expect(ten.available).toBe(true);

    const bad = await admin.post(`/api/doctors/${doctor.id}/slot-templates`, {
      data: {
        effective_from: DAY,
        template: { ...morning, hours: [{ ...morning.hours[0], capWalkin: 150 }] },
      },
    });
    expect(bad.status()).toBe(400);
  });
});
