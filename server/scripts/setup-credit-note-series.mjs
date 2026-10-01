import "../loadEnv.js";
import pool from "../config/db.js";
import { financialYear, listSeries, saveSeries } from "../services/billing/billSeries.js";

const apply = process.argv.includes("--apply");
const prefixArg = process.argv.find((arg) => arg.startsWith("--prefix="));
const fyArg = process.argv.find((arg) => arg.startsWith("--fy="));
const fy = fyArg ? fyArg.slice("--fy=".length) : financialYear();

const target = new URL(process.env.DATABASE_URL);
console.log(`Database: ${target.hostname}:${target.port}${target.pathname}`);
console.log(`Financial year: ${fy}\n`);

try {
  const rows = await listSeries();
  console.log("Number series now:");
  if (!rows.length) console.log("  none");
  rows.forEach((row) =>
    console.log(
      `  ${row.fy} · ${row.series}: prefix "${row.prefix ?? ""}", ${row.number_width} digits, next ${row.next_no}`,
    ),
  );
  const existing = rows.find((row) => row.series === "CN" && row.fy === fy);
  if (existing) {
    console.log(`\nThe Credit notes (CN) series for ${fy} is already set up. Nothing to do.`);
  } else if (!apply) {
    console.log(
      `\nNo Credit notes (CN) series for ${fy}. Re-run with --apply --prefix=<prefix> to add it.`,
    );
  } else {
    if (!prefixArg) throw new Error("Give the prefix, e.g. --prefix=CN/26-27/");
    const saved = await saveSeries(
      {
        series: "CN",
        fy,
        prefix: prefixArg.slice("--prefix=".length),
        number_width: 6,
        next_no: 1,
      },
      { actorId: null },
    );
    console.log(
      `\nSaved: ${saved.fy} · CN prefix "${saved.prefix}", ${saved.number_width} digits, next ${saved.next_no}`,
    );
  }
} catch (error) {
  console.error(`\nFailed, nothing saved: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
