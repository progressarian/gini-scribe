import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const pricing = await import("../../../server/services/pricing.js");
const mo = await import("../../../server/services/giniflow/moStation.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");
const machines = await import("../../../server/services/giniflow/machineCatalog.js");
const catalog = await import("../../../server/services/giniflow/testCatalog.js");
const items = await import("../../../server/services/billing/serviceItems.js");
const rates = await import("../../../server/services/billing/categoryRates.js");
const schemes = await import("../../../server/services/patientSchemes.js");
const visitTypes = await import("../../../shared/billingVisitType.js");
const machineStation = await import("../../../server/services/giniflow/machineStation.js");

const db = getPool();
const ctx = { actorId: USERS.admin.id, ip: null };
const tag = crypto.randomBytes(3).toString("hex");
const c = (name) => `${name}_${tag}`;
const one = (sql, params) => query(sql, params).then((r) => r.rows[0]);
const failure = (promise) => promise.then(() => null).catch((e) => e);
const ids = {};
const LAB = `Ferritin ${tag}`;
const MACHINE = `Doppler ${tag}`;

const panelPrice = async (name) =>
  (await mo.getTestPanels(db)).tests.find((t) => (t.name ?? t.test_name) === name);
const deskPrice = async (name) =>
  (await reception.getTestCatalog(db)).find((t) => t.name === name)?.price;
const machinePrice = async (name) =>
  (await machines.machineOptions([], db)).tests.find((t) => t.testName === name)?.price;

const vptItemState = () =>
  one(
    `SELECT si.id, si.base_price, si.is_active FROM service_items si
       JOIN giniflow_test_catalog t ON t.id = si.test_catalog_id
      WHERE t.test_name = 'VPT'`,
  );

async function cleanUp(runTag) {
  const patients = `SELECT id FROM patients WHERE name LIKE ANY($1::text[])`;
  const visits = `SELECT id FROM giniflow_visits WHERE patient_id IN (${patients})`;
  const named = [[`E2E Arrival ${runTag} %`, `E2E Machine ${runTag} %`]];
  const items = `SELECT id FROM service_items WHERE subgroup_id IN
                   (SELECT id FROM service_subgroups WHERE code = $1)`;
  const sub = [`PS-${runTag}`];
  const schemes = [[`cghs_${runTag}`, `paid_${runTag}`]];
  await query(
    `DELETE FROM giniflow_lab_order_tests WHERE lab_order_id IN
       (SELECT id FROM giniflow_lab_orders WHERE visit_id IN (${visits}))`,
    named,
  );
  await query(`DELETE FROM giniflow_lab_orders WHERE visit_id IN (${visits})`, named);
  await query(`DELETE FROM giniflow_visit_events WHERE visit_id IN (${visits})`, named);
  await query(`DELETE FROM giniflow_visits WHERE patient_id IN (${patients})`, named);
  await query(`DELETE FROM appointments WHERE patient_id IN (${patients})`, named);
  await query(`DELETE FROM patients WHERE name LIKE ANY($1::text[])`, named);
  await query(`DELETE FROM category_item_rates WHERE scheme_code = ANY($1::text[])`, schemes);
  await query(`DELETE FROM category_item_rates WHERE service_item_id IN (${items})`, sub);
  await query(`DELETE FROM service_item_price_history WHERE service_item_id IN (${items})`, sub);
  await query(`DELETE FROM service_items WHERE id IN (${items})`, sub);
  await query(`DELETE FROM service_subgroups WHERE code = $1`, sub);
  await query(`DELETE FROM service_groups WHERE code = $1`, [`PG-${runTag}`]);
  await query(`DELETE FROM giniflow_test_catalog WHERE test_name = ANY($1::text[])`, [
    [`Ferritin ${runTag}`, `Doppler ${runTag}`, `Unpriced ${runTag}`],
  ]);
  await query(`DELETE FROM patient_schemes WHERE code = $1`, [`paid_${runTag}`]);
  await query(`DELETE FROM patient_schemes WHERE code = $1`, [`cghs_${runTag}`]);
}

test.describe.serial("P1-24 test prices move to the service master", () => {
  test.beforeAll(async () => {
    const earlier = await query(
      `SELECT substring(code FROM 4) AS tag FROM service_groups
        WHERE code ~ '^PG-[0-9a-f]{6}$' AND name = 'Prices ' || substring(code FROM 4)`,
    );
    for (const { tag: runTag } of earlier.rows) await cleanUp(runTag);
    ids.vptBefore = await vptItemState();
    ids.lab = (
      await one(
        `INSERT INTO giniflow_test_catalog (test_name, price, category) VALUES ($1, 150, 'lab') RETURNING id`,
        [LAB],
      )
    ).id;
    ids.machine = (
      await one(
        `INSERT INTO giniflow_test_catalog (test_name, price, category) VALUES ($1, 800, 'machine') RETURNING id`,
        [MACHINE],
      )
    ).id;
    const group = await one(
      `INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`,
      [`PG-${tag}`, `Prices ${tag}`],
    );
    ids.sub = (
      await one(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'Prices sub') RETURNING id`,
        [group.id, `PS-${tag}`],
      )
    ).id;
    await schemes.createScheme({ code: c("cghs"), label: `CGHS ${tag}` }, db, ctx);
    await schemes.createScheme(
      { code: c("paid"), label: "CGHS Paid", parent_code: c("cghs") },
      db,
      ctx,
    );
  });

  test.afterAll(async () => {
    try {
      await cleanUp(tag);
    } finally {
      const before = ids.vptBefore;
      if (before)
        await query(`UPDATE service_items SET base_price = $2, is_active = $3 WHERE id = $1`, [
          before.id,
          before.base_price,
          before.is_active,
        ]);
    }
  });

  test("1. with no service item, every screen shows the catalogue price, as before", async () => {
    expect(await pricing.testPricesFor([LAB, MACHINE], null, db)).toEqual({
      [LAB]: 150,
      [MACHINE]: 800,
    });
    expect(
      await pricing.testPricesFor([LAB], c("cghs"), db),
      "no item means no category rate either",
    ).toEqual({ [LAB]: 150 });
    const panel = await panelPrice(LAB);
    expect(panel?.price).toBe(150);
    expect(await deskPrice(LAB)).toBe(150);
    expect(await machinePrice(MACHINE)).toBe(800);
    const listed = (await catalog.listCatalog(db)).find((t) => t.name === LAB);
    expect(listed).toMatchObject({ price: 150, pricedBy: "catalogue", serviceItemId: null });
  });

  test("2. once a test has an active service item, its price comes from the item everywhere", async () => {
    const item = await items.createItem(
      {
        code: `P-FER-${tag}`,
        name: "Ferritin",
        subgroup_id: ids.sub,
        base_price: 400,
        kind: "test",
        test_catalog_id: ids.lab,
      },
      ctx,
      db,
    );
    ids.labItem = item.id;
    const machineItem = await items.createItem(
      {
        code: `P-DOP-${tag}`,
        name: "Doppler",
        subgroup_id: ids.sub,
        base_price: 950,
        kind: "test",
        test_catalog_id: ids.machine,
      },
      ctx,
      db,
    );
    ids.machineItem = machineItem.id;
    expect(await pricing.testPricesFor([LAB, MACHINE], null, db)).toEqual({
      [LAB]: 400,
      [MACHINE]: 950,
    });
    expect((await panelPrice(LAB))?.price).toBe(400);
    expect(await deskPrice(LAB)).toBe(400);
    expect(await machinePrice(MACHINE)).toBe(950);
    const listed = (await catalog.listCatalog(db)).find((t) => t.name === LAB);
    expect(listed).toMatchObject({
      price: 400,
      pricedBy: "service_item",
      serviceItemCode: `P-FER-${tag}`,
    });
    await items.setItemActive(ids.labItem, false, ctx, db);
    expect(
      await pricing.testPricesFor([LAB], null, db),
      "a deactivated item falls back to the catalogue",
    ).toEqual({ [LAB]: 150 });
    await items.setItemActive(ids.labItem, true, ctx, db);
  });

  test("3. a category's rate, else its parent's, is used for that category", async () => {
    const today = pricing.testPricesFor;
    await rates.saveRate(
      { scheme_code: c("cghs"), service_item_id: ids.labItem, rate: 300, valid_from: "2020-01-01" },
      ctx,
      db,
    );
    expect(await today([LAB], c("cghs"), db)).toEqual({ [LAB]: 300 });
    expect(await today([LAB], c("paid"), db), "a sub-category inherits the parent's rate").toEqual({
      [LAB]: 300,
    });
    await rates.saveRate(
      { scheme_code: c("paid"), service_item_id: ids.labItem, rate: 250, valid_from: "2020-01-01" },
      ctx,
      db,
    );
    expect(await today([LAB], c("paid"), db), "its own rate wins").toEqual({ [LAB]: 250 });
    await rates.saveRate(
      {
        scheme_code: c("paid"),
        service_item_id: ids.labItem,
        bill_code: "ONLYCODE",
        valid_from: "2021-01-01",
      },
      ctx,
      db,
    );
    expect(
      await today([LAB], c("paid"), db),
      "a row with only a bill code keeps the price from the parent",
    ).toEqual({ [LAB]: 300 });
    await rates.saveRate(
      { scheme_code: c("cghs"), service_item_id: ids.labItem, rate: 999, valid_from: "2099-01-01" },
      ctx,
      db,
    );
    expect(await today([LAB], c("cghs"), db), "a future rate isn't used yet").toEqual({
      [LAB]: 300,
    });
    expect(
      await pricing.testPricesFor([LAB], c("cghs"), db, "2099-06-01"),
      "but is on its date",
    ).toEqual({ [LAB]: 999 });
    expect(await today([LAB], null, db), "General still pays the base price").toEqual({
      [LAB]: 400,
    });
    const panel = (await mo.getTestPanels(db)).tests.find((t) => (t.name ?? t.test_name) === LAB);
    expect(panel?.price, "the MO list without a visit shows the base price").toBe(400);
  });

  test("4. the Reception arrivals row shows the category's consultation rate for the doctor", async () => {
    const DAY = "2031-05-05";
    const doctor = CONSULTANTS.banshali.id;
    const consult = await items.createItem(
      {
        code: `P-CFU-${tag}`,
        name: `Consult FU ${tag}`,
        subgroup_id: ids.sub,
        base_price: 1000,
        kind: "consultation",
        doctor_id: doctor,
        visit_type: "Follow Up",
      },
      ctx,
      db,
    );
    await rates.saveRate(
      { scheme_code: c("cghs"), service_item_id: consult.id, rate: 700, valid_from: "2031-01-01" },
      ctx,
      db,
    );
    const book = async (category, visitType) => {
      const patient = await one(`INSERT INTO patients (name) VALUES ($1) RETURNING id`, [
        `E2E Arrival ${tag} ${visitType}`,
      ]);
      const appt = await one(
        `INSERT INTO appointments (patient_id, patient_name, appointment_date, patient_category, visit_type, status)
         VALUES ($1, 'E2E', $2, $3, $4, 'scheduled') RETURNING id`,
        [patient.id, DAY, category, visitType],
      );
      return (
        await one(
          `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, assigned_doctor_id, current_status)
           VALUES ($1, $2, $3, $4, 'booked') RETURNING id`,
          [patient.id, DAY, appt.id, doctor],
        )
      ).id;
    };
    const followUp = await book(c("paid"), "Follow-Up");
    const investigation = await book(c("paid"), "Investigation");
    const general = await book(null, "Follow-Up");
    const result = await reception.getArrivals(DAY, "", new Date(), db);
    const rows = Object.values(result).filter(Array.isArray).flat();
    const fee = (id) => rows.find((r) => r.visitId === id)?.schemeOpdFee;
    expect(fee(followUp), "CGHS Paid inherits CGHS's 700 for this doctor's Follow Up").toBe(700);
    expect(fee(investigation), "no consultation fee for an Investigation visit").toBeNull();
    expect(fee(general), "no category, nothing to key in").toBeNull();
  });

  test("5. the test catalogue refuses every price edit (P1-24, widened in P1-34)", async () => {
    const error = await failure(catalog.updateCatalogTest(ids.lab, { price: 175 }, db));
    expect(error?.status).toBe(409);
    expect(error.message).toBe(
      `This test is priced by the billing item Ferritin (P-FER-${tag}); change its price in Settings → Services`,
    );
    const gloss = await catalog.updateCatalogTest(ids.lab, { gloss: "Iron stores" }, db);
    expect(gloss, "other edits still work and show the item's price").toMatchObject({
      gloss: "Iron stores",
      price: 400,
    });
    const other = await one(
      `INSERT INTO giniflow_test_catalog (test_name, price) VALUES ($1, 90) RETURNING id`,
      [`Unpriced ${tag}`],
    );
    const unpriced = await failure(catalog.updateCatalogTest(other.id, { price: 120 }, db));
    expect(unpriced.status, "P1-34: no catalogue price is set here any more").toBe(409);
    expect(unpriced.message).toBe(
      "Test prices are set on the test's billing item; create one in Settings → Services",
    );
    expect(
      (await one(`SELECT price::int FROM giniflow_test_catalog WHERE id = $1`, [other.id])).price,
    ).toBe(90);
    const found = await catalog.addCatalogTest(LAB, {}, db);
    expect(found).toMatchObject({ created: false, price: 400 });
  });

  test("6. the billing visit type means the same in JavaScript and in SQL", async () => {
    const samples = [
      "New",
      "New Patient",
      "new",
      "Follow-Up",
      "Follow-up",
      "Follow Up",
      "Tele",
      "OPD",
      "Investigation",
      "investigation ",
      "",
      null,
      "  ",
    ];
    const { rows } = await query(
      `SELECT v.value, ${visitTypes.billingVisitTypeSql("v.value")} AS billing
         FROM unnest($1::text[]) WITH ORDINALITY AS v(value, n) ORDER BY n`,
      [samples],
    );
    expect(rows.map((r) => r.billing)).toEqual(samples.map(visitTypes.billingVisitType));
    expect(samples.map(visitTypes.billingVisitType)).toEqual([
      "New",
      "New",
      "New",
      "Follow Up",
      "Follow Up",
      "Follow Up",
      "Follow Up",
      "Follow Up",
      null,
      null,
      "New",
      "New",
      "New",
    ]);
  });

  test("7. a machine test is priced at the patient's category rate, like a lab test", async () => {
    const vpt = await one(`SELECT id FROM giniflow_test_catalog WHERE test_name = 'VPT'`);
    const existing = await one(`SELECT id FROM service_items WHERE test_catalog_id = $1`, [vpt.id]);
    const vptItem =
      existing?.id ??
      (
        await items.createItem(
          {
            code: `P-VPT-${tag}`,
            name: `VPT ${tag}`,
            subgroup_id: ids.sub,
            base_price: 700,
            kind: "test",
            test_catalog_id: vpt.id,
          },
          ctx,
          db,
        )
      ).id;
    await query(`UPDATE service_items SET base_price = 700, is_active = TRUE WHERE id = $1`, [
      vptItem,
    ]);
    await rates.saveRate(
      { scheme_code: c("cghs"), service_item_id: vptItem, rate: 450, valid_from: "2020-01-01" },
      ctx,
      db,
    );
    const DAY = "2031-06-06";
    const visitFor = async (category) => {
      const patient = await one(`INSERT INTO patients (name) VALUES ($1) RETURNING id`, [
        `E2E Machine ${tag} ${category}`,
      ]);
      const appt = await one(
        `INSERT INTO appointments (patient_id, patient_name, appointment_date, patient_category, visit_type, status)
         VALUES ($1, 'E2E', $2, $3, 'Follow-Up', 'scheduled') RETURNING id`,
        [patient.id, DAY, category],
      );
      return (
        await one(
          `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, current_status)
           VALUES ($1, $2, $3, 'checked_in') RETURNING id`,
          [patient.id, DAY, appt.id],
        )
      ).id;
    };
    const cghsVisit = await visitFor(c("paid"));
    const generalVisit = await visitFor(null);
    expect(
      await pricing.testPriceForVisit(cghsVisit, "vpt", db),
      "found ignoring case, CGHS Paid inherits 450",
    ).toBe(450);
    expect(await pricing.testPriceForVisit(generalVisit, "VPT", db)).toBe(700);
    expect(await pricing.testPriceForVisit(generalVisit, `Nope ${tag}`, db)).toBeNull();

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const cghsOrder = await machineStation.addMachineTestOn(client, cghsVisit, {
        machineId: "vpt",
      });
      const generalOrder = await machineStation.addMachineTestOn(client, generalVisit, {
        machineId: "vpt",
      });
      const amounts = await client.query(
        `SELECT id, amount_total FROM giniflow_lab_orders WHERE id = ANY($1::uuid[])`,
        [[cghsOrder.orderId, generalOrder.orderId]],
      );
      const amount = (id) => Number(amounts.rows.find((r) => r.id === id).amount_total);
      expect(amount(cghsOrder.orderId), "the machine station charges the CGHS rate").toBe(450);
      expect(amount(generalOrder.orderId), "and the General price otherwise").toBe(700);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("8. a retired category's rates are not used", async () => {
    expect(await pricing.testPricesFor([LAB], c("paid"), db)).toEqual({ [LAB]: 300 });
    await query(`UPDATE patient_schemes SET is_active = FALSE WHERE code = $1`, [c("paid")]);
    expect(await pricing.testPricesFor([LAB], c("paid"), db), "a retired sub-category").toEqual({
      [LAB]: 400,
    });
    await query(`UPDATE patient_schemes SET is_active = TRUE WHERE code = $1`, [c("paid")]);
    await query(`UPDATE patient_schemes SET is_active = FALSE WHERE code = $1`, [c("cghs")]);
    expect(await pricing.testPricesFor([LAB], c("paid"), db), "a retired parent").toEqual({
      [LAB]: 400,
    });
    expect(await pricing.testPricesFor([LAB], c("cghs"), db)).toEqual({ [LAB]: 400 });
    await query(`UPDATE patient_schemes SET is_active = TRUE WHERE code = $1`, [c("cghs")]);
  });
});
