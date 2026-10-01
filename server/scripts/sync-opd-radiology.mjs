import "../loadEnv.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../config/db.js";
import { createGroup, createSubgroup } from "../services/billing/serviceGroups.js";
import { createItem, updateItem } from "../services/billing/serviceItems.js";

const APPLY = process.argv.includes("--apply");
const here = path.dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(fs.readFileSync(path.join(here, "opd-radiology-plan.json")));
const ctx = {};
const GROUP = { code: "RAD", name: "Radiology" };
const SUBGROUPS = [
  ["RAD-XRAY", "X-Ray"],
  ["RAD-USG", "Ultrasound & Doppler"],
  ["RAD-CT", "CT"],
  ["RAD-MRI", "MRI"],
  ["RAD-NUCLEAR", "Nuclear Medicine"],
  ["RAD-CARDIAC", "Cardiac"],
  ["RAD-OTHER", "Other"],
];

const log = (...parts) => console.log(APPLY ? "" : "[dry]", ...parts);

const one = async (sql, params) => (await pool.query(sql, params)).rows[0] ?? null;

function codeFor(name, taken) {
  const base = `RAD-${name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`.slice(0, 40);
  let code = base;
  for (let n = 2; taken.has(code); n += 1) code = `${base.slice(0, 37)}-${n}`;
  taken.add(code);
  return code;
}

async function raiseTmt() {
  const tmt = await one(`SELECT id, base_price FROM service_items WHERE code = 'MAC-TMT'`);
  if (Number(tmt.base_price) === 1800) return;
  if (APPLY) {
    await updateItem(
      tmt.id,
      { base_price: 1800, reason: "Synced from OPD Billing Master Radiology sheet" },
      ctx,
    );
  }
  log("price MAC-TMT", Number(tmt.base_price), "→ 1800");
}

async function run() {
  await raiseTmt();
  let group = await one(`SELECT id FROM service_groups WHERE code = $1`, [GROUP.code]);
  if (!group && APPLY) group = await createGroup({ ...GROUP, sort_order: 30 }, ctx);
  log("group", GROUP.name, group ? `(id ${group.id})` : "(new)");

  const subs = new Map();
  for (const [index, [code, name]] of SUBGROUPS.entries()) {
    let sub = group
      ? await one(`SELECT id FROM service_subgroups WHERE group_id = $1 AND name = $2`, [
          group.id,
          name,
        ])
      : null;
    if (!sub && APPLY)
      sub = await createSubgroup({ group_id: group.id, code, name, sort_order: index + 1 }, ctx);
    subs.set(name, sub?.id ?? null);
    log("subgroup", name);
  }

  const taken = new Set(
    (await pool.query(`SELECT code FROM service_items`)).rows.map((r) => r.code.toUpperCase()),
  );
  for (const row of rows) {
    const subgroupId = subs.get(row.sub);
    const existing = subgroupId
      ? await one(
          `SELECT id FROM service_items WHERE subgroup_id = $1 AND lower(name) = lower($2)`,
          [subgroupId, row.name],
        )
      : null;
    if (existing) {
      log("exists", row.name);
      continue;
    }
    const input = {
      code: codeFor(row.name, taken),
      name: row.name,
      kind: row.kind,
      subgroup_id: subgroupId,
      base_price: row.price,
    };
    if (APPLY) await createItem(input, ctx);
    log("create", input.code, `"${row.name}"`, `₹${row.price}`, row.sub);
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
