import { test, expect } from "@playwright/test";
import { apiAs, userFor } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

const today = async () =>
  (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`)).d;

async function appointmentToday(patient) {
  return one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        status, visit_type)
     VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date, '12:30 PM to 1 PM', 'scheduled', 'Follow-Up')
     RETURNING id`,
    [patient.id, patient.file_no, patient.name, patient.phone],
  );
}

const cleanup = async (patients) => {
  const ids = patients.map((p) => p.id);
  await query(`DELETE FROM obt_call_assignments WHERE patient_id = ANY($1::int[])`, [ids]);
  await query(
    `DELETE FROM appointment_change_log WHERE appointment_id IN
       (SELECT id FROM appointments WHERE patient_id = ANY($1::int[]))`,
    [ids],
  );
  await query(`DELETE FROM call_attempts WHERE patient_id = ANY($1::int[])`, [ids]);
  await query(
    `DELETE FROM call_claim_sessions WHERE appointment_id IN
       (SELECT id FROM appointments WHERE patient_id = ANY($1::int[]))`,
    [ids],
  );
  await query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [ids]);
  await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
};

test.describe("GHM: OBT calls are divided and only the assignee calls", () => {
  const ONE = userFor("obt_one").id;
  const TWO = userFor("obt_two").id;
  let patients;
  let appts;
  let admin;
  let obtOne;
  let obtTwo;

  test.beforeEach(async () => {
    patients = [await buildPatient(), await buildPatient(), await buildPatient()];
    appts = [];
    for (const p of patients) appts.push((await appointmentToday(p)).id);
    admin = await apiAs("admin");
    obtOne = await apiAs("obt_one");
    obtTwo = await apiAs("obt_two");
  });

  test.afterEach(async () => {
    await cleanup(patients);
  });

  const ownerOf = async (patientId) =>
    (
      await one(`SELECT assigned_to_id FROM obt_call_assignments WHERE patient_id = $1`, [
        patientId,
      ])
    )?.assigned_to_id ?? null;

  test("1. the OBT team list holds the OBT members", async () => {
    const team = await (await obtOne.get("/api/obt-assignments/team")).json();
    const ids = team.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([ONE, TWO]));
    expect(ids).not.toContain(userFor("reception").id);
  });

  test("2. a team member without the lead permission cannot divide or assign", async () => {
    const divide = await obtOne.post("/api/obt-assignments/divide", {
      data: { patient_ids: patients.map((p) => p.id), member_ids: [ONE, TWO] },
    });
    expect(divide.status()).toBe(403);
    const assign = await obtOne.post("/api/obt-assignments/assign", {
      data: { patient_ids: [patients[0].id], assigned_to_id: ONE },
    });
    expect(assign.status()).toBe(403);
  });

  test("3. dividing shares only the unassigned patients and evens out the load", async () => {
    await admin.post("/api/obt-assignments/assign", {
      data: { patient_ids: [patients[0].id], assigned_to_id: ONE },
    });
    const res = await admin.post("/api/obt-assignments/divide", {
      data: { patient_ids: patients.map((p) => p.id), member_ids: [ONE, TWO] },
    });
    expect(res.ok()).toBe(true);
    expect((await res.json()).assigned).toBe(2);

    expect(await ownerOf(patients[0].id)).toBe(ONE);
    const owners = [await ownerOf(patients[1].id), await ownerOf(patients[2].id)];
    expect([...owners].sort()).toEqual([ONE, TWO].sort());

    const logged = await one(
      `SELECT new_value FROM appointment_change_log
        WHERE appointment_id = $1 AND field = 'call_assigned_to'`,
      [appts[1]],
    );
    expect(logged.new_value).toBe(userFor(owners[0] === ONE ? "obt_one" : "obt_two").short_name);
  });

  test("4. someone outside the OBT team cannot be given calls", async () => {
    const res = await admin.post("/api/obt-assignments/divide", {
      data: { patient_ids: [patients[0].id], member_ids: [userFor("reception").id] },
    });
    expect(res.status()).toBe(400);
  });

  test("5. only the assignee can call, change the call status or log a call", async () => {
    await admin.post("/api/obt-assignments/assign", {
      data: { patient_ids: [patients[0].id], assigned_to_id: ONE },
    });
    const id = appts[0];

    const claim = await obtTwo.post(`/api/ghm-appointments/${id}/calling`);
    expect(claim.status()).toBe(403);
    expect((await claim.json()).error).toMatch(/assigned to OBT One/);

    const status = await obtTwo.patch(`/api/ghm-appointments/${id}`, {
      data: { call_status: "called" },
    });
    expect(status.status()).toBe(403);

    const attempt = await obtTwo.post("/api/call-attempts", {
      data: { appointment_id: id, outcome: "called" },
    });
    expect(attempt.status()).toBe(403);

    expect((await obtOne.post(`/api/ghm-appointments/${id}/calling`)).ok()).toBe(true);
    expect(
      (
        await obtOne.post("/api/call-attempts", { data: { appointment_id: id, outcome: "called" } })
      ).status(),
    ).toBe(201);
  });

  test("6. the lead can change an assigned patient", async () => {
    await admin.post("/api/obt-assignments/assign", {
      data: { patient_ids: [patients[0].id], assigned_to_id: ONE },
    });
    expect(
      (
        await admin.patch(`/api/ghm-appointments/${appts[0]}`, { data: { call_status: "busy" } })
      ).ok(),
    ).toBe(true);
  });

  test("7. My patients and Unassigned filter the day list", async () => {
    await admin.post("/api/obt-assignments/assign", {
      data: { patient_ids: [patients[0].id], assigned_to_id: ONE },
    });
    await admin.post("/api/obt-assignments/assign", {
      data: { patient_ids: [patients[1].id], assigned_to_id: TWO },
    });
    const ours = new Set(patients.map((p) => p.id));
    const listed = async (api, calls) => {
      const res = await api.get(
        `/api/ghm-appointments?date=${await today()}&limit=100&calls=${calls}`,
      );
      expect(res.ok()).toBe(true);
      return (await res.json()).data.map((r) => r.patient_id).filter((id) => ours.has(id));
    };

    expect(await listed(obtOne, "mine")).toEqual([patients[0].id]);
    expect(await listed(obtTwo, "mine")).toEqual([patients[1].id]);
    expect(await listed(obtOne, "unassigned")).toEqual([patients[2].id]);
  });

  test("8. an OBT member cannot change an unassigned patient, a lead and reception can", async () => {
    const call = await obtTwo.post(`/api/ghm-appointments/${appts[0]}/calling`);
    expect(call.status()).toBe(403);
    expect((await call.json()).error).toMatch(/not assigned to you/);
    expect(
      (
        await obtTwo.patch(`/api/ghm-appointments/${appts[0]}`, {
          data: { preferred_time_slot: "10 AM to 11 AM" },
        })
      ).status(),
    ).toBe(403);

    const reception = await apiAs("reception");
    expect(
      (
        await reception.patch(`/api/ghm-appointments/${appts[0]}`, {
          data: { call_status: "busy" },
        })
      ).ok(),
    ).toBe(true);
  });

  test("9. an OBT member cannot edit any column of someone else's patient", async () => {
    await admin.post("/api/obt-assignments/assign", {
      data: { patient_ids: [patients[0].id], assigned_to_id: ONE },
    });
    for (const data of [
      { preferred_time_slot: "10 AM to 11 AM" },
      { home_collection: true },
      { patient_category: null },
      { booking_status: "not_connected" },
    ]) {
      const res = await obtTwo.patch(`/api/ghm-appointments/${appts[0]}`, { data });
      expect(res.status()).toBe(403);
    }
    expect(
      (
        await obtOne.patch(`/api/ghm-appointments/${appts[0]}`, {
          data: { booking_status: "not_connected" },
        })
      ).ok(),
    ).toBe(true);
  });

  test("10. an OBT member cannot book the next visit for someone else's patient", async () => {
    await admin.post("/api/obt-assignments/assign", {
      data: { patient_ids: [patients[0].id], assigned_to_id: ONE },
    });
    const res = await obtTwo.post("/api/ghm-appointments", {
      data: {
        patient_name: patients[0].name,
        file_no: patients[0].file_no,
        phone: patients[0].phone,
        doctor_name: "Dr E2E Banshali",
        appointment_date: await today(),
        time_slot: "12:30 PM to 1 PM",
        visit_type: "Follow Up",
      },
    });
    expect(res.status()).toBe(403);
  });
});
