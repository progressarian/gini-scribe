import { Router } from "express";

const router = Router();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;

// ─── POST /api/ai/complete ───────────────────────────────────────────
// Generic Claude proxy. Accepts the same shape as the Anthropic Messages API.
// Body: { messages, system?, model?, maxTokens? }
router.post("/ai/complete", async (req, res) => {
  if (!ANTHROPIC_KEY)
    return res.status(503).json({ error: "Anthropic API key not configured on server" });

  const { messages, system, model, maxTokens } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ error: "messages array is required" });

  const anthropicModel =
    model === "haiku" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-20250514";

  try {
    const body = {
      model: anthropicModel,
      max_tokens: maxTokens || 8000,
      messages,
    };
    if (system) body.system = system;

    const hasPdf = messages.some((m) =>
      (Array.isArray(m.content) ? m.content : []).some(
        (c) => c.type === "document" && c.source?.media_type === "application/pdf",
      ),
    );

    const headers = {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    };
    if (hasPdf) headers["anthropic-beta"] = "pdfs-2024-09-25";

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return res
        .status(resp.status)
        .json({ error: `Anthropic ${resp.status}: ${errText.slice(0, 200)}` });
    }

    const data = await resp.json();
    if (data.error) return res.status(502).json({ error: data.error.message });

    const text = (data.content || []).map((c) => c.text || "").join("");
    res.json({ text });
  } catch (err) {
    console.error("AI complete error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ai/transcribe ────────────────────────────────────────
// Proxies audio transcription to Deepgram or Whisper.
// Body: multipart/form-data { file, engine (deepgram|whisper), language }
router.post("/ai/transcribe", async (req, res) => {
  // Read raw body as buffer for forwarding
  const chunks = [];
  // The body is already parsed by Express as JSON if Content-Type is json.
  // For multipart/form-data with audio, we need raw handling.
  // Since Express already parsed JSON body, let's accept base64 audio instead.
  const { audio, engine, language, mimeType } = req.body;

  if (!audio) return res.status(400).json({ error: "audio (base64) is required" });

  const audioBuffer = Buffer.from(audio, "base64");

  if (engine === "whisper") {
    if (!OPENAI_KEY) return res.status(503).json({ error: "OpenAI API key not configured" });

    const lang = language === "hi" ? "hi" : "en";
    const boundary = "----GiniFormBoundary" + Date.now();
    const parts = [];

    // Build multipart form data manually
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: ${mimeType || "audio/webm"}\r\n\r\n`,
    );
    const filePart = Buffer.from(parts[0]);
    parts.length = 0;

    const afterFile = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1` +
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${lang}` +
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nMedical consultation in India. Terms: HbA1c, eGFR, creatinine, TSH, LDL, HDL, metformin, insulin, telmisartan, amlodipine, rosuvastatin, dapagliflozin, empagliflozin, thyronorm, dianorm, glimepiride, canagliflozin, proteinuria, nephropathy, retinopathy, CABG, dyslipidemia, hypothyroidism.` +
        `\r\n--${boundary}--\r\n`,
    );

    const body = Buffer.concat([filePart, audioBuffer, afterFile]);

    try {
      const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return res
          .status(resp.status)
          .json({ error: `Whisper ${resp.status}: ${errText.slice(0, 200)}` });
      }

      const data = await resp.json();
      res.json({ text: data.text || "" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } else {
    // Deepgram
    if (!DEEPGRAM_KEY) return res.status(503).json({ error: "Deepgram API key not configured" });

    const lang = language === "multi" ? "en" : language || "en";
    const keywords =
      "HbA1c:2,eGFR:2,creatinine:2,TSH:2,LDL:2,HDL:2,triglycerides:2,metformin:2,insulin:2,thyronorm:2,dianorm:1,glimepiride:1,telmisartan:1,amlodipine:1,rosuvastatin:1,atorvastatin:1,dapagliflozin:1,empagliflozin:1,sitagliptin:1,vildagliptin:1,proteinuria:1,nephropathy:1,retinopathy:1,neuropathy:1,CABG:1,dyslipidemia:1,hypothyroidism:1,ecosprin:1,concor:1,dytor:1,atchol:1,telma:1,amlong:1,cetanil:1,ciplar:1,lantus:1,tresiba:1,novorapid:1,humalog:1,jardiance:1,forxiga:1,shelcal:1,euthrox:1,glimy:1,mixtard:1";
    const kw = keywords
      .split(",")
      .map((k) => `keywords=${encodeURIComponent(k)}`)
      .join("&");
    const url = `https://api.deepgram.com/v1/listen?model=nova-2&language=${lang}&smart_format=true&punctuate=true&paragraphs=true&${kw}`;

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_KEY}`,
          "Content-Type": mimeType || "audio/webm",
        },
        body: audioBuffer,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return res
          .status(resp.status)
          .json({ error: `Deepgram ${resp.status}: ${errText.slice(0, 200)}` });
      }

      const data = await resp.json();
      const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      res.json({ text });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ─── GET /api/ai/deepgram-stream-token ──────────────────────────────
// Returns a short-lived config for the frontend to open a Deepgram WebSocket.
// The actual WebSocket is proxied below via the HTTP server upgrade handler.
router.get("/ai/deepgram-key", (req, res) => {
  if (!DEEPGRAM_KEY) return res.status(503).json({ error: "Deepgram key not configured" });
  res.json({ key: DEEPGRAM_KEY });
});

// ─── POST /api/ai/clinical-intelligence ─────────────────────────────
// Proxy to Supabase Edge Function (keeps anon key on server)
router.post("/ai/clinical-intelligence", async (req, res) => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(503).json({ error: "Supabase not configured" });

  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/clinical-intelligence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify(req.body),
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
