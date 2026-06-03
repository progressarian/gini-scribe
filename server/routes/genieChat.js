import { Router } from "express";
import pool from "../config/db.js";

// ── Genie AI chat — read-only doctor view ───────────────────────────────────
// Surfaces the patient↔"Genie" AI assistant transcript (the `chat_messages`
// table the patient app writes via saveChatMessage) to the doctor web app.
// Scoped to gini-program patients only — their chat_messages live on THIS
// scribe Postgres with an INTEGER patient_id, so this is a direct pool read
// with no cross-project work. Standalone (UUID) genie patients are out of
// scope. Consumed by src/pages/GenieChatsPage.jsx.

const router = Router();

// List gini-program patients who have any Genie chat history, most-recently
// active first. `search` matches patient name or file number (gini_patient_id).
// Paginated — returns { rows, page, limit, total, totalPages }, same shape as
// /refill-requests so the frontend can reuse the standard useInfiniteQuery
// pattern. `total` is the count of distinct patients matching the filter.
router.get("/genie-chats", async (req, res) => {
  try {
    const search = (req.query.search || "").toString().trim();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 30));
    const offset = (page - 1) * limit;

    const params = [];
    let where = "";
    if (search) {
      params.push(`%${search}%`);
      where = `WHERE p.name ILIKE $1 OR p.gini_patient_id ILIKE $1`;
    }

    const countSql = `
      SELECT COUNT(DISTINCT p.id)::int AS total
        FROM chat_messages c
        JOIN patients p ON p.id = c.patient_id
        ${where}`;

    const dataParams = [...params, limit, offset];
    const limIdx = dataParams.length - 1;
    const offIdx = dataParams.length;
    const dataSql = `
      SELECT p.id,
             p.name,
             p.gini_patient_id,
             COUNT(*)::int                                        AS msg_count,
             MAX(c.created_at)                                    AS last_at,
             (array_agg(c.content ORDER BY c.created_at DESC))[1] AS last_preview
        FROM chat_messages c
        JOIN patients p ON p.id = c.patient_id
        ${where}
       GROUP BY p.id, p.name, p.gini_patient_id
       ORDER BY last_at DESC NULLS LAST
       LIMIT $${limIdx} OFFSET $${offIdx}`;

    const [countRes, dataRes] = await Promise.all([
      pool.query(countSql, params),
      pool.query(dataSql, dataParams),
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
    console.error("[genie-chats list]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Transcript for one patient. Returns the newest `limit` messages (optionally
// strictly older than the `before` ISO timestamp, for "load older"), reversed
// to chronological order for rendering. `hasMore` signals another older page.
router.get("/patients/:id/genie-chat", async (req, res) => {
  try {
    const patientId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(patientId)) {
      return res.status(400).json({ error: "invalid patient id" });
    }
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    const before = (req.query.before || "").toString().trim();

    const params = [patientId];
    let beforeClause = "";
    if (before) {
      params.push(before);
      beforeClause = `AND created_at < $2`;
    }
    params.push(limit);
    const limIdx = params.length;

    const { rows } = await pool.query(
      `SELECT id, role, content, image_uri, actions, created_at
         FROM chat_messages
        WHERE patient_id = $1 ${beforeClause}
        ORDER BY created_at DESC
        LIMIT $${limIdx}`,
      params,
    );
    res.json({ data: rows.reverse(), hasMore: rows.length === limit });
  } catch (e) {
    console.error("[genie-chat thread]", e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
