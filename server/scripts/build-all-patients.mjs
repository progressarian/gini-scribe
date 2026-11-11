import "../loadEnv.js";
import fs from "node:fs/promises";
import path from "node:path";
import { buildAllPatients } from "../services/analytics/allPatients.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};

const outDir = path.resolve(arg("out", "reports/dm-outcomes"));
const dm = JSON.parse(await fs.readFile(path.join(outDir, "dm-outcomes.json"), "utf8"));
const { cronPool } = await import("../config/db.js");

const readOnly = {
  query: async (sql, params) => {
    const client = await cronPool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '30s'");
      return await client.query(sql, params);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  },
};

try {
  const report = await buildAllPatients(readOnly, dm.meta.period, {
    diabetesCount: dm.funnel.registry,
    log: (line) => console.log(`  ${line}`),
  });
  const file = path.join(outDir, "all-patients.json");
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  console.log(`Built in ${(report.meta.build_ms / 1000).toFixed(1)}s -> ${file}`);
} catch (error) {
  console.error(`Stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cronPool.end();
}
