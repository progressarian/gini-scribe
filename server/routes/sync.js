import { Router } from "express";
import { handleError } from "../utils/errorHandler.js";
import {
  syncWalkingAppointments,
  syncTodayWalkingAppointments,
  syncWalkingAppointmentsByDate,
} from "../services/cron/index.js";

const router = Router();

// Manual trigger: full sync
router.post("/sync/healthray/full", async (req, res) => {
  try {
    const result = await syncWalkingAppointments();
    res.json({ success: true, ...result });
  } catch (e) {
    handleError(res, e, "HealthRay full sync");
  }
});

// Manual trigger: today only
router.post("/sync/healthray/today", async (req, res) => {
  try {
    const result = await syncTodayWalkingAppointments();
    res.json({ success: true, ...result });
  } catch (e) {
    handleError(res, e, "HealthRay today sync");
  }
});

// Manual trigger: specific date (e.g. POST /api/sync/healthray/date?date=2026-03-26)
router.post("/sync/healthray/date", async (req, res) => {
  try {
    const date = req.query.date || req.body.date;
    if (!date) return res.status(400).json({ error: "date query param required (YYYY-MM-DD)" });
    const result = await syncWalkingAppointmentsByDate(date);
    res.json({ success: true, ...result });
  } catch (e) {
    handleError(res, e, "HealthRay date sync");
  }
});

export default router;
