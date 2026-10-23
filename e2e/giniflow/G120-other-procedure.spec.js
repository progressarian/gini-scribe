import { test, expect } from "@playwright/test";
import { getPool, query } from "../helpers/db.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { newTag, refused, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { OTHER_PROCEDURE_CODE } from "../../shared/otherProcedure.js";
if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const ordered = await import("../../server/services/billing/orderedServices.js");

const db = getPool();
const tag = newTag();
const doctor = { actorId: CONSULTANTS.banshali.id, ip: "10.9.12.5", role: "consultant" };
const asDoctor = { priceLater: true };
let ids;
let createdItem = null;

const requestsFor = async () =>
  (
    await query(
      `SELECT proposed_name, status FROM billing_requests
        WHERE visit_id = $1 AND kind = 'new_item' ORDER BY created_at`,
      [ids.visit],
    )
  ).rows;

test.describe
  .serial("G120 a procedure not in the list is billed as Other procedure and requested", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await query(`UPDATE service_items SET is_active = false WHERE upper(code) = $1`, [
      OTHER_PROCEDURE_CODE,
    ]);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM billing_requests WHERE visit_id = $1`, [ids.visit]).catch(() => {});
    await tearDown(ids);
    if (createdItem) {
      await query(`DELETE FROM service_items WHERE id = $1`, [createdItem]).catch(() => {});
    }
    await query(`UPDATE service_items SET is_active = true WHERE upper(code) = $1`, [
      OTHER_PROCEDURE_CODE,
    ]);
  });

  test("1. with no Other procedure item, nothing is billed but admin is asked", async () => {
    const result = await ordered.addOtherProcedure(
      ids.visit,
      { name: `Wound dressing ${tag}` },
      doctor,
      db,
      asDoctor,
    );
    expect(result).toMatchObject({ added: false, requested: true });
    expect(result.services).toHaveLength(0);
    expect(await requestsFor()).toEqual([
      { proposed_name: `Wound dressing ${tag}`, status: "pending" },
    ]);
  });

  test("2. with the item, it goes on the bill under its own name, unpriced for reception", async () => {
    const existing = await query(`SELECT id FROM service_items WHERE upper(code) = $1`, [
      OTHER_PROCEDURE_CODE,
    ]);
    if (existing.rows.length) {
      await query(
        `UPDATE service_items SET is_active = true, price_per_patient = true WHERE id = $1`,
        [existing.rows[0].id],
      );
    } else {
      createdItem = (
        await query(
          `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, price_per_patient)
           VALUES ($1, 'Other procedure', $2, 0, 'procedure', TRUE) RETURNING id`,
          [OTHER_PROCEDURE_CODE, ids.subgroup],
        )
      ).rows[0].id;
    }
    const result = await ordered.addOtherProcedure(
      ids.visit,
      { name: `Wound dressing ${tag}` },
      doctor,
      db,
      asDoctor,
    );
    expect(result).toMatchObject({ added: true, requested: true });
    expect(result.services).toHaveLength(1);
    expect(result.services[0]).toMatchObject({
      name: `Other procedure — Wound dressing ${tag}`,
      agreed_rate: null,
      added_by: CONSULTANTS.banshali.id,
    });
  });

  test("3. a second, different other procedure needs no repeat approval; the same one twice is refused", async () => {
    const result = await ordered.addOtherProcedure(
      ids.visit,
      { name: `Suture removal ${tag}` },
      doctor,
      db,
      asDoctor,
    );
    expect(result.services.map((s) => s.name)).toEqual([
      `Other procedure — Wound dressing ${tag}`,
      `Other procedure — Suture removal ${tag}`,
    ]);
    await refused(
      ordered.addOtherProcedure(ids.visit, { name: `suture REMOVAL ${tag}` }, doctor, db, asDoctor),
      409,
      /already ordered/,
    );
  });

  test("4. a name that is too short is refused", async () => {
    await refused(
      ordered.addOtherProcedure(ids.visit, { name: " x " }, doctor, db, asDoctor),
      400,
      /procedure's name/,
    );
  });
});
