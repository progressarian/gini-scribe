import "../loadEnv.js";
import { readFileSync } from "node:fs";
import pool from "../config/db.js";
import { createGroup, createSubgroup } from "../services/billing/serviceGroups.js";
import { createItem } from "../services/billing/serviceItems.js";

const DATA = "gini-machine-services-2026-09.json";
const apply = process.argv.includes("--apply");
const ctx = { actorId: null };
const data = JSON.parse(readFileSync(new URL(`./data/${DATA}`, import.meta.url)));

const target = new URL(process.env.DATABASE_URL);
console.log(`Database: ${target.hostname}:${target.port}${target.pathname}`);
console.log(apply ? "Mode: APPLY — changes will be saved\n" : "Mode: dry run — nothing is saved\n");

async function groupId(client, plan) {
  const { rows } = await client.query(
    `SELECT id, code, name, is_active FROM service_groups WHERE lower(code) = lower($1)`,
    [data.group.code],
  );
  if (rows.length) {
    if (!rows[0].is_active) plan.blockers.push(`group ${rows[0].code} is deactivated`);
    plan.notes.push(`Group: using existing ${rows[0].code} — ${rows[0].name}`);
    return rows[0].id;
  }
  plan.notes.push(`Group: create ${data.group.code} — ${data.group.name}`);
  return (await createGroup({ ...data.group, sort_order: 30 }, ctx, client)).id;
}

async function subgroupIds(client, parentId, plan) {
  const ids = new Map();
  for (const [index, subgroup] of data.subgroups.entries()) {
    const { rows } = await client.query(
      `SELECT id, code, group_id, is_active FROM service_subgroups WHERE lower(code) = lower($1)`,
      [subgroup.code],
    );
    if (rows.length) {
      if (rows[0].group_id !== parentId) {
        plan.blockers.push(`subgroup ${rows[0].code} is under another group`);
      } else if (!rows[0].is_active) {
        plan.blockers.push(`subgroup ${rows[0].code} is deactivated`);
      }
      ids.set(subgroup.code, rows[0].id);
      continue;
    }
    const created = await createSubgroup(
      { group_id: parentId, ...subgroup, sort_order: (index + 1) * 10 },
      ctx,
      client,
    );
    plan.notes.push(`Subgroup: create ${subgroup.code} — ${subgroup.name}`);
    ids.set(subgroup.code, created.id);
  }
  return ids;
}

async function run(client) {
  const plan = { blockers: [], notes: [], create: [], same: [] };
  const parentId = await groupId(client, plan);
  const subgroups = await subgroupIds(client, parentId, plan);
  for (const row of data.items) {
    const { rows: tests } = await client.query(
      `SELECT c.id, c.test_name, c.price, c.category, c.is_active,
              i.code AS item_code, i.base_price
         FROM giniflow_test_catalog c
         LEFT JOIN service_items i ON i.test_catalog_id = c.id
        WHERE c.test_name = $1`,
      [row.catalog_name],
    );
    const test = tests[0];
    if (!test) {
      plan.blockers.push(`${row.code}: no lab test is named "${row.catalog_name}"`);
      continue;
    }
    if (test.item_code) {
      plan.same.push(
        `${row.code}: "${test.test_name}" already has service ${test.item_code} ₹${Number(test.base_price)}`,
      );
      continue;
    }
    if (!test.is_active) {
      plan.blockers.push(`${row.code}: "${test.test_name}" is retired in the test list`);
      continue;
    }
    const { rows: clash } = await client.query(
      `SELECT code FROM service_items WHERE lower(code) = lower($1)`,
      [row.code],
    );
    if (clash.length) {
      plan.blockers.push(`${row.code}: a service with this code already exists`);
      continue;
    }
    await createItem(
      {
        code: row.code,
        name: row.name,
        subgroup_id: subgroups.get(row.subgroup),
        base_price: Number(test.price),
        kind: "test",
        test_catalog_id: test.id,
      },
      ctx,
      client,
    );
    plan.create.push(
      `${row.code} — ${row.name} ₹${Number(test.price)} (today's reception price) in ${row.subgroup}, linked to "${test.test_name}" [${test.category}]`,
    );
  }
  return plan;
}

const client = await pool.connect();
let exitCode = 0;
try {
  await client.query("BEGIN");
  const plan = await run(client);
  plan.notes.forEach((note) => console.log(note));
  console.log(`\nNew services: ${plan.create.length}`);
  plan.create.forEach((line) => console.log(`  ${line}`));
  console.log(`\nAlready have a service: ${plan.same.length}`);
  plan.same.forEach((line) => console.log(`  ${line}`));
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
