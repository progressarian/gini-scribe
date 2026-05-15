import { Router } from "express";
import { parseClinicalWithAI, parsePrescriptionWithAi } from "../services/healthray/parser.js";

const router = Router();

// POST /api/extract
// Body: { text: string }
router.post("/extract", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string" || text.trim().length < 1) {
      return res.status(400).json({ ok: false, error: "text is required" });
    }

    const result = await parsePrescriptionWithAi(text);
    // const res2 = await parseClinicalWithAI(text);
    if (!result) {
      return res.status(502).json({ ok: false, error: "parsePrescriptionWithAi returned null" });
    }

    return res.json({ ok: true, result: result });
  } catch (err) {
    console.error("[extract] failure:", err);
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "Extraction failed", stack: err?.stack });
  }
});

export default router;
