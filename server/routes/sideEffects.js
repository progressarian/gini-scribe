import { Router } from "express";
import { createRequire } from "module";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

// genie-sync.cjs is a legacy CommonJS module; load it via createRequire so
// this ES-module route file can use its conversation helpers.
const require = createRequire(import.meta.url);
let genie = null;
try {
  genie = require("../genie-sync.cjs");
} catch {
  console.log("[sideEffects] genie-sync.cjs not loaded — reception notify disabled");
}

const router = Router();

const SEVERITY_LABEL = {
  warn: "⚠️ Warning",
  uncommon: "🟠 Uncommon",
  common: "🟡 Common",
};

function formatBody({ action, name, medicationName, severity, status, source, patientNote }) {
  if (action === "removed") {
    return `🩺 Patient removed a side-effect they had reported${name ? ` (${name})` : ""}.`;
  }
  const verb = action === "updated" ? "updated" : "reported";
  const lines = [`🩺 Patient ${verb} a side-effect.`];
  lines.push(`• Symptom: ${name}`);
  if (medicationName) lines.push(`• Medicine: ${medicationName}`);
  if (severity) lines.push(`• Severity: ${SEVERITY_LABEL[severity] || severity}`);
  if (status) lines.push(`• Status: ${status === "resolved" ? "Resolved" : "Active"}`);
  if (source) lines.push(`• Source: ${source === "custom" ? "Custom entry" : "From curated list"}`);
  if (patientNote && String(patientNote).trim()) {
    lines.push(`• Note: ${String(patientNote).trim()}`);
  }
  lines.push("");
  lines.push("Please follow up with the patient.");
  return lines.join("\n");
}

// POST /api/patients/:id/side-effects/notify
// Public (no scribe JWT). Posts a system-style message from the patient
// into their reception conversation so the reception team's inbox surfaces
// the report in the conversation flow.
router.post("/patients/:id/side-effects/notify", async (req, res) => {
  try {
    if (!genie?.ensureConversation || !genie?.sendMessageToConversation) {
      return res.status(503).json({ error: "messaging not available" });
    }
    const patientIdParam = String(req.params.id || "").trim();
    if (!patientIdParam) return res.status(400).json({ error: "patient id required" });

    const {
      id = null,
      name = "",
      medicationName = null,
      severity = "common",
      status = "active",
      source = "custom",
      patientNote = null,
      action = "reported",
    } = req.body || {};

    if (!["reported", "updated", "removed"].includes(action)) {
      return res.status(400).json({ error: "invalid action" });
    }
    if (action !== "removed") {
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: "name required" });
      }
    }

    // Look up patient name (gini DB) for a friendlier sender label. Best-effort.
    let patientName = "Patient";
    try {
      const asInt = parseInt(patientIdParam, 10);
      if (Number.isFinite(asInt) && String(asInt) === patientIdParam) {
        const { rows } = await pool.query("SELECT name FROM patients WHERE id = $1 LIMIT 1", [
          asInt,
        ]);
        if (rows[0]?.name) patientName = rows[0].name;
      }
    } catch {
      // non-fatal
    }

    const conv = await genie.ensureConversation({
      patientId: patientIdParam,
      kind: "reception",
    });
    if (!conv) return res.status(500).json({ error: "could not ensure reception conversation" });

    const body = formatBody({
      action,
      name: String(name || "").trim(),
      medicationName,
      severity,
      status,
      source,
      patientNote,
    });

    const row = await genie.sendMessageToConversation({
      conversationId: conv.id,
      message: body,
      // Outbound = patient → team. Lands in the reception inbox conversation
      // exactly like a regular patient chat message.
      direction: "outbound",
      senderName: patientName,
      senderRole: "reception",
      messageType: "side_effect_log",
      sideEffectId: id || null,
    });

    if (!row) return res.status(500).json({ error: "failed to post message" });
    res.json({ ok: true, message_id: row.id, conversation_id: conv.id });
  } catch (e) {
    handleError(res, e, "Notify reception of side effect");
  }
});

// GET /api/side-effects
// Team-facing list. Returns all patient-reported side effects across patients
// (most recent first) joined with patient name + phone for the listing page.
// Requires scribe auth (mounted under /api which is gated by requireAuth).
router.get("/side-effects", async (req, res) => {
  try {
    const status = String(req.query.status || "").toLowerCase();
    const severity = String(req.query.severity || "").toLowerCase();
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    const params = [];
    const where = [];
    if (status === "active" || status === "resolved") {
      params.push(status);
      where.push(`r.status = $${params.length}`);
    }
    if (["common", "uncommon", "warn"].includes(severity)) {
      params.push(severity);
      where.push(`r.severity = $${params.length}`);
    }
    params.push(limit);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `SELECT r.id, r.patient_id, r.medication_id, r.medication_name,
              r.name, r.description, r.severity, r.status, r.source,
              r.patient_note, r.reported_at, r.updated_at,
              p.name AS patient_name, p.phone AS patient_phone, p.file_no AS patient_file_no
         FROM patient_reported_side_effects r
         JOIN patients p ON p.id = r.patient_id
         ${whereSql}
         ORDER BY r.reported_at DESC
         LIMIT $${params.length}`,
      params,
    );
    res.json({ data: rows });
  } catch (e) {
    handleError(res, e, "List side effects");
  }
});

// PATCH /api/side-effects/:id
// Team-facing toggle. Reception/MO marks a reported side effect as resolved
// (or re-opens it). Posts a follow-up message to the reception conversation
// so the patient + team timeline reflects the resolution.
router.patch("/side-effects/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "id required" });
    const status = String(req.body?.status || "").toLowerCase();
    if (!["active", "resolved"].includes(status)) {
      return res.status(400).json({ error: "status must be active|resolved" });
    }

    const { rows } = await pool.query(
      `UPDATE patient_reported_side_effects
          SET status = $1, updated_at = now()
        WHERE id = $2
      RETURNING id, patient_id, name, medication_name, status`,
      [status, id],
    );
    if (rows.length === 0) return res.status(404).json({ error: "not found" });
    const row = rows[0];

    // Best-effort: drop a system message into the reception conversation so the
    // resolution shows up in the chat timeline alongside the original report.
    try {
      if (genie?.ensureConversation && genie?.sendMessageToConversation) {
        const conv = await genie.ensureConversation({
          patientId: String(row.patient_id),
          kind: "reception",
        });
        if (conv?.id) {
          const verb = status === "resolved" ? "marked resolved" : "re-opened";
          const lines = [`🩺 Side-effect ${verb} by the team.`];
          lines.push(`• Symptom: ${row.name}`);
          if (row.medication_name) lines.push(`• Medicine: ${row.medication_name}`);
          await genie.sendMessageToConversation({
            conversationId: conv.id,
            message: lines.join("\n"),
            direction: "inbound",
            senderName: req.doctor?.doctor_name || "Gini Reception",
            senderRole: "reception",
            messageType: "side_effect_log",
            sideEffectId: row.id,
            teamOnly: true,
          });
        }
      }
    } catch (e) {
      console.warn("[side-effects PATCH] timeline post failed:", e?.message || e);
    }

    res.json({ ok: true, data: row });
  } catch (e) {
    handleError(res, e, "Update side effect");
  }
});

export default router;
