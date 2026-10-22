import { test, expect } from "@playwright/test";
import { getPool, one } from "../helpers/db.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { desk, newTag, refused, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const ordered = await import("../../server/services/billing/orderedServices.js");
const bills = await import("../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
const doctor = { actorId: CONSULTANTS.banshali.id, ip: "10.9.11.5", role: "consultant" };
let ids;

test.describe.serial("G115 the doctor orders a procedure and reception sets its price", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    ids.echo = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, price_per_patient)
         VALUES ($1, $2, $3, 0, 'procedure', TRUE) RETURNING id`,
        [`P4-ECHO-${tag}`, `2D echo ${tag}`, ids.subgroup],
      )
    ).id;
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. reception still has to type the price when it adds the procedure", async () => {
    await refused(
      ordered.addOrderedService(ids.visit, { item_id: ids.echo }, desk, db),
      400,
      /Enter this patient's price/,
    );
  });

  test("2. the doctor adds it with no price and it waits on the bill unpriced", async () => {
    const { services } = await ordered.addOrderedService(
      ids.visit,
      { item_id: ids.echo },
      doctor,
      db,
      { priceLater: true },
    );
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      name: `2D echo ${tag}`,
      agreed_rate: null,
      patient_payable: 0,
      added_by: CONSULTANTS.banshali.id,
      price_set_by: null,
    });
    ids.line = services[0].line_id;
    ids.bill = services[0].bill_id;
  });

  test("3. reception sets the price and the bill carries it", async () => {
    const bill = await bills.setLinePrice(
      ids.bill,
      ids.line,
      { agreed_rate: "1800", reason: "Echo rate for this patient" },
      desk,
      db,
    );
    const line = bill.lines.find((l) => l.id === ids.line);
    expect(line.agreed_rate).toBe(180000);
    expect(line.agreed_by).toBe(desk.actorId);
  });
});
