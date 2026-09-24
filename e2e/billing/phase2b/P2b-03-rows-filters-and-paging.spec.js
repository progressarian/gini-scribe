import { test, expect } from "@playwright/test";
import { query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { cleanUp, db, newTag, seed, sessions, upload } from "./p2b-fixture.mjs";

const { P, p, T } = newTag("P2B03");
const file = (name) => `${p}-${name}.xlsx`;
const PAGE = sessions.ROWS_PAGE_SIZE;
let small = null;
let big = null;

const spy = () => {
  const sizes = [];
  return {
    sizes,
    query: async (...args) => {
      const result = await db.query(...args);
      sizes.push(result.rows.length);
      return result;
    },
  };
};

async function allPages(id, filters, spyDb = db) {
  const seen = [];
  let page = 1;
  for (;;) {
    const result = await sessions.listRows(id, { ...filters, page: String(page) }, spyDb);
    seen.push(...result.rows);
    if (page >= result.pages) return { rows: seen, last: result };
    page += 1;
  }
}

test.describe.serial("P2b-03 rows: filters and server-side paging", () => {
  test.beforeAll(async () => {
    await cleanUp(P, p);
    await seed(
      {
        Groups: Array.from({ length: 30 }, (_, i) => ({
          group_code: `${P}-OLD${i}`,
          name: `Old ${i} ${T}`,
        })),
      },
      file("base"),
    );
    small = await upload(
      {
        Groups: [
          ...Array.from({ length: 70 }, (_, i) => ({
            group_code: `${P}-N${i}`,
            name: `${i % 2 ? "Alpha" : "Beta"} ${i} ${T}`,
          })),
          ...Array.from({ length: 30 }, (_, i) => ({
            group_code: `${P}-OLD${i}`,
            name: i < 20 ? `Old ${i} ${T}` : `Old renamed ${i} ${T}`,
          })),
          { group_code: `${P}-PCT`, name: `100% sure_${T}` },
        ],
        Subgroups: Array.from({ length: 12 }, (_, i) => ({
          subgroup_code: `${P}-S${i}`,
          group_code: i < 8 ? `${P}-N${i}` : `${P}-MISSING`,
          name: `Sub ${i} ${T}`,
        })),
      },
      file("small"),
    );
    const { rows } = await query(
      `INSERT INTO billing_import_sessions (file_name, file, uploaded_by, expires_at)
       VALUES ($1, $2, $3, NOW() + interval '1 hour') RETURNING id`,
      [file("big"), Buffer.from("xlsx"), USERS.admin.id],
    );
    big = rows[0].id;
    await query(
      `INSERT INTO billing_import_rows
              (session_id, sheet, row_no, row_key, label, status, decision, reason, errors,
               "values", input, before, changes)
       SELECT $1, CASE WHEN n % 2 = 0 THEN 'Items' ELSE 'Groups' END, n + 1, 'K' || n, 'Name ' || n,
              s, CASE WHEN s = 'override' THEN 'pending' END,
              CASE WHEN s = 'failed' THEN 'bad' END,
              CASE WHEN s = 'failed' THEN '[{"column":"name","message":"bad"}]'::jsonb END,
              '{}'::jsonb, '{}'::jsonb,
              CASE WHEN s = 'override' THEN '{"name":"a"}'::jsonb END,
              CASE WHEN s = 'override' THEN '[{"column":"name","from":"a","to":"b"}]'::jsonb END
         FROM generate_series(1, 10000) AS n,
              LATERAL (SELECT (ARRAY['ready','override','unchanged','failed'])[n % 4 + 1] AS s) x`,
      [big],
    );
  });

  test.afterAll(async () => {
    await query(`DELETE FROM billing_import_sessions WHERE id = $1`, [big]);
    await cleanUp(P, p);
  });

  test("1. the chips count by status and sheet, each ignoring its own filter", async () => {
    const all = await sessions.listRows(small.id, {}, db);
    expect(all.counts.status).toEqual({
      all: 113,
      ready: 79,
      override: 10,
      unchanged: 20,
      failed: 4,
    });
    expect(all.counts.sheet.Groups).toBe(101);
    expect(all.counts.sheet.Subgroups).toBe(12);
    expect(all.counts.decision).toEqual({ pending: 10, override: 0, keep: 0 });
    const subs = await sessions.listRows(small.id, { sheet: "Subgroups" }, db);
    expect(subs.total).toBe(12);
    expect(subs.counts.status).toEqual({ all: 12, ready: 8, override: 0, unchanged: 0, failed: 4 });
    expect(subs.counts.sheet).toMatchObject({ all: 113, Groups: 101, Subgroups: 12 });
    const failed = await sessions.listRows(small.id, { status: "failed" }, db);
    expect(failed.counts.sheet).toMatchObject({ all: 4, Groups: 0, Subgroups: 4 });
    expect(failed.counts.status.all).toBe(113);
  });

  test("2. every page of a filter returns exactly its rows, in sheet then row order", async () => {
    const { rows, last } = await allPages(small.id, { status: "ready" });
    expect(last.total).toBe(79);
    expect(last.pages).toBe(2);
    expect(rows).toHaveLength(79);
    expect(rows.every((r) => r.status === "ready")).toBe(true);
    const order = rows.map(
      (r) => `${r.sheet === "Groups" ? 0 : 1}:${String(r.row).padStart(4, "0")}`,
    );
    expect(order).toEqual([...order].sort());
    expect(new Set(rows.map((r) => r.id)).size).toBe(79);
    const first = await sessions.listRows(small.id, { status: "ready" }, db);
    expect(first.rows).toHaveLength(PAGE);
    expect(first.page).toBe(1);
    expect(first.page_size).toBe(PAGE);

    const overrides = await sessions.listRows(
      small.id,
      { status: "override", sheet: "Groups" },
      db,
    );
    expect(overrides.rows.map((r) => r.key)).toEqual(
      Array.from({ length: 10 }, (_, i) => `${P}-OLD${i + 20}`),
    );
    expect(overrides.rows[0].changes).toEqual([
      { column: "name", from: `Old 20 ${T}`, to: `Old renamed 20 ${T}` },
    ]);
    expect(overrides.rows[0].before).toEqual({ name: `Old 20 ${T}`, sort_order: 0, active: true });
    expect(overrides.rows[0].decision).toBe("pending");
  });

  test("3. search matches the code or the name, ignoring case, with % and _ taken literally", async () => {
    const alpha = await allPages(small.id, { q: "alpha" });
    expect(alpha.rows).toHaveLength(35);
    expect(alpha.rows.every((r) => r.label.startsWith("Alpha"))).toBe(true);
    expect(alpha.last.counts.status).toMatchObject({ all: 35, ready: 35 });
    const code = await sessions.listRows(small.id, { q: `${P}-n6`.toLowerCase() }, db);
    expect(code.rows.map((r) => r.key)).toEqual([
      `${P}-N6`,
      ...Array.from({ length: 10 }, (_, i) => `${P}-N6${i}`),
    ]);
    const pct = await sessions.listRows(small.id, { q: "100%" }, db);
    expect(pct.rows.map((r) => r.key)).toEqual([`${P}-PCT`]);
    const under = await sessions.listRows(small.id, { q: "e_" }, db);
    expect(under.rows.map((r) => r.key)).toEqual([`${P}-PCT`]);
    const both = await sessions.listRows(
      small.id,
      { q: "sub", sheet: "Subgroups", status: "failed" },
      db,
    );
    expect(both.rows.map((r) => r.row)).toEqual([10, 11, 12, 13]);
    expect(both.rows[0].reason).toMatch(/There is no group/);
  });

  test("4. a 10,000-row session pages 50 at a time without any query returning more", async () => {
    const watch = spy();
    const started = Date.now();
    const { rows, last } = await allPages(big, { status: "override", sheet: "Groups" }, watch);
    expect(last.total).toBe(2500);
    expect(last.pages).toBe(50);
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500);
    expect(rows.every((r) => r.status === "override" && r.sheet === "Groups")).toBe(true);
    expect(rows.map((r) => r.row)).toEqual([...rows.map((r) => r.row)].sort((a, b) => a - b));
    expect(Math.max(...watch.sizes)).toBeLessThanOrEqual(PAGE);
    expect(Date.now() - started).toBeLessThan(20000);

    const middle = await sessions.listRows(big, { page: "101" }, db);
    expect(middle.total).toBe(10000);
    expect(middle.pages).toBe(200);
    expect(middle.rows.every((r) => r.sheet === "Items")).toBe(true);
    expect(middle.rows.map((r) => r.row)).toEqual(
      Array.from({ length: PAGE }, (_, i) => 3 + i * 2),
    );
    const beyond = await sessions.listRows(big, { page: "201" }, db);
    expect(beyond.rows).toEqual([]);
    expect(beyond.total).toBe(10000);
  });

  test("5. bad filters, a bad id and an unknown session are refused in words", async () => {
    const refusal = (input, id = small.id) => sessions.listRows(id, input, db).catch((e) => e);
    expect((await refusal({ status: "done" })).message).toBe(
      "Status must be one of: ready, override, unchanged, failed",
    );
    expect((await refusal({ sheet: "Nope" })).status).toBe(400);
    expect((await refusal({ outcome: "lost" })).status).toBe(400);
    expect((await refusal({ q: "x".repeat(101) })).message).toBe(
      "Search can be at most 100 characters",
    );
    expect((await refusal({ page: "0" })).status).toBe(400);
    expect((await refusal({ page: "abc" })).status).toBe(400);
    expect((await refusal({}, "not-an-id")).message).toBe("Choose a valid import session");
    const gone = await refusal({}, "00000000-0000-4000-8000-000000000000");
    expect(gone.status).toBe(404);
  });
});
