import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  HEALTHRAY_CONSULTATION,
  autoConsultation,
  desk,
  extraVisit,
  healthrayBill,
  labOrder,
  newTag,
  setUp,
  tearDown,
} from "../phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const visitLines = await import("../../../server/services/billing/visitLines.js");
const { healthrayLinesForDesk } =
  await import("../../../server/services/billing/healthrayBillLines.js");

const db = getPool();
const tag = newTag();
const PACKAGE = "ABI,VPT,Fundus";
const REVIEW_CODE = "HR-ABI-VPT-FUNDUS";
const MACHINES = ["ABI", "VPT", "Fundus"];
let ids;
let autoBefore;
let reviewExisted;

const liveLines = (visitId) =>
  query(
    `SELECT i.code, l.source, l.patient_payable FROM bill_lines l
       JOIN bills b ON b.id = l.bill_id AND b.status <> 'cancelled'
       JOIN service_items i ON i.id = l.service_item_id
      WHERE l.visit_id = $1 AND l.is_live ORDER BY l.line_no`,
    [visitId],
  ).then((r) => r.rows);

test.describe.serial("P5-16 a HealthRay machine package is charged once", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    reviewExisted = !!(await query(`SELECT 1 FROM service_items WHERE code = $1`, [REVIEW_CODE]))
      .rows.length;
    const prices = { ABI: 500, VPT: 300, Fundus: 500 };
    for (const name of MACHINES) {
      await query(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
         SELECT $1, $2, $3, $4, 'test', c.id FROM giniflow_test_catalog c WHERE c.test_name = $5`,
        [`P4-M${name.toUpperCase()}-${tag}`, `${name} ${tag}`, ids.subgroup, prices[name], name],
      );
    }
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
    if (!reviewExisted) {
      await query(
        `DELETE FROM service_items i WHERE i.code = $1
            AND NOT EXISTS (SELECT 1 FROM bill_lines l WHERE l.service_item_id = i.id)`,
        [REVIEW_CODE],
      );
    }
  });

  test("1. tests already on the bill from floor orders: the HealthRay package is not added", async () => {
    const visit = await extraVisit(ids, "Pkg", { visitType: "Follow Up" });
    for (const name of MACHINES) {
      const order = await labOrder({ ...ids, visit: visit.visit }, [name], "machine");
      const result = await visitLines.linesForOrder(
        visit.visit,
        { labOrderId: order, testNames: [name] },
        desk,
        db,
      );
      expect(result.ok).toBe(true);
    }
    await healthrayBill(ids, visit.patient, [
      HEALTHRAY_CONSULTATION,
      { desc: PACKAGE, amount: 800, category: "machine" },
    ]);
    const result = await healthrayLinesForDesk(visit.visit, desk, db);
    expect(result.ok).toBe(true);
    expect(result.added).not.toContain(PACKAGE);
    const lines = await liveLines(visit.visit);
    expect(lines.map((l) => l.code)).not.toContain(REVIEW_CODE);
    expect(lines.filter((l) => l.source === "lab_order")).toHaveLength(3);
  });

  test("2. tests not on the bill: the HealthRay package is the one charge", async () => {
    const visit = await extraVisit(ids, "Only", { visitType: "Follow Up" });
    await healthrayBill(ids, visit.patient, [
      HEALTHRAY_CONSULTATION,
      { desc: PACKAGE, amount: 800, category: "machine" },
    ]);
    const result = await healthrayLinesForDesk(visit.visit, desk, db);
    expect(result.ok).toBe(true);
    expect(result.added).toContain(PACKAGE);
    const lines = await liveLines(visit.visit);
    const pkg = lines.filter((l) => l.code === REVIEW_CODE);
    expect(pkg).toHaveLength(1);
    expect(Number(pkg[0].patient_payable)).toBe(800);
    const again = await healthrayLinesForDesk(visit.visit, desk, db);
    expect(again.added).toEqual([]);
    expect((await liveLines(visit.visit)).filter((l) => l.code === REVIEW_CODE)).toHaveLength(1);
  });
});
