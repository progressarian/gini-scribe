import "../loadEnv.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../config/db.js";
import {
  collectConsultantList,
  writeConsultantList,
} from "../services/billing/consultantListExport.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const target =
  process.argv[2] ??
  path.resolve(here, "..", "..", "docs", "gini-flow", "billing-consultant-list.xlsx");

const dbHost = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL);
    return `${url.hostname}:${url.port}${url.pathname}`;
  } catch {
    return "unknown";
  }
})();

try {
  console.log(`Reading doctors (read-only) from ${dbHost}`);
  const list = await collectConsultantList(pool);
  await writeConsultantList(list, target);
  const consultantCount = new Set(list.consultants.map((r) => r.doctor_id)).size;
  const consulting = list.others.filter((r) => !r.lab_only && r.past + r.upcoming > 0).length;
  const unmatchedCount = list.unmatched.reduce((sum, r) => sum + r.past, 0);
  console.log(
    `Wrote ${consultantCount} consultants (${list.consultants.length} rows) to ${path.relative(process.cwd(), target)}`,
  );
  console.log(`Other active staff: ${list.others.length} (${consulting} with recent appointments)`);
  console.log(
    `Appointments whose doctor name matched nobody (last 90 days): ${unmatchedCount} across ${list.unmatched.length} names`,
  );
} catch (error) {
  console.error(`Export failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
