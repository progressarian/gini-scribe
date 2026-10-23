import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import {
  desk,
  extraVisit,
  healthrayBill,
  newTag,
  setUp,
  tearDown,
  HEALTHRAY_CONSULTATION,
} from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const { healthrayBillSteps } = await import("../../server/services/giniflow/machineSync.js");
const { ensurePlan } = await import("../../server/services/giniflow/journey.js");
const { LAB_ONLY_DOCTOR } = await import("../../server/services/giniflow/labOnlyVisits.js");
const { arrivalBillPreview, commitArrivalBill } =
  await import("../../server/services/billing/arrivalBill.js");
const { healthrayLinesForDesk } =
  await import("../../server/services/billing/healthrayBillLines.js");

const tag = newTag();
const MYSTERY = `MYSTERY LINE ${tag}`;
let ids;
let dressing;

const dressingLine = () => ({ desc: `DRESSING ${tag}`, amount: 500, category: "procedure" });

async function samplesOnly(label, items) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(
    `UPDATE appointments
        SET doctor_id = NULL, doctor_name = $2, visit_type = 'Investigation', status = 'checkedin',
            healthray_patient_id = $3
      WHERE id = $1`,
    [made.appointment, LAB_ONLY_DOCTOR, `hr-${label}-${tag}`],
  );
  await query(
    `UPDATE giniflow_visits SET current_status = 'booked', assigned_doctor_id = NULL WHERE id = $1`,
    [made.visit],
  );
  await healthrayBill(ids, made.patient, items);
  await query(
    `UPDATE giniflow_patient_bills SET read_at = NOW() WHERE patient_id = $1 AND bill_date = $2`,
    [made.patient, ids.day],
  );
  return made;
}

const planned = async (visit) =>
  (
    await query(
      `SELECT step_catalog_id, step_name FROM giniflow_visit_steps
        WHERE visit_id = $1 ORDER BY step_order`,
      [visit],
    )
  ).rows;

test.describe.serial("G124 a procedure-only arrival gets a procedure journey and bill", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    dressing = await one(`SELECT id, name FROM service_items WHERE id = $1`, [ids.dressing]);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`HR-MYSTERY-LINE-%`]).catch(
      () => {},
    );
  });

  test("1. a dressing-only HealthRay bill is read as procedures only", async () => {
    const { patient } = await samplesOnly("ReadOnly", [dressingLine()]);
    const read = await healthrayBillSteps(patient, { date: ids.day, db });
    expect(read.status).toBe("procedures_only");
    expect(read.steps).toEqual([]);
    expect(read.procedure).toMatchObject({ catalogId: "procedure", name: dressing.name });
  });

  test("2. the floor seeds Check-in then the procedure, with no lab steps", async () => {
    const { visit } = await samplesOnly("Seeded", [dressingLine()]);
    await ensurePlan(visit, db);
    const steps = await planned(visit);
    expect(steps.map((s) => s.step_catalog_id)).toEqual(["check_in", "procedure"]);
    expect(steps[1].step_name).toBe(dressing.name);
  });

  test("3. a consultation booking with a dressing keeps its journey", async () => {
    const made = await extraVisit(ids, "Consult", { healthray: false });
    await healthrayBill(ids, made.patient, [HEALTHRAY_CONSULTATION, dressingLine()]);
    await ensurePlan(made.visit, db);
    const steps = await planned(made.visit);
    expect(steps.some((s) => s.step_catalog_id === "procedure")).toBe(false);
  });

  test("4. Bill at arrival shows the dressing from HealthRay and names an unknown line", async () => {
    const { visit } = await samplesOnly("Arrival", [
      dressingLine(),
      { desc: MYSTERY, amount: 200, category: "procedure" },
    ]);
    const preview = await arrivalBillPreview(visit, {}, desk, db);
    const line = preview.lines.find((l) => l.itemId === dressing.id);
    expect(line).toMatchObject({ fromHealthray: true, amount: 50000 });
    expect(preview.notMatched).toEqual([{ desc: MYSTERY, amount: 20000 }]);
    expect(preview.lines.some((l) => l.name.includes("MYSTERY"))).toBe(false);
  });

  test("5. paid in HealthRay at arrival, nothing to collect and the Bill tab adds nothing", async () => {
    const { visit } = await samplesOnly("Commit", [dressingLine()]);
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [visit]);
    const preview = await arrivalBillPreview(visit, {}, desk, db);
    expect(preview.outstanding).toBe(50000);
    const done = await commitArrivalBill(
      visit,
      {
        expectedTotal: preview.outstanding,
        alreadyPaid: [{ itemId: dressing.id, source: "healthray" }],
      },
      desk,
      db,
    );
    expect(done.payments).toEqual([{ mode: "healthray", amount: 50000 }]);
    const lines = await query(
      `SELECT count(*)::int AS n FROM bill_lines WHERE visit_id = $1 AND service_item_id = $2
          AND is_live`,
      [visit, dressing.id],
    );
    expect(lines.rows[0].n).toBe(1);
    const again = await healthrayLinesForDesk(visit, desk, db);
    expect(again.added).toEqual([]);
  });
});
