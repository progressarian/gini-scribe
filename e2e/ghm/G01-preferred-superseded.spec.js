import { test, expect } from "@playwright/test";
import { apiAs, userFor } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

const istDay = async (offset) =>
  (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS d`, [offset]))
    .d;

const listFileNos = async (api, date) => {
  const res = await api.get(`/api/ghm-appointments?date=${date}&limit=100`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data.map((r) => r.file_no);
};

async function patientWithPreference({ preferredOffset, setDaysAgo }) {
  const patient = await buildPatient();
  const visit = await one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, status,
        visit_type, preferred_date, preferred_time_slot, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 60, 'completed', 'Follow-Up',
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date + $5::int, '1 PM to 2 PM',
             NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days')
     RETURNING id`,
    [patient.id, patient.file_no, patient.name, patient.phone, preferredOffset],
  );
  await query(
    `INSERT INTO appointment_change_log
       (appointment_id, field, field_label, old_value, new_value, changed_by, changed_at)
     VALUES ($1, 'preferred_date', 'Preferred Date', NULL,
             ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $2::int)::text, 'Caller',
             NOW() - make_interval(days => $3::int))`,
    [visit.id, preferredOffset, setDaysAgo],
  );
  return { patient, visitId: visit.id };
}

const cleanup = async (patient) => {
  await query(
    `DELETE FROM call_claim_sessions WHERE appointment_id IN
       (SELECT id FROM appointments WHERE file_no = $1)`,
    [patient.file_no],
  );
  await query(
    `DELETE FROM appointment_change_log WHERE appointment_id IN
       (SELECT id FROM appointments WHERE file_no = $1)`,
    [patient.file_no],
  );
  await query(`DELETE FROM appointments WHERE file_no = $1`, [patient.file_no]);
  await query(`DELETE FROM patients WHERE id = $1`, [patient.id]);
};

test.describe("GHM preferred date vs a newer booking", () => {
  test("a newer booking on another date takes the patient off the preferred day", async () => {
    const { patient, visitId } = await patientWithPreference({
      preferredOffset: 20,
      setDaysAgo: 1,
    });
    const api = await apiAs("reception_admin");
    try {
      const preferredDay = await istDay(20);
      const bookedDay = await istDay(30);
      expect(await listFileNos(api, preferredDay)).toContain(patient.file_no);

      const res = await api.post("/api/ghm-appointments", {
        data: {
          patient_name: patient.name,
          file_no: patient.file_no,
          phone: patient.phone,
          doctor_name: "Dr E2E Banshali",
          appointment_date: bookedDay,
          time_slot: "12:30 PM to 1 PM",
          visit_type: "Follow Up",
        },
      });
      expect(res.status()).toBe(201);
      const booking = await res.json();
      expect(booking.booked_by_name).toBe(userFor("reception_admin").short_name);

      expect(await listFileNos(api, preferredDay)).not.toContain(patient.file_no);
      expect(await listFileNos(api, bookedDay)).toContain(patient.file_no);

      const hist = await (
        await api.get(`/api/appointment-changes?appointment_id=${booking.id}`)
      ).json();
      const superseded = hist.find((h) => h.kind === "superseded");
      expect(superseded).toMatchObject({
        appointment_id: visitId,
        old_value: preferredDay,
        new_value: `Booked for ${bookedDay}`,
      });
      expect(hist.some((h) => h.kind === "change" && h.appointment_id === visitId)).toBeTruthy();
      const bookedEntry = hist.find((h) => h.kind === "booking" && h.appointment_id === booking.id);
      expect(bookedEntry).toMatchObject({
        changed_by: userFor("reception_admin").short_name,
        changed_by_id: userFor("reception_admin").id,
      });
      expect(hist.some((h) => h.kind === "change" && h.field === "booking_created")).toBeFalsy();

      const audit = await one(
        `SELECT id FROM appointment_change_log
          WHERE appointment_id = $1 AND field = 'booking_created'`,
        [booking.id],
      );
      const del = await api.delete(`/api/appointment-changes/${audit.id}`);
      expect(del.status()).toBe(409);
    } finally {
      await api.dispose();
      await cleanup(patient);
    }
  });

  test("a preference set after the booking stays on the preferred day", async () => {
    const { patient } = await patientWithPreference({ preferredOffset: 40, setDaysAgo: 0 });
    await query(
      `INSERT INTO appointments
         (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, status,
          created_at)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 10, 'scheduled', NOW() - INTERVAL '2 days')`,
      [patient.id, patient.file_no, patient.name, patient.phone],
    );
    const api = await apiAs("reception_admin");
    try {
      expect(await listFileNos(api, await istDay(40))).toContain(patient.file_no);
    } finally {
      await api.dispose();
      await cleanup(patient);
    }
  });

  test("a calling flag nobody cleared is recorded as at most the 10-minute window", async () => {
    const patient = await buildPatient();
    const appt = await one(
      `INSERT INTO appointments
         (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, status,
          calling_by, calling_by_id, calling_since)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 5, 'scheduled',
               'Caller', NULL, NOW() - INTERVAL '5 hours')
       RETURNING id`,
      [patient.id, patient.file_no, patient.name, patient.phone],
    );
    await query(
      `INSERT INTO call_claim_sessions
         (appointment_id, patient_id, called_by, started_at, ended_at, duration_secs, ended_reason)
       VALUES ($1, $2, 'Caller', NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day', 172800, 'expired')`,
      [appt.id, patient.id],
    );
    const api = await apiAs("reception_admin");
    try {
      const claim = await api.post(`/api/ghm-appointments/${appt.id}/calling`);
      expect(claim.ok()).toBeTruthy();

      const stored = await one(
        `SELECT duration_secs, ended_reason FROM call_claim_sessions
          WHERE appointment_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [appt.id],
      );
      expect(stored).toEqual({ duration_secs: 600, ended_reason: "expired" });

      const sessions = await (await api.get(`/api/call-sessions?appointment_id=${appt.id}`)).json();
      expect(sessions.map((s) => s.duration_secs)).toEqual([600, 600]);
    } finally {
      await api.dispose();
      await cleanup(patient);
    }
  });
});

test.describe("GHM one open call per caller", () => {
  async function bookedPatient() {
    const patient = await buildPatient();
    const appt = await one(
      `INSERT INTO appointments
         (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, status)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 3, 'scheduled')
       RETURNING id`,
      [patient.id, patient.file_no, patient.name, patient.phone],
    );
    return { patient, id: appt.id };
  }

  test("a caller with an open call cannot start another until it ends", async () => {
    const first = await bookedPatient();
    const second = await bookedPatient();
    const api = await apiAs("reception_admin");
    try {
      expect((await api.post(`/api/ghm-appointments/${first.id}/calling`)).ok()).toBeTruthy();

      const blocked = await api.post(`/api/ghm-appointments/${second.id}/calling`);
      expect(blocked.status()).toBe(409);
      const body = await blocked.json();
      expect(body.error).toBe("still_calling");
      expect(body.open).toMatchObject({ id: first.id, file_no: first.patient.file_no });
      expect(body.message).toContain(first.patient.name);

      const switched = await api.post(`/api/ghm-appointments/${second.id}/calling`, {
        data: { release_previous: true },
      });
      expect(switched.ok()).toBeTruthy();
      const flags = await query(
        `SELECT id, calling_since IS NOT NULL AS open FROM appointments WHERE id = ANY($1) ORDER BY id`,
        [[first.id, second.id]],
      );
      expect(flags.rows).toEqual([
        { id: first.id, open: false },
        { id: second.id, open: true },
      ]);
    } finally {
      await api.dispose();
      await cleanup(first.patient);
      await cleanup(second.patient);
    }
  });

  test("setting the call status ends the caller's open call", async () => {
    const first = await bookedPatient();
    const second = await bookedPatient();
    const api = await apiAs("reception_admin");
    try {
      expect((await api.post(`/api/ghm-appointments/${first.id}/calling`)).ok()).toBeTruthy();
      const patched = await api.patch(`/api/ghm-appointments/${first.id}`, {
        data: { call_status: "called" },
      });
      expect(patched.ok()).toBeTruthy();
      expect((await api.post(`/api/ghm-appointments/${second.id}/calling`)).ok()).toBeTruthy();
    } finally {
      await api.dispose();
      await cleanup(first.patient);
      await cleanup(second.patient);
    }
  });

  test("a call is ended automatically 10 minutes after it started", async () => {
    const stale = await bookedPatient();
    const fresh = await bookedPatient();
    const me = userFor("reception_admin");
    await query(
      `UPDATE appointments SET calling_by = $2, calling_by_id = $3,
              calling_since = NOW() - INTERVAL '11 minutes'
        WHERE id = $1`,
      [stale.id, me.short_name, me.id],
    );
    const api = await apiAs("reception_admin");
    try {
      expect((await api.post(`/api/ghm-appointments/${fresh.id}/calling`)).ok()).toBeTruthy();

      const active = await api.post("/api/ghm-appointments/active-calls", {
        data: { appointment_ids: [stale.id, fresh.id] },
      });
      const shown = await active.json();
      expect(shown[stale.id]).toBeUndefined();
      expect(shown[fresh.id]).toMatchObject({ calling_by_id: me.id });

      const row = await one(`SELECT calling_since FROM appointments WHERE id = $1`, [stale.id]);
      expect(row.calling_since).toBeNull();
      const session = await one(
        `SELECT duration_secs, ended_reason FROM call_claim_sessions WHERE appointment_id = $1`,
        [stale.id],
      );
      expect(session).toEqual({ duration_secs: 600, ended_reason: "expired" });
    } finally {
      await api.dispose();
      await cleanup(stale.patient);
      await cleanup(fresh.patient);
    }
  });
});

test.describe("Patient history records the logged-in user", () => {
  const history = async (api, id) =>
    (await api.get(`/api/appointment-changes?appointment_id=${id}`)).json();

  test("a logged call, its deletion and a deleted history entry are all kept", async () => {
    const patient = await buildPatient();
    const appt = await one(
      `INSERT INTO appointments
         (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, status)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 4, 'scheduled')
       RETURNING id`,
      [patient.id, patient.file_no, patient.name, patient.phone],
    );
    const me = userFor("reception_admin");
    const api = await apiAs("reception_admin");
    try {
      const logged = await api.post("/api/call-attempts", {
        data: { appointment_id: appt.id, outcome: "not_picked" },
      });
      expect(logged.status()).toBe(201);
      const attempt = await logged.json();
      expect(attempt.called_by).toBe(me.short_name);

      expect((await api.delete(`/api/call-attempts/${attempt.id}`)).ok()).toBeTruthy();

      expect(
        (
          await api.patch(`/api/ghm-appointments/${appt.id}`, {
            data: { notes: "Asked for evening" },
          })
        ).ok(),
      ).toBeTruthy();
      const noteChange = (await history(api, appt.id)).find((h) => h.field === "notes");
      expect((await api.delete(`/api/appointment-changes/${noteChange.id}`)).ok()).toBeTruthy();

      const hist = await history(api, appt.id);
      const byField = (f) => hist.find((h) => h.field === f);
      for (const f of ["call_logged", "call_log_deleted", "history_deleted"]) {
        expect(byField(f)).toMatchObject({
          kind: "audit",
          changed_by: me.short_name,
          changed_by_id: me.id,
        });
      }
      expect(
        (await api.delete(`/api/appointment-changes/${byField("call_logged").id}`)).status(),
      ).toBe(409);
    } finally {
      await api.dispose();
      await cleanup(patient);
    }
  });

  test("booking, editing and deleting on the Appointments page are recorded", async () => {
    const patient = await buildPatient();
    const me = userFor("reception_admin");
    const api = await apiAs("reception_admin");
    try {
      const day = await istDay(6);
      const created = await api.post("/api/appointments", {
        data: {
          patient_id: patient.id,
          patient_name: patient.name,
          file_no: patient.file_no,
          phone: patient.phone,
          doctor_name: "Dr E2E Banshali",
          appointment_date: day,
          time_slot: "11:00",
        },
      });
      expect(created.ok()).toBeTruthy();
      const appt = await created.json();

      const moved = await api.put(`/api/appointments/${appt.id}`, {
        data: { time_slot: "12:00" },
      });
      expect(moved.ok()).toBeTruthy();

      const hist = await history(api, appt.id);
      expect(hist.find((h) => h.kind === "booking")).toMatchObject({
        changed_by: me.short_name,
        changed_by_id: me.id,
      });
      expect(hist.find((h) => h.field === "time_slot")).toMatchObject({
        old_value: "11:00",
        new_value: "12:00",
        changed_by: me.short_name,
      });

      const keep = await one(
        `INSERT INTO appointments (patient_id, file_no, patient_name, appointment_date, status)
         VALUES ($1, $2, $3, (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 9, 'scheduled') RETURNING id`,
        [patient.id, patient.file_no, patient.name],
      );
      expect((await api.delete(`/api/appointments/${appt.id}`)).ok()).toBeTruthy();
      const after = await history(api, keep.id);
      expect(after.find((h) => h.field === "appointment_deleted")).toMatchObject({
        kind: "audit",
        changed_by: me.short_name,
        changed_by_id: me.id,
      });
    } finally {
      await api.dispose();
      await query(
        `DELETE FROM audit_log WHERE action = 'delete_appointment' AND details->>'file_no' = $1`,
        [patient.file_no],
      );
      await cleanup(patient);
    }
  });
});
