import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

const { skipSunday, effectiveFollowUpDate, followUpDueDate, weekdayFollowUpDate, isClosedDay } =
  await import("../../shared/followUp.js");

const SUNDAY = "2026-10-18";
const MONDAY = "2026-10-19";

test.describe("G23 a follow-up never lands on a Sunday, and Sunday cannot be a preferred date", () => {
  let patient;

  test.beforeAll(async () => {
    patient = await buildPatient();
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM appointment_change_log WHERE appointment_id IN
         (SELECT id FROM appointments WHERE patient_id = $1)`,
      [patient.id],
    );
    await query(`DELETE FROM appointments WHERE patient_id = $1`, [patient.id]);
    await query(`DELETE FROM patients WHERE id = $1`, [patient.id]);
  });

  test("1. a Sunday follow-up moves to Monday, other days stay", () => {
    expect(skipSunday(SUNDAY)).toBe(MONDAY);
    expect(skipSunday(MONDAY)).toBe(MONDAY);
    expect(skipSunday("")).toBe("");
    expect(isClosedDay(SUNDAY)).toBe(true);
    expect(isClosedDay(MONDAY)).toBe(false);
  });

  test("2. every way a follow-up is read skips Sunday", () => {
    expect(effectiveFollowUpDate({ follow_up_date: SUNDAY })).toBe(MONDAY);
    expect(effectiveFollowUpDate({ healthray_follow_up: { date: SUNDAY } })).toBe(MONDAY);
    expect(followUpDueDate("2026-10-11", "1 week")).toBe(MONDAY);
    expect(weekdayFollowUpDate("2026-10-16", "follow up on Sunday")).toBe(MONDAY);
  });

  test("3. the stored follow-up date the GHM lists use skips Sunday", async () => {
    const { own } = await one(
      `INSERT INTO appointments (patient_id, file_no, patient_name, phone, doctor_name, time_slot,
                                 status, visit_type, appointment_date, follow_up_date)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali', '10:00', 'completed', 'Follow-Up',
               '2026-10-11', $5)
       RETURNING own_follow_up_date::text AS own`,
      [patient.id, patient.file_no, patient.name, patient.phone, SUNDAY],
    );
    expect(own).toBe(MONDAY);
  });

  test("4. the server refuses a Sunday preferred date and accepts a Monday", async () => {
    const { id } = await one(
      `INSERT INTO appointments (patient_id, file_no, patient_name, phone, doctor_name, time_slot,
                                 status, visit_type, appointment_date)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali', '10:00', 'scheduled', 'Follow-Up',
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 1)
       RETURNING id`,
      [patient.id, patient.file_no, patient.name, patient.phone],
    );
    const api = await apiAs("admin");
    const sunday = await api.patch(`/api/ghm-appointments/${id}`, {
      data: { preferred_date: "2026-12-06" },
    });
    expect(sunday.status()).toBe(400);
    expect((await sunday.json()).error).toMatch(/closed on Sunday/);
    const monday = await api.patch(`/api/ghm-appointments/${id}`, {
      data: { preferred_date: "2026-12-07" },
    });
    expect(monday.status()).toBe(200);
  });
});
