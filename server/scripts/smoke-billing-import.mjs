import "../loadEnv.js";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { isLabOnlyDoctor } from "../../shared/labOnly.js";

const target = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL || "");
    return { host: `${url.hostname}:${url.port || 5432}`, name: url.pathname.slice(1) };
  } catch {
    return { host: "unknown", name: "" };
  }
})();
console.log(`Billing import smoke — ${target.host}/${target.name} — everything is rolled back\n`);
if (!/test/i.test(target.name) && process.env.SMOKE_ANY_DATABASE !== "1") {
  console.log(
    `Refused: ${target.name || "this database"} is not a test database. Point DATABASE_URL at one, or set SMOKE_ANY_DATABASE=1 if you really mean to run it here.`,
  );
  process.exit(2);
}

const { default: pool } = await import("../config/db.js");
const { templateBuffer } = await import("../services/billing/importTemplate.js");
const { commitUpload } = await import("../services/billing/importCommit.js");
const { previewUpload } = await import("../services/billing/importPreview.js");

const tag = crypto.randomBytes(3).toString("hex");
const code = (name) => `SMOKE_${name}_${tag}`.toUpperCase();
const category = (name) => `smoke_${name}_${tag}`;
const fileName = (name) => `smoke-${name}-${tag}.xlsx`;
const results = [];
const notes = [];
const importIds = [];

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function check(name, work) {
  try {
    await work();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

const SAVEPOINT = {
  BEGIN: "SAVEPOINT smoke_import",
  COMMIT: "RELEASE SAVEPOINT smoke_import",
  ROLLBACK: "ROLLBACK TO SAVEPOINT smoke_import",
};

const insideOuter = (client) => {
  const query = (text, ...rest) =>
    client.query(typeof text === "string" ? (SAVEPOINT[text.trim()] ?? text) : text, ...rest);
  return { connect: async () => ({ query, release: () => {} }), query };
};

async function workbook(sheets) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await templateBuffer());
  for (const [sheetName, rows] of Object.entries(sheets)) {
    const ws = book.getWorksheet(sheetName);
    const columns = {};
    ws.getRow(1).eachCell((cell, col) => {
      columns[cell.text] = col;
    });
    rows.forEach((values, i) => {
      const row = ws.getRow(i + 2);
      for (const [column, value] of Object.entries(values)) {
        expect(columns[column], `the template's ${sheetName} sheet has no ${column} column`);
        row.getCell(columns[column]).value = value;
      }
    });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function pickRows(client) {
  const { rows: admins } = await client.query(
    `SELECT id FROM doctors WHERE is_active ORDER BY (role = 'admin') DESC, id LIMIT 1`,
  );
  expect(admins.length, "the database has no active doctor to import as");
  const { rows: consultants } = await client.query(
    `SELECT d.id, d.name FROM doctors d
      WHERE d.is_active AND d.role = 'consultant'
        AND NOT EXISTS (SELECT 1 FROM service_items i
                         WHERE i.doctor_id = d.id AND i.kind = 'consultation'
                           AND i.visit_type = 'New' AND i.is_active)
      ORDER BY d.id`,
  );
  const consultant = consultants.find((d) => !isLabOnlyDoctor(d.name));
  const { rows: tests } = await client.query(
    `SELECT c.id, c.test_name FROM giniflow_test_catalog c
      WHERE c.is_active
        AND NOT EXISTS (SELECT 1 FROM service_items i WHERE i.test_catalog_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM giniflow_test_catalog o
                         WHERE o.id <> c.id AND lower(btrim(o.test_name)) = lower(btrim(c.test_name)))
      ORDER BY c.test_name LIMIT 1`,
  );
  if (!consultant) notes.push("No active consultant without a New fee; the fee row is skipped.");
  if (!tests.length)
    notes.push("No active catalogue test without an item; the test row is skipped.");
  return { actorId: admins[0].id, consultant, test: tests[0] };
}

function goodSheets({ consultant, test }) {
  const cghs = category("cghs");
  const items = [
    {
      item_code: code("DRESS"),
      name: `Smoke dressing ${tag}`,
      subgroup_code: code("PROC"),
      base_price: 200,
      kind: "procedure",
    },
  ];
  if (consultant) {
    items.push({
      item_code: code("FEE"),
      name: `Smoke consultation ${tag}`,
      subgroup_code: code("OPD"),
      base_price: 900,
      kind: "consultation",
      doctor: String(consultant.id),
      visit_type: "New",
    });
  }
  if (test) {
    items.push({
      item_code: code("TEST"),
      name: `Smoke ${test.test_name}`,
      subgroup_code: code("PROC"),
      base_price: 350,
      kind: "test",
      test_name: test.test_name,
    });
  }
  return {
    Groups: [{ group_code: code("G"), name: `Smoke group ${tag}`, sort_order: 90 }],
    Subgroups: [
      { subgroup_code: code("PROC"), group_code: code("G"), name: "Smoke procedures" },
      { subgroup_code: code("OPD"), group_code: code("G"), name: "Smoke consultations" },
    ],
    Items: items,
    Categories: [
      {
        category_code: cghs,
        label: `Smoke CGHS ${tag}`,
        payer_name: "Smoke payer",
        requires_ref: "yes",
      },
      { category_code: category("paid"), label: "Paid", parent_code: cghs },
      {
        category_code: category("ref"),
        label: "Referral",
        parent_code: cghs,
        requires_referral: "yes",
      },
      { category_code: category("pen"), label: "Pensioner", parent_code: cghs },
    ],
    "Category rules": [
      {
        category_code: category("pen"),
        rule_name: "Smoke card 60+",
        min_age: 60,
        requires_card: "yes",
        mode: "suggest",
      },
    ],
    "Category rates": [
      {
        category_code: cghs,
        item_code: code("DRESS"),
        valid_from: "2026-10-01",
        rate: 150,
        bill_code: `SM${tag}`.toUpperCase(),
      },
    ],
  };
}

const TAGGED = `(SELECT count(*) FROM service_groups WHERE code ILIKE '%' || $1)::int AS groups,
  (SELECT count(*) FROM service_subgroups WHERE code ILIKE '%' || $1)::int AS subgroups,
  (SELECT count(*) FROM service_items WHERE code ILIKE '%' || $1)::int AS items,
  (SELECT count(*) FROM service_item_price_history h JOIN service_items i ON i.id = h.service_item_id
    WHERE i.code ILIKE '%' || $1)::int AS price_history,
  (SELECT count(*) FROM patient_schemes WHERE code LIKE '%' || $1)::int AS categories,
  (SELECT count(*) FROM category_rules WHERE scheme_code LIKE '%' || $1)::int AS rules,
  (SELECT count(*) FROM category_item_rates WHERE scheme_code LIKE '%' || $1)::int AS rates,
  (SELECT count(*) FROM billing_imports WHERE file_name LIKE '%' || $1 || '.xlsx')::int AS imports,
  (SELECT count(*) FROM billing_audit WHERE import_id = ANY($2::bigint[])
     OR entity_id ILIKE '%' || $1)::int AS audit`;

const tagged = async (db) => (await db.query(`SELECT ${TAGGED}`, [tag, importIds])).rows[0];

const sheetCounts = (preview) =>
  Object.fromEntries(preview.sheets.filter((s) => !s.later).map((s) => [s.name, s.counts]));

async function run(client) {
  const picked = await pickRows(client);
  const ctx = { actorId: picked.actorId, ip: null };
  const db = insideOuter(client);
  const sheets = goodSheets(picked);
  const good = await workbook(sheets);
  const expected = Object.fromEntries(
    Object.entries(sheets).map(([name, rows]) => [name, rows.length]),
  );
  const total = Object.values(expected).reduce((a, b) => a + b, 0);

  await check("1. a good file (CGHS with three sub-categories) imports every row", async () => {
    const preview = await previewUpload(good, db);
    expect(
      preview.canImport,
      `the preview refuses the good file: ${JSON.stringify(preview.problems)}`,
    );
    const result = await commitUpload(good, { fileName: fileName("good"), ctx }, db);
    expect(result.saved === true, "the good file was not saved");
    importIds.push(result.importId);
    const counts = sheetCounts(result.preview);
    for (const [name, n] of Object.entries(expected)) {
      expect(
        counts[name]?.new === n && counts[name].error === 0,
        `${name}: expected ${n} new, got ${JSON.stringify(counts[name])}`,
      );
    }
    const found = await tagged(client);
    expect(
      found.groups === 1 &&
        found.subgroups === 2 &&
        found.items === expected.Items &&
        found.categories === 4 &&
        found.rules === 1 &&
        found.rates === 1 &&
        found.imports === 1,
      `the rows are not all in the tables: ${JSON.stringify(found)}`,
    );
    const { rows: subs } = await client.query(
      `SELECT label FROM patient_schemes WHERE parent_code = $1 ORDER BY label`,
      [category("cghs")],
    );
    expect(
      subs.map((s) => s.label).join(",") === "Paid,Pensioner,Referral",
      `CGHS has sub-categories ${subs.map((s) => s.label).join(", ")}`,
    );
    const { rows: linked } = await client.query(
      `SELECT i.status, i.imported_by, i.counts,
              (SELECT count(*) FROM billing_audit a WHERE a.import_id = i.id)::int AS audit
         FROM billing_imports i WHERE i.id = $1`,
      [result.importId],
    );
    expect(linked[0]?.status === "saved", "the billing_imports row is missing or not saved");
    expect(linked[0].imported_by === ctx.actorId, "the import does not name who imported it");
    expect(linked[0].counts.Items?.new === expected.Items, "the import's counts are wrong");
    expect(
      linked[0].audit >= total + 1,
      `only ${linked[0].audit} audit rows carry the import id (expected at least ${total + 1})`,
    );
    if (picked.consultant) {
      const { rows } = await client.query(`SELECT doctor_id FROM service_items WHERE code = $1`, [
        code("FEE"),
      ]);
      expect(
        rows[0]?.doctor_id === picked.consultant.id,
        "the consultation fee is not the doctor's",
      );
    }
    if (picked.test) {
      const { rows } = await client.query(
        `SELECT test_catalog_id FROM service_items WHERE code = $1`,
        [code("TEST")],
      );
      expect(
        rows[0]?.test_catalog_id === picked.test.id,
        "the test item is not linked to its test",
      );
    }
  });

  await check("2. the same file again is all unchanged and saves nothing", async () => {
    const before = await tagged(client);
    const result = await commitUpload(good, { fileName: fileName("again"), ctx }, db);
    expect(result.saved === false, "the repeat upload was saved");
    const { counts } = result.preview;
    expect(
      counts.new === 0 && counts.update === 0 && counts.error === 0 && counts.unchanged === total,
      `expected ${total} unchanged, got ${JSON.stringify(counts)}`,
    );
    const after = await tagged(client);
    expect(
      JSON.stringify(before) === JSON.stringify(after),
      "the repeat upload changed the tables",
    );
  });

  await check("3. a file with one bad row imports nothing", async () => {
    const bad = await workbook({
      Groups: [{ group_code: code("G2"), name: `Smoke group two ${tag}` }],
      Subgroups: [{ subgroup_code: code("SUB2"), group_code: code("G2"), name: "Smoke two" }],
      Items: [
        {
          item_code: code("OK2"),
          name: "Smoke fine",
          subgroup_code: code("SUB2"),
          base_price: 10,
          kind: "other",
        },
        {
          item_code: code("BAD2"),
          name: "Smoke broken",
          subgroup_code: code("SUB2"),
          base_price: "₹1,200",
          kind: "other",
        },
      ],
      Categories: [{ category_code: category("two"), label: `Smoke two ${tag}` }],
    });
    const before = await tagged(client);
    const preview = await previewUpload(bad, db);
    expect(!preview.canImport && preview.counts.error === 1, "the preview does not show one error");
    const result = await commitUpload(bad, { fileName: fileName("bad"), ctx }, db);
    expect(result.saved === false, "the file with a bad row was saved");
    expect(
      result.preview.counts.error === 1,
      `expected 1 error row, got ${result.preview.counts.error}`,
    );
    const after = await tagged(client);
    expect(JSON.stringify(before) === JSON.stringify(after), "the bad file changed the tables");
  });

  await check("4. other sessions never see the import before it is rolled back", async () => {
    const outside = await tagged(pool);
    const left = Object.entries(outside).filter(([, n]) => n > 0);
    expect(
      left.length === 0,
      `visible outside the transaction: ${left.map(([t, n]) => `${n} in ${t}`).join(", ")}`,
    );
  });
}

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

await check("5. everything ran inside a transaction that was rolled back", async () => {
  expect(importIds.length === 1, `expected 1 saved import, got ${importIds.length}`);
  const left = Object.entries(await tagged(pool)).filter(([, n]) => n > 0);
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
