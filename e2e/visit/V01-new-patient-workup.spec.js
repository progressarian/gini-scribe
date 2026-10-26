import { test, expect } from "@playwright/test";
import { query, one } from "../helpers/db.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { buildPatient } from "../helpers/builders.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const rx = await import("../../server/services/prescriptionAutoSave.js");
const { buildPrescriptionHtml } = await import("../../server/templates/prescriptionTemplate.js");

const flagged = CONSULTANTS.banshali;
const unflagged = CONSULTANTS.rahul;
const patients = [];

const istDay = (offset = 0) =>
  new Date(Date.now() + 330 * 60 * 1000 + offset * 86400000).toISOString().slice(0, 10);

const booking = async ({ doctor = flagged, visitType = "New Patient", day = istDay() } = {}) => {
  const patient = await buildPatient();
  patients.push(patient.id);
  const appt = await one(
    `INSERT INTO appointments (patient_id, patient_name, appointment_date, doctor_name, visit_type, status)
     VALUES ($1, $2, $3::date, $4, $5, 'checkedin') RETURNING id`,
    [patient.id, patient.name, day, doctor.name, visitType],
  );
  return { patient: patient.id, appointment: appt.id };
};

const workup = {
  history: {
    complaints: "Fatigue for 3 months",
    smoking: "  ",
    covid: { answer: "yes", note: "2021, home isolation" },
  },
  allergy: { status: "known", note: "Sulfa — rash" },
  exam: {
    head_neck: { xanthelasma: { state: "present", note: "B/L" }, acanthosis: { value: "2" } },
    lower_limbs: { reflexes: { state: "normal" } },
  },
};

test.describe.serial("V01 new-patient History & Examination — API", () => {
  let api;

  test.beforeAll(async () => {
    await query(`UPDATE doctors SET new_patient_workup = (id = $1) WHERE id = ANY($2)`, [
      flagged.id,
      [flagged.id, unflagged.id],
    ]);
    api = await apiAs("banshali");
  });

  test.afterAll(async () => {
    await query(`DELETE FROM new_patient_workups WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM patients WHERE id = ANY($1)`, [patients]);
    await query(
      `UPDATE doctors SET new_patient_workup = false, qualification = NULL, license_no = NULL WHERE id = $1`,
      [flagged.id],
    );
    await api?.dispose();
  });

  test("1. a flagged doctor's new patient can be saved and read back, blanks dropped", async () => {
    const v = await booking();
    const empty = await api.get(`/api/visit/${v.patient}/workup?appointment_id=${v.appointment}`);
    expect(await empty.json()).toMatchObject({ applies: true, editable: true, workup: null });

    const saved = await api.put(`/api/visit/${v.patient}/workup`, {
      data: { appointment_id: v.appointment, ...workup },
    });
    expect(saved.status()).toBe(200);
    const { workup: row } = await saved.json();
    expect(row.history).toEqual({
      complaints: "Fatigue for 3 months",
      covid: { answer: "yes", note: "2021, home isolation" },
    });
    expect((await saved.json()).allergy).toEqual({
      allergy_status: "known",
      allergy_note: "Sulfa — rash",
    });
    const patientRow = await one(
      `SELECT allergy_status, allergy_note, allergy_asked_by FROM patients WHERE id = $1`,
      [v.patient],
    );
    expect(patientRow).toEqual({
      allergy_status: "known",
      allergy_note: "Sulfa — rash",
      allergy_asked_by: flagged.id,
    });
    expect(row.exam.head_neck.acanthosis).toEqual({ value: "2" });
    expect(row.prepared_by).toBe(flagged.name);

    const read = await (
      await api.get(`/api/visit/${v.patient}/workup?appointment_id=${v.appointment}`)
    ).json();
    expect(read.workup.version).toBe(row.version);
  });

  test("2. a second save without the latest version is refused as stale", async () => {
    const v = await booking();
    const first = await (
      await api.put(`/api/visit/${v.patient}/workup`, {
        data: { appointment_id: v.appointment, ...workup },
      })
    ).json();
    const ok = await api.put(`/api/visit/${v.patient}/workup`, {
      data: {
        appointment_id: v.appointment,
        expected_updated_at: first.workup.version,
        history: { complaints: "Updated" },
      },
    });
    expect(ok.status()).toBe(200);

    const stale = await api.put(`/api/visit/${v.patient}/workup`, {
      data: {
        appointment_id: v.appointment,
        expected_updated_at: first.workup.version,
        history: { complaints: "Overwrite" },
      },
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).code).toBe("workup_stale");
  });

  test("3. follow-up, unflagged doctor and past visits are refused", async () => {
    const cases = [
      [await booking({ visitType: "Follow-Up" }), "first visit"],
      [await booking({ doctor: unflagged }), "doesn't use"],
      [await booking({ day: istDay(-1) }), "day of the visit"],
    ];
    for (const [v, reason] of cases) {
      const res = await api.put(`/api/visit/${v.patient}/workup`, {
        data: { appointment_id: v.appointment, history: { complaints: "x" } },
      });
      expect(res.status()).toBe(409);
      expect((await res.json()).error).toContain(reason);
    }
  });

  test("4. another patient's appointment is refused", async () => {
    const a = await booking();
    const b = await booking();
    const res = await api.put(`/api/visit/${a.patient}/workup`, {
      data: { appointment_id: b.appointment, history: { complaints: "x" } },
    });
    expect(res.status()).toBe(404);
  });

  test("5. unknown fields and values are rejected", async () => {
    const v = await booking();
    for (const bad of [
      { history: { favourite_colour: "blue" } },
      { exam: { head_neck: { pallor: { state: "maybe" } } } },
      { exam: { head_neck: { acanthosis: { value: "7" } } } },
      { allergy: { status: "not_asked" } },
      { history: { allergies: { status: "known" } } },
    ]) {
      const res = await api.put(`/api/visit/${v.patient}/workup`, {
        data: { appointment_id: v.appointment, ...bad },
      });
      expect(res.status()).toBe(400);
    }
  });

  test("6. a follow-up visit shows the first workup read-only", async () => {
    const v = await booking({ day: istDay() });
    await api.put(`/api/visit/${v.patient}/workup`, {
      data: { appointment_id: v.appointment, ...workup },
    });
    await query(`UPDATE appointments SET appointment_date = $2::date WHERE id = $1`, [
      v.appointment,
      istDay(-30),
    ]);
    const later = await one(
      `INSERT INTO appointments (patient_id, appointment_date, doctor_name, visit_type, status)
       VALUES ($1, $2::date, $3, 'Follow-Up', 'checkedin') RETURNING id`,
      [v.patient, istDay(), flagged.name],
    );
    const res = await (
      await api.get(`/api/visit/${v.patient}/workup?appointment_id=${later.id}`)
    ).json();
    expect(res).toMatchObject({ applies: false, editable: false, workup: null });
    expect(res.earlier.history.complaints).toBe("Fatigue for 3 months");
    expect(res.earlier.visit_date).toBe(istDay(-30));
  });

  test("7. a workup blocks deleting its appointment", async () => {
    const v = await booking();
    await api.put(`/api/visit/${v.patient}/workup`, {
      data: { appointment_id: v.appointment, ...workup },
    });
    await expect(query(`DELETE FROM appointments WHERE id = $1`, [v.appointment])).rejects.toThrow(
      /foreign key/,
    );
  });

  test("8. the printed doctor comes from the appointment, never the person printing", async () => {
    await query(
      `UPDATE doctors SET qualification = 'MD, DM (Endocrinology)', license_no = 'PMC-E2E-1' WHERE id = $1`,
      [flagged.id],
    );
    const v = await booking();
    const printedBy = { name: flagged.name, qualification: "MBBS (MO)", reg_no: "MO-REG" };
    const out = await rx.withAppointmentRxContext(v.patient, v.appointment, {
      doctor: printedBy,
      activeMeds: [],
    });
    expect(out.doctor).toEqual({
      name: flagged.name,
      qualification: "MD, DM (Endocrinology)",
      reg_no: "PMC-E2E-1",
      designation: flagged.specialty,
    });
    expect(out.activeMeds).toEqual([]);

    const other = await booking();
    const untouched = await rx.withAppointmentRxContext(v.patient, other.appointment, {
      doctor: printedBy,
    });
    expect(untouched.doctor).toEqual(printedBy);
    expect(
      (await rx.withAppointmentRxContext(v.patient, null, { doctor: printedBy })).doctor.name,
    ).toBe(flagged.name);
  });

  test("9. the printed Rx carries the workup in place of Clinical history, not the MO", async () => {
    const v = await booking();
    await api.put(`/api/visit/${v.patient}/workup`, {
      data: { appointment_id: v.appointment, ...workup },
    });
    const data = await rx.withAppointmentRxContext(v.patient, v.appointment, {
      patient: { name: "Test", sex: "Male", age: 40 },
      doctor: { name: "Dr MO Writer", qualification: "MBBS (MO)" },
      history: "Diabetes since 2019",
      activeDx: [],
      activeMeds: [],
    });
    const html = buildPrescriptionHtml(data);
    expect(html).toContain(">History</div>");
    expect(html).not.toContain("Clinical history");
    expect(html).toContain("<b>C/O:</b> Fatigue for 3 months");
    expect(html).toContain("<b>COVID:</b> Yes — 2021, home isolation");
    expect(html).toContain("<b>Allergies:</b> Known — Sulfa — rash");
    expect(html).toContain("<b>Head &amp; Neck:</b> Xanthelasma (B/L), Acanthosis gr 2");
    expect(html).toContain("<b>Rest of the examination:</b> NAD");
    expect(html).not.toContain("Reflexes");
    expect(html).not.toContain("Dr MO Writer");
    expect(html).not.toContain("MBBS (MO)");
    expect(html).toContain(flagged.name);
  });

  test("10. without a workup the Rx keeps its Clinical history, and a forged workup is ignored", async () => {
    const v = await booking({ visitType: "Follow-Up" });
    const data = await rx.withAppointmentRxContext(v.patient, v.appointment, {
      patient: { name: "Test" },
      history: "Diabetes since 2019",
      workup: { history: { complaints: "forged" }, exam: {} },
    });
    expect(data.workup).toBeNull();
    const html = buildPrescriptionHtml(data);
    expect(html).toContain("Clinical history");
    expect(html).not.toContain("forged");
  });

  test("11. an empty workup still prints that allergies were not asked", async () => {
    const v = await booking();
    await api.put(`/api/visit/${v.patient}/workup`, {
      data: { appointment_id: v.appointment, history: { complaints: "Thirst" } },
    });
    const html = buildPrescriptionHtml(
      await rx.withAppointmentRxContext(v.patient, v.appointment, { patient: { name: "T" } }),
    );
    expect(html).toContain("<b>Allergies:</b> Not asked");
    expect(html).not.toContain(">Examination</div>");
  });

  test("12. a booking under the consultant's short name still gets the form", async () => {
    const v = await booking({ doctor: { name: flagged.short_name } });
    const res = await (
      await api.get(`/api/visit/${v.patient}/workup?appointment_id=${v.appointment}`)
    ).json();
    expect(res).toMatchObject({ applies: true, editable: true });
  });

  test("13. with no appointment sent, the Rx uses today's appointment, not the person printing", async () => {
    const v = await booking();
    await api.put(`/api/visit/${v.patient}/workup`, {
      data: { appointment_id: v.appointment, ...workup },
    });
    const out = await rx.withAppointmentRxContext(v.patient, null, {
      doctor: { name: "Dr MO Writer", qualification: "MBBS (MO)" },
    });
    expect(out.doctor.name).toBe(flagged.name);
    expect(out.workup.history.complaints).toBe("Fatigue for 3 months");
    const page = await (await api.get(`/api/visit/${v.patient}`)).json();
    expect(page.appt_doctor_name).toBe(flagged.name);
  });
});
