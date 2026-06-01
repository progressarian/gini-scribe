import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// GET /api/cc-calling — list logs with filters
router.get("/cc-calling", async (req, res) => {
  try {
    const { call_type, cc_assigned, from_date, to_date, page = 1, limit = 50 } = req.query;
    const off = (Math.max(1, +page) - 1) * Math.min(100, +limit);
    const params = [];
    const conds = [];

    if (call_type) {
      params.push(call_type);
      conds.push(`call_type=$${params.length}`);
    }
    if (cc_assigned) {
      params.push(cc_assigned);
      conds.push(`cc_assigned=$${params.length}`);
    }
    if (from_date) {
      params.push(from_date);
      conds.push(`visit_date>=$${params.length}`);
    }
    if (to_date) {
      params.push(to_date);
      conds.push(`visit_date<=$${params.length}`);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const [cntR, datR] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM cc_calling_log ${where}`, params),
      pool.query(
        `SELECT * FROM cc_calling_log ${where}
         ORDER BY visit_date DESC, created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, Math.min(100, +limit), off],
      ),
    ]);
    res.json({ data: datR.rows, total: cntR.rows[0]?.total || 0, page: +page, limit: +limit });
  } catch (e) {
    handleError(res, e, "CC calling list");
  }
});

// GET /api/cc-calling/agents — list CC names
router.get("/cc-calling/agents", async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM cc_agents WHERE is_active=true ORDER BY name");
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "CC agents");
  }
});

// GET /api/cc-calling/:id
router.get("/cc-calling/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM cc_calling_log WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "CC calling get");
  }
});

// POST /api/cc-calling — create log entry
router.post("/cc-calling", async (req, res) => {
  try {
    const fields = [
      "call_type",
      "patient_id",
      "file_no",
      "patient_name",
      "dob",
      "mobile",
      "condition",
      "visit_date",
      "visit_type",
      "cc_assigned",
      "outcome_data",
      "pt_recovery",
      "follow_visit_date",
      "follow_up_appt_time",
      "fundus_status",
      "additional_followup_date",
      "gap_days",
      "call_made_by",
      "calling_date",
      "call_duration_mins",
      "call_done",
      "improvement_status",
      "appt_booked_on",
      "appt_time_slot",
      "appt_type",
      "appt_not_booked_reason",
      "medical_issues_noted",
      "ticket_no",
      "followup_tests_status",
      "notes",
      "is_on_insulin",
      "show_no_show",
      "week_num",
      "month_num",
    ];
    const vals = fields.map((f) => req.body[f] ?? null);
    const cols = fields.join(",");
    const phs = fields.map((_, i) => `$${i + 1}`).join(",");
    const r = await pool.query(
      `INSERT INTO cc_calling_log (${cols}) VALUES (${phs}) RETURNING *`,
      vals,
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "CC calling create");
  }
});

// PATCH /api/cc-calling/:id — update any field
router.patch("/cc-calling/:id", async (req, res) => {
  try {
    const allowed = [
      "call_type",
      "call_made_by",
      "calling_date",
      "call_duration_mins",
      "call_done",
      "improvement_status",
      "pt_recovery",
      "appt_booked_on",
      "appt_time_slot",
      "appt_type",
      "appt_not_booked_reason",
      "medical_issues_noted",
      "ticket_no",
      "followup_tests_status",
      "notes",
      "is_on_insulin",
      "show_no_show",
      "follow_visit_date",
      "follow_up_appt_time",
      "outcome_data",
    ];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in req.body) {
        vals.push(req.body[k]);
        sets.push(`${k}=$${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    vals.push(req.params.id);
    sets.push(`updated_at=NOW()`);
    const r = await pool.query(
      `UPDATE cc_calling_log SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`,
      vals,
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "CC calling update");
  }
});

// DELETE /api/cc-calling/:id
router.delete("/cc-calling/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM cc_calling_log WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "CC calling delete");
  }
});

export default router;
