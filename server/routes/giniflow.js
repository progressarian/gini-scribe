import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import {
  giniflowDateQuerySchema,
  giniflowSearchQuerySchema,
  giniflowSlaUpdateSchema,
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
import { seedDemoDay, cleanDemoDay, demoAllowed } from "../services/giniflow/demo.js";

const router = Router();

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
