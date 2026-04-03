import { Router } from "express";
import { handleError } from "../utils/errorHandler.js";
import {
  syncWalkingAppointments,
  syncTodayWalkingAppointments,
  syncWalkingAppointmentsByDate,
} from "../services/cron/index.js";
import { readSheetTab, readUpcomingAppointments } from "../services/sheets/reader.js";
import { syncFromSheets } from "../services/cron/sheetsSync.js";
import pool from "../config/db.js";
import { parseClinicalWithAI } from "../services/healthray/parser.js";

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

// ── Google Sheets: import upcoming OPD appointments into DB ─────────────────

// Manual trigger: import all 3 upcoming tabs into appointments table
router.post("/sync/sheets/import", async (req, res) => {
  try {
    const result = await syncFromSheets();
    res.json({ success: true, ...result });
  } catch (e) {
    handleError(res, e, "Sheets OPD import");
  }
});

// Read all 3 upcoming tabs (Tomorrow, Day After, Day After + 1)
router.get("/sync/sheets/upcoming", async (req, res) => {
  try {
    const data = await readUpcomingAppointments();
    res.json({ success: true, tabs: data });
  } catch (e) {
    handleError(res, e, "Sheets upcoming read");
  }
});

// Read a single tab by name (e.g. GET /api/sync/sheets/tab?name=Tomorrow)
router.get("/sync/sheets/tab", async (req, res) => {
  try {
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: "name query param required" });
    const data = await readSheetTab(name);
    res.json({ success: true, tab: name, ...data });
  } catch (e) {
    handleError(res, e, "Sheets tab read");
  }
});

// Backfill: re-parse clinical notes for a single appointment
// POST /api/sync/backfill/investigations/:appointmentId
router.post("/sync/backfill/investigations/:appointmentId", async (req, res) => {
  const apptId = Number(req.params.appointmentId);
  if (!apptId) return res.status(400).json({ error: "Valid appointmentId required" });

  try {
    const { rows } = await pool.query(
      `SELECT id, healthray_clinical_notes FROM appointments WHERE id = $1`,
      [apptId],
    );

    if (!rows[0]) return res.status(404).json({ error: "Appointment not found" });

    let notes = rows[0].healthray_clinical_notes;

    // If notes provided in body, save them first
    if (req.body?.notes) {
      notes = req.body.notes;
      await pool.query(
        `UPDATE appointments SET healthray_clinical_notes = $1, updated_at = NOW() WHERE id = $2`,
        [notes, apptId],
      );
    }

    if (!notes) {
      return res.status(400).json({
        error:
          "Appointment has no clinical notes to parse. Pass { notes: '...' } in the request body.",
      });
    }

    const parsed = await parseClinicalWithAI(notes);
    if (!parsed) return res.status(422).json({ error: "AI parsing failed or returned no data" });

    const investigations = (parsed.investigations_to_order || []).map((t) =>
      typeof t === "string" ? { name: t, urgency: "routine" } : t,
    );
    const followUp = parsed.follow_up || null;

    await pool.query(
      `UPDATE appointments
       SET healthray_investigations = $1::jsonb,
           healthray_follow_up = $2::jsonb,
           updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(investigations), followUp ? JSON.stringify(followUp) : null, apptId],
    );

    res.json({ success: true, appointmentId: apptId, investigations, followUp });
  } catch (e) {
    handleError(res, e, "Backfill investigations");
  }
});

export default router;
