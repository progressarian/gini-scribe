import pool from "../../config/db.js";
import { wholeNumber } from "./common.js";

export const IMPORT_HISTORY_PAGE_SIZE = 25;
export const IMPORT_HISTORY_PAGE_MAX = 100;

export async function listImports(filters = {}, db = pool) {
  const limit =
    wholeNumber(filters.limit, "Page size", { min: 1, max: IMPORT_HISTORY_PAGE_MAX }) ??
    IMPORT_HISTORY_PAGE_SIZE;
  const offset = wholeNumber(filters.offset, "Offset") ?? 0;
  const { rows } = await db.query(
    `SELECT i.id, i.file_name, i.imported_at, i.status, i.counts,
            i.imported_by, d.name AS imported_by_name,
            count(*) OVER ()::int AS total
       FROM billing_imports i
       LEFT JOIN doctors d ON d.id = i.imported_by
      ORDER BY i.imported_at DESC, i.id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const total =
    rows[0]?.total ??
    (offset ? (await db.query(`SELECT count(*)::int AS n FROM billing_imports`)).rows[0].n : 0);
  return { total, limit, offset, imports: rows.map(({ total, ...row }) => row) };
}
