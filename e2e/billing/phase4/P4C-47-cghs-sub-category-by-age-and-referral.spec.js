import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;
const createdSchemes = [];

const CGHS_FAMILY = [
  { code: "cghs", label: "CGHS", parent_code: null },
  { code: "cghs_pensioner", label: "CGHS Pensioner", parent_code: "cghs" },
  { code: "cghs_referral", label: "CGHS Referral", parent_code: "cghs" },
  { code: "cghs_paid", label: "CGHS Paid", parent_code: "cghs" },
];

async function cghsPatient(label, age, schemeCode = "cghs") {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE patients SET age = $2, dob = NULL, scheme_code = $3 WHERE id = $1`, [
    made.patient,
    age,
    schemeCode,
  ]);
  return made;
}

const profileOf = (patient) =>
  one(`SELECT scheme_code FROM patients WHERE id = $1`, [patient]).then((r) => r.scheme_code);

test.describe.serial("P4C-47 CGHS sub-category follows age and the referral number", () => {
  test.beforeAll(async () => {
    for (const scheme of CGHS_FAMILY) {
      const { rows } = await query(
        `INSERT INTO patient_schemes (code, label, parent_code, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (code) DO NOTHING RETURNING code`,
        [scheme.code, scheme.label, scheme.parent_code],
      );
      if (rows.length) createdSchemes.push(scheme.code);
    }
    await query(`UPDATE patient_schemes SET is_active = TRUE WHERE code = ANY($1::text[])`, [
      CGHS_FAMILY.map((s) => s.code),
    ]);
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
    await query(
      `DELETE FROM patient_schemes WHERE code = ANY($1::text[]) AND parent_code IS NOT NULL`,
      [createdSchemes],
    );
    await query(`DELETE FROM patient_schemes WHERE code = ANY($1::text[])`, [createdSchemes]);
  });

  test("1. a CGHS patient aged 70 or more starts as CGHS Pensioner", async () => {
    const { visit } = await cghsPatient("Seventy", 70);
    const draft = await bills.openDraft(visit, desk, db);
    expect(draft.category).toBe("cghs_pensioner");
  });

  test("2. under 70 starts as CGHS Paid; a referral number makes it CGHS Referral, for this bill only", async () => {
    const { patient, visit } = await cghsPatient("SixtyNine", 69);
    const draft = await bills.openDraft(visit, desk, db);
    expect(draft.category).toBe("cghs_paid");
    const referred = await bills.setCategory(draft.id, { referral_no: "R/2026/101" }, desk, db);
    expect(referred.category).toBe("cghs_referral");
    expect(referred.profile_saved).toBe(false);
    expect(await profileOf(patient)).toBe("cghs");
  });

  test("3. a referral already chosen on the profile still starts the next visit as CGHS Paid", async () => {
    const { visit } = await cghsPatient("LastReferral", 55, "cghs_referral");
    const draft = await bills.openDraft(visit, desk, db);
    expect(draft.category).toBe("cghs_paid");
  });

  test("4. a pensioner under 70 chosen by hand stays CGHS Pensioner", async () => {
    const { visit } = await cghsPatient("YoungPensioner", 65, "cghs_pensioner");
    const draft = await bills.openDraft(visit, desk, db);
    expect(draft.category).toBe("cghs_pensioner");
    const withReferral = await bills.setCategory(draft.id, { referral_no: "R/2026/102" }, desk, db);
    expect(withReferral.category).toBe("cghs_pensioner");
  });

  test("5. choosing CGHS Paid by hand together with a referral number keeps CGHS Paid", async () => {
    const { visit } = await cghsPatient("HandPaid", 50);
    const draft = await bills.openDraft(visit, desk, db);
    const chosen = await bills.setCategory(
      draft.id,
      { category: "cghs_paid", referral_no: "R/2026/103" },
      desk,
      db,
    );
    expect(chosen.category).toBe("cghs_paid");
  });

  test("6. a patient with no category is still General", async () => {
    const { visit } = await extraVisit(ids, "Plain", { healthray: false });
    const draft = await bills.openDraft(visit, desk, db);
    expect(draft.category).toBeNull();
  });
});
