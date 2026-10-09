import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

const istDay = async (offset) =>
  (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS d`, [offset]))
    .d;

test.describe("booking by phone when the phone also has a blocked duplicate", () => {
  let phone;
  let duplicate;
  let kept;
  let api;

  test.beforeEach(async () => {
    phone = `6${String(Date.now()).slice(-9)}`;
    duplicate = await buildPatient({ phone, is_blocked: true, blocked_note: "Duplicate" });
    kept = await buildPatient({ phone });
    api = await apiAs("reception_admin");
  });

  test.afterEach(async () => {
    await query(
      `DELETE FROM appointment_change_log WHERE appointment_id IN
         (SELECT id FROM appointments WHERE phone = $1)`,
      [phone],
    );
    await query(`DELETE FROM appointments WHERE phone = $1`, [phone]);
    await query(`DELETE FROM walkin_bookings WHERE contact_number = $1`, [phone]);
    await query(`DELETE FROM patient_block_log WHERE patient_id = ANY($1::int[])`, [
      [duplicate.id, kept.id],
    ]);
    await query(`DELETE FROM patients WHERE phone = $1`, [phone]);
  });

  const book = async (extra = {}) =>
    api.post("/api/ghm-appointments", {
      data: {
        patient_name: kept.name,
        phone,
        doctor_name: "Dr E2E Banshali",
        appointment_date: await istDay(5),
        time_slot: "12:30 PM to 1 PM",
        visit_type: "Follow Up",
        ...extra,
      },
    });

  test("a GHM booking by phone goes to the unblocked record", async () => {
    const res = await book();
    expect(res.status()).toBe(201);
    expect((await res.json()).patient_id).toBe(kept.id);
  });

  test("a walk-in by phone is not refused", async () => {
    const res = await api.post("/api/walkins", {
      data: { walkin_date: await istDay(1), patient_name: kept.name, contact_number: phone },
    });
    expect(res.status()).toBe(201);
  });

  test("a new patient on that phone is still refused", async () => {
    const res = await book({ new_patient: true, patient_name: "E2E Relative" });
    expect(res.status()).toBe(409);
  });
});
