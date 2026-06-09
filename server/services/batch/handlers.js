// ── Batch result handlers (job_type -> apply fn) ────────────────────────────
//
// Wires the generic batchQueue to domain apply-logic. Kept separate from
// batchQueue.js so the queue stays domain-agnostic and there is no import cycle
// (the domain modules import `enqueue` from batchQueue; batchQueue imports
// nothing domain-specific; this file imports both and is only imported by the
// cron that runs the queue).
//
// Each handler receives (context, message) where `message` is the Anthropic
// Messages API response object for that request, and `context` is the JSON we
// stored at enqueue time. A handler that throws marks the job 'failed' (it will
// be retried by the originating job on its next run).

import { applySideEffectsResult } from "../medication/commonSideEffectsAI.js";
import { applyOpdParse } from "../cron/healthraySync.js";
import { extractPrescriptionFromMessage } from "../healthray/parser.js";

export const BATCH_HANDLERS = {
  med_side_effects: async (context, message) => {
    await applySideEffectsResult(context, message);
  },
  healthray_parse: async (context, message) => {
    const parsed = extractPrescriptionFromMessage(message);
    if (!parsed) throw new Error("healthray_parse: unparseable / invalid batch result");
    await applyOpdParse(context, parsed);
  },
};
