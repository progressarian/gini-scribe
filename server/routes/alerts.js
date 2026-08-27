import { Router } from "express";
import { createRequire } from "module";
import { handleError } from "../utils/errorHandler.js";
import { doctorScope, myPatientIds } from "../services/patientScope.js";
import { blockWriteGuard } from "../middleware/blockWriteGuard.js";

const require = createRequire(import.meta.url);
let sendAlertToGenie = null;
let getAlertsFromGenie = null;
try {
  const genie = require("../genie-sync.cjs");
  sendAlertToGenie = genie.sendAlertToGenie;
  getAlertsFromGenie = genie.getAlertsFromGenie;
} catch {
  console.log("genie-sync.cjs not loaded — alert sync disabled");
}

const router = Router();

// No write against a blocked patient succeeds (admin `force` excepted).
// See docs/PATIENT_BLOCKLIST_PLAN.md §3.9
router.param("id", blockWriteGuard);

// Get all alerts from mobile app (for Home page)
router.get("/alerts/from-genie", async (req, res) => {
  try {
    if (!getAlertsFromGenie) return res.json([]);
    const { patient_id } = req.query;
    const alerts = (await getAlertsFromGenie(patient_id || null)) || [];
    const scope = doctorScope(req);
    if (!scope.mine) return res.json(alerts);
    const mine = await myPatientIds(
      scope,
      alerts.map((a) => a.patient_id),
    );
    res.json(mine ? alerts.filter((a) => mine.has(Number(a.patient_id))) : alerts);
  } catch (e) {
    handleError(res, e, "Get Genie alerts");
  }
});

// Get alerts for a specific patient from mobile app
router.get("/patients/:id/alerts", async (req, res) => {
  try {
    if (!getAlertsFromGenie) return res.json([]);
    const alerts = await getAlertsFromGenie(req.params.id);
    res.json(alerts || []);
  } catch (e) {
    handleError(res, e, "Get patient alerts");
  }
});

// Send alert from doctor to patient's mobile app
router.post("/patients/:id/alerts", async (req, res) => {
  try {
    if (!sendAlertToGenie) return res.status(400).json({ error: "Genie sync not configured" });
    const { alert_type, title, message, data } = req.body;
    if (!title || !message)
      return res.status(400).json({ error: "title and message are required" });

    const alertId = await sendAlertToGenie(
      req.params.id,
      alert_type || "doctor_note",
      title,
      message,
      data || null,
    );
    res.json({ success: true, alertId });
  } catch (e) {
    handleError(res, e, "Send alert to Genie");
  }
});

export default router;
