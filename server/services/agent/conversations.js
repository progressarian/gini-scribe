// Dr. Gini AI conversation persistence + rolling-checkpoint summarisation.
//
// The patient app only sends the latest user message + a conversation_id.
// We hydrate the thread, run the agent loop in routes/ai.js, then persist
// the new user turn + assistant turn back. When the thread grows beyond
// LIVE_WINDOW turns, the oldest pairs get folded into `checkpoint_summary`
// (an LLM-written paragraph) so per-turn token cost stays bounded.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Keep the most-recent N message blocks live (a "turn" here = one
// role:user OR role:assistant entry; tool_result entries also count).
// Older blocks get summarised. 16 ≈ 8 back-and-forths.
const LIVE_WINDOW = 16;
// Re-summarise once at least this many *new* blocks have been pushed out
// since the last summary refresh.
const SUMMARISE_EVERY = 8;

// ── Load / create ─────────────────────────────────────────────────────
export async function getOrCreateConversation(pool, patientId, conversationId) {
  if (conversationId) {
    const { rows } = await pool.query(
      `SELECT id, messages, checkpoint_summary, summary_covers_n, total_turns
         FROM agent_conversations
        WHERE id = $1 AND patient_id = $2`,
      [conversationId, patientId],
    );
    if (rows[0]) return rows[0];
  }
  // Create a fresh thread.
  const { rows } = await pool.query(
    `INSERT INTO agent_conversations (patient_id, messages, last_message_at)
     VALUES ($1, '[]'::jsonb, NOW())
     RETURNING id, messages, checkpoint_summary, summary_covers_n, total_turns`,
    [patientId],
  );
  return rows[0];
}

// ── Persist the turn pair ─────────────────────────────────────────────
// `userMessage`  — Anthropic-shaped message (role:user) the patient just sent.
// `assistantTurns` — array of role:user (tool_result) + role:assistant
//                    blocks produced during the loop. Persist them all so
//                    the next turn can reference tool_use/tool_result ids.
export async function appendTurn(pool, conversation, userMessage, assistantTurns) {
  const existing = Array.isArray(conversation.messages) ? conversation.messages : [];
  const next = [...existing, userMessage, ...assistantTurns];

  // Trim to LIVE_WINDOW, but be careful not to break a tool_use ↔
  // tool_result pair. If the first surviving block is a user-role
  // tool_result, drop it too (the matching tool_use was just rotated
  // out, so Anthropic would reject the chain).
  let live = next;
  let droppedCount = 0;
  if (next.length > LIVE_WINDOW) {
    const cutFrom = next.length - LIVE_WINDOW;
    live = next.slice(cutFrom);
    droppedCount = cutFrom;
    while (live.length > 0 && isOrphanToolResult(live[0])) {
      live.shift();
      droppedCount += 1;
    }
  }

  const newTotal = (conversation.total_turns || 0) + 1; // one back-and-forth = one turn
  const needsSummary =
    droppedCount > 0 &&
    droppedCount + (conversation.summary_covers_n || 0) >=
      (conversation.summary_covers_n || 0) + SUMMARISE_EVERY;

  let nextSummary = conversation.checkpoint_summary || null;
  let nextSummaryCovers = conversation.summary_covers_n || 0;
  if (needsSummary) {
    const rotatedOut = next.slice(0, next.length - live.length);
    try {
      nextSummary = await refreshSummary(conversation.checkpoint_summary, rotatedOut);
      nextSummaryCovers = (conversation.summary_covers_n || 0) + rotatedOut.length;
    } catch (e) {
      // Summary failed — keep the old summary. We'd rather lose a bit of
      // long-term context than break the turn.
      console.warn("[agent] checkpoint summary refresh failed:", e?.message || e);
    }
  } else if (droppedCount > 0) {
    nextSummaryCovers = (conversation.summary_covers_n || 0) + droppedCount;
  }

  await pool.query(
    `UPDATE agent_conversations
        SET messages           = $2::jsonb,
            checkpoint_summary = $3,
            summary_covers_n   = $4,
            total_turns        = $5,
            last_message_at    = NOW()
      WHERE id = $1`,
    [
      conversation.id,
      JSON.stringify(live),
      nextSummary,
      nextSummaryCovers,
      newTotal,
    ],
  );

  return { messages: live, checkpoint_summary: nextSummary };
}

function isOrphanToolResult(block) {
  if (!block || block.role !== "user") return false;
  const content = Array.isArray(block.content) ? block.content : [];
  return content.length > 0 && content.every((c) => c?.type === "tool_result");
}

// ── Summarisation ─────────────────────────────────────────────────────
// Send the rotated-out blocks to Claude Haiku with a strict "compress
// into 4-6 bullets about what matters for future turns" prompt. The
// previous summary is fed in too so context accumulates instead of
// resetting.
async function refreshSummary(previousSummary, rotatedBlocks) {
  if (!ANTHROPIC_KEY) return previousSummary;

  const transcript = rotatedBlocks
    .map((b) => {
      if (typeof b?.content === "string") return `${b.role.toUpperCase()}: ${b.content}`;
      const text = (Array.isArray(b?.content) ? b.content : [])
        .map((c) => {
          if (c?.type === "text") return c.text;
          if (c?.type === "tool_use") return `[tool ${c.name}(${JSON.stringify(c.input)})]`;
          if (c?.type === "tool_result")
            return `[result: ${String(c.content || "").slice(0, 400)}]`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return text ? `${b.role.toUpperCase()}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 12_000);

  const system = `You are summarising a patient↔Dr.Gini-AI chat so the agent can keep context after older turns are rotated out. Output 4-6 short bullets covering ONLY what future turns might need: facts about the patient (preferences, conditions they raised, things they were told to do), explicit decisions, open follow-ups, and any logs the patient said they made. Do NOT recap pleasantries. Do NOT invent. Keep the whole summary under 800 characters.`;

  const userText =
    (previousSummary
      ? `Previous summary (still valid — merge with new info, drop anything contradicted):\n${previousSummary}\n\n`
      : "") +
    `Older turns that were just rotated out of the live window:\n${transcript}\n\nWrite the refreshed summary now.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!resp.ok) throw new Error(`summary http ${resp.status}`);
  const data = await resp.json();
  return ((data.content || []).map((c) => c.text || "").join("") || "").trim() || previousSummary;
}

// ── Build the per-turn Messages array for Anthropic ───────────────────
// Returns the array to pass to Anthropic. The checkpoint_summary is
// prepended as a single synthetic user→assistant pair so the model treats
// it as established context rather than a new instruction.
export function buildOutgoingMessages(conversation, latestUserBlock) {
  const live = Array.isArray(conversation.messages) ? conversation.messages : [];
  const prefix = [];
  if (conversation.checkpoint_summary) {
    prefix.push(
      {
        role: "user",
        content: `[Earlier conversation summary — established context]\n${conversation.checkpoint_summary}`,
      },
      {
        role: "assistant",
        content: "Got it — continuing from there.",
      },
    );
  }
  // The latest user block was already wrapped by the caller in Messages-API
  // shape ({role:'user', content:string|blocks}).
  return [...prefix, ...live, latestUserBlock];
}
