import { test, expect } from "@playwright/test";
import {
  HAS_COMMENTS,
  REFUSED,
  SEEDS_ROWS,
  allowedValuesOf,
  columnsOf,
  indexesOf,
  lockdownOf,
  openFreshCopy,
  readMigration,
  tablesCreatedBy,
} from "../../helpers/migration.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { IMPORT_SHEETS } from "../../../server/services/billing/importColumns.js";

const SQL = readMigration("2026-10-21_billing_import_sessions.sql");
const SESSIONS = "billing_import_sessions";
const ROWS = "billing_import_rows";

const SESSION_COLUMNS = [
  "id",
  "file_name",
  "file",
  "uploaded_by",
  "uploaded_at",
  "expires_at",
  "status",
  "counts",
  "import_id",
  "committed_by",
  "committed_at",
  "row_state",
];

const ROW_COLUMNS = [
  "id",
  "session_id",
  "sheet",
  "row_no",
  "row_key",
  "label",
  "status",
  "decision",
  "reason",
  "errors",
  "warnings",
  "values",
  "input",
  "before",
  "changes",
  "depends_on",
  "outcome",
  "session_state",
];

let db = null;
let importId = null;

const addSession = async (o = {}) =>
  (
    await db.client.query(
      `INSERT INTO billing_import_sessions (file_name, file, uploaded_by, expires_at)
       VALUES ($1, $2, $3, NOW() + interval '24 hours') RETURNING id`,
      [o.name ?? "prices.xlsx", o.file ?? Buffer.from("xlsx"), o.by ?? USERS.admin.id],
    )
  ).rows[0].id;

const ROW_SQL = `INSERT INTO billing_import_rows
  (session_id, sheet, row_no, row_key, status, decision, reason, errors, "values", input, before,
   changes, depends_on, outcome)
  VALUES ($1, COALESCE($2, 'Items'), COALESCE($3, 2), COALESCE($4, 'LAB-1'), COALESCE($5, 'ready'),
          $6, $7, $8::jsonb, '{}'::jsonb, '{}'::jsonb, $9::jsonb, $10::jsonb, $11, $12)
  RETURNING id`;

const row = (session, o = {}) => [
  session,
  o.sheet ?? null,
  o.row ?? null,
  o.key ?? null,
  o.status ?? null,
  o.decision ?? null,
  o.reason ?? null,
  o.errors ? JSON.stringify(o.errors) : null,
  o.before ? JSON.stringify(o.before) : null,
  o.changes ? JSON.stringify(o.changes) : null,
  o.dependsOn ?? null,
  o.outcome ?? null,
];

const FAILED = { reason: "Bad price", errors: [{ column: "base_price", message: "Bad price" }] };
const OVERRIDE = {
  status: "override",
  decision: "pending",
  before: { base_price: 100 },
  changes: [{ column: "base_price", from: 100, to: 150 }],
};

async function immediately(statements) {
  await db.client.query("SAVEPOINT immediate");
  try {
    for (const [sql, params] of statements) await db.client.query(sql, params);
    await db.client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.client.query("RELEASE SAVEPOINT immediate");
    return null;
  } catch (error) {
    await db.client.query("ROLLBACK TO SAVEPOINT immediate");
    return error.code ?? "unknown";
  } finally {
    await db.client.query("SET CONSTRAINTS ALL DEFERRED");
  }
}

test.describe.serial("P2b-01 migration: import sessions", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
    importId = (
      await db.client.query(
        `INSERT INTO billing_imports (file_name, imported_by, status) VALUES ('p2b01.xlsx', $1, 'saved')
         RETURNING id`,
        [USERS.admin.id],
      )
    ).rows[0].id;
  });

  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file creates both tables, inserts no rows and has no comments", () => {
    expect(tablesCreatedBy(SQL)).toEqual([SESSIONS, ROWS]);
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. it runs twice and both tables have exactly the planned columns", async () => {
    expect(await columnsOf(db.client, SESSIONS)).toEqual([...SESSION_COLUMNS].sort());
    expect(await columnsOf(db.client, ROWS)).toEqual([...ROW_COLUMNS].sort());
  });

  test("3. statuses, decisions, outcomes and sheets are the planned lists", async () => {
    expect(await allowedValuesOf(db.client, SESSIONS, "status")).toEqual(
      ["abandoned", "committed", "open"].sort(),
    );
    expect(await allowedValuesOf(db.client, ROWS, "status")).toEqual(
      ["failed", "override", "ready", "unchanged"].sort(),
    );
    expect(await allowedValuesOf(db.client, ROWS, "decision")).toEqual(
      ["keep", "override", "pending"].sort(),
    );
    expect(await allowedValuesOf(db.client, ROWS, "outcome")).toEqual(
      ["failed", "kept", "saved", "unchanged"].sort(),
    );
    expect(await allowedValuesOf(db.client, ROWS, "sheet")).toEqual(
      IMPORT_SHEETS.map((s) => s.name).sort(),
    );
  });

  test("4. a session needs a name, an uploader, an expiry after the upload, and a file while it lives", async () => {
    const add = `INSERT INTO billing_import_sessions (file_name, file, uploaded_by, uploaded_at, expires_at, status)
                 VALUES ($1, $2, $3, NOW(), $4, COALESCE($5, 'open'))`;
    const later = new Date(Date.now() + 3600e3);
    expect(await db.refused(add, [" ", Buffer.from("x"), USERS.admin.id, later, null])).toBe(
      REFUSED.rule,
    );
    expect(await db.refused(add, ["a.xlsx", Buffer.from("x"), null, later, null])).toBe("23502");
    expect(await db.refused(add, ["a.xlsx", Buffer.from("x"), 987654321, later, null])).toBe(
      REFUSED.missingParent,
    );
    expect(
      await db.refused(add, ["a.xlsx", Buffer.from("x"), USERS.admin.id, new Date(0), null]),
    ).toBe(REFUSED.rule);
    expect(await db.refused(add, ["a.xlsx", null, USERS.admin.id, later, null])).toBe(REFUSED.rule);
    expect(await db.refused(add, ["a.xlsx", Buffer.alloc(0), USERS.admin.id, later, null])).toBe(
      REFUSED.rule,
    );
    expect(
      await db.refused(add, ["a.xlsx", Buffer.from("x"), USERS.admin.id, later, "abandoned"]),
    ).toBe(REFUSED.rule);
    expect(await db.refused(add, ["a.xlsx", null, USERS.admin.id, later, "abandoned"])).toBeNull();
    expect(
      await db.refused(add, ["a.xlsx", Buffer.from("x"), USERS.admin.id, later, null]),
    ).toBeNull();
  });

  test("5. committed means linked to its import, by someone, at a time — and only then", async () => {
    const session = await addSession();
    const commit = `UPDATE billing_import_sessions SET status = $2, import_id = $3, committed_by = $4,
                    committed_at = $5 WHERE id = $1`;
    const now = new Date(Date.now() + 1000);
    expect(await db.refused(commit, [session, "committed", null, null, null])).toBe(REFUSED.rule);
    expect(await db.refused(commit, [session, "committed", importId, null, now])).toBe(
      REFUSED.rule,
    );
    expect(await db.refused(commit, [session, "open", importId, USERS.admin.id, now])).toBe(
      REFUSED.rule,
    );
    expect(await db.refused(commit, [session, "committed", 987654321, USERS.admin.id, now])).toBe(
      REFUSED.missingParent,
    );
    expect(
      await db.refused(commit, [session, "committed", importId, USERS.admin.id, new Date(0)]),
    ).toBe(REFUSED.rule);
    expect(
      await db.refused(commit, [session, "committed", importId, USERS.admin.id, now]),
    ).toBeNull();
    const other = await addSession();
    expect(await db.refused(commit, [other, "committed", importId, USERS.admin.id, now])).toBe(
      REFUSED.duplicate,
    );
  });

  test("6. a decision only on a row that needs an override, which also carries before and changes", async () => {
    const s = await addSession();
    expect(await db.refused(ROW_SQL, row(s, { decision: "pending" }))).toBe(REFUSED.rule);
    expect(await db.refused(ROW_SQL, row(s, { ...OVERRIDE, decision: null }))).toBe(REFUSED.rule);
    expect(await db.refused(ROW_SQL, row(s, { ...OVERRIDE, before: null }))).toBe(REFUSED.rule);
    expect(await db.refused(ROW_SQL, row(s, { ...OVERRIDE, changes: [] }))).toBe(REFUSED.rule);
    expect(await db.refused(ROW_SQL, row(s, { row: 3, changes: [{ column: "name" }] }))).toBe(
      REFUSED.rule,
    );
    expect(await db.refused(ROW_SQL, row(s, { ...OVERRIDE, decision: "maybe" }))).toBe(
      REFUSED.rule,
    );
    expect(await db.refused(ROW_SQL, row(s, OVERRIDE))).toBeNull();
    expect(await db.refused(ROW_SQL, row(s, OVERRIDE))).toBe(REFUSED.duplicate);
  });

  test("7. a failed row has its reason and errors; no other row has one", async () => {
    const s = await addSession();
    expect(await db.refused(ROW_SQL, row(s, { status: "failed" }))).toBe(REFUSED.rule);
    expect(await db.refused(ROW_SQL, row(s, { status: "failed", reason: "x", errors: null }))).toBe(
      REFUSED.rule,
    );
    expect(
      await db.refused(ROW_SQL, row(s, { status: "failed", reason: " ", errors: FAILED.errors })),
    ).toBe(REFUSED.rule);
    expect(await db.refused(ROW_SQL, row(s, { status: "ready", ...FAILED }))).toBe(REFUSED.rule);
    expect(
      await db.refused(ROW_SQL, row(s, { row: 2, status: "failed", key: " ", ...FAILED })),
    ).toBeNull();
    expect(await db.refused(ROW_SQL, row(s, { row: 3, key: " " }))).toBe(REFUSED.rule);
  });

  test("8. a row depends only on a row of its own session, and only when it failed", async () => {
    const s = await addSession();
    const other = await addSession();
    const parent = (await db.client.query(ROW_SQL, row(s, { status: "failed", ...FAILED }))).rows[0]
      .id;
    const stranger = (await db.client.query(ROW_SQL, row(other, { status: "failed", ...FAILED })))
      .rows[0].id;
    expect(await db.refused(ROW_SQL, row(s, { row: 3, dependsOn: parent }))).toBe(REFUSED.rule);
    expect(
      await db.refused(
        ROW_SQL,
        row(s, { row: 4, status: "failed", ...FAILED, dependsOn: stranger }),
      ),
    ).toBe(REFUSED.missingParent);
    expect(
      await db.refused(ROW_SQL, row(s, { row: 5, status: "failed", ...FAILED, dependsOn: parent })),
    ).toBeNull();
  });

  test("9. an outcome only once the session is committed, and then on every row", async () => {
    const s = await addSession();
    const r = (await db.client.query(ROW_SQL, row(s))).rows[0].id;
    expect(
      await immediately([[`UPDATE billing_import_rows SET outcome = 'saved' WHERE id = $1`, [r]]]),
    ).toBe("23503");
    const imp = (
      await db.client.query(
        `INSERT INTO billing_imports (file_name, imported_by, status) VALUES ('p2b01b.xlsx', $1, 'saved')
         RETURNING id`,
        [USERS.admin.id],
      )
    ).rows[0].id;
    const commit = [
      `UPDATE billing_import_sessions SET status = 'committed', import_id = $2, committed_by = $3,
              committed_at = NOW() + interval '1 second' WHERE id = $1`,
      [s, imp, USERS.admin.id],
    ];
    expect(await immediately([commit])).toBe("23503");
    expect(
      await immediately([
        commit,
        [`UPDATE billing_import_rows SET outcome = 'saved' WHERE id = $1`, [r]],
      ]),
    ).toBeNull();
  });

  test("10. the outcome fits the row: kept only for an undecided or kept change, never for a failed row", async () => {
    const s = await addSession();
    const imp = (
      await db.client.query(
        `INSERT INTO billing_imports (file_name, imported_by, status) VALUES ('p2b01c.xlsx', $1, 'saved')
         RETURNING id`,
        [USERS.admin.id],
      )
    ).rows[0].id;
    await db.client.query(
      `UPDATE billing_import_sessions SET status = 'committed', import_id = $2, committed_by = $3,
              committed_at = NOW() + interval '1 second' WHERE id = $1`,
      [s, imp, USERS.admin.id],
    );
    let n = 1;
    const tryRow = (o) => db.refused(ROW_SQL, row(s, { row: (n += 1), ...o }));
    expect(await tryRow({ outcome: "kept" })).toBe(REFUSED.rule);
    expect(await tryRow({ outcome: "saved" })).toBeNull();
    expect(await tryRow({ ...OVERRIDE, outcome: "kept" })).toBeNull();
    expect(await tryRow({ ...OVERRIDE, outcome: "saved" })).toBe(REFUSED.rule);
    expect(await tryRow({ ...OVERRIDE, decision: "keep", outcome: "kept" })).toBeNull();
    expect(await tryRow({ ...OVERRIDE, decision: "override", outcome: "kept" })).toBe(REFUSED.rule);
    expect(await tryRow({ ...OVERRIDE, decision: "override", outcome: "saved" })).toBeNull();
    expect(await tryRow({ status: "unchanged", outcome: "saved" })).toBe(REFUSED.rule);
    expect(await tryRow({ status: "failed", ...FAILED, outcome: "saved" })).toBe(REFUSED.rule);
    expect(await tryRow({ status: "failed", ...FAILED, outcome: "failed" })).toBeNull();
    expect(await tryRow({ outcome: "failed" })).toBe(REFUSED.rule);
    expect(await tryRow({ outcome: "failed", ...FAILED })).toBeNull();
  });

  test("11. an abandoned session can't keep rows; deleting a session deletes its rows", async () => {
    const s = await addSession();
    await db.client.query(ROW_SQL, row(s));
    expect(
      await immediately([
        [`UPDATE billing_import_sessions SET status = 'abandoned', file = NULL WHERE id = $1`, [s]],
      ]),
    ).toBe("23503");
    await db.client.query(`DELETE FROM billing_import_sessions WHERE id = $1`, [s]);
    const { rows } = await db.client.query(
      `SELECT count(*)::int AS n FROM billing_import_rows WHERE session_id = $1`,
      [s],
    );
    expect(rows[0].n).toBe(0);
    expect(await db.refused(`DELETE FROM billing_imports WHERE id = $1`, [importId])).toBe(
      REFUSED.stillUsed,
    );
  });

  test("12. the list, the dependency and the stale-session lookups are indexed", async () => {
    const indexes = await indexesOf(db.client, [SESSIONS, ROWS]);
    expect(indexes.billing_import_rows_list_idx).toMatch(/\(session_id, status, sheet, row_no\)/);
    expect(indexes.billing_import_rows_row_key).toMatch(
      /UNIQUE INDEX .*\(session_id, sheet, row_no\)/,
    );
    expect(indexes.billing_import_rows_depends_on_idx).toMatch(/\(session_id, depends_on\)/);
    expect(indexes.billing_import_sessions_stale_idx).toMatch(
      /\(expires_at\) WHERE \(status <> 'committed'::text\)/,
    );
    expect(indexes.billing_import_sessions_import_id_key).toMatch(/UNIQUE INDEX .*\(import_id\)/);
  });

  test("13. RLS is on and forced, and anon/authenticated have no access", async () => {
    const { rls, publicGrants } = await lockdownOf(db.client, [SESSIONS, ROWS]);
    expect(rls.sort((a, b) => a.relname.localeCompare(b.relname))).toEqual([
      { relname: ROWS, relrowsecurity: true, relforcerowsecurity: true },
      { relname: SESSIONS, relrowsecurity: true, relforcerowsecurity: true },
    ]);
    expect(publicGrants).toEqual([]);
  });
});
