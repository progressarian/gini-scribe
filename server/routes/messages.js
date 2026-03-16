import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { messageCreateSchema } from "../schemas/index.js";

const router = Router();

// Inbox — latest message per patient, unread first (paginated)
router.get("/messages/inbox", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const offset = (page - 1) * limit;

    // Get total thread count for pagination metadata
    const countResult = await pool.query(
      "SELECT COUNT(DISTINCT patient_id)::int AS total FROM patient_messages WHERE sender='patient'",
    );
    const total = countResult.rows[0]?.total || 0;

    const { rows } = await pool.query(`
      SELECT DISTINCT ON (pm.patient_id)
        pm.id, pm.patient_id, pm.sender, pm.sender_name, pm.message,
        pm.created_at AS sent_at, pm.is_read, pm.direction AS source,
        COALESCE(p.name, pm.sender_name, 'Unknown Patient') AS patient_name,
        p.file_no, p.phone, p.age, p.sex
      FROM patient_messages pm
      LEFT JOIN patients p ON p.id = pm.patient_id
      WHERE pm.sender = 'patient'
      ORDER BY pm.patient_id, pm.created_at DESC
    `);
    rows.sort((a, b) => {
      if (!a.is_read && b.is_read) return -1;
      if (a.is_read && !b.is_read) return 1;
      return new Date(b.sent_at) - new Date(a.sent_at);
    });

    const paginated = rows.slice(offset, offset + limit);
    res.json({
      data: paginated,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (e) {
    handleError(res, e, "Inbox");
  }
});

// Unread count
router.get("/messages/unread-count", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM patient_messages WHERE sender='patient' AND (is_read IS NULL OR is_read = false)",
    );
    res.json({ count: rows[0]?.count || 0 });
  } catch (e) {
    handleError(res, e, "Unread count");
  }
});

// Mark message as read
router.put("/messages/:id/read", async (req, res) => {
  try {
    await pool.query("UPDATE patient_messages SET is_read = true WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    handleError(res, e, "Mark read");
  }
});

// Full conversation thread for a patient
router.get("/patients/:id/messages", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pm.*, pm.created_at AS sent_at, pm.direction AS source,
              COALESCE(p.name, pm.sender_name) AS patient_name
       FROM patient_messages pm
       LEFT JOIN patients p ON p.id = pm.patient_id
       WHERE pm.patient_id = $1
       ORDER BY pm.created_at ASC`,
      [req.params.id],
    );
    res.json(rows);
  } catch (e) {
    handleError(res, e, "Messages thread");
  }
});

// Doctor sends a reply
router.post("/patients/:id/messages", validate(messageCreateSchema), async (req, res) => {
  try {
    const { message, sender_name } = req.body;
    const patientId = req.params.id;
    const doctorName = sender_name || "Dr. Bhansali";

    const { rows: msgRows } = await pool.query(
      `INSERT INTO patient_messages (patient_id, sender, sender_name, direction, message, is_read, created_at)
       VALUES ($1, 'doctor', $2, 'outbound', $3, true, NOW())
       RETURNING *, created_at AS sent_at, direction AS source`,
      [patientId, doctorName, message],
    );

    // Also write to alert_channel for scribe-sync delivery
    try {
      await pool.query(
        `INSERT INTO alert_channel (patient_id, direction, alert_type, title, message, sender_name, sender_role, status, created_at)
         VALUES ($1, 'scribe_to_genie', 'doctor_reply', $2, $3, $4, 'doctor', 'unread', NOW())`,
        [String(patientId), `Message from ${doctorName}`, message, doctorName],
      );
    } catch (alertErr) {
      console.log("alert_channel insert skipped (table may not exist):", alertErr.message);
    }

    res.json(msgRows[0]);
  } catch (e) {
    handleError(res, e, "Send message");
  }
});

export default router;
