import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import {
  AUDIT_COLUMNS,
  REFUSED,
  HAS_COMMENTS,
  SEEDS_ROWS,
  columnsOf,
  indexesOf,
  lockdownOf,
  openFreshCopy,
  readMigration,
} from "../../helpers/migration.mjs";

const SQL = readMigration("2026-10-08_billing_service_master.sql");
const TABLES = ["service_groups", "service_subgroups"];
const COLUMNS = {
  service_groups: ["id", "code", "name", "sort_order", "is_active", ...AUDIT_COLUMNS],
  service_subgroups: [
    "id",
    "group_id",
    "code",
    "name",
    "sort_order",
    "is_active",
    ...AUDIT_COLUMNS,
  ],
};

let db = null;

test.describe.serial("P1-04 migration: service groups and subgroups", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
  });
  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file inserts no rows and has no comments", () => {
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. it runs twice on fresh tables without error", async () => {
    for (const table of TABLES) {
      const { rows } = await db.client.query(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
      expect(rows[0].t, table).toBe(table);
    }
  });

  test("3. the tables have exactly the planned columns", async () => {
    for (const table of TABLES) {
      expect(await columnsOf(db.client, table), table).toEqual([...COLUMNS[table]].sort());
    }
  });

  test("4. codes are unique ignoring case, and subgroups are indexed by group", async () => {
    const indexes = await indexesOf(db.client, TABLES);
    expect(indexes.service_groups_code_key).toMatch(/UNIQUE INDEX .*lower\(code\)/);
    expect(indexes.service_subgroups_code_key).toMatch(/UNIQUE INDEX .*lower\(code\)/);
    expect(indexes.service_subgroups_group_id_idx).toMatch(/\(group_id\)/);
  });

  test("5. RLS is on and forced, and anon/authenticated have no access", async () => {
    const { rls, publicGrants } = await lockdownOf(db.client, TABLES);
    expect(rls).toHaveLength(TABLES.length);
    for (const row of rls) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
    expect(publicGrants).toEqual([]);
  });

  test("6. no business rows exist after the migration", async () => {
    for (const table of TABLES) {
      const { rows } = await db.client.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });

  test("7. the rules hold: blank or spaced codes, case duplicates and orphans are refused", async () => {
    const { client, refused } = db;
    const group = await client.query(
      `INSERT INTO service_groups (code, name) VALUES ('G1', 'Group one') RETURNING id`,
    );
    const groupId = group.rows[0].id;
    const addGroup = `INSERT INTO service_groups (code, name) VALUES ($1, $2)`;
    expect(await refused(addGroup, ["g1", "Dup"])).toBe(REFUSED.duplicate);
    expect(await refused(addGroup, ["G 2", "Space"])).toBe(REFUSED.rule);
    expect(await refused(addGroup, ["", "Empty"])).toBe(REFUSED.rule);
    expect(await refused(addGroup, ["G3", "  "])).toBe(REFUSED.rule);
    const addSub = `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $3)`;
    expect(await refused(addSub, [-1, "S0", "Orphan"])).toBe(REFUSED.missingParent);
    expect(await refused(addSub, [groupId, "S1", "Sub one"])).toBeNull();
    expect(await refused(addSub, [groupId, "s1", "Dup"])).toBe(REFUSED.duplicate);
    expect(await refused(`DELETE FROM service_groups WHERE id = $1`, [groupId])).toBe(
      REFUSED.stillUsed,
    );
    const row = await client.query(
      `SELECT sort_order, is_active, created_at IS NOT NULL AS stamped FROM service_groups WHERE id = $1`,
      [groupId],
    );
    expect(row.rows[0]).toEqual({ sort_order: 0, is_active: true, stamped: true });
  });

  test("8. the test database was built with this migration applied", async () => {
    for (const table of TABLES) {
      const row = await one(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
      expect(row.t, table).toBe(table);
    }
  });
});
