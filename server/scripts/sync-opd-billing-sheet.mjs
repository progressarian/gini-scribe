import "../loadEnv.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../config/db.js";
import { createItem, updateItem } from "../services/billing/serviceItems.js";
import { addCatalogTest } from "../services/giniflow/testCatalog.js";
import { FLAT } from "../services/giniflow/labCatalog.js";

const APPLY = process.argv.includes("--apply");
const here = path.dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(fs.readFileSync(path.join(here, "opd-billing-sheet-plan.json")));
const ctx = {};
const PATHOLOGY_GROUP = "Pathology";

const flat = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
const log = (...parts) => console.log(APPLY ? "" : "[dry]", ...parts);

async function subgroupIds() {
  const { rows } = await pool.query(
    `SELECT s.id, s.name FROM service_subgroups s
       JOIN service_groups g ON g.id = s.group_id
      WHERE g.name = $1`,
    [PATHOLOGY_GROUP],
  );
  return new Map(rows.map((row) => [row.name, row.id]));
}

async function takenCodes() {
  const { rows } = await pool.query(`SELECT code FROM service_items`);
  return new Set(rows.map((row) => row.code.toUpperCase()));
}

function codeFor(name, taken) {
  const base = `LAB-${name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`.slice(0, 40);
  let code = base;
  for (let n = 2; taken.has(code); n += 1) code = `${base.slice(0, 37)}-${n}`;
  taken.add(code);
  return code;
}

async function existingItems(names) {
  const { rows } = await pool.query(
    `SELECT DISTINCT i.id, i.code, i.name, i.is_active, i.is_outsourced
       FROM service_items i
       LEFT JOIN giniflow_test_catalog c ON c.id = i.test_catalog_id
       LEFT JOIN service_item_aliases a ON a.service_item_id = i.id
      WHERE ${FLAT("i.name")} = ANY($1)
         OR ${FLAT("c.test_name")} = ANY($1)
         OR a.flat_name = ANY($1)
      ORDER BY i.id`,
    [names.map(flat)],
  );
  return rows;
}

async function catalogId(name) {
  const { rows } = await pool.query(
    `SELECT id FROM giniflow_test_catalog WHERE upper(test_name) = upper($1)`,
    [name],
  );
  return rows[0].id;
}

async function markOutsourced(item) {
  if (APPLY) await updateItem(item.id, { is_outsourced: true }, ctx);
  log("outsourced", item.code, `"${item.name}"`);
}

async function create(row, subs, taken) {
  const subgroupId = subs.get(row.sub);
  if (!subgroupId) throw new Error(`No "${row.sub}" subgroup under ${PATHOLOGY_GROUP}`);
  const input = {
    code: codeFor(row.name, taken),
    name: row.name,
    kind: row.kind,
    subgroup_id: subgroupId,
    base_price: row.price,
    is_outsourced: row.outsourced,
  };
  if (APPLY) {
    if (row.kind === "test") {
      await addCatalogTest(row.name, { category: "lab" });
      input.test_catalog_id = await catalogId(row.name);
    }
    await createItem(input, ctx);
  }
  log(
    "create",
    row.kind,
    input.code,
    `"${row.name}"`,
    `₹${row.price}`,
    row.sub,
    row.outsourced ? "OUT" : "",
  );
}

async function matchAll() {
  const matched = [];
  const owner = new Map();
  const clashes = [];
  for (const row of plan.rows) {
    const items = await existingItems(row.names);
    for (const item of items) {
      if (owner.has(item.id))
        clashes.push(`"${row.name}" and "${owner.get(item.id)}" → ${item.code}`);
      else owner.set(item.id, row.name);
    }
    const outIds = new Set((await existingItems(row.out_names)).map((item) => item.id));
    matched.push({ row, items, outIds });
  }
  if (clashes.length) {
    throw new Error(`Sheet rows match the same Scribe item:\n  ${clashes.join("\n  ")}`);
  }
  return matched;
}

async function run() {
  const matched = await matchAll();
  const subs = await subgroupIds();
  const taken = await takenCodes();
  const tally = { unchanged: 0, outsourced: 0, created: 0, switchedOff: 0 };

  for (const { row, items, outIds } of matched) {
    if (!items.length) {
      await create(row, subs, taken);
      tally.created += 1;
      continue;
    }
    const active = items.filter((item) => item.is_active);
    if (!active.length) {
      log(
        "exists but switched off, left alone",
        `"${row.name}"`,
        items.map((i) => i.code),
      );
      tally.switchedOff += 1;
      continue;
    }
    if (active.length > 1) {
      log(
        "matches several items",
        `"${row.name}"`,
        active.map((i) => i.code),
      );
    }
    const toFlag = active.filter((item) => outIds.has(item.id) && !item.is_outsourced);
    for (const item of toFlag) await markOutsourced(item);
    tally[toFlag.length ? "outsourced" : "unchanged"] += 1;
  }
  console.log(tally);
}

try {
  await run();
  console.log(APPLY ? "SYNC APPLIED" : "DRY RUN OK — rerun with --apply");
} catch (error) {
  console.error("STOPPED:", error.status ?? "", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
