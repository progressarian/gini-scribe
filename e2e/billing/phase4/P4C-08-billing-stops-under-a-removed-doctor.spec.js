import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import {
  desk,
  discountCode,
  extraVisit,
  newTag,
  payRule,
  refused,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const items = await import("../../../server/services/billing/serviceItems.js");
const rates = await import("../../../server/services/billing/categoryRates.js");
const fees = await import("../../../server/services/billing/consultantFees.js");
const discounts = await import("../../../server/services/billing/discountRules.js");
const reports = await import("../../../server/services/billing/reports.js");
const removal = await import("../../../server/services/doctorRemoval.js");
const { priceBill } = await import("../../../server/services/billing/priceBill.js");
const { previewUpload } = await import("../../../server/services/billing/importPreview.js");
const { templateBuffer } = await import("../../../server/services/billing/importTemplate.js");
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.8.1", role: "admin" };
const master = { actorId: USERS.reception_admin.id, ip: "10.9.8.2", role: "reception_admin" };
const GONE = `Dr P4C08 Gone ${tag}`;
const STAYS = `Dr P4C08 Stays ${tag}`;
const ours = {};
let ids;

const removedMessage = (what) => new RegExp(`^${GONE} was removed, so ${what}`);

async function doctor(name) {
  const { pin } = await one(`SELECT pin FROM doctors WHERE id = $1`, [USERS.reception.id]);
  return (
    await one(
      `INSERT INTO doctors (name, short_name, role, pin, is_active)
       VALUES ($1, $1, 'consultant', $2, TRUE) RETURNING id`,
      [name, pin],
    )
  ).id;
}

async function consultation(code, name, price, visitType, doctorId) {
  return (
    await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, visit_type, doctor_id)
       VALUES ($1, $2, $3, $4, 'consultation', $5, $6) RETURNING id`,
      [`${code}-${tag}`, `${name} ${tag}`, ids.subgroup, price, visitType, doctorId],
    )
  ).id;
}

async function dropDoctors() {
  const doctors = [ours.gone, ours.stays].filter(Boolean);
  if (!doctors.length) return;
  await query(`DELETE FROM auth_sessions WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM refresh_tokens WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM audit_log WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM audit_log WHERE entity_type = 'doctor' AND entity_id = ANY($1)`, [
    doctors,
  ]);
  await query(`DELETE FROM appointments WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM doctors WHERE id = ANY($1)`, [doctors]);
}

const draftOf = (visit) => bills.openDraft(visit, desk, db);

async function finalise(bill) {
  const set = await bills.setCategory(bill.id, { category: ids.pensioner }, desk, db);
  return bills.finaliseBill(set.id, { version: set.version }, desk, db);
}

const linesOf = async (billId) => (await bills.readBill(billId, db)).lines;

async function workbook(sheets) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await templateBuffer({ examples: false }));
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.getWorksheet(name);
    const headers = ws.getRow(1).values.slice(1);
    for (const cells of rows) ws.addRow(headers.map((h) => cells[h] ?? null));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const errorsOf = (preview, name) =>
  preview.sheets
    .find((s) => s.name === name)
    .rows.filter((r) => r.status === "error")
    .flatMap((r) => r.errors.map((e) => `${e.column}: ${e.message}`));

test.describe.serial("P4C-08 billing stops under a removed doctor", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner pays nothing", patient_pays: "nothing" });
    ours.gone = await doctor(GONE);
    ours.stays = await doctor(STAYS);
    ours.goneNew = await consultation("P4-C8GN", "P4 Consult Gone New", 1200, "New", ours.gone);
    ours.goneFu = await consultation("P4-C8GF", "P4 Consult Gone FU", 900, "Follow Up", ours.gone);
    ours.staysNew = await consultation("P4-C8SN", "P4 Consult Stays New", 1100, "New", ours.stays);
    ours.visitA = await extraVisit(ids, "C8A", { doctorId: ours.gone });
    ours.visitF = await extraVisit(ids, "C8F", { doctorId: ours.gone });
    ours.visitS = await extraVisit(ids, "C8S", { doctorId: ours.stays });
    await query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [
      ours.visitF.appointment,
    ]);
    const tomorrow = await one(`SELECT ($1::date + 1)::text AS d`, [ids.day]);
    await query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type,
                                 doctor_id, doctor_name)
       VALUES ($1, $2, $3, $4::date, 'Follow Up', $5, $6)`,
      [ours.visitS.patient, `P4 C8S ${tag}`, `F4C8S-${tag}`, tomorrow.d, ours.gone, GONE],
    );
    await query(
      `INSERT INTO auth_sessions (doctor_id, token, expires_at)
       VALUES ($1, $2, NOW() + interval '1 day')`,
      [ours.gone, `p4c08-${tag}`],
    );
    await query(
      `INSERT INTO refresh_tokens (kind, doctor_id, token_hash, family_id, expires_at)
       VALUES ('doctor', $1, $2, $2, NOW() + interval '1 day')`,
      [ours.gone, `p4c08-${tag}`],
    );
  });

  test.afterAll(async () => {
    try {
      await tearDown(ids);
    } finally {
      await dropDoctors();
    }
  });

  test("1. before the delete: a draft charges the doctor's fee and a bill is made final", async () => {
    const drafted = await visitLines.draftAtCheckIn(ours.visitA.visit, desk, db);
    expect(drafted.added).toEqual([`P4 Consult Gone New ${tag}`]);
    const final = await visitLines.draftAtCheckIn(ours.visitF.visit, desk, db);
    const made = await finalise(await bills.readBill(final.bill_id, db));
    expect(made.status).toBe("final");
    ours.finalBill = made;
  });

  test("2. the preview counts future appointments and open drafts", async () => {
    const preview = await removal.removalPreview(ours.gone, db);
    expect(preview.doctor).toMatchObject({ id: ours.gone, name: GONE, is_active: true });
    expect(preview.future_appointments).toBe(2);
    expect(preview.open_drafts).toBe(1);
  });

  test("3. deleting needs a reason, is refused on yourself, and 404s an unknown doctor", async () => {
    await refused(removal.removeDoctor(ours.gone, {}, admin, db), 400, /reason/, "no reason");
    await refused(
      removal.removeDoctor(ours.gone, { reason: "   " }, admin, db),
      400,
      /reason/,
      "blank reason",
    );
    await refused(
      removal.removeDoctor(ours.stays, { reason: "Me" }, { ...admin, actorId: ours.stays }, db),
      409,
      /can't delete your own account/,
      "self",
    );
    await refused(
      removal.removeDoctor(999999999, { reason: "Nobody" }, admin, db),
      404,
      /doesn't exist/,
      "unknown",
    );
    const stays = await one(`SELECT is_active FROM doctors WHERE id = $1`, [ours.stays]);
    expect(stays.is_active).toBe(true);
  });

  test("4. delete: soft, who/when/why, items off, signed out, counts returned", async () => {
    const result = await removal.removeDoctor(
      ours.gone,
      { reason: " Left the hospital " },
      admin,
      db,
    );
    expect(result.already_removed).toBe(false);
    expect(result.future_appointments).toBe(2);
    expect(result.open_drafts).toBe(1);
    expect(result.items_deactivated.sort()).toEqual([ours.goneNew, ours.goneFu].sort());
    expect(result.sessions_revoked).toBe(1);
    expect(result.refresh_tokens_revoked).toBe(1);
    const row = await one(
      `SELECT is_active, removed_by, removed_reason, removed_at IS NOT NULL AS stamped
         FROM doctors WHERE id = $1`,
      [ours.gone],
    );
    expect(row).toEqual({
      is_active: false,
      removed_by: USERS.admin.id,
      removed_reason: "Left the hospital",
      stamped: true,
    });
    const { rows: off } = await query(
      `SELECT id FROM service_items WHERE doctor_id = $1 AND is_active`,
      [ours.gone],
    );
    expect(off).toEqual([]);
    expect(
      (await one(`SELECT count(*)::int AS n FROM auth_sessions WHERE doctor_id = $1`, [ours.gone]))
        .n,
    ).toBe(0);
    expect(
      (
        await one(
          `SELECT count(*)::int AS n FROM refresh_tokens WHERE doctor_id = $1 AND revoked_at IS NULL`,
          [ours.gone],
        )
      ).n,
    ).toBe(0);
    const audit = await one(
      `SELECT doctor_id, details->>'reason' AS reason FROM audit_log
        WHERE action = 'remove_doctor' AND entity_id = $1`,
      [ours.gone],
    );
    expect(audit).toEqual({ doctor_id: USERS.admin.id, reason: "Left the hospital" });
  });

  test("5. deleting again changes nothing", async () => {
    const again = await removal.removeDoctor(ours.gone, { reason: "Twice" }, admin, db);
    expect(again.already_removed).toBe(true);
    expect(again.doctor.removed_reason).toBe("Left the hospital");
    const audits = await one(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'remove_doctor' AND entity_id = $1`,
      [ours.gone],
    );
    expect(audits.n).toBe(1);
  });

  test("6. no line can be added for the removed doctor's consultation", async () => {
    const other = await draftOf(ours.visitS.visit);
    await refused(
      bills.addLine(other.id, { item_id: ours.goneNew }, desk, db),
      409,
      removedMessage(`P4 Consult Gone New ${tag} can't be billed`),
      "the doctor's own item",
    );
    await query(`UPDATE service_items SET is_active = TRUE WHERE id = $1`, [ours.goneFu]);
    try {
      await refused(
        bills.addLine(other.id, { item_id: ours.goneFu }, desk, db),
        409,
        removedMessage(`P4 Consult Gone FU ${tag} can't be billed`),
        "the doctor's item left active",
      );
      await refused(
        priceBill({ lines: [{ item: ours.goneFu }], date: ids.day }, db),
        409,
        new RegExp(`${GONE} was removed, so P4 Consult Gone FU ${tag} can't be billed`),
        "a price preview",
      );
    } finally {
      await query(`UPDATE service_items SET is_active = FALSE WHERE id = $1`, [ours.goneFu]);
    }
    await refused(
      bills.addLine(other.id, { item_id: ids.consultNew, doctor_id: ours.gone }, desk, db),
      409,
      removedMessage(`Consultation New ${tag} can't be billed`),
      "the hospital default named for the doctor",
    );
    const own = await draftOf(ours.visitA.visit);
    await refused(
      bills.addLine(own.id, { item_id: ids.consultNew }, desk, db),
      409,
      removedMessage(`Consultation New ${tag} can't be billed`),
      "the hospital default on the doctor's visit",
    );
  });

  test("7. an open draft still works, but can't be made final with the doctor's line", async () => {
    const withTest = await bills.addLine(
      (await draftOf(ours.visitA.visit)).id,
      { item_id: ids.hba1c },
      desk,
      db,
    );
    const consult = withTest.lines.find((l) => l.service_item_id === ours.goneNew);
    expect(consult.removed_doctor).toEqual({ id: ours.gone, name: GONE });
    expect(withTest.lines.find((l) => l.service_item_id === ids.hba1c).removed_doctor).toBeNull();
    const error = await refused(
      finalise(withTest),
      409,
      removedMessage(`P4 Consult Gone New ${tag} can't be billed; remove it from this bill first`),
      "finalise",
    );
    expect(error.code).toBe("doctor_removed");
    const removed = await bills.removeLine(
      withTest.id,
      consult.id,
      { reason: "Doctor left" },
      desk,
      db,
    );
    const made = await bills.finaliseBill(removed.id, { version: removed.version }, desk, db);
    expect(made.status).toBe("final");
    expect(made.lines.map((l) => l.service_item_id)).toEqual([ids.hba1c]);
  });

  test("8. check-in drafts no fee and never falls back to the hospital default", async () => {
    const visit = await extraVisit(ids, "C8N", { doctorId: ours.gone });
    const drafted = await visitLines.draftAtCheckIn(visit.visit, desk, db);
    expect(drafted.ok).toBe(true);
    expect(drafted.added).toEqual([]);
    expect(drafted.consultation).toBeNull();
    expect(drafted.removed_doctor).toEqual({ id: ours.gone, name: GONE });
    const atDesk = await visitLines.consultationForDesk(visit.visit, desk, db);
    expect(atDesk.added).toEqual([]);
    expect(atDesk.removed_doctor).toEqual({ id: ours.gone, name: GONE });
    const opened = await draftOf(visit.visit);
    expect(opened.lines).toEqual([]);
    expect(opened.removed_doctor).toEqual({ id: ours.gone, name: GONE });
    const other = await draftOf(ours.visitS.visit);
    expect(other.removed_doctor).toBeNull();
    const assigned = await extraVisit(ids, "C8V", { doctorId: ours.gone });
    await query(`UPDATE appointments SET doctor_id = NULL WHERE id = $1`, [assigned.appointment]);
    const byAssignment = await visitLines.draftAtCheckIn(assigned.visit, desk, db);
    expect(byAssignment.added).toEqual([]);
    expect(byAssignment.removed_doctor).toEqual({ id: ours.gone, name: GONE });
  });

  test("9. no item, fee, rate or discount can be aimed at the removed doctor", async () => {
    await refused(
      items.createItem(
        {
          code: `P4-C8X-${tag}`,
          name: `P4 Consult Gone Extra ${tag}`,
          subgroup_id: ids.subgroup,
          base_price: 500,
          kind: "consultation",
          visit_type: "New",
          doctor_id: ours.gone,
        },
        master,
        db,
      ),
      409,
      removedMessage("no consultation item can be made or brought back for them"),
      "create item",
    );
    await refused(
      items.setItemActive(ours.goneNew, true, master, db),
      409,
      removedMessage("no consultation item can be made or brought back for them"),
      "reactivate item",
    );
    await refused(
      rates.saveRate(
        { scheme_code: ids.pensioner, service_item_id: ours.goneNew, rate: 700 },
        master,
        db,
      ),
      409,
      removedMessage(`P4 Consult Gone New ${tag} can't be priced`),
      "category rate",
    );
    await refused(
      fees.saveConsultantFee(
        { scheme_code: ids.pensioner, service_item_id: ours.goneNew, fee: 700 },
        master,
        db,
      ),
      409,
      removedMessage(`P4 Consult Gone New ${tag} can't be given a fee`),
      "consultant fee",
    );
    const error = await refused(
      discounts.createDiscountRule(
        {
          name: `P4 C8 coupon ${tag}`,
          code: `P4C8X${tag}`,
          method: "code",
          kind: "percent",
          value: 10,
          doctor_ids: [ours.gone, ours.stays],
        },
        master,
        db,
      ),
      409,
      removedMessage("a discount can't be aimed at them"),
      "discount",
    );
    expect(error.code).toBe("doctor_removed");
  });

  test("10. the import refuses every sheet aimed at the removed doctor", async () => {
    const buffer = await workbook({
      Items: [
        {
          item_code: `P4-C8I-${tag}`,
          name: `P4 Consult Gone Import ${tag}`,
          subgroup_code: `P4S-${tag}`,
          base_price: 800,
          kind: "consultation",
          doctor: GONE,
          visit_type: "New",
        },
      ],
      "Category rates": [
        {
          category_code: ids.pensioner,
          item_code: `P4-C8GN-${tag}`,
          rate: 650,
          valid_from: ids.day,
        },
      ],
      "Consultant fees": [
        {
          doctor: GONE,
          category_code: ids.pensioner,
          fee: 700,
          patient_pays: "full",
          remainder: "claim",
        },
      ],
      Discounts: [
        {
          rule_name: `P4 C8 import ${tag}`,
          code: `P4C8I${tag}`,
          method: "code",
          kind: "percent",
          value: 10,
          doctors: GONE,
        },
      ],
    });
    const preview = await previewUpload(buffer, db);
    expect(errorsOf(preview, "Items")).toEqual([
      `doctor: ${GONE} was removed, so nothing can be priced under them`,
    ]);
    expect(errorsOf(preview, "Category rates")).toEqual([
      `item_code: ${GONE} was removed, so P4 Consult Gone New ${tag} can't be priced`,
    ]);
    expect(errorsOf(preview, "Consultant fees")).toEqual([
      `doctor: ${GONE} was removed, so nothing can be priced under them`,
    ]);
    expect(errorsOf(preview, "Discounts")).toEqual([
      `doctors: ${GONE} was removed, so a discount can't be aimed at them`,
    ]);
  });

  test("11. a doctor-only discount never applies to the removed doctor's lines", async () => {
    const code = `P4C8D${tag}`;
    await discountCode(ids, code, { value: 30, doctor_ids: [ours.gone, ours.stays] });
    const billCode = `P4C8B${tag}`;
    await discountCode(ids, billCode, { doctor_ids: [ours.gone], applies_per: "bill" });
    await discountCode(ids, `P4C8A${tag}`, {
      code: null,
      method: "auto",
      value: 20,
      doctor_ids: [ours.gone, ours.stays],
    });
    const staysBill = await bills.addLine(
      (await draftOf(ours.visitS.visit)).id,
      { item_id: ids.hba1c },
      desk,
      db,
    );
    const staysLine = staysBill.lines.find((l) => l.service_item_id === ids.hba1c);
    expect(staysLine.doctor_id).toBe(ours.stays);
    expect(staysLine.discount).toBe(5000);
    const withCode = await bills.addCode(staysBill.id, { code }, desk, db);
    expect(withCode.lines.find((l) => l.service_item_id === ids.hba1c).discount).toBe(7500);

    const visit = await extraVisit(ids, "C8D", { doctorId: ours.gone });
    const goneBill = await bills.addLine(
      (await draftOf(visit.visit)).id,
      { item_id: ids.hba1c },
      desk,
      db,
    );
    const goneLine = goneBill.lines.find((l) => l.service_item_id === ids.hba1c);
    expect(goneLine.doctor_id).toBe(ours.gone);
    expect(goneLine.discount).toBe(0);
    await refused(
      bills.addCode(goneBill.id, { code }, desk, db),
      409,
      new RegExp(`The code ${code} doesn't apply: ${GONE} was removed`),
      "line code",
    );
    await refused(
      bills.addCode(goneBill.id, { code: billCode }, desk, db),
      409,
      new RegExp(`The code ${billCode} isn't for any doctor on this bill`),
      "bill code",
    );
  });

  test("12. final bills and reports keep the removed doctor's name", async () => {
    const final = await bills.readBill(ours.finalBill.id, db);
    expect(final.status).toBe("final");
    expect(final.bill_no).toBe(ours.finalBill.bill_no);
    expect(final.totals).toEqual(ours.finalBill.totals);
    expect(final.lines.map((l) => l.bill_name)).toEqual(
      ours.finalBill.lines.map((l) => l.bill_name),
    );
    const report = await reports.runReport(
      "revenue_consultants",
      { from: ids.day, to: ids.day, consultant: ours.gone },
      db,
    );
    expect(JSON.stringify(report)).toContain(GONE);
  });

  test("13. the removed doctor disappears from every billing picker", async () => {
    const choices = await items.itemChoices(db);
    expect(choices.consultants.map((d) => d.id)).not.toContain(ours.gone);
    expect(choices.consultants.map((d) => d.id)).toContain(ours.stays);
    const grid = await fees.consultantFeeGrid({}, db);
    expect(grid.rows.map((r) => r.doctor_id)).not.toContain(ours.gone);
    expect(grid.rows.map((r) => r.doctor_id)).toContain(ours.stays);
    const notPriced = await items.notPricedList(db);
    expect(notPriced.consultants.map((d) => d.doctor_id)).not.toContain(ours.gone);
    expect(notPriced.consultants.map((d) => d.doctor_id)).toContain(ours.stays);
    const catalog = await reports.reportCatalog(db);
    expect(catalog.options.consultants.map((d) => d.id)).not.toContain(ours.gone);
    expect(catalog.options.consultants.map((d) => d.id)).toContain(ours.stays);
    const removed = await removal.listRemovedDoctors(db);
    expect(removed.find((d) => d.id === ours.gone)).toMatchObject({
      name: GONE,
      removed_reason: "Left the hospital",
      removed_by_name: USERS.admin.name,
    });
  });

  test("14. restore brings the doctor back but not their consultation items", async () => {
    const restored = await removal.restoreDoctor(ours.gone, admin, db);
    expect(restored.already_active).toBe(false);
    expect(restored.doctor).toMatchObject({
      is_active: true,
      removed_at: null,
      removed_reason: null,
    });
    const again = await removal.restoreDoctor(ours.gone, admin, db);
    expect(again.already_active).toBe(true);
    const { rows: active } = await query(
      `SELECT id FROM service_items WHERE doctor_id = $1 AND is_active`,
      [ours.gone],
    );
    expect(active).toEqual([]);
    const audit = await one(
      `SELECT details->>'removed_reason' AS reason FROM audit_log
        WHERE action = 'restore_doctor' AND entity_id = $1`,
      [ours.gone],
    );
    expect(audit.reason).toBe("Left the hospital");
    const other = await draftOf(ours.visitS.visit);
    await refused(
      bills.addLine(other.id, { item_id: ours.goneFu }, desk, db),
      409,
      /is deactivated/,
      "items stay off after restore",
    );
    await items.setItemActive(ours.goneFu, true, master, db);
    const added = await bills.addLine(other.id, { item_id: ours.goneFu }, desk, db);
    expect(added.lines.some((l) => l.service_item_id === ours.goneFu)).toBe(true);
    const choices = await items.itemChoices(db);
    expect(choices.consultants.map((d) => d.id)).toContain(ours.gone);
  });
});
