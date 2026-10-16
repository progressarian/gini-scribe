import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

const { LIST_PREDICATES } = await import("../../shared/patientLists.js");
const { LAB_ONLY_DOCTOR } = await import("../../shared/labOnly.js");

async function appointment(patient, daysFromToday, visitType, status, doctor = "Dr E2E Banshali") {
  return one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        status, visit_type)
     VALUES ($1, $2, $3, $4, $7,
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date + $5::int, '12:30 PM to 1 PM', $6, $8)
     RETURNING id, visit_type`,
    [
      patient.id,
      patient.file_no,
      patient.name,
      patient.phone,
      daysFromToday,
      status,
      doctor,
      visitType,
    ],
  );
}

const visitTypeOf = async (id) =>
  (await one(`SELECT visit_type FROM appointments WHERE id = $1`, [id])).visit_type;

test.describe("G20 a patient who already came is never a new patient again", () => {
  let returning, brandNew, labOnly, earlyWalkIn;
  let admin;
  let date;
  const ids = () => [returning, brandNew, labOnly, earlyWalkIn].map((p) => p.id);

  test.beforeAll(async () => {
    date = (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`)).d;
    returning = await buildPatient();
    brandNew = await buildPatient();
    labOnly = await buildPatient();
    earlyWalkIn = await buildPatient();
    admin = await apiAs("admin");
  });

  test.afterAll(async () => {
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [ids()]);
    await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids()]);
  });

  test("1. a New booking after an attended visit is saved as Follow-Up", async () => {
    await appointment(returning, -4, "New Patient", "completed");
    const today = await appointment(returning, 0, "New", "scheduled");
    expect(today.visit_type).toBe("Follow-Up");
  });

  test("2. a sync that writes New again is corrected", async () => {
    const today = await one(
      `SELECT id FROM appointments WHERE patient_id = $1 AND visit_type = 'Follow-Up'`,
      [returning.id],
    );
    await query(`UPDATE appointments SET visit_type = 'New Patient' WHERE id = $1`, [today.id]);
    expect(await visitTypeOf(today.id)).toBe("Follow-Up");
  });

  test("3. a first visit, and a booking after only a lab-only visit, stay New", async () => {
    expect((await appointment(brandNew, 0, "New", "scheduled")).visit_type).toBe("New");
    await appointment(labOnly, -4, "New Patient", "completed", LAB_ONLY_DOCTOR);
    expect((await appointment(labOnly, 0, "New", "scheduled")).visit_type).toBe("New");
  });

  test("4. coming in early turns the patient's later New booking into Follow-Up", async () => {
    const later = await appointment(earlyWalkIn, 3, "New", "scheduled");
    const walkIn = await appointment(earlyWalkIn, -1, "New Patient", "checkedin");
    expect(walkIn.visit_type).toBe("New Patient");
    expect(await visitTypeOf(later.id)).toBe("Follow-Up");
    await query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [walkIn.id]);
    expect(await visitTypeOf(walkIn.id)).toBe("New Patient");
  });

  test("5. GHM counts and lists the returning patient as a follow-up", async () => {
    const res = await admin.get(
      `/api/ghm-appointments?date=${date}&limit=500&page=1&calls=all&bucket=follow_up`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ours = (p) => body.data.find((r) => r.patient_id === p.id);
    expect(ours(returning)).toBeTruthy();
    expect(ours(brandNew)).toBeFalsy();
    expect(ours(labOnly)).toBeFalsy();
    const tabsOf = (row) =>
      Object.keys(LIST_PREDICATES).filter((k) => LIST_PREDICATES[k](row, date));
    expect(tabsOf(ours(returning))).toEqual(["followup"]);
  });
});
