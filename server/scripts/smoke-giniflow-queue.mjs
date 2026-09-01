// Smoke test for board queue control: patient priority, manual queue order and
// drag-to-move. Seeds a demo day, exercises the three services against it, then
// cleans up.
//
// The pure rules — compareQueue and the drop-legality matrix — are asserted
// first and need no database: they are what the UI greys a column out on, so a
// change to them must fail here rather than on the floor.
//
//   npm run smoke:giniflow-queue   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import { getSlaConfig, getDayBoard } from "../services/giniflow/board.js";
import { setPriority, reorderColumn, moveToColumn } from "../services/giniflow/queue.js";
import {
  BOARD_COLUMNS,
  ORDERED_COLUMNS,
  COLUMN_ENTRY_STATUS,
  canDropInColumn,
  compareQueue,
  columnForStatus,
  nextColumn,
} from "../../shared/giniflowStatus.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const cards = (board, key) => board.columns.find((c) => c.key === key)?.cards ?? [];

// ── The pure rules ──────────────────────────────────────────────────────────
console.log("\nordering rule");

const order = (list) => [...list].sort(compareQueue).map((c) => c.id);

check(
  "a manual position wins over priority",
  order([
    { id: "urgent-unplaced", priority: "urgent", queuePosition: null, statusMinutes: 5 },
    { id: "placed", priority: "normal", queuePosition: 1, statusMinutes: 1 },
  ])[0] === "placed",
);
check(
  "priority wins over waiting time",
  order([
    { id: "waited-longest", priority: "normal", statusMinutes: 90 },
    { id: "urgent", priority: "urgent", statusMinutes: 2 },
  ])[0] === "urgent",
);
check(
  "urgent sorts above high",
  order([
    { id: "high", priority: "high", statusMinutes: 50 },
    { id: "urgent", priority: "urgent", statusMinutes: 1 },
  ])[0] === "urgent",
);
check(
  "longest waiting first when priority ties — the rule before any of this",
  order([
    { id: "short", priority: "normal", statusMinutes: 3 },
    { id: "long", priority: "normal", statusMinutes: 40 },
  ])[0] === "long",
);
check(
  "an unknown priority sorts as normal rather than first",
  order([
    { id: "junk", priority: "whatever", statusMinutes: 1 },
    { id: "high", priority: "high", statusMinutes: 1 },
  ])[0] === "high",
);

// ── The drop matrix ─────────────────────────────────────────────────────────
// BQ-02: the SD column holds three statuses and pharmacy two, so a card is
// usually NOT sitting at its column's entry status. Every status that a column
// can hold must still be draggable to the next column, or the common case is
// the one that silently greys out.
console.log("\ndrop legality");

for (const col of BOARD_COLUMNS) {
  if (!col.statuses || col.key === "done") continue;
  for (const status of col.statuses) {
    if (status === "blocked_reports") continue;
    const target = nextColumn(col.key);
    check(
      `${status} (in ${col.key}) can be dropped on ${target}`,
      canDropInColumn({ status, column: col.key }, target),
    );
  }
}

check(
  "a card cannot be dropped two columns away",
  !canDropInColumn({ status: "checked_in", column: "checked_in" }, "sd"),
);
check(
  "a card cannot be dropped backwards",
  !canDropInColumn({ status: "with_doctor", column: "doctor" }, "vitals"),
);
check(
  "a blocked patient cannot be dragged at all (BQ-05)",
  !ORDERED_COLUMNS.some((key) =>
    canDropInColumn({ status: "blocked_reports", column: "checked_in" }, key),
  ),
);
check(
  "the lab track is not a drop target",
  !canDropInColumn({ status: "with_vitals", column: "vitals" }, "lab") &&
    COLUMN_ENTRY_STATUS.lab === null,
);
check(
  "a drop on Done records dispensed, not exited (BQ-03)",
  COLUMN_ENTRY_STATUS.done === "dispensed",
);

// ── Against the database ────────────────────────────────────────────────────
const TEST_DAY = "2019-01-04";
await cleanDemoDay();
await seedDemoDay({ date: TEST_DAY });
const sla = await getSlaConfig();
const board = async () => getDayBoard(TEST_DAY, sla, new Date());

console.log("\npriority");

let day = await board();
const target = cards(day, "checked_in")[0] || cards(day, "vitals")[0];
check("demo day gives us a card to work with", !!target);

if (target) {
  await setPriority(target.id, "urgent", "chest pain", null);
  day = await board();
  const after = day.columns.flatMap((c) => c.cards).find((c) => c.id === target.id);
  check("priority is stored", after?.priority === "urgent", after?.priority);
  check("the reason is stored", after?.priorityReason === "chest pain", after?.priorityReason);
  check(
    "an urgent patient sorts to the top of their column",
    cards(day, after.column ?? columnForStatus(after.status))[0]?.id === target.id ||
      day.columns.find((c) => c.cards.some((x) => x.id === target.id))?.cards[0]?.id === target.id,
  );

  await setPriority(target.id, "normal", null, null);
  day = await board();
  const back = day.columns.flatMap((c) => c.cards).find((c) => c.id === target.id);
  check("returning to normal drops the reason", back?.priorityReason === null);
}

console.log("\nmanual order");

day = await board();
const orderable = day.columns.find(
  (c) => c.key !== "lab" && c.key !== "done" && c.cards.length >= 2,
);
check("a column with two or more patients to reorder", !!orderable, orderable?.key);

if (orderable) {
  const ids = orderable.cards.map((c) => c.id);
  const reversed = [...ids].reverse();
  const result = await reorderColumn(orderable.key, reversed, TEST_DAY);
  check("every id was placed", result.ordered === reversed.length, `${result.ordered}`);
  check("nothing reported as ignored", result.ignored.length === 0);

  day = await board();
  check(
    "the column comes back in the order it was given",
    cards(day, orderable.key)
      .map((c) => c.id)
      .join() === reversed.join(),
  );

  // BQ-08: a stale id is skipped, and the caller is told which.
  const stale = await reorderColumn(
    orderable.key,
    [...reversed, "00000000-0000-0000-0000-000000000000"],
    TEST_DAY,
  );
  check("a stale id is reported back, not swallowed", stale.ignored.length === 1);

  // BQ-09: Done has no queue to arrange, so it is refused rather than accepted
  // and discarded.
  let refused = false;
  try {
    await reorderColumn("done", ids, TEST_DAY);
  } catch {
    refused = true;
  }
  check("reordering Done is refused", refused);
}

console.log("\nmoving between columns");

day = await board();
const movable = day.columns
  .filter((c) => c.key !== "lab" && c.key !== "done")
  .flatMap((c) => c.cards.map((card) => ({ card, column: c.key })))
  .find(
    ({ card, column }) =>
      !card.blockedReason && canDropInColumn({ ...card, column }, nextColumn(column)),
  );
check("a card that can be moved one column right", !!movable, movable?.card?.name);

if (movable) {
  const to = nextColumn(movable.column);
  const before = cards(await board(), movable.column).find((c) => c.id === movable.card.id);
  check("the card has a manual position to lose", before !== undefined);

  await reorderColumn(movable.column, [movable.card.id], TEST_DAY);
  await moveToColumn(movable.card.id, to, null);
  day = await board();

  const moved = cards(day, to).find((c) => c.id === movable.card.id);
  check(`the card is now in ${to}`, !!moved, moved?.status);
  check(
    "the manual position did not travel with it (BQ-06)",
    moved?.queuePosition === null || moved?.queuePosition === undefined,
    String(moved?.queuePosition),
  );

  const { rows } = await pool.query(
    `SELECT actor_role, meta FROM giniflow_visit_events
      WHERE visit_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [movable.card.id],
  );
  check("the move is attributed to the coordinator", rows[0]?.actor_role === "coordinator");
  check("the move records that it came from the board", rows[0]?.meta?.source === "board_drag");

  let jumped = false;
  // Report what actually happened: any other error, or no error at all, would
  // otherwise be indistinguishable from the guard simply not firing.
  let why = "";
  const twoAway = nextColumn(nextColumn(to));
  const statusNow = await pool.query(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
    movable.card.id,
  ]);
  try {
    if (twoAway) await moveToColumn(movable.card.id, twoAway, null);
    else why = "no column two away — nothing was tested";
  } catch (e) {
    why = e.message;
    jumped = /Move one station at a time/.test(e.message);
  }
  check(
    "skipping a column is refused (BQ-02)",
    jumped,
    `${statusNow.rows[0]?.current_status} in ${columnForStatus(statusNow.rows[0]?.current_status)} → ${twoAway}: ${why || "the move was allowed"}`,
  );
}

await cleanDemoDay();
const leftover = (
  await pool.query(`SELECT count(*)::int AS n FROM giniflow_visits WHERE visit_date = $1::date`, [
    TEST_DAY,
  ])
).rows[0].n;
check("demo day cleaned up", leftover === 0, `${leftover} left`);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
