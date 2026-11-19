import "../loadEnv.js";
import pool from "../config/db.js";
import { deleteRate, saveRate } from "../services/billing/categoryRates.js";
import { indiaToday } from "../services/billing/categoryResolver.js";

const SCHEME = "cghs";
const ITEM_CODES = ["LAB-C-PEPTIDE", "OPD-LB167"];
const NEW_RATE = 600;

const apply = process.argv.includes("--apply");
const revert = process.argv.includes("--revert");
const ctx = { actorId: null };
const today = indiaToday();

const target = new URL(process.env.DATABASE_URL);
console.log(`Database: ${target.hostname}:${target.port}${target.pathname}`);
console.log(apply ? "Mode: APPLY — changes will be saved\n" : "Mode: dry run — nothing is saved\n");

async function currentRates(client) {
  const { rows } = await client.query(
    `SELECT i.id AS item_id, i.code AS item_code, i.name AS item_name, r.rate, r.bill_name,
            r.bill_code, r.valid_from::text AS valid_from, r.valid_to::text AS valid_to
       FROM service_items i
       LEFT JOIN LATERAL (
         SELECT * FROM category_item_rates r
          WHERE r.scheme_code = $1 AND r.service_item_id = i.id
            AND r.valid_from <= $3::date AND (r.valid_to IS NULL OR r.valid_to >= $3::date)
          ORDER BY r.valid_from DESC LIMIT 1
       ) r ON TRUE
      WHERE i.code = ANY($2::text[])
      ORDER BY i.id`,
    [SCHEME, ITEM_CODES, today],
  );
  return rows;
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await currentRates(client);
    const missing = ITEM_CODES.filter((code) => !rows.some((row) => row.item_code === code));
    if (missing.length) throw new Error(`Items not found: ${missing.join(", ")}`);

    let changed = 0;
    for (const row of rows) {
      if (revert) {
        if (row.valid_from !== today || Number(row.rate) !== NEW_RATE) {
          console.log(
            `skip  ${row.item_code} ${row.item_name}: no ₹${NEW_RATE} rate from ${today}`,
          );
          continue;
        }
        const result = await deleteRate(
          {
            scheme_code: SCHEME,
            service_item_id: row.item_id,
            valid_from: today,
            reopen_previous: true,
          },
          ctx,
          client,
        );
        changed += 1;
        console.log(
          `undo  ${row.item_code} ${row.item_name}: ₹${NEW_RATE} removed → ₹${result.reopened.rate} (from ${result.reopened.valid_from}) reopened`,
        );
        continue;
      }
      if (row.rate !== null && Number(row.rate) === NEW_RATE) {
        console.log(`skip  ${row.item_code} ${row.item_name}: already ₹${NEW_RATE}`);
        continue;
      }
      const result = await saveRate(
        {
          scheme_code: SCHEME,
          service_item_id: row.item_id,
          valid_from: today,
          rate: NEW_RATE,
          bill_name: row.bill_name,
          bill_code: row.bill_code,
        },
        ctx,
        client,
      );
      changed += 1;
      const was =
        row.rate === null ? "no CGHS rate" : `₹${Number(row.rate)} (from ${row.valid_from})`;
      console.log(
        `set   ${row.item_code} ${row.item_name}: ${was} → ₹${result.rate.rate} from ${result.rate.valid_from}; closed ${result.closed.length} old rate(s)`,
      );
    }

    if (apply) {
      await client.query("COMMIT");
      console.log(`\nSaved: ${changed} rate(s) changed.`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\nDry run: ${changed} rate(s) would change. Rerun with --apply to save.`);
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

run()
  .catch((error) => {
    console.error(`Stopped: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
