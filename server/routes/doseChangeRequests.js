import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { sendDoseDecisionNotification } from "../services/pushNotifier.js";

const router = Router();

const VALID_STATUS = ["pending", "approved", "rejected", "cancelled"];

const SELECT_BASE = `
  SELECT
    r.id,
    r.patient_id,
    r.medication_id,
    r.medication_name,
    r.current_dose,
    r.requested_dose,
    r.final_dose,
    r.dose_unit,
    r.patient_reason,
    r.status,
    r.doctor_id,
    r.doctor_note,
    r.reject_reason,
    r.initiated_by,
    r.requested_at,
    r.decided_at,
    p.name AS patient_name,
    p.phone AS patient_phone,
    p.file_no AS patient_file_no
  FROM medication_dose_change_requests r
  LEFT JOIN patients p ON p.id = r.patient_id
`;

function buildFilters(req, { includeStatus }) {
  const params = [];
  const where = [];

  if (includeStatus) {
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    if (status && status !== "all") {
      if (!VALID_STATUS.includes(status)) {
        const err = new Error("invalid status");
        err.statusCode = 400;
        throw err;
      }
      params.push(status);
      where.push(`r.status = $${params.length}`);
    }
  }

  const patientTerm =
    (typeof req.query.patient === "string" && req.query.patient.trim()) ||
    (typeof req.query.patient_id === "string" && req.query.patient_id.trim()) ||
    "";
  if (patientTerm) {
    const asInt = parseInt(patientTerm, 10);
    if (Number.isFinite(asInt) && String(asInt) === patientTerm) {
      params.push(asInt);
      const i = params.length;
      params.push(patientTerm);
      const j = params.length;
      params.push(`%${patientTerm}%`);
      const k = params.length;
      where.push(`(r.patient_id = $${i} OR p.file_no = $${j} OR p.name ILIKE $${k})`);
    } else {
      params.push(`%${patientTerm}%`);
      const i = params.length;
      where.push(`(p.name ILIKE $${i} OR p.file_no ILIKE $${i} OR p.phone ILIKE $${i})`);
    }
  }

  if (typeof req.query.from === "string" && req.query.from) {
    params.push(req.query.from);
    where.push(`r.requested_at >= $${params.length}`);
  }
  if (typeof req.query.to === "string" && req.query.to) {
    params.push(req.query.to);
    where.push(`r.requested_at <= $${params.length}`);
  }

  return { params, whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "" };
}

router.get("/dose-change-requests", async (req, res) => {
  try {
    const { params, whereSql } = buildFilters(req, { includeStatus: true });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const offset = (page - 1) * limit;

    const countSql = `
      SELECT COUNT(*)::int AS total
        FROM medication_dose_change_requests r
        LEFT JOIN patients p ON p.id = r.patient_id
        ${whereSql}`;
    const dataSql = `${SELECT_BASE}
      ${whereSql}
      ORDER BY r.requested_at DESC
      LIMIT ${limit} OFFSET ${offset}`;

    const [countRes, dataRes] = await Promise.all([
      pool.query(countSql, params),
      pool.query(dataSql, params),
    ]);
    const total = countRes.rows[0]?.total || 0;
    res.json({
      rows: dataRes.rows,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    handleError(res, e, "Get dose-change requests");
  }
});

router.get("/dose-change-requests/stats", async (req, res) => {
  try {
    const { params, whereSql } = buildFilters(req, { includeStatus: false });
    const sql = `
      SELECT r.status, COUNT(*)::int AS n
        FROM medication_dose_change_requests r
        LEFT JOIN patients p ON p.id = r.patient_id
        ${whereSql}
       GROUP BY r.status`;
    const { rows } = await pool.query(sql, params);
    const totals = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    rows.forEach((r) => {
      if (totals[r.status] !== undefined) totals[r.status] = r.n;
    });
    totals.total = totals.pending + totals.approved + totals.rejected + totals.cancelled;
    res.json(totals);
  } catch (e) {
    handleError(res, e, "Get dose-change stats");
  }
});

router.get("/dose-change-requests/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(`${SELECT_BASE} WHERE r.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Get dose-change request");
  }
});

router.get("/patients/:id/dose-change-requests", async (req, res) => {
  try {
    const pid = parseInt(req.params.id, 10);
    if (!Number.isFinite(pid)) return res.status(400).json({ error: "invalid patient id" });
    const { rows } = await pool.query(
      `${SELECT_BASE} WHERE r.patient_id = $1 ORDER BY r.requested_at DESC LIMIT 200`,
      [pid],
    );
    res.json(rows);
  } catch (e) {
    handleError(res, e, "Get patient dose-change history");
  }
});

// Doctor-initiated request (or admin staff on behalf of a doctor).
router.post("/dose-change-requests", async (req, res) => {
  try {
    const {
      patient_id,
      medication_id,
      medication_name,
      current_dose,
      requested_dose,
      dose_unit,
      patient_reason,
      doctor_id,
    } = req.body || {};
    const pid = parseInt(patient_id, 10);
    if (!Number.isFinite(pid)) return res.status(400).json({ error: "patient_id required" });
    if (!medication_id) return res.status(400).json({ error: "medication_id required" });
    if (!requested_dose) return res.status(400).json({ error: "requested_dose required" });

    const { rows } = await pool.query(
      `INSERT INTO medication_dose_change_requests
         (patient_id, medication_id, medication_name, current_dose,
          requested_dose, dose_unit, patient_reason, doctor_id, initiated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'doctor')
       RETURNING *`,
      [
        pid,
        String(medication_id),
        medication_name || "",
        current_dose || "",
        requested_dose,
        dose_unit || null,
        patient_reason || null,
        doctor_id || null,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") {
      return res.status(409).json({ error: "A pending request already exists for this medication" });
    }
    handleError(res, e, "Create dose-change request");
  }
});

// Doctor decision: approve / reject. On approve, update medications.dose
// inside the same transaction so the row never falls out of sync.
router.patch("/dose-change-requests/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { status, final_dose, doctor_note, reject_reason, doctor_id } = req.body || {};
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be approved or rejected" });
    }

    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id, patient_id, medication_id, medication_name, requested_dose, status
         FROM medication_dose_change_requests
        WHERE id = $1
        FOR UPDATE`,
      [req.params.id],
    );
    if (!existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not found" });
    }
    const row = existing.rows[0];
    if (row.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `request is ${row.status}, cannot decide again` });
    }

    let chosenDose = null;
    if (status === "approved") {
      chosenDose =
        typeof final_dose === "string" && final_dose.trim()
          ? final_dose.trim()
          : row.requested_dose;
    }

    const updated = await client.query(
      `UPDATE medication_dose_change_requests
          SET status        = $1,
              final_dose    = $2,
              doctor_note   = $3,
              reject_reason = CASE WHEN $1 = 'rejected' THEN $4 ELSE NULL END,
              doctor_id     = COALESCE($5, doctor_id),
              decided_at    = now()
        WHERE id = $6
        RETURNING *`,
      [
        status,
        chosenDose,
        typeof doctor_note === "string" && doctor_note.trim() ? doctor_note.trim() : null,
        typeof reject_reason === "string" && reject_reason.trim() ? reject_reason.trim() : null,
        doctor_id || null,
        req.params.id,
      ],
    );

    if (status === "approved") {
      // medications.id is TEXT; the request stored it as TEXT too.
      await client.query(
        `UPDATE medications
            SET dose = $1,
                updated_at = now()
          WHERE id::text = $2`,
        [chosenDose, row.medication_id],
      );
    }

    await client.query("COMMIT");

    // Fire-and-forget push (no-op if not configured).
    sendDoseDecisionNotification(row.patient_id, {
      kind: status,
      medicationName: row.medication_name,
      finalDose: chosenDose,
      doctorNote: updated.rows[0].doctor_note,
      rejectReason: updated.rows[0].reject_reason,
      requestId: row.id,
    }).catch((err) => console.warn("[doseChange] push failed:", err.message));

    res.json(updated.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Decide dose-change request");
  } finally {
    client.release();
  }
});

export default router;
