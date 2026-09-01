import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { blockedResponse, blockActor } from "../services/patientBlockGuard.js";
import { createWalkinBooking } from "../services/walkinBooking.js";

const router = Router();

// GET /api/walkins?date=2026-06-02
router.get("/walkins", async (req, res) => {
  try {
    const { date } = req.query;
    const d = date || new Date().toISOString().split("T")[0];
    const r = await pool.query(
      "SELECT * FROM walkin_bookings WHERE walkin_date=$1 ORDER BY time_slot ASC, created_at ASC",
      [d],
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Walk-ins list");
  }
});

// POST /api/walkins
router.post("/walkins", async (req, res) => {
  try {
    const { blocked, booking } = await createWalkinBooking(req.body, {
      force: req.body.force,
      role: req.doctor?.role,
      actor: blockActor(req),
    });
    if (blocked) return res.status(409).json(blockedResponse(blocked));
    res.status(201).json(booking);
  } catch (e) {
    handleError(res, e, "Walk-in create");
  }
});

// DELETE /api/walkins/:id
router.delete("/walkins/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM walkin_bookings WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "Walk-in delete");
  }
});

export default router;
