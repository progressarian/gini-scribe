import "../loadEnv.js";
import { readFileSync } from "node:fs";
import pool from "../config/db.js";
import { deleteRate, saveRate } from "../services/billing/categoryRates.js";
import { indiaToday } from "../services/billing/categoryResolver.js";

const DATA = "cghs-rates-2026-02.json";
const CATEGORIES = ["cghs", "himachal_govt"];

const apply = process.argv.includes("--apply");
const ctx = { actorId: null };
const data = JSON.parse(readFileSync(new URL(`./data/${DATA}`, import.meta.url)));
const rupees = (value) => (value === null ? "—" : `₹${Number(value)}`);

const target = new URL(process.env.DATABASE_URL);
console.log(`Database: ${target.hostname}:${target.port}${target.pathname}`);
console.log(`Source: ${data.source}`);
console.log(apply ? "Mode: APPLY — changes will be saved\n" : "Mode: dry run — nothing is saved\n");

async function categoriesFor(client, plan) {
  const { rows } = await client.query(
    `SELECT s.code, s.label, s.parent_code, s.is_active, COALESCE(p.label, '') AS parent_label
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = ANY($1::text[]) OR s.parent_code = ANY($1::text[])
      ORDER BY COALESCE(s.parent_code, s.code), s.parent_code NULLS FIRST, s.code`,
    [CATEGORIES],
  );
  for (const code of CATEGORIES) {
    const found = rows.find((row) => row.code === code);
    if (!found) plan.blockers.push(`category "${code}" does not exist`);
    else if (!found.is_active) plan.blockers.push(`category "${code}" is retired`);
    else if (found.parent_code) plan.blockers.push(`category "${code}" is not a top category`);
  }
  return rows;
}

async function existingRates(client, schemes) {
  const { rows } = await client.query(
    `SELECT r.scheme_code, r.service_item_id, r.rate, r.bill_code, r.valid_from::text AS valid_from,
            r.valid_to::text AS valid_to, i.code AS item_code, i.name AS item_name
       FROM category_item_rates r JOIN service_items i ON i.id = r.service_item_id
      WHERE r.scheme_code = ANY($1::text[])
      ORDER BY r.scheme_code, i.code, r.valid_from`,
    [schemes],
  );
  return rows;
}

async function itemsByCode(client) {
  const { rows } = await client.query(
    `SELECT id, code, name, kind, is_active, doctor_id, visit_type FROM service_items`,
  );
  return new Map(rows.map((row) => [row.code.toLowerCase(), row]));
}

async function consultationItems(client) {
  const { rows } = await client.query(
    `SELECT i.id, i.code, i.name FROM service_items i
      WHERE i.kind = 'consultation' AND i.is_active
      ORDER BY i.code`,
  );
  return rows;
}

async function save(client, plan, scheme, item, rate, billName, billCode, note) {
  try {
    await saveRate(
      {
        scheme_code: scheme,
        service_item_id: item.id,
        rate,
        bill_name: billName,
        bill_code: billCode,
        valid_from: indiaToday(),
      },
      ctx,
      client,
    );
    plan.saved.push(
      `${scheme} · ${item.code} — ${item.name}: ${rupees(rate)} as ${billCode} "${billName}"${note ? `  ⚠ ${note}` : ""}`,
    );
  } catch (error) {
    if (/can't be priced/.test(error.message)) {
      plan.skipped.push(`${scheme} · ${item.code}: ${error.message}`);
    } else {
      plan.blockers.push(`${scheme} · ${item.code}: ${error.message}`);
    }
  }
}

async function run(client) {
  const plan = { blockers: [], removed: [], saved: [], skipped: [] };
  const categories = await categoriesFor(client, plan);
  if (plan.blockers.length) return plan;
  const replaced = categories.map((row) => row.code);
  plan.categories = categories.map(
    (row) => `${row.parent_code ? `${row.parent_label} › ` : ""}${row.label} (${row.code})`,
  );

  for (const row of await existingRates(client, replaced)) {
    await deleteRate(
      {
        scheme_code: row.scheme_code,
        service_item_id: row.service_item_id,
        valid_from: row.valid_from,
      },
      ctx,
      client,
    );
    plan.removed.push(
      `${row.scheme_code} · ${row.item_code} — ${row.item_name}: ${rupees(row.rate)}${row.bill_code ? ` ${row.bill_code}` : ""} (${row.valid_from} → ${row.valid_to ?? "open"})`,
    );
  }

  const items = await itemsByCode(client);
  const consultations = await consultationItems(client);
  for (const scheme of CATEGORIES) {
    for (const row of data.rates) {
      const item = items.get(row.item_code.toLowerCase());
      if (!item) {
        plan.blockers.push(`service ${row.item_code} does not exist`);
        continue;
      }
      if (!item.is_active) {
        plan.skipped.push(`${scheme} · ${row.item_code}: the service is deactivated`);
        continue;
      }
      await save(
        client,
        plan,
        scheme,
        item,
        row.rate,
        row.cghs_name,
        row.cghs_code,
        {
          check: "contents differ from Gini's test — check",
          parts: "priced as the CGHS parts added together",
        }[row.match] ?? null,
      );
    }
    for (const item of consultations) {
      await save(
        client,
        plan,
        scheme,
        item,
        data.consultation.rate,
        data.consultation.cghs_name,
        data.consultation.cghs_code,
        null,
      );
    }
  }
  return plan;
}

function print(plan) {
  const section = (title, list) => {
    console.log(`\n${title}: ${list.length}`);
    list.forEach((line) => console.log(`  ${line}`));
  };
  section("Categories replaced (top and sub-categories)", plan.categories ?? []);
  section("Existing rates removed", plan.removed);
  section("New rates", plan.saved);
  section("Skipped", plan.skipped);
  section(
    "Gini services with no CGHS rate (they keep the General price)",
    data.no_cghs_rate.map((row) => `${row.item_code}: ${row.why}`),
  );
}

const client = await pool.connect();
let exitCode = 0;
try {
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
