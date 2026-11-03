import "../loadEnv.js";
import pool from "../config/db.js";
import { writeAudit } from "../services/billing/audit.js";

const APPLY = process.argv.includes("--apply");

const ECHO_CODES = [
  "MAC-ECHO",
  "RAD-2D-ECHO",
  "RAD-FINV-PACKAGE-2D-ECHO",
  "RAD-STRESS-ECHO",
  "OPD-RI001",
  "OPD-RI002",
  "OPD-RI003",
  "OPD-RI004",
  "OPD-RI005",
  "OPD-RI006",
];

const FIELDS = "key, label, item_kinds, group_codes, subgroup_codes, item_ids";

async function idsOf(client, codes) {
  const { rows } = await client.query(
    `SELECT id, code FROM service_items WHERE code = ANY($1) ORDER BY id`,
    [codes],
  );
  const missing = codes.filter((code) => !rows.some((row) => row.code === code));
  if (missing.length) throw new Error(`Items not found: ${missing.join(", ")}`);
  return rows.map((row) => row.id);
}

async function change(client, key, patch) {
  const { rows } = await client.query(
    `SELECT ${FIELDS} FROM billing_mis_columns WHERE key = $1 FOR UPDATE`,
    [key],
  );
  if (!rows.length) throw new Error(`No MIS column ${key}`);
  const before = rows[0];
  const after = { ...before, ...patch };
  await client.query(
    `UPDATE billing_mis_columns
        SET group_codes = $2, subgroup_codes = $3, item_ids = $4::int[], updated_at = NOW()
      WHERE key = $1`,
    [key, after.group_codes, after.subgroup_codes, after.item_ids],
  );
  await writeAudit(client, {
    entity: "billing_mis_columns",
    entityId: key,
    action: "update",
    before,
    after: { ...after, reason: "MIS mapping fixed after review (2026-11-03)" },
    actorId: null,
    ip: null,
  });
  console.log(`${key}:`, JSON.stringify({ before, after }));
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '5s'");
  const { rows: fundus } = await client.query(
    `SELECT item_ids FROM billing_mis_columns WHERE key = 'fundus'`,
  );
  const [oi007] = await idsOf(client, ["OPD-OI007"]);
  await change(client, "fundus", {
    item_ids: fundus[0].item_ids.filter((id) => id !== oi007),
  });
  await change(client, "echo", { group_codes: [], item_ids: await idsOf(client, ECHO_CODES) });
  await change(client, "x_ray", { group_codes: [], subgroup_codes: ["rad-xray"] });
  if (APPLY) {
    await client.query("COMMIT");
    console.log("APPLIED");
  } else {
    await client.query("ROLLBACK");
    console.log("DRY RUN — rolled back. Run with --apply to write.");
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("FAILED, nothing written:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
