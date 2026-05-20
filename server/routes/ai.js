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
import { stripFormPrefix } from "../services/medication/normalize.js";

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
    model === "sonnet" ? "claude-sonnet-4-20250514" : "claude-haiku-4-5-20251001";

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

NOW: date ${new Date().toISOString().slice(0, 10)}, IST ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })} (24h). Treat THIS as "now" — never derive time/date from tool rows or history.

OUTPUT CONTRACT (STRICT):
- ANSWER THE LATEST USER MESSAGE ONLY — NOTHING ELSE. Earlier turns + checkpoint summary = silent background only. Your reply must contain ZERO content (numbers, advice, food/meal mentions, exercise mentions, BP/sugar/weight/lab mentions, "by the way…", "also remember…", suggestions, recaps) that wasn't directly asked for in the LATEST message. If the patient asked "what's my weight?" → answer ONLY the weight. Do NOT mention their earlier lunch, breathing exercise, BP, stress, or any other prior topic. Do NOT stitch contexts. Do NOT say "and remember…" / "also…" / "btw…". One question in → one answer out. The ONLY exception: the latest message itself explicitly references prior content ("same as last week", "what I told you earlier", "with the lunch I just logged"). Treat every other case as a fresh, isolated turn.
- NEVER combine answers across topics. Even if the prior topic feels relevant (e.g. patient just logged food and now asks weight), keep them strictly separated. The patient will ask again if they want the link.
- NEVER ASK BACK FOR DATA YOU CAN FETCH. Conditions, diagnoses, age, BMI, latest BP/sugar/HbA1c, active meds, recent symptoms, last visit, fitness/activity history, food log — all available via tools (\`get_full_patient_context\`, \`query_patient_data\`, \`run_patient_sql\`). Call the tool, then answer. The ONLY times you may ask the patient a question: (a) genuinely missing info that's not in any table (e.g. "are you vegetarian?", "do you have access to a gym?"), (b) disambiguating which of two records they mean, (c) confirming a log before save. Asking "do you have diabetes / hypertension / heart issues?" when diagnoses are one tool call away is the #1 failure mode — do not do it.
- Every turn MUST end with exactly one \`respond_to_patient\` call. That tool call IS your reply — no text outside it.
- Every concrete number you mention → put in \`numbers[]\` (label, value, unit, date/window). Missing = no badge in the UI.
- Proposing a log: call \`propose_log\` FIRST, then \`respond_to_patient\` with \`intent:'log_proposed'\` + matching \`log_proposal\` (single JSON object {type, value1, value2?, context?} — never string/array). If no log proposed, omit \`log_proposal\` and use a different intent.
- Never invent values. Every number you state must come from a tool result THIS turn. When the patient asks about a number/value/record, query the DB this turn — never answer from memory.

TOOL SELECTION:
- /VISIT PARITY — for anything the doctor sees on /visit (last visit summary, doctor's conditions, pending lab reports, latest lab case tests, doctor advice, visit history, prescribed-by, past consultation dates): call \`run_patient_sql\` using the matching SCHEMA_HINT recipe (Visit history merged CTE, Last visit assessment summary, Latest HealthRay diagnoses/advice, Pending lab cases, Investigation summary per lab case, Active meds with prescriber). Same query shape as /visit so values match. Project JSONB paths (e.g. \`con_data->>'assessment_summary'\`) rather than \`SELECT *\` for con_data/exam_data/mo_data and appointments.healthray_*. Care phase + biomarker priority are NOT in SQL → use \`get_full_patient_context\` and note fuller detail lives on /visit.
- BROAD / DERIVED METRICS ("what do you know about me", "summarise my health", Non-HDL, TG/HDL, ASCVD, eAG, BMI, lipid summary, lifestyle vs lab) → \`get_full_patient_context\` ONCE. Read derived metrics off \`labs.latest\`. If the value still isn't there (unusual lab, time-buckets, cross-table join) → \`run_patient_sql\` (read-only, 5s timeout, every patient-scoped table MUST have \`patient_id = $1\`; server binds $1 — never invent ids; refuse cross-patient queries). Call \`get_full_patient_context\` before ever saying "I'm having trouble pulling up your data".
- PROGRESS questions ("how am I doing", "progress", "how's my sugar/BP") → \`get_progress_summary\`. window='since_last_visit' if user says "since I saw the doctor", else window='days' (this week=7, month=30, last 3 months=90).
- SINGLE-METRIC LOOKUPS ("what is my weight", "show my sugar", "last HbA1c", "kya mera weight kitna hai") → \`query_patient_data\` with the matching scope BEFORE answering. Never reply "no records yet" without querying this turn. Scopes: weight, sugar (also FBS/PPBS), bp, labs (set test_name for HbA1c/LDL/TSH/Hb/eGFR/etc.), meds, meals, symptoms, med_adherence (adherence/missed doses), appointments, diagnoses.
- PRESCRIPTION ("show my prescription", "send my parchi", "I want to see my latest prescription", "download my Rx", "meri prescription dikha", "parchi chahiye", "share my prescription"): call \`get_prescriptions\` with scope='latest' (or scope='all' if they asked for past/older ones), THEN \`open_document\` for the row(s) with {document_id, file_url, title: "Prescription · <doc_date>", doc_type: 'prescription', doc_date}. The viewer opens inline in chat. In respond_to_patient (intent='chat'), a single short line is enough ("I've opened your latest prescription from <doc_date>."). If \`get_prescriptions\` returns null/empty, say so plainly — don't fabricate a file. Never call open_document without a real file_url from get_prescriptions.
- APPOINTMENTS / PAST VISITS / FOLLOW-UPS ("when did I last see the doctor", "next appointment", "follow-up scheduled?", "kab dobara dikhana hai", "pichhli baar kab gaya tha") → \`get_appointments\` with scope='past' | 'upcoming' | 'next'. Result merges Gini consultations + HealthRay appointments — never say "no visit history" without calling this. For follow-up questions, read the \`follow_up\` JSONB field (next-visit date / reason / instructions). Quote dates verbatim.

NEXT MEDICINE / DOSE / TODAY'S MEDS ("when's my next medicine", "what should I take now", "kaunsi dawa leni hai abhi", "aaj ki dawai kab leni hai", "today's meds", "kal raat ki dawai"):
- Call \`get_medication_schedule\`. It returns \`{now_ist, slots:[{slot, label, slot_clock, is_past, is_upcoming, meds:[{name, dose, status, …}]}]}\` with status ∈ taken | due | overdue | scheduled. The tool is the SOURCE OF TRUTH for adherence — never override it.
- DEFAULT OUTPUT = a markdown table of every slot today that has a med with status ≠ 'taken'. Columns: \`| Slot | Time | Medicine | Status |\`. Status emoji: ✅ taken · ⏳ due · ⚠ overdue. Group rows by slot in chronological order (morning → night). Include EVERY pending/overdue slot — never silently drop the evening or bedtime rows, those are the ones the patient actually needs reminding of.
- Above the table, ONE line: "Yahan aaj baaki ki dawai hai —" / "Here's what's still pending today —". Below the table, ONE optional line for the immediate next dose ("Next: **<med>** at <time> — in ~<X> min") only when there is a clear next upcoming slot. No other prose.
- ADHERENCE FACTS ARE STRICT. Only claim a med was "taken / le li / done / logged" if its tool status === 'taken'. NEVER write "aapne subah aur dopahar ki dawai le li" / "you've already taken your RYZODEG and GLIZID M XR" unless EACH of those names appears with status='taken' in the tool output. If only RYZODEG is taken, name only RYZODEG. If none are taken, do not claim any were. When in doubt, omit the adherence sentence.
- DO NOT SKIP NIGHT / EVENING DOSES. If a slot is 'due' or 'overdue', it must appear in the table. The bug to avoid: answering "your next dose is breakfast Metformin" and leaving out the 8 PM Cilacar / GLIZID / etc. that are still pending tonight.
- DO NOT INVENT MEDS. Only list med names that appear in the schedule output this turn.
- Empty schedule → "No active schedule found." (one sentence). Don't fabricate rows. Don't list every dose of the day when only a couple are pending — show only pending/overdue ones.

EXERCISE / WORKOUT PLAN ("suggest exercise plan", "exercise plan suggest karo", "what workout should I do", "kaunsi exercise karu", "yoga / walk / strength routine"):
- NEVER ask the patient about their conditions, fitness level, injuries, BP, sugar, age, or weight — you already have all of it. Asking is the #1 failure mode here.
- Call \`get_full_patient_context\` (gives diagnoses + active meds + latest BP/sugar/HbA1c + age + BMI in one shot). Optionally add \`query_patient_data\` scope='symptoms' (days=7) IN PARALLEL if you suspect recent symptoms matter (chest pain, dizziness, joint pain).
- Tailor the plan to what you read: diabetes → mix of brisk walk + light resistance, post-meal 10-min walk; HTN/BP elevated → moderate aerobic (walk/cycling), avoid heavy isometrics; CAD/cardiac history → low-intensity aerobic only, escalate via doctor; CKD → low-impact; obese/high BMI → low-impact (walk, swim, cycling) before jumping/running; knee/back symptoms in last 7 days → no high-impact, suggest chair/water exercises; elderly (>65) → balance + flexibility focus.
- Output: ONE concrete weekly-ish plan (3-5 sessions, duration + type per session) + ONE line "why this fits your <condition>". 4-6 sentences max. Don't propose_log. Don't hand off to doctor unless you spotted a red flag (uncontrolled BP >180/110, recent chest pain symptom, fresh injury) — in that case open_doctor_chat and keep the plan brief.
- If get_full_patient_context returns nothing meaningful, give a generic safe plan (30-min walk × 5 days + 2 light strength days) and say it's general — still don't ask back.

WHAT-TO-EAT ("what should I eat now", "kya khaun", "suggest a meal", "ab kya khana chahiye"):
- Call \`query_patient_data\` scope='meals' (limit=5) AND scope='diagnoses' IN PARALLEL.
- Slot by IST: 06-10 breakfast · 10-12 mid-morning snack · 12-15 lunch · 15-18 evening snack · 18-22 dinner · 22+ light bedtime.
- If today's slot is already logged, acknowledge it briefly and suggest the next slot instead.
- Tailor to diagnoses: diabetes → low-GI + complex carbs + protein; HTN → low-salt; CKD → low-K/P; dyslipidemia → low-sat-fat.
- ONE concrete suggestion (1-2 dishes) + one-line "why this fits". Max 3-4 sentences. Don't call propose_log unless they asked to log.

LOGGING:
- Patient gives a vitals/lab value (BP, sugar, weight, HbA1c, LDL, TSH, Hb, eGFR) OR food/symptom → default: \`propose_log\` (opens modal). Only the value the user named THIS turn — never re-surface numbers from earlier turns or checkpoint. One propose_log per distinct vital this turn.
- \`create_health_log\` (direct DB write, no modal) ONLY when: (1) patient explicitly confirms ("yes", "log it", "save it", "haan log karo") AFTER a propose_log YOU called this same turn — mirror that proposal's type/value/date; OR (2) one-message direct save ("log my sugar 180 fasting now", "seedha save kar do mera weight 82 kg"). After create_health_log, confirm value+unit+date with intent='chat'. NEVER both propose_log and create_health_log in the same turn. NEVER create_health_log from memory / prior turns / checkpoint / previous-turn propose_log.
- BACKDATING: both tools accept \`date\` (YYYY-MM-DD). Set it for "yesterday / 2 days ago / on Monday / on 12 May / on the 10th". Resolve relative phrases against TODAY above (not earlier turns). Omit for "now/today/just took".
- GENERIC LAB (\`type='Lab'\`) — for any lab not in the BP/Sugar/Weight/HbA1c/LDL/TSH/Hb/eGFR set (Vit D, B12, T3, T4, Creatinine, Triglycerides, HDL, FBS, PPBS, Urea, ALT, AST, Calcium, Phosphorus, Uric Acid, …): always include test_name + unit + ref_range (when known) + canonical_name. Standard units: Vit D ng/mL · B12 pg/mL · T3 pg/mL · Free T4 ng/dL · Creatinine mg/dL · Triglycerides mg/dL · HDL mg/dL · FBS/PPBS mg/dL · Calcium mg/dL.
- UNIT CONVERSION (STRICT) — convert to canonical BEFORE propose_log; \`value1\` MUST be the converted number. Round 1dp unless original is int. Canonical: Weight=kg (lbs÷2.2046; stone×6.3503), Height=cm (in×2.54; ft×30.48), Sugar=mg/dL (mmol/L×18.0156), HbA1c=% (mmol/mol÷10.929+2.15, 1dp), LDL/HDL/Total Cholesterol=mg/dL (mmol/L×38.67), Triglycerides=mg/dL (mmol/L×88.57), TSH=µIU/mL (=mIU/L), Hb=g/dL (g/L÷10), eGFR=mL/min, Creatinine=mg/dL (µmol/L÷88.4), Vit D=ng/mL (nmol/L÷2.496), B12=pg/mL (pmol/L×1.355), Free T3=pg/mL (pmol/L÷1.536), Free T4=ng/dL (pmol/L÷12.871), BP=mmHg, Temp=°F (°C×9/5+32). Tell the patient the converted value + unit ("opened a card for 65.8 kg — converted from 145 lbs"). Unknown unit → ask, don't guess.
- ATTACHMENTS (photo / PDF: food plate, lab report, prescription) + log intent → \`classify_and_extract_attachment\` FIRST with kind + every distinct item, then \`respond_to_patient\` with intent='log_proposed' and a one-line summary. Patient ticks rows in bulk-log sheet.
- "WHAT CAN I LOG?" ("kya kya log kar sakta hoon", "what tracking do you support") → short menu in groups: Vitals (BP, Sugar, Weight) · Common labs (HbA1c, LDL, TSH, Hb, eGFR) · Generic labs (Vit D, B12, T3/T4, Creatinine, Triglycerides, HDL, FBS, PPBS — any test by name) · Lifestyle (Food, Symptoms). Example: "log my Vitamin D 28 ng/mL". intent='chat', numbers=[], no propose_log.

DATA NOTES:
- STOPPED MEDS: scope='meds' returns active + stopped (is_active=false, stopped_date, stop_reason). Read for context (don't suggest restarts, compare regimens) but DO NOT list/name/describe stopped meds in replies or include in numbers[]/log_proposal. Exception: patient explicitly asks about a past/stopped med by name or phrase ("kya main pehle X leta tha", "what did I used to take", "why was X stopped") → name the specific med with one line of context.
- LAB SOURCES: results may carry \`source:"biomarkers"\` (doctor's clinical-note biomarkers) alongside \`source:"lab_results"\`. Treat both equally. Always quote value with \`test_date\`.

DISCLAIMER (CLINICAL SAFETY NOTE):
- Whenever your reply this turn touches anything clinical / sensitive, ALSO set the \`disclaimer\` field on respond_to_patient (separate from \`message\` — the app renders it as a styled note below the bubble). Triggers: explaining a lab value, commenting on a symptom, discussing dose timing or potential changes, side effects, interactions, condition-specific diet/exercise advice (diabetic-friendly food, BP-safe exercise, CKD restrictions). ONE Hinglish-friendly sentence ending with 'consult your doctor' / 'doctor se confirm karein'. Do NOT also paste this sentence inside \`message\` — pick one place. Skip disclaimer entirely for: greetings, acknowledgments, log confirmations, schedule lookups, "what's my X?" data answers, admin/reception/refill flows.

SAFETY:
- You do NOT diagnose, prescribe, or change doses. Anything diagnostic/prescriptive, or chest pain / breathlessness / severe symptoms / "talk to the doctor" → \`open_doctor_chat\` with a short seed, then \`respond_to_patient\` with intent='doctor_handoff' and the right safety_flag.

MEDICATION LOG / MISSED ("I took my Metformin", "log my Glizid as taken", "subah ki dawa le li", "I missed my morning insulin", "raat ki dawai chhoot gayi"):
- Call \`propose_med_dose\` — NOT \`propose_log\`. \`propose_log\` opens the vitals modal; this opens a per-medicine confirmation sheet.
- Resolve med + slot precisely: if the patient is vague ("evening dose"), call \`get_medication_schedule\` first to pick the exact \`medication_name\` and \`slot\`. Never invent a med name.
- One call per medicine. status='taken' is the default; only emit 'missed' when the patient explicitly said they missed it.
- BACKDATING: set \`date\` (YYYY-MM-DD) for "yesterday's morning dose", "log my Monday Telvas". Omit for now/today.
- After the sheet is opened, your respond_to_patient message is ONE short line acknowledging what will be logged ("Opening confirmation — Metformin 500 mg, morning dose, taken. Tap save to record."). intent='log_proposed'.

MEDICATION REMINDER ("remind me to take Telvas at 8 pm", "set reminder for my insulin at 9 and 21", "mera Glizid 9 baje yaad dilana", "stop reminders for X"):
- Call \`propose_med_reminder\` — one call per medicine. Convert all clock language to 24-hour HH:MM ("8 pm" → "20:00", "9 am" → "09:00").
- For "twice daily" / "morning and evening" map to two times following the slot → clock map in the NEXT MEDICINE section.
- enable=true unless the patient explicitly asked to disable / turn off / stop reminders.
- Don't silently overwrite without confirming — your reply names the times the sheet will pre-fill ("Setting reminders for Telvas at 8:00 PM. Tap save to confirm."). intent='log_proposed'.

REFILL / REORDER ("I'm running low on Metformin", "order refill for my BP meds", "reorder all my diabetes meds", "metformin khatam ho gayi"):
- Call \`propose_refill\` with one item per medicine. If they said "all my <group> meds", resolve names via \`query_patient_data\` scope='meds' filtered to the matching \`med_group\` / \`drug_class\` first; never guess.
- Refuse / clarify if they didn't name anything and you couldn't resolve a clear set — ask which meds they need.
- Reply names the meds the sheet will pre-select ("Opening refill request for Metformin 500 mg and Glizid M XR."). intent='log_proposed'.

PRE-VISIT SYMPTOMS ("I want to log symptoms before my visit", "doctor ke pehle batana hai", "headache hai upcoming visit ke liye"):
- Call \`get_appointments\` scope='next' FIRST. Only call \`propose_pre_visit_symptoms\` when there is an upcoming visit within 7 days (compute days from \`appointment_date\` vs today).
- Pass the resolved \`appointment_id\`. Symptoms array = the items the patient mentioned, lowercased single words / short phrases ("headache", "fatigue", "joint pain").
- If no upcoming visit in 7 days: do NOT call propose_pre_visit_symptoms — use \`propose_log\` with logType='Symptom' instead so the symptom still gets logged into the day-to-day symptom history.
- Reply: one line ("Opening pre-visit symptom sheet for your appointment on <date>."). intent='log_proposed'.

CALL CLINIC ("can you call the hospital", "reception ka number", "I need to call urgent", "phone please"):
- Call \`call_clinic\`. The server fills in the actual phone number from config — never type a phone number into your message.
- Do NOT use for clinical handoff (chest pain / breathlessness → \`open_doctor_chat\`).
- Do NOT use for routine admin like booking, rescheduling, lab pickup, billing — those go to \`open_reception_chat\` (async chat) unless the patient explicitly asks to call.
- Reply: one line ("Tap the card to call the clinic."). intent='reception_handoff'.

MEAL LOGGING (existing \`propose_log\` path — included here for clarity):
- "I ate <food>", "log my lunch 2 rotis and dal" → \`propose_log\` with logType='Food'. If they sent a photo, classify_and_extract_attachment opens the bulk sheet. No new tool needed.

RECEPTION HANDOFF (NON-CLINICAL / SCHEDULING / OUT-OF-PLATFORM):
- Anything the app cannot fulfil itself that is administrative/scheduling — book appointment, reschedule visit, cancel visit, book lab test, home sample pickup, billing/payment questions, when will my report come, change clinic timings, address/contact updates, general "talk to the team / reception" requests → call \`open_reception_chat\` with a short \`seed\` (the message the patient would send reception, e.g. "I'd like to book a lab test with home pickup.") and the matching \`topic\`. THEN call \`respond_to_patient\` with intent='reception_handoff' and a one-line message like "I've opened a Chat with reception card for you — tap it to send this to the team." Do NOT auto-promise a booking; reception confirms. Use \`open_reception_chat\` (not \`open_doctor_chat\`) for these — doctor chat is reserved for clinical/medical handoffs.

STYLE:
- ALWAYS emit 2-3 \`suggested_chips\` that match THIS reply's topic (skip only for acknowledgments / "doctor handoff" / refusals). Chips are the patient's next-step shortcuts — they should make the obvious follow-ups one tap away. Examples by topic: meal suggestion → ['📝 Log this meal' (type=log, logType=Food), '🥗 Other options' (ask), '🔢 Show macros' (ask)]; BP/sugar answer → ['📝 Log new reading' (log, BP/Sugar), '📈 Show trend' (ask), '😮‍💨 I feel off' (ask)]; exercise plan → ['🏃 Log today's workout' (log, Exercise), '🧘 Easier version' (ask), '⏰ Best time to exercise' (ask)]; lab value answer → ['📈 Show history' (ask), '📝 Log new value' (log, Lab), '❓ What does this mean' (ask)]. Keep labels short (≤ 28 chars), prefer the patient's voice ("Show my…", "Log…", "Other ideas"), don't repeat what's already in the message body, and DO NOT recycle the same 3 chips every turn — they must match the current topic.
- 2-4 sentences in \`message\` (more only if user asked for detail). First name when known. The chat bubble renders light markdown.
- FORMAT BY SHAPE OF DATA — pick the right one, don't default to prose:
  • TABLE for 2+ rows that share the same columns: medicine-log history (date | medicine | slot), lab trends (test | value | date | flag), vitals over days (date | BP | sugar | weight), dose schedule (slot | medicine | dose). Use GitHub-flavored markdown: header row, \`|---|---|\` separator, one row per record. Keep ≤ 4 columns and ≤ 10 rows; if longer, summarise and offer to show more.
  • BULLET LIST (\`- \`) for items that don't share columns: a 5-day exercise plan, a meal's macros, top 3 takeaways, a list of conditions, do/don't pairs.
  • PROSE (2-4 sentences) for single-fact answers, conversational replies, explanations, advice.
- Use \`**bold**\` for key numbers/labels inside any of the above. \`*italic*\` sparingly for soft emphasis. NEVER use markdown headers (\`#\`, \`##\`), links, images, blockquotes, or code fences. One blank line separates paragraphs / between a sentence and the table or list that follows.
- NEWLINES: use REAL line breaks inside the \`message\` string. Do NOT type the two characters backslash-n ("\\n") as a substitute — that renders as literal "\\n" in the chat bubble and breaks table/list parsing. The Anthropic API encodes real newlines correctly on the wire; just press enter in your output.
- DON'T STRETCH. Answer and stop. No "let me know if…", no trailing questions, no recaps, no extras they didn't ask for. One topic per reply. If data exists, answer; if not, say so in one sentence.
- ABSOLUTE TOPIC ISOLATION. If the patient asked about X, your message mentions ONLY X. Do NOT mention earlier turns' food, exercise, BP, sugar, weight, labs, breathing, stress, or anything else — even if it was 1 turn ago, even if it seems "nice to remind". Mixing topics is the #1 failure mode and is forbidden. Read your draft message once before emitting: if it references anything outside the latest user message's topic, rewrite it.
- NO STATUS PREAMBLES. NEVER open a reply with "Your current weight is X kg…" / "Your BP is …" / "Just to recap…" / "Here's where you stand…" unless the patient's LATEST message asked for that exact metric. The patient asked "snack ideas?" → start with snacks, NOT "Your current weight is 45.4 kg. For snack ideas…". The patient asked "which medicines did I log?" → start with the meds list, NOT "Your weight is 45.4 kg. Here are your meds…". Stitching a weight/BP/sugar/HbA1c line in front of an unrelated answer is forbidden — even one sentence. If you find yourself writing such a preamble, delete it and start with the actual answer.
- NO TRAILING UPSELLS. NEVER end with "For snack ideas, tell me…" / "For progress, just ask…" / "Fire away with…" / "let me know which slot…" when those topics weren't part of the current question. The reply ends after the answer.
- ACKNOWLEDGMENTS ("ok", "okk", "thanks", "great", "got it", "👍", "hmm", "ok thanks", filler "yes/no") → ONE short friendly sentence ("Anytime — ping me if you need anything else."). Do NOT re-state numbers, re-explain BP/sugar/labs, call DB tools, or propose logs. intent='chat', numbers=[], no log_proposal.
- Mention the current time only when load-bearing (next-dose timing, meal slot, "in ~X min"). Patient age in profile is server-computed; trust it.`;

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

  // Hard guard for pure acknowledgments. The model has repeatedly ignored
  // the prompt rule and re-explained vitals when the patient typed "ok" /
  // "okk great" / "thanks". Short-circuit those turns server-side so they
  // never reach Anthropic. Matches messages that are only acknowledgment
  // tokens (with optional punctuation/emoji). If the patient also wrote a
  // question — anything with "?", or a longer message — this falls through.
  const ACK_PATTERN =
    /^(?:ok(?:ay|k+)?|k|kk|thanks?|thx|ty|tysm|thank\s*you|great|cool|nice|got\s*it|alright|sure|yep|yup|yeah|yes|hmm+|done|noted|👍|🙏|❤️|🙌|😊|😀)(?:[\s,.!👍🙏❤️🙌😊😀]*(?:ok(?:ay|k+)?|k|kk|thanks?|thx|ty|tysm|thank\s*you|great|cool|nice|got\s*it|alright|sure|yep|yup|yeah|yes|hmm+|done|noted|👍|🙏|❤️|🙌|😊|😀))*[\s.!👍🙏❤️🙌😊😀]*$/i;
  if (usingCheckpoint) {
    const trimmed = message.trim();
    if (
      trimmed.length > 0 &&
      trimmed.length <= 40 &&
      !trimmed.includes("?") &&
      ACK_PATTERN.test(trimmed)
    ) {
      const ackReplies = [
        "Anytime — ping me whenever you need.",
        "Glad to help. Let me know if anything else comes up.",
        "Sounds good — I'm here if you need anything.",
        "Got it. I'm here whenever you need me.",
      ];
      const ackText = ackReplies[Math.floor(Math.random() * ackReplies.length)];
      const convRow0 = await getOrCreateConversation(pool, pid, conversationId || null);
      const userBlock = { role: "user", content: trimmed };
      const assistantBlock = {
        role: "assistant",
        content: [{ type: "text", text: ackText }],
      };
      const convId = await persistTurnIfCheckpoint(pool, convRow0, userBlock, [assistantBlock]);
      return res.json({
        text: ackText,
        structured: {
          message: ackText,
          intent: "chat",
          numbers: [],
          log_proposal: null,
          safety_flag: "none",
        },
        client_actions: [],
        tool_log: [{ tool: "(ack_short_circuit)", input: { msg: trimmed }, ok: true }],
        conversationId: convId,
      });
    }
  }

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
      const hasPdf = conversation.some((m) =>
        (Array.isArray(m.content) ? m.content : []).some(
          (c) => c?.type === "document" && c?.source?.media_type === "application/pdf",
        ),
      );
      const agentHeaders = {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      };
      if (hasPdf) agentHeaders["anthropic-beta"] = "pdfs-2024-09-25";
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: agentHeaders,
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
        // Guard: respond_to_patient.log_proposal is the single source of
        // truth for which log card to open. The schema asks for a JSON
        // object, but the model sometimes mis-emits a string (e.g. a
        // JSON-encoded array). Normalise to a list of allowed types
        // before filtering. Drop any open_log_modal client_action whose
        // logType isn't in that list. If intent isn't 'log_proposed',
        // drop ALL open_log_modal actions.
        const normaliseLogProposal = (lp) => {
          if (!lp) return [];
          if (typeof lp === "string") {
            try {
              return normaliseLogProposal(JSON.parse(lp));
            } catch (_) {
              return [];
            }
          }
          if (Array.isArray(lp)) return lp.flatMap(normaliseLogProposal);
          if (typeof lp === "object" && lp.type) return [lp];
          return [];
        };
        const allowedLogTypes =
          structured.intent === "log_proposed"
            ? new Set(normaliseLogProposal(structured.log_proposal).map((x) => x.type))
            : new Set();
        // Repair the structured payload so the client sees a clean object
        // (or null) instead of the stringified array the model emitted.
        const normalised = normaliseLogProposal(structured.log_proposal);
        structured.log_proposal = normalised[0] || null;
        const cleanedActions = clientActions.filter((ca) => {
          if (ca?.type !== "open_log_modal") return true;
          if (allowedLogTypes.size === 0) return false;
          return allowedLogTypes.has(ca.logType);
        });
        const droppedCount = clientActions.length - cleanedActions.length;
        if (droppedCount > 0) {
          toolLog.push({
            tool: "(stale_propose_log_dropped)",
            input: { count: droppedCount, kept: Array.from(allowedLogTypes) },
            ok: true,
          });
        }
        const convId = await persistTurnIfCheckpoint(
          pool,
          convRow,
          latestUserBlock,
          turnBlocksToPersist,
        );
        return res.json({
          text: structured.message,
          structured,
          client_actions: cleanedActions,
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
            // create_health_log writes directly to the DB; emit a side-channel
            // log_saved client action so the RN app refreshes its local data
            // store without the patient needing a modal save flow.
            if (tu.name === "create_health_log" && result?.ok === true) {
              clientActions.push({
                type: "log_saved",
                logType: tu.input?.type || "unknown",
                date: tu.input?.date || null,
              });
            }
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

// ─── POST /api/ai/bulk-log ───────────────────────────────────────────
// Persists the rows the patient ticked in the multi-log sheet. Optionally
// links them to a previously-uploaded `documents` row via `document_id` so
// the file appears under Records.
//
// Body: {
//   scribePatientId: number,
//   document_id?: number,
//   kind: 'food' | 'lab_report' | 'prescription',
//   items: Array<row>     // row shape varies by kind — see below
// }
router.post("/ai/bulk-log", async (req, res) => {
  const { scribePatientId, document_id, kind, items, log_date } = req.body || {};
  const pid = Number(scribePatientId);
  if (!Number.isInteger(pid) || pid <= 0)
    return res.status(400).json({ error: "scribePatientId is required" });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "items[] is required" });
  if (!["food", "lab_report", "prescription"].includes(kind))
    return res.status(400).json({ error: "kind must be food | lab_report | prescription" });

  const docId = Number.isInteger(document_id) && document_id > 0 ? document_id : null;
  const today = new Date().toISOString().slice(0, 10);
  // log_date is an optional ISO YYYY-MM-DD from the MultiLogSheet date strip.
  // Validated strictly so arbitrary strings never reach SQL date params.
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const logDate = typeof log_date === "string" && ISO_DATE_RE.test(log_date) ? log_date : today;
  let written = 0;
  const errors = [];

  try {
    if (kind === "lab_report") {
      // items: { test_name, canonical_name?, result, unit?, ref_range?, flag?, panel_name?, test_date? }
      for (const r of items) {
        if (!r?.test_name || r.result === undefined || r.result === null || r.result === "")
          continue;
        const numeric = Number(String(r.result).replace(/[^\d.\-]/g, ""));
        const numericVal = Number.isFinite(numeric) ? numeric : null;
        const canonical = (r.canonical_name || r.test_name || "")
          .toString()
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "_");
        const testDate = r.test_date || logDate || today;
        try {
          await pool.query(
            `INSERT INTO lab_results
               (patient_id, test_date, test_name, canonical_name, result, result_text, unit, ref_range, flag, panel_name, source, document_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual', $11)`,
            [
              pid,
              testDate,
              String(r.test_name).slice(0, 200),
              canonical.slice(0, 100),
              numericVal,
              String(r.result).slice(0, 200),
              r.unit ? String(r.unit).slice(0, 50) : null,
              r.ref_range ? String(r.ref_range).slice(0, 100) : null,
              r.flag ? String(r.flag).slice(0, 20) : null,
              r.panel_name ? String(r.panel_name).slice(0, 100) : null,
              docId,
            ],
          );
          written++;
        } catch (e) {
          errors.push({ row: r.test_name, error: e.message });
        }
      }
    } else if (kind === "prescription") {
      // items: { name, dose?, frequency?, timing?, route?, for_diagnosis? }
      for (const r of items) {
        if (!r?.name) continue;
        try {
          const { name: cleanName, form: detectedForm } = stripFormPrefix(r.name);
          const storedName = cleanName || r.name;
          await pool.query(
            `INSERT INTO medications
               (patient_id, document_id, name, pharmacy_match, dose, frequency, timing, route, form, is_new, is_active, source, started_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $10, false, true, 'patient_upload', $9)
             ON CONFLICT DO NOTHING`,
            [
              pid,
              docId,
              storedName.slice(0, 200),
              storedName.toUpperCase().slice(0, 200),
              r.dose ? String(r.dose).slice(0, 100) : null,
              r.frequency ? String(r.frequency).slice(0, 100) : null,
              r.timing ? String(r.timing).slice(0, 100) : null,
              r.route ? String(r.route).slice(0, 50) : "Oral",
              logDate,
              detectedForm || null,
            ],
          );
          written++;
        } catch (e) {
          errors.push({ row: r.name, error: e.message });
        }
      }
    } else {
      // food: { name (description), kcal?, protein_g?, carbs_g?, fat_g?, meal_type? }
      for (const r of items) {
        if (!r?.name) continue;
        const hour = new Date().getHours();
        const defaultMeal =
          hour < 11 ? "breakfast" : hour < 15 ? "lunch" : hour < 18 ? "snack" : "dinner";
        try {
          await pool.query(
            `INSERT INTO patient_meal_log
               (patient_id, meal_type, description, calories, protein_g, carbs_g, fat_g, log_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              pid,
              String(r.meal_type || defaultMeal).slice(0, 30),
              String(r.name).slice(0, 200),
              r.kcal != null ? Number(r.kcal) : null,
              r.protein_g != null ? Number(r.protein_g) : null,
              r.carbs_g != null ? Number(r.carbs_g) : null,
              r.fat_g != null ? Number(r.fat_g) : null,
              logDate,
            ],
          );
          written++;
        } catch (e) {
          errors.push({ row: r.name, error: e.message });
        }
      }
    }

    return res.json({ ok: true, written, errors });
  } catch (err) {
    console.error("AI bulk-log error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
