import { test, expect } from "@playwright/test";
import { query, one } from "../helpers/db.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { buildPatient } from "../helpers/builders.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";

const flagged = CONSULTANTS.banshali;
const patients = [];

const istDay = (offset = 0) =>
  new Date(Date.now() + 330 * 60 * 1000 + offset * 86400000).toISOString().slice(0, 10);

const booking = async (visitType = "New Patient", day = istDay()) => {
  const patient = await buildPatient();
  patients.push(patient.id);
  const appt = await one(
    `INSERT INTO appointments (patient_id, patient_name, appointment_date, doctor_name, visit_type, status)
     VALUES ($1, $2, $3::date, $4, $5, 'checkedin') RETURNING id`,
    [patient.id, patient.name, day, flagged.name, visitType],
  );
  return { patient: patient.id, appointment: appt.id };
};

const heading = (page) => page.locator(".sct", { hasText: "New patient History & Examination" });
const region = (page, name) => page.getByRole("group", { name: new RegExp(`^${name}`) });
const savedRow = (appointmentId) =>
  one(`SELECT history, exam FROM new_patient_workups WHERE appointment_id = $1`, [appointmentId]);

test.describe.serial("V02 new-patient History & Examination — on /visit", () => {
  test.beforeAll(async () => {
    await query(`UPDATE doctors SET new_patient_workup = true WHERE id = $1`, [flagged.id]);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM new_patient_workups WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM patients WHERE id = ANY($1)`, [patients]);
    await query(`UPDATE doctors SET new_patient_workup = false WHERE id = $1`, [flagged.id]);
  });

  test("1. the form saves as it is filled and comes back after a reload", async ({ page }) => {
    const v = await booking();
    await loginAs(page, "banshali");
    const url = `/visit?patient=${v.patient}&appt=${v.appointment}`;
    await gotoReady(page, url, () => heading(page));

    await page.getByLabel("C/O (chief complaints)").fill("Thirst and weight loss");
    await page.getByRole("radiogroup", { name: "Allergies" }).getByLabel("Known allergy").check();
    await page.getByLabel("Known allergies").fill("Penicillin — rash");
    const headNeck = region(page, "Head & Neck");
    await headNeck.getByRole("radiogroup", { name: "Pallor" }).getByLabel("Present").check();
    await headNeck.getByLabel("Pallor note").fill("mild");
    await headNeck.getByLabel("Acanthosis").selectOption("2");
    await region(page, "Lower limbs").getByRole("button", { name: "Mark rest normal" }).click();
    await expect(page.getByText(/^Saved \d/)).toBeVisible();
    await expect(headNeck.getByText("2 abnormal · 0 normal")).toBeVisible();
    await expect(page.locator(".ptmeta .allergy")).toHaveText("Allergies: Penicillin — rash");

    await expect
      .poll(async () => (await savedRow(v.appointment))?.exam?.lower_limbs?.reflexes?.state)
      .toBe("normal");
    const row = await savedRow(v.appointment);
    expect(row.history).toMatchObject({ complaints: "Thirst and weight loss" });
    expect(
      await one(`SELECT allergy_status, allergy_note FROM patients WHERE id = $1`, [v.patient]),
    ).toEqual({ allergy_status: "known", allergy_note: "Penicillin — rash" });
    expect(row.exam.head_neck).toMatchObject({
      pallor: { state: "present", note: "mild" },
      acanthosis: { value: "2" },
    });

    await gotoReady(page, url, () => heading(page));
    await expect(page.getByLabel("C/O (chief complaints)")).toHaveValue("Thirst and weight loss");
    await expect(
      region(page, "Head & Neck").getByRole("radiogroup", { name: "Pallor" }).getByLabel("Present"),
    ).toBeChecked();
  });

  test("2. a follow-up visit has no form and shows the first workup read-only", async ({
    page,
  }) => {
    const v = await booking("New Patient", istDay(-20));
    await query(
      `INSERT INTO new_patient_workups (appointment_id, patient_id, history, exam, prepared_by_doctor_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        v.appointment,
        v.patient,
        { complaints: "Old complaint" },
        { head_neck: { xanthelasma: { state: "present" } } },
        flagged.id,
      ],
    );
    const later = await one(
      `INSERT INTO appointments (patient_id, appointment_date, doctor_name, visit_type, status)
       VALUES ($1, $2::date, $3, 'Follow-Up', 'checkedin') RETURNING id`,
      [v.patient, istDay(), flagged.name],
    );
    await loginAs(page, "banshali");
    await gotoReady(page, `/visit?patient=${v.patient}&appt=${later.id}`, () =>
      page.getByRole("button", { name: /History/ }).first(),
    );
    await expect(heading(page)).toHaveCount(0);
    await page.getByRole("button", { name: "📅 History" }).click();
    await expect(page.getByText("First-visit History & Examination")).toBeVisible();
    await expect(page.getByText("Old complaint")).toBeVisible();
    await page.getByRole("button", { name: "🩺 Exam" }).click();
    await expect(page.getByText("Xanthelasma").first()).toBeVisible();
  });
});
