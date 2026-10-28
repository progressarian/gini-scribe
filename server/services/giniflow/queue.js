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
import { rxBlock } from "./pharmacyStation.js";

export const ORDERABLE_COLUMNS = ORDERED_COLUMNS.filter((key) => key !== "done");

const columnStatuses = (key) => BOARD_COLUMNS.find((c) => c.key === key)?.statuses ?? null;

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

    if (isExceptionStatus(fromStatus)) {
      throw new Error(
        `Cannot move a ${STATUS_LABEL[fromStatus] || fromStatus} patient — clear it at the station first`,
      );
    }

    const fromColumn = columnForStatus(fromStatus);
    if (nextColumn(fromColumn) !== columnKey) {
      throw new Error("Move one station at a time");
    }
    const blocked = rxBlock(fromStatus);
    if (blocked) throw new Error(blocked);

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
