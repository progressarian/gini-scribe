import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { LAB_ONLY_DOCTOR } from "../../../shared/labOnly.js";
import {
  autoConsultation,
  desk,
  extraVisit,
  HEALTHRAY_CONSULTATION,
  healthrayBill,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const { consultantOptions } = await import("../../../server/services/billing/billConsultant.js");
const { consultationForDesk } = await import("../../../server/services/billing/visitLines.js");
const billPdf = await import("../../../server/services/billing/billPdf.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const { reassignConsultant } = await import("../../../server/services/giniflow/reassign.js");
const { healthrayLinesForDesk } =
  await import("../../../server/services/billing/healthrayBillLines.js");

const db = getPool();
const tag = newTag();
let ids;
let hospitalAdmin;
let madeHospitalAdmin = false;
let autoBefore;

async function samplesOnlyVisit(label) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE appointments SET doctor_id = NULL, doctor_name = $2 WHERE id = $1`, [
    made.appointment,
    LAB_ONLY_DOCTOR,
  ]);
  await query(`UPDATE giniflow_visits SET assigned_doctor_id = NULL WHERE id = $1`, [made.visit]);
  return made;
}

test.describe.serial("P4C-41 every bill has a consultant, Hospital Admin when tests only", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(true);
    const found = await query(`SELECT id FROM doctors WHERE lower(name) = lower($1)`, [
      LAB_ONLY_DOCTOR,
    ]);
    if (found.rows.length) hospitalAdmin = found.rows[0].id;
    else {
      hospitalAdmin = (
        await one(
          `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE)
           RETURNING id`,
          [LAB_ONLY_DOCTOR],
        )
      ).id;
      madeHospitalAdmin = true;
    }
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
    if (madeHospitalAdmin) await query(`DELETE FROM doctors WHERE id = $1`, [hospitalAdmin]);
  });

  test("1. a doctor visit's bill is under that doctor", async () => {
    const { visit } = await extraVisit(ids, "ConsDoctor", { healthray: false });
    const bill = await bills.openDraft(visit, desk, db);
    expect(bill.consultant).toMatchObject({
      id: CONSULTANTS.banshali.id,
      chosen: false,
      tests_only: false,
    });
  });

  test("2. a samples-only patient's bill is under Hospital Admin", async () => {
    const { visit } = await samplesOnlyVisit("ConsLab");
    const bill = await bills.openDraft(visit, desk, db);
    expect(bill.consultant).toMatchObject({ id: hospitalAdmin, chosen: false, tests_only: true });
  });

  test("3. a consultant chosen for the bill wins over the visit's doctor", async () => {
    const { visit } = await extraVisit(ids, "ConsChosen", { healthray: false });
    const draft = await bills.openDraft(visit, desk, db);
    await query(`UPDATE bills SET consultant_id = $2 WHERE id = $1`, [
      draft.id,
      CONSULTANTS.beant.id,
    ]);
    const bill = await bills.readBill(draft.id, db);
    expect(bill.consultant).toMatchObject({ id: CONSULTANTS.beant.id, chosen: true });
  });

  test("4. the choices list today's doctor first, then the others, then Hospital Admin", async () => {
    const { visit } = await extraVisit(ids, "ConsOptions", { healthray: false });
    const draft = await bills.openDraft(visit, desk, db);
    const options = await consultantOptions(draft.id, db);
    expect(options.today.map((d) => d.id)).toEqual([CONSULTANTS.banshali.id]);
    expect(options.others.map((d) => d.id)).toContain(CONSULTANTS.beant.id);
    expect(options.others.map((d) => d.id)).not.toContain(CONSULTANTS.banshali.id);
    expect(options.others.map((d) => d.id)).not.toContain(hospitalAdmin);
    expect(options.hospital_admin).toMatchObject({ id: hospitalAdmin });
  });

  const consultations = (bill) =>
    bill.lines
      .filter((line) => line.is_live && line.item_kind === "consultation")
      .map((line) => ({ item: line.service_item_id, doctor: line.doctor_id }));

  async function doctorDraftWithConsultation(label) {
    const { visit } = await extraVisit(ids, label, { healthray: false });
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(
      draft.id,
      { item_id: ids.consultDoctorNew, source: "visit", doctor_id: CONSULTANTS.banshali.id },
      desk,
      db,
    );
    return { visit, draft };
  }

  test("5. choosing Hospital Admin takes the consultation off and it is not added back", async () => {
    const { visit, draft } = await doctorDraftWithConsultation("ConsToLab");
    const bill = await bills.setConsultant(draft.id, { consultant_id: hospitalAdmin }, desk, db);
    expect(consultations(bill)).toEqual([]);
    expect(bill.consultant).toMatchObject({ id: hospitalAdmin, chosen: true, tests_only: true });

    await consultationForDesk(visit, desk, db);
    expect(consultations(await bills.readBill(draft.id, db))).toEqual([]);
  });

  test("6. choosing a doctor on a samples-only bill adds that doctor's consultation", async () => {
    const { visit } = await samplesOnlyVisit("ConsLabToDoc");
    const draft = await bills.openDraft(visit, desk, db);
    const bill = await bills.setConsultant(
      draft.id,
      { consultant_id: CONSULTANTS.banshali.id },
      desk,
      db,
    );
    expect(consultations(bill)).toEqual([
      { item: ids.consultDoctorNew, doctor: CONSULTANTS.banshali.id },
    ]);
    expect(bill.consultant).toMatchObject({ id: CONSULTANTS.banshali.id, tests_only: false });
    const floor = await one(`SELECT assigned_doctor_id FROM giniflow_visits WHERE id = $1`, [
      visit,
    ]);
    expect(floor.assigned_doctor_id).toBeNull();
  });

  test("7. choosing another doctor swaps the consultation to theirs", async () => {
    const { draft } = await doctorDraftWithConsultation("ConsSwap");
    const bill = await bills.setConsultant(
      draft.id,
      { consultant_id: CONSULTANTS.beant.id },
      desk,
      db,
    );
    expect(consultations(bill)).toEqual([{ item: ids.consultNew, doctor: CONSULTANTS.beant.id }]);
    expect(bill.consultant).toMatchObject({ id: CONSULTANTS.beant.id, chosen: true });
    const audit = await one(
      `SELECT count(*)::int AS n FROM billing_audit
        WHERE entity_id = $1 AND after->>'consultant_id' = $2`,
      [draft.id, String(CONSULTANTS.beant.id)],
    );
    expect(audit.n).toBe(1);
  });

  test("8. reception sets the consultant through the desk API and sees the choices", async () => {
    const { visit } = await samplesOnlyVisit("ConsApi");
    const draft = await bills.openDraft(visit, desk, db);
    const api = await apiAs("reception");
    const choices = await api.get(`/api/billing/bills/${draft.id}/consultants`);
    expect(choices.status()).toBe(200);
    expect((await choices.json()).hospital_admin).toMatchObject({ id: hospitalAdmin });
    const saved = await api.patch(`/api/billing/bills/${draft.id}/consultant`, {
      data: { consultant_id: hospitalAdmin },
    });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).consultant).toMatchObject({ id: hospitalAdmin, chosen: true });
    const refused = await api.patch(`/api/billing/bills/${draft.id}/consultant`, {
      data: { consultant_id: 999999 },
    });
    expect(refused.status()).toBe(400);
    await api.dispose();
  });

  test("9. at the counter a samples-only bill shows Hospital Admin and a doctor can be chosen", async ({
    page,
  }) => {
    const made = await samplesOnlyVisit("ConsScreen");
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      made.visit,
    ]);
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, 'checked_in', 'reception', NOW())`,
      [made.visit],
    );
    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/billing", () =>
      page.getByRole("searchbox", { name: "Search today's patients" }),
    );
    await page
      .getByRole("searchbox", { name: "Search today's patients" })
      .fill(`ConsScreen ${tag}`);
    await page
      .getByRole("complementary", { name: "Today's patients" })
      .getByRole("button", { name: `P4 ConsScreen ${tag}` })
      .click();

    const consultant = page.getByRole("combobox", { name: /^Consultant/ });
    await expect(consultant).toHaveValue(String(hospitalAdmin));
    await expect(page.getByRole("button", { name: "Change consultant" })).toBeDisabled();

    await consultant.selectOption({ label: CONSULTANTS.banshali.name });
    await expect(page.getByText("This doctor's consultation fee will be added")).toBeVisible();
    await page.getByRole("button", { name: "Change consultant" }).click();

    await expect(page.getByRole("table", { name: "Bill lines" })).toContainText(
      `Consultation Dr New ${tag}`,
    );
    await expect(consultant).toHaveValue(String(CONSULTANTS.banshali.id));
  });

  test("10. the printed bill names Hospital Admin on a tests-only bill and the doctor otherwise", async () => {
    const lab = await samplesOnlyVisit("ConsPdfLab");
    const labBill = await bills.openDraft(lab.visit, desk, db);
    expect((await billPdf.billView(labBill.id, db)).consultant).toBe(LAB_ONLY_DOCTOR);

    const { visit } = await extraVisit(ids, "ConsPdfDoc", { healthray: false });
    const doctorBill = await bills.openDraft(visit, desk, db);
    const doctor = await one(`SELECT name FROM doctors WHERE id = $1`, [CONSULTANTS.banshali.id]);
    expect((await billPdf.billView(doctorBill.id, db)).consultant).toBe(doctor.name);
  });

  test("11. tests first under Hospital Admin, then a doctor the same day: one bill under the doctor", async () => {
    const made = await extraVisit(ids, "ConsBoth", { healthray: false });
    await query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type,
                                 doctor_name, status)
       SELECT patient_id, patient_name, file_no, appointment_date, 'Investigation', $2, 'checkedin'
         FROM appointments WHERE id = $1`,
      [made.appointment, LAB_ONLY_DOCTOR],
    );
    await healthrayBill(ids, made.patient, [
      { ...HEALTHRAY_CONSULTATION, invoice: "OPD-DOCTOR" },
      { desc: ids.hba1cName, amount: 250, category: "lab", invoice: "OPD-LAB" },
    ]);

    await consultationForDesk(made.visit, desk, db);
    await healthrayLinesForDesk(made.visit, desk, db);
    const bill = await bills.openDraft(made.visit, desk, db);

    const { n } = await one(
      `SELECT count(*)::int AS n FROM bills WHERE visit_id = $1 AND status <> 'cancelled'`,
      [made.visit],
    );
    expect(n).toBe(1);
    const items = bill.lines.filter((line) => line.is_live).map((line) => line.service_item_id);
    expect(items).toContain(ids.hba1c);
    expect(consultations(bill)).toEqual([
      { item: ids.consultDoctorNew, doctor: CONSULTANTS.banshali.id },
    ]);
    expect(bill.consultant).toMatchObject({ id: CONSULTANTS.banshali.id, tests_only: false });
  });

  test("12. a final bill keeps the consultant it was finalised under", async () => {
    await query(
      `UPDATE cash_shifts SET closed_at = NOW(), expected_cash = opening_cash,
              counted_cash = opening_cash, difference = 0
        WHERE closed_at IS NULL AND user_id = $1`,
      [USERS.reception.id],
    );
    await shifts.openShift({ opening_cash: 0 }, desk, db);
    const { visit } = await extraVisit(ids, "ConsFinal", { healthray: false });
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    await payments.takePayments(
      draft.id,
      { version: ready.version, payments: [{ mode: "cash", amount: ready.totals.payable / 100 }] },
      desk,
      db,
    );
    const paid = await bills.readBill(draft.id, db);
    await bills.finaliseBill(draft.id, { version: paid.version }, desk, db);
    await query(`UPDATE giniflow_visits SET assigned_doctor_id = $2 WHERE id = $1`, [
      visit,
      CONSULTANTS.beant.id,
    ]);
    const bill = await bills.readBill(draft.id, db);
    expect(bill.consultant).toMatchObject({ id: CONSULTANTS.banshali.id });
  });

  test("13. a floor reassign moves a consultant reception chose on the draft", async () => {
    const { visit, draft } = await doctorDraftWithConsultation("ConsReassign");
    await bills.setConsultant(draft.id, { consultant_id: CONSULTANTS.banshali.id }, desk, db);
    await reassignConsultant(visit, CONSULTANTS.beant.id, desk, db);
    const bill = await bills.readBill(draft.id, db);
    expect(bill.consultant).toMatchObject({ id: CONSULTANTS.beant.id, chosen: true });
    expect(consultations(bill).map((line) => line.doctor)).toEqual([CONSULTANTS.beant.id]);
  });
});
