// Every rule of the machine room, against synthetic orders
// (docs/gini-flow/36-MACHINE-TEST-STATION-PLAN.md §4).
//
// Runs inside one transaction that is ALWAYS rolled back: `DATABASE_URL` is
// production, and a fake patient must not survive the test that used it.
//
// The service manages its own transaction — it BEGINs and ROLLBACKs around every
// advance — so a refusal would tear down the outer transaction and every later
// check would fail with "Order not found". The fake pool below maps the
// service's BEGIN/COMMIT/ROLLBACK onto SAVEPOINTs, so a refused advance unwinds
// only itself and the test can carry on asking questions.
//
//   npm run smoke:machine-steps   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";
import {
  getMachineQueue,
  advanceMachineTest,
  addMachineTest,
} from "../services/giniflow/machineStation.js";
import { advanceSample } from "../services/giniflow/labStation.js";
import { MACHINES, machineForTest } from "../../shared/machineStages.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }))
  .toISOString()
  .slice(0, 10);
const TAG = `ZZMACH_${Date.now()}`;

const client = await pool.connect();

// The service's own transaction, nested inside ours.
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

let n = 0;
const makeOrder = async (
  testName,
  { payment = "paid", status = "vitals_done", vitals = true } = {},
) => {
  n += 1;
  const { rows: p } = await client.query(
    `INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`,
    [`Probe ${testName} ${n}`, `${TAG}_${n}`],
  );
  const { rows: v } = await client.query(
    `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
     VALUES ($1, $2::date, $3, 'none') RETURNING id`,
    [p[0].id, today, status],
  );
  // Vitals, recorded by a person. The machine room will not start a test before
  // them (39-HYBRID-FLOOR-PLAN.md §3 G1), and this suite is about P1/P2/P3 and
  // the evidence gate — the vitals gate has its own suite in smoke:routing-gates.
  if (vitals) {
    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role)
       VALUES ($1, 'vitals_done', 'vitals')`,
      [v[0].id],
    );
  }
  const { rows: o } = await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, urgency, payment_status, amount_total, amount_paid, sample_status, kind)
     VALUES ($1, 'today', $2, 500, CASE WHEN $2 = 'paid' THEN 500 ELSE 0 END, 'paid', 'machine')
     RETURNING id`,
    [v[0].id, payment],
  );
  await client.query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 500)`,
    [o[0].id, testName],
  );
  return { orderId: o[0].id, patientId: p[0].id };
};

let fatal = null;
try {
  await client.query("BEGIN");

  // P2 is a fact about the whole day, so this test cannot assume a machine is
  // free — real work, or the demo seed, may already be on one. Pick two that are
  // idle right now and use those.
  const { rows: busyNow } = await client.query(
    `SELECT COALESCE(t.names, ARRAY[]::text[]) AS names
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
       LEFT JOIN LATERAL (
         SELECT array_agg(lt.test_name) AS names
           FROM giniflow_lab_order_tests lt WHERE lt.lab_order_id = o.id
       ) t ON TRUE
      WHERE o.kind = 'machine' AND o.sample_status = 'in_progress' AND v.visit_date = $1::date`,
    [today],
  );
  const occupied = new Set(
    busyNow
      .flatMap((r) => r.names)
      .map((n) => machineForTest(n)?.id)
      .filter(Boolean),
  );
  const free = MACHINES.filter((m) => !occupied.has(m.id));
  if (free.length < 2) {
    console.log(`  --   fewer than two idle machines right now — P2 checks skipped`);
  }
  const MINE = free[0]?.tests[0] || "ABI";
  const OTHER = free[1]?.tests[0] || "Fundus";

  const abi = await makeOrder(MINE);
  const abi2 = await makeOrder(MINE);
  const vpt = await makeOrder(OTHER);
  const unpaid = await makeOrder("VPT", { payment: "pending" });
  const claimed = await makeOrder("Fundus", { payment: "insurance_claim" });
  const inRoom = await makeOrder("TMT", { status: "with_doctor" });
  const gone = await makeOrder("ECG", { status: "exited" });

  console.log("\n── P3 · payment gates the start ─────────────────────────────");
  const noPay = await refusal(() => advanceMachineTest(unpaid.orderId, { to: "in_progress" }, db));
  check("an unpaid test cannot be started", noPay?.status === 409, noPay?.message);
  const claim = await refusal(() => advanceMachineTest(claimed.orderId, { to: "in_progress" }, db));
  check("nor one on an unapproved claim", claim?.status === 409, claim?.message);

  console.log("\n── P1 · the patient is needed for the whole test ────────────");
  const busy = await refusal(() => advanceMachineTest(inRoom.orderId, { to: "in_progress" }, db));
  check("a patient another station has cannot be started", busy?.status === 409, busy?.message);
  const left = await refusal(() => advanceMachineTest(gone.orderId, { to: "in_progress" }, db));
  check("nor one who has gone home", left?.status === 409, left?.message);

  console.log("\n── P2 · one patient per machine ────────────────────────────");
  const first = await refusal(() => advanceMachineTest(abi.orderId, { to: "in_progress" }, db));
  check(`the first ${MINE} starts`, first === null, first?.message);
  const second = await refusal(() => advanceMachineTest(abi2.orderId, { to: "in_progress" }, db));
  check(`a second ${MINE} is refused while it is busy`, second?.status === 409, second?.message);
  const other = await refusal(() => advanceMachineTest(vpt.orderId, { to: "in_progress" }, db));
  check(`a different machine (${OTHER}) is unaffected`, other === null, other?.message);

  console.log("\n── A busy machine is not offered a Start button ────────────");
  // The service refuses a second patient on a busy machine, so the screen must
  // not offer the tap. A button that answers 409 is worse than no button.
  const busyQueue = await getMachineQueue(today, "Probe", client);
  // Only rows the earlier gates have already cleared: an unpaid test is blocked
  // for its own reason, and payment is checked first — correctly, since it is
  // the more fundamental refusal.
  const occupiedNow = new Set(busyQueue.in_progress.map((o) => o.machine).filter(Boolean));
  const queued = busyQueue.ordered.filter(
    (o) => occupiedNow.has(o.machine) && o.paid && o.collectable,
  );
  check(
    "the queue behind a busy machine has no action",
    queued.length > 0 && queued.every((o) => o.nextAction === null),
    `${queued.length} queued behind ${[...occupiedNow].join(", ") || "nothing"}`,
  );
  check(
    "and says which machine, and who is on it",
    queued.every((o) => /busy/.test(o.blockedReason || "")),
    queued[0]?.blockedReason,
  );

  console.log("\n── The evidence gate ───────────────────────────────────────");
  // A machine prints its report while the patient is still in the chair, so the
  // test being over and the result existing are the same moment — unlike a tube,
  // whose result comes back hours after it was collected. Finishing therefore
  // needs the evidence, not just filing does.
  const empty = await refusal(() => advanceMachineTest(abi.orderId, { to: "done" }, db));
  check("a test cannot be finished with nothing recorded", empty?.status === 409, empty?.message);
  const emptyFile = await refusal(() => advanceMachineTest(abi.orderId, { to: "reported" }, db));
  check("nor filed", emptyFile?.status === 409, emptyFile?.message);

  await client.query(
    `INSERT INTO lab_results (patient_id, test_name, test_date, lab_order_id)
     VALUES ($1, 'ABI Right', CURRENT_DATE, $2)`,
    [abi.patientId, abi.orderId],
  );
  const filed = await advanceMachineTest(abi.orderId, { to: "done" }, db);
  check(
    "once a value is typed it can be finished",
    filed.sampleStatus === "reported",
    filed.sampleStatus,
  );
  check(
    "and finishing files it — one tap, not two",
    filed.sampleStatus === "reported",
    "the evidence was already there; a second tap would confirm what was just done",
  );
  const { rows: evs } = await client.query(
    `SELECT status FROM giniflow_lab_order_events WHERE lab_order_id = $1 ORDER BY occurred_at`,
    [abi.orderId],
  );
  check(
    "both steps stay on the record",
    evs
      .map((e) => e.status)
      .join(" ")
      .includes("done reported"),
    evs.map((e) => e.status).join(" → "),
  );

  console.log("\n── The ladder only moves forwards ──────────────────────────");
  const back = await advanceMachineTest(abi.orderId, { to: "in_progress" }, db);
  check("going backwards is a no-op, not an error", back.unchanged === true);
  const nonsense = await refusal(() => advanceMachineTest(abi.orderId, { to: "teleported" }, db));
  check("an invented status is refused", nonsense?.status === 400, nonsense?.message);

  console.log("\n── The machine that is busy, and the wait behind it ────────");
  const q = await getMachineQueue(today, "Probe", client);
  const byId = Object.fromEntries(q.machines.map((m) => [m.id, m]));
  const mineId = machineForTest(MINE)?.id;
  const otherId = machineForTest(OTHER)?.id;
  check(`${OTHER} shows who is on it`, !!byId[otherId].onIt?.name, byId[otherId].onIt?.name);
  check(`${MINE} is free again once its test is filed`, byId[mineId].onIt === null);
  check(
    "the wait behind a machine is its queue times its duration",
    MACHINES.every((m) => byId[m.id].waitMinutes >= byId[m.id].waiting * m.durationMin),
    MACHINES.map((m) => `${m.id} ${byId[m.id].waiting}×${m.durationMin}m`).join(" · "),
  );

  console.log("\n── An unmatched test is listed once ────────────────────────");
  const stageRows = [
    ...busyQueue.ordered,
    ...busyQueue.in_progress,
    ...busyQueue.done,
    ...busyQueue.reported,
  ];
  check(
    "a test matching no machine is not also in a stage section",
    stageRows.every((o) => o.machine),
    `${busyQueue.unassigned.length} unassigned`,
  );

  console.log("\n── Filtering is server-side ────────────────────────────────");
  const onlyAbi = await getMachineQueue(today, "Probe", client, { machine: "abi" });
  const rows = [...onlyAbi.ordered, ...onlyAbi.in_progress, ...onlyAbi.done, ...onlyAbi.reported];
  check(
    "asking for one machine returns only its rows",
    rows.every((r) => r.machine === "abi"),
  );
  check(
    "and the counts still describe the whole day",
    onlyAbi.counts.in_progress === q.counts.in_progress,
    `${onlyAbi.counts.in_progress} vs ${q.counts.in_progress}`,
  );
  const onlyWaiting = await getMachineQueue(today, "Probe", client, { group: "ordered" });
  check("asking for one stage returns only that stage", onlyWaiting.in_progress.length === 0);
  const bogus = await getMachineQueue(today, "Probe", client, { machine: "teleporter" });
  check("an unknown machine falls back to all", bogus.machine === null);

  console.log("\n── Raising a test at the machine ───────────────────────────");
  // Without this the station depends on a doctor remembering during the
  // consultation, and today's floor says that does not happen.
  const { rows: onFloor } = await client.query(
    `SELECT v.id FROM giniflow_visits v
      WHERE v.visit_date = $1::date AND v.current_status <> ALL($2::text[]) LIMIT 1`,
    [today, ["exited", "dispensed", "no_show", "cancelled", "abandoned"]],
  );
  if (onFloor.length) {
    // The machines are all catalogued now, so the unpriced case has to be
    // created rather than assumed: take Fundus out of the catalogue, prove the
    // refusal, put it back. Rolled back with everything else either way.
    await client.query(
      `UPDATE giniflow_test_catalog SET is_active = FALSE WHERE UPPER(test_name) = 'FUNDUS'`,
    );
    const unpriced = await refusal(() =>
      addMachineTest(onFloor[0].id, { machineId: "fundus" }, db),
    );
    check(
      "a test with no catalogue price cannot be raised",
      unpriced?.status === 409,
      unpriced?.message,
    );

    await client.query(
      `INSERT INTO giniflow_test_catalog (test_name, category, price, is_active)
       VALUES ('Fundus', 'machine', 400, TRUE)
       ON CONFLICT (test_name) DO UPDATE
         SET category = 'machine', price = 400, is_active = TRUE`,
    );

    const added = await refusal(() => addMachineTest(onFloor[0].id, { machineId: "fundus" }, db));
    check("a priced test can be raised for a patient on the floor", added === null, added?.message);
    const again = await addMachineTest(onFloor[0].id, { machineId: "fundus" }, db);
    check("raising it twice is one statement, not two cards", again.alreadyThere === true);

    // The billing gate, the same one the collection bench has. A test raised at
    // the machine is not a test the hospital has been paid for.
    const { rows: raised } = await client.query(
      `SELECT payment_status, sample_status, amount_total, amount_paid
         FROM giniflow_lab_orders WHERE id = $1`,
      [again.orderId],
    );
    check(
      "and it is raised unpaid, for reception to clear",
      raised[0].payment_status === "pending" &&
        raised[0].sample_status === "payment_pending" &&
        Number(raised[0].amount_paid) === 0,
      `${raised[0].payment_status} / ${raised[0].sample_status} / paid ${raised[0].amount_paid} of ${raised[0].amount_total}`,
    );
    const unbilled = await refusal(() =>
      advanceMachineTest(again.orderId, { to: "in_progress" }, db),
    );
    check(
      "the test cannot start until the desk clears it",
      unbilled?.status === 409,
      unbilled?.message,
    );

    const bogus = await refusal(() =>
      addMachineTest(onFloor[0].id, { machineId: "teleporter" }, db),
    );
    check("an unknown machine is refused", bogus?.status === 400, bogus?.message);
  }
  const { rows: leftAlready } = await client.query(
    `SELECT v.id FROM giniflow_visits v
      WHERE v.visit_date = $1::date AND v.current_status = 'exited' LIMIT 1`,
    [today],
  );
  if (leftAlready.length) {
    const tooLate = await refusal(() =>
      addMachineTest(leftAlready[0].id, { machineId: "abi" }, db),
    );
    check("a patient who has gone cannot be given one", tooLate?.status === 409, tooLate?.message);
  }

  console.log("\n── Neither station works the other's orders ────────────────");
  const { rows: labOrder } = await client.query(
    `SELECT id FROM giniflow_lab_orders WHERE kind = 'lab' LIMIT 1`,
  );
  if (labOrder.length) {
    const wrong = await refusal(() =>
      advanceMachineTest(labOrder[0].id, { to: "in_progress" }, db),
    );
    check("the machine room refuses a lab order", wrong?.status === 409, wrong?.message);

    // The mirror. A capability says which room somebody works, not which orders
    // exist — so the lab endpoint has to refuse a machine test just as firmly,
    // or the whole split is one API call from being undone.
    const backwards = await refusal(() =>
      advanceSample(abi.orderId, { to: "sample_collected" }, db),
    );
    check("and the lab refuses a machine test", backwards?.status === 409, backwards?.message);
  }

  console.log("\n── The board does not call a machine test a sample ─────────");
  const { rows: onBoard } = await client.query(
    `SELECT count(*)::int n
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
      WHERE v.visit_date = $1::date AND o.kind = 'machine' AND o.sample_status <> 'uploaded'`,
    [today],
  );
  check(
    "machine tests exist today that the lab track must not claim",
    onBoard[0].n > 0,
    `${onBoard[0].n} machine orders`,
  );
} catch (e) {
  fatal = e;
} finally {
  await client.query("ROLLBACK");
  client.release();
  const { rows } = await pool.query(`SELECT count(*)::int n FROM patients WHERE file_no LIKE $1`, [
    `${TAG}%`,
  ]);
  console.log(`\n  ${rows[0].n === 0 ? "ok " : "FAIL"}  the synthetic orders left no trace`);
  if (rows[0].n !== 0) failures++;
  await pool.end();
}

if (fatal) {
  console.error(fatal);
  process.exit(1);
}
console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
