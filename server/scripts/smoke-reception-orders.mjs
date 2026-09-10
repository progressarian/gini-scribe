// Tests reception names at check-in become real orders
// (docs/gini-flow/38-MANUAL-FLOOR-PLAN.md §3.1 — the lab and the machine room
// only have a queue if somebody orders the test here).
//
// Runs inside one transaction that is ALWAYS rolled back: `DATABASE_URL` is
// production, and a synthetic patient must not survive the test that used it.
// The services manage their own transactions, so the fake pool below maps their
// BEGIN/COMMIT/ROLLBACK onto SAVEPOINTs.
//
//   npm run smoke:reception-orders   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";
import { checkInWithJourney } from "../services/giniflow/journey.js";
import { getMachineQueue } from "../services/giniflow/machineStation.js";
import { getPaymentQueue } from "../services/giniflow/receptionStation.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const client = await pool.connect();
let depth = 0;
const nested = {
  query: (text, params) => {
    const sql = String(text).trim().toUpperCase();
    if (sql === "BEGIN") return client.query(`SAVEPOINT sp${++depth}`);
    if (sql === "COMMIT") return client.query(`RELEASE SAVEPOINT sp${depth--}`);
    if (sql === "ROLLBACK") return client.query(`ROLLBACK TO SAVEPOINT sp${depth--}`);
    return client.query(text, params);
  },
  release: () => {},
};
const db = { connect: async () => nested, query: (t, p) => client.query(t, p) };

const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return { message: e.message, status: e.status ?? null };
  }
};

const step = (catalogId, name, extra = {}) => ({
  catalogId,
  name,
  minutes: 5,
  source: "added",
  ...extra,
});

try {
  await client.query("BEGIN");
  const { rows: day } = await client.query(
    `SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`,
  );
  const today = day[0].d;

  const makeVisit = async (tag) => {
    const { rows: p } = await client.query(
      `INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`,
      [`Probe ${tag}`, `ZZRO_${tag}_${Date.now()}`],
    );
    const { rows: v } = await client.query(
      `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
       VALUES ($1, $2::date, 'booked', 'none') RETURNING id`,
      [p[0].id, today],
    );
    return v[0].id;
  };

  // The machine catalogue is empty on the floor today, so the priced rows this
  // test needs are seeded here and rolled back with everything else.
  await client.query(
    `INSERT INTO giniflow_test_catalog (test_name, category, price, is_active)
     VALUES ('ABI', 'machine', 400, TRUE)
     ON CONFLICT (test_name) DO UPDATE
       SET category = 'machine', price = 400, is_active = TRUE`,
  );

  console.log("── Blood Sample with tests raises a lab order ──────────────");
  const labVisit = await makeVisit("LAB");
  const labResult = await checkInWithJourney(
    labVisit,
    {
      steps: [
        step("vitals", "Vitals"),
        step("blood_sample", "Blood Sample", { tests: ["HbA1c", "TSH"] }),
      ],
      actorRole: "reception",
    },
    db,
  );
  check("one lab order is raised", !!labResult.raised.labOrderId);
  check(
    "for the tests the desk named",
    labResult.raised.labTests.length === 2,
    labResult.raised.labTests.join(", "),
  );

  const { rows: order } = await client.query(
    `SELECT payment_status, sample_status, amount_total, amount_paid, kind
       FROM giniflow_lab_orders WHERE id = $1`,
    [labResult.raised.labOrderId],
  );
  check(
    "unpaid, for the payment desk to clear",
    order[0].payment_status === "pending" &&
      order[0].sample_status === "payment_pending" &&
      Number(order[0].amount_paid) === 0,
    `${order[0].payment_status} / ${order[0].sample_status}`,
  );
  check(
    "priced from the catalogue",
    Number(order[0].amount_total) === 530,
    `₹${order[0].amount_total}`,
  );
  check("and it belongs to the lab, not a machine", order[0].kind === "lab");

  const { rows: ev } = await client.query(
    `SELECT track, status, actor_role FROM giniflow_lab_order_events WHERE lab_order_id = $1`,
    [labResult.raised.labOrderId],
  );
  check(
    "attributed to reception",
    ev[0]?.track === "payment" && ev[0]?.status === "pending" && ev[0]?.actor_role === "reception",
    `${ev[0]?.actor_role} ${ev[0]?.track}/${ev[0]?.status}`,
  );

  const { rows: billing } = await client.query(
    `SELECT step_catalog_id FROM giniflow_visit_steps WHERE visit_id = $1 ORDER BY step_order`,
    [labVisit],
  );
  check(
    "and Lab Billing joins the journey",
    billing.some((s) => s.step_catalog_id === "lab_billing"),
    billing.map((s) => s.step_catalog_id).join(" → "),
  );

  console.log("\n── It reaches reception's own payment desk ─────────────────");
  const payments = await getPaymentQueue(today, db);
  const mine = payments.pending.find((o) => o.orderId === labResult.raised.labOrderId);
  check("the order is pending on the desk", !!mine, `${payments.pending.length} pending today`);
  check(
    "with the outstanding amount to collect",
    mine?.outstanding === 530,
    `₹${mine?.outstanding}`,
  );
  check("and says which room is waiting", mine?.kind === "lab", mine?.kind);

  console.log("\n── Blood Sample with no tests raises nothing ──────────────");
  const emptyVisit = await makeVisit("EMPTY");
  const emptyResult = await checkInWithJourney(
    emptyVisit,
    { steps: [step("blood_sample", "Blood Sample")], actorRole: "reception" },
    db,
  );
  check(
    "no order, no bill — the step is just a stop",
    emptyResult.raised.labOrderId === null && emptyResult.raised.machine.length === 0,
  );
  // `blood_sample` is a default step on three visit types, so a check-in that
  // refused when nobody picked a test would break most arrivals on the floor.
  check("and the check-in still succeeds", emptyResult.steps.length === 1);

  console.log("\n── A Machine Room step raises a machine order ─────────────");
  const machineVisit = await makeVisit("MACH");
  const machineResult = await checkInWithJourney(
    machineVisit,
    { steps: [step("vitals", "Vitals"), step("abi", "ABI Test")], actorRole: "reception" },
    db,
  );
  check("one machine order is raised", machineResult.raised.machine.length === 1);
  check("for the right machine", machineResult.raised.machine[0]?.machine === "abi");

  const queue = await getMachineQueue(today, null, db);
  const card = queue.ordered.find((o) => o.visitId === machineVisit);
  check("the patient appears in the machine room queue", !!card, `${queue.total} orders today`);
  check("as unpaid", card && !card.paid, card?.paymentStatus);
  check(
    "with no Start button until the desk clears it",
    card?.nextAction === null && /payment/i.test(card?.blockedReason || ""),
    card?.blockedReason,
  );

  console.log("\n── An unpriced machine test refuses the check-in ──────────");
  await client.query(`UPDATE giniflow_test_catalog SET is_active = FALSE WHERE test_name = 'ABI'`);
  const unpricedVisit = await makeVisit("UNPRICED");
  const refused = await refusal(() =>
    checkInWithJourney(
      unpricedVisit,
      { steps: [step("abi", "ABI Test")], actorRole: "reception" },
      db,
    ),
  );
  check("refused rather than silently unbilled", refused?.status === 409, refused?.message);
  const { rows: rolled } = await client.query(
    `SELECT current_status FROM giniflow_visits WHERE id = $1`,
    [unpricedVisit],
  );
  check(
    "and the arrival rolled back with it — no half-checked-in patient",
    rolled[0].current_status === "booked",
    rolled[0].current_status,
  );
  const { rows: noSteps } = await client.query(
    `SELECT count(*)::int AS c FROM giniflow_visit_steps WHERE visit_id = $1`,
    [unpricedVisit],
  );
  check("with no journey left behind", noSteps[0].c === 0, `${noSteps[0].c} steps`);

  console.log("\n── An unknown test name is refused ────────────────────────");
  const bogusVisit = await makeVisit("BOGUS");
  const bogus = await refusal(() =>
    checkInWithJourney(
      bogusVisit,
      {
        steps: [step("blood_sample", "Blood Sample", { tests: ["Unobtainium"] })],
        actorRole: "reception",
      },
      db,
    ),
  );
  check("not in the catalogue, not an order", bogus?.status === 400, bogus?.message);

  console.log("\n── A second press does not bill twice ─────────────────────");
  const again = await checkInWithJourney(
    labVisit,
    {
      steps: [step("blood_sample", "Blood Sample", { tests: ["HbA1c", "TSH"] })],
      actorRole: "reception",
    },
    db,
  );
  check("the journey is left alone", again.alreadyPlanned === true);
  const { rows: count } = await client.query(
    `SELECT count(*)::int AS c FROM giniflow_lab_orders WHERE visit_id = $1`,
    [labVisit],
  );
  check("and there is still exactly one order", count[0].c === 1, `${count[0].c} orders`);
} finally {
  await client.query("ROLLBACK");
  client.release();
  const { rows: left } = await pool.query(
    `SELECT count(*)::int AS c FROM patients WHERE file_no LIKE 'ZZRO_%'`,
  );
  check("the synthetic patients left no trace", left[0].c === 0, `${left[0].c} rows`);
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  await pool.end();
  process.exit(failures ? 1 : 0);
}
