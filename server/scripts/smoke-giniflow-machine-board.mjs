import "../loadEnv.js";
import pool from "../config/db.js";
import {
  machineCardFor,
  ownedByMachineRoom,
  placementFor,
  getDayBoard,
  getSlaConfig,
  getBottleneck,
  getTestsPlacement,
  getTestSegments,
  testSegmentsFor,
  budgetMap,
} from "../services/giniflow/board.js";
import { getStationTimes, advanceStatus } from "../services/giniflow/statusEngine.js";
import { TESTS_HOLD_SQL } from "../services/giniflow/testsHold.js";
import { getMachines } from "../services/giniflow/machineCatalog.js";
import { getMachineQueue, getMachineTrack } from "../services/giniflow/machineStation.js";
import {
  firstUnrecordedStation,
  getBehindVisits,
  BEHIND_STATION_LABEL,
} from "../services/giniflow/observation.js";
import { placeTestsBeforeDoctors } from "../services/giniflow/journey.js";
import { requiredStepsFirst, testsBeforeDoctors } from "../../shared/journeyOrder.js";
import { machineForTest } from "../../shared/machineStages.js";
import {
  BOARD_COLUMNS,
  COLUMN_ENTRY_STATUS,
  ORDERED_COLUMNS,
  canDropInColumn,
  columnForStatus,
  MACHINE_COLUMNS,
  SIDE_TRACK_COLUMNS,
} from "../../shared/giniflowStatus.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const machines = await getMachines(pool);
const byId = Object.fromEntries(machines.map((m) => [m.id, m]));
const testName = (id) => byId[id]?.tests?.[0];
const now = new Date("2026-09-14T10:00:00Z");
const ago = (min) => new Date(now.getTime() - min * 60000).toISOString();
const order = (id, sampleStatus, extra = {}) => ({
  orderId: `o-${id}`,
  tests: [testName(id)],
  sampleStatus,
  paidAt: ago(60),
  startedAt: null,
  ...extra,
});

console.log("card builder");

check("no orders gives no card (T1)", machineCardFor({ orders: [] }, machines, now) === null);

const waiting = machineCardFor(
  { orders: [order("abi", "paid"), order("vpt", "paid")], steps: [], vitalsAt: ago(30) },
  machines,
  now,
);
check(
  "two waiting tests are listed with their catalogue budgets (T3)",
  waiting.tests.length === 2 &&
    waiting.budget === byId.abi.durationMin + byId.vpt.durationMin &&
    waiting.subtitle.startsWith("⏳ Waiting for"),
  waiting.subtitle,
);
check("the card clock starts at the later of payment and vitals", waiting.minutes === 30);

const dbShaped = machineCardFor(
  {
    orders: [order("abi", "paid", { paidAt: ago(20) })],
    steps: [],
    vitalsAt: new Date(now.getTime() - 90 * 60000),
  },
  machines,
  now,
);
check(
  "payment after vitals starts the clock at payment when vitals come back as a Date",
  dbShaped.minutes === 20,
  `${dbShaped.minutes}m`,
);

const overrun = machineCardFor(
  {
    orders: [order("tmt", "in_progress", { startedAt: ago(25) })],
    steps: [{ catalogId: "tmt", plannedMin: 20 }],
    vitalsAt: ago(40),
  },
  machines,
  now,
);
check(
  "a running test over its journey budget turns the card red (T4)",
  overrun.running && overrun.colour === "red" && overrun.subtitle.includes("25m of 20m"),
  overrun.subtitle,
);

const twoInOne = machineCardFor(
  {
    orders: [{ ...order("abi", "paid"), tests: [testName("abi"), testName("vpt")] }],
    steps: [],
    vitalsAt: ago(5),
  },
  machines,
  now,
);
check("one order naming two machines gives two tests (T5)", twoInOne.tests.length === 2);

const planned = machineCardFor(
  {
    orders: [order("tmt", "in_progress", { startedAt: ago(25) })],
    steps: [{ catalogId: "tmt", plannedMin: 30 }],
    vitalsAt: ago(40),
  },
  machines,
  now,
);
check(
  "the patient's own journey duration wins over the catalogue (T14)",
  planned.tests[0].budget === 30 && planned.subtitle.includes("25m of 30m"),
  planned.subtitle,
);

console.log("\nwhich machine room (plan 47)");

const roomOf = (orders) =>
  machineCardFor({ orders, steps: [], vitalsAt: ago(10) }, machines, now)?.column;
check("ABI alone is the Machine Room's", roomOf([order("abi", "paid")]) === "machine");
check("X-ray alone is the X-Ray column's", roomOf([order("x_ray", "paid")]) === "xray");
check("Echo alone is the Echo column's", roomOf([order("echo", "paid")]) === "echo");
check(
  "X-ray and Echo both open: X-ray first, because Echo needs it reported",
  roomOf([order("echo", "paid"), order("x_ray", "paid")]) === "xray",
);
check(
  "X-ray done but not reported still holds Echo back",
  roomOf([order("echo", "paid"), order("x_ray", "done")]) === "xray",
);
check(
  "a running test owns the patient wherever it is",
  roomOf([order("abi", "paid"), order("echo", "in_progress", { startedAt: ago(3) })]) === "echo",
);
check(
  "nothing running: the Machine Room goes before X-ray",
  roomOf([order("x_ray", "paid"), order("abi", "paid")]) === "machine",
);
check(
  "Machine Room only has a report pending: the patient moves on to X-ray",
  roomOf([order("abi", "done"), order("x_ray", "paid")]) === "xray",
);
check(
  "an uncatalogued test stays with the Machine Room",
  roomOf([{ ...order("abi", "paid"), tests: ["Some Unknown Scan"] }]) === "machine",
);
check(
  "the card still lists every open test, not only the owning room's",
  machineCardFor(
    { orders: [order("abi", "paid"), order("x_ray", "in_progress", { startedAt: ago(2) })] },
    machines,
    now,
  ).tests.length === 2,
);

console.log("\nunpaid machine tests (plan 47 §13)");

const unpaidOnly = machineCardFor(
  {
    orders: [
      order("abi", "payment_pending", { paid: false }),
      order("vpt", "payment_pending", { paid: false }),
    ],
    steps: [],
    vitalsAt: ago(10),
  },
  machines,
  now,
);
check(
  "only unpaid tests: the Machine Room column, waiting for payment",
  unpaidOnly.column === "machine" &&
    unpaidOnly.awaitingPayment &&
    unpaidOnly.subtitle.includes("payment pending at reception") &&
    unpaidOnly.tests.every((t) => t.unpaid),
  unpaidOnly.subtitle,
);
const paidBeatsUnpaid = machineCardFor(
  {
    orders: [
      order("x_ray", "payment_pending", { paid: false }),
      order("abi", "paid", { paid: true }),
    ],
    steps: [],
    vitalsAt: ago(10),
  },
  machines,
  now,
);
check(
  "a paid test that can start wins the room over an unpaid one",
  paidBeatsUnpaid.column === "machine" && !paidBeatsUnpaid.awaitingPayment,
  paidBeatsUnpaid.column,
);
const unpaidXrayOnly = machineCardFor(
  { orders: [order("x_ray", "payment_pending", { paid: false })], steps: [], vitalsAt: ago(10) },
  machines,
  now,
);
check(
  "an unpaid X-ray alone sits in X-Ray",
  unpaidXrayOnly.column === "xray",
  unpaidXrayOnly.column,
);

console.log("\nwhat holds a test back (plan 47 P2)");

const heldCard = (openTests, orders = [order("echo", "paid")]) =>
  machineCardFor({ orders, steps: [], vitalsAt: ago(10), openTests }, machines, now);
const echoOf = (c) => c.tests.find((t) => t.machine === "echo");
const unpaidXray = heldCard([
  { test: testName("echo"), paid: true },
  { test: testName("x_ray"), paid: false },
]);
check(
  "Echo paid, X-ray unpaid: the patient is in Echo, held by an unpaid X-ray (U1)",
  unpaidXray.column === "echo" &&
    echoOf(unpaidXray).heldBy?.machine === "x_ray" &&
    echoOf(unpaidXray).heldBy.unpaid === true,
  JSON.stringify(echoOf(unpaidXray).heldBy),
);
check(
  "Echo paid, no today X-ray: nothing holds it (U2)",
  echoOf(heldCard([{ test: testName("echo"), paid: true }])).heldBy === null,
);
check(
  "a paid X-ray holds Echo without the unpaid wording",
  echoOf(
    heldCard([
      { test: testName("echo"), paid: true },
      { test: testName("x_ray"), paid: true },
    ]),
  ).heldBy?.unpaid === false,
);
check(
  "a running Echo is never marked held",
  heldCard(
    [
      { test: testName("echo"), paid: true },
      { test: testName("x_ray"), paid: true },
    ],
    [order("echo", "in_progress", { startedAt: ago(2) })],
  ).tests[0].heldBy === null,
);

console.log("\njourney order (plan 47 P4)");

const step = (catalogId, status = "pending", extra = {}) => ({ catalogId, status, ...extra });
const requiresOf = (st) => byId[st.catalogId]?.requiresBefore || null;
const ids = (list) => list.map((st) => st.catalogId).join(",");
const echoFirst = [step("vitals", "done"), step("echo"), step("x_ray"), step("chief_consult")];
check(
  "Echo before X-ray is swapped (U4)",
  ids(requiredStepsFirst(echoFirst, { requiresOf })) === "vitals,x_ray,echo,chief_consult",
  ids(requiredStepsFirst(echoFirst, { requiresOf })),
);
const started = [step("vitals"), step("echo", "in_progress"), step("x_ray")];
check(
  "a started Echo is left where it is (U5)",
  requiredStepsFirst(started, { requiresOf }) === started,
);
const fine = [step("vitals"), step("x_ray"), step("echo")];
check(
  "nothing to move returns the same list (U6)",
  requiredStepsFirst(fine, { requiresOf }) === fine,
);
const mixed = [
  step("vitals", "done"),
  step("echo", "pending", { machine: true }),
  step("x_ray", "pending", { machine: true }),
  step("chief_consult", "pending", { chainStatus: "with_doctor" }),
  step("blood_sample"),
  step("lab_billing"),
];
check(
  "with lab steps: billing, blood, X-ray, Echo, then the doctor (U7)",
  ids(requiredStepsFirst(testsBeforeDoctors(mixed), { requiresOf })) ===
    "vitals,lab_billing,blood_sample,x_ray,echo,chief_consult",
);

console.log("\ntimeline names the room (plan 47 P3)");

const segLabels = (station, label) =>
  testSegmentsFor(
    {
      vitalsAt: new Date(now.getTime() - 60 * 60000),
      machineOrders: [
        {
          station,
          label,
          createdAt: new Date(now.getTime() - 50 * 60000),
          paidAt: new Date(now.getTime() - 50 * 60000),
          startedAt: new Date(now.getTime() - 20 * 60000),
          doneAt: null,
        },
      ],
    },
    now,
  ).map((seg) => seg.label);
const echoSegs = segLabels("echo", "2D Echo");
check(
  "an Echo visit waits for Echo and runs on the Echo machine (U8)",
  echoSegs.includes("Waiting for Echo — 2D Echo") &&
    echoSegs.includes("On the Echo machine — 2D Echo"),
  echoSegs.join(" | "),
);
const abiSegs = segLabels("machine_room", "ABI");
check(
  "a Machine Room visit keeps its wording (U9)",
  abiSegs.includes("Waiting for the Machine Room — ABI") &&
    abiSegs.includes("On the machine — ABI"),
  abiSegs.join(" | "),
);

console.log("\nownership");

const card = (status, extra = {}) => ({ status, finished: false, machine: waiting, ...extra });
const vitals = { vitalsAt: ago(10) };
check(
  "no vitals recorded keeps the patient in Checked in (T8)",
  !ownedByMachineRoom(card("checked_in"), {}),
);
check(
  "at the vitals desk stays in the vitals column (T8)",
  !ownedByMachineRoom(card("with_vitals"), vitals),
);
check(
  "vitals recorded belongs to the Machine Room even if still marked checked in",
  ownedByMachineRoom(card("checked_in"), vitals),
);
check(
  "vitals done belongs to the Machine Room (T3)",
  ownedByMachineRoom(card("vitals_done"), vitals),
);
check(
  "a samples-only patient needs no vitals",
  ownedByMachineRoom(card("checked_in", { labOnly: true }), {}),
);
check(
  "a Scribe-written room keeps the patient in that room (T13)",
  !ownedByMachineRoom(card("with_sd"), { ...vitals, roomSource: "mo_station" }),
);
check(
  "a room written by the HealthRay sync does not hold the patient",
  ownedByMachineRoom(card("with_sd"), { ...vitals, roomSource: "healthray" }),
);
check(
  "no machine card means no ownership (T6)",
  !ownedByMachineRoom(card("sd_pending", { machine: null }), vitals),
);
check(
  "a finished visit is never owned",
  !ownedByMachineRoom(card("exited", { finished: true }), vitals),
);

console.log("\none station at a time");

const both = { ...vitals, labUndrawn: 1, labOpen: 1 };
check(
  "lab + machine after vitals: the lab comes first",
  placementFor(card("vitals_done"), both) === "lab",
);
check(
  "once the sample is collected the patient goes to the machine",
  placementFor(card("vitals_done"), { ...vitals, labUndrawn: 0, labOpen: 1 }) === "machine",
);
check(
  "machine done, lab reports still out: waiting at the lab, not the Chief",
  placementFor(card("vitals_done", { machine: null }), { ...vitals, labUndrawn: 0, labOpen: 1 }) ===
    "lab",
);
check(
  "lab only after vitals: at the lab until reports are done",
  placementFor(card("vitals_done", { machine: null }), both) === "lab",
);
check(
  "machine only after vitals: at the machine",
  placementFor(card("vitals_done"), vitals) === "machine",
);
check(
  "no tests after vitals: the Chief",
  placementFor(card("vitals_done", { machine: null }), vitals) === "chain",
);
check(
  "tests ordered by the Chief (HealthRay room): the patient leaves for the lab",
  placementFor(card("with_sd"), { ...both, roomSource: "healthray" }) === "lab",
);
check(
  "all tests done: back to the Chief",
  placementFor(card("with_sd", { machine: null }), { ...vitals, roomSource: "healthray" }) ===
    "chain",
);
check(
  "before vitals nothing pulls the patient to a test",
  placementFor(card("checked_in"), { labUndrawn: 1, labOpen: 1 }) === "chain",
);

console.log("\ntimeline segments");

const at = (min) => new Date(now.getTime() - min * 60000);
const labels = (segs) => segs.map((x) => x.status).join(" → ");
const full = testSegmentsFor(
  {
    vitalsAt: at(200),
    testsOrderedAt: at(180),
    labOrderedAt: at(180),
    labPaidAt: at(170),
    labUndrawn: 0,
    labOpen: 0,
    labDrawnAt: at(120),
    labReportedAt: at(30),
    machineOrders: [
      {
        createdAt: at(180),
        paidAt: at(160),
        startedAt: at(100),
        doneAt: at(80),
        reportedAt: at(70),
      },
    ],
    machineLabel: "ABI",
    machineBudget: 10,
  },
  now,
);
check(
  "lab + machine: payment wait → lab → waiting for the machine → on the machine → reports wait",
  labels(full) === "payment_wait → lab_room → machine_wait → machine_room → reports_wait",
  labels(full),
);
check(
  "the machine wait runs from the lab draw to the start; time on the machine ends when the test is done",
  full[2].from.getTime() === at(120).getTime() &&
    full[2].to.getTime() === at(100).getTime() &&
    full[3].from.getTime() === at(100).getTime() &&
    full[3].to.getTime() === at(80).getTime(),
);
check(
  "segments never overlap",
  full.every((x, i) => i === 0 || x.from >= full[i - 1].to),
);
const exited = testSegmentsFor(
  {
    vitalsAt: at(200),
    testsOrderedAt: at(190),
    labOrderedAt: at(190),
    labPaidAt: at(190),
    labUndrawn: 1,
    labOpen: 1,
    endAt: at(150),
  },
  now,
);
check(
  "nothing is timed after the visit ended",
  exited.every((x) => x.to && x.to <= at(150)),
  labels(exited),
);
check("no tests means no test steps", testSegmentsFor({ vitalsAt: at(50) }, now).length === 0);

console.log("\ncolumn vocabulary (T11)");

for (const key of MACHINE_COLUMNS) {
  check(
    `${key} column exists`,
    BOARD_COLUMNS.some((c) => c.key === key),
  );
  check(`${key} is not a drop target`, COLUMN_ENTRY_STATUS[key] === null);
  check(`${key} is not in the chain order`, !ORDERED_COLUMNS.includes(key));
  check(
    `no status maps to ${key}`,
    ["vitals_done", "sd_pending", "with_sd"].every((s) => columnForStatus(s) !== key),
  );
  check(
    `nothing can be dropped on ${key}`,
    !canDropInColumn({ status: "vitals_done", column: "sd" }, key),
  );
}
const order_ = BOARD_COLUMNS.map((c) => c.key);
check(
  "X-Ray sits before Echo on the board",
  order_.indexOf("machine") < order_.indexOf("xray") &&
    order_.indexOf("xray") < order_.indexOf("echo"),
);

console.log("\ntoday's board (read-only)");

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const sla = await getSlaConfig(pool);
const board = await getDayBoard(today, sla);
const machineCols = board.columns.filter((c) => MACHINE_COLUMNS.includes(c.key));
const machineCards = machineCols.flatMap((c) => c.cards);
const chain = board.columns.filter((c) => !SIDE_TRACK_COLUMNS.includes(c.key));
check(
  "no Machine Room patient also sits in a chain column",
  chain.every((c) => c.cards.every((x) => !x.machineOwned)),
);
check(
  "every machine card has at least one open test",
  machineCards.every((x) => x.machine?.tests?.length > 0),
);
check(
  "every machine card sits in the column its owning room names",
  machineCols.every((c) => c.cards.every((x) => x.machine.column === c.key)),
);
check(
  "no finished patient is on a machine column",
  machineCards.every((x) => !x.finished),
);
check(
  "a machine patient is judged on the machine clock everywhere (stats, filters)",
  machineCards.every(
    (x) => x.statusColour === x.machine.colour && x.statusMinutes === x.machine.minutes,
  ),
);
for (const col of machineCols) {
  const timed = col.cards.filter((x) => x.machine.budget);
  check(
    `the ${col.key} column budget is the mean of its patients' journey budgets`,
    timed.length === 0 ||
      col.budgetMinutes ===
        Math.round(timed.reduce((a, x) => a + x.machine.budget, 0) / timed.length),
  );
}
const places = (x) =>
  board.columns.filter((c) => c.cards.some((y) => y.id === x.id)).map((c) => c.key);
const misplaced = board.onFloor
  .filter((x) => !x.finished && !x.labOnly)
  .filter((x) => places(x).length !== 1);
check(
  "every patient in the building is at exactly one place on the board",
  misplaced.length === 0,
  misplaced.map((x) => `${x.name}: ${places(x).join("+") || "nowhere"}`).join("; "),
);
for (const x of machineCards) {
  const hold = await getTestsPlacement(x.id, new Date(), pool);
  check(
    `timeline hold agrees with the board for ${x.name}`,
    !!hold &&
      hold.since === x.machine.since &&
      hold.budget === x.machine.budget &&
      hold.machine.column === x.machine.column,
  );
  const tests = await getTestSegments(x.id, new Date(), pool);
  const times = await getStationTimes(pool, x.id, budgetMap(sla), new Date(), {
    slaConfig: sla,
    segments: tests.segments,
    orderTimes: tests.orderTimes,
  });
  const current = times.find((s) => s.isCurrent);
  check(
    `timeline current step is the Machine Room for ${x.name}`,
    (x.machine.awaitingPayment ? ["payment_wait"] : ["machine_wait", "machine_room"]).includes(
      current?.status,
    ),
    current?.label,
  );
}
for (const x of board.onFloor.filter((c) => !c.machineOwned).slice(0, 20)) {
  check(
    `no timeline hold for ${x.name} (not in the Machine Room)`,
    !(await getTestsPlacement(x.id, new Date(), pool)),
  );
}
console.log("\nno automatic move while tests are open (rolled back)");

const { rows: openVisits } = await pool.query(
  `SELECT v.id, p.name, v.current_status
     FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
     CROSS JOIN LATERAL (${TESTS_HOLD_SQL("v", "p")}) h
    WHERE v.visit_date = $1::date AND h.tests_pending > 0
      AND v.current_status IN ('vitals_done', 'sd_pending', 'with_sd', 'ready_for_doctor')
    LIMIT 3`,
  [today],
);
for (const visit of openVisits) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const refused = await advanceStatus(client, {
      visitId: visit.id,
      toStatus: "rx_pending",
      actorRole: "system",
      allowSkip: true,
      meta: { source: "healthray" },
    })
      .then(() => null)
      .catch((e) => e);
    check(
      `HealthRay cannot move ${visit.name} (${visit.current_status}) while tests are open`,
      refused?.status === 409,
      refused?.message,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
if (!openVisits.length) console.log("  ·  no visit with open tests today to try");

const bottleneck = getBottleneck(board.columns);
check(
  "bottleneck is computable with the new column",
  bottleneck === null || typeof bottleneck.label === "string",
  bottleneck?.label || "none",
);
console.log("\nbehind, timeline and station agree on the room (plan 47 L1–L5)");

const ROOM_ORDER = ["machine_room", "xray", "echo"];
const ROOM_KEY = { machine_room: "machine", xray: "xray", echo: "echo" };
const { rows: openByVisit } = await pool.query(
  `SELECT o.visit_id, array_agg(t.test_name) AS names
     FROM giniflow_lab_orders o
     JOIN giniflow_visits v ON v.id = o.visit_id
     JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
    WHERE v.visit_date = $1::date AND o.kind = 'machine' AND o.urgency = 'today'
      AND o.sample_status <> 'reported'
    GROUP BY 1`,
  [today],
);
for (const r of openByVisit) {
  const owed = await firstUnrecordedStation(pool, r.visit_id);
  if (!["machine", "xray", "echo"].includes(owed)) continue;
  const rooms = r.names.map((n) => machineForTest(machines, n)?.station || "machine_room");
  const expected = ROOM_KEY[ROOM_ORDER.find((room) => rooms.includes(room))];
  check(
    `behind names ${BEHIND_STATION_LABEL[expected]} for ${r.names.join(", ")} (L1)`,
    owed === expected,
    owed,
  );
}
if (!openByVisit.length) console.log("  ·  no open machine tests today to check behind against");
for (const station of ["machine", "xray", "echo"]) {
  const rows = await getBehindVisits(today, pool, { station });
  check(
    `Behind filtered to ${station} returns only ${station} rows (L2)`,
    rows.every((x) => x.station === station),
    `${rows.length} row(s)`,
  );
}
for (const x of machineCards) {
  const track = await getMachineTrack(pool, x.id, new Date());
  const room = machineCols.find((c) => c.key === x.machine.column)?.name;
  check(
    `timeline rooms for ${x.name} include ${room} (L3)`,
    track.some((m) => m.room === room),
    track.map((m) => m.room).join(", "),
  );
}
const echoQueue = await getMachineQueue(today, null, pool, { station: "echo" });
const echoRows = [
  ...(echoQueue.ordered || []),
  ...(echoQueue.in_progress || []),
  ...(echoQueue.done || []),
];
for (const x of machineCards.filter((c) => c.machine.tests.some((t) => t.heldBy))) {
  const row = echoRows.find((o) => o.visitId === x.id && o.machine === "echo");
  check(
    `the Echo screen also holds ${x.name} back (L5)`,
    !!row && row.nextAction === null && /must be done before/.test(row.blockedReason || ""),
    row?.blockedReason,
  );
}

console.log("\njourney reorder on a real visit (rolled back, R2)");

const { rows: misordered } = await pool.query(
  `SELECT x.visit_id
     FROM giniflow_visit_steps x
     JOIN giniflow_visit_steps e ON e.visit_id = x.visit_id AND e.step_catalog_id = 'echo'
     JOIN giniflow_visits v ON v.id = x.visit_id
    WHERE x.step_catalog_id = 'x_ray' AND v.visit_date = $1::date
      AND x.status = 'pending' AND e.status = 'pending' AND e.step_order < x.step_order
    LIMIT 3`,
  [today],
);
for (const { visit_id: visitId } of misordered) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const moved = await placeTestsBeforeDoctors(client, visitId);
    const { rows: after } = await client.query(
      `SELECT step_catalog_id FROM giniflow_visit_steps
        WHERE visit_id = $1 AND step_catalog_id IN ('x_ray', 'echo') ORDER BY step_order`,
      [visitId],
    );
    check(
      "an Echo-before-X-ray journey is put right",
      moved && after.map((a) => a.step_catalog_id).join(",") === "x_ray,echo",
      after.map((a) => a.step_catalog_id).join(","),
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
if (!misordered.length) console.log("  ·  no misordered journey today");

console.log("\nunpaid lab test puts the patient on the Lab track (rolled back)");

const { rows: plainWaiters } = await pool.query(
  `SELECT v.id, p.name
     FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
    WHERE v.visit_date = $1::date AND v.current_status = 'vitals_done'
      AND NOT EXISTS (SELECT 1 FROM giniflow_lab_orders o WHERE o.visit_id = v.id)
      AND NOT EXISTS (SELECT 1 FROM lab_cases lc
                       WHERE lc.patient_id = v.patient_id AND lc.case_date = v.visit_date)
    LIMIT 1`,
  [today],
);
for (const visit of plainWaiters) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await getTestsPlacement(visit.id, new Date(), client);
    await client.query(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, sample_status, kind)
       VALUES ($1, 'today', 'pending', 'payment_pending', 'lab')`,
      [visit.id],
    );
    const hold = await getTestsPlacement(visit.id, new Date(), client);
    check(
      `${visit.name}: no hold before, Lab track with a payment wait after an unpaid order`,
      before === null &&
        hold?.kind === "lab" &&
        hold.label === "Waiting for payment at reception — lab tests",
      hold?.label,
    );
    const lab = await getTestSegments(visit.id, new Date(), client);
    const last = lab.segments[lab.segments.length - 1];
    check(
      "its timeline ends in an open payment wait",
      last?.status === "payment_wait" && last.to === null,
      last?.label,
    );
    const labBoard = await getDayBoard(today, sla, undefined, client);
    const labCol = labBoard.columns.find((c) => c.key === "lab");
    const card = labCol.cards.find((c) => c.id === visit.id);
    check(
      "it is on the Lab track, not in a doctor column, saying reception is next",
      !!card &&
        labBoard.columns.filter((c) => c.cards.some((x) => x.id === visit.id)).length === 1 &&
        /reception/i.test(card.lab.hint || ""),
      card?.lab?.hint,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
if (!plainWaiters.length) console.log("  ·  no plain vitals_done visit today to try");

console.log(`  ·  today: ${machineCols.map((c) => `${c.name} ${c.count}`).join(", ")}`);

const { rows } = await pool.query(
  `SELECT o.id
     FROM giniflow_lab_orders o JOIN giniflow_visits v ON v.id = o.visit_id
    WHERE v.visit_date = $1::date AND o.kind = 'machine' AND o.urgency = 'today'
      AND o.payment_status NOT IN ('paid', 'claim_approved')
      AND o.sample_status <> 'reported'`,
  [today],
);
const unpaid = new Set(rows.map((r) => r.id));
const onTrackUnpaid = board.cards.flatMap((x) =>
  (x.machine?.tests || []).filter((t) => unpaid.has(t.orderId)),
);
check(
  "unpaid machine orders are on the card, marked as waiting for payment (T2)",
  onTrackUnpaid.every((t) => t.unpaid && t.stage === "waiting"),
  `${unpaid.size} unpaid open order(s) today, ${onTrackUnpaid.length} on a card`,
);
const heldInChain = chain.flatMap((c) => c.cards).filter((x) => x.machine?.tests?.length);
check(
  "nobody with an open machine test is left in a doctor column after vitals",
  heldInChain.every((x) => x.placement !== "chain" || !x.machine || x.status !== "vitals_done"),
  heldInChain.map((x) => `${x.fileNo} ${x.status}`).join("; "),
);

await pool.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
