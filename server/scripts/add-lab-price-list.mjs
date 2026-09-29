import "../loadEnv.js";
import { readFileSync } from "node:fs";
import pool from "../config/db.js";
import { catalogTestsFor } from "../services/billing/testMatch.js";
import { createGroup, createSubgroup } from "../services/billing/serviceGroups.js";
import { createItem, updateItem } from "../services/billing/serviceItems.js";

const LIST = "gini-lab-price-list-2026-09.json";
const GROUP = { code: "LAB", name: "Lab" };
const NEW_SUBGROUPS = {
  "lab-sero": { code: "LAB-SERO", name: "Serology", sort_order: 30 },
  "lab-horm": { code: "LAB-HORM", name: "Hormones", sort_order: 40 },
  "lab-urine": { code: "LAB-URINE", name: "Urine tests", sort_order: 50 },
};
const PRICE_REASON = "GINI lab price list (2026-09)";
const CATALOG_SOURCE = "gini_lab_price_list_2026_09";

const apply = process.argv.includes("--apply");
const ctx = { actorId: null };
const rows = JSON.parse(readFileSync(new URL(`./data/${LIST}`, import.meta.url)));
const flat = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
const rupees = (value) => `₹${Number(value)}`;

const target = new URL(process.env.DATABASE_URL);
console.log(`Database: ${target.hostname}:${target.port}${target.pathname}`);
console.log(apply ? "Mode: APPLY — changes will be saved\n" : "Mode: dry run — nothing is saved\n");

async function findOrCreateGroup(client, plan) {
  const { rows: found } = await client.query(
    `SELECT id, code, name, is_active FROM service_groups WHERE lower(code) = lower($1)`,
    [GROUP.code],
  );
  if (found.length) {
    if (!found[0].is_active) plan.blockers.push(`group ${found[0].code} is deactivated`);
    plan.notes.push(`Group: using existing ${found[0].code} — ${found[0].name}`);
    return found[0].id;
  }
  const created = await createGroup({ ...GROUP, sort_order: 20 }, ctx, client);
  plan.notes.push(`Group: create ${GROUP.code} — ${GROUP.name}`);
  return created.id;
}

async function groupSubgroups(client, groupId) {
  const { rows: found } = await client.query(
    `SELECT s.code, s.name, s.is_active, COUNT(i.id)::int AS items
       FROM service_subgroups s LEFT JOIN service_items i ON i.subgroup_id = s.id
      WHERE s.group_id = $1
      GROUP BY s.id ORDER BY s.sort_order, s.code`,
    [groupId],
  );
  return found.map(
    (row) =>
      `${row.code} — ${row.name} (${row.items} item${row.items === 1 ? "" : "s"})${row.is_active ? "" : " (deactivated)"}`,
  );
}

function subgroupFinder(client, groupId, plan) {
  const found = new Map();
  return async (code) => {
    const key = code.toLowerCase();
    if (found.has(key)) return found.get(key);
    const { rows: existing } = await client.query(
      `SELECT s.id, s.code, s.is_active, s.group_id, g.code AS group_code
         FROM service_subgroups s JOIN service_groups g ON g.id = s.group_id
        WHERE lower(s.code) = $1`,
      [key],
    );
    let id = null;
    if (existing.length) {
      if (existing[0].group_id !== groupId) {
        plan.blockers.push(
          `subgroup ${existing[0].code} is under ${existing[0].group_code}, not ${GROUP.code}`,
        );
      } else if (!existing[0].is_active) {
        plan.blockers.push(`subgroup ${existing[0].code} is deactivated`);
      } else {
        id = existing[0].id;
      }
    } else if (NEW_SUBGROUPS[key]) {
      id = (await createSubgroup({ group_id: groupId, ...NEW_SUBGROUPS[key] }, ctx, client)).id;
      plan.notes.push(`Subgroup: create ${NEW_SUBGROUPS[key].code} — ${NEW_SUBGROUPS[key].name}`);
    } else {
      plan.blockers.push(`subgroup ${code} does not exist`);
    }
    found.set(key, id);
    return id;
  };
}

async function unlinkedTests(client, claimed) {
  const { rows: found } = await client.query(
    `SELECT c.test_name, c.category, c.price, i.code AS item_code, i.base_price
       FROM giniflow_test_catalog c
       LEFT JOIN service_items i ON i.test_catalog_id = c.id AND i.is_active
      WHERE c.is_active AND source IS DISTINCT FROM $2 AND NOT (c.id = ANY($1::uuid[]))
      ORDER BY c.category, c.test_name`,
    [[...claimed.keys()], CATALOG_SOURCE],
  );
  return found.map(
    (row) =>
      `[${row.category}] ${row.test_name} · ${row.item_code ? `${row.item_code} ${rupees(row.base_price)}` : `no service, list price ${rupees(row.price)}`}`,
  );
}

const GENERIC_WORDS = new Set([
  "test",
  "total",
  "serum",
  "with",
  "urine",
  "blood",
  "hormone",
  "ratio",
  "profile",
  "function",
  "rapid",
  "antibodies",
  "igg",
  "igm",
  "min",
]);

async function namedCatalogTest(client, row, plan) {
  const { rows: found } = await client.query(
    `SELECT id, test_name, category, is_active FROM giniflow_test_catalog WHERE test_name = $1`,
    [row.catalog_name],
  );
  if (!found.length) {
    plan.blockers.push(`#${row.sr} ${row.pdf_name}: no lab test is named "${row.catalog_name}"`);
    return null;
  }
  if (!found[0].is_active) {
    await client.query(
      `UPDATE giniflow_test_catalog SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
      [found[0].id],
    );
  }
  return { ...found[0], reactivated: !found[0].is_active, created: false };
}

async function catalogFor(client, row, matches, plan) {
  if (row.catalog_name) return namedCatalogTest(client, row, plan);
  const ids = [...new Set([matches.get(row.pdf_name), matches.get(row.name)].filter(Boolean))];
  if (ids.length > 1) {
    plan.blockers.push(`#${row.sr} ${row.pdf_name}: matches two different lab tests`);
    return null;
  }
  if (ids.length) {
    const { rows: found } = await client.query(
      `SELECT id, test_name, category, is_active FROM giniflow_test_catalog WHERE id = $1`,
      [ids[0]],
    );
    return { ...found[0], created: false };
  }
  const { rows: sameName } = await client.query(
    `SELECT id, test_name, category, is_active FROM giniflow_test_catalog
      WHERE upper(test_name) = upper($1) OR upper(test_name) = upper($2)`,
    [row.name, row.pdf_name],
  );
  if (sameName.length > 1) {
    plan.blockers.push(`#${row.sr} ${row.pdf_name}: two lab tests share this name`);
    return null;
  }
  if (sameName.length) {
    await client.query(
      `UPDATE giniflow_test_catalog SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
      [sameName[0].id],
    );
    return { ...sameName[0], reactivated: !sameName[0].is_active, created: false };
  }
  const { rows: inserted } = await client.query(
    `INSERT INTO giniflow_test_catalog (test_name, price, source, category)
     VALUES ($1, $2, $3, 'lab')
     RETURNING id, test_name, category, is_active`,
    [row.name, row.price, CATALOG_SOURCE],
  );
  return { ...inserted[0], created: true };
}

async function similarTests(client, test) {
  const words = test.test_name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !GENERIC_WORDS.has(word));
  if (!words.length) return [];
  const { rows: found } = await client.query(
    `SELECT test_name, is_active FROM giniflow_test_catalog
      WHERE id <> $1 AND source IS DISTINCT FROM $3 AND lower(test_name) ~ ANY($2::text[])
      ORDER BY test_name LIMIT 6`,
    [test.id, words.map((word) => `\\y${word}`), CATALOG_SOURCE],
  );
  return found.map((row) => `${row.test_name}${row.is_active ? "" : " (inactive)"}`);
}

async function itemFor(client, catalogId) {
  const { rows: found } = await client.query(
    `SELECT i.id, i.code, i.name, i.base_price, i.is_active, s.code AS subgroup_code
       FROM service_items i JOIN service_subgroups s ON s.id = i.subgroup_id
      WHERE i.test_catalog_id = $1`,
    [catalogId],
  );
  return found[0] ?? null;
}

async function clashes(client, row) {
  const { rows: found } = await client.query(
    `SELECT code, name, kind FROM service_items
      WHERE lower(code) = lower($1)
         OR lower(regexp_replace(name, '[^a-zA-Z0-9]+', '', 'g')) = ANY($2::text[])`,
    [row.code, [flat(row.name), flat(row.pdf_name)]],
  );
  return found;
}

async function run(client) {
  const plan = {
    blockers: [],
    notes: [],
    create: [],
    update: [],
    same: [],
    newTests: [],
    subgroups: [],
    unlinked: [],
  };
  const groupId = await findOrCreateGroup(client, plan);
  plan.subgroups = await groupSubgroups(client, groupId);
  const subgroupOf = subgroupFinder(client, groupId, plan);
  const matches = await catalogTestsFor(
    client,
    rows.flatMap((row) => [row.pdf_name, row.name]),
  );
  const claimed = new Map();

  for (const row of rows) {
    const test = await catalogFor(client, row, matches, plan);
    if (!test) continue;
    if (claimed.has(test.id)) {
      plan.blockers.push(
        `#${row.sr} ${row.pdf_name} and #${claimed.get(test.id)} both match lab test "${test.test_name}"`,
      );
      continue;
    }
    claimed.set(test.id, row.sr);
    if (test.category !== "lab") {
      plan.notes.push(
        `#${row.sr} ${row.pdf_name}: lab test "${test.test_name}" is a ${test.category} test`,
      );
    }
    if (test.created) {
      const similar = await similarTests(client, test);
      plan.newTests.push(
        `#${row.sr} ${test.test_name}${similar.length ? `   ⚠ similar already in the list: ${similar.join("; ")}` : ""}`,
      );
    }
    if (test.reactivated) plan.newTests.push(`#${row.sr} ${test.test_name} (reactivated)`);

    const item = await itemFor(client, test.id);
    if (item) {
      if (!item.is_active) {
        plan.blockers.push(`#${row.sr} ${row.pdf_name}: its item ${item.code} is deactivated`);
      } else if (Number(item.base_price) === row.price) {
        plan.same.push(`#${row.sr} ${item.code} — ${item.name} ${rupees(row.price)}`);
      } else {
        await updateItem(item.id, { base_price: row.price, reason: PRICE_REASON }, ctx, client);
        plan.update.push(
          `#${row.sr} ${item.code} — ${item.name}: ${rupees(item.base_price)} → ${rupees(row.price)} (stays in ${item.subgroup_code})`,
        );
      }
      continue;
    }

    const subgroupCode = row.subgroup;
    const subgroupId = await subgroupOf(subgroupCode);
    if (!subgroupId) continue;
    const clash = await clashes(client, row);
    if (clash.length) {
      clash.forEach((other) =>
        plan.blockers.push(
          `#${row.sr} ${row.pdf_name}: item ${other.code} — ${other.name} (${other.kind}) already exists with this code or name`,
        ),
      );
      continue;
    }
    await createItem(
      {
        code: row.code,
        name: row.name,
        subgroup_id: subgroupId,
        base_price: row.price,
        kind: "test",
        test_catalog_id: test.id,
      },
      ctx,
      client,
    );
    plan.create.push(
      `#${row.sr} ${row.code} — ${row.name} ${rupees(row.price)} in ${subgroupCode} (lab test "${test.test_name}")`,
    );
  }
  plan.unlinked = await unlinkedTests(client, claimed);
  return plan;
}

function print(plan) {
  plan.notes.forEach((note) => console.log(note));
  const section = (title, list) => {
    console.log(`\n${title}: ${list.length}`);
    list.forEach((line) => console.log(`  ${line}`));
  };
  section("New lab tests added to the lab's test list", plan.newTests);
  section("New services", plan.create);
  section("Price changed", plan.update);
  section("Already at this price (unchanged)", plan.same);
  section(`Subgroups already under ${GROUP.code} (before this run)`, plan.subgroups);
  section("Lab tests already in the list that no PDF row links to", plan.unlinked);
}

const client = await pool.connect();
let exitCode = 0;
try {
  if (rows.length !== 80) throw new Error(`${LIST} has ${rows.length} rows, expected 80`);
  if (rows.some((row) => !row.subgroup)) throw new Error(`Every row in ${LIST} needs a subgroup`);
  await client.query("BEGIN");
  const plan = await run(client);
  print(plan);
  if (plan.blockers.length) {
    console.log("\nREFUSED — these must be dealt with first (nothing was saved):");
    plan.blockers.forEach((blocker) => console.log(`  - ${blocker}`));
    await client.query("ROLLBACK");
    exitCode = 2;
  } else if (!apply) {
    console.log("\nDry run only. Re-run with --apply to save.");
    await client.query("ROLLBACK");
  } else {
    await client.query("COMMIT");
    console.log("\nSaved.");
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`\nFailed, nothing saved: ${error.message}`);
  exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
process.exit(exitCode);
