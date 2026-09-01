// The lab station and the gate it guards.
//
// The rule that matters (brief §2.2): no sample may be collected until reception
// has cleared payment. And uploading a report is what turns a patient green for
// the MO and the doctor — trigger 1 — so that must happen in the same
// transaction as the upload, never as a second step that can fail on its own.
//
//   npm run smoke:giniflow-lab   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import { getLabQueue, advanceSample } from "../services/giniflow/labStation.js";
import { clearPayment } from "../services/giniflow/receptionStation.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

const TEST_DAY = "2019-01-06";
const before = await one(`SELECT count(*)::int AS c FROM flow_visits`);

await cleanDemoDay();
await seedDemoDay({ date: TEST_DAY });

const q = await getLabQueue(TEST_DAY);
const all = [...q.pending, ...q.collecting, ...q.processing, ...q.ready, ...q.uploaded];
check("the lab queue loads", all.length > 0, `${all.length} orders`);
check(
  "orders are grouped into the five buckets",
  ["pending", "collecting", "processing", "ready", "uploaded"].every((k) => Array.isArray(q[k])),
);
check("a card carries its tests", all[0].tests.length > 0);
check("a card carries its progress rail", all[0].steps.length === 4);

// ── The payment gate ────────────────────────────────────────────────────────
const unpaid = all.find((o) => o.paymentStatus === "pending");
if (unpaid) {
  check("an unpaid order offers no action", unpaid.nextAction === null);
  check("and says why", /payment/i.test(unpaid.blockedReason || ""), unpaid.blockedReason);
  const refused = await advanceSample(unpaid.orderId, { to: "sample_collected" })
    .then(() => false)
    .catch((e) => e.status === 409);
  check("collecting before payment is refused by the service, not just the UI", refused);

  // Clearing payment opens the sample task.
  await clearPayment(unpaid.orderId, { method: "paid" });
  const afterPay = await getLabQueue(TEST_DAY);
  const nowReady = [...afterPay.pending].find((o) => o.orderId === unpaid.orderId);
  check("once paid, the sample can be collected", nowReady?.nextAction?.to === "sample_collected");
} else {
  check("a payment-pending order exists to test the gate", false);
}

// ── The track ───────────────────────────────────────────────────────────────
const target = (await getLabQueue(TEST_DAY)).pending.find((o) => o.paid);
check("a paid order is ready to collect", !!target);

for (const step of ["sample_collected", "processing", "results_ready"]) {
  const r = await advanceSample(target.orderId, { to: step });
  check(`advances to ${step}`, r.sampleStatus === step, r.sampleStatus);
}

// Going backwards is a no-op, not an error: two technicians tapping one card
// must not write a second event.
const back = await advanceSample(target.orderId, { to: "sample_collected" });
check("going backwards is a no-op", back.unchanged === true);

// ── Upload is trigger 1 ─────────────────────────────────────────────────────
// The seeder marks some journeys as already having results, which would make the
// next assertion prove nothing. Reset this one so the upload is what sets it.
await pool.query(`UPDATE giniflow_visits SET results_status = 'none' WHERE id = $1`, [
  target.visitId,
]);
const visitBefore = await one(`SELECT results_status FROM giniflow_visits WHERE id = $1`, [
  target.visitId,
]);
check(
  "the visit starts with no results",
  visitBefore.results_status !== "ready",
  visitBefore.results_status,
);

await advanceSample(target.orderId, { to: "uploaded" });
const visitAfter = await one(`SELECT results_status FROM giniflow_visits WHERE id = $1`, [
  target.visitId,
]);
check(
  "uploading turns the patient green for the MO and doctor",
  visitAfter.results_status === "ready",
  visitAfter.results_status,
);
const uploaded = await one(`SELECT uploaded_at FROM giniflow_lab_orders WHERE id = $1`, [
  target.orderId,
]);
check("the upload is timestamped", !!uploaded.uploaded_at);

const events = await pool.query(
  `SELECT status, actor_role FROM giniflow_lab_order_events
    WHERE lab_order_id = $1 AND track = 'sample' ORDER BY occurred_at`,
  [target.orderId],
);
check(
  "every step is logged and attributed to the lab",
  ["sample_collected", "processing", "results_ready", "uploaded"].every((s) =>
    events.rows.some((e) => e.status === s && e.actor_role === "lab"),
  ),
);

const q3 = await getLabQueue(TEST_DAY);
check(
  "the order lands in the uploaded bucket",
  q3.uploaded.some((o) => o.orderId === target.orderId),
);

// ── Urgency: only today's tests are today's work (plan §5b.1) ───────────────
const laterOrder = await one(
  `SELECT o.id FROM giniflow_lab_orders o
     JOIN giniflow_visits v ON v.id = o.visit_id
    WHERE v.visit_date = $1::date LIMIT 1`,
  [TEST_DAY],
);
await pool.query(`UPDATE giniflow_lab_orders SET urgency = 'next_visit' WHERE id = $1`, [
  laterOrder.id,
]);
const afterUrgency = await getLabQueue(TEST_DAY);
const stillListed = [
  ...afterUrgency.pending,
  ...afterUrgency.collecting,
  ...afterUrgency.processing,
  ...afterUrgency.ready,
  ...afterUrgency.uploaded,
].some((o) => o.orderId === laterOrder.id);
check("a next-visit test is not on today's lab queue", !stillListed);
await pool.query(`UPDATE giniflow_lab_orders SET urgency = 'today' WHERE id = $1`, [laterOrder.id]);

// ── A submitted claim is not an approved one (plan §5b.3) ───────────────────
// Reset one order to unpaid: by this point the gate test above has cleared the
// only pending one, and a check that silently skips proves nothing.
const claimRow = await one(
  `SELECT o.id FROM giniflow_lab_orders o
     JOIN giniflow_visits v ON v.id = o.visit_id
    WHERE v.visit_date = $1::date ORDER BY o.created_at LIMIT 1`,
  [TEST_DAY],
);
await pool.query(
  `UPDATE giniflow_lab_orders SET payment_status = 'pending', sample_status = 'payment_pending'
    WHERE id = $1`,
  [claimRow.id],
);
const claimOrder = (await getLabQueue(TEST_DAY)).pending.find((o) => o.orderId === claimRow.id);
check("an order is available to test the claim path", !!claimOrder);
if (claimOrder) {
  await clearPayment(claimOrder.orderId, { method: "insurance_claim" });
  const afterClaim = (await getLabQueue(TEST_DAY)).pending.find(
    (o) => o.orderId === claimOrder.orderId,
  );
  check("a submitted claim does not open the lab gate", afterClaim && !afterClaim.paid);
  check(
    "and the card says the claim is awaiting approval",
    /approval/i.test(afterClaim?.blockedReason || ""),
    afterClaim?.blockedReason,
  );
  const refusedOnClaim = await advanceSample(claimOrder.orderId, { to: "sample_collected" })
    .then(() => false)
    .catch((e) => e.status === 409);
  check("collecting on an unapproved claim is refused", refusedOnClaim);

  await clearPayment(claimOrder.orderId, { method: "claim_approved" });
  const approved = (await getLabQueue(TEST_DAY)).pending.find(
    (o) => o.orderId === claimOrder.orderId,
  );
  check("approving the claim opens the gate", approved?.paid === true);
}

// ── Per-test status follows the order (plan §7) ─────────────────────────────
const withTests = (await getLabQueue(TEST_DAY)).processing[0];
if (withTests) {
  check(
    "each test carries its own status for the detail pane",
    withTests.tests.every((t) => "status" in t),
    withTests.tests[0]?.status,
  );
}

// ── The report itself ───────────────────────────────────────────────────────
// Marking an order uploaded with no report tells the MO a result exists when it
// does not, so the upload path is what the screen offers for the last step.
const { uploadReport } = await import("../services/giniflow/labStation.js");

const unpaidUpload = await getLabQueue(TEST_DAY).then((q) =>
  [...q.pending, ...q.collecting].find((o) => !o.paid),
);
if (unpaidUpload) {
  const refused = await uploadReport(unpaidUpload.orderId, { base64: "eA==", fileName: "r.pdf" })
    .then(() => false)
    .catch((e) => e.status === 409);
  check("a report cannot be uploaded against an unpaid order", refused);
}

const noFile = await uploadReport(target.orderId, { base64: "" })
  .then(() => false)
  .catch((e) => e.status === 400);
check("an empty upload is rejected", noFile);

const missingOrder = await uploadReport("00000000-0000-0000-0000-000000000000", {
  base64: "eA==",
})
  .then(() => false)
  .catch((e) => e.status === 404 || e.status === 503);
check("an unknown order is rejected", missingOrder);

const bogus = await advanceSample(target.orderId, { to: "teleported" })
  .then(() => false)
  .catch(() => true);
check("an unknown status is rejected", bogus);

// The queue must carry what the card renders.
const shape = (await getLabQueue(TEST_DAY)).uploaded[0];
check(
  "an uploaded order exposes its report link",
  shape ? "reportUrl" in shape : true,
  "so the card can offer 'view report'",
);

await cleanDemoDay();
const after = await one(`SELECT count(*)::int AS c FROM flow_visits`);
check("old flow_* module untouched", after.c === before.c, `${before.c}→${after.c}`);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
