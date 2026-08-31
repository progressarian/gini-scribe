import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  giniflowDateQuerySchema,
  giniflowPaymentSchema,
  giniflowVitalsSchema,
} from "../schemas/index.js";
import {
  getVitalsQueue,
  getVitalsPatient,
  saveVitals,
  startVitals,
} from "../services/giniflow/vitalsStation.js";
import {
  getPaymentQueue,
  clearPayment,
  getTestCatalog,
} from "../services/giniflow/receptionStation.js";
import { getStationSummary } from "../services/giniflow/stationSummary.js";
import { hasCapability } from "../../shared/permissions.js";

const router = Router();

const istToday = async () =>
  (await pool.query(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).rows[0].d;

const resolveDate = async (raw) => raw || (await istToday());

const vitalsGate = requireCapability(CAP.GINIFLOW_STATION_VITALS);

router.get(
  "/giniflow/stations/vitals/queue",
  vitalsGate,
  validateQuery(giniflowDateQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const data = await getVitalsQueue(date);
      res.json({ date, ...data, serverTime: new Date().toISOString() });
    } catch (e) {
      handleError(res, e, "Gini Flow vitals queue");
    }
  },
);

router.get("/giniflow/stations/vitals/:visitId", vitalsGate, async (req, res) => {
  try {
    const patient = await getVitalsPatient(req.params.visitId);
    if (!patient) return res.status(404).json({ error: "Visit not found" });
    res.json(patient);
  } catch (e) {
    handleError(res, e, "Gini Flow vitals patient");
  }
});

router.post("/giniflow/stations/vitals/:visitId/start", vitalsGate, async (req, res) => {
  try {
    res.json(await startVitals(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    handleError(res, e, "Gini Flow vitals start");
  }
});

router.post(
  "/giniflow/stations/vitals/:visitId",
  vitalsGate,
  validate(giniflowVitalsSchema),
  async (req, res) => {
    try {
      const saved = await saveVitals(req.params.visitId, {
        ...req.body,
        actorId: req.doctor?.doctor_id ?? null,
      });
      res.json(saved);
    } catch (e) {
      handleError(res, e, "Gini Flow vitals save");
    }
  },
);

// ── Launcher ────────────────────────────────────────────────────────────────
// Every station's count in one call, filtered to the stations this role may
// open. A tile that appears and then 403s is worse than no tile.
const STATION_CAPS = {
  manager: CAP.GINIFLOW_VIEW,
  vitals: CAP.GINIFLOW_STATION_VITALS,
  reception: CAP.GINIFLOW_STATION_RECEPTION,
};

router.get(
  "/giniflow/stations/summary",
  validateQuery(giniflowDateQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const summary = await getStationSummary(date);
      const role = req.doctor?.role;
      const allowed = Object.fromEntries(
        Object.entries(STATION_CAPS).filter(([, cap]) => hasCapability(role, cap)),
      );
      res.json({
        date,
        stations: Object.fromEntries(Object.keys(allowed).map((k) => [k, summary[k]])),
        bottleneck: summary.bottleneck,
        serverTime: new Date().toISOString(),
      });
    } catch (e) {
      handleError(res, e, "Gini Flow station summary");
    }
  },
);

// ── Reception ───────────────────────────────────────────────────────────────
const receptionGate = requireCapability(CAP.GINIFLOW_STATION_RECEPTION);

router.get(
  "/giniflow/stations/reception/queue",
  receptionGate,
  validateQuery(giniflowDateQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const data = await getPaymentQueue(date);
      res.json({ date, ...data, serverTime: new Date().toISOString() });
    } catch (e) {
      handleError(res, e, "Gini Flow reception queue");
    }
  },
);

router.get("/giniflow/stations/reception/catalog", receptionGate, async (req, res) => {
  try {
    res.json({ tests: await getTestCatalog() });
  } catch (e) {
    handleError(res, e, "Gini Flow test catalog");
  }
});

router.post(
  "/giniflow/stations/reception/:orderId/clear",
  receptionGate,
  validate(giniflowPaymentSchema),
  async (req, res) => {
    try {
      res.json(
        await clearPayment(req.params.orderId, {
          method: req.body.method,
          actorId: req.doctor?.doctor_id ?? null,
        }),
      );
    } catch (e) {
      handleError(res, e, "Gini Flow clear payment");
    }
  },
);

export default router;
