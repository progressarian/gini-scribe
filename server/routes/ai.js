import { Router } from "express";
import sharp from "sharp";
import pool from "../config/db.js";
import {
  AGENT_TOOLS,
  executeTool,
  buildClientAction,
  UI_TOOL_NAMES,
  FINAL_TOOL_NAME,
} from "../services/agent/tools.js";
import {
  getOrCreateConversation,
  appendTurn,
  buildOutgoingMessages,
} from "../services/agent/conversations.js";

const router = Router();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;

// Anthropic rejects base64 image payloads above 5 MB per image. Stay below that
// with headroom for JSON/transport overhead.
const MAX_IMAGE_BASE64_BYTES = 4.5 * 1024 * 1024;

async function compressImageSource(source) {
  if (!source || source.type !== "base64" || typeof source.data !== "string") return source;
  if (!source.media_type?.startsWith("image/")) return source;

  const currentBase64Bytes = Buffer.byteLength(source.data, "utf8");
  if (currentBase64Bytes <= MAX_IMAGE_BASE64_BYTES) return source;

  const inputBuffer = Buffer.from(source.data, "base64");

  const attempts = [
    { maxDim: 2400, quality: 80 },
    { maxDim: 2000, quality: 75 },
    { maxDim: 1600, quality: 70 },
    { maxDim: 1280, quality: 65 },
    { maxDim: 1024, quality: 60 },
  ];

  for (const { maxDim, quality } of attempts) {
    try {
      const outBuffer = await sharp(inputBuffer, { failOn: "none" })
        .rotate()
        .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();

      const outBase64 = outBuffer.toString("base64");
      if (Buffer.byteLength(outBase64, "utf8") <= MAX_IMAGE_BASE64_BYTES) {
        return { type: "base64", media_type: "image/jpeg", data: outBase64 };
      }
    } catch (err) {
      console.error("sharp compress failed:", err.message);
      break;
    }
  }

  // Final fallback: aggressive downscale
  try {
    const outBuffer = await sharp(inputBuffer, { failOn: "none" })
      .rotate()
      .resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 50, mozjpeg: true })
      .toBuffer();
    return { type: "base64", media_type: "image/jpeg", data: outBuffer.toString("base64") };
  } catch (err) {
    console.error("sharp final compress failed:", err.message);
    return source;
  }
}

async function compressMessagesImages(messages) {
  return Promise.all(
    messages.map(async (m) => {
      if (!m || !Array.isArray(m.content)) return m;
      const newContent = await Promise.all(
        m.content.map(async (c) => {
          if (c?.type !== "image") return c;
          const newSource = await compressImageSource(c.source);
          return newSource === c.source ? c : { ...c, source: newSource };
        }),
      );
      return { ...m, content: newContent };
    }),
  );
}

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
    const compressedMessages = await compressMessagesImages(messages);

    const body = {
      model: anthropicModel,
      max_tokens: maxTokens || 8000,
      messages: compressedMessages,
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

// ─── POST /api/ai/agent ──────────────────────────────────────────────
// Tool-using patient-facing agent ("Dr. Gini AI"). Runs the Anthropic
// `tools` loop server-side. DB-read tools execute here; UI tools
// (propose_log, open_doctor_chat) are emitted as `client_actions` for the
// RN app to act on. Body: { messages, scribePatientId, model?: 'haiku'|'sonnet' }.
const AGENT_SYSTEM_PROMPT = `You are Dr. Gini AI, a warm, concise patient health coach for Gini Health. Hinglish is fine when the patient uses it. You can read this patient's records and open in-app cards via tools.

OUTPUT CONTRACT (STRICT):
- Every turn MUST end with exactly one call to the \`respond_to_patient\` tool. That tool call IS your reply; never put text outside of it.
- Put every concrete number you mention into \`numbers[]\` (label, value, unit, date or window). The app uses this array to render numeric badges — if it's missing, the patient sees no badge.
- When you propose a log, you MUST call \`propose_log\` FIRST, then \`respond_to_patient\` with \`intent:'log_proposed'\` and a matching \`log_proposal\` block.
- When you hand off to a doctor, you MUST call \`open_doctor_chat\` FIRST, then \`respond_to_patient\` with \`intent:'doctor_handoff'\` (and \`safety_flag\` set when relevant).

DATA RULES:
- Never invent values. Any number you state must have come from a tool result this turn.
- For "how am I doing / what's my progress / how's my sugar / how's my BP" questions, prefer \`get_progress_summary\` (one call) over multiple \`query_patient_data\` calls. Pick window='since_last_visit' if the user references "since I saw the doctor", otherwise window='days' with days inferred from the phrasing (this week=7, this month=30, last 3 months=90).
- When the patient gives you a vitals/lab number they want recorded (BP, sugar, weight, HbA1c, LDL, TSH, Hb, eGFR) OR a food/exercise/sleep/mood/symptom entry, ALWAYS call propose_log. Never claim to have logged something — only the in-app card saves data.

SAFETY:
- You do NOT diagnose, prescribe, or change doses. If the patient asks anything like that — or mentions chest pain, breathlessness, severe symptoms, or asks to talk to the doctor — call open_doctor_chat with a short seed, then respond with intent='doctor_handoff' and the right safety_flag.

STYLE:
- 2-4 sentences in \`message\` unless the patient asked for detail. Use the patient's first name when you know it. No markdown headers, no bullet syntax inside message.
- Time/date context: today is ${new Date().toISOString().slice(0, 10)}.`;

// Persist the user message + every model-produced block from this turn
// back to agent_conversations. No-ops on the legacy path (when convRow is
// null because the client sent `messages[]` instead of `message`+id).
// Returns the conversation id so the client can stash it.
async function persistTurnIfCheckpoint(poolRef, convRow, userBlock, turnBlocks) {
  if (!convRow || !userBlock) return null;
  try {
    await appendTurn(poolRef, convRow, userBlock, turnBlocks);
  } catch (e) {
    console.warn("[agent] persist turn failed:", e?.message || e);
  }
  return convRow.id;
}

router.post("/ai/agent", async (req, res) => {
  if (!ANTHROPIC_KEY)
    return res.status(503).json({ error: "Anthropic API key not configured on server" });

  // Two accepted body shapes:
  //   • New (preferred): { message, scribePatientId, conversationId?, model? }
  //     — server hydrates the persisted thread; client doesn't re-send history.
  //   • Legacy: { messages: [...], scribePatientId, model? } — full history
  //     from the client, no server-side persistence. Kept so older app
  //     builds keep working during rollout.
  const { messages, message, scribePatientId, conversationId, model } = req.body || {};
  const pid = Number(scribePatientId);
  if (!Number.isInteger(pid) || pid <= 0)
    return res.status(400).json({ error: "scribePatientId is required" });

  const usingCheckpoint = typeof message === "string" && message.trim().length > 0;
  if (!usingCheckpoint && (!Array.isArray(messages) || messages.length === 0))
    return res
      .status(400)
      .json({ error: "Either `message` (string) or `messages` (array) is required" });

  const anthropicModel =
    model === "sonnet" ? "claude-sonnet-4-20250514" : "claude-haiku-4-5-20251001";

  // Hydrate the thread (or create one) when using the checkpoint path.
  let convRow = null;
  let conversation;
  let latestUserBlock = null;
  if (usingCheckpoint) {
    convRow = await getOrCreateConversation(pool, pid, conversationId || null);
    latestUserBlock = { role: "user", content: message.trim() };
    const compressedTail = await compressMessagesImages([latestUserBlock]);
    latestUserBlock = compressedTail[0];
    conversation = buildOutgoingMessages(convRow, latestUserBlock);
  } else {
    const compressed = await compressMessagesImages(messages);
    conversation = [...compressed];
  }

  const ctx = { pool, scribePatientId: pid };
  const clientActions = [];
  const toolLog = [];
  let structured = null; // Set when the model calls respond_to_patient.

  // Track the blocks the model produced this turn (assistant + interleaved
  // tool_result user blocks) so we can persist them in one go at the end.
  const turnBlocksToPersist = [];

  try {
    for (let turn = 0; turn < 5; turn++) {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: anthropicModel,
          max_tokens: 1500,
          system: AGENT_SYSTEM_PROMPT,
          tools: AGENT_TOOLS,
          messages: conversation,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return res
          .status(resp.status)
          .json({ error: `Anthropic ${resp.status}: ${errText.slice(0, 300)}` });
      }
      const data = await resp.json();
      if (data.error) return res.status(502).json({ error: data.error.message });

      const blocks = Array.isArray(data.content) ? data.content : [];
      // Append the assistant turn to the conversation so any subsequent
      // tool_result references it.
      const assistantBlock = { role: "assistant", content: blocks };
      conversation.push(assistantBlock);
      turnBlocksToPersist.push(assistantBlock);

      const toolUses = blocks.filter((b) => b.type === "tool_use");
      const rawText = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text || "")
        .join("\n")
        .trim();

      // Did the model emit the terminal structured-output tool? If so, that
      // input IS our response — return immediately.
      const finalCall = toolUses.find((tu) => tu.name === FINAL_TOOL_NAME);
      if (finalCall) {
        const input = finalCall.input || {};
        structured = {
          message: typeof input.message === "string" ? input.message : "",
          intent: input.intent || "chat",
          numbers: Array.isArray(input.numbers) ? input.numbers : [],
          log_proposal: input.log_proposal || null,
          safety_flag: input.safety_flag || "none",
        };
        toolLog.push({ tool: FINAL_TOOL_NAME, input, ok: true });
        const convId = await persistTurnIfCheckpoint(
          pool,
          convRow,
          latestUserBlock,
          turnBlocksToPersist,
        );
        return res.json({
          text: structured.message,
          structured,
          client_actions: clientActions,
          tool_log: toolLog,
          conversationId: convId,
        });
      }

      // No tool_use AND no terminal tool — the model went off-contract.
      // Fall back to whatever plain text it produced so the patient still
      // gets a reply, but flag it in tool_log for monitoring.
      if (toolUses.length === 0) {
        toolLog.push({
          tool: "(no_final_tool)",
          input: { text: rawText.slice(0, 200) },
          ok: false,
        });
        const convId = await persistTurnIfCheckpoint(
          pool,
          convRow,
          latestUserBlock,
          turnBlocksToPersist,
        );
        return res.json({
          text: rawText || "(no response)",
          structured: {
            message: rawText,
            intent: "chat",
            numbers: [],
            log_proposal: null,
            safety_flag: "none",
          },
          client_actions: clientActions,
          tool_log: toolLog,
          conversationId: convId,
        });
      }

      // Execute each non-terminal tool_use and build a single user-role
      // message of tool_result blocks (Anthropic requires them grouped).
      const toolResults = [];
      for (const tu of toolUses) {
        let result;
        try {
          if (UI_TOOL_NAMES.has(tu.name)) {
            const built = buildClientAction(tu.name, tu.input || {});
            if (built) {
              clientActions.push(built.clientAction);
              result = built.ack;
            } else {
              result = { error: `Unknown UI tool: ${tu.name}` };
            }
          } else {
            result = await executeTool(tu.name, tu.input || {}, ctx);
          }
        } catch (err) {
          result = { error: String(err?.message || err) };
        }
        toolLog.push({ tool: tu.name, input: tu.input, ok: !result?.error });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result ?? null).slice(0, 60_000),
        });
      }
      const toolResultBlock = { role: "user", content: toolResults };
      conversation.push(toolResultBlock);
      turnBlocksToPersist.push(toolResultBlock);
    }

    // Loop budget exhausted without a respond_to_patient — return a fallback.
    const convId = await persistTurnIfCheckpoint(
      pool,
      convRow,
      latestUserBlock,
      turnBlocksToPersist,
    );
    return res.json({
      text: "I hit my tool-use limit before finishing. Please try again or rephrase.",
      structured: {
        message: "I hit my tool-use limit before finishing. Please try again or rephrase.",
        intent: "chat",
        numbers: [],
        log_proposal: null,
        safety_flag: "none",
      },
      client_actions: clientActions,
      tool_log: toolLog,
      conversationId: convId,
    });
  } catch (err) {
    console.error("AI agent error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
