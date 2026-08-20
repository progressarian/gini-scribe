import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { dayWindowWhere, callStatusToday } from "../services/ghmDayWindow.js";

const router = Router();

const OPEN_CALL_SQL = `'{pending,not_picked,call_later,busy,switched_off}'::text[]`;

// Scoped to today, matching the GHM sheet: the tiles report the calling done
// today for this date's patients, and reset with each new round.
const CALL_STAT = callStatusToday("a");
const OPEN_CALL = `${CALL_STAT} = ANY(${OPEN_CALL_SQL})`;

const VISIT_TYPE = `COALESCE(NULLIF(TRIM(a.visit_type), ''), 'Not set')`;

const isoDate = (d) => d.toISOString().split("T")[0];

router.get("/obt-dashboard", async (req, res) => {
  try {
    const date = req.query.date || isoDate(new Date());
    // Same window as the GHM sheet's day tabs, so every tile counts exactly the
    // rows the OBT team sees when they open that date.
    const where = dayWindowWhere("a");

    const r = await pool.query(
      `SELECT COUNT(*)::int                                                    AS total,
              COUNT(*) FILTER (WHERE ${OPEN_CALL})::int                        AS need_call,
              COUNT(*) FILTER (WHERE ${CALL_STAT} = 'pending')::int            AS not_called,
              COUNT(*) FILTER (WHERE ${CALL_STAT} = 'called')::int             AS spoke,
              COUNT(*) FILTER (WHERE ${CALL_STAT} = 'not_picked')::int         AS not_picked,
              COUNT(*) FILTER (WHERE ${CALL_STAT} = 'rescheduled')::int        AS rescheduled,
              COUNT(*) FILTER (WHERE ${CALL_STAT} = 'call_later')::int         AS call_later,
              COUNT(*) FILTER (
                WHERE ${CALL_STAT} = ANY('{busy,switched_off}'::text[])
              )::int                                                           AS unreachable,
              COUNT(*) FILTER (WHERE ${CALL_STAT} = 'no_call_needed')::int     AS no_call_needed,
              COUNT(*) FILTER (WHERE a.home_collection)::int                   AS home_collection
       FROM appointments a ${where}`,
      [date],
    );

    const v = await pool.query(
      `SELECT ${VISIT_TYPE} AS type, COUNT(*)::int AS count
         FROM appointments a ${where}
        GROUP BY 1
        ORDER BY 2 DESC, 1`,
      [date],
    );

    res.json({ date, summary: r.rows[0] || {}, visitTypes: v.rows });
  } catch (e) {
    handleError(res, e, "OBT dashboard");
  }
});

export default router;
