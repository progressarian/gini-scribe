# GHM AI Assistant — Implementation Plan

Status: **proposed**, not built. Written 2026-08-18.

Adds a conversational assistant to `/ghm` (`src/pages/GHMPage.jsx`) that lets the
reception / OBT desk read and write appointment data by typing or speaking, instead of
hunting for a row and clicking through inline dropdowns.

Read `docs/APPOINTMENT_FLOW.md` first for what the GHM sheet is and who works it.

---

## 1. Goal & non-goals

**Goal.** A coordinator can say _"Priya Sharma didn't pick up, will try again tomorrow"_
and get a pre-filled, reviewable change to the right appointment row — call status, call
date, caller, notes, and a `call_attempts` entry — applied with one click.

**In scope**

- Natural-language read: "who hasn't been called for tomorrow?", "show me Dr Gupta's Thursday".
- Natural-language write: call outcomes, show/no-show, reschedules, notes, new bookings.
- Voice input in the same composer (Hindi/English), reusing the existing transcription path.
- Every write goes through a **confirmation card** before it touches the DB.

**Explicitly out of scope for v1**

- Auto-applying writes without confirmation.
- Anything outside the `appointments` / `call_attempts` domain (no labs, no prescriptions,
  no medication changes — those have their own owners and their own risk profile).
- Sending WhatsApp/SMS from the assistant. It may _draft_; a human sends.
- Bulk writes above a hard row cap (see §7).

---

## 2. Architecture decisions

### 2.1 A new endpoint, not `/api/ai/agent`

`server/routes/ai.js:446` already runs a full Anthropic tool-calling loop, and it is
tempting to add GHM tools to it. Don't. That route is structurally patient-bound:

- it 400s without a valid `scribePatientId` (`ai.js:466`);
- `AGENT_SYSTEM_PROMPT` is a patient-facing health-coach persona;
- `sqlGuard.js` whitelists only patient-scoped tables and _requires_ `patient_id = $1` on
  every query — exactly the wrong shape for "all of tomorrow's appointments";
- it force-funnels every turn through `respond_to_patient` (`FINAL_TOOL_NAME`).

Bolting a second persona on means two prompts, two tool sets and two auth models inside
one 900-line handler. A sibling route with the same _shape_ is cheaper to build and much
cheaper to reason about.

**Decision:** new `POST /api/ghm-agent/chat`, modelled on `/api/ai/agent` but staff-scoped.

### 2.2 Tools call the service layer, never raw SQL

`POST /api/ghm-appointments` (`ghm-appointments.js:535`) does far more than an INSERT:

1. resolves the patient by `file_no` → `phone`, and **registers a new patient** with an
   auto-generated `GNI-xxxxx` file_no if neither matches;
2. runs the availability gate (`checkBookingAvailability`) which can 409 with
   `doctor_unavailable`;
3. derives `reporting_time_slot` from `REPORTING_MAP`;
4. builds `whatsapp_message` + `additional_whatsapp_msg`;
5. increments `appointment_slots.booked_count`.

`POST /api/call-attempts` (`ghm-appointments.js:104`) similarly computes `attempt_no`
inside a transaction and mirrors the latest attempt onto the appointment summary columns.

An agent writing SQL directly skips all of it and silently corrupts slot counts and
attempt numbering. **Decision:** extract this logic into `server/services/ghm/` and have
both the HTTP route and the agent tools call the same functions. This refactor is a
prerequisite, not an optional cleanup.

### 2.3 Propose → confirm → apply

The patient agent already has this split: `propose_log` opens a pre-filled card and only
`create_health_log` writes (`services/agent/tools.js:169` / `:283`). GHM needs it _more_,
because:

- a wrong match hits **someone else's** row — "Sharma" is not unique;
- the rows belong to a colleague's worklist, so a bad edit is invisible to the person who
  caused it;
- `DATABASE_URL` in `.env` points at **production**.

**Decision:** GHM write tools are all `propose_*`. They return a structured patch; the
page renders a diff card; the existing `patch()` / `POST /api/call-attempts` fire only on
user confirm. No server-side write happens inside the agent loop in v1.

This also keeps the page's optimistic-update path (`GHMPage.jsx:1147`) as the single
writer, so the table refreshes correctly with no new state-sync code.

### 2.4 Visible rows are passed as context

`GHMPage.jsx` already holds the current result set in `rows`. Sending a compact
projection of the _visible_ rows with each message means:

- "mark the third one as not picked" and "Priya didn't come" resolve with no extra query;
- the model is constrained to rows the user can actually see, which is a cheap and
  effective scoping guard on top of RBAC.

### 2.5 RBAC is enforced per tool, server-side

`/ghm` is reachable by **two** roles — `["/ghm"]: [CAP.RECEPTION_OPS, CAP.OBT_OPS]`
(`src/config/routes.js:94`, mirrored at `server/middleware/auth.js:161`) — and the
Reassign tab is deliberately `RECEPTION_OPS`-only (`GHMPage.jsx:43`). An OBT caller must
not be able to say "move her to Dr Verma" and have it work.

Prompt instructions are not an access-control mechanism. **Decision:** a tool→capability
map filters `GHM_AGENT_TOOLS` per request _before_ they are sent to Anthropic, and
`executeTool` re-checks. A tool the caller lacks is never offered and never runs.

`req.doctor` carries `{doctor_id, doctor_name, short_name, specialty, role, jti}`
(`server/routes/auth.js:79`), so both the capability check and write attribution come
from the token — never from the request body.

---

## 3. Phases

| Phase | Deliverable                                                                                                 | Risk                                             |
| ----- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **0** | Extract `server/services/ghm/appointments.js` from the route handlers; routes call it. No behaviour change. | Low — pure refactor, verify with the existing UI |
| **1** | Agent endpoint + **read-only** tools. Chat panel renders answers, no writes exist yet.                      | Low — nothing can be damaged                     |
| **2** | `propose_*` write tools + confirmation card. Single-row only.                                               | Medium — the real work                           |
| **3** | Voice input via `AudioInput`.                                                                               | Low                                              |
| **4** | Bulk proposals (capped), audit-log widening, conversation persistence.                                      | Medium                                           |

Ship 0–1 and use it for a few days before starting 2. The read-only phase is where you
find out whether the model actually resolves names and dates the way the desk expects,
and it costs nothing to be wrong.

---

## 4. Backend, file by file

### 4.1 `server/services/ghm/appointments.js` — NEW (phase 0)

Extract, verbatim, from `routes/ghm-appointments.js`:

```
createAppointment(input, { actor })      // from the POST handler, ghm-appointments.js:535
updateAppointment(id, patch, { actor })  // from the PATCH handler, :704
logCallAttempt(input, { actor })         // from the call-attempts POST, :104
listAppointments(query)                  // from the GET handler, :309
```

- Keep the `PATCH_ALLOWED` field allowlist (currently inline at `:706`) here as an
  exported constant — the agent tool schema will be generated from it so the two cannot
  drift.
- Keep the `TRACK` change-log map (`:757`) here too.
- `actor` is `req.doctor`. The route passes it; the agent passes it. Used for
  attribution (§4.5).
- Routes become thin wrappers. **No behaviour change in phase 0** — this is the checkpoint
  to verify before anything AI touches it.

### 4.2 `server/services/ghmAgent/tools.js` — NEW

Tool definitions + `executeTool`. Read tools hit `services/ghm/`; propose tools are pure —
they validate, resolve, and return a patch **without writing**.

**Read tools**

| Tool                      | Input                                                     | Returns                                                                                     |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `find_appointment`        | `query` (name/file_no/phone), `date_hint?`                | up to 5 candidate rows with id, name, file_no, doctor, date, slot, current call/show status |
| `list_appointments`       | `date`, `doctor?`, `filter?` (`uncalled`/`no_show`/`all`) | compact rows + count                                                                        |
| `get_appointment_detail`  | `appointment_id`                                          | full row + call attempts + change log                                                       |
| `check_slot_availability` | `doctor`, `date`                                          | slots with capacity, via `services/availability.js`                                         |

**Propose tools** (no writes)

| Tool                         | Input                                                                                                      | Returns                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `propose_update_appointment` | `appointment_id`, `changes` (object keyed by `PATCH_ALLOWED`)                                              | `{appointment_id, before:{}, after:{}, summary}`                                                 |
| `propose_log_call`           | `appointment_id`, `outcome` (enum from `ATTEMPT_OUTCOMES`, `GHMPage.jsx:69`), `notes?`, `reschedule_date?` | proposal incl. the mirrored appointment columns the endpoint will also set                       |
| `propose_book_appointment`   | patient + doctor + date + slot + visit_type                                                                | proposal, **plus** a dry-run availability check so a clash is reported as a clash, not attempted |

**Terminal tool:** `respond_to_user` — mirrors `respond_to_patient`. Fields:
`message`, `intent` (`answer` \| `proposal` \| `clarify`), `proposals[]`.

Notes:

- `propose_update_appointment` must **echo `before`**, read fresh from the DB. The card
  shows a real diff, and a stale `before` at confirm time is how you detect that someone
  else edited the row while the assistant was thinking.
- Enums (`CALL_STATUSES`, `SHOW_STATUSES`, `VISIT_TYPES`, `ATTEMPT_OUTCOMES`) currently
  live in `GHMPage.jsx:47–100`. Move them to `shared/ghmEnums.js` so the page, the tool
  schemas and the validator share one definition.
- Dates: every relative expression ("tomorrow", "Thursday", "next week") resolves against
  a server-supplied `today`, injected into the system prompt. Resolved absolute dates
  **must** appear on the confirmation card. DATE columns are parsed as strings on purpose
  (`server/config/db.js`) — keep everything as `YYYY-MM-DD` strings end to end and never
  round-trip through a JS `Date`.

### 4.3 `server/services/ghmAgent/prompt.js` — NEW

System prompt. Must state:

- Role: assistant to the GHM appointment desk. Not clinical. Never gives medical advice —
  deflect to the doctor.
- Today's date, the logged-in user's name and role, and the tools they are allowed.
- The visible-row context block and that it is the preferred way to resolve a reference.
- **Ambiguity rule:** if `find_appointment` returns more than one candidate, call
  `respond_to_user` with `intent:"clarify"` and list them. Never guess between two patients.
- **No silent writes:** every change is a proposal. Never claim something is saved.
- Language: match the user (Hindi/Hinglish/English), same as the existing agent's
  LANGUAGE RULE.

Keep it a module-level constant so the Anthropic prompt cache works — `/api/ai/agent`
already relies on byte-identical `system` + `tools` across requests (`ai.js:610`). Copy
that `cache_control` breakpoint.

### 4.4 `server/services/ghmAgent/permissions.js` — NEW

```
TOOL_CAPABILITIES = {
  find_appointment:          [RECEPTION_OPS, OBT_OPS],
  list_appointments:         [RECEPTION_OPS, OBT_OPS],
  get_appointment_detail:    [RECEPTION_OPS, OBT_OPS],
  check_slot_availability:   [RECEPTION_OPS],
  propose_log_call:          [RECEPTION_OPS, OBT_OPS],
  propose_update_appointment:[RECEPTION_OPS, OBT_OPS],  // field-level gate below
  propose_book_appointment:  [RECEPTION_OPS],
}

FIELD_CAPABILITIES = {
  doctor_name:      [RECEPTION_OPS],   // reassignment is scheduling-desk work
  preferred_doctor: [RECEPTION_OPS],
  appointment_date: [RECEPTION_OPS],
  time_slot:        [RECEPTION_OPS],
  // everything else in PATCH_ALLOWED: [RECEPTION_OPS, OBT_OPS]
}
```

Both filters run before the Anthropic call (shrink the tool list, and strip forbidden keys
from the schema) **and** inside `executeTool`. Use `hasAnyCapability` from
`shared/permissions.js` — do not hand-roll role checks.

⚠️ `GRANT_ALL_CAPABILITIES` is `false`; RBAC is live. A missing mapping here fails _open_
at the route level (`capabilityForPath` returns null → allowed), so the route prefix must
be registered in the same change (§4.6).

### 4.5 `server/migrations/2026-08-XX_ghm_agent.sql` — NEW

```sql
CREATE TABLE IF NOT EXISTS ghm_agent_conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id       INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE appointment_change_log
  ADD COLUMN IF NOT EXISTS changed_by TEXT,
  ADD COLUMN IF NOT EXISTS source     TEXT NOT NULL DEFAULT 'ui';
```

⚠️ **Schema drift:** `appointment_change_log` is used by four queries in
`ghm-appointments.js` but appears in **neither `server/schema.sql` nor any migration** —
it was created directly against production. Dump its real definition before writing this
migration, and add the `CREATE TABLE` to `schema.sql` while you're there.

`source` values: `'ui'` (default, existing behaviour) and `'ghm_agent'`. This is the
audit trail you will want the first time an edit is disputed. `changed_by` comes from
`req.doctor.short_name || req.doctor.doctor_name`.

Also widen the `TRACK` map (`ghm-appointments.js:757`) from its current 4 fields
(`doctor_name`, `preferred_doctor`, `preferred_date`, `call_made_by`) to all of
`PATCH_ALLOWED`, at least for agent-sourced writes. If the assistant can edit 30 fields,
logging 4 of them is not an audit trail.

Run with `node migrations/_runOne.mjs migrations/2026-08-XX_ghm_agent.sql` from `server/`.

### 4.6 `server/routes/ghmAgent.js` — NEW

`POST /api/ghm-agent/chat`

Body: `{ message, conversationId?, context: { view, date, doctor, visibleRows[] }, model? }`

Loop structure copied from `ai.js:446`:

- max 5 turns;
- `system` as a single cached text block, `tools` from the filtered set;
- terminal tool `respond_to_user` ends the turn;
- persist to `ghm_agent_conversations` (a near-copy of `services/agent/conversations.js`,
  keyed on `doctor_id` instead of `patient_id` — consider generalising that module rather
  than forking it);
- strip HTML from Anthropic error bodies before returning, as `ai.js:625` does.

Cap `visibleRows` server-side (~60 rows, name/id/status only) so a "Load More"-heavy page
can't blow up the prompt.

**Model:** default `claude-haiku-4-5-20251001`, same as the existing agent. Haiku is fine
for slot-filling against a fixed schema. Keep the `model: "sonnet"` escape hatch — note
that `ai.js:523` maps `"sonnet"` to `claude-sonnet-4-6`; if you want a current model,
update that mapping deliberately rather than copying it. Log `usage` per turn as
`ai.js:598` does — this is a per-message cost on a page the desk uses all day.

### 4.7 `server/index.js` + `server/middleware/auth.js` — EDIT

- `index.js`: `app.use("/api", ghmAgentRoutes);` next to the GHM mount (`index.js:153`).
- `auth.js`: add `["/api/ghm-agent", [CAP.RECEPTION_OPS, CAP.OBT_OPS]]` beside the
  existing `/api/ghm-appointments` entry (`auth.js:161`). Without this the route is open
  to every logged-in role.
- Do **not** add it to `PUBLIC_PATHS` / `PUBLIC_PREFIXES`.

---

## 5. Frontend, file by file

### 5.1 `src/components/ghm/GhmAssistant.jsx` + `.css` — NEW

Right-hand slide-over panel on `/ghm`. Message list, composer, mic button, proposal cards.

- Use `src/services/api.js` (the shared axios instance), **not** the page's local `fetch`
  wrapper at `GHMPage.jsx:10`. That wrapper predates the shared client and doesn't handle
  401 redirects.
- Keep the panel's own state local; the only thing it hands back to the page is a
  confirmed proposal.

### 5.2 `src/components/ghm/ProposalCard.jsx` + `.css` — NEW

Renders one proposal as a field-by-field diff with **Apply** / **Dismiss**:

```
Priya Sharma · GNI-01847 · Wed, 4 Jun 11:00 AM · Dr Gupta
  Call Status   Not Called Yet  →  📵 Not Picked Up
  Call Date     —               →  18 Aug 2026
  Called By     —               →  Nikhil
  Call Notes    —               →  "Will retry tomorrow"
  + call attempt #3 logged
                                        [ Apply ]  [ Dismiss ]
```

- Show the resolved absolute date, never "tomorrow".
- Re-verify `before` against the current row at Apply time; if it drifted, show
  "this row changed since — review again" instead of applying.
- Disable Apply while the row is `saving` (the page already tracks this,
  `GHMPage.jsx:1148`).

### 5.3 `src/hooks/useGhmAssistant.js` — NEW

Owns the conversation: `sendMessage`, `messages`, `pendingProposals`, `conversationId`,
`isLoading`. Builds the `context` payload from the page's current `view` / `date` /
`doctor` / `visible`.

### 5.4 `src/pages/GHMPage.jsx` — EDIT (small)

Three changes only:

1. Mount `<GhmAssistant />` next to the `ghm__tabs` block (~`:1265`), behind a toggle
   button in the header controls row.
2. Pass down `{ view, date, doctor, rows: visible }` for context, plus `loggedInName`
   (`:1011`) so proposals attribute correctly.
3. Pass an `applyProposal` callback that reuses the existing `patch()` (`:1147`) and the
   call-attempt POST (`:620`) — **do not** add a second write path.

Gate the toggle with `hasAnyCapability` (already imported at `:5`).

### 5.5 Voice — reuse, don't build

`src/components/AudioInput.jsx` already does mic capture, live Deepgram streaming,
Whisper fallback, language toggle and transcript cleanup, all through
`src/services/transcription.js` → `/api/ai/transcribe`. Mount it `compact` in the
composer and wire `onTranscript` to the input value. No backend work.

### 5.6 `shared/ghmEnums.js` — NEW

Move `CALL_STATUSES`, `SHOW_STATUSES`, `RECOVERY_STATUSES`, `ATTEMPT_OUTCOMES`,
`VISIT_TYPES` out of `GHMPage.jsx:47–100`. Imported by the page, the tool schemas and the
server-side validator. Follows the `shared/permissions.js` precedent.

---

## 6. Worked example

Coordinator (voice): _"Priya Sharma didn't pick up, will try again tomorrow"_

1. `AudioInput` → `/api/ai/transcribe` → text.
2. `POST /api/ghm-agent/chat` with the message + 40 visible rows + `view:"tomorrow"`.
3. Model calls `find_appointment("Priya Sharma")` → 1 match, id 4821.
4. Model calls `propose_log_call` → `{outcome:"not_picked", notes:"Will retry tomorrow", reschedule_date:"2026-08-19"}`
   and `propose_update_appointment` → `{call_date:"2026-08-18", call_made_by:"Nikhil"}`.
5. Model calls `respond_to_user` → _"Priya Sharma — logging attempt #3 as not picked up, retry tomorrow. Confirm?"_
6. Card renders → Apply → `POST /api/call-attempts` then `PATCH /api/ghm-appointments/4821`
   → rows refresh.

Two candidates named Sharma? Step 4 becomes `intent:"clarify"` with both rows listed, and
nothing is proposed until the user picks.

---

## 7. Guardrails

| Risk                                     | Mitigation                                                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong patient matched                    | Propose-only + mandatory clarify on >1 candidate + visible-row scoping                                                                               |
| Production DB                            | Phase 1 is read-only. Add a `GHM_AGENT_DRY_RUN=1` env flag that makes Apply log the intended write instead of running it, for the first week         |
| Relative-date drift                      | Server-supplied `today`; resolved `YYYY-MM-DD` on the card; strings end to end                                                                       |
| Bulk damage                              | Hard cap of 10 rows per proposal batch; each row confirmed individually; no "select all"                                                             |
| OBT exceeding scope                      | Tool + field capability filters, enforced twice (§4.4)                                                                                               |
| Slot-count corruption                    | All writes go through `services/ghm/` (§2.2), never raw SQL                                                                                          |
| Concurrent edits                         | `before` snapshot re-verified at Apply time                                                                                                          |
| Cost                                     | Haiku by default; cached system+tools prefix; `visibleRows` capped; usage logged per turn                                                            |
| Prompt injection via patient names/notes | Row context is data, not instruction — state this in the prompt, and never let a tool result decide which tool runs next without a confirmation step |

---

## 8. Verification

There is no test suite and no linter, so verification is manual plus scripts.

- **Phase 0:** exercise `/ghm` by hand — book, patch, log a call, delete an attempt.
  Confirm `appointment_slots.booked_count` and `call_attempts.attempt_no` still behave.
- **New:** `server/scripts/verify-ghm-agent-tools.mjs` — read-only. Drives each read tool
  and each `propose_*` (which write nothing by construction) against real data, asserting
  shapes. Safe against production; run it before every deploy.
- **RBAC:** extend `server/scripts/verify-rbac.mjs` to assert `/api/ghm-agent` is mapped,
  and add a case asserting an `OBT_OPS` role is denied `propose_book_appointment` and the
  `doctor_name` field.
- `npm run format` before committing.

---

## 9. Open questions

1. **Auto-apply for unambiguous single-row call outcomes?** The desk will ask for it once
   the confirmation step feels like friction. Revisit after two weeks of real use, not before.
2. **Should the assistant draft WhatsApp messages?** `buildWhatsappMessage` already exists
   and `GET /api/ghm-appointments/whatsapp-preview` (`:867`) is there. Drafting is low risk;
   sending is not. Recommend draft-only if added.
3. **Conversation retention.** `agent_conversations` has checkpoint/summary rotation.
   The GHM desk probably wants a short-lived thread (per day?) rather than an
   indefinitely growing one — decide before phase 4.
4. **Generalise or fork `services/agent/conversations.js`?** Forking is faster; generalising
   to `(ownerType, ownerId)` avoids two copies of the checkpoint logic. Lean generalise.
