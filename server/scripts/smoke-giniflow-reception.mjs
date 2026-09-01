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

// Insurance is the other way across the same line.
if (q2.pending[0]) {
  const claim = await clearPayment(q2.pending[0].orderId, { method: "insurance_claim" });
  check("an insurance claim also clears the order", claim.paymentStatus === "insurance_claim");
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
