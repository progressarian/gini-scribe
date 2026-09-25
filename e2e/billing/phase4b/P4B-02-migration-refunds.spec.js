import { test, expect } from "@playwright/test";
import { getPool } from "../../helpers/db.mjs";
import {
  HAS_COMMENTS,
  REFUSED,
  SEEDS_ROWS,
  allowedValuesOf,
  indexesOf,
  lockdownOf,
  openFreshCopy,
  readMigration,
  tablesCreatedBy,
} from "../../helpers/migration.mjs";

const SQL = readMigration("2026-10-22_billing_refunds.sql");
const TABLES = ["bills", "bill_lines", "payments", "billing_requests"];
const REQUEST_COLUMNS = {
  refund_lines: "jsonb",
  requested_mode: "text",
  approved_mode: "text",
  mode_reason: "text",
  credit_note_id: "uuid",
};
const TRIGGERS = {
  bills_credit_note_guard: "bills",
  payments_direction_guard: "payments",
  bill_lines_credit_guard: "bill_lines",
};

const UNDO = `
  DROP TRIGGER IF EXISTS bills_credit_note_guard ON bills;
  DROP TRIGGER IF EXISTS payments_direction_guard ON payments;
  DROP TRIGGER IF EXISTS bill_lines_credit_guard ON bill_lines;
  DROP FUNCTION IF EXISTS bills_credit_note_guard();
  DROP FUNCTION IF EXISTS payments_direction_guard();
  DROP FUNCTION IF EXISTS bill_lines_credit_guard();
  DROP INDEX IF EXISTS billing_requests_pending_refund_key;
  ALTER TABLE billing_requests
    ${Object.keys(REQUEST_COLUMNS)
      .map((c) => `DROP COLUMN IF EXISTS ${c} CASCADE`)
      .join(",\n    ")},
    DROP CONSTRAINT IF EXISTS billing_requests_kind_check,
    ADD CONSTRAINT billing_requests_kind_check CHECK (kind IN ('new_item', 'repeat_item'));
  ALTER TABLE bill_lines DROP COLUMN IF EXISTS credited_line_id CASCADE;
  ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS payments_cash_out_shift_check,
    DROP CONSTRAINT IF EXISTS payments_direction_check,
    ADD CONSTRAINT payments_direction_check CHECK (direction IN ('in'));
  DROP INDEX IF EXISTS bills_id_original_key;`;

const NEW_FEATURES_IN_USE = `SELECT
  (SELECT count(*) FROM payments WHERE direction <> 'in')
  + (SELECT count(*) FROM bills WHERE bill_type <> 'invoice')
  + (SELECT count(*) FROM billing_requests WHERE kind = 'refund') AS n`;

const ids = {};
let db = null;
let lineNo = 0;

const one = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];

const addLine = `INSERT INTO bill_lines
  (id, bill_id, visit_id, line_no, service_item_id, is_live, credited_line_id, bill_name, quantity,
   rate, listed_actual, actual_amount, taxable, patient_payable)
  VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, COALESCE($6, TRUE), $7, 'Line', $8::numeric,
          100, ROUND($8::numeric * 100, 2), ROUND($8::numeric * 100, 2), ROUND($8::numeric * 100, 2),
          ROUND($8::numeric * 100, 2))`;

const line = (o = {}) => [
  o.id ?? null,
  o.bill ?? ids.creditNote,
  o.visit ?? ids.visit,
  ++lineNo,
  o.item ?? ids.itemA,
  o.live ?? (o.credits === null ? null : false),
  o.credits === undefined ? ids.lineA : o.credits,
  o.quantity ?? 1,
];

const addPayment = `INSERT INTO payments (bill_id, direction, mode, amount, reference, shift_id)
  VALUES ($1, $2, $3, 100, $4, $5)`;

const payment = (o = {}) => [
  o.bill ?? ids.creditNote,
  o.direction ?? "out",
  o.mode ?? "cash",
  o.reference ?? null,
  o.shift === undefined ? ids.shift : o.shift,
];

const addRequest = `INSERT INTO billing_requests
  (kind, patient_id, visit_id, bill_id, service_item_id, proposed_name, reason, status, decided_at,
   refund_lines, requested_mode, approved_mode, mode_reason, credit_note_id)
  VALUES (COALESCE($1, 'refund'), $2, $3, $4, $5, $6, 'Patient left before the test',
          COALESCE($7, 'pending'), CASE WHEN COALESCE($7, 'pending') = 'pending' THEN NULL ELSE NOW() END,
          $8::jsonb, $9, $10, $11, $12)`;

const refundLines = (entries) => JSON.stringify(entries);

const request = (o = {}) => [
  o.kind ?? null,
  ids.patient,
  ids.visit,
  o.bill === undefined ? ids.invoice : o.bill,
  o.item ?? null,
  o.proposedName ?? null,
  o.status ?? null,
  o.lines === undefined ? refundLines([{ line_id: ids.lineA, quantity: 1 }]) : o.lines,
  o.requestedMode === undefined ? "as_paid" : o.requestedMode,
  o.approvedMode ?? null,
  o.modeReason ?? null,
  o.creditNote ?? null,
];

const legacyRows = async (client) => {
  const rows = await client.query(
    `SELECT t, r FROM (
       SELECT 'bills' AS t, to_jsonb(b) AS r FROM bills b WHERE id = $1
       UNION ALL SELECT 'bill_lines', to_jsonb(l) FROM bill_lines l WHERE bill_id = $1
       UNION ALL SELECT 'payments', to_jsonb(p) FROM payments p WHERE bill_id = $1
       UNION ALL SELECT 'billing_requests', to_jsonb(q) FROM billing_requests q WHERE id = ANY($2)
     ) x ORDER BY t, r->>'id'`,
    [ids.legacyBill, ids.legacyRequests],
  );
  return rows.rows.map(({ t, r }) => {
    const keep = { ...r };
    for (const c of ["credited_line_id", ...Object.keys(REQUEST_COLUMNS)]) delete keep[c];
    return {
      t,
      r: keep,
      added: Object.fromEntries(
        Object.keys(r)
          .filter((c) => !(c in keep))
          .map((c) => [c, r[c]]),
      ),
    };
  });
};

const seed = async (client, tag) => {
  const patient = (
    await one(client, `INSERT INTO patients (name) VALUES ($1) RETURNING id`, [`${tag} Patient`])
  ).id;
  const visit = (
    await one(client, `INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [
      patient,
    ])
  ).id;
  const group = (
    await one(client, `INSERT INTO service_groups (code, name) VALUES ($1, 'OPD') RETURNING id`, [
      `${tag}-G`,
    ])
  ).id;
  const subgroup = (
    await one(
      client,
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'Tests') RETURNING id`,
      [group, `${tag}-S`],
    )
  ).id;
  const item = async (code) =>
    (
      await one(
        client,
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
         VALUES ($1, $1, $2, 100, 'procedure') RETURNING id`,
        [`${tag}-${code}`, subgroup],
      )
    ).id;
  return { patient, visit, group, subgroup, item };
};

const finalBill = async (client, o) =>
  (
    await one(
      client,
      `INSERT INTO bills (patient_id, visit_id, bill_type, original_bill_id, actual_amount,
                          patient_payable, paid_amount, status, bill_no, series, fy, finalised_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, 'final', $7, $8, '2026-27', NOW()) RETURNING id`,
      [
        o.patient,
        o.visit,
        o.original ? "credit_note" : "invoice",
        o.original ?? null,
        o.amount,
        o.paid ?? 0,
        o.no,
        o.original ? "CN" : "MAIN",
      ],
    )
  ).id;

test.describe.serial("P4B-02 migration: refunds and credit notes", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL, {
      before: async (client) => {
        const applied = (
          await one(
            client,
            `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                             WHERE table_name = 'bill_lines' AND column_name = 'credited_line_id') AS yes`,
          )
        ).yes;
        const inUse = applied ? Number((await one(client, NEW_FEATURES_IN_USE)).n) : 0;
        if (!inUse) await client.query(UNDO);
        const s = await seed(client, "P4B02-OLD");
        const item = await s.item("A");
        ids.legacyBill = (
          await one(
            client,
            `INSERT INTO bills (patient_id, visit_id, actual_amount, patient_payable) VALUES ($1, $2, 300, 300)
             RETURNING id`,
            [s.patient, s.visit],
          )
        ).id;
        await client.query(
          `INSERT INTO bill_lines (bill_id, visit_id, line_no, service_item_id, bill_name, quantity, rate,
                                   listed_actual, actual_amount, taxable, patient_payable)
           VALUES ($1, $2, 1, $3, 'Old line', 3, 100, 300, 300, 300, 300)`,
          [ids.legacyBill, s.visit, item],
        );
        await client.query(
          `UPDATE bills SET status = 'final', bill_no = 'P4B02-OLD/1', series = 'MAIN', fy = '2026-27',
                            finalised_at = NOW(), paid_amount = 300 WHERE id = $1`,
          [ids.legacyBill],
        );
        await client.query(
          `INSERT INTO payments (bill_id, mode, amount) VALUES ($1, 'cash', 200)`,
          [ids.legacyBill],
        );
        await client.query(
          `INSERT INTO payments (bill_id, mode, amount, reference) VALUES ($1, 'card', 100, 'APPR1')`,
          [ids.legacyBill],
        );
        ids.legacyRequests = (
          await client.query(
            `INSERT INTO billing_requests (kind, patient_id, visit_id, service_item_id, proposed_name, reason,
                                           status, decided_at)
             VALUES ('new_item', $1, NULL, NULL, 'Ear wash', 'Not in the list', 'pending', NULL),
                    ('new_item', $1, NULL, NULL, 'Nail care', 'Not in the list', 'rejected', NOW()),
                    ('repeat_item', $1, $2, $3, NULL, 'Second knee', 'approved', NOW()),
                    ('repeat_item', $1, $2, $3, NULL, 'Second knee', 'used', NOW())
             RETURNING id`,
            [s.patient, s.visit, item],
          )
        ).rows.map((r) => r.id);
        return { undone: !inUse, rows: await legacyRows(client) };
      },
    });
    const { client } = db;
    const s = await seed(client, "P4B02");
    ids.patient = s.patient;
    ids.visit = s.visit;
    ids.itemA = await s.item("A");
    ids.itemB = await s.item("B");
    ids.otherVisit = (
      await one(
        client,
        `INSERT INTO giniflow_visits (patient_id, visit_date) VALUES ($1, CURRENT_DATE - 1) RETURNING id`,
        [ids.patient],
      )
    ).id;
    ids.invoice = await finalBill(client, {
      patient: ids.patient,
      visit: ids.visit,
      amount: 800,
      paid: 800,
      no: "P4B02/1",
    });
    ids.otherInvoice = await finalBill(client, {
      patient: ids.patient,
      visit: ids.otherVisit,
      amount: 100,
      no: "P4B02/2",
    });
    ids.draft = (
      await one(client, `INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`, [
        ids.patient,
        ids.otherVisit,
      ])
    ).id;
    const invoiceLine = async (bill, visit, item, quantity) => {
      const id = (await one(client, `SELECT gen_random_uuid() AS id`)).id;
      await client.query(addLine, [id, bill, visit, ++lineNo, item, true, null, quantity]);
      return id;
    };
    ids.lineA = await invoiceLine(ids.invoice, ids.visit, ids.itemA, 3);
    ids.lineB = await invoiceLine(ids.invoice, ids.visit, ids.itemB, 5);
    ids.otherLine = await invoiceLine(ids.otherInvoice, ids.otherVisit, ids.itemA, 1);
    ids.creditNote = await finalBill(client, {
      patient: ids.patient,
      visit: ids.visit,
      original: ids.invoice,
      amount: 300,
      no: "P4B02-CN/1",
    });
    ids.secondCreditNote = await finalBill(client, {
      patient: ids.patient,
      visit: ids.visit,
      original: ids.invoice,
      amount: 100,
      no: "P4B02-CN/2",
    });
    ids.doctor = (
      await one(
        client,
        `INSERT INTO doctors (name, role) VALUES ('P4B02 Desk', 'reception') RETURNING id`,
      )
    ).id;
    ids.shift = (
      await one(
        client,
        `INSERT INTO cash_shifts (user_id, opening_cash) VALUES ($1, 2000) RETURNING id`,
        [ids.doctor],
      )
    ).id;
  });

  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file only alters existing tables, seeds nothing, has no comments and drops only constraints it re-adds", () => {
    expect(tablesCreatedBy(SQL)).toEqual([]);
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
    const dropped = [...SQL.matchAll(/DROP\s+(\w+)\s+IF EXISTS\s+(\w+)/gi)];
    expect(dropped.length).toBeGreaterThan(0);
    for (const [, kind, name] of dropped) {
      expect(kind.toUpperCase(), name).toBe("CONSTRAINT");
      expect(SQL, name).toMatch(new RegExp(`ADD CONSTRAINT ${name}\\b`));
    }
    expect(SQL).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX|TRIGGER|FUNCTION)\b/i);
  });

  test("2. it runs twice and the rows written before it are untouched", async () => {
    expect(db.snapshot.rows.length).toBe(8);
    const after = await legacyRows(db.client);
    expect(after.map(({ t, r }) => ({ t, r }))).toEqual(
      db.snapshot.rows.map(({ t, r }) => ({ t, r })),
    );
    for (const { added } of after)
      for (const value of Object.values(added)) expect(value).toBeNull();
    const { refused } = db;
    for (const status of ["pending", "approved", "rejected"])
      expect(
        await refused(
          `INSERT INTO billing_requests (kind, patient_id, proposed_name, reason, status, decided_at)
           VALUES ('new_item', $1, 'Ear wash', 'Not listed', $2, CASE WHEN $2 = 'pending' THEN NULL ELSE NOW() END)`,
          [ids.patient, status],
        ),
        `a ${status} new-item request as before`,
      ).toBeNull();
    expect(
      await refused(`UPDATE payments SET amount = 150 WHERE bill_id = $1 AND mode = 'card'`, [
        ids.legacyBill,
      ]),
      "an old payment still edits",
    ).toBeNull();
    expect(
      await refused(
        `UPDATE bill_lines SET quantity = 2, listed_actual = 200, actual_amount = 200, taxable = 200,
                               patient_payable = 200 WHERE bill_id = $1`,
        [ids.legacyBill],
      ),
      "an old line reprices",
    ).toBeNull();
  });

  test("3. the new columns, value lists, triggers and indexes are in place, and the tables stay locked down", async () => {
    const { rows } = await db.client.query(
      `SELECT table_name || '.' || column_name AS c, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'bill_lines' AND column_name = 'credited_line_id')
               OR (table_name = 'billing_requests' AND column_name = ANY($1)))
`,
      [Object.keys(REQUEST_COLUMNS)],
    );
    const byName = (a, b) => (a.c < b.c ? -1 : a.c > b.c ? 1 : 0);
    expect(rows.sort(byName)).toEqual(
      [
        { c: "bill_lines.credited_line_id", data_type: "uuid", is_nullable: "YES" },
        ...Object.entries(REQUEST_COLUMNS).map(([c, data_type]) => ({
          c: `billing_requests.${c}`,
          data_type,
          is_nullable: "YES",
        })),
      ].sort(byName),
    );
    expect(await allowedValuesOf(db.client, "payments", "direction")).toEqual(["in", "out"]);
    expect(await allowedValuesOf(db.client, "billing_requests", "kind")).toEqual([
      "new_item",
      "refund",
      "repeat_item",
    ]);
    for (const column of ["requested_mode", "approved_mode"])
      expect(await allowedValuesOf(db.client, "billing_requests", column)).toEqual([
        "as_paid",
        "card",
        "cash",
        "upi",
      ]);
    const { rows: triggers } = await db.client.query(
      `SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname = ANY($1)`,
      [Object.keys(TRIGGERS)],
    );
    expect(Object.fromEntries(triggers.map((t) => [t.tgname, t.relname]))).toEqual(TRIGGERS);
    const indexes = await indexesOf(db.client, TABLES);
    expect(indexes.bill_lines_credited_idx).toMatch(
      /\(credited_line_id\) WHERE \(credited_line_id IS NOT NULL\)/,
    );
    expect(indexes.bills_id_original_key).toMatch(/UNIQUE INDEX .*\(id, original_bill_id\)/);
    expect(indexes.billing_requests_credit_note_key).toMatch(
      /UNIQUE INDEX .*\(credit_note_id\) WHERE \(credit_note_id IS NOT NULL\)/,
    );
    expect(indexes.billing_requests_pending_refund_key).toMatch(
      /UNIQUE INDEX .*\(bill_id\) WHERE \(\(kind = 'refund'::text\) AND \(status = 'pending'::text\)\)/,
    );
    const { rls, publicGrants } = await lockdownOf(db.client, TABLES);
    expect(rls.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    expect(rls).toHaveLength(4);
    expect(publicGrants).toEqual([]);
  });

  test("4. a credit note credits only a final invoice, and a bill's type and original never change", async () => {
    const { refused } = db;
    const creditNote = (original, no) =>
      refused(
        `INSERT INTO bills (patient_id, visit_id, bill_type, original_bill_id, status, bill_no, series, fy,
                            finalised_at)
         VALUES ($1, $2, 'credit_note', $3, 'final', $4, 'CN', '2026-27', NOW())`,
        [ids.patient, ids.visit, original, no],
      );
    expect(await creditNote(ids.draft, "P4B02-CN/9"), "a credit note on a draft").toBe(
      REFUSED.rule,
    );
    expect(await creditNote(ids.creditNote, "P4B02-CN/9"), "a credit note on a credit note").toBe(
      REFUSED.rule,
    );
    expect(
      await creditNote("00000000-0000-0000-0000-000000000009", "P4B02-CN/9"),
      "a credit note on no bill",
    ).toBe(REFUSED.missingParent);
    expect(
      await creditNote(ids.otherInvoice, "P4B02-CN/9"),
      "a credit note on a final invoice",
    ).toBeNull();
    expect(
      await refused(
        `UPDATE bills SET bill_type = 'credit_note', original_bill_id = $2 WHERE id = $1`,
        [ids.draft, ids.invoice],
      ),
      "an invoice turned into a credit note",
    ).toBe(REFUSED.rule);
    expect(
      await refused(`UPDATE bills SET original_bill_id = $2 WHERE id = $1`, [
        ids.creditNote,
        ids.otherInvoice,
      ]),
      "a credit note moved to another bill",
    ).toBe(REFUSED.rule);
    expect(
      await refused(`UPDATE bills SET bill_type = 'invoice', original_bill_id = $2 WHERE id = $1`, [
        ids.creditNote,
        ids.invoice,
      ]),
      "rewriting the same type and original",
    ).toBe(REFUSED.rule);
    expect(
      await refused(`UPDATE bills SET original_bill_id = $2 WHERE id = $1`, [
        ids.creditNote,
        ids.invoice,
      ]),
      "setting the same original again",
    ).toBeNull();
    expect(
      await refused(`UPDATE bills SET paid_amount = 50 WHERE id = $1`, [ids.creditNote]),
      "other fields of a credit note",
    ).toBeNull();
  });

  test("5. money goes out only on a credit note, from a shift when in cash, with a reference otherwise", async () => {
    const { refused } = db;
    const good = [
      ["cash back from the desk's shift", {}],
      ["a card reversal with its reference", { mode: "card", reference: "RRN123", shift: null }],
      ["a UPI reversal with its reference", { mode: "upi", reference: "UTR123", shift: null }],
      ["cash still comes in on an invoice", { bill: ids.invoice, direction: "in", shift: null }],
    ];
    for (const [why, o] of good) expect(await refused(addPayment, payment(o)), why).toBeNull();
    const bad = [
      ["money out on an invoice", { bill: ids.invoice }],
      ["money in on a credit note", { direction: "in" }],
      ["cash out of no shift", { shift: null }],
      ["a card reversal with no reference", { mode: "card", shift: null }],
      ["a UPI reversal with a blank reference", { mode: "upi", reference: " ", shift: null }],
      ["a direction that isn't in or out", { direction: "sideways" }],
    ];
    for (const [why, o] of bad)
      expect(await refused(addPayment, payment(o)), why).toBe(REFUSED.rule);
    expect(
      await refused(`UPDATE payments SET direction = 'out' WHERE bill_id = $1`, [ids.invoice]),
      "turning a payment in into money out",
    ).toBe(REFUSED.rule);
    expect(
      await refused(`UPDATE payments SET bill_id = $2 WHERE bill_id = $1 AND direction = 'out'`, [
        ids.creditNote,
        ids.invoice,
      ]),
      "moving a refund onto the invoice",
    ).toBe(REFUSED.rule);
  });

  test("6. a credit note's lines each credit a line of its own invoice, never past that line's quantity", async () => {
    const { refused } = db;
    const bad = [
      [
        "an invoice line that credits another line",
        { bill: ids.otherInvoice, visit: ids.otherVisit, credits: ids.otherLine, live: false },
      ],
      ["a credit note line that credits nothing", { credits: null }],
      ["a line of a different invoice", { credits: ids.otherLine }],
      ["a different item from the line it credits", { item: ids.itemB }],
      ["a credit note line that is live", { live: true }],
      ["more than the line's quantity at once", { quantity: 3.01 }],
    ];
    for (const [why, o] of bad) expect(await refused(addLine, line(o)), why).toBe(REFUSED.rule);
    expect(
      await refused(addLine, line({ credits: "00000000-0000-0000-0000-000000000009" })),
      "a line that doesn't exist",
    ).toBe(REFUSED.missingParent);
    const self = "11111111-2222-4333-8444-555555555555";
    expect(
      await refused(addLine, line({ id: self, credits: self })),
      "a line crediting itself",
    ).toBe(REFUSED.rule);

    ids.cnLine = (await one(db.client, `${addLine} RETURNING id`, line({ quantity: 2 }))).id;
    expect(
      await refused(addLine, line({ bill: ids.secondCreditNote, quantity: 1.5 })),
      "a second credit note taking more than is left",
    ).toBe(REFUSED.rule);
    expect(
      await refused(addLine, line({ bill: ids.secondCreditNote, quantity: 0.5 })),
      "part of what is left",
    ).toBeNull();
    expect(
      await refused(addLine, line({ bill: ids.secondCreditNote, quantity: 0.5 })),
      "the rest of the line",
    ).toBeNull();
    expect(
      await refused(addLine, line({ bill: ids.secondCreditNote, quantity: 0.01 })),
      "a paisa past it",
    ).toBe(REFUSED.rule);
    expect(
      await refused(
        `UPDATE bill_lines SET quantity = 2.5, listed_actual = 250, actual_amount = 250, taxable = 250,
                               patient_payable = 250 WHERE id = $1`,
        [ids.cnLine],
      ),
      "growing a credit line past the original",
    ).toBe(REFUSED.rule);
    expect(
      await refused(
        `UPDATE bill_lines SET quantity = 2, listed_actual = 200, actual_amount = 200, taxable = 200,
                               patient_payable = 200 WHERE id = $1`,
        [ids.lineA],
      ),
      "shrinking the original below what was credited",
    ).toBe(REFUSED.rule);
    expect(
      await refused(`UPDATE bill_lines SET credited_line_id = $2 WHERE id = $1`, [
        ids.cnLine,
        ids.lineB,
      ]),
      "pointing a credit line at another item's line",
    ).toBe(REFUSED.rule);
    expect(
      await refused(`UPDATE bill_lines SET is_live = FALSE WHERE id = $1`, [ids.lineA]),
      "the fully credited line is freed",
    ).toBeNull();
    expect(
      await refused(`DELETE FROM bill_lines WHERE id = $1`, [ids.lineA]),
      "deleting a credited line",
    ).toBe(REFUSED.stillUsed);
    expect(
      await refused(addLine, line({ item: ids.itemB, credits: ids.lineB, quantity: 5 })),
      "the whole of another line",
    ).toBeNull();
  });

  test("7. a refund request carries its bill, lines and mode, and an approval its credit note and any mode change", async () => {
    const { refused } = db;
    const other = ids.lineB;
    const shapes = [
      ["an empty list", "[]"],
      ["an object instead of a list", refundLines({ line_id: ids.lineA, quantity: 1 })],
      ["a line with no quantity", refundLines([{ line_id: ids.lineA }])],
      ["a quantity with no line", refundLines([{ quantity: 1 }])],
      ["a quantity of nothing", refundLines([{ line_id: ids.lineA, quantity: 0 }])],
      ["a negative quantity", refundLines([{ line_id: ids.lineA, quantity: -1 }])],
      ["a quantity finer than the paisa", refundLines([{ line_id: ids.lineA, quantity: 0.333 }])],
      ["a quantity in words", refundLines([{ line_id: ids.lineA, quantity: "1" }])],
      ["a line that isn't an id", refundLines([{ line_id: "line-1", quantity: 1 }])],
      ["a line id that is a number", refundLines([{ line_id: 7, quantity: 1 }])],
      ["an extra field", refundLines([{ line_id: ids.lineA, quantity: 1, amount: 100 }])],
      ["a list inside the list", refundLines([[{ line_id: ids.lineA, quantity: 1 }]])],
      ["a bare number", refundLines([5])],
      [
        "a good line beside a bad one",
        refundLines([{ line_id: ids.lineA, quantity: 1 }, { line_id: other }]),
      ],
    ];
    for (const [why, lines] of shapes)
      expect(await refused(addRequest, request({ lines })), why).toBe(REFUSED.rule);
    const missing = [
      ["no bill", { bill: null }],
      ["no lines", { lines: null }],
      ["no mode", { requestedMode: null }],
      ["an unknown mode", { requestedMode: "cheque" }],
      ["an item as well", { item: ids.itemA }],
      ["a proposed name as well", { proposedName: "Ear wash" }],
      [
        "a new-item request with a refund mode",
        { kind: "new_item", proposedName: "Ear wash", lines: null },
      ],
      [
        "a repeat request with refund lines",
        { kind: "repeat_item", item: ids.itemA, requestedMode: null },
      ],
      ["a pending request with a credit note", { creditNote: ids.creditNote }],
      ["a pending request with an approved mode", { approvedMode: "cash" }],
    ];
    for (const [why, o] of missing)
      expect(await refused(addRequest, request(o)), why).toBe(REFUSED.rule);

    const whole = refundLines([
      { line_id: ids.lineA, quantity: 3 },
      { line_id: ids.lineB, quantity: 2.5 },
    ]);
    expect(await refused(addRequest, request({ lines: whole })), "a pending refund").toBeNull();
    expect(await refused(addRequest, request()), "a second pending refund on the bill").toBe(
      REFUSED.duplicate,
    );
    expect(
      await refused(addRequest, request({ status: "rejected" })),
      "a rejected refund beside it",
    ).toBeNull();

    const approved = (o) => request({ status: "approved", creditNote: ids.creditNote, ...o });
    const badApprovals = [
      ["approved with no mode", { approvedMode: null }],
      ["approved with no credit note", { approvedMode: "as_paid", creditNote: null }],
      ["a different mode with no reason", { approvedMode: "cash" }],
      ["a different mode with a blank reason", { approvedMode: "cash", modeReason: "  " }],
      [
        "a rejected refund with an approved mode",
        { status: "rejected", creditNote: null, approvedMode: "cash", modeReason: "x" },
      ],
      [
        "a reason with no approved mode",
        { status: "rejected", creditNote: null, modeReason: "Card can't be reversed" },
      ],
    ];
    for (const [why, o] of badApprovals)
      expect(await refused(addRequest, approved(o)), why).toBe(REFUSED.rule);
    expect(
      await refused(
        addRequest,
        approved({ creditNote: ids.otherInvoice, approvedMode: "as_paid" }),
      ),
      "a credit note that is really an invoice",
    ).toBe(REFUSED.missingParent);
    expect(
      await refused(
        addRequest,
        approved({
          bill: ids.otherInvoice,
          approvedMode: "as_paid",
          lines: refundLines([{ line_id: ids.otherLine, quantity: 1 }]),
        }),
      ),
      "a credit note against another bill",
    ).toBe(REFUSED.missingParent);
    expect(
      await refused(
        addRequest,
        approved({ approvedMode: "cash", modeReason: "The card can't be reversed" }),
      ),
      "approved in cash with the reason",
    ).toBeNull();
    expect(
      await refused(addRequest, approved({ approvedMode: "as_paid", status: "used" })),
      "the same credit note on a second request",
    ).toBe(REFUSED.duplicate);
    expect(
      await refused(
        addRequest,
        approved({ creditNote: ids.secondCreditNote, requestedMode: "upi", approvedMode: "upi" }),
      ),
      "approved the way it was asked",
    ).toBeNull();
    expect(
      await refused(`DELETE FROM bills WHERE id = $1`, [ids.secondCreditNote]),
      "deleting a credit note a request points at",
    ).toBe(REFUSED.stillUsed);
  });

  test("8. the CN series takes a bill_series row like MAIN and RCPT", async () => {
    expect(
      await db.refused(
        `INSERT INTO bill_series (series, fy, prefix, next_no) VALUES ('CN', '2031-32', 'CN/31-32/', 1)
         ON CONFLICT (series, fy) DO NOTHING`,
      ),
    ).toBeNull();
  });
});

test.describe.serial("P4B-02 two desks crediting the same line", () => {
  const tag = `P4B02R${Date.now()}`;
  const made = {};
  const pool = () => getPool();

  test.afterAll(async () => {
    const c = await pool().connect();
    try {
      await c.query("BEGIN");
      if (made.bills) {
        await c.query(
          `DELETE FROM bill_lines WHERE bill_id = ANY($1) AND credited_line_id IS NOT NULL`,
          [made.bills],
        );
        await c.query(`DELETE FROM bill_lines WHERE bill_id = ANY($1)`, [made.bills]);
        await c.query(`DELETE FROM bills WHERE id = ANY($1) AND bill_type = 'credit_note'`, [
          made.bills,
        ]);
        await c.query(`DELETE FROM bills WHERE id = ANY($1)`, [made.bills]);
      }
      if (made.item) await c.query(`DELETE FROM service_items WHERE id = $1`, [made.item]);
      if (made.subgroup)
        await c.query(`DELETE FROM service_subgroups WHERE id = $1`, [made.subgroup]);
      if (made.group) await c.query(`DELETE FROM service_groups WHERE id = $1`, [made.group]);
      if (made.visit) {
        await c.query(`DELETE FROM giniflow_visit_events WHERE visit_id = $1`, [made.visit]);
        await c.query(`DELETE FROM giniflow_visits WHERE id = $1`, [made.visit]);
      }
      if (made.patient) await c.query(`DELETE FROM patients WHERE id = $1`, [made.patient]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  });

  test("9. the second desk waits for the first and is refused once the line is used up", async () => {
    const setup = await pool().connect();
    try {
      const s = await seed(setup, tag);
      Object.assign(made, {
        patient: s.patient,
        visit: s.visit,
        group: s.group,
        subgroup: s.subgroup,
      });
      made.item = await s.item("A");
      const invoice = await finalBill(setup, {
        patient: s.patient,
        visit: s.visit,
        amount: 100,
        paid: 100,
        no: `${tag}/1`,
      });
      made.bills = [invoice];
      await setup.query(addLine, [null, invoice, s.visit, 1, made.item, true, null, 1]);
      for (const n of [1, 2])
        made.bills.push(
          await finalBill(setup, {
            patient: s.patient,
            visit: s.visit,
            original: invoice,
            amount: 100,
            no: `${tag}-CN/${n}`,
          }),
        );
    } finally {
      setup.release();
    }
    const original = (
      await pool().query(`SELECT id FROM bill_lines WHERE bill_id = $1`, [made.bills[0]])
    ).rows[0].id;
    const first = await pool().connect();
    const second = await pool().connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      await first.query(addLine, [
        null,
        made.bills[1],
        made.visit,
        1,
        made.item,
        false,
        original,
        1,
      ]);
      let settled = false;
      const waiting = second
        .query(addLine, [null, made.bills[2], made.visit, 1, made.item, false, original, 1])
        .then(
          () => null,
          (error) => error.code,
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled, "the second desk is still waiting on the first").toBe(false);
      await first.query("COMMIT");
      expect(await waiting).toBe(REFUSED.rule);
      await second.query("ROLLBACK");
      const { rows } = await pool().query(
        `SELECT sum(quantity)::text AS credited FROM bill_lines WHERE credited_line_id = $1`,
        [original],
      );
      expect(rows[0].credited).toBe("1.00");
    } finally {
      await first.query("ROLLBACK").catch(() => {});
      await second.query("ROLLBACK").catch(() => {});
      first.release();
      second.release();
    }
  });
});
