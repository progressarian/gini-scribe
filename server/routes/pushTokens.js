import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// Patient app upserts its FCM token here. Idempotent on (patient_id, fcm_token).
router.post("/push-tokens", async (req, res) => {
  try {
    const { patient_id, fcm_token, platform } = req.body || {};
    const pid = parseInt(patient_id, 10);
    if (!Number.isFinite(pid)) return res.status(400).json({ error: "patient_id required" });
    if (!fcm_token || typeof fcm_token !== "string") {
      return res.status(400).json({ error: "fcm_token required" });
    }
    await pool.query(
      `INSERT INTO patient_push_tokens (patient_id, fcm_token, platform)
            VALUES ($1, $2, $3)
       ON CONFLICT (patient_id, fcm_token)
            DO UPDATE SET last_seen_at = now(),
                          platform = COALESCE(EXCLUDED.platform, patient_push_tokens.platform)`,
      [pid, fcm_token, platform || null],
    );
    res.json({ success: true });
  } catch (e) {
    handleError(res, e, "Upsert push token");
  }
});

router.delete("/push-tokens", async (req, res) => {
  try {
    const { fcm_token } = req.body || {};
    if (!fcm_token) return res.status(400).json({ error: "fcm_token required" });
    await pool.query(`DELETE FROM patient_push_tokens WHERE fcm_token = $1`, [fcm_token]);
    res.json({ success: true });
  } catch (e) {
    handleError(res, e, "Delete push token");
  }
});

export default router;
