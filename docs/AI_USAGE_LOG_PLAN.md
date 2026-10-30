# AI usage log

Status: plan, 2026-10-30. Not built.

## 1. Why

Scribe calls the Anthropic API from about 15 places (Sonnet 4.6 and Haiku 4.5), with
one API key. Nothing records which feature spends what. Token counts reach the server
log from only three places (HealthRay note parser, scanned-Rx reader, Dr. Gini agent),
and those lines are lost on restart. The Anthropic Console shows the total per model,
not per feature.

Goal: an admin can see, for a date range, **calls, tokens and estimated cost per
feature and model**, plus failures, without reading logs.

## 2. Features to tag

| Feature key | What | Model | Code |
|---|---|---|---|
| `healthray_notes` | HealthRay clinical notes → structured Rx (inline) | Haiku | `services/healthray/parser.js` `parsePrescriptionWithAi` |
| `healthray_notes_batch` | Same, via the Batches API (50% price) | Haiku | `services/batch/batchQueue.js` `applyOne` |
| `scanned_rx` | Scanned prescription PDF/image | Sonnet | `services/healthray/prescriptionExtractor.js` |
| `doc_classify` | HealthRay document → tab | Haiku | `services/documentClassifier.js` |
| `scanned_bill` | Scanned bill PDF | Haiku | `services/healthray/billingExtractor.js` |
| `patient_summary` | Patient summary (auto on Rx save + button) | Sonnet | `services/patientSummaryAI.js` |
| `visit_summary` | Visit summary button | Sonnet | `services/visitSummaryAI.js` |
| `post_visit_summary` | Post-visit summary | Sonnet | `routes/postVisitSummary.js` |
| `clinical_summary` | Summary route | Sonnet | `routes/summary.js` |
| `consult_extract` | Voice transcript / document → structured data | Sonnet | `services/extraction.js` |
| `referral_letter` | Referral letter | Sonnet | `routes/visit.js` (`/visit/:patientId/referral`) |
| `side_effects` | Common side effects of a medicine | Sonnet | `services/medication/commonSideEffectsAI.js` |
| `ai_complete` | Generic helper used by screens | Haiku / Sonnet | `routes/ai.js` `/ai/complete` |
| `gini_agent` | Dr. Gini chat agent (patient app), every loop turn | Haiku / Sonnet | `routes/ai.js` `/ai/agent` |
| `gini_agent_checkpoint` | Chat thread summarising | Haiku | `services/agent/conversations.js` |
| `flow_plan` | Gini Flow plan → steps | Haiku | `services/giniflow/planExtract.js` |
| `flow_rx_paste` | Gini Flow Rx paste | Haiku | `services/giniflow/rxPaste.js` |

Manual re-parse paths in `routes/sync.js` / `routes/extract.js` call
`parsePrescriptionWithAi`; they pass `feature: "healthray_notes_manual"` so a manual
backfill does not look like normal background load.

## 3. Design

### 3.1 One helper for every call

`server/services/ai/anthropic.js`:

- `callAnthropic(feature, body, { signal })` — the `fetch` to `/v1/messages` with the
  headers every file repeats today, returns the parsed JSON (same shape callers
  already use), and records usage from `data.usage`. Errors record a failed call
  (HTTP status only) and are thrown as today.
- `recordAiUsage(feature, model, usage, { batch, ok, ms })` — for the two files using
  the SDK (`parser.js`, `billingExtractor.js`) and for batch results.

Each call site changes only its `fetch(...)` line to `callAnthropic("<feature>", body)`.
Prompts, models, retries and parsing stay as they are. The three existing
`[... usage]` log lines are removed (the table replaces them).

Recording **never** blocks or fails the AI call: it only adds to an in-memory counter.

### 3.2 Storage: daily roll-up, flushed once a minute

Production has a small disk-I/O budget, and background parsing can run hundreds of
calls an hour, so one row per call is not written. Instead:

```sql
CREATE TABLE ai_usage_daily (
  day          date        NOT NULL,
  feature      text        NOT NULL,
  model        text        NOT NULL,
  batch        boolean     NOT NULL DEFAULT false,
  calls        integer     NOT NULL DEFAULT 0,
  failed       integer     NOT NULL DEFAULT 0,
  input_tokens bigint      NOT NULL DEFAULT 0,
  output_tokens bigint     NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens  bigint NOT NULL DEFAULT 0,
  total_ms     bigint      NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, feature, model, batch)
);
```

- API and worker each keep a counter map keyed by (IST day, feature, model, batch).
- Every 60 s, and on shutdown, each flushes with **one** statement:
  `INSERT … SELECT FROM jsonb_to_recordset($1) ON CONFLICT (…) DO UPDATE SET calls = ai_usage_daily.calls + EXCLUDED.calls, …`.
  A flush is a handful of rows, so one short write a minute per process.
- A crash loses at most the last minute's counts. Acceptable for a cost view.
- If the table is missing (local dev on prod before the migration), the flush logs
  once and drops the counts — no screen breaks (see "new table empties local
  screens").
- No patient data, no prompt text, no user ids. Size: ~20 features × 2 models × 365
  days ≈ 15k rows a year; no retention job needed.

### 3.3 Cost estimate

`shared/aiPricing.js` — price per million tokens per model (input, output, cache
write, cache read), batch = 50%. Today:

| Model | Input | Output | Cache write | Cache read |
|---|---|---|---|---|
| Sonnet 4.6 | $3 | $15 | $3.75 | $0.30 |
| Haiku 4.5 | $1 | $5 | $1.25 | $0.10 |

The page shows cost as **"Estimated"**; the Anthropic Console bill is the truth. An
unknown model shows tokens with cost "—", never a guessed price.

### 3.4 API

`GET /api/admin/ai-usage?from=YYYY-MM-DD&to=YYYY-MM-DD` (max 92 days), new capability
`AI_USAGE` in `shared/permissions.js`, granted to **admin** only. Returns:

- rows grouped by feature + model (+ batch): calls, failed, tokens, avg seconds,
  estimated cost;
- totals per day (for a small daily totals table);
- grand total.

### 3.5 Page

Settings → **AI usage** tab (next to Billing settings), shown only with `AI_USAGE`.

```
AI usage                                  [Today] [7 days] [30 days] [From – To]

Total  12,480 calls · 41.2M in / 3.1M out tokens · Est. $86.40     47 failed

Feature                  Model      Calls   Failed  Input    Output   Est. cost
HealthRay notes (batch)  Haiku 4.5  9,812   12      30.1M    2.2M     $26.55
Scanned prescriptions    Sonnet 4.6   640    3       6.0M    0.3M     $22.50
...
                                   sortable by any column, cost by default

By day   (date · calls · est. cost)
```

Loading skeleton, empty state ("No AI calls recorded in this range — logging started
on <date>"), error state with Try again. Desktop table; on phones the table scrolls
horizontally with Feature and Est. cost kept visible.

### 3.6 Batch path

`applyOne` already has `result.message.usage`; it calls
`recordAiUsage("healthray_notes_batch", model, usage, { batch: true })`. Failed batch
results count as `failed`.

## 4. Build order

1. Migration `ai_usage_daily` (you apply it on prod).
2. `services/ai/anthropic.js` + flush loop in API and worker; `shared/aiPricing.js`.
3. Move call sites to the helper in three small groups, each tested:
   a. background (parser, batch, scanned Rx, classifier, scanned bill),
   b. summaries/extraction/referral/side effects,
   c. `ai.js` agent/complete, conversations, Gini Flow plan/paste.
4. Endpoint + capability + Settings tab.

Nothing changes in what the AI is asked or returns.

## 5. Tests (e2e test DB; outbound network is blocked there)

- Helper: with `fetch` pointed at a stub, a call adds to the counter; a flush writes
  one roll-up row; a second flush adds to it (not duplicates); a failed call counts as
  failed; a missing table does not throw.
- Endpoint: seeded rows → grouped totals and estimated cost match `aiPricing`;
  non-admin gets 403; range over 92 days rejected.
- Page: admin sees the tab and table; reception does not see the tab; empty range
  shows the empty state.

## 6. Open questions

1. Daily roll-up only (this plan), or also one row per call for a short window?
2. Who sees it: admin only, or the named analytics admin only?
3. Cost in $ only, or $ and ₹ (with a fixed rate set in Settings)?
