import pool from "../../config/db.js";
import {
  PRIORITIES,
  COLUMN_ENTRY_STATUS,
  ORDERED_COLUMNS,
  BOARD_COLUMNS,
  STATUS_LABEL,
  columnForStatus,
  nextColumn,
  isExceptionStatus,
} from "../../../shared/giniflowStatus.js";
import { advanceStatus } from "./statusEngine.js";

// Columns the manager can rearrange by hand. The lab track is ordered by its own
// clock rather than by the chain, and "Done today" is a record of what already
// happened — neither has a queue to arrange, so accepting a reorder for them and
// then discarding it would report a success that never took (BQ-09).
export const ORDERABLE_COLUMNS = ORDERED_COLUMNS.filter((key) => key !== "done");

const columnStatuses = (key) => BOARD_COLUMNS.find((c) => c.key === key)?.statuses ?? null;

// Attributed on the visit row rather than appended to giniflow_visit_events:
// every duration in Gini Flow is the gap between consecutive event rows, so an
// event that is not a journey step would restart the patient's station timer.
//
// Setting a priority clears the manual position (BQ-01). The manager has just
// said something stronger about where this patient belongs, and keeping the old
// position would pin an urgent patient below the person they were meant to
// overtake — which is what the board would show, since a positioned card sorts
// above every unpositioned one.
export async function setPriority(visitId, priority, reason, actorId, db = pool) {
  if (!PRIORITIES.includes(priority)) throw new Error(`Unknown priority: ${priority}`);
  const { rows } = await db.query(
    `UPDATE giniflow_visits
        SET priority        = $2,
            priority_reason = $3,
            priority_set_by = $4,
            priority_set_at = NOW(),
            queue_position  = NULL,
            queue_column    = NULL,
            updated_at      = NOW()
      WHERE id = $1
      RETURNING id, priority, priority_reason, current_status`,
    [visitId, priority, priority === "normal" ? null : reason || null, actorId],
  );
  if (!rows.length) throw new Error(`No such visit: ${visitId}`);
  return rows[0];
}

// Rewrites one column's manual order in a single statement. The caller sends the
// column's full list of visit ids top to bottom; positions are 1..n. Ids that
// are not currently in that column are ignored rather than rejected — the board
// polls every 10s, so a card can legitimately have moved on between the render
// the manager dragged and the request arriving, and failing the whole reorder
// over one stale id would lose the intent for everyone else in the column.
//
// The ignored ids are returned rather than swallowed (BQ-08): a partial reorder
// that reports plain success tells the manager the board did what they asked
// when it did not.
export async function reorderColumn(columnKey, visitIds, visitDate, db = pool) {
  const statuses = columnStatuses(columnKey);
  if (!statuses || !ORDERABLE_COLUMNS.includes(columnKey)) {
    throw new Error(`Column cannot be ordered: ${columnKey}`);
  }
  const { rows } = await db.query(
    `UPDATE giniflow_visits v
        SET queue_position = ord.pos, queue_column = $4, updated_at = NOW()
       FROM (SELECT t.id, t.n::int AS pos
               FROM UNNEST($1::uuid[]) WITH ORDINALITY AS t(id, n)) ord
      WHERE v.id = ord.id
        AND v.visit_date = $2::date
        AND v.current_status = ANY($3::text[])
      RETURNING v.id`,
    [visitIds, visitDate, statuses, columnKey],
  );
  const placed = new Set(rows.map((r) => r.id));
  return { ordered: rows.length, ignored: visitIds.filter((id) => !placed.has(id)) };
}

// The floor manager moving a card from one column to the next. It is the same
// transition a station screen makes — same log, same legality rules, same
// timers — recorded against `coordinator` so the timeline shows who moved it.
//
// Adjacency is checked HERE and not only in the client (BQ-02): the drag may
// cross exactly one column, which bounds the skip to one station regardless of
// how many statuses that column contains, and regardless of what a caller
// hitting the API directly asks for.
export async function moveToColumn(visitId, columnKey, actorId, db = pool) {
  const toStatus = COLUMN_ENTRY_STATUS[columnKey];
  if (!toStatus) throw new Error(`Column is not a drop target: ${columnKey}`);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT current_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw new Error(`No such visit: ${visitId}`);
    const fromStatus = rows[0].current_status;

    // A block is a documented decision carrying a reason, and advanceStatus
    // clears blocked_reason on any move out of it. Allowing a drag here would
    // let an undocumented gesture undo a documented decision, with no record of
    // who cleared it or why (BQ-05). Blocks are cleared where they were set.
    if (isExceptionStatus(fromStatus)) {
      throw new Error(
        `Cannot move a ${STATUS_LABEL[fromStatus] || fromStatus} patient — clear it at the station first`,
      );
    }

    const fromColumn = columnForStatus(fromStatus);
    if (nextColumn(fromColumn) !== columnKey) {
      throw new Error("Move one station at a time");
    }

    const event = await advanceStatus(client, {
      visitId,
      toStatus,
      actorRole: "coordinator",
      actorId,
      meta: { source: "board_drag", column: columnKey, from_column: fromColumn },
      // Bounded above: one column, verified against the board's own layout.
      allowSkip: true,
    });
    await client.query("COMMIT");
    return event;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
