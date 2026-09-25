import { test, expect } from "@playwright/test";
import {
  AUDIT_COLUMNS,
  HAS_COMMENTS,
  REFUSED,
  SEEDS_ROWS,
  columnsOf,
  indexesOf,
  lockdownOf,
  openFreshCopy,
  readMigration,
  tablesCreatedBy,
} from "../../helpers/migration.mjs";

const SQL = readMigration("2026-10-24_billing_claim_settlements.sql");
const SETTLEMENTS = "claim_settlements";
const LINKS = "claim_settlement_bills";

const SETTLEMENT_COLUMNS = [
  "id",
  "payer_name",
  "received_on",
  "reference",
  "amount",
  "note",
  "cleared_by",
  "cleared_at",
  "voided_at",
  "voided_by",
  "void_reason",
  ...AUDIT_COLUMNS,
].sort();

const LINK_COLUMNS = ["settlement_id", "bill_id", "amount", "voided_at", ...AUDIT_COLUMNS].sort();

const UNDO = `
  ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_claim_settlement_id_fkey;
  DROP INDEX IF EXISTS bills_claim_settlement_idx;`;

let db = null;
const ids = {};

const addSettlement = `INSERT INTO claim_settlements
  (payer_name, received_on, reference, amount, voided_at, void_reason)
  VALUES (COALESCE($1, 'CGHS Chandigarh'), CURRENT_DATE, COALESCE($2, 'UTR-P501'),
          COALESCE($3::numeric, 700), $4, $5)`;

const settlement = (o = {}) => [
  o.payer ?? null,
  o.reference ?? null,
  o.amount ?? null,
  o.voidedAt ?? null,
  o.voidReason ?? null,
];

test.describe.serial("P5-01 migration: claim settlements", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL, {
      undo: UNDO,
      before: async (client) => {
        const patient = (
          await client.query(`INSERT INTO patients (name) VALUES ('P501 Patient') RETURNING id`)
        ).rows[0].id;
        const visit = (
          await client.query(`INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [
            patient,
          ])
        ).rows[0].id;
        const bill = (
          await client.query(
            `INSERT INTO bills (patient_id, visit_id, bill_no, series, fy, status, finalised_at,
                                claim_amount, claim_status, actual_amount, payer_name)
             VALUES ($1, $2, 'P501/000001', 'MAIN', '2026-27', 'final', NOW(), 700, 'pending',
                     700, 'CGHS Chandigarh')
             RETURNING id`,
            [patient, visit],
          )
        ).rows[0].id;
        return { patient, visit, bill };
      },
    });
    Object.assign(ids, db.snapshot);
  });

  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file creates both tables, inserts no rows and has no comments", () => {
    expect(tablesCreatedBy(SQL).sort()).toEqual([LINKS, SETTLEMENTS].sort());
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. run twice, both tables have the planned columns, are empty and locked down", async () => {
    const { client } = db;
    expect(await columnsOf(client, SETTLEMENTS)).toEqual(SETTLEMENT_COLUMNS);
    expect(await columnsOf(client, LINKS)).toEqual(LINK_COLUMNS);
    for (const table of [SETTLEMENTS, LINKS]) {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
    const { rls, publicGrants } = await lockdownOf(client, [SETTLEMENTS, LINKS]);
    expect(rls).toHaveLength(2);
    for (const row of rls) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
    expect(publicGrants).toEqual([]);
  });

  test("3. the unique index and the foreign keys exist", async () => {
    const { client } = db;
    const indexes = await indexesOf(client, [LINKS, "bills"]);
    expect(indexes.claim_settlement_bills_live_key).toMatch(
      /UNIQUE INDEX .* \(bill_id\) WHERE \(voided_at IS NULL\)/,
    );
    expect(indexes.bills_claim_settlement_idx).toMatch(/\(claim_settlement_id\)/);
    const { rows } = await client.query(
      `SELECT conname, confrelid::regclass::text AS target, confdeltype
         FROM pg_constraint WHERE contype = 'f'
          AND conrelid IN ('bills'::regclass, 'claim_settlement_bills'::regclass)
          AND confrelid IN ('bills'::regclass, 'claim_settlements'::regclass)`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.conname, r]));
    expect(byName.bills_claim_settlement_id_fkey).toMatchObject({
      target: SETTLEMENTS,
      confdeltype: "r",
    });
    expect(byName.claim_settlement_bills_settlement_id_fkey).toMatchObject({
      target: SETTLEMENTS,
      confdeltype: "r",
    });
    expect(byName.claim_settlement_bills_bill_id_fkey).toMatchObject({
      target: "bills",
      confdeltype: "r",
    });
  });

  test("4. existing bills pass the new link, and the settlement rules hold", async () => {
    const { client, refused } = db;
    const { rows: stray } = await client.query(
      `SELECT COUNT(*)::int AS n FROM bills b
        WHERE b.claim_settlement_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM claim_settlements s WHERE s.id = b.claim_settlement_id)`,
    );
    expect(stray[0].n).toBe(0);
    expect(await refused(addSettlement, settlement()), "a payment").toBeNull();
    const bad = [
      ["nothing received", { amount: 0 }],
      ["a blank reference", { reference: "  " }],
      ["a blank payer", { payer: " " }],
      ["undone with no reason", { voidedAt: "2026-10-01T10:00:00Z" }],
      ["a reason with no undo", { voidReason: "Wrong UTR" }],
      ["a blank reason", { voidedAt: "2026-10-01T10:00:00Z", voidReason: " " }],
    ];
    for (const [why, o] of bad) {
      expect(await refused(addSettlement, settlement(o)), why).toBe(REFUSED.rule);
    }
    expect(
      await refused(
        addSettlement,
        settlement({ voidedAt: "2026-10-01T10:00:00Z", voidReason: "Wrong UTR" }),
      ),
      "an undone payment with its reason",
    ).toBeNull();
  });

  test("5. a bill sits in at most one live payment, and a link can't point at nothing", async () => {
    const { client, refused } = db;
    const made = async (reference) =>
      (
        await client.query(
          `INSERT INTO claim_settlements (payer_name, received_on, reference, amount)
           VALUES ('CGHS Chandigarh', CURRENT_DATE, $1, 700) RETURNING id`,
          [reference],
        )
      ).rows[0].id;
    const first = await made("UTR-P501-A");
    const second = await made("UTR-P501-B");
    const link = `INSERT INTO claim_settlement_bills (settlement_id, bill_id, amount, voided_at)
                  VALUES ($1, $2, $3, $4)`;
    expect(await refused(link, [first, ids.bill, 700, null]), "the first payment").toBeNull();
    expect(await refused(link, [second, ids.bill, 700, null]), "a second live payment").toBe(
      REFUSED.duplicate,
    );
    expect(await refused(link, [second, ids.bill, 0, null]), "a link of nothing").toBe(
      REFUSED.rule,
    );
    await client.query(
      `UPDATE claim_settlement_bills SET voided_at = NOW() WHERE settlement_id = $1`,
      [first],
    );
    expect(
      await refused(link, [second, ids.bill, 700, null]),
      "once the first is undone",
    ).toBeNull();
    expect(
      await refused(link, [first, "00000000-0000-4000-8000-000000000001", 700, null]),
      "an unknown bill",
    ).toBe(REFUSED.missingParent);

    const clear = `UPDATE bills SET claim_status = 'cleared', claim_settlement_id = $2 WHERE id = $1`;
    expect(
      await refused(clear, [ids.bill, "00000000-0000-4000-8000-000000000002"]),
      "a bill cleared by no payment",
    ).toBe(REFUSED.missingParent);
    expect(await refused(clear, [ids.bill, second]), "a bill cleared by a payment").toBeNull();
    expect(
      await refused(`DELETE FROM claim_settlements WHERE id = $1`, [second]),
      "deleting a payment a bill points at",
    ).toBe(REFUSED.stillUsed);
    expect(
      await refused(`DELETE FROM bills WHERE id = $1`, [ids.bill]),
      "deleting a bill in a payment",
    ).toBe(REFUSED.stillUsed);
  });
});
