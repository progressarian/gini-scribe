import "../loadEnv.js";
import pool from "../config/db.js";
import { catalogTestsFor } from "../services/billing/testMatch.js";
import { addAlias } from "../services/billing/serviceItemAliases.js";

const apply = process.argv.includes("--apply");
const pairs = process.argv.slice(2).filter((arg) => arg !== "--apply");
const ctx = { actorId: null };

const target = new URL(process.env.DATABASE_URL);
console.log(`Database: ${target.hostname}:${target.port}${target.pathname}`);
console.log(apply ? "Mode: APPLY — changes will be saved\n" : "Mode: dry run — nothing is saved\n");

function parse(arg) {
  const at = arg.lastIndexOf("=");
  const name = at > 0 ? arg.slice(0, at).trim() : "";
  const code = at > 0 ? arg.slice(at + 1).trim() : "";
  if (!name || !code) throw new Error(`"${arg}" is not NAME=CODE`);
  return { name, code };
}

async function resolvesTo(client, names) {
  const matches = await catalogTestsFor(client, names);
  const ids = [...new Set([...matches.values()].filter(Boolean))];
  const { rows } = await client.query(
    `SELECT c.id, c.test_name, i.code, i.base_price, i.is_active
       FROM giniflow_test_catalog c
       LEFT JOIN service_items i ON i.test_catalog_id = c.id
      WHERE c.id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return new Map(
    names.map((name) => {
      const test = byId.get(matches.get(name));
      if (!test) return [name, "no lab test — not priced"];
      if (!test.code) return [name, `lab test "${test.test_name}" — no service, not priced`];
      if (!test.is_active) {
        return [name, `lab test "${test.test_name}" — ${test.code} is deactivated, not priced`];
      }
      return [name, `lab test "${test.test_name}" — ${test.code} ₹${Number(test.base_price)}`];
    }),
  );
}

async function itemByCode(client, code) {
  const { rows } = await client.query(
    `SELECT i.id, i.code, i.name, i.kind, i.is_active, i.base_price, c.test_name
       FROM service_items i LEFT JOIN giniflow_test_catalog c ON c.id = i.test_catalog_id
      WHERE lower(i.code) = lower($1)`,
    [code],
  );
  return rows[0] ?? null;
}

async function run(client, wanted) {
  const plan = { link: [], blockers: [] };
  const before = await resolvesTo(
    client,
    wanted.map((pair) => pair.name),
  );
  for (const { name, code } of wanted) {
    console.log(`${name}\n  now: ${before.get(name)}`);
    const item = await itemByCode(client, code);
    if (!item) {
      plan.blockers.push(`${name}: no service has the code ${code}`);
      continue;
    }
    if (!item.is_active) plan.blockers.push(`${name}: ${item.code} is deactivated`);
    try {
      await addAlias(item.id, { name }, ctx, client);
      plan.link.push(
        `${name} → ${item.code} — ${item.name} ₹${Number(item.base_price)} (lab test "${item.test_name}")`,
      );
    } catch (error) {
      plan.blockers.push(`${name}: ${error.message}`);
    }
  }
  const after = await resolvesTo(
    client,
    wanted.map((pair) => pair.name),
  );
  console.log("\nAfter linking:");
  wanted.forEach(({ name }) => console.log(`  ${name}: ${after.get(name)}`));
  return plan;
}

const client = await pool.connect();
let exitCode = 0;
try {
  if (!pairs.length) {
    throw new Error('Usage: node scripts/link-ordered-names.mjs "NAME=CODE" ... [--apply]');
  }
  const wanted = pairs.map(parse);
  await client.query("BEGIN");
  const plan = await run(client, wanted);
  console.log(`\nLink: ${plan.link.length}`);
  plan.link.forEach((line) => console.log(`  ${line}`));
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
