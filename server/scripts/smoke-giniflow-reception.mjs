// Reception: the payment desk, and the gate it guards.
//
// The rule that matters (brief §2.2): the lab may not collect a sample until the
// order is paid or an insurance claim is approved. Reception is what moves an
// order across that line, so these checks are mostly about money and the log.
//
//   npm run smoke:giniflow-reception   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import {
  getPaymentQueue,
  clearPayment,
  getTestCatalog,
  getArrivals,
  markArrived,
  markNoShow,
  markCancelled,
  undoArrival,
  searchWalkInPatients,
  checkInWalkIn,
} from "../services/giniflow/receptionStation.js";
import { syncAppointmentsToFlow } from "../services/giniflow/appointmentSync.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

const TEST_DAY = "2019-01-04";
const before = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS v,
          (SELECT count(*)::int FROM giniflow_test_catalog) AS cat`,
);

await cleanDemoDay();
await seedDemoDay({ date: TEST_DAY });

const catalog = await getTestCatalog();
check("the price catalogue is readable", catalog.length > 0, `${catalog.length} tests`);
check(
  "catalogue prices are marked as placeholders",
  catalog.every((t) => t.source === "prototype_placeholder"),
  "so nobody mistakes a mockup figure for a tariff",
);

const q = await getPaymentQueue(TEST_DAY);
check("payment-pending orders are listed", q.pending.length > 0, `${q.pending.length}`);
const order = q.pending[0];
check("an order carries its patient", !!order.name && !!order.fileNo);
check("an order lists its tests with prices", order.tests.length > 0 && order.tests[0].price > 0);
check(
  "the total is summed from the order's own lines",
  order.total === order.tests.reduce((s, t) => s + Number(t.price), 0),
  `${order.total}`,
);
check("who ordered it is shown", "orderedBy" in order);

// Clearing is what lets the lab collect.
const cleared = await clearPayment(order.orderId, { method: "paid" });
check("clearing marks the order paid", cleared.paymentStatus === "paid");
const afterRow = await one(
  `SELECT payment_status, sample_status FROM giniflow_lab_orders WHERE id = $1`,
  [order.orderId],
);
check(
  "the sample task opens for the lab",
  afterRow.sample_status === "paid",
  afterRow.sample_status,
);

const events = await pool.query(
  `SELECT track, status, actor_role FROM giniflow_lab_order_events
    WHERE lab_order_id = $1 ORDER BY occurred_at`,
  [order.orderId],
);
check(
  "the payment is logged, not just stored",
  events.rows.some(
    (e) => e.track === "payment" && e.status === "paid" && e.actor_role === "reception",
  ),
);
check(
  "the sample hand-off is logged too",
  events.rows.some((e) => e.track === "sample" && e.status === "paid"),
);

// A double-tap at a busy counter must not read as paying twice.
const again = await clearPayment(order.orderId, { method: "paid" });
check("clearing twice is a no-op", again.alreadySettled === true);
const paymentEvents = await one(
  `SELECT count(*)::int AS c FROM giniflow_lab_order_events
    WHERE lab_order_id = $1 AND track = 'payment' AND status = 'paid'`,
  [order.orderId],
);
check("only one payment event exists", paymentEvents.c === 1, `${paymentEvents.c}`);

const q2 = await getPaymentQueue(TEST_DAY);
check("the order leaves the pending list", !q2.pending.find((o) => o.orderId === order.orderId));
check(
  "and appears as cleared or awaiting the lab",
  [...q2.cleared, ...q2.awaitingSample].some((o) => o.orderId === order.orderId),
);

// Insurance is the other way across the same line — but a SUBMITTED claim has
// not crossed it yet. Reception keeps chasing it; the lab must not see it.
{
  const claimed = (
    await one(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total, sample_status)
       VALUES ($1, 'today', 'pending', 900, 'ordered') RETURNING id`,
      [order.visitId],
    )
  ).id;
  const nameless = await clearPayment(claimed, { method: "insurance_claim" })
    .then(() => false)
    .catch(() => true);
  check("a claim with no insurer is refused — nobody could chase it", nameless);

  const MAKER = 20;
  const CHECKER = 26;
  const claim = await clearPayment(claimed, {
    method: "insurance_claim",
    actorId: MAKER,
    actorRole: "reception",
    insurer: "  Star Health  ",
    policyNo: "POL-99",
  });
  check("an insurance claim is submitted", claim.paymentStatus === "insurance_claim");

  const q3 = await getPaymentQueue(TEST_DAY);
  const onList = q3.pending.find((o) => o.orderId === claimed);
  check("a submitted claim stays on reception's list", onList?.paymentStatus === "insurance_claim");
  check("the insurer is recorded and trimmed", onList?.insurer === "Star Health", onList?.insurer);
  check("so is the policy the claim is under", onList?.policyNo === "POL-99");
  check("and who submitted it, for the checker to see", onList?.claimSubmittedBy === MAKER);
  check(
    "and counts as neither cleared nor waiting on the lab",
    ![...q3.cleared, ...q3.awaitingSample].some((o) => o.orderId === claimed),
  );

  // The money is with the insurer, so it cannot also be taken at the counter —
  // the desk has to settle the claim one way or the other first.
  const cashOverClaim = await clearPayment(claimed, { method: "paid" })
    .then(() => false)
    .catch((e) => e.status === 409);
  check("cash cannot be taken while the claim stands", cashOverClaim);
  const kept = await one(
    `SELECT payment_status, amount_paid FROM giniflow_lab_orders WHERE id = $1`,
    [claimed],
  );
  check("and nothing was collected", Number(kept.amount_paid) === 0);
  check("and it keeps its claim status", kept.payment_status === "insurance_claim");

  const selfApproved = await clearPayment(claimed, {
    method: "claim_approved",
    actorId: MAKER,
  })
    .then(() => false)
    .catch((e) => e.status === 409);
  check("the submitter cannot approve their own claim", selfApproved);
  const stillWaiting = await one(`SELECT payment_status FROM giniflow_lab_orders WHERE id = $1`, [
    claimed,
  ]);
  check("and the refusal changed nothing", stillWaiting.payment_status === "insurance_claim");

  const approved = await clearPayment(claimed, {
    method: "claim_approved",
    actorId: CHECKER,
    actorRole: "coordinator",
    claimNo: "CLM-1",
  });
  check("a second pair of eyes can approve it", approved.alreadySettled === false);
  const log = await one(
    `SELECT o.claim_approved_by, o.claim_no,
            (SELECT actor_role FROM giniflow_lab_order_events e
              WHERE e.lab_order_id = o.id AND e.status = 'claim_approved') AS role
       FROM giniflow_lab_orders o WHERE o.id = $1`,
    [claimed],
  );
  check("the approver is recorded, not just the action", log.claim_approved_by === CHECKER);
  check("the log carries the real role, not a hardcoded one", log.role === "coordinator", log.role);
  check("and the claim reference is kept", log.claim_no === "CLM-1");
  const q4 = await getPaymentQueue(TEST_DAY);
  check(
    "an approved claim leaves the pending list",
    !q4.pending.some((o) => o.orderId === claimed),
  );
  check(
    "and opens the lab gate",
    [...q4.cleared, ...q4.awaitingSample].some((o) => o.orderId === claimed),
  );
}

// ── The split: part cash, part insurance ───────────────────────────────────
// The ordinary OPD case. A policy covers ₹900 of a ₹1,250 order and the patient
// pays the rest at the desk — and NEITHER half settles the order until the
// insurer has actually approved its half.
const newOrder = async (total) =>
  (
    await one(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total, sample_status)
       VALUES ($1, 'today', 'pending', $2, 'ordered') RETURNING id`,
      [order.visitId, total],
    )
  ).id;

{
  const MAKER = 20;
  const CHECKER = 26;
  const split = await newOrder(1250);

  const overpay = await clearPayment(split, { method: "paid", amountPaid: 2000 })
    .then(() => false)
    .catch((e) => e.status === 400);
  check("collecting more than the order is worth is refused", overpay);

  const overSplit = await clearPayment(split, {
    method: "split",
    amountPaid: 350,
    amountClaimed: 1500,
    insurer: "Star Health",
  })
    .then(() => false)
    .catch((e) => e.status === 400);
  check("a split that adds up to more than the total is refused", overSplit);

  const done = await clearPayment(split, {
    method: "split",
    actorId: MAKER,
    amountPaid: 350,
    amountClaimed: 900,
    insurer: "Star Health",
    policyNo: "POL-1",
  });
  check("the cash half is recorded", Number(done.amountPaid) === 350);
  check("the claimed half is recorded", Number(done.amountClaimed) === 900);
  check(
    "a submitted claim settles nothing — the balance is still the claim",
    done.outstanding === 900,
    `₹${done.outstanding}`,
  );
  check(
    "so the order reads as a claim, not as part paid",
    done.paymentStatus === "insurance_claim",
  );

  const gate = await one(`SELECT sample_status FROM giniflow_lab_orders WHERE id = $1`, [split]);
  check("and the lab gate stays shut", gate.sample_status === "ordered", gate.sample_status);

  const ledger = await pool.query(
    `SELECT status FROM giniflow_lab_order_events
      WHERE lab_order_id = $1 AND track = 'payment' ORDER BY occurred_at`,
    [split],
  );
  check(
    "both halves are in the ledger, not just the last one",
    ledger.rows.map((r) => r.status).join(",") === "part_paid,insurance_claim",
    ledger.rows.map((r) => r.status).join(","),
  );

  const second = await clearPayment(split, {
    method: "insurance_claim",
    insurer: "Star Health",
    amountClaimed: 100,
  })
    .then(() => false)
    .catch((e) => e.status === 409);
  check("a second claim cannot stand against the same money", second);

  // Double-tap: the guard that a status check cannot give once amounts are real.
  const stale = await clearPayment(split, {
    method: "claim_approved",
    actorId: CHECKER,
    version: 0,
  })
    .then(() => false)
    .catch((e) => e.status === 409 && e.stale === true);
  check("a write from a stale screen is refused", stale);
  const untouched = await one(`SELECT payment_status FROM giniflow_lab_orders WHERE id = $1`, [
    split,
  ]);
  check("and it changed nothing", untouched.payment_status === "insurance_claim");

  const ok = await clearPayment(split, {
    method: "claim_approved",
    actorId: CHECKER,
    version: done.version,
  });
  check("the version the desk actually read is accepted", ok.alreadySettled === false);
  check("approving the claim settles the order", ok.outstanding === 0);
  check("and it reads as claim_approved", ok.paymentStatus === "claim_approved");
  const opened = await one(`SELECT sample_status FROM giniflow_lab_orders WHERE id = $1`, [split]);
  check("the lab gate opens on the approval", opened.sample_status === "paid");
}

// ── Rejection: the insurer says no ─────────────────────────────────────────
// The money goes back to outstanding, the order returns to reception's list and
// the gate closes again — as long as the sample has not already been taken.
{
  const MAKER = 20;
  const CHECKER = 26;
  const refused = await newOrder(1000);
  const submitted = await clearPayment(refused, {
    method: "split",
    actorId: MAKER,
    amountPaid: 200,
    amountClaimed: 800,
    insurer: "Care Health",
  });
  await clearPayment(refused, {
    method: "claim_approved",
    actorId: CHECKER,
    version: submitted.version,
  });
  const openedGate = await one(`SELECT sample_status FROM giniflow_lab_orders WHERE id = $1`, [
    refused,
  ]);
  check("an approved split opens the gate", openedGate.sample_status === "paid");

  // An insurer can go back on an approval, and that is the one case where the
  // gate has to shut on an order the lab has already been shown.
  const reversed = await clearPayment(refused, {
    method: "claim_rejected",
    actorId: CHECKER,
    note: "Reversed on review",
  });
  check("an approved claim can still be reversed", reversed.alreadySettled === false);
  check("the money goes back to outstanding", reversed.outstanding === 800);
  const shut = await one(`SELECT sample_status FROM giniflow_lab_orders WHERE id = $1`, [refused]);
  check("and the lab gate closes on an uncollected sample", shut.sample_status === "ordered");

  // Once the sample is in the lab's hand the work is done — a reversal after
  // that is a bill to chase, not a task to withdraw.
  const collected = await newOrder(500);
  const c1 = await clearPayment(collected, {
    method: "insurance_claim",
    actorId: MAKER,
    insurer: "Care Health",
  });
  await clearPayment(collected, {
    method: "claim_approved",
    actorId: CHECKER,
    version: c1.version,
  });
  await pool.query(
    `UPDATE giniflow_lab_orders SET sample_status = 'sample_collected' WHERE id = $1`,
    [collected],
  );
  await clearPayment(collected, { method: "claim_rejected", actorId: CHECKER });
  const kept2 = await one(`SELECT sample_status FROM giniflow_lab_orders WHERE id = $1`, [
    collected,
  ]);
  check("a sample already taken is left alone", kept2.sample_status === "sample_collected");

  const again = await newOrder(1000);
  const claim2 = await clearPayment(again, {
    method: "split",
    actorId: MAKER,
    amountPaid: 200,
    amountClaimed: 800,
    insurer: "Care Health",
  });
  const no = await clearPayment(again, {
    method: "claim_rejected",
    actorId: CHECKER,
    actorRole: "coordinator",
    note: "  OPD tests not covered  ",
    version: claim2.version,
  });
  check("a refused claim stops counting toward settlement", no.outstanding === 800);
  check("the cash already taken is kept", Number(no.amountPaid) === 200);
  check("and the order falls back to part paid", no.paymentStatus === "part_paid");
  const why = await one(
    `SELECT claim_state, claim_note, sample_status FROM giniflow_lab_orders WHERE id = $1`,
    [again],
  );
  check("the reason the insurer gave is kept", why.claim_note === "OPD tests not covered");
  check("the claim reads as rejected", why.claim_state === "rejected");
  check("the lab gate is shut again", why.sample_status === "ordered", why.sample_status);
  const backOnList = await getPaymentQueue(TEST_DAY);
  check(
    "and the order is back on reception's list to collect from the patient",
    backOnList.pending.some((o) => o.orderId === again),
  );

  const balance = await clearPayment(again, { method: "paid" });
  check("collecting the balance settles it in one tap", balance.outstanding === 0);
  check("with the full amount recorded as cash", Number(balance.amountPaid) === 1000);
  check("and the order reads as paid", balance.paymentStatus === "paid");
}

const bad = await clearPayment(order.orderId, { method: "waived" })
  .then(() => false)
  .catch(() => true);
check("an unknown settlement method is rejected", bad);

const missing = await clearPayment("00000000-0000-0000-0000-000000000000", { method: "paid" })
  .then(() => false)
  .catch(() => true);
check("an unknown order is rejected", missing);

// ── Arrivals: the front door ────────────────────────────────────────────────
// The half of brief §4.2 that lets a real patient onto the floor when HealthRay
// cannot say so. Everything below writes through advanceStatus, so what these
// assertions really check is the LOG: the desk's actions have to be as readable
// a week later as the sync's are.
const demoPatient = async (suffix, name) =>
  (
    await one(
      `INSERT INTO patients (name, file_no, age, sex, phone)
       VALUES ($2, $1, 52, 'Male', $3)
       ON CONFLICT (file_no) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [`ZZDEMO_${suffix}`, name, `99999${suffix}`],
    )
  ).id;

const bookedPatient = await demoPatient("900", "Demo Walkin Expected");
const bookedVisit = await one(
  `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_time, current_status, is_demo)
   VALUES ($1, $2::date, '09:30', 'booked', TRUE)
   ON CONFLICT (patient_id, visit_date) DO UPDATE SET current_status = 'booked'
   RETURNING id`,
  [bookedPatient, TEST_DAY],
);

const arrivals = await getArrivals(TEST_DAY);
check(
  "arrivals splits the day into three groups",
  ["expected", "onFloor", "notComing"].every((k) => Array.isArray(arrivals[k])),
);
check(
  "a booked patient is Expected",
  arrivals.expected.some((a) => a.visitId === bookedVisit.id),
  `${arrivals.expected.length} expected`,
);
check(
  "the demo floor shows up as on the floor",
  arrivals.onFloor.length > 0,
  `${arrivals.onFloor.length}`,
);
check(
  "an expected row carries the slot and how late they are",
  arrivals.expected[0]?.slot != null && arrivals.expected[0]?.minutesLate != null,
);
check(
  "counts describe the whole day, not the filtered view",
  arrivals.counts.expected === arrivals.expected.length,
);

const searched = await getArrivals(TEST_DAY, "Demo Walkin Expected");
check(
  "search is applied server-side",
  searched.expected.length === 1 && searched.expected[0].visitId === bookedVisit.id,
  `${searched.expected.length} hit(s)`,
);
check(
  "but the day's counts do not move with it",
  searched.counts.expected === arrivals.counts.expected,
);

const eventsFor = async (visitId) =>
  (
    await pool.query(
      `SELECT status, actor_role FROM giniflow_visit_events
        WHERE visit_id = $1 ORDER BY occurred_at, id`,
      [visitId],
    )
  ).rows;

const arrived = await markArrived(bookedVisit.id);
check("Arrived checks the patient in", arrived.status === "checked_in");
const arrivedEvents = await eventsFor(bookedVisit.id);
check(
  "the arrival is logged as reception's own action",
  arrivedEvents.length === 1 &&
    arrivedEvents[0].status === "checked_in" &&
    arrivedEvents[0].actor_role === "reception",
  JSON.stringify(arrivedEvents),
);

// A double-tap at a busy counter must not read as two arrivals.
const arrivedAgain = await markArrived(bookedVisit.id);
check("a second Arrived is a no-op", arrivedAgain.unchanged === true);
check("and writes no second event", (await eventsFor(bookedVisit.id)).length === 1);

// §5.1 — the guard that makes manual check-in safe at all. HealthRay still calls
// this patient `scheduled`; the sync must leave them where reception put them.
const appt = await one(
  `INSERT INTO appointments (patient_id, appointment_date, status, created_at)
   VALUES ($1, $2::date, 'scheduled', NOW()) RETURNING id`,
  [bookedPatient, TEST_DAY],
);
await syncAppointmentsToFlow({ date: TEST_DAY });
const afterSync = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
  bookedVisit.id,
]);
check(
  "the HealthRay sync does not undo a manual check-in",
  afterSync.current_status === "checked_in",
  afterSync.current_status,
);
check("and writes no event of its own", (await eventsFor(bookedVisit.id)).length === 1);
// Dropped as soon as it has done its job: `appointments` is the hospital's own
// table and cleanDemoDay does not touch it, so a row left here would block the
// demo patient's own removal on the next run.
await pool.query(`DELETE FROM appointments WHERE id = $1`, [appt.id]);

// A no-show who turns up is re-checked-in, not un-no-showed: undo returns them
// to booked and the desk presses Arrived again. Every hop forward, none back.
const absent = await demoPatient("901", "Demo Absent Patient");
const absentVisit = await one(
  `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_time, current_status, is_demo)
   VALUES ($1, $2::date, '10:00', 'booked', TRUE)
   ON CONFLICT (patient_id, visit_date) DO UPDATE SET current_status = 'booked'
   RETURNING id`,
  [absent, TEST_DAY],
);
check("no-show marks the patient absent", (await markNoShow(absentVisit.id)).status === "no_show");
const notComing = await getArrivals(TEST_DAY);
check(
  "and they move to Not coming",
  notComing.notComing.some((a) => a.visitId === absentVisit.id),
);
check(
  "undo puts them back on the expected list",
  (await undoArrival(absentVisit.id)).status === "booked",
);
check(
  "and Arrived then works normally",
  (await markArrived(absentVisit.id)).status === "checked_in",
);
const hops = (await eventsFor(absentVisit.id)).map((e) => e.status);
check(
  "every hop is logged and none is an edit",
  JSON.stringify(hops) === JSON.stringify(["no_show", "booked", "checked_in"]),
  hops.join(" → "),
);
check(
  "undoing a patient who is not absent is refused",
  await undoArrival(absentVisit.id)
    .then(() => false)
    .catch(() => true),
);

// A cancellation another station will see has to say why.
const cancelled = await demoPatient("902", "Demo Cancelled Patient");
const cancelledVisit = await one(
  `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_time, current_status, is_demo)
   VALUES ($1, $2::date, '10:30', 'booked', TRUE)
   ON CONFLICT (patient_id, visit_date) DO UPDATE SET current_status = 'booked'
   RETURNING id`,
  [cancelled, TEST_DAY],
);
check(
  "cancelling without a reason is refused",
  await markCancelled(cancelledVisit.id, "  ")
    .then(() => false)
    .catch(() => true),
);
await markCancelled(cancelledVisit.id, "Patient rescheduled to Friday");
const cancelEvent = await one(
  `SELECT status, actor_role, meta FROM giniflow_visit_events
    WHERE visit_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
  [cancelledVisit.id],
);
check(
  "the reason is carried in the event, not lost",
  cancelEvent.status === "cancelled" &&
    cancelEvent.meta?.reason === "Patient rescheduled to Friday",
  JSON.stringify(cancelEvent.meta),
);

// Marking someone absent whom a station has already seen is refused: the
// building has contradicted the claim.
const onFloorVisit = notComing.onFloor[0];
check(
  "a patient already on the floor cannot be marked absent",
  await markNoShow(onFloorVisit.visitId)
    .then(() => false)
    .catch(() => true),
  onFloorVisit.statusLabel,
);

// ── Walk-in ────────────────────────────────────────────────────────────────
const walkIn = await demoPatient("903", "Demo True Walkin");
const found = await searchWalkInPatients(TEST_DAY, "Demo True Walkin", "reception");
check(
  "a walk-in patient is findable by name",
  found.some((p) => p.patientId === walkIn),
);
check(
  "and is not already on the day's list",
  found.find((p) => p.patientId === walkIn)?.visitId == null,
);

const checkedIn = await checkInWalkIn({ patientId: walkIn, visitDate: TEST_DAY });
check("a walk-in is checked in in one action", checkedIn.status === "checked_in");
const walkInVisits = await one(
  `SELECT count(*)::int AS c FROM giniflow_visits WHERE patient_id = $1 AND visit_date = $2::date`,
  [walkIn, TEST_DAY],
);
check("exactly one visit is created", walkInVisits.c === 1, `${walkInVisits.c}`);
check(
  "it reuses the hospital's own walk-in booking record",
  !!checkedIn.walkinBookingId &&
    !!(await one(`SELECT id FROM walkin_bookings WHERE id = $1`, [checkedIn.walkinBookingId])),
);
check(
  "checking the same walk-in in twice changes nothing",
  (await checkInWalkIn({ patientId: walkIn, visitDate: TEST_DAY })).unchanged === true,
);

// §5.4 — the blocklist is the reason this goes through the walk-in path at all.
await pool.query(`UPDATE patients SET is_blocked = TRUE WHERE id = $1`, [walkIn]);
const blockedSearch = await searchWalkInPatients(TEST_DAY, "Demo True Walkin", "reception");
check(
  "a blocked patient is shown with their block, not hidden",
  blockedSearch.find((p) => p.patientId === walkIn)?.isBlocked === true,
);
const blockedPatient = await demoPatient("904", "Demo Blocked Walkin");
await pool.query(`UPDATE patients SET is_blocked = TRUE WHERE id = $1`, [blockedPatient]);
const refused = await checkInWalkIn({
  patientId: blockedPatient,
  visitDate: TEST_DAY,
  role: "reception",
})
  .then(() => false)
  .catch((e) => e.status === 409);
check("a blocked patient cannot be checked in", refused);
const noVisit = await one(`SELECT count(*)::int AS c FROM giniflow_visits WHERE patient_id = $1`, [
  blockedPatient,
]);
check("and no visit row is left behind for them", noVisit.c === 0, `${noVisit.c}`);
check(
  "a blocked patient stays off the arrivals board entirely",
  !(await getArrivals(TEST_DAY)).onFloor.some((a) => a.patientId === walkIn),
);

await cleanDemoDay();
const after = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS v,
          (SELECT count(*)::int FROM giniflow_test_catalog) AS cat`,
);
check("old flow_* module untouched", after.v === before.v, `${before.v}→${after.v}`);
check("the catalogue survives a smoke run", after.cat === before.cat, `${before.cat}→${after.cat}`);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
