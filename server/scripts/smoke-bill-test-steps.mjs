import "../loadEnv.js";
import pool from "../config/db.js";
import { getMachines } from "../services/giniflow/machineCatalog.js";
import { transactionsToBilling } from "../services/healthray/billingExtractor.js";
import {
  keepEverySeenItem,
  billedStepIds,
  reconcileTestSteps,
  repricePaidOrdersFromBill,
  stepsAllowedByBill,
} from "../services/giniflow/patientBill.js";
import { billSuppressor } from "../services/giniflow/testCancel.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const machines = await getMachines(pool);
const bill = (items, status = "billed") => ({ status, items, readAt: new Date().toISOString() });
const consult = { desc: "CONSULTATION", category: "consultation", amount: 800 };
const echoLine = { desc: "2D ECHO", category: "other", amount: 1100 };
const labLine = { desc: "HBA1C", category: "lab", amount: 450 };
const ids = (steps) => steps.map((s) => s.catalogId).join(",");

const plan = [
  { catalogId: "billing", source: "template" },
  { catalogId: "vitals", source: "template" },
  { catalogId: "lab_billing", source: "template" },
  { catalogId: "blood_sample", source: "template" },
  { catalogId: "abi", machine: true, source: "template" },
  { catalogId: "vpt", machine: true, source: "template" },
  { catalogId: "fundus", machine: true, source: "added" },
  { catalogId: "mo_assessment", source: "template" },
  { name: "Custom stop", source: "custom" },
];

console.log("what the bill allows");

check(
  "2D ECHO on the bill counts as the Echo machine",
  [...billedStepIds(bill([echoLine]), machines)].join(",") === "echo",
);
check(
  "a lab line allows both lab steps",
  ["lab_billing", "blood_sample"].every((id) => billedStepIds(bill([labLine]), machines).has(id)),
);
check(
  "consultation-only bill: template test steps leave; the desk's own addition and other steps stay",
  ids(stepsAllowedByBill(plan, bill([consult]), machines)) ===
    "billing,vitals,fundus,mo_assessment,",
  ids(stepsAllowedByBill(plan, bill([consult]), machines)),
);
check(
  "lab on the bill: lab steps stay, unbilled machines leave",
  ids(stepsAllowedByBill(plan, bill([consult, labLine]), machines)) ===
    "billing,vitals,lab_billing,blood_sample,fundus,mo_assessment,",
);
check(
  "no bill yet: the journey is left exactly as it is",
  stepsAllowedByBill(plan, bill([], "no_bill"), machines) === plan,
);
check(
  "bill unknown (HealthRay blocked): left as it is",
  stepsAllowedByBill(plan, { status: "unknown", items: [] }, machines) === plan,
);
check(
  "a step already merged from the bill is never dropped",
  ids(
    stepsAllowedByBill(
      [{ catalogId: "echo", machine: true, source: "auto", billedIn: "healthray" }],
      bill([consult]),
      machines,
    ),
  ) === "echo",
);

console.log("\ntwo bills in one day");

const txn = (appointmentId, date, items) => ({
  appointment_id: appointmentId,
  billing_date: date,
  invoice_no: `INV-${items[0].name}`,
  billing_items: items.map((i) => ({ ...i, net_price: 500 })),
});
const firstBill = txn(111, "2026-09-16", [
  { name: "CONSULTATION", category_type: "OPD" },
  { name: "ABI", category_type: "MACHINE TEST" },
]);
const echoBill = txn(null, "2026-09-16", [{ name: "2D ECHO", category_type: "RADIOLOGY" }]);
const otherDay = txn(null, "2026-09-15", [{ name: "VPT", category_type: "MACHINE TEST" }]);
const wholeDay = transactionsToBilling([firstBill, echoBill, otherDay], {
  appointmentId: 111,
  date: "2026-09-16",
  wholeDay: true,
}).billing.items.map((i) => i.desc);
check(
  "a whole-day read takes the appointment's bill and the separate Echo bill, not yesterday's",
  wholeDay.join(",") === "CONSULTATION,ABI,2D ECHO",
  wholeDay.join(","),
);
check(
  "the old one-appointment read (flow.js) is unchanged",
  transactionsToBilling([firstBill, echoBill], { appointmentId: 111, date: "2026-09-16" })
    .billing.items.map((i) => i.desc)
    .join(",") === "CONSULTATION,ABI",
);
const firstItems = [
  { desc: "ABI", category: "machine", amount: 500, itemId: 1, invoice: "INV-1" },
  { desc: "CONSULTATION", category: "consultation", amount: 800, itemId: 2, invoice: "INV-1" },
];
const secondRead = [
  { desc: "2D ECHO", category: "imaging", amount: 1100, itemId: 3, invoice: "INV-2" },
  { desc: "abi ", category: "machine", amount: 0, itemId: 4, invoice: "INV-2" },
];
const merged = keepEverySeenItem(firstItems, secondRead);
check(
  "a later read with only the Echo keeps ABI from the first bill",
  merged.some((i) => i.desc === "ABI") && merged.some((i) => i.desc === "2D ECHO"),
  merged.map((i) => i.desc).join(","),
);
check(
  "a same-name line on another invoice does not overwrite the first bill's line",
  merged.find((i) => i.itemId === 1)?.amount === 500,
);
check(
  "so both ABI and Echo count as billed",
  ["abi", "echo"].every((id) => billedStepIds(bill(merged), machines).has(id)),
);

const pairsFailing = [];
for (const first of machines) {
  for (const later of machines) {
    if (first.id === later.id) continue;
    const kept = keepEverySeenItem(
      [{ desc: first.tests[0], category: "machine", amount: 100 }],
      [{ desc: later.tests[0], category: "machine", amount: 200 }],
    );
    const billedIds = billedStepIds(bill(kept), machines);
    if (!billedIds.has(first.id) || !billedIds.has(later.id)) {
      pairsFailing.push(`${first.id}→${later.id}`);
    }
  }
}
check(
  `every machine pair (${machines.length} machines): the first bill's test stays when a later bill adds another`,
  pairsFailing.length === 0,
  pairsFailing.join(", "),
);
const labKept = keepEverySeenItem(
  [{ desc: "HBA1C", category: "lab", amount: 450 }],
  [{ desc: "LIPID PROFILE", category: "lab", amount: 700 }],
);
check(
  "lab tests: the first bill's HbA1c stays when a later bill adds a lipid profile",
  labKept.map((i) => i.desc).join(",") === "HBA1C,LIPID PROFILE" &&
    billedStepIds(bill(labKept), machines).has("blood_sample"),
);
const unmatched = machines.filter(
  (m) =>
    ![...billedStepIds(bill([{ desc: m.tests[0], category: "machine" }]), machines)].includes(m.id),
);
check(
  "every catalogue machine is recognised from its own bill name",
  unmatched.length === 0,
  unmatched.map((m) => `${m.id} (${m.tests[0]})`).join(", "),
);

console.log("\nreconcile a real journey (rolled back)");

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const { rows: visits } = await pool.query(
  `SELECT v.id, p.name
     FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
    WHERE v.visit_date = $1::date
      AND v.current_status NOT IN ('dispensed', 'exited', 'no_show', 'cancelled')
      AND EXISTS (SELECT 1 FROM giniflow_visit_steps s
                   WHERE s.visit_id = v.id AND s.source = 'template' AND s.status = 'pending')
      AND NOT EXISTS (SELECT 1 FROM giniflow_lab_orders o WHERE o.visit_id = v.id)
      AND NOT EXISTS (SELECT 1 FROM giniflow_test_cancellations c WHERE c.visit_id = v.id)
    LIMIT 1`,
  [today],
);

const addOrder = async (client, visitId, test, fromCheckin) => {
  const { rows } = await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, urgency, payment_status, amount_total, sample_status, kind, created_at)
     VALUES ($1, 'today', 'pending', 500, 'payment_pending', 'machine',
             CASE WHEN $2 THEN (SELECT min(s.created_at) FROM giniflow_visit_steps s
                                 WHERE s.visit_id = $1 AND s.source IN ('template', 'added'))
                  ELSE NOW() END)
     RETURNING id`,
    [visitId, fromCheckin],
  );
  await client.query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 500)`,
    [rows[0].id, test],
  );
  return rows[0].id;
};
const addStep = (client, visitId, catalogId, source) =>
  client.query(
    `INSERT INTO giniflow_visit_steps (visit_id, step_order, step_catalog_id, step_name, source, status)
     VALUES ($1, (SELECT COALESCE(max(step_order), 0) + 1 FROM giniflow_visit_steps WHERE visit_id = $1),
             $2, $2, $3, 'pending')`,
    [visitId, catalogId, source],
  );
const stepsOf = async (client, visitId) =>
  (
    await client.query(
      `SELECT step_catalog_id FROM giniflow_visit_steps WHERE visit_id = $1 AND status = 'pending'`,
      [visitId],
    )
  ).rows.map((r) => r.step_catalog_id);
const orderExists = async (client, id) =>
  (await client.query(`SELECT 1 FROM giniflow_lab_orders WHERE id = $1`, [id])).rows.length > 0;
const stepStatus = async (client, visitId, catalogId) =>
  (
    await client.query(
      `SELECT status FROM giniflow_visit_steps WHERE visit_id = $1 AND step_catalog_id = $2`,
      [visitId, catalogId],
    )
  ).rows.map((r) => r.status);

for (const visit of visits) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const id of ["abi", "vpt", "ecg", "echo"]) {
      await addStep(client, visit.id, id, "template");
    }
    await addStep(client, visit.id, "fundus", "added");
    await addStep(client, visit.id, "tmt", "auto");
    const byName = (id) => machines.find((m) => m.id === id).tests[0];
    const abiOrder = await addOrder(client, visit.id, byName("abi"), true);
    const vptOrder = await addOrder(client, visit.id, byName("vpt"), true);
    const doctorEcg = await addOrder(client, visit.id, byName("ecg"), false);
    await client.query(
      `UPDATE giniflow_lab_orders SET payment_status = 'paid', amount_paid = 500, sample_status = 'paid'
        WHERE id = $1`,
      [vptOrder],
    );

    process.env.SCRIBE_BILL_AUTO_CANCEL = "dry";
    const dry = await reconcileTestSteps(client, visit.id, bill([consult, echoLine]), machines);
    delete process.env.SCRIBE_BILL_AUTO_CANCEL;
    check(
      "dry run: lists what it would cancel and changes nothing",
      dry.wouldCancel.length >= 2 &&
        dry.removedOrders === 0 &&
        (await orderExists(client, abiOrder)) &&
        (await stepsOf(client, visit.id)).includes("fundus"),
      JSON.stringify(dry.wouldCancel),
    );

    const result = await reconcileTestSteps(client, visit.id, bill([consult, echoLine]), machines);
    const left = await stepsOf(client, visit.id);

    check(
      `${visit.name}: unpaid check-in ABI order taken off the floor`,
      !(await orderExists(client, abiOrder)),
    );
    const { rows: record } = await client.query(
      `SELECT reason, source, test_name FROM giniflow_test_cancellations
        WHERE visit_id = $1 AND order_id = $2`,
      [visit.id, abiOrder],
    );
    check(
      "…with a cancellation record (reason not_on_bill), not a silent delete",
      record.length === 1 && record[0].reason === "not_on_bill" && record[0].source === "healthray",
      JSON.stringify(record),
    );
    check(
      "hand-added Fundus step with no order is marked skipped, not deleted",
      (await stepStatus(client, visit.id, "fundus")).includes("skipped"),
    );
    const suppressed = await billSuppressor(client, visit.id);
    check(
      "a not_on_bill cancel does not stop ABI being raised if HealthRay bills it later",
      !suppressed({
        kind: "machine",
        machineId: "abi",
        line: { desc: "ABI", itemId: 999001 },
      }),
    );
    check(
      "paid VPT order kept, and its step kept",
      (await orderExists(client, vptOrder)) && left.includes("vpt"),
    );
    check(
      "a doctor's ECG order (not from check-in) kept, and its step kept",
      (await orderExists(client, doctorEcg)) && left.includes("ecg"),
    );
    check(
      "unbilled template ABI and hand-added Fundus steps removed once the bill is in",
      !left.includes("abi") && !left.includes("fundus"),
    );
    check("an auto step (from the bill or a doctor) is never removed", left.includes("tmt"));
    check("billed Echo step kept", left.includes("echo"));
    check(
      "counts reported",
      result.removedOrders === 1 && result.removedSteps >= 1 && result.failed.length === 0,
      JSON.stringify(result),
    );

    const untouched = await reconcileTestSteps(client, visit.id, bill([], "no_bill"), machines);
    check(
      "no bill: nothing removed",
      untouched.removedSteps === 0 && untouched.removedOrders === 0,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
if (!visits.length) console.log("  ·  no suitable visit today to try");

console.log("\npaid orders follow the bill (rolled back)");

const paidOrder = async (client, visitId, test) => {
  const { rows } = await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, urgency, payment_status, amount_total, amount_paid, sample_status, kind)
     VALUES ($1, 'today', 'paid', 500, 500, 'paid', 'machine') RETURNING id`,
    [visitId],
  );
  await client.query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 500)`,
    [rows[0].id, test],
  );
  return rows[0].id;
};
const amounts = async (client, ids) =>
  (
    await client.query(
      `SELECT o.id, o.amount_total::numeric AS total, o.amount_paid::numeric AS paid,
              (SELECT sum(price) FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS tests
         FROM giniflow_lab_orders o WHERE o.id = ANY($1::uuid[]) ORDER BY o.id`,
      [ids],
    )
  ).rows;
const combined = (extra = {}) =>
  bill([
    consult,
    {
      desc: "ABI,VPT,Fundus",
      category: "machine",
      amount: 800,
      invoice: "OPD/TEST-1",
      itemId: 990001,
      invoiceDue: 0,
      invoiceRefunded: 0,
      ...extra,
    },
  ]);

for (const visit of visits) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const byName = (id) => machines.find((m) => m.id === id).tests[0];
    const ids = [];
    for (const id of ["abi", "vpt", "fundus"])
      ids.push(await paidOrder(client, visit.id, byName(id)));

    const dry = await repricePaidOrdersFromBill(client, visit.id, combined(), machines);
    const untouched = await amounts(client, ids);
    check(
      "default is dry: lists ₹1,500 → ₹800 and changes nothing",
      dry.wouldReprice.length === 3 &&
        dry.repriced.length === 0 &&
        untouched.every((r) => Number(r.total) === 500 && Number(r.paid) === 500),
      dry.wouldReprice.map((r) => r.tests).join(" | "),
    );

    process.env.SCRIBE_BILL_AUTO_REPRICE = "dry";
    for (const [label, extra] of [
      ["invoice has a refund (Mukesh's ₹200)", { invoiceRefunded: 200 }],
      ["invoice not fully paid", { invoiceDue: 300 }],
      ["bill does not say whether paid", { invoiceDue: undefined }],
      ["line has a refund", { refunded: 100 }],
    ]) {
      const r = await repricePaidOrdersFromBill(client, visit.id, combined(extra), machines);
      check(
        `refused: ${label}`,
        r.wouldReprice.length === 0 && r.refused.length === 3,
        r.refused[0]?.reason,
      );
    }

    process.env.SCRIBE_BILL_AUTO_REPRICE = "1";
    const done = await repricePaidOrdersFromBill(client, visit.id, combined(), machines);
    const after = await amounts(client, ids);
    const total = after.reduce((sum, r) => sum + Number(r.total), 0);
    check(
      "acting: three orders repriced to the ₹800 line, paid follows, tests match",
      done.repriced.length === 3 &&
        total === 800 &&
        after.every(
          (r) => Number(r.paid) === Number(r.total) && Number(r.tests) === Number(r.total),
        ),
      after.map((r) => r.total).join(" + "),
    );
    const { rows: audit } = await client.query(
      `SELECT count(*)::int n FROM billing_audit
        WHERE entity = 'giniflow_lab_order' AND entity_id = ANY($1::text[])`,
      [ids],
    );
    const { rows: events } = await client.query(
      `SELECT count(*)::int n FROM giniflow_lab_order_events
        WHERE lab_order_id = ANY($1::uuid[]) AND track = 'payment' AND status = 'repriced'`,
      [ids],
    );
    check(
      "each change has an audit row and a repriced payment event",
      audit[0].n === 3 && events[0].n === 3,
    );
    const again = await repricePaidOrdersFromBill(client, visit.id, combined(), machines);
    check(
      "a second read changes nothing",
      again.repriced.length === 0 && again.refused.length === 0,
    );

    await client.query(
      `UPDATE giniflow_lab_orders SET claim_state = 'submitted', amount_claimed = 100, amount_paid = amount_total - 100
        WHERE id = $1`,
      [ids[0]],
    );
    const claimed = await repricePaidOrdersFromBill(
      client,
      visit.id,
      bill([
        consult,
        { desc: "ABI", category: "machine", amount: 300, invoiceDue: 0, invoiceRefunded: 0 },
      ]),
      machines,
    );
    check(
      "an order with an insurance claim is never repriced",
      claimed.repriced.every((r) => r.orderId !== ids[0]) &&
        claimed.refused.some((r) => r.reason === "not a plain full payment"),
    );
  } finally {
    delete process.env.SCRIBE_BILL_AUTO_REPRICE;
    await client.query("ROLLBACK");
    client.release();
  }
}

await pool.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
