import { test, expect } from "@playwright/test";
import {
  HAS_COMMENTS,
  REFUSED,
  SEEDS_ROWS,
  openFreshCopy,
  readMigration,
} from "../../helpers/migration.mjs";

const SQL = readMigration("2026-10-16_discount_rules_bill_fixed_price.sql");
const CHECK = "discount_rules_bill_fixed_price_check";

let db = null;

const addDiscount = `INSERT INTO discount_rules (name, method, kind, value, applies_per)
  VALUES ($1, 'auto', $2, 500, $3)`;

test.describe.serial("P3-02a a whole-bill fixed price can't be saved at all", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL, {
      undo: `ALTER TABLE discount_rules DROP CONSTRAINT IF EXISTS ${CHECK}`,
      before: (client) =>
        client
          .query(
            `SELECT count(*)::int AS breaking FROM discount_rules
              WHERE kind = 'fixed_price' AND applies_per = 'bill'`,
          )
          .then((r) => r.rows[0]),
    });
  });

  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the migration seeds nothing, carries no comments and runs twice", async () => {
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
    expect(db.snapshot.breaking, "no saved discount breaks the new check").toBe(0);
  });

  test("2. the check is on the table and says what it forbids", async () => {
    const { rows } = await db.client.query(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conrelid = 'discount_rules'::regclass AND c.conname = $1`,
      [CHECK],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].def.replace(/[()]/g, "")).toContain("kind <> 'fixed_price'::text");
    expect(rows[0].def.replace(/[()]/g, "")).toContain("applies_per <> 'bill'::text");
  });

  test("3. a whole-bill fixed price is refused, and the shapes that work still do", async () => {
    expect(await db.refused(addDiscount, ["Whole bill ₹500", "fixed_price", "bill"])).toBe(
      REFUSED.rule,
    );
    expect(await db.refused(addDiscount, ["One line ₹500", "fixed_price", "line"])).toBeNull();
    expect(await db.refused(addDiscount, ["Bill flat ₹500", "flat", "bill"])).toBeNull();
    expect(
      await db.refused(`UPDATE discount_rules SET applies_per = 'bill' WHERE name = $1`, [
        "One line ₹500",
      ]),
      "a saved line rule can't be moved to the whole bill either",
    ).toBe(REFUSED.rule);
  });
});
