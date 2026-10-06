import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { MEDICINE_TYPES, medicineTypeFor } from "../../shared/medicineTypes.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/receptionStation.js");
const rx = await import("../../server/services/giniflow/prescription.js");

const db = getPool();
const tag = newTag();
let ids;
let visit;

test.describe.serial("G65 a medicine carries its HealthRay medicine type", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    visit = await extraVisit(ids, "RxType");
  });

  test.afterAll(async () => {
    await query(`DELETE FROM giniflow_rx_items WHERE visit_id = $1`, [visit.visit]);
    await query(`DELETE FROM medications WHERE patient_id = $1`, [visit.patient]);
    await tearDown(ids);
  });

  test("1. the list is HealthRay's, trimmed, and old forms map onto it", () => {
    expect(MEDICINE_TYPES).toContain("INJ(insulin)");
    expect(MEDICINE_TYPES).toContain("SAC");
    expect(MEDICINE_TYPES.every((type) => type === type.trim())).toBe(true);
    expect(new Set(MEDICINE_TYPES).size).toBe(MEDICINE_TYPES.length);
    expect(medicineTypeFor({ name: "Tab Atchol 40mg" })).toBe("TAB");
    expect(medicineTypeFor({ name: "Inj. Lantus" })).toBe("INJ");
    expect(medicineTypeFor({ form: "Capsule" })).toBe("CAP");
    expect(medicineTypeFor({ form: "vag.cap" })).toBe("VAG.CAP");
    expect(medicineTypeFor({ name: "Atchol" })).toBe("");
  });

  test("2. the type chosen when adding is saved, and can be changed by editing", async () => {
    const added = await rx.addItem(
      visit.visit,
      { medicineName: `Lantus ${tag}`, dose: "10 U", frequency: "OD", form: "INJ(insulin)" },
      db,
    );
    expect(added.form).toBe("INJ(insulin)");
    const edited = await rx.updateItem(added.id, { form: "INSULIN PEN" }, db);
    expect(edited.form).toBe("INSULIN PEN");
    const untouched = await rx.updateItem(added.id, { dose: "12 U" }, db);
    expect(untouched.form).toBe("INSULIN PEN");
  });

  test("3. a typed medicine keeps the chosen type over the one in its name", async () => {
    const saved = await rx.addExternal(
      visit.patient,
      { medicineName: `Tab Thyronorm ${tag}`, form: "CAP", prescriberName: "Dr Outside" },
      db,
    );
    const row = await one(`SELECT form FROM medications WHERE id = $1`, [saved.id]);
    expect(row.form).toBe("CAP");
  });
});
