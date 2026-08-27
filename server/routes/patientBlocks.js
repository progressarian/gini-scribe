import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../../shared/permissions.js";
import {
  isValidBlockReason,
  blockReasonLabel,
  BLOCK_ACTIONS,
  NOTE_REQUIRED_REASON,
} from "../../shared/patientBlockReasons.js";
import { redactBlock } from "../services/patientBlockView.js";
import { blockActor, logBlockAction } from "../services/patientBlockGuard.js";

const router = Router();

const auditLog = (req, action, patientId, details) =>
  pool
    .query(
      `INSERT INTO audit_log (doctor_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, 'patient', $3, $4)`,
      [req.doctor?.doctor_id || null, action, patientId, JSON.stringify(details || {})],
    )
    .catch(() => {});

// GET /api/patient-block-status?patient_ids=1,2,3
// Every staff role needs this to render the badge, so it sits on its own path
// prefix — capabilityForPath() is a literal longest-prefix matcher, and a
// sub-path of /api/patient-blocks would inherit ADMIN and 403 every list screen.
router.get("/patient-block-status", async (req, res) => {
  try {
    const ids = String(req.query.patient_ids || "")
      .split(",")
      .map((v) => parseInt(v, 10))
      .filter(Number.isInteger);

    if (ids.length === 0) return res.json({});

    const { rows } = await pool.query(
      `SELECT id, is_blocked, blocked_reason_code, blocked_note, blocked_at, blocked_by
         FROM patients
        WHERE id = ANY($1::int[]) AND is_blocked = TRUE`,
      [ids],
    );

    const out = {};
    for (const row of rows) out[row.id] = redactBlock(row, req.doctor?.role);
    res.json(out);
  } catch (e) {
    handleError(res, e, "Patient block status");
  }
});

// GET /api/patient-blocks?q=&page=&limit= — the admin list of everyone blocked.
//
// Paged server-side, returning the { data, total, page, limit, totalPages }
// shape the rest of the app's list endpoints use (see ghm-appointments.js), so
// the count is always the true total rather than a truncated page.
router.get("/patient-blocks", requireCapability(CAPABILITIES.ADMIN), async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const limit = Math.min(100, Math.max(1, +req.query.limit || 25));
    const page = Math.max(1, +req.query.page || 1);
    const offset = (page - 1) * limit;

    const params = [];
    let where = `WHERE p.is_blocked = TRUE`;
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (p.name ILIKE $1 OR p.file_no ILIKE $1 OR p.phone ILIKE $1)`;
    }

    // The admin review screen shows the whole person, not just the flag — an
    // administrator deciding whether to lift a block needs to recognise who
    // they are looking at. ADMIN-gated, so this is the one place the full
    // record is returned alongside the block.
    const [countR, dataR] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM patients p ${where}`, params),
      pool.query(
        `SELECT p.id, p.name, p.file_no, p.phone, p.alt_phone, p.age, p.sex, p.dob,
                p.address, p.email, p.blood_group, p.abha_id,
                p.blocked_reason_code, p.blocked_note, p.blocked_at, p.blocked_by, p.blocked_by_id,
                (SELECT MAX(a.appointment_date) FROM appointments a WHERE a.patient_id = p.id)
                  AS last_visit_date,
                (SELECT COUNT(*)::int FROM appointments a WHERE a.patient_id = p.id)
                  AS visit_count
           FROM patients p ${where}
          ORDER BY p.blocked_at DESC NULLS LAST, p.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
    ]);

    const total = countR.rows[0].total;
    res.json({
      data: dataR.rows.map((r) => ({
        ...r,
        blocked_label: blockReasonLabel(r.blocked_reason_code),
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (e) {
    handleError(res, e, "Blocked patients");
  }
});

// GET /api/patient-blocks/:patientId/history
router.get(
  "/patient-blocks/:patientId/history",
  requireCapability(CAPABILITIES.ADMIN),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, action, reason_code, note, actor_name, actor_id, created_at
           FROM patient_block_log
          WHERE patient_id = $1
          ORDER BY created_at DESC, id DESC`,
        [req.params.patientId],
      );
      res.json(rows.map((r) => ({ ...r, label: blockReasonLabel(r.reason_code) })));
    } catch (e) {
      handleError(res, e, "Block history");
    }
  },
);

// POST /api/patient-blocks/:patientId — block.
router.post(
  "/patient-blocks/:patientId",
  requireCapability(CAPABILITIES.ADMIN),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const patientId = parseInt(req.params.patientId, 10);
      if (!Number.isInteger(patientId))
        return res.status(400).json({ error: "Invalid patient id" });

      const reasonCode = (req.body?.reason_code || "").trim();
      const note = (req.body?.note || "").trim() || null;

      if (!isValidBlockReason(reasonCode)) {
        return res.status(400).json({ error: "A valid reason is required to block a patient" });
      }
      if (reasonCode === NOTE_REQUIRED_REASON && !note) {
        return res.status(400).json({ error: "A note is required when the reason is Other" });
      }

      const actor = blockActor(req);

      await client.query("BEGIN");

      // `AND is_blocked = FALSE` is what stops a second block from silently
      // rewriting who blocked this patient and when. Without it, B blocking an
      // already-blocked patient overwrites A's reason and timestamp on the
      // patient row — the row every screen and the admin list reads from —
      // while patient_block_log still holds the truth. The row would lie.
      const { rows } = await client.query(
        `UPDATE patients
          SET is_blocked = TRUE,
              blocked_reason_code = $2,
              blocked_note = $3,
              blocked_at = NOW(),
              blocked_by = $4,
              blocked_by_id = $5
        WHERE id = $1 AND is_blocked = FALSE
      RETURNING id, name, file_no, is_blocked, blocked_reason_code, blocked_note,
                blocked_at, blocked_by`,
        [patientId, reasonCode, note, actor.name, actor.id],
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        const cur = await pool.query("SELECT blocked_by, blocked_at FROM patients WHERE id = $1", [
          patientId,
        ]);
        if (cur.rows.length === 0) return res.status(404).json({ error: "Patient not found" });
        return res.status(409).json({
          error: "Patient is already blocked",
          reason: "already_blocked",
          blocked_by: cur.rows[0].blocked_by,
          blocked_at: cur.rows[0].blocked_at,
        });
      }

      await logBlockAction(
        {
          patientId,
          action: BLOCK_ACTIONS.BLOCK,
          reasonCode,
          note,
          actorName: actor.name,
          actorId: actor.id,
        },
        client,
      );

      // Kill every live patient-app session. authMiddleware already checks
      // auth_sessions on each request, so deleting these rows expires the
      // patient's 30-day tokens with no added per-request cost.
      await client.query(
        `DELETE FROM auth_sessions
        WHERE kind = 'patient' AND patient_db = 'hospital' AND patient_ref = $1`,
        [String(patientId)],
      );

      await client.query("COMMIT");

      auditLog(req, "block_patient", patientId, { reason_code: reasonCode });
      res.json({ ok: true, patient: rows[0] });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      handleError(res, e, "Block patient");
    } finally {
      client.release();
    }
  },
);

// DELETE /api/patient-blocks/:patientId — unblock. A note is required so a
// lifted block always leaves a reasoned record.
router.delete(
  "/patient-blocks/:patientId",
  requireCapability(CAPABILITIES.ADMIN),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const patientId = parseInt(req.params.patientId, 10);
      if (!Number.isInteger(patientId))
        return res.status(400).json({ error: "Invalid patient id" });

      const note = (req.body?.note || "").trim();
      if (!note) return res.status(400).json({ error: "A note is required to unblock a patient" });

      const actor = blockActor(req);

      await client.query("BEGIN");

      // `AND is_blocked = TRUE` keeps a no-op unblock from appending a phantom
      // `unblock` row to the audit trail for an action that changed nothing.
      const { rows } = await client.query(
        `UPDATE patients
            SET is_blocked = FALSE,
                blocked_reason_code = NULL,
                blocked_note = NULL,
                blocked_at = NULL,
                blocked_by = NULL,
                blocked_by_id = NULL
          WHERE id = $1 AND is_blocked = TRUE
        RETURNING id, name, file_no, is_blocked`,
        [patientId],
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        const cur = await pool.query("SELECT id FROM patients WHERE id = $1", [patientId]);
        if (cur.rows.length === 0) return res.status(404).json({ error: "Patient not found" });
        return res.status(409).json({ error: "Patient is not blocked", reason: "not_blocked" });
      }

      await logBlockAction(
        {
          patientId,
          action: BLOCK_ACTIONS.UNBLOCK,
          note,
          actorName: actor.name,
          actorId: actor.id,
        },
        client,
      );

      await client.query("COMMIT");

      auditLog(req, "unblock_patient", patientId, {});
      res.json({ ok: true, patient: rows[0] });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      handleError(res, e, "Unblock patient");
    } finally {
      client.release();
    }
  },
);

export default router;
