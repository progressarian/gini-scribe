// Smoke test for the Gini Flow board: seeds a demo day, checks the board the
// engine produces against the log it was seeded from, then cleans up.
//
// Also asserts isolation — the older flow_* module must be byte-for-byte
// untouched by anything Gini Flow does. That is the regression test for the
// separation decision in docs/gini-flow/00-OVERVIEW.md §2.3.
//
//   npm run smoke:giniflow   (from server/)
import "../loadEnv.js";
// The seeder refuses to run without this; the smoke script is the one caller
// that always wants it, so it opts in explicitly rather than relying on .env.
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import {
  getSlaConfig,
  budgetMap,
  getDayBoard,
  getBottleneck,
  getDayStats,
  getStationAverages,
} from "../services/giniflow/board.js";
import { getStationTimes, advanceStatus } from "../services/giniflow/statusEngine.js";
import { CHAIN } from "../../shared/giniflowStatus.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

const before = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS visits,
          (SELECT count(*)::int FROM flow_events) AS events`,
);

// Seed a day of the suite's own rather than today: since the HealthRay sync
// runs, today's board holds real patients and asserting fixed counts against a
// mixture of both is meaningless.
const TEST_DAY = "2019-01-02";
await cleanDemoDay();
const seeded = await seedDemoDay({ date: TEST_DAY });
console.log(`\nseeded ${seeded.visits} visits, ${seeded.labOrders} lab orders\n`);

const today = TEST_DAY;
const sla = await getSlaConfig();
const budgets = budgetMap(sla);
const now = new Date();
const board = await getDayBoard(today, sla, now);
const stats = await getDayStats(today, board, sla);
const bottleneck = getBottleneck(board.columns);
const averages = await getStationAverages(today, sla);

const REQUIRED_SLA = [
  "checkin_to_vitals",
  "vitals",
  "wait_sd",
  "sd",
  "wait_doctor",
  "doctor",
  "pharmacy",
  "lab_total",
  "total_journey",
];
const missingSla = REQUIRED_SLA.filter((k) => !sla.some((r) => r.station === k));
check("sla config covers every station budget", missingSla.length === 0, missingSla.join(", "));
check(
  "board returns every seeded visit",
  board.cards.length === seeded.visits,
  `${board.cards.length}`,
);

const col = (k) => board.columns.find((c) => c.key === k);
check("checked-in column populated", col("checked_in").count >= 2, `${col("checked_in").count}`);
check("vitals column populated", col("vitals").count === 2, `${col("vitals").count}`);
check("SD column populated", col("sd").count === 2, `${col("sd").count}`);
check(
  "waiting-for-doctor column has 4",
  col("wait_doctor").count === 4,
  `${col("wait_doctor").count}`,
);
check("with-doctor column has 2", col("doctor").count === 2, `${col("doctor").count}`);
check("pharmacy column has 2", col("pharmacy").count === 2, `${col("pharmacy").count}`);
check("lab track has 3", col("lab").count === 3, `${col("lab").count}`);
check("done column has 8", col("done").count === 8, `${col("done").count}`);
check(
  "waiting-for-doctor is hot",
  col("wait_doctor").hot === true,
  `avg ${col("wait_doctor").avgMinutes}m vs ${col("wait_doctor").budgetMinutes}m`,
);

check(
  "bottleneck is wait_doctor",
  bottleneck?.station === "wait_doctor",
  bottleneck?.station || "none",
);
check(
  "bottleneck names the longest waiter",
  bottleneck?.longest?.minutes >= 40,
  `${bottleneck?.longest?.name} ${bottleneck?.longest?.minutes}m`,
);
check(
  "bottleneck suggests SD-closing greens",
  /green-category/.test(bottleneck?.suggestion || ""),
  bottleneck?.suggestion,
);

check("stats count the floor", stats.inBuilding === seeded.visits - 8, `${stats.inBuilding}`);
check(
  "a recovered patient is back in the chain",
  !!board.cards.find((c) => c.status === "with_vitals" && !c.blockedReason),
);
check("stats count completions", stats.completed === 8, `${stats.completed}`);
check("stats count blocked", stats.blocked === 2, `${stats.blocked}`);
check("stats count over-budget", stats.overBudget >= 1, `${stats.overBudget}`);
check(
  "avg completed journey is plausible",
  stats.avgCompletedMinutes > 55 && stats.avgCompletedMinutes < 85,
  `${stats.avgCompletedMinutes}m`,
);
check("station averages cover every budget", averages.length === sla.length);

// Each clickable stat tile filters the board with the same predicate the stat was
// counted by. If these drift, a tile says 14 and shows a different number of cards.
const allCards = board.columns.flatMap((c) => (c.key === "lab" ? [] : c.cards));
const uniqueCards = [...new Map(allCards.map((c) => [c.id, c])).values()];
check(
  "over-budget tile matches its filter",
  stats.overBudget === uniqueCards.filter((c) => !c.finished && c.statusColour === "red").length,
  `${stats.overBudget}`,
);
check(
  "blocked tile matches its filter",
  stats.blocked === uniqueCards.filter((c) => c.status === "blocked_reports").length,
  `${stats.blocked}`,
);
check(
  "in-building tile matches its filter",
  stats.inBuilding === uniqueCards.filter((c) => !c.finished).length,
  `${stats.inBuilding}`,
);
check(
  "completed tile matches its filter",
  stats.completed === uniqueCards.filter((c) => c.finished).length,
  `${stats.completed}`,
);

// Durations must reconstruct from the log alone, matching what was seeded.
const longest = col("wait_doctor").cards.sort((a, b) => b.statusMinutes - a.statusMinutes)[0];
const steps = await getStationTimes(pool, longest.id, budgets, now);
const current = steps.find((s) => s.isCurrent);
check("timeline reconstructs the full journey", steps.length >= 4, `${steps.length} steps`);
const firstEvent = await one(
  `SELECT min(occurred_at) AS at FROM giniflow_visit_events WHERE visit_id = $1`,
  [longest.id],
);
check(
  "timeline loses no time at the front",
  Math.abs(new Date(steps[0].enteredAt) - new Date(firstEvent.at)) < 1000,
);
check(
  "step durations sum to the whole journey",
  Math.abs(steps.reduce((sum, s) => sum + s.totalMinutes, 0) - longest.totalMinutes) <= 2,
  `${steps.reduce((sum, s) => sum + s.totalMinutes, 0)}m vs ${longest.totalMinutes}m`,
);
check("current step is the doctor wait", current?.status === "ready_for_doctor", current?.status);
check(
  "current wait matches the card",
  Math.abs(current.waitMinutes - longest.statusMinutes) <= 1,
  `${current.waitMinutes} vs ${longest.statusMinutes}`,
);
check(
  "over-budget step is red",
  current.colour === "red",
  `${current.totalMinutes}m of ${current.budgetMinutes}m`,
);
check(
  "a wait is paired with its station",
  steps.some((s) => s.waitMinutes > 0 && s.stationMinutes > 0),
);

// One event per transition, with the acting role recorded.
const events = await one(
  `SELECT count(*)::int AS total,
          count(*) FILTER (WHERE actor_role = 'system')::int AS unattributed,
          count(DISTINCT (visit_id, status))::int AS distinct_pairs
     FROM giniflow_visit_events e
     JOIN giniflow_visits v ON v.id = e.visit_id AND v.visit_date = $1::date`,
  [today],
);
check(
  "no duplicate status per visit",
  events.total === events.distinct_pairs,
  `${events.total} events`,
);
check(
  "every event has a real actor role",
  events.unattributed === 0,
  `${events.unattributed} unattributed`,
);

// Schema-level invariants.
const dup = await pool
  .query(
    `INSERT INTO giniflow_visits (patient_id, visit_date)
     SELECT patient_id, visit_date FROM giniflow_visits LIMIT 1`,
  )
  .then(() => false)
  .catch(() => true);
check("duplicate visit for a patient+day is rejected", dup);

const backwards = await pool.connect().then(async (c) => {
  try {
    await c.query("BEGIN");
    await advanceStatus(c, { visitId: longest.id, toStatus: "checked_in" });
    await c.query("ROLLBACK");
    return false;
  } catch {
    await c.query("ROLLBACK");
    return true;
  } finally {
    c.release();
  }
});
check("backwards transition is rejected", backwards);

// Editing a budget must recolour without touching any visit row.
await pool.query(
  `UPDATE giniflow_sla_config SET budget_minutes = 60 WHERE station = 'wait_doctor'`,
);
const relaxed = await getDayBoard(today, await getSlaConfig(), now);
check(
  "raising a budget cools the hot column",
  relaxed.columns.find((c) => c.key === "wait_doctor").hot === false,
);
await pool.query(
  `UPDATE giniflow_sla_config SET budget_minutes = 15 WHERE station = 'wait_doctor'`,
);

// A non-seeded visit on the same day must survive the clean (GF-01).
const realPatient = await one(
  `SELECT id FROM patients WHERE file_no NOT LIKE 'ZZDEMO_%' AND COALESCE(is_blocked,false)=false
    AND id NOT IN (SELECT patient_id FROM giniflow_visits) ORDER BY id LIMIT 1`,
);
const bystander = await one(
  `INSERT INTO giniflow_visits (patient_id, visit_date, current_status)
   VALUES ($1, $2::date, 'checked_in') RETURNING id`,
  [realPatient.id, TEST_DAY],
);

// GF-04: advanceStatus is what every station screen will call, but the seeder
// bulk-inserts, so nothing else exercises it forward. Walk one visit down the
// whole chain through the engine and assert the log it leaves behind.
const walker = await pool.connect();
try {
  await walker.query("BEGIN");
  const { rows: wp } = await walker.query(
    `INSERT INTO patients (name, file_no, age, sex) VALUES ('Demo Chain Walker', 'ZZDEMO_WALK', 50, 'Male')
     ON CONFLICT (file_no) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  const { rows: wv } = await walker.query(
    `INSERT INTO giniflow_visits (patient_id, visit_date, is_demo)
     VALUES ($1, $2::date, TRUE) RETURNING id`,
    [wp[0].id, TEST_DAY],
  );
  const walkId = wv[0].id;

  for (const status of CHAIN.slice(CHAIN.indexOf("confirmed"))) {
    await advanceStatus(walker, { visitId: walkId, toStatus: status, actorRole: "system" });
  }
  const walked = await walker.query(
    `SELECT count(*)::int AS n, max(status) FILTER (WHERE TRUE) IS NOT NULL AS ok
       FROM giniflow_visit_events WHERE visit_id = $1`,
    [walkId],
  );
  const final = await walker.query(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
    walkId,
  ]);
  check(
    "engine walks the whole chain forward",
    walked.rows[0].n === CHAIN.length - 1,
    `${walked.rows[0].n} events`,
  );
  check(
    "engine leaves the visit exited",
    final.rows[0].current_status === "exited",
    final.rows[0].current_status,
  );

  // Exception states and recovery.
  const { rows: bv } = await walker.query(
    `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, is_demo)
     VALUES ($1, $2::date - 1, 'checked_in', TRUE) RETURNING id`,
    [wp[0].id, TEST_DAY],
  );
  await advanceStatus(walker, {
    visitId: bv[0].id,
    toStatus: "blocked_reports",
    actorRole: "reception",
    blockedReason: "Blocked — reports not uploaded",
  });

  // A rejected statement aborts the surrounding transaction, so the negative case
  // runs inside its own savepoint.
  await walker.query("SAVEPOINT no_reason");
  const noReason = await advanceStatus(walker, {
    visitId: bv[0].id,
    toStatus: "blocked_reports",
    actorRole: "reception",
  })
    .then(() => false)
    .catch(() => true);
  await walker.query("ROLLBACK TO SAVEPOINT no_reason");
  check("blocking without a reason is rejected", noReason);

  await advanceStatus(walker, {
    visitId: bv[0].id,
    toStatus: "vitals_pending",
    actorRole: "reception",
  });
  const recovered = await walker.query(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
    bv[0].id,
  ]);
  check(
    "blocked recovers back into the chain",
    recovered.rows[0].current_status === "vitals_pending",
  );

  await advanceStatus(walker, { visitId: bv[0].id, toStatus: "cancelled", actorRole: "reception" });
  const cancelled = await walker.query(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
    bv[0].id,
  ]);
  check(
    "a visit can be cancelled from mid-chain",
    cancelled.rows[0].current_status === "cancelled",
  );

  await walker.query("ROLLBACK");
} catch (e) {
  await walker.query("ROLLBACK");
  check("engine walk-through ran", false, e.message);
} finally {
  walker.release();
}

// An empty day must render as an empty board, not as an error or a divide-by-zero.
const emptyDay = "2019-01-05";
const emptyBoard = await getDayBoard(emptyDay, sla, now);
const emptyStats = await getDayStats(emptyDay, emptyBoard, sla);
check(
  "an empty day yields empty columns",
  emptyBoard.columns.every((c) => c.count === 0),
);
check("an empty day has no bottleneck", getBottleneck(emptyBoard.columns) === null);
check(
  "an empty day reports no averages rather than zeroes",
  emptyStats.avgCompletedMinutes === null && emptyStats.withinSlaPct === null,
  `${emptyStats.avgCompletedMinutes} / ${emptyStats.withinSlaPct}`,
);
check("an empty day still names the journey target", emptyStats.journeyTargetMinutes === 90);

const cleaned = await cleanDemoDay();
const survived = await one(`SELECT count(*)::int c FROM giniflow_visits WHERE id = $1`, [
  bystander.id,
]);
check("clean spares a visit it did not seed", survived.c === 1);
await pool.query(`DELETE FROM giniflow_visits WHERE id = $1`, [bystander.id]);
check("clean removes every seeded visit", cleaned.deleted === seeded.visits, `${cleaned.deleted}`);
check(
  "clean removes its demo patients",
  cleaned.demoPatientsRemoved > 0,
  `${cleaned.demoPatientsRemoved}`,
);
const demoLeft = await one(`SELECT count(*)::int c FROM patients WHERE file_no LIKE 'ZZDEMO_%'`);
check("no demo patients left behind", demoLeft.c === 0, `${demoLeft.c}`);
const leftover = await one(
  `SELECT (SELECT count(*)::int FROM giniflow_visits WHERE visit_date = $1::date) AS visits,
          (SELECT count(*)::int FROM giniflow_lab_orders) AS orders`,
  [today],
);
check("no orphan lab orders", leftover.orders === 0, `${leftover.orders}`);

const after = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS visits,
          (SELECT count(*)::int FROM flow_events) AS events`,
);
check(
  "old flow_* module untouched",
  after.visits === before.visits && after.events === before.events,
  `flow_visits ${before.visits}→${after.visits}, flow_events ${before.events}→${after.events}`,
);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
