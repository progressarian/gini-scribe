import { test, expect } from "@playwright/test";
import { apiAs, userFor } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

async function bookedToday(status) {
  const patient = await buildPatient();
  const appt = await one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        status, visit_type)
     VALUES ($1, $2, $3, $4, 'Dr E2E Banshali', (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
             '07:55', $5, 'Follow-Up')
     RETURNING id`,
    [patient.id, patient.file_no, patient.name, patient.phone, status],
  );
  const visit = await one(
    `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, current_status)
     VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, $2, 'booked')
     RETURNING id`,
    [patient.id, appt.id],
  );
  return { patient, apptId: appt.id, visitId: visit.id };
}

const cleanup = async ({ patient, apptId, visitId }) => {
  await query(`DELETE FROM giniflow_visit_events WHERE visit_id = $1`, [visitId]);
  await query(`DELETE FROM giniflow_visits WHERE id = $1`, [visitId]);
  await query(`DELETE FROM appointment_change_log WHERE appointment_id = $1`, [apptId]);
  await query(`DELETE FROM appointments WHERE id = $1`, [apptId]);
  await query(`DELETE FROM patients WHERE id = $1`, [patient.id]);
};

const statusOf = async (id) =>
  (await one(`SELECT status FROM appointments WHERE id = $1`, [id])).status;

test.describe("reception's cancel and no-show reach the appointment", () => {
  test("cancelling a checked-in visit cancels the appointment and logs who and why", async () => {
    const ctx = await bookedToday("checkedin");
    const api = await apiAs("reception_admin");
    try {
      const res = await api.post(`/api/giniflow/stations/reception/${ctx.visitId}/cancel`, {
        data: { reason: "not in fasting" },
      });
      expect(res.ok()).toBeTruthy();
      expect(await statusOf(ctx.apptId)).toBe("cancelled");

      const log = await one(
        `SELECT old_value, new_value, changed_by FROM appointment_change_log
          WHERE appointment_id = $1 AND field = 'status'`,
        [ctx.apptId],
      );
      expect(log.old_value).toBe("checkedin");
      expect(log.new_value).toBe("cancelled (not in fasting)");
      expect(log.changed_by).toBe(userFor("reception_admin").short_name);

      const undo = await api.post(`/api/giniflow/stations/reception/${ctx.visitId}/undo`);
      expect(undo.ok()).toBeTruthy();
      expect(await statusOf(ctx.apptId)).toBe("scheduled");
    } finally {
      await api.dispose();
      await cleanup(ctx);
    }
  });

  test("marking a no-show at the desk marks the appointment no-show", async () => {
    const ctx = await bookedToday("scheduled");
    const api = await apiAs("reception_admin");
    try {
      const res = await api.post(`/api/giniflow/stations/reception/${ctx.visitId}/no-show`);
      expect(res.ok()).toBeTruthy();
      expect(await statusOf(ctx.apptId)).toBe("no_show");
    } finally {
      await api.dispose();
      await cleanup(ctx);
    }
  });
});
