import { Router } from "express";
import pool from "../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import {
  reasoningCreateSchema,
  reasoningUpdateSchema,
  audioUploadSchema,
  rxFeedbackCreateSchema,
  rxAudioUploadSchema,
} from "../schemas/index.js";

const router = Router();

// ============ CLINICAL REASONING ============

// Save reasoning for a consultation
router.post("/consultations/:id/reasoning", validate(reasoningCreateSchema), async (req, res) => {
  try {
    const {
      patient_id,
      doctor_id,
      doctor_name,
      reasoning_text,
      primary_condition,
      secondary_conditions,
      reasoning_tags,
      capture_method,
    } = req.body;
    const r = await pool.query(
      `INSERT INTO clinical_reasoning (consultation_id, patient_id, doctor_id, doctor_name, reasoning_text, primary_condition, secondary_conditions, reasoning_tags, capture_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        req.params.id,
        patient_id,
        doctor_id || null,
        doctor_name,
        reasoning_text,
        primary_condition,
        secondary_conditions || [],
        reasoning_tags || [],
        capture_method || "text",
      ],
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Reasoning");
  }
});

// Save reasoning standalone (no consultation)
router.post("/reasoning", validate(reasoningCreateSchema), async (req, res) => {
  try {
    const {
      patient_id,
      doctor_id,
      doctor_name,
      reasoning_text,
      primary_condition,
      secondary_conditions,
      reasoning_tags,
      capture_method,
      patient_context,
    } = req.body;
    const r = await pool.query(
      `INSERT INTO clinical_reasoning (consultation_id, patient_id, doctor_id, doctor_name, reasoning_text, primary_condition, secondary_conditions, reasoning_tags, capture_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        null,
        patient_id || null,
        doctor_id || null,
        doctor_name,
        reasoning_text + (patient_context ? "\n\n--- Context ---\n" + patient_context : ""),
        primary_condition,
        secondary_conditions || [],
        reasoning_tags || [],
        capture_method || "text",
      ],
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Reasoning");
  }
});

// Update reasoning
router.put("/reasoning/:id", validate(reasoningUpdateSchema), async (req, res) => {
  try {
    const {
      reasoning_text,
      primary_condition,
      secondary_conditions,
      reasoning_tags,
      capture_method,
      audio_transcript,
      transcription_status,
    } = req.body;
    const r = await pool.query(
      `UPDATE clinical_reasoning SET reasoning_text=COALESCE($1,reasoning_text), primary_condition=COALESCE($2,primary_condition),
       secondary_conditions=COALESCE($3,secondary_conditions), reasoning_tags=COALESCE($4,reasoning_tags),
       capture_method=COALESCE($5,capture_method), audio_transcript=COALESCE($6,audio_transcript),
       transcription_status=COALESCE($7,transcription_status), updated_at=NOW() WHERE id=$8 RETURNING *`,
      [
        reasoning_text,
        primary_condition,
        secondary_conditions,
        reasoning_tags,
        capture_method,
        audio_transcript,
        transcription_status,
        req.params.id,
      ],
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Reasoning");
  }
});

// Get reasoning for a consultation
router.get("/consultations/:id/reasoning", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM clinical_reasoning WHERE consultation_id=$1 ORDER BY created_at DESC",
      [req.params.id],
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Reasoning");
  }
});

// Upload audio for reasoning
router.post("/reasoning/:id/audio", validate(audioUploadSchema), async (req, res) => {
  try {
    const { base64, duration } = req.body;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
      return res.status(400).json({ error: "Storage not configured" });

    const cr = await pool.query("SELECT * FROM clinical_reasoning WHERE id=$1", [req.params.id]);
    if (!cr.rows[0]) return res.status(404).json({ error: "Not found" });

    const r = cr.rows[0];
    const ts = Date.now();
    const storagePath = `clinical-recordings/${r.doctor_id || "unknown"}/${new Date().toISOString().slice(0, 7)}/${r.consultation_id}_${ts}.webm`;

    const fileBuffer = Buffer.from(base64, "base64");
    const uploadResp = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "audio/webm",
          "x-upsert": "true",
        },
        body: fileBuffer,
      },
    );

    if (!uploadResp.ok)
      return res.status(500).json({ error: "Upload failed: " + (await uploadResp.text()) });

    await pool.query(
      "UPDATE clinical_reasoning SET audio_url=$1, audio_duration=$2, capture_method=CASE WHEN reasoning_text IS NOT NULL AND reasoning_text!='' THEN 'both' ELSE 'audio' END, transcription_status='pending', updated_at=NOW() WHERE id=$3",
      [storagePath, duration || 0, req.params.id],
    );

    res.json({ success: true, storage_path: storagePath });
  } catch (e) {
    handleError(res, e, "Reasoning");
  }
});

// Get signed URL for audio playback
router.get("/reasoning/:id/audio-url", async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
      return res.status(400).json({ error: "Storage not configured" });
    const cr = await pool.query("SELECT audio_url FROM clinical_reasoning WHERE id=$1", [
      req.params.id,
    ]);
    if (!cr.rows[0]?.audio_url) return res.status(404).json({ error: "No audio" });

    const signResp = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${cr.rows[0].audio_url}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      },
    );
    if (!signResp.ok) return res.status(500).json({ error: "Failed to generate URL" });
    const signData = await signResp.json();
    const signedPath = signData.signedURL || signData.signedUrl || signData.token;
    res.json({
      url: signedPath?.startsWith("http") ? signedPath : `${SUPABASE_URL}/storage/v1${signedPath}`,
    });
  } catch (e) {
    handleError(res, e, "Reasoning");
  }
});

// ============ RX REVIEW FEEDBACK ============

// Save Rx feedback
router.post(
  "/consultations/:id/rx-feedback",
  validate(rxFeedbackCreateSchema),
  async (req, res) => {
    try {
      const {
        patient_id,
        doctor_id,
        doctor_name,
        ai_rx_analysis,
        ai_model,
        agreement_level,
        feedback_text,
        correct_approach,
        reason_for_difference,
        disagreement_tags,
        primary_condition,
        medications_involved,
        severity,
      } = req.body;
      const r = await pool.query(
        `INSERT INTO rx_review_feedback (consultation_id, patient_id, doctor_id, doctor_name, ai_rx_analysis, ai_model, agreement_level, feedback_text, correct_approach, reason_for_difference, disagreement_tags, primary_condition, medications_involved, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          req.params.id,
          patient_id,
          doctor_id || null,
          doctor_name,
          ai_rx_analysis,
          ai_model || "claude-sonnet-4.5",
          agreement_level,
          feedback_text,
          correct_approach,
          reason_for_difference,
          disagreement_tags || [],
          primary_condition,
          medications_involved || [],
          severity,
        ],
      );
      res.json(r.rows[0]);
    } catch (e) {
      handleError(res, e, "Reasoning");
    }
  },
);

// Get Rx feedback for a consultation
router.get("/consultations/:id/rx-feedback", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM rx_review_feedback WHERE consultation_id=$1 ORDER BY created_at DESC",
      [req.params.id],
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Reasoning");
  }
});

// Upload audio for Rx feedback
router.post("/rx-feedback/:id/audio", validate(rxAudioUploadSchema), async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
      return res.status(400).json({ error: "Storage not configured" });

    const fb = await pool.query("SELECT * FROM rx_review_feedback WHERE id=$1", [req.params.id]);
    if (!fb.rows[0]) return res.status(404).json({ error: "Not found" });

    const ts = Date.now();
    const storagePath = `rx-feedback-audio/${fb.rows[0].doctor_id || "unknown"}/${new Date().toISOString().slice(0, 7)}/${fb.rows[0].consultation_id}_${ts}.webm`;

    const fileBuffer = Buffer.from(base64, "base64");
    const uploadResp = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "audio/webm",
          "x-upsert": "true",
        },
        body: fileBuffer,
      },
    );
    if (!uploadResp.ok) return res.status(500).json({ error: "Upload failed" });

    await pool.query("UPDATE rx_review_feedback SET feedback_audio_url=$1 WHERE id=$2", [
      storagePath,
      req.params.id,
    ]);
    res.json({ success: true });
  } catch (e) {
    handleError(res, e, "Reasoning");
  }
});

export default router;
