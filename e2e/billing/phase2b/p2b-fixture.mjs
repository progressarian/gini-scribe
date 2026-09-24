import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { getPool, query } from "../../helpers/db.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { templateBuffer } from "../../../server/services/billing/importTemplate.js";
import { assertTestDatabase } from "../../setup/guard.mjs";

assertTestDatabase(process.env.DATABASE_URL);
const { commitUpload } = await import("../../../server/services/billing/importCommit.js");
export const sessions = await import("../../../server/services/billing/importSessions.js");

const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

export const db = getPool();
export const admin = { actorId: USERS.admin.id, ip: "127.0.0.1", role: "admin" };
export const recAdmin = {
  actorId: USERS.reception_admin.id,
  ip: "127.0.0.1",
  role: "reception_admin",
};

export function newTag(prefix) {
  const tag = crypto.randomBytes(3).toString("hex");
  const T = tag.toUpperCase();
  return { tag, T, P: `${prefix}${T}`, p: `${prefix.toLowerCase()}${tag}` };
}

export async function workbook(sheets) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await templateBuffer({ examples: false }));
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.getWorksheet(name);
    const headers = ws.getRow(1).values.slice(1);
    for (const cells of rows) ws.addRow(headers.map((h) => cells[h] ?? null));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function seed(sheets, fileName) {
  const result = await commitUpload(
    await workbook(sheets),
    { fileName, ctx: admin, options: { canChangeDailyCap: true } },
    getPool(),
  );
  if (!result.saved) {
    const errors = result.preview.sheets.flatMap((s) =>
      s.rows
        .filter((r) => r.errors.length)
        .map((r) => `${s.name} ${r.row}: ${JSON.stringify(r.errors)}`),
    );
    throw new Error(`seed failed: ${[...result.preview.problems, ...errors].join(" | ")}`);
  }
  return result;
}

export async function addDoctor(name) {
  return (
    await query(
      `INSERT INTO doctors (name, role, is_active) VALUES ($1, 'consultant', TRUE) RETURNING id`,
      [name],
    )
  ).rows[0].id;
}

export const upload = async (sheets, fileName, ctx = admin) =>
  sessions.createSession(await workbook(sheets), { fileName, ctx }, getPool());

export async function readWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

export async function rowsOf(sessionId) {
  return (
    await query(
      `SELECT id::int, sheet, row_no, row_key, label, status, decision, outcome, reason, errors,
              before, changes, depends_on::int, warnings
         FROM billing_import_rows WHERE session_id = $1 ORDER BY sheet, row_no`,
      [sessionId],
    )
  ).rows;
}

export const find = (rows, sheet, row) => rows.find((r) => r.sheet === sheet && r.row_no === row);

export async function cleanUp(prefix, lower) {
  const like = `${prefix}%`;
  const low = `${lower}%`;
  await query(`DELETE FROM billing_import_sessions WHERE file_name ILIKE $1`, [`%${lower}%`]);
  await query(`UPDATE discount_rules SET is_active = FALSE WHERE name ILIKE $1`, [like]);
  await query(`DELETE FROM discount_rules WHERE name ILIKE $1`, [like]);
  await query(`DELETE FROM category_payment_rules WHERE scheme_code LIKE $1`, [low]);
  await query(`DELETE FROM category_item_rates WHERE scheme_code LIKE $1`, [low]);
  await query(`DELETE FROM category_rules WHERE scheme_code LIKE $1`, [low]);
  await query(`DELETE FROM patient_schemes WHERE parent_code LIKE $1`, [low]);
  await query(`DELETE FROM patient_schemes WHERE code LIKE $1`, [low]);
  await query(
    `DELETE FROM service_item_price_history WHERE service_item_id IN
       (SELECT id FROM service_items WHERE code ILIKE $1)`,
    [like],
  );
  await query(`DELETE FROM service_items WHERE code ILIKE $1`, [like]);
  await query(`DELETE FROM service_subgroups WHERE code ILIKE $1`, [like]);
  await query(`DELETE FROM service_groups WHERE code ILIKE $1`, [like]);
  await query(`DELETE FROM doctors WHERE name ILIKE $1`, [`Dr ${prefix}%`]);
}
