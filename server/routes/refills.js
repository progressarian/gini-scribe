import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

const VALID_STATUS = ["pending", "approved", "fulfilled", "rejected"];

const SELECT_WITH_ITEMS = `
  SELECT
    r.id,
    r.patient_id,
    r.status,
    r.notes,
    r.reject_reason,
    r.requested_at,
    r.status_updated_at,
    r.status_updated_by,
    p.name AS patient_name,
    p.phone AS patient_phone,
    p.file_no AS patient_file_no,
    COALESCE(
      (SELECT jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'medication_name', i.medication_name,
          'dose', i.dose,
          'timing', i.timing,
          'quantity', i.quantity,
          'source_medication_id', i.source_medication_id
        ) ORDER BY i.medication_name
       ) FROM medication_refill_request_items i WHERE i.request_id = r.id),
      '[]'::jsonb
    ) AS items
  FROM medication_refill_requests r
  LEFT JOIN patients p ON p.id = r.patient_id
`;

// Builds the WHERE clause + params from req.query. `includeStatus` controls
// whether to apply the status filter — the stats endpoint omits it so the
// per-status counts always reflect every status in the current scope.
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
      where.push(`(r.patient_id = $${i} OR p.file_no = $${j})`);
    } else {
      params.push(`%${patientTerm}%`);
      where.push(`p.file_no ILIKE $${params.length}`);
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

// Paginated list. Returns { rows, page, limit, total, totalPages }.
router.get("/refill-requests", async (req, res) => {
  try {
    const { params, whereSql } = buildFilters(req, { includeStatus: true });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const offset = (page - 1) * limit;

    const countSql = `
      SELECT COUNT(*)::int AS total
        FROM medication_refill_requests r
        LEFT JOIN patients p ON p.id = r.patient_id
        ${whereSql}`;
    const dataSql = `${SELECT_WITH_ITEMS}
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
    handleError(res, e, "Get refill requests");
  }
});

// Stats endpoint for the 4-card strip — counts grouped by status, applying
// every filter EXCEPT status itself. This way switching the status pill
// doesn't zero out the other counts.
router.get("/refill-requests/stats", async (req, res) => {
  try {
    const { params, whereSql } = buildFilters(req, { includeStatus: false });
    const sql = `
      SELECT r.status, COUNT(*)::int AS n
        FROM medication_refill_requests r
        LEFT JOIN patients p ON p.id = r.patient_id
        ${whereSql}
       GROUP BY r.status`;
    const { rows } = await pool.query(sql, params);
    const totals = { pending: 0, approved: 0, fulfilled: 0, rejected: 0 };
    rows.forEach((r) => {
      if (totals[r.status] !== undefined) totals[r.status] = r.n;
    });
    totals.total = totals.pending + totals.approved + totals.fulfilled + totals.rejected;
    res.json(totals);
  } catch (e) {
    handleError(res, e, "Get refill stats");
  }
});

router.get("/patients/:id/refill-requests", async (req, res) => {
  try {
    const pid = parseInt(req.params.id, 10);
    if (!Number.isFinite(pid)) return res.status(400).json({ error: "invalid patient id" });
    const { rows } = await pool.query(
      `${SELECT_WITH_ITEMS} WHERE r.patient_id = $1 ORDER BY r.requested_at DESC LIMIT 200`,
      [pid],
    );
    res.json(rows);
  } catch (e) {
    handleError(res, e, "Get patient refill history");
  }
});

router.patch("/refill-requests/:id", async (req, res) => {
  try {
    const { status, reject_reason } = req.body || {};
    if (!VALID_STATUS.includes(status)) {
      return res.status(400).json({ error: "invalid status" });
    }
    // reject_reason is only meaningful when rejecting; clear it on any
    // other status transition so a re-approved request doesn't carry the
    // stale rejection note.
    const reason =
      status === "rejected" && typeof reject_reason === "string" && reject_reason.trim()
        ? reject_reason.trim()
        : null;

    const { rowCount } = await pool.query(
      `UPDATE medication_refill_requests
          SET status = $1,
              reject_reason = CASE WHEN $1 = 'rejected' THEN $2 ELSE NULL END,
              status_updated_at = now(),
              status_updated_by = 'doctor'
        WHERE id = $3`,
      [status, reason, req.params.id],
    );
    if (rowCount === 0) return res.status(404).json({ error: "not found" });
    res.json({ success: true });
  } catch (e) {
    handleError(res, e, "Update refill request");
  }
});

export default router;
