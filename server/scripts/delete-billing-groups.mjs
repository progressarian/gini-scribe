import "../loadEnv.js";
import pool from "../config/db.js";

const apply = process.argv.includes("--apply");
const withTestDrafts = process.argv.includes("--with-test-drafts");
const testBillNos = process.argv
  .filter((arg) => arg.startsWith("--with-test-bill="))
  .flatMap((arg) => arg.slice("--with-test-bill=".length).split(","))
  .map((no) => no.trim())
  .filter(Boolean);
const codes = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

if (!codes.length) {
  console.error(
    "usage: node scripts/delete-billing-groups.mjs <GROUP_CODE> [...] [--with-test-drafts] [--with-test-bill=<BILL_NO>[,<BILL_NO>]] [--apply]",
  );
  process.exit(1);
}

const target = new URL(process.env.DATABASE_URL);
console.log(`Database: ${target.hostname}:${target.port}${target.pathname}`);
console.log(
  apply ? "Mode: APPLY — rows will be deleted\n" : "Mode: dry run — nothing is deleted\n",
);

const client = await pool.connect();
let exitCode = 0;
try {
  await client.query("BEGIN");

  const { rows: groups } = await client.query(
    `SELECT id, code, name FROM service_groups WHERE lower(code) = ANY($1::text[]) ORDER BY code FOR UPDATE`,
    [codes.map((code) => code.toLowerCase())],
  );
  const found = new Set(groups.map((group) => group.code.toLowerCase()));
  const missing = codes.filter((code) => !found.has(code.toLowerCase()));
  if (missing.length) console.log(`Not found (skipped): ${missing.join(", ")}`);
  if (!groups.length) throw new Error("No matching group — nothing to do");

  const groupIds = groups.map((group) => group.id);
  const { rows: subgroups } = await client.query(
    `SELECT id, code, name FROM service_subgroups WHERE group_id = ANY($1) ORDER BY code FOR UPDATE`,
    [groupIds],
  );
  const subgroupIds = subgroups.map((subgroup) => subgroup.id);
  const { rows: items } = await client.query(
    `SELECT id, code, name FROM service_items WHERE subgroup_id = ANY($1) ORDER BY code FOR UPDATE`,
    [subgroupIds],
  );
  const itemIds = items.map((item) => item.id);

  console.log("Groups:");
  groups.forEach((group) => console.log(`  ${group.code} — ${group.name}`));
  console.log("Subgroups:");
  subgroups.forEach((subgroup) => console.log(`  ${subgroup.code} — ${subgroup.name}`));
  console.log("Items:");
  items.forEach((item) => console.log(`  ${item.code} — ${item.name}`));

  const blockers = [];
  let testBills = [];
  if (testBillNos.length) {
    ({ rows: testBills } = await client.query(
      `SELECT b.id, b.bill_no, b.status, b.bill_date::text AS day, b.patient_payable, b.claim_status,
              b.claim_settlement_id, p.name AS patient, p.file_no
         FROM bills b JOIN patients p ON p.id = b.patient_id
        WHERE b.bill_no = ANY($1::text[]) AND b.bill_type = 'invoice'
        ORDER BY b.bill_no FOR UPDATE OF b`,
      [testBillNos],
    ));
    const known = new Set(testBills.map((bill) => bill.bill_no));
    testBillNos
      .filter((no) => !known.has(no))
      .forEach((no) => blockers.push(`test bill ${no} was not found`));
    console.log("\nTest bills to delete (with lines, payments and receipts):");
    for (const bill of testBills) {
      const { rows: paid } = await client.query(
        `SELECT receipt_no, mode, amount, direction, shift_id FROM payments WHERE bill_id = $1 ORDER BY received_at`,
        [bill.id],
      );
      const { rows: lines } = await client.query(
        `SELECT string_agg(DISTINCT COALESCE(bill_name, ''), ', ') AS names FROM bill_lines WHERE bill_id = $1`,
        [bill.id],
      );
      console.log(
        `  ${bill.bill_no} · ${bill.status} · ${bill.day} · ${bill.patient} (${bill.file_no || "no file no"}) · ₹${bill.patient_payable} · ${lines[0].names || "no lines"}`,
      );
      paid.forEach((payment) =>
        console.log(
          `    ${payment.direction === "out" ? "refund" : "receipt"} ${payment.receipt_no || "—"} · ${payment.mode} · ₹${payment.amount}${payment.shift_id ? " · in a cash shift (its totals drop)" : ""}`,
        ),
      );
    }
    const testIds = testBills.map((bill) => bill.id);
    const { rows: notes } = await client.query(
      `SELECT bill_no FROM bills WHERE original_bill_id = ANY($1::uuid[])`,
      [testIds],
    );
    notes.forEach((note) =>
      blockers.push(
        `credit note ${note.bill_no || "(draft)"} is against a test bill — delete it first`,
      ),
    );
    const { rows: settled } = await client.query(
      `SELECT DISTINCT b.bill_no FROM claim_settlement_bills s JOIN bills b ON b.id = s.bill_id
        WHERE s.bill_id = ANY($1::uuid[]) AND s.voided_at IS NULL`,
      [testIds],
    );
    settled.forEach((row) =>
      blockers.push(`${row.bill_no} is cleared in the CGHS register — undo that payment first`),
    );
  }
  const testBillIds = testBills.map((bill) => bill.id);

  const { rows: billed } = await client.query(
    `SELECT i.code, COUNT(*)::int AS lines, array_agg(DISTINCT COALESCE(b.bill_no, 'draft')) AS bills
       FROM bill_lines l JOIN service_items i ON i.id = l.service_item_id JOIN bills b ON b.id = l.bill_id
      WHERE l.service_item_id = ANY($1) AND ($2::boolean IS FALSE OR b.status <> 'draft')
        AND NOT (b.id = ANY($3::uuid[]))
      GROUP BY i.code ORDER BY i.code`,
    [itemIds, withTestDrafts, testBillIds],
  );
  billed.forEach((row) =>
    blockers.push(`${row.code} is on ${row.lines} bill line(s) (bills: ${row.bills.join(", ")})`),
  );

  let drafts = [];
  if (withTestDrafts) {
    ({ rows: drafts } = await client.query(
      `SELECT b.id, b.bill_date::text AS day, p.name AS patient, p.file_no,
              (SELECT COUNT(*)::int FROM payments x WHERE x.bill_id = b.id) AS payments,
              (SELECT string_agg(DISTINCT COALESCE(l2.bill_name, i2.name), ', ')
                 FROM bill_lines l2 LEFT JOIN service_items i2 ON i2.id = l2.service_item_id
                WHERE l2.bill_id = b.id) AS lines
         FROM bills b JOIN patients p ON p.id = b.patient_id
        WHERE b.status = 'draft'
          AND EXISTS (SELECT 1 FROM bill_lines l WHERE l.bill_id = b.id AND l.service_item_id = ANY($1))
        ORDER BY b.bill_date, b.id FOR UPDATE OF b`,
      [itemIds],
    ));
    console.log("\nTest draft bills to delete (with all their lines):");
    if (!drafts.length) console.log("  none");
    drafts.forEach((draft) =>
      console.log(
        `  ${draft.id.slice(0, 8)} · ${draft.day} · ${draft.patient} (${draft.file_no || "no file no"}) · ${draft.lines || "no lines"}`,
      ),
    );
    drafts
      .filter((draft) => draft.payments > 0)
      .forEach((draft) =>
        blockers.push(
          `draft ${draft.id.slice(0, 8)} (${draft.patient}) has ${draft.payments} payment(s) — money was taken, so it is not only a test`,
        ),
      );
    const { rows: others } = await client.query(
      `SELECT COUNT(*)::int AS n FROM billing_requests WHERE credit_note_id = ANY($1::uuid[])`,
      [drafts.map((draft) => draft.id)],
    );
    if (others[0].n) blockers.push(`${others[0].n} refund request(s) point at these drafts`);
  }
  const draftIds = drafts.map((draft) => draft.id);

  const { rows: requests } = await client.query(
    `SELECT id, kind, status FROM billing_requests
      WHERE service_item_id = ANY($1) OR created_item_id = ANY($1) OR bill_id = ANY($2::uuid[])`,
    [itemIds, [...draftIds, ...testBillIds]],
  );
  if (requests.length && !withTestDrafts && !testBillIds.length) {
    blockers.push(`${requests.length} desk request(s) refer to these items`);
  } else if (requests.length) {
    console.log(
      `\nDesk requests to delete: ${requests.map((r) => `${r.kind} (${r.status})`).join(", ")}`,
    );
  }
  const { rows: discounts } = await client.query(
    `SELECT name FROM discount_rules
      WHERE group_ids && $1::int[] OR subgroup_ids && $2::int[] OR service_item_ids && $3::int[]`,
    [groupIds, subgroupIds, itemIds],
  );
  discounts.forEach((row) => blockers.push(`discount "${row.name}" targets one of these`));

  const { rows: rates } = await client.query(
    `SELECT COUNT(*)::int AS n FROM category_item_rates WHERE service_item_id = ANY($1)`,
    [itemIds],
  );
  const { rows: rules } = await client.query(
    `SELECT COUNT(*)::int AS n FROM category_payment_rules
      WHERE group_id = ANY($1) OR subgroup_id = ANY($2) OR service_item_id = ANY($3)`,
    [groupIds, subgroupIds, itemIds],
  );
  console.log(
    `\nAlso removed with them: ${rates[0].n} category rate(s), ${rules[0].n} payment rule(s)`,
  );

  if (blockers.length) {
    console.log("\nREFUSED — these must be dealt with first (nothing was deleted):");
    blockers.forEach((blocker) => console.log(`  - ${blocker}`));
    await client.query("ROLLBACK");
    exitCode = 2;
  } else if (!apply) {
    console.log("\nDry run only. Re-run with --apply to delete.");
    await client.query("ROLLBACK");
  } else {
    const billIds = [...draftIds, ...testBillIds];
    if (billIds.length) {
      await client.query(
        `DELETE FROM bill_line_discounts
          WHERE bill_line_id IN (SELECT id FROM bill_lines WHERE bill_id = ANY($1::uuid[]))`,
        [billIds],
      );
      await client.query(`DELETE FROM bill_lines WHERE bill_id = ANY($1::uuid[])`, [billIds]);
    }
    const requestIds = requests.map((request) => request.id);
    if (requestIds.length) {
      await client.query(`DELETE FROM billing_requests WHERE id = ANY($1)`, [requestIds]);
    }
    if (testBillIds.length) {
      await client.query(`DELETE FROM payments WHERE bill_id = ANY($1::uuid[])`, [testBillIds]);
    }
    if (billIds.length) {
      await client.query(`DELETE FROM bills WHERE id = ANY($1::uuid[])`, [billIds]);
    }
    await client.query(`DELETE FROM category_item_rates WHERE service_item_id = ANY($1)`, [
      itemIds,
    ]);
    await client.query(
      `DELETE FROM category_payment_rules
        WHERE group_id = ANY($1) OR subgroup_id = ANY($2) OR service_item_id = ANY($3)`,
      [groupIds, subgroupIds, itemIds],
    );
    const deletedItems = await client.query(`DELETE FROM service_items WHERE id = ANY($1)`, [
      itemIds,
    ]);
    const deletedSubgroups = await client.query(
      `DELETE FROM service_subgroups WHERE id = ANY($1)`,
      [subgroupIds],
    );
    const deletedGroups = await client.query(`DELETE FROM service_groups WHERE id = ANY($1)`, [
      groupIds,
    ]);
    await client.query("COMMIT");
    console.log(
      `\nDeleted ${deletedGroups.rowCount} group(s), ${deletedSubgroups.rowCount} subgroup(s), ${deletedItems.rowCount} item(s), ${draftIds.length} test draft bill(s), ${testBillIds.length} test bill(s) with their payments, ${requests.length} desk request(s).`,
    );
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`\nFailed, nothing deleted: ${error.message}`);
  exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
process.exit(exitCode);
