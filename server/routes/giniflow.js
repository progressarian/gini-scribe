import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import {
  giniflowDateQuerySchema,
  giniflowSearchQuerySchema,
  giniflowSlaUpdateSchema,
  giniflowPrioritySchema,
  giniflowReorderSchema,
  giniflowMoveSchema,
} from "../schemas/index.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import { getStationTimes } from "../services/giniflow/statusEngine.js";
import {
  getSlaConfig,
  budgetMap,
  getDayBoard,
  getBottleneck,
  getDayStats,
  getStationAverages,
  searchDayVisits,
} from "../services/giniflow/board.js";
import { setPriority, reorderColumn, moveToColumn } from "../services/giniflow/queue.js";
import { seedDemoDay, cleanDemoDay, demoAllowed } from "../services/giniflow/demo.js";
import { addClient, removeClient, hubStatus } from "../services/giniflow/eventHub.js";

const router = Router();

// Live updates for the board and the stations (docs/gini-flow/12-REALTIME-PLAN.md).
//
// Server-Sent Events rather than a socket to Supabase Realtime: this way the
// connection is authenticated by our own middleware — `EventSource` cannot set
// headers, which is exactly what the `?token=` form in middleware/auth.js is
// for — and no anon key reaches the browser. The frames carry a signal, never a
// patient row; the screen refetches through the API it is already signed in to.
router.get("/giniflow/events", requireCapability(CAP.GINIFLOW_VIEW), async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : null;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      // `no-transform` is what stops the compression middleware buffering the
      // stream; `X-Accel-Buffering` is the same instruction to nginx. Without
      // them nothing arrives until the connection closes.
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });

    const client = addClient(res, {
      date,
      lastEventId: req.headers["last-event-id"] || req.query.lastEventId || null,
    });
    if (!client) {
      res.write(`event: full\ndata: {"reason":"too many open screens"}\n\n`);
      return res.end();
    }
    req.on("close", () => removeClient(client));
  } catch (e) {
    handleError(res, e, "Gini Flow live events");
  }
});

router.get("/giniflow/events/status", requireCapability(CAP.GINIFLOW_VIEW), (req, res) => {
  res.json(hubStatus());
});

// "Today" is the IST day. The server runs UTC, so CURRENT_DATE would show
// yesterday's board to anyone on the floor before 05:30 IST.
const istToday = async () =>
  (await pool.query(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).rows[0].d;

const resolveDate = async (raw) => (/^\d{4}-\d{2}-\d{2}$/.test(raw || "") ? raw : await istToday());

// Everything the board needs in one request. serverTime lets the client tick its
// timers against the server rather than a wall display's drifting clock.
router.get("/giniflow/board", validateQuery(giniflowDateQuerySchema), async (req, res) => {
  try {
    const date = await resolveDate(req.query.date);
    const now = new Date();
    const sla = await getSlaConfig();
    const board = await getDayBoard(date, sla, now);
    const [stats, stationAverages] = await Promise.all([
      getDayStats(date, board, sla),
      getStationAverages(date, sla),
    ]);

    res.json({
      date,
      serverTime: now.toISOString(),
      columns: board.columns,
      stats,
      bottleneck: getBottleneck(board.columns),
      stationAverages,
      slaConfig: sla,
    });
  } catch (e) {
    handleError(res, e, "Gini Flow board");
  }
});

router.get("/giniflow/visits/:id/timeline", async (req, res) => {
  try {
    const visit = await pool.query(
      `SELECT v.id, v.current_status, v.category, v.blocked_reason, v.visit_date::text AS visit_date,
              p.name, p.age, p.sex, p.file_no,
              (SELECT COUNT(*)::int FROM giniflow_visits pv
                WHERE pv.patient_id = v.patient_id AND pv.visit_date <= v.visit_date) AS visit_number
         FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
        WHERE v.id = $1`,
      [req.params.id],
    );
    if (!visit.rows.length) return res.status(404).json({ error: "Visit not found" });

    const sla = await getSlaConfig();
    const steps = await getStationTimes(pool, req.params.id, budgetMap(sla));
    res.json({ visit: visit.rows[0], steps, serverTime: new Date().toISOString() });
  } catch (e) {
    handleError(res, e, "Gini Flow timeline");
  }
});

// Search is server-side: the floor can hold 100+ patients and the answer must
// not depend on which cards happen to be rendered.
router.get("/giniflow/search", validateQuery(giniflowSearchQuerySchema), async (req, res) => {
  try {
    const date = await resolveDate(req.query.date);
    res.json({ date, query: req.query.q, results: await searchDayVisits(date, req.query.q) });
  } catch (e) {
    handleError(res, e, "Gini Flow search");
  }
});

router.get("/giniflow/sla-config", async (req, res) => {
  try {
    res.json({ slaConfig: await getSlaConfig() });
  } catch (e) {
    handleError(res, e, "Gini Flow SLA config");
  }
});

router.patch(
  "/giniflow/sla-config",
  requireCapability(CAP.GINIFLOW_SLA_ADMIN),
  validate(giniflowSlaUpdateSchema),
  async (req, res) => {
    const { budgets } = req.body;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const b of budgets) {
        await client.query(
          `UPDATE giniflow_sla_config
              SET budget_minutes = $2, updated_at = NOW(), updated_by = $3
            WHERE station = $1`,
          [b.station, b.budgetMinutes, req.doctor?.short_name || req.doctor?.doctor_name || null],
        );
      }
      await client.query("COMMIT");
      res.json({ slaConfig: await getSlaConfig() });
    } catch (e) {
      await client.query("ROLLBACK");
      handleError(res, e, "Gini Flow SLA update");
    } finally {
      client.release();
    }
  },
);

router.get("/giniflow/day-report", validateQuery(giniflowDateQuerySchema), async (req, res) => {
  try {
    const date = await resolveDate(req.query.date);
    const sla = await getSlaConfig();
    const board = await getDayBoard(date, sla, new Date());
    const stats = await getDayStats(date, board, sla);
    const bottleneck = getBottleneck(board.columns);

    const parts = [
      stats.avgCompletedMinutes
        ? `avg journey ${stats.avgCompletedMinutes}m`
        : "no completed visits yet",
      `${stats.completed} completed`,
      `${stats.overBudget} over SLA`,
      bottleneck ? `bottleneck: ${bottleneck.label}` : "no bottleneck",
    ];
    res.json({ date, summary: parts.join(" · "), stats, bottleneck });
  } catch (e) {
    handleError(res, e, "Gini Flow day report");
  }
});

// ── Queue management ────────────────────────────────────────────────────────
// Three ways the floor manager rearranges the board, all behind one capability.
// An illegal move is the manager's mistake, not a server fault, so it answers
// 409 with the reason the chain gave rather than a 500.

const queueError = (res, e, label) => {
  if (
    /^(Illegal transition|Unknown |No such visit|Column |Move one station|Cannot move)/.test(
      e.message || "",
    )
  ) {
    return res.status(409).json({ error: e.message });
  }
  return handleError(res, e, label);
};

router.patch(
  "/giniflow/visits/:id/priority",
  requireCapability(CAP.GINIFLOW_MANAGE_QUEUE),
  validate(giniflowPrioritySchema),
  async (req, res) => {
    try {
      res.json(
        await setPriority(
          req.params.id,
          req.body.priority,
          req.body.reason,
          req.doctor?.doctor_id ?? null,
        ),
      );
    } catch (e) {
      queueError(res, e, "Gini Flow set priority");
    }
  },
);

// Dropping a card on another column. The same transition a station screen makes,
// logged against the manager who made it.
router.post(
  "/giniflow/visits/:id/move",
  requireCapability(CAP.GINIFLOW_MANAGE_QUEUE),
  validate(giniflowMoveSchema),
  async (req, res) => {
    try {
      res.json(await moveToColumn(req.params.id, req.body.column, req.doctor?.doctor_id ?? null));
    } catch (e) {
      queueError(res, e, "Gini Flow move visit");
    }
  },
);

// Dragging a card within its column. The body carries the column's whole order,
// not one card's new index, so the result does not depend on the board the
// client happened to be looking at.
router.patch(
  "/giniflow/columns/:key/order",
  requireCapability(CAP.GINIFLOW_MANAGE_QUEUE),
  validate(giniflowReorderSchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.body.date);
      res.json(await reorderColumn(req.params.key, req.body.visitIds, date));
    } catch (e) {
      queueError(res, e, "Gini Flow reorder column");
    }
  },
);

// A destructive endpoint on the live host needs more than a role check: an admin
// misclick would otherwise write fabricated visits into production.
const requireDemoEnabled = (req, res, next) =>
  demoAllowed()
    ? next()
    : res.status(403).json({ error: "Demo endpoints are disabled. Set GINIFLOW_ALLOW_DEMO=1." });

router.post(
  "/giniflow/demo/seed",
  requireCapability(CAP.ADMIN),
  requireDemoEnabled,
  async (req, res) => {
    try {
      res.json(await seedDemoDay());
    } catch (e) {
      handleError(res, e, "Gini Flow demo seed");
    }
  },
);

router.post(
  "/giniflow/demo/clean",
  requireCapability(CAP.ADMIN),
  requireDemoEnabled,
  async (req, res) => {
    try {
      res.json(await cleanDemoDay());
    } catch (e) {
      handleError(res, e, "Gini Flow demo clean");
    }
  },
);

export default router;
