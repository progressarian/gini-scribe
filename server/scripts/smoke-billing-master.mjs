import "../loadEnv.js";
import crypto from "node:crypto";
import pool from "../config/db.js";
import * as groups from "../services/billing/serviceGroups.js";
import * as taxes from "../services/billing/taxCodes.js";
import * as items from "../services/billing/serviceItems.js";
import * as rules from "../services/billing/categoryRules.js";
import * as rates from "../services/billing/categoryRates.js";
import { createScheme, deleteScheme, updateScheme } from "../services/patientSchemes.js";
import { loadResolverData, resolveCategory } from "../services/billing/categoryResolver.js";
import { testPricesFor } from "../services/pricing.js";
import { getTestCatalog } from "../services/giniflow/receptionStation.js";
import { machineOptions } from "../services/giniflow/machineCatalog.js";

const tag = crypto.randomBytes(3).toString("hex");
const code = (name) => `SMOKE_${name}_${tag}`.toUpperCase();
const scheme = (name) => `smoke_${name}_${tag}`;
const ctx = { actorId: null, ip: null };
const results = [];
const notes = [];
const created = [];
const track = (entity, id) => {
  created.push([entity, String(id)]);
  return id;
};

const refused = async (work, status) => {
  try {
    await work();
  } catch (error) {
    if (error.status === status) return error;
    throw error;
  }
  throw new Error(`expected a ${status} refusal, but it succeeded`);
};

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const readBack = async (client, sql, params, expected, what) => {
  const { rows } = await client.query(sql, params);
  const actual = rows[0] ? Object.values(rows[0])[0] : undefined;
  expect(String(actual) === String(expected), `${what} was not saved (got ${actual})`);
};

async function check(name, work) {
  try {
    await work();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

async function run(client) {
  const doctor = (
    await client.query(
      `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
      [`Dr Smoke ${tag}`],
    )
  ).rows[0];
  const catalogueTest = (
    await client.query(
      `INSERT INTO giniflow_test_catalog (test_name, price, category, source)
       VALUES ($1, 250, 'lab', 'smoke') RETURNING id`,
      [`Smoke Test ${tag}`],
    )
  ).rows[0];
  const made = {};

  await check("1. create, update and delete one of each master row", async () => {
    made.group = await groups.createGroup({ code: code("G"), name: `Smoke ${tag}` }, ctx, client);
    track("service_groups", made.group.id);
    await groups.updateGroup(made.group.id, { name: `Smoke group ${tag}` }, ctx, client);
    await readBack(
      client,
      `SELECT name FROM service_groups WHERE id = $1`,
      [made.group.id],
      `Smoke group ${tag}`,
      "the group rename",
    );
    made.subgroup = await groups.createSubgroup(
      { group_id: made.group.id, code: code("S"), name: "Smoke sub" },
      ctx,
      client,
    );
    track("service_subgroups", made.subgroup.id);
    await groups.updateSubgroup(made.subgroup.id, { name: "Smoke subgroup" }, ctx, client);
    await readBack(
      client,
      `SELECT name FROM service_subgroups WHERE id = $1`,
      [made.subgroup.id],
      "Smoke subgroup",
      "the subgroup rename",
    );
    const tax = await taxes.createTaxCode({ code: code("T"), rate_pct: 18 }, ctx, client);
    track("tax_codes", tax.id);
    await taxes.updateTaxCode(tax.id, { sac_hsn: "999312" }, ctx, client);
    await readBack(
      client,
      `SELECT sac_hsn FROM tax_codes WHERE id = $1`,
      [tax.id],
      "999312",
      "the tax code's SAC",
    );
    made.item = await items.createItem(
      {
        code: code("I"),
        name: "Smoke dressing",
        subgroup_id: made.subgroup.id,
        base_price: 200,
        kind: "procedure",
        tax_code_id: tax.id,
      },
      ctx,
      client,
    );
    track("service_items", made.item.id);
    const top = await createScheme({ code: scheme("top"), label: `Smoke ${tag}` }, client, ctx);
    track("patient_schemes", top.code);
    await updateScheme(top.code, { payer_name: "Smoke payer" }, client, ctx);
    await readBack(
      client,
      `SELECT payer_name FROM patient_schemes WHERE code = $1`,
      [top.code],
      "Smoke payer",
      "the category's payer",
    );
    const rule = await rules.createRule(
      { scheme_code: top.code, name: "Smoke women", gender: "Female" },
      ctx,
      client,
    );
    track("category_rules", rule.id);
    await rules.updateRule(rule.id, { priority: 7 }, ctx, client);
    await readBack(
      client,
      `SELECT priority FROM category_rules WHERE id = $1`,
      [rule.id],
      7,
      "the rule's priority",
    );
    await rates.saveRate(
      { scheme_code: top.code, service_item_id: made.item.id, rate: 150, bill_code: "SM01" },
      ctx,
      client,
    );
    const { rate } = await rates.saveRate(
      { scheme_code: top.code, service_item_id: made.item.id, rate: 160, bill_code: "SM01" },
      ctx,
      client,
    );
    track("category_item_rates", `${top.code}:${made.item.id}:${rate.valid_from}`);
    await readBack(
      client,
      `SELECT rate FROM category_item_rates WHERE scheme_code = $1 AND service_item_id = $2`,
      [top.code, made.item.id],
      "160.00",
      "the rate update",
    );

    await rates.deleteRate(
      { scheme_code: top.code, service_item_id: made.item.id, valid_from: rate.valid_from },
      ctx,
      client,
    );
    await rules.deleteRule(rule.id, ctx, client);
    await deleteScheme(top.code, client, ctx);
    await items.updateItem(made.item.id, { tax_code_id: null }, ctx, client);
    await taxes.deleteTaxCode(tax.id, ctx, client);

    const spareGroup = await groups.createGroup(
      { code: code("G2"), name: `Smoke spare ${tag}` },
      ctx,
      client,
    );
    const spareSub = await groups.createSubgroup(
      { group_id: spareGroup.id, code: code("S2"), name: "Smoke spare sub" },
      ctx,
      client,
    );
    const spareItem = await items.createItem(
      {
        code: code("I2"),
        name: "Smoke spare item",
        subgroup_id: spareSub.id,
        base_price: 10,
        kind: "other",
      },
      ctx,
      client,
    );
    track("service_groups", spareGroup.id);
    track("service_subgroups", spareSub.id);
    track("service_items", spareItem.id);
    await items.updateItem(spareItem.id, { unit: "box" }, ctx, client);
    await readBack(
      client,
      `SELECT unit FROM service_items WHERE id = $1`,
      [spareItem.id],
      "box",
      "the item update",
    );
    await items.deleteItem(spareItem.id, ctx, client);
    await groups.deleteSubgroup(spareSub.id, ctx, client);
    await groups.deleteGroup(spareGroup.id, ctx, client);
    const spares = await client.query(
      `SELECT (SELECT count(*) FROM service_items WHERE id = $1)::int
            + (SELECT count(*) FROM service_subgroups WHERE id = $2)::int
            + (SELECT count(*) FROM service_groups WHERE id = $3)::int AS n`,
      [spareItem.id, spareSub.id, spareGroup.id],
    );
    expect(spares.rows[0].n === 0, "a deleted group, subgroup or item is still there");
    const left = await client.query(
      `SELECT (SELECT count(*) FROM tax_codes WHERE id = $1)::int
            + (SELECT count(*) FROM patient_schemes WHERE code = $2)::int
            + (SELECT count(*) FROM category_rules WHERE id = $3)::int AS n`,
      [tax.id, top.code, rule.id],
    );
    expect(left.rows[0].n === 0, "a deleted row is still there");
  });

  await check("2. deleting a row that is still used is refused", async () => {
    const error = await refused(() => groups.deleteSubgroup(made.subgroup.id, ctx, client), 409);
    expect(error.uses?.length > 0, "the refusal did not list where it is used");
    await refused(() => groups.deleteGroup(made.group.id, ctx, client), 409);
  });

  await check("3. CGHS › Pensioner is accepted; a child under Pensioner is refused", async () => {
    made.cghs = await createScheme(
      { code: scheme("cghs"), label: `Smoke CGHS ${tag}`, requires_ref: true },
      client,
      ctx,
    );
    track("patient_schemes", made.cghs.code);
    made.pensioner = await createScheme(
      { code: scheme("pen"), label: "Pensioner", parent_code: made.cghs.code },
      client,
      ctx,
    );
    track("patient_schemes", made.pensioner.code);
    expect(
      made.pensioner.display_label === `Smoke CGHS ${tag} › Pensioner`,
      `unexpected label ${made.pensioner.display_label}`,
    );
    await refused(
      () =>
        createScheme(
          { code: scheme("deep"), label: "Too deep", parent_code: made.pensioner.code },
          client,
          ctx,
        ),
      409,
    );
  });

  await check(
    "4. a second consultation item for the same doctor and visit type is refused",
    async () => {
      const consultation = {
        name: "Smoke consultation",
        subgroup_id: made.subgroup.id,
        base_price: 900,
        kind: "consultation",
        doctor_id: doctor.id,
        visit_type: "New",
      };
      const first = await items.createItem({ ...consultation, code: code("C1") }, ctx, client);
      track("service_items", first.id);
      await refused(
        () =>
          items.createItem({ ...consultation, code: code("C2"), name: "Smoke again" }, ctx, client),
        409,
      );
    },
  );

  await check("5. a price change writes the price history", async () => {
    await items.updateItem(
      made.item.id,
      { base_price: 240, reason: "Smoke price change" },
      ctx,
      client,
    );
    const history = await items.priceHistory(made.item.id, client);
    expect(history.length === 2, `expected 2 history rows, got ${history.length}`);
    expect(
      history[0].old_price === 200 &&
        history[0].new_price === 240 &&
        history[0].reason === "Smoke price change",
      "the newest history row is wrong",
    );
  });

  await check("6. the category resolver's four cases", async () => {
    const women = await createScheme(
      { code: scheme("women"), label: `Smoke Women ${tag}` },
      client,
      ctx,
    );
    track("patient_schemes", women.code);
    const pensionerRule = await rules.createRule(
      {
        scheme_code: made.pensioner.code,
        name: "Smoke card 60+",
        min_age: 60,
        requires_card: true,
        mode: "auto",
        priority: 1,
      },
      ctx,
      client,
    );
    track("category_rules", pensionerRule.id);
    const data = await loadResolverData(client);
    data.rules = data.rules.filter((r) => r.id === pensionerRule.id);
    const dob = (years) => `${new Date().getFullYear() - years}-01-01`;
    const resolve = (patient, appointment = {}) => resolveCategory({ patient, appointment }, data);

    const fromAppointment = resolve(
      { dob: dob(30), scheme_code: women.code },
      { patient_category: made.pensioner.code },
    );
    expect(
      fromAppointment.source === "appointment" &&
        fromAppointment.category?.display_label === `Smoke CGHS ${tag} › Pensioner`,
      "a patient recorded as Pensioner did not resolve to CGHS › Pensioner",
    );
    const fromPatient = resolve({ dob: dob(30), scheme_code: women.code });
    expect(
      fromPatient.source === "patient" && fromPatient.category?.code === women.code,
      "the patient's recorded category did not win",
    );
    const fromRule = resolve({ dob: dob(70), scheme_ref: "CARD-1" });
    expect(
      fromRule.source === "rule" && fromRule.category?.code === made.pensioner.code,
      "the automatic 60+ card rule did not choose Pensioner",
    );
    const general = resolve({ dob: dob(30) });
    expect(
      general.source === "general" && general.category === null,
      "a patient nothing matches is not General",
    );
  });

  await check("7. every floor screen charges the same price for every active test", async () => {
    const reception = await getTestCatalog(client);
    const doctorAndMo = await testPricesFor(
      reception.map((t) => t.name),
      null,
      client,
    );
    const machine = Object.fromEntries(
      (await machineOptions([], client)).tests.map((t) => [t.testName, t.price]),
    );
    const disagree = reception.filter(
      (t) =>
        Number(doctorAndMo[t.name]) !== t.price ||
        (t.category === "machine" && Number(machine[t.name]) !== t.price),
    );
    expect(
      disagree.length === 0,
      `${disagree.length} test(s) priced differently on different screens, e.g. ${disagree
        .slice(0, 3)
        .map(
          (t) =>
            `${t.name}: reception ${t.price}, doctor/MO ${doctorAndMo[t.name]}${t.category === "machine" ? `, machine ${machine[t.name]}` : ""}`,
        )
        .join("; ")}`,
    );
    expect(
      reception.find((t) => t.name === `Smoke Test ${tag}`)?.price === 250,
      "the smoke test's price is wrong",
    );

    const { rows: moved } = await client.query(
      `SELECT c.test_name, c.price::float AS catalogue, i.base_price::float AS item, i.code
         FROM giniflow_test_catalog c
         JOIN service_items i ON i.test_catalog_id = c.id AND i.is_active
        WHERE c.is_active AND i.base_price <> c.price
        ORDER BY c.test_name`,
    );
    if (moved.length) {
      notes.push(
        `${moved.length} test(s) now bill at their item's price, not the old catalogue price:`,
        ...moved.map(
          (r) => `    ${r.test_name}: catalogue ₹${r.catalogue} → item ${r.code} ₹${r.item}`,
        ),
      );
    } else {
      notes.push("Every test with an item bills at its old catalogue price.");
    }

    const item = await items.createItem(
      {
        code: code("LAB"),
        name: "Smoke lab test",
        subgroup_id: made.subgroup.id,
        base_price: 275,
        kind: "test",
        test_catalog_id: catalogueTest.id,
      },
      ctx,
      client,
    );
    track("service_items", item.id);
    const after = await getTestCatalog(client);
    expect(
      after.find((t) => t.name === `Smoke Test ${tag}`)?.price === 275,
      "a test with an active item is not priced from the item on the floor",
    );
  });
}

const host = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL || "");
    return `${url.hostname}:${url.port || 5432}${url.pathname}`;
  } catch {
    return "unknown";
  }
})();
console.log(`Billing master-data smoke — ${host} — everything is rolled back\n`);

const client = await pool.connect();
let failed = false;
try {
  await client.query("BEGIN");
  await run(client);
} catch (error) {
  results.push({ name: "setup", ok: false, error: error.message });
} finally {
  await client.query("ROLLBACK");
  client.release();
}

await check("8. everything ran inside a transaction that was rolled back", async () => {
  const byEntity = (entity) => created.filter(([e]) => e === entity).map(([, id]) => id);
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM service_groups WHERE id::text = ANY($1))::int AS groups,
            (SELECT count(*) FROM service_subgroups WHERE id::text = ANY($2))::int AS subgroups,
            (SELECT count(*) FROM service_items WHERE id::text = ANY($3))::int AS items,
            (SELECT count(*) FROM service_item_price_history
              WHERE service_item_id::text = ANY($3))::int AS price_history,
            (SELECT count(*) FROM tax_codes WHERE id::text = ANY($4))::int AS tax_codes,
            (SELECT count(*) FROM patient_schemes WHERE code = ANY($5))::int AS categories,
            (SELECT count(*) FROM category_rules WHERE id::text = ANY($6))::int AS rules,
            (SELECT count(*) FROM category_item_rates WHERE scheme_code = ANY($5))::int AS rates,
            (SELECT count(*) FROM giniflow_test_catalog WHERE test_name = $7)::int AS tests,
            (SELECT count(*) FROM doctors WHERE name = $8)::int AS doctors,
            (SELECT count(*) FROM billing_audit a
              JOIN unnest($9::text[], $10::text[]) AS c(entity, entity_id)
                ON a.entity = c.entity AND a.entity_id = c.entity_id)::int AS audit`,
    [
      byEntity("service_groups"),
      byEntity("service_subgroups"),
      byEntity("service_items"),
      byEntity("tax_codes"),
      byEntity("patient_schemes"),
      byEntity("category_rules"),
      `Smoke Test ${tag}`,
      `Dr Smoke ${tag}`,
      created.map(([entity]) => entity),
      created.map(([, id]) => id),
    ],
  );
  expect(created.length > 10, `only ${created.length} created rows were tracked`);
  const left = Object.entries(rows[0]).filter(([, n]) => n > 0);
  expect(
    left.length === 0,
    `left behind: ${left.map(([table, n]) => `${n} in ${table}`).join(", ")}`,
  );
});

for (const note of notes) console.log(`ℹ ${note}`);
if (notes.length) console.log("");
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n    ${r.error}`}`);
  if (!r.ok) failed = true;
}
console.log(
  `\n${failed ? "FAILED" : "ALL OK"} (${results.filter((r) => r.ok).length}/${results.length})`,
);
await pool.end();
process.exit(failed ? 1 : 0);
