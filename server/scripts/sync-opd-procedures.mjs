import "../loadEnv.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../config/db.js";
import { createGroup, createSubgroup } from "../services/billing/serviceGroups.js";
import { createItem } from "../services/billing/serviceItems.js";

const APPLY = process.argv.includes("--apply");
const here = path.dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(fs.readFileSync(path.join(here, "opd-procedures-plan.json")));
const ctx = {};
const GROUP = { code: "OPDPROC", name: "OPD Procedures (CGHS list)" };

const one = async (sql, params) => (await pool.query(sql, params)).rows[0] ?? null;
const slug = (text) =>
  text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

async function run() {
  let group = await one(`SELECT id FROM service_groups WHERE code = $1`, [GROUP.code]);
  if (!group && APPLY) group = await createGroup({ ...GROUP, sort_order: 60 }, ctx);
  console.log(APPLY ? "" : "[dry]", "group", GROUP.name, group ? `(id ${group.id})` : "(new)");

  const subs = new Map();
  const names = [...new Set(rows.map((row) => row.sub))];
  for (const [index, name] of names.entries()) {
    let sub = group
      ? await one(`SELECT id FROM service_subgroups WHERE group_id = $1 AND name = $2`, [
          group.id,
          name,
        ])
      : null;
    if (!sub && APPLY) {
      sub = await createSubgroup(
        { group_id: group.id, code: `OPD-${slug(name)}`, name, sort_order: index + 1 },
        ctx,
      );
    }
    subs.set(name, sub?.id ?? null);
  }
  console.log(APPLY ? "" : "[dry]", "subgroups", names.length);

  const taken = new Set(
    (await pool.query(`SELECT upper(code) AS code FROM service_items`)).rows.map((r) => r.code),
  );
  let created = 0;
  let existing = 0;
  for (const row of rows) {
    const code = `OPD-${row.sheet_code}`;
    if (taken.has(code.toUpperCase())) {
      existing += 1;
      continue;
    }
    if (APPLY) {
      await createItem(
        {
          code,
          name: row.name,
          kind: "procedure",
          subgroup_id: subs.get(row.sub),
          base_price: 0,
          price_per_patient: true,
        },
        ctx,
      );
    }
    created += 1;
  }
  console.log(APPLY ? "" : "[dry]", "items to create", created, "· already there", existing);
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
