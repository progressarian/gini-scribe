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
import {
  BOARD_COLUMNS,
  COLUMN_ENTRY_STATUS,
  ORDERED_COLUMNS,
  canDropInColumn,
  columnForStatus,
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

check(
  "Machine Room column exists",
  BOARD_COLUMNS.some((c) => c.key === "machine"),
);
check("it is not a drop target", COLUMN_ENTRY_STATUS.machine === null);
check("it is not in the chain order", !ORDERED_COLUMNS.includes("machine"));
check(
  "no status maps to it",
  ["vitals_done", "sd_pending", "with_sd"].every((s) => columnForStatus(s) !== "machine"),
);
check(
  "nothing can be dropped on it",
  !canDropInColumn({ status: "vitals_done", column: "sd" }, "machine"),
);

console.log("\ntoday's board (read-only)");

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const sla = await getSlaConfig(pool);
const board = await getDayBoard(today, sla);
const machineCol = board.columns.find((c) => c.key === "machine");
const chain = board.columns.filter((c) => !["lab", "machine"].includes(c.key));
check(
  "no Machine Room patient also sits in a chain column",
  chain.every((c) => c.cards.every((x) => !x.machineOwned)),
);
check(
  "every Machine Room card has at least one open test",
  machineCol.cards.every((x) => x.machine?.tests?.length > 0),
);
check(
  "no finished patient is on the Machine Room column",
  machineCol.cards.every((x) => !x.finished),
);
check(
  "a Machine Room patient is judged on the machine clock everywhere (stats, filters)",
  machineCol.cards.every(
    (x) => x.statusColour === x.machine.colour && x.statusMinutes === x.machine.minutes,
  ),
);
check(
  "the column budget is the mean of the patients' journey budgets",
  machineCol.cards.filter((x) => x.machine.budget).length === 0 ||
    machineCol.budgetMinutes ===
      Math.round(
        machineCol.cards.filter((x) => x.machine.budget).reduce((a, x) => a + x.machine.budget, 0) /
          machineCol.cards.filter((x) => x.machine.budget).length,
      ),
);
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
for (const x of machineCol.cards) {
  const hold = await getTestsPlacement(x.id, new Date(), pool);
  check(
    `timeline hold agrees with the board for ${x.name}`,
    !!hold && hold.since === x.machine.since && hold.budget === x.machine.budget,
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
    ["machine_wait", "machine_room"].includes(current?.status),
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
console.log(`  ·  Machine Room today: ${machineCol.count} patient(s)`);

const { rows } = await pool.query(
  `SELECT o.id
     FROM giniflow_lab_orders o JOIN giniflow_visits v ON v.id = o.visit_id
    WHERE v.visit_date = $1::date AND o.kind = 'machine' AND o.urgency = 'today'
      AND o.payment_status NOT IN ('paid', 'claim_approved')
      AND o.sample_status <> 'reported'`,
  [today],
);
const unpaid = new Set(rows.map((r) => r.id));
check(
  "unpaid machine orders never reach the track (T2)",
  board.cards.every((x) => (x.machine?.tests || []).every((t) => !unpaid.has(t.orderId))),
  `${unpaid.size} unpaid open order(s) today`,
);

await pool.end();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
