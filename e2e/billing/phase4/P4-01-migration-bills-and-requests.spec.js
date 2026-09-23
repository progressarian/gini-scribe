import { test, expect } from "@playwright/test";
import {
  AUDIT_COLUMNS,
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

const SQL = readMigration("2026-10-17_billing_bills.sql");
const BILLS = "bills";
const REQUESTS = "billing_requests";

const BILL_COLUMNS = [
  "id",
  "bill_no",
  "series",
  "fy",
  "bill_type",
  "original_bill_id",
  "patient_id",
  "visit_id",
  "appointment_id",
  "bill_date",
  "status",
  "scheme_code",
  "scheme_label",
  "payer_name",
  "scheme_ref_enc",
  "referral_no_enc",
  "referral_doc_id",
  "patient_age",
  "pay_later",
  "actual_amount",
  "discount_amount",
  "tax_amount",
  "patient_payable",
  "claim_amount",
  "adjustment_amount",
  "round_off",
  "paid_amount",
  "claim_status",
  "claim_settlement_id",
  "version",
  "finalised_by",
  "finalised_at",
  "cancelled_by",
  "cancelled_at",
  "cancel_reason",
  ...AUDIT_COLUMNS,
];

const REQUEST_COLUMNS = [
  "id",
  "kind",
  "patient_id",
  "visit_id",
  "bill_id",
  "service_item_id",
  "proposed_name",
  "proposed_group",
  "reason",
  "status",
  "requested_by",
  "requested_at",
  "decided_by",
  "decided_at",
  "decision_note",
  "created_item_id",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
];

let db = null;
const ids = {};

const addBill = `INSERT INTO bills
  (patient_id, visit_id, appointment_id, bill_no, series, fy, bill_type, original_bill_id,
   bill_date, status, scheme_code, patient_age, claim_amount, claim_status, claim_settlement_id,
   round_off, finalised_at, cancelled_at, cancel_reason, actual_amount, patient_payable,
   paid_amount, referral_doc_id)
  VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'invoice'), $8, COALESCE($9::date, CURRENT_DATE),
          COALESCE($10, 'draft'), $11, $12, COALESCE($13::numeric, 0), COALESCE($14, 'none'), $15,
          COALESCE($16::numeric, 0), $17, $18, $19, COALESCE($20::numeric, 0),
          COALESCE($21::numeric, 0), COALESCE($22::numeric, 0), $23)`;

const bill = (o = {}) => [
  o.patient ?? ids.patient,
  o.visit ?? ids.visit,
  o.appointment ?? null,
  o.no ?? null,
  o.series ?? null,
  o.fy ?? null,
  o.type ?? null,
  o.original ?? null,
  o.date ?? null,
  o.status ?? null,
  o.scheme ?? null,
  o.age ?? null,
  o.claim ?? null,
  o.claimStatus ?? null,
  o.settlement ?? null,
  o.roundOff ?? null,
  o.finalisedAt ?? null,
  o.cancelledAt ?? null,
  o.cancelReason ?? null,
  o.actual ?? o.claim ?? null,
  o.payable ?? null,
  o.paid ?? null,
  o.referralDoc ?? null,
];

const spare = () => ids.spareVisits.pop();

const addRequest = `INSERT INTO billing_requests
  (kind, patient_id, visit_id, bill_id, service_item_id, proposed_name, reason, status,
   decided_at, created_item_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'pending'), $9, $10)`;

const request = (o = {}) => [
  o.kind ?? "new_item",
  o.patient ?? ids.patient,
  o.visit === "" ? null : (o.visit ?? ids.visit),
  o.bill ?? null,
  o.item ?? null,
  o.name === "" ? null : (o.name ?? (o.kind === "repeat_item" ? null : "Knee brace")),
  o.reason ?? "Second X-ray, other knee, per Dr Gill",
  o.status ?? null,
  o.decidedAt ?? null,
  o.createdItem ?? null,
];

test.describe.serial("P4-01 migration: bills and requests", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
    const { client } = db;
    const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
    ids.patient = (
      await one(`INSERT INTO patients (name) VALUES ('P401 Patient') RETURNING id`)
    ).id;
    ids.otherPatient = (
      await one(`INSERT INTO patients (name) VALUES ('P401 Other') RETURNING id`)
    ).id;
    ids.visit = (
      await one(`INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [ids.patient])
    ).id;
    ids.otherVisit = (
      await one(`INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [
        ids.otherPatient,
      ])
    ).id;
    ids.spareVisits = (
      await client.query(
        `INSERT INTO giniflow_visits (patient_id, visit_date)
         SELECT $1, CURRENT_DATE - n FROM generate_series(1, 8) AS n RETURNING id`,
        [ids.patient],
      )
    ).rows.map((r) => r.id);
    ids.document = (
      await one(
        `INSERT INTO documents (patient_id, doc_type, title) VALUES ($1, 'referral', 'CGHS form')
         RETURNING id`,
        [ids.patient],
      )
    ).id;
    ids.appointment = (
      await one(
        `INSERT INTO appointments (patient_name, appointment_date)
         VALUES ('P401 Patient', CURRENT_DATE) RETURNING id`,
      )
    ).id;
    await one(
      `INSERT INTO patient_schemes (code, label) VALUES ('p401_cghs', 'CGHS P401') RETURNING code`,
    );
    ids.group = (
      await one(
        `INSERT INTO service_groups (code, name) VALUES ('P401-G', 'Radiology') RETURNING id`,
      )
    ).id;
    ids.subgroup = (
      await one(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, 'P401-S', 'X-ray') RETURNING id`,
        [ids.group],
      )
    ).id;
    ids.item = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
         VALUES ('P401-I', 'X-ray knee', $1, 400, 'procedure') RETURNING id`,
        [ids.subgroup],
      )
    ).id;
  });

  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file creates the bill tables, inserts no rows and has no comments", () => {
    expect(tablesCreatedBy(SQL)).toEqual(
      expect.arrayContaining([
        BILLS,
        REQUESTS,
        "bill_lines",
        "bill_line_discounts",
        "payments",
        "cash_shifts",
      ]),
    );
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. it runs twice and both tables have exactly the planned columns", async () => {
    expect(await columnsOf(db.client, BILLS)).toEqual([...BILL_COLUMNS].sort());
    expect(await columnsOf(db.client, REQUESTS)).toEqual([...REQUEST_COLUMNS].sort());
  });

  test("3. the bill number is unique and the register, day and visit lookups are indexed", async () => {
    const indexes = await indexesOf(db.client, [BILLS, REQUESTS]);
    expect(indexes.bills_bill_no_key).toMatch(
      /UNIQUE INDEX .*\(bill_no\) WHERE \(bill_no IS NOT NULL\)/,
    );
    expect(indexes.bills_claim_idx).toMatch(/\(claim_status, bill_date\)/);
    expect(indexes.bills_day_idx).toMatch(/\(bill_date, status\)/);
    expect(indexes.bills_visit_idx).toMatch(/\(visit_id\)/);
    expect(indexes.bills_patient_idx).toMatch(/\(patient_id, bill_date\)/);
    expect(indexes.bills_visit_draft_key, "one open draft per visit").toMatch(
      /UNIQUE INDEX .*\(visit_id\) WHERE \(\(status = 'draft'::text\) AND \(bill_type = 'invoice'::text\)\)/,
    );
    expect(indexes.bills_dues_idx, "the dues list").toMatch(
      /\(bill_date\) WHERE \(\(status = 'final'::text\) AND \(paid_amount < patient_payable\)\)/,
    );
    expect(indexes.bills_id_visit_key, "a line can only join its own bill's visit").toMatch(
      /UNIQUE INDEX .*\(id, visit_id\)/,
    );
    expect(indexes.billing_requests_pending_idx).toMatch(
      /\(requested_at\) WHERE \(status = 'pending'/,
    );
  });

  test("4. RLS is on and forced, and anon/authenticated have no access", async () => {
    const { rls, publicGrants } = await lockdownOf(db.client, [BILLS, REQUESTS]);
    expect(rls.sort((a, b) => a.relname.localeCompare(b.relname))).toEqual([
      { relname: REQUESTS, relrowsecurity: true, relforcerowsecurity: true },
      { relname: BILLS, relrowsecurity: true, relforcerowsecurity: true },
    ]);
    expect(publicGrants).toEqual([]);
  });

  test("5. no bills or requests are seeded", async () => {
    for (const table of [BILLS, REQUESTS]) {
      expect(
        (await db.client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
        table,
      ).toBe(0);
    }
  });

  test("6. the allowed values are the planned ones", async () => {
    expect(await allowedValuesOf(db.client, BILLS, "status")).toEqual([
      "cancelled",
      "draft",
      "final",
    ]);
    expect(await allowedValuesOf(db.client, BILLS, "bill_type")).toEqual([
      "credit_note",
      "invoice",
    ]);
    expect(await allowedValuesOf(db.client, BILLS, "claim_status")).toEqual([
      "cleared",
      "none",
      "pending",
    ]);
    expect(await allowedValuesOf(db.client, REQUESTS, "kind")).toEqual(["new_item", "repeat_item"]);
    expect(await allowedValuesOf(db.client, REQUESTS, "status")).toEqual([
      "approved",
      "pending",
      "rejected",
      "used",
    ]);
  });

  test("7. a new bill starts as a draft with no number and everything at zero", async () => {
    const { rows } = await db.client.query(
      `INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2)
       RETURNING status, bill_no, bill_type, pay_later, version, claim_status,
                 actual_amount, discount_amount, tax_amount, patient_payable, claim_amount,
                 adjustment_amount, round_off, paid_amount,
                 bill_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS india_today`,
      [ids.patient, ids.otherVisit],
    );
    expect(rows[0]).toEqual({
      status: "draft",
      bill_no: null,
      bill_type: "invoice",
      pay_later: false,
      version: 0,
      claim_status: "none",
      actual_amount: "0.00",
      discount_amount: "0.00",
      tax_amount: "0.00",
      patient_payable: "0.00",
      claim_amount: "0.00",
      adjustment_amount: "0.00",
      round_off: "0.00",
      paid_amount: "0.00",
      india_today: true,
    });
  });

  test("8. the bill rules hold", async () => {
    const { refused } = db;
    const finalised = {
      status: "final",
      no: "GAC/26-27/000001",
      series: "MAIN",
      fy: "2026-27",
      finalisedAt: "2026-09-23T10:00:00Z",
    };
    expect(await refused(addBill, bill(finalised)), "a finalised bill").toBeNull();
    expect(
      await refused(addBill, bill({ ...finalised, no: "GAC/26-27/000001" })),
      "the same bill number twice",
    ).toBe(REFUSED.duplicate);

    const bad = [
      ["an unknown status", { status: "sent" }],
      ["an unknown bill type", { type: "estimate" }],
      ["a draft with a number", { no: "GAC/26-27/000002" }],
      ["a final bill with no number", { ...finalised, no: null }],
      ["a final bill with no series", { ...finalised, no: "N2", series: null }],
      ["a final bill never finalised", { ...finalised, no: "N3", finalisedAt: null }],
      [
        "a cancelled bill with no reason",
        { status: "cancelled", cancelledAt: "2026-09-23T10:00:00Z" },
      ],
      ["a cancelled bill with no time", { status: "cancelled", cancelReason: "Wrong patient" }],
      ["a credit note with no original", { type: "credit_note" }],
      ["a cleared claim with no settlement", { claim: 100, claimStatus: "cleared" }],
      ["a pending claim of nothing", { claimStatus: "pending" }],
      ["a settlement on an unclaimed bill", { settlement: "00000000-0000-0000-0000-000000000001" }],
      ["an impossible age", { age: 151 }],
      ["a negative age", { age: -1 }],
      ["a round off that rounds a rupee", { roundOff: 0.51 }],
      ["a round off below the half rupee", { roundOff: -0.5 }],
      ["an unknown claim status", { claimStatus: "paid" }],
      ["totals that don't add up", { actual: 1000, payable: 100 }],
      ["a round-off that isn't in the payable", { actual: 1000, payable: 1000, roundOff: 0.4 }],
      ["more paid than the bill comes to", { actual: 700, payable: 700, paid: 800 }],
      ["money paid on a bill of nothing", { paid: 100 }],
    ];
    for (const [why, o] of bad) expect(await refused(addBill, bill(o)), why).toBe(REFUSED.rule);

    expect(await refused(addBill, bill({ patient: 0 })), "no such patient").toBe(
      REFUSED.missingParent,
    );
    expect(
      await refused(addBill, bill({ visit: "00000000-0000-0000-0000-000000000009" })),
      "no such visit",
    ).toBe(REFUSED.missingParent);
    expect(await refused(addBill, bill({ scheme: "p401_nope" })), "no such category").toBe(
      REFUSED.missingParent,
    );
    expect(
      await refused(`INSERT INTO bills (patient_id) VALUES ($1)`, [ids.patient]),
      "a bill with no visit",
    ).toBe("23502");

    expect(
      await refused(
        addBill,
        bill({
          scheme: "p401_cghs",
          appointment: ids.appointment,
          age: 62,
          referralDoc: ids.document,
          visit: spare(),
        }),
      ),
      "a CGHS bill on an appointment, with its referral scan",
    ).toBeNull();
    expect(
      await refused(addBill, bill({ referralDoc: 0, visit: spare() })),
      "a referral scan that doesn't exist",
    ).toBe(REFUSED.missingParent);
    expect(
      await refused(addBill, bill({ claim: 300, claimStatus: "pending", visit: spare() })),
      "a claim waiting to be sent",
    ).toBeNull();
    expect(
      await refused(
        addBill,
        bill({
          claim: 300,
          claimStatus: "cleared",
          settlement: "00000000-0000-0000-0000-000000000002",
          visit: spare(),
        }),
      ),
      "a cleared claim",
    ).toBeNull();
    expect(
      await refused(
        addBill,
        bill({
          status: "cancelled",
          cancelledAt: "2026-09-23T10:00:00Z",
          cancelReason: "Wrong patient",
        }),
      ),
      "a cancelled bill",
    ).toBeNull();
    expect(
      await refused(
        addBill,
        bill({ actual: 1250.5, payable: 1251, roundOff: 0.5, paid: 1251, visit: spare() }),
      ),
      "a rounded-up bill paid in full",
    ).toBeNull();
  });

  test("8a. a visit has one open draft, and the desk can bill it again once that draft is done", async () => {
    const { client, refused } = db;
    const visit = spare();
    const first = (
      await client.query(`INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`, [
        ids.patient,
        visit,
      ])
    ).rows[0].id;
    expect(await refused(addBill, bill({ visit })), "a second draft while the first is open").toBe(
      REFUSED.duplicate,
    );
    await client.query(
      `UPDATE bills SET status = 'final', bill_no = 'GAC/26-27/000900', series = 'MAIN',
                        fy = '2026-27', finalised_at = NOW() WHERE id = $1`,
      [first],
    );
    expect(
      await refused(addBill, bill({ visit })),
      "a fresh draft for the tests ordered later",
    ).toBeNull();
  });

  test("8b. a referral scan can be tidied away without taking the bill with it", async () => {
    const { client } = db;
    const visit = spare();
    const { rows } = await client.query(
      `INSERT INTO bills (patient_id, visit_id, referral_doc_id) VALUES ($1, $2, $3) RETURNING id`,
      [ids.patient, visit, ids.document],
    );
    await client.query(`DELETE FROM documents WHERE id = $1`, [ids.document]);
    expect(
      (await client.query(`SELECT referral_doc_id FROM bills WHERE id = $1`, [rows[0].id])).rows[0],
    ).toEqual({ referral_doc_id: null });
  });

  test("9. a credit note points at a real bill and never at itself", async () => {
    const { rows } = await db.client.query(
      `INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`,
      [ids.patient, ids.visit],
    );
    expect(
      await db.refused(addBill, bill({ type: "credit_note", original: rows[0].id })),
    ).toBeNull();
    expect(
      await db.refused(
        addBill,
        bill({ type: "credit_note", original: "00000000-0000-0000-0000-000000000003" }),
      ),
      "a credit note of a bill that doesn't exist",
    ).toBe(REFUSED.missingParent);
    expect(
      await db.refused(addBill, bill({ type: "invoice", original: rows[0].id })),
      "an invoice that cancels another bill",
    ).toBe(REFUSED.rule);
    expect(
      await db.refused(
        `UPDATE bills SET original_bill_id = id, bill_type = 'credit_note'
                         WHERE id = $1`,
        [rows[0].id],
      ),
      "its own credit note",
    ).toBe(REFUSED.rule);
  });

  test("10. the request rules hold", async () => {
    const { refused } = db;
    const bad = [
      ["an unknown kind", { kind: "new_price" }],
      ["an unknown status", { status: "maybe", decidedAt: "2026-09-23T10:00:00Z" }],
      ["a blank reason", { reason: "  " }],
      ["a repeat with no item", { kind: "repeat_item" }],
      ["a repeat with a proposed name", { kind: "repeat_item", item: ids.item, name: "Another" }],
      ["a repeat for no visit in particular", { kind: "repeat_item", item: ids.item, visit: "" }],
      ["a new item with no name", { kind: "new_item", name: "" }],
      ["a new item pointing at an item", { kind: "new_item", item: ids.item }],
      ["a blank proposed name", { name: " " }],
      ["a decision with no time", { status: "approved" }],
      [
        "an item created for a repeat",
        {
          kind: "repeat_item",
          item: ids.item,
          createdItem: ids.item,
          status: "approved",
          decidedAt: "2026-09-23T10:00:00Z",
        },
      ],
      ["an item created while pending", { createdItem: ids.item }],
    ];
    for (const [why, o] of bad)
      expect(await refused(addRequest, request(o)), why).toBe(REFUSED.rule);

    expect(await refused(addRequest, request()), "a new-item request").toBeNull();
    expect(
      await refused(addRequest, request({ kind: "repeat_item", item: ids.item })),
      "a repeat request",
    ).toBeNull();
    expect(
      await refused(
        addRequest,
        request({ status: "approved", decidedAt: "2026-09-23T10:00:00Z", createdItem: ids.item }),
      ),
      "an approved new item",
    ).toBeNull();
    expect(
      await refused(addRequest, request({ item: ids.item, kind: "repeat_item", bill: null })),
    ).toBeNull();
  });

  test("11. a patient, visit, category or item a bill or request uses can't be deleted", async () => {
    const { refused } = db;
    expect(await refused(`DELETE FROM patient_schemes WHERE code = 'p401_cghs'`)).toBe(
      REFUSED.stillUsed,
    );
    expect(await refused(`DELETE FROM patients WHERE id = $1`, [ids.patient])).toBe(
      REFUSED.stillUsed,
    );
    expect(await refused(`DELETE FROM giniflow_visits WHERE id = $1`, [ids.visit])).toBe(
      REFUSED.stillUsed,
    );
    expect(await refused(`DELETE FROM service_items WHERE id = $1`, [ids.item])).toBe(
      REFUSED.stillUsed,
    );
  });
});

test.describe.serial("P4-01 where-is-it-used", () => {
  test("12. a category a bill is billed as, and an item a request names, are counted", async () => {
    const { USAGE_KINDS, whereUsed } = await import("../../../server/services/billing/usage.js");
    const links = Object.values(USAGE_KINDS).flatMap((kind) =>
      kind.uses
        .filter((use) => ["bills", "billing_requests"].includes(use.table))
        .map((use) => `${kind.table}<-${use.table}.${use.column}`),
    );
    expect(links.sort()).toEqual([
      "patient_schemes<-bills.scheme_code",
      "service_items<-billing_requests.created_item_id",
      "service_items<-billing_requests.service_item_id",
    ]);

    const fresh = await openFreshCopy(SQL);
    try {
      const { client } = fresh;
      const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
      await one(`INSERT INTO patient_schemes (code, label) VALUES ('p401_u', 'CGHS Paid')`);
      const patient = (await one(`INSERT INTO patients (name) VALUES ('P401 U') RETURNING id`)).id;
      const visit = (
        await one(`INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [patient])
      ).id;
      const group = (
        await one(`INSERT INTO service_groups (code, name) VALUES ('P401-U', 'Lab U') RETURNING id`)
      ).id;
      const subgroup = (
        await one(
          `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, 'P401-US', 'Bio') RETURNING id`,
          [group],
        )
      ).id;
      const item = (
        await one(
          `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
           VALUES ('P401-UI', 'Sugar fasting', $1, 100, 'procedure') RETURNING id`,
          [subgroup],
        )
      ).id;
      await client.query(
        `INSERT INTO bills (patient_id, visit_id, scheme_code) VALUES ($1, $2, 'p401_u')`,
        [patient, visit],
      );
      await client.query(
        `INSERT INTO billing_requests (kind, patient_id, visit_id, service_item_id, reason)
         VALUES ('repeat_item', $1, $2, $3, 'Second sample')`,
        [patient, visit, item],
      );
      expect((await whereUsed("category", "p401_u", client)).uses.map((u) => u.text)).toEqual([
        "1 bill is billed as CGHS Paid",
      ]);
      expect((await whereUsed("item", item, client)).uses.map((u) => u.text)).toEqual([
        "1 request asks to bill Sugar fasting again",
      ]);
    } finally {
      await fresh.close();
    }
  });
});
