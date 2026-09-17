import "../loadEnv.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../config/db.js";
import { collectTestList, writeTestList } from "../services/billing/testListExport.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const target =
  process.argv[2] ?? path.resolve(here, "..", "..", "docs", "gini-flow", "billing-test-list.xlsx");

const dbHost = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL);
    return `${url.hostname}:${url.port}${url.pathname}`;
  } catch {
    return "unknown";
  }
})();

try {
  console.log(`Reading tests (read-only) from ${dbHost}`);
  const rows = await collectTestList(pool);
  await writeTestList(rows, target);
  const byGroup = rows.reduce(
    (acc, r) => ({ ...acc, [r.suggested_group]: (acc[r.suggested_group] ?? 0) + 1 }),
    {},
  );
  const unpriced = rows.filter((r) => r.current_price == null || r.note).length;
  console.log(`Wrote ${rows.length} tests to ${path.relative(process.cwd(), target)}`);
  console.log(`By group: ${JSON.stringify(byGroup)}`);
  console.log(`Need a price or a real price: ${unpriced}`);
} catch (error) {
  console.error(`Export failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
