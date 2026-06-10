// ============================================================================
// Medicine collection (pharmacy fulfillment) — pharmacist marks whether a
// patient collected each prescribed medicine, so doctors/management can see who
// got which meds, with history.
//
// Design: docs/medicines-management/
// Writes guarded by MED_COLLECTION; while GRANT_ALL_CAPABILITIES is true the
// guard is permissive (activates with the role matrix).
// ============================================================================
import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../../shared/permissions.js";
import { collectionMarkSchema, collectionBulkSchema } from "../schemas/index.js";

const router = Router();
const canMark = requireCapability(CAPABILITIES.MED_COLLECTION);
const today = () => new Date().toISOString().split("T")[0];

// Best-effort appointment for a patient on a date (med.appointment_id is
// unreliable, so we look it up from appointments instead).
async function appointmentFor(client, patientId, date) {
  const r = await client.query(
    `SELECT id FROM appointments
      WHERE patient_id=$1 AND appointment_date=$2::date
      ORDER BY created_at DESC LIMIT 1`,
    [patientId, date],
  );
  return r.rows[0]?.id || null;
}

// Roll-up status from line counts.
function rollup({ total, given, not_given, partial, pending }) {
  if (total === 0) return "none_prescribed";
  if (pending === total) return "pending";
  if (given === total) return "all";
  if (not_given === total) return "none";
  return "partial";
}

// ── Phase 4: journey integration ────────────────────────────────────────────
// Reflect pharmacy collection on the patient-journey board's Rx station.
// First mark of the day = rx_checkin; once every current med is resolved (no
// pending lines) = rx_checkout. Best-effort: only stamps an EXISTING journey
// row (we never create one — patients not on today's board stay off it), and a
// failure here must never break the collection save (callers wrap in try/catch).
// Returns "stamped" (completed), "in_progress" (checked in, meds pending),
// "no_journey" (no station_tracking row for the appointment), or "no_appt".
async function stampRxJourney(client, patientId, apptId, date, markedBy) {
  if (!apptId) return "no_appt";
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS pending
       FROM medications m
       LEFT JOIN medicine_collections mc
         ON mc.medication_id = m.id AND mc.collected_date = $2::date
      WHERE m.patient_id = $1 AND m.is_active = true AND m.visit_status = 'current'
        AND mc.id IS NULL`,
    [patientId, date],
  );
  const pending = rows[0]?.pending ?? 0;
  const upd = await client.query(
    `UPDATE station_tracking
        SET rx_checkin = COALESCE(rx_checkin, NOW()),
            rx_checkout = CASE WHEN $2 = 0 THEN COALESCE(rx_checkout, NOW()) ELSE rx_checkout END,
            rx_explained_by = COALESCE($3, rx_explained_by),
            updated_at = NOW()
      WHERE appointment_id = $1`,
    [apptId, pending, markedBy],
  );
  if (!upd.rowCount) return "no_journey";
  return pending === 0 ? "stamped" : "in_progress";
}

// ── Worklist: patients prescribed on a date (who should collect) ────────────
router.get("/pharmacy/collection/today", async (req, res) => {
  try {
    const date = req.query.date || today();
    const { rows } = await pool.query(
      `SELECT p.id AS patient_id, p.name AS patient_name, p.file_no, p.phone,
              a.id AS appointment_id, a.doctor_name,
              COUNT(m.*)::int AS total,
              COUNT(mc.*) FILTER (WHERE mc.status='given')::int     AS given,
              COUNT(mc.*) FILTER (WHERE mc.status='not_given')::int AS not_given,
              COUNT(mc.*) FILTER (WHERE mc.status='partial')::int   AS partial,
              COUNT(m.*) FILTER (WHERE mc.id IS NULL)::int          AS pending
         FROM medications m
         JOIN patients p ON p.id = m.patient_id
         LEFT JOIN appointments a
           ON a.patient_id = p.id AND a.appointment_date = $1::date
         LEFT JOIN medicine_collections mc
           ON mc.medication_id = m.id AND mc.collected_date = $1::date
        WHERE m.is_active AND m.visit_status = 'current'
          AND m.last_prescribed_date = $1::date
        GROUP BY p.id, p.name, p.file_no, p.phone, a.id, a.doctor_name
        ORDER BY p.name`,
      [date],
    );
    const patients = rows.map((r) => ({ ...r, status: rollup(r) }));
    res.json({ date, count: patients.length, patients });
  } catch (e) {
    handleError(res, e, "Collection worklist");
  }
});

// ── A patient's current meds + each one's collection status for a date ──────
router.get("/patients/:id/collection", async (req, res) => {
  try {
    const date = req.query.date || today();
    const all = req.query.all === "1"; // include all active meds, not just current
    const { rows } = await pool.query(
      `SELECT m.id AS medication_id, m.name, m.pharmacy_match, m.composition,
              m.dose, m.frequency, m.timing, m.when_to_take, m.med_group, m.sort_order,
              mc.id AS collection_id, mc.status, mc.reason, mc.qty_note,
              mc.marked_by, mc.marked_at
         FROM medications m
         LEFT JOIN medicine_collections mc
           ON mc.medication_id = m.id AND mc.collected_date = $2::date
        WHERE m.patient_id = $1 AND m.is_active = true
          ${all ? "" : "AND m.visit_status = 'current'"}
        ORDER BY m.med_group NULLS LAST, m.sort_order, m.name`,
      [req.params.id, date],
    );
    res.json({ patient_id: Number(req.params.id), date, medicines: rows });
  } catch (e) {
    handleError(res, e, "Patient collection");
  }
});

// ── Mark ONE medicine (upsert on medication_id + date) ──────────────────────
router.post(
  "/medications/:id/collection",
  canMark,
  validate(collectionMarkSchema),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const medicationId = parseInt(req.params.id, 10);
      const { status, reason, qty_note } = req.body;
      const date = req.body.date || today();

      const med = await client.query("SELECT patient_id FROM medications WHERE id=$1", [
        medicationId,
      ]);
      if (!med.rows.length) return res.status(404).json({ error: "Medication not found" });
      const patientId = med.rows[0].patient_id;
      const apptId = req.body.appointment_id || (await appointmentFor(client, patientId, date));

      const r = await client.query(
        `INSERT INTO medicine_collections
           (medication_id, patient_id, appointment_id, collected_date, status, reason, qty_note, marked_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (medication_id, collected_date)
         DO UPDATE SET status=EXCLUDED.status, reason=EXCLUDED.reason,
                       qty_note=EXCLUDED.qty_note, marked_by=EXCLUDED.marked_by, updated_at=NOW()
         RETURNING *`,
        [
          medicationId,
          patientId,
          apptId,
          date,
          status,
          reason || null,
          qty_note || null,
          req.doctor?.doctor_name || null,
        ],
      );
      let journey = "skipped";
      try {
        journey = await stampRxJourney(client, patientId, apptId, date, req.doctor?.doctor_name);
      } catch (je) {
        console.warn("rx journey stamp failed:", je.message);
      }
      res.status(201).json({ ...r.rows[0], journey });
    } catch (e) {
      handleError(res, e, "Mark collection");
    } finally {
      client.release();
    }
  },
);

// ── Mark MANY meds for a patient in one call ────────────────────────────────
router.post(
  "/patients/:id/collection/bulk",
  canMark,
  validate(collectionBulkSchema),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const patientId = parseInt(req.params.id, 10);
      const date = req.body.date || today();
      const apptId = await appointmentFor(client, patientId, date);
      const markedBy = req.doctor?.doctor_name || null;

      await client.query("BEGIN");
      for (const it of req.body.items) {
        await client.query(
          `INSERT INTO medicine_collections
             (medication_id, patient_id, appointment_id, collected_date, status, reason, qty_note, marked_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (medication_id, collected_date)
           DO UPDATE SET status=EXCLUDED.status, reason=EXCLUDED.reason,
                         qty_note=EXCLUDED.qty_note, marked_by=EXCLUDED.marked_by, updated_at=NOW()`,
          [
            it.medication_id,
            patientId,
            apptId,
            date,
            it.status,
            it.reason || null,
            it.qty_note || null,
            markedBy,
          ],
        );
      }
      let journey = "skipped";
      try {
        journey = await stampRxJourney(client, patientId, apptId, date, markedBy);
      } catch (je) {
        console.warn("rx journey stamp failed:", je.message);
      }
      await client.query("COMMIT");
      res.json({ ok: true, count: req.body.items.length, date, journey });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      handleError(res, e, "Bulk collection");
    } finally {
      client.release();
    }
  },
);

// ── Report: per patient-day collection summary (doctors / management) ───────
router.get("/pharmacy/collection/report", async (req, res) => {
  try {
    const from = req.query.from || today();
    const to = req.query.to || from;
    const doctor = req.query.doctor ? `%${req.query.doctor}%` : null;
    const statusFilter = req.query.status || ""; // "" | all | partial | none

    const { rows } = await pool.query(
      `SELECT mc.patient_id, p.name AS patient_name, p.file_no,
              mc.collected_date::text AS collected_date,
              a.doctor_name,
              COUNT(*)::int                                        AS lines,
              COUNT(*) FILTER (WHERE mc.status='given')::int       AS given,
              COUNT(*) FILTER (WHERE mc.status='not_given')::int   AS not_given,
              COUNT(*) FILTER (WHERE mc.status='partial')::int     AS partial
         FROM medicine_collections mc
         JOIN patients p ON p.id = mc.patient_id
         LEFT JOIN appointments a ON a.id = COALESCE(
            mc.appointment_id,
            (SELECT id FROM appointments a2
              WHERE a2.patient_id = mc.patient_id AND a2.appointment_date = mc.collected_date
              ORDER BY created_at DESC LIMIT 1))
        WHERE mc.collected_date BETWEEN $1 AND $2
          AND ($3::text IS NULL OR a.doctor_name ILIKE $3)
        GROUP BY mc.patient_id, p.name, p.file_no, mc.collected_date, a.doctor_name
        ORDER BY mc.collected_date DESC, p.name`,
      [from, to, doctor],
    );

    const withStatus = rows.map((r) => ({
      ...r,
      status: r.given === r.lines ? "all" : r.not_given === r.lines ? "none" : "partial",
    }));
    const out = statusFilter ? withStatus.filter((r) => r.status === statusFilter) : withStatus;
    res.json({ from, to, count: out.length, rows: out });
  } catch (e) {
    handleError(res, e, "Collection report");
  }
});

// ── Not-collected worklist (clinically important follow-ups) ────────────────
router.get("/pharmacy/collection/not-collected", async (req, res) => {
  try {
    const from = req.query.from || today();
    const to = req.query.to || from;
    const { rows } = await pool.query(
      `SELECT mc.id, mc.collected_date::text AS collected_date, mc.reason, mc.qty_note,
              mc.marked_by, p.id AS patient_id, p.name AS patient_name, p.file_no, p.phone,
              m.name AS medicine, m.pharmacy_match, m.dose, m.frequency
         FROM medicine_collections mc
         JOIN patients p ON p.id = mc.patient_id
         JOIN medications m ON m.id = mc.medication_id
        WHERE mc.status='not_given' AND mc.collected_date BETWEEN $1 AND $2
        ORDER BY mc.collected_date DESC, p.name`,
      [from, to],
    );
    res.json({ from, to, count: rows.length, rows });
  } catch (e) {
    handleError(res, e, "Not-collected list");
  }
});

// ── A patient's full collection history (all dates) ─────────────────────────
router.get("/patients/:id/collection/history", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT mc.id, mc.collected_date, mc.status, mc.reason, mc.qty_note,
              mc.marked_by, mc.marked_at, m.name AS medicine, m.dose, m.frequency
         FROM medicine_collections mc
         JOIN medications m ON m.id = mc.medication_id
        WHERE mc.patient_id = $1
        ORDER BY mc.collected_date DESC, m.name`,
      [req.params.id],
    );
    res.json({ patient_id: Number(req.params.id), history: rows });
  } catch (e) {
    handleError(res, e, "Collection history");
  }
});

export default router;
