import "../loadEnv.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../config/db.js";
import { createSubgroup, updateGroup } from "../services/billing/serviceGroups.js";
import {
  createItem,
  deleteItem,
  setItemActive,
  updateItem,
} from "../services/billing/serviceItems.js";
import { addAlias } from "../services/billing/serviceItemAliases.js";
import { addCatalogTest } from "../services/giniflow/testCatalog.js";

const APPLY = process.argv.includes("--apply");
const here = path.dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(fs.readFileSync(path.join(here, "opd-billing-master-plan.json")));
const ctx = {};
const REASON = "Synced from OPD Billing Master sheet";
const PATHOLOGY_GROUP = 7;
const NEW_SUBGROUPS = [
  ["LAB-TUMOUR", "Tumour Markers"],
  ["LAB-MICRO", "Microbiology"],
  ["LAB-CLIN", "Clinical Pathology"],
  ["LAB-HISTO", "Histopathology"],
  ["LAB-MOLGEN", "Molecular & Genetics"],
  ["LAB-PKG", "Packages"],
  ["LAB-OTHER", "Other Services"],
];

const log = (...parts) => console.log(APPLY ? "" : "[dry]", ...parts);

async function subgroupIds() {
  const { rows } = await pool.query(`SELECT id, name FROM service_subgroups WHERE group_id = $1`, [
    PATHOLOGY_GROUP,
  ]);
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

async function existingItemFor(row, subgroupId) {
  const { rows } = await pool.query(
    `SELECT id FROM service_items WHERE subgroup_id = $1 AND lower(name) = lower($2)`,
    [subgroupId, row.name],
  );
  return rows[0]?.id ?? null;
}

async function catalogConflict(name) {
  const { rows } = await pool.query(
    `SELECT c.test_name, i.code FROM giniflow_test_catalog c
       JOIN service_items i ON i.test_catalog_id = c.id
      WHERE upper(c.test_name) = upper($1)`,
    [name],
  );
  return rows[0] ?? null;
}

async function catalogId(name) {
  const { rows } = await pool.query(
    `SELECT id FROM giniflow_test_catalog WHERE upper(test_name) = upper($1)`,
    [name],
  );
  return rows[0].id;
}

async function alias(itemId, name, label) {
  if (!name) return;
  if (!APPLY) return log("alias", `"${name}" → item ${itemId}`, label);
  try {
    await addAlias(itemId, { name }, ctx);
    log("alias", `"${name}" → item ${itemId}`, label);
  } catch (error) {
    if (error.status !== 409) throw error;
    log("alias skipped", `"${name}":`, error.message);
  }
}

async function run() {
  if (APPLY) await updateGroup(PATHOLOGY_GROUP, { name: "Pathology" }, ctx);
  log("group 7 → Pathology");

  let subs = await subgroupIds();
  for (const [index, [code, name]] of NEW_SUBGROUPS.entries()) {
    if (subs.has(name)) continue;
    if (APPLY) {
      await createSubgroup({ group_id: PATHOLOGY_GROUP, code, name, sort_order: 10 + index }, ctx);
    }
    log("subgroup", name);
  }
  subs = await subgroupIds();
  const subOf = (row) => subs.get(row.sub) ?? (APPLY ? null : -1);

  const itemOfSr = new Map();
  const taken = await takenCodes();

  for (const row of plan.rows.filter((r) => r.action === "update")) {
    const values = { name: row.name, base_price: row.price, subgroup_id: subOf(row) };
    if (APPLY) await updateItem(row.item_id, { ...values, reason: REASON }, ctx);
    log("update", row.code, JSON.stringify(values));
    itemOfSr.set(row.orig_sr, row.item_id);
    if (row.manual) await alias(row.item_id, row.name, "(sheet name)");
    await alias(row.item_id, row.orig_name, "(old spelling)");
  }

  for (const row of plan.rows.filter((r) => r.action === "create")) {
    const subgroupId = subOf(row);
    const already = APPLY ? await existingItemFor(row, subgroupId) : null;
    if (already) {
      log("exists", row.name, "→ item", already);
      itemOfSr.set(row.orig_sr, already);
      continue;
    }
    if (row.kind === "test") {
      const clash = await catalogConflict(row.name);
      if (clash) throw new Error(`"${row.name}" is already the lab test of ${clash.code}`);
    }
    const input = {
      code: codeFor(row.name, taken),
      name: row.name,
      kind: row.kind,
      subgroup_id: subgroupId,
      base_price: row.price,
    };
    if (APPLY) {
      if (row.kind === "test") {
        await addCatalogTest(row.name, { category: "lab" });
        input.test_catalog_id = await catalogId(row.name);
      }
      const item = await createItem(input, ctx);
      itemOfSr.set(row.orig_sr, item.id);
      if (row.kind === "test") await alias(item.id, row.orig_name, "(old spelling)");
    } else {
      itemOfSr.set(row.orig_sr, `new:${input.code}`);
      if (row.orig_name) log("alias", `"${row.orig_name}" → ${input.code}`, "(old spelling)");
    }
    log("create", row.kind, input.code, `"${row.name}"`, `₹${row.price}`, row.sub);
  }

  for (const row of plan.rows.filter((r) => r.action === "alias")) {
    const target = itemOfSr.get(row.target_orig_sr);
    if (!target) throw new Error(`No item for SR ${row.target_orig_sr} to alias "${row.name}"`);
    await alias(target, row.name, "(duplicate row)");
    await alias(target, row.orig_name, "(old spelling)");
  }

  for (const id of plan.remove) {
    if (!APPLY) {
      log("delete item", id);
      continue;
    }
    try {
      await deleteItem(id, ctx);
      log("delete item", id);
    } catch (error) {
      if (error.status !== 409) throw error;
      await setItemActive(id, false, ctx);
      log("switched off item", id, "—", error.message);
    }
  }
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
