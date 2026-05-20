import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

const VALID_STATUS = ["pending", "approved", "rejected"];
const VALID_COLLECTION = ["hospital", "home"];
const PINCODE_RE = /^[0-9]{6}$/;

// Shared SELECT joins patient identity so the doctor's list shows
// name + file_no without an N+1 lookup.
const SELECT_BASE = `
  SELECT
    r.id,
    r.patient_id,
    r.test_names,
    r.collection_type,
    r.address_house,
    r.address_street,
    r.address_landmark,
    r.address_pincode,
    r.status,
    r.reviewed_by,
    r.reviewed_at,
    r.review_note,
    r.created_at,
    p.name    AS patient_name,
    p.phone   AS patient_phone,
    p.file_no AS patient_file_no
  FROM lab_test_requests r
  LEFT JOIN patients p ON p.id = r.patient_id
`;

// Normalises a request body into the column values the INSERT expects.
// Returns { error } on validation failure, { values } on success.
function buildInsertValues(body) {
  const patient_id = parseInt(body?.patient_id, 10);
  if (!Number.isFinite(patient_id)) return { error: "patient_id required" };

  const rawTests = body?.test_names;
  const test_names = Array.isArray(rawTests)
    ? rawTests.map((s) => String(s).trim()).filter(Boolean)
    : typeof rawTests === "string" && rawTests.trim()
      ? [rawTests.trim()]
      : [];
  if (!test_names.length) return { error: "at least one test name required" };

  const collection_type = String(body?.collection_type || "")
    .trim()
    .toLowerCase();
  if (!VALID_COLLECTION.includes(collection_type)) {
    return { error: "collection_type must be 'hospital' or 'home'" };
  }

  let house = null;
  let street = null;
  let landmark = null;
  let pincode = null;
  if (collection_type === "home") {
    house = String(body?.address_house || "").trim();
    street = String(body?.address_street || "").trim();
    landmark = String(body?.address_landmark || "").trim();
    pincode = String(body?.address_pincode || "").trim();
    if (!house) return { error: "address_house required for home collection" };
    if (!street) return { error: "address_street required for home collection" };
    if (!landmark) return { error: "address_landmark required for home collection" };
    if (!PINCODE_RE.test(pincode)) return { error: "address_pincode must be 6 digits" };
  }

  return { values: { patient_id, test_names, collection_type, house, street, landmark, pincode } };
}

// POST /api/lab-requests
// Patient creates a new request. Returns the created row.
router.post("/lab-requests", async (req, res) => {
  try {
    const built = buildInsertValues(req.body);
    if (built.error) return res.status(400).json({ error: built.error });
    const v = built.values;
    const { rows } = await pool.query(
      `INSERT INTO lab_test_requests
         (patient_id, test_names, collection_type,
          address_house, address_street, address_landmark, address_pincode)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [v.patient_id, v.test_names, v.collection_type, v.house, v.street, v.landmark, v.pincode],
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    handleError(res, e, "Create lab request");
  }
});

// GET /api/lab-requests?status=pending
// Doctor list view. status defaults to 'pending'; pass status=all for everything.
router.get("/lab-requests", async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    const params = [];
    const where = [];
    if (status && status !== "all") {
      if (!VALID_STATUS.includes(status)) {
        return res.status(400).json({ error: "invalid status" });
      }
      params.push(status);
      where.push(`r.status = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `${SELECT_BASE} ${whereSql} ORDER BY r.created_at DESC LIMIT 200`,
      params,
    );
    res.json(rows);
  } catch (e) {
    handleError(res, e, "List lab requests");
  }
});

// GET /api/lab-requests/:id
router.get("/lab-requests/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const { rows } = await pool.query(`${SELECT_BASE} WHERE r.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Get lab request");
  }
});

// GET /api/patients/:id/lab-requests
// Patient's own history, newest first.
router.get("/patients/:id/lab-requests", async (req, res) => {
  try {
    const pid = parseInt(req.params.id, 10);
    if (!Number.isFinite(pid)) return res.status(400).json({ error: "invalid patient id" });
    const { rows } = await pool.query(
      `${SELECT_BASE} WHERE r.patient_id = $1 ORDER BY r.created_at DESC LIMIT 200`,
      [pid],
    );
    res.json(rows);
  } catch (e) {
    handleError(res, e, "Get patient lab requests");
  }
});

// PATCH /api/lab-requests/:id
// Doctor decision. Body: { status: 'approved'|'rejected', review_note, reviewed_by }
router.patch("/lab-requests/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });

    const { status, review_note, reviewed_by } = req.body || {};
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
    }

    const existing = await pool.query(`SELECT id, status FROM lab_test_requests WHERE id = $1`, [
      id,
    ]);
    if (!existing.rows.length) return res.status(404).json({ error: "not found" });
    if (existing.rows[0].status !== "pending") {
      return res
        .status(409)
        .json({ error: `request is ${existing.rows[0].status}, cannot decide again` });
    }

    const { rows } = await pool.query(
      `UPDATE lab_test_requests
          SET status      = $1,
              review_note = $2,
              reviewed_by = $3,
              reviewed_at = NOW()
        WHERE id = $4
        RETURNING *`,
      [
        status,
        typeof review_note === "string" && review_note.trim() ? review_note.trim() : null,
        typeof reviewed_by === "string" && reviewed_by.trim() ? reviewed_by.trim() : null,
        id,
      ],
    );
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Decide lab request");
  }
});

export default router;
