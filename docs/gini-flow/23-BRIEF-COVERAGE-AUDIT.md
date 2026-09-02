# 23 — Brief coverage audit — what is built, what is not, and what changed

**Date:** 2 Sep 2026
**Status:** current
**Brief:** `Gini-Flow-Developer-Brief.docx`, all sections
**Supersedes:** the gap list in this doc's first revision (three rows of which were wrong — see §5)

A section-by-section audit of the developer brief against the code, verified against the
running database rather than against the plan docs. Every "built" claim below was checked by
reading the table, the route or the component named beside it.

---

## 1. Verdict

All four phases are built: **11 screens, 88 API routes, 15 `giniflow_*` tables, 26 services.**

What remains is not missing screens. It is **one integration nobody started** (WhatsApp template
approval), **one dataset nobody loaded** (pharmacy inventory), **two deliberate architecture
deviations**, and the fact that **the floor still works in HealthRay**, so most of it has never
carried real traffic.

---

## 2. Where the brief and the build differ on purpose

### 2.1 Product boundary — deviation

| Brief                                       | Built                                                |
| ------------------------------------------- | ---------------------------------------------------- |
| `flow.ginihealth.com`, a peer app to Scribe | Routes under `/giniflow/*` **inside the Scribe SPA** |

Same bundle, same router, same header. §1.1's "reception, lab and pharmacy staff should not work
under Scribe branding" is unmet. The code is already modular (`src/pages/giniflow/`,
`server/routes/giniflow*.js`, `shared/giniflow*.js`), so this is a deployment split, not a rewrite.

### 2.2 Auth and roles — deviation

| Brief                                                                                                 | Built                                                             |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Supabase auth, role claim `flow_manager \| reception \| vitals \| mo_sd \| doctor \| lab \| pharmacy` | Scribe JWT + `doctors` table; 11 roles in `shared/permissions.js` |
| Login lands each role on their station                                                                | Lands on the Scribe dashboard; stations via `/giniflow/stations`  |

There is no `flow_manager` role — Flow Manager is the `GINIFLOW_MANAGE_QUEUE` capability held by
admin and coordinator. `mo_sd` is split into `mo` + `nurse`. RBAC is genuinely enforced
(`GRANT_ALL_CAPABILITIES = false`) across 11 `GINIFLOW_*` capabilities.

### 2.3 One medicines table, not two

The brief proposed `prescription_items` + `external_medicines`. The repo has one prescription
history — `medications` — and `2026-09-02_consultant_prescription.sql` records why: the refill
queue, the dose-review queue, the medicine card and the Genie sync all read it, and a second
history is the failure this module is structured to avoid. External medicines are `medications`
rows with `external_doctor` set. See §4.6 for how the brief's fields were satisfied without it.

### 2.4 WATI → MSG91

The brief names WATI. The repo has one WhatsApp vendor, one WABA and one approval queue: MSG91.
`16` §3.1 records the reasoning. MSG91 here has **no document/media path** — all three senders are
`content_type: "template"` — so the medicine card and the referral letter travel as links.

---

## 3. Status chain and triggers

`shared/giniflowStatus.js` carries all 14 chain statuses, all 3 exception states, all 7 lab-track
states and all 3 payment states. It adds `with_vitals`, which the brief omits: without it there is
no state meaning "on the chair having BP taken", so the 5-minute vitals budget would measure the
queue instead of the station.

| #   | Trigger (brief §2.3)                                      | State                              |
| --- | --------------------------------------------------------- | ---------------------------------- |
| 1   | Lab `uploaded` → `results_status='ready'`                 | ✅                                 |
| 2   | Tests ordered → `lab_order` `payment_pending` → Reception | ✅ `moStation.orderTests`          |
| 3   | Reception paid → sample task → Lab                        | ✅ `receptionStation.clearPayment` |
| 4   | Finalize fan-out                                          | ⚠️ partial — see below             |
| 5   | Pharmacy all-dispensed → `dispensed` → `exited`           | ✅                                 |
| 6   | SLA amber at 80%, red at 100%, bottleneck recompute       | ✅                                 |

**Trigger 4.** Built: prescription → finalized, `pharmacy_pending`, referral letters (after the
commit, deliberately — a Puppeteer render must not hold a row lock). Not built: **tests →
lab_orders does not happen at Finalize**; tests are ordered immediately from the Tests section
instead. The med-card → MHG leg is addressed in §4.5.

---

## 4. What was fixed on 2 Sep 2026

Nine migrations and a set of behaviour fixes. Each row names the file so it can be read back.

### 4.1 PDFs were being served as JSON

Puppeteer 24's `page.pdf()` returns a plain `Uint8Array`, and `res.send()` JSON-encodes it — so the
browser received `{"0":37,"1":80,…}` under `Content-Type: application/pdf` and reported _"Failed to
load PDF document"_. Fixed once in `services/prescriptionHtmlPdf.js`, which is the single renderer
behind all three PDFs. Also affected `POST /api/visit/prescription-pdf` and the medicine card.

### 4.2 `when_to_take` was unreadable, and the medicine card was empty

`medications.when_to_take` is `when_to_take_pill[]` — an array of a **user-defined enum**.
node-postgres ships parsers only for built-in OIDs, so it returned the raw literal
`'{"After dinner"}'`. Two consumers then failed differently: the pharmacy card printed the literal,
and `normalizeWhenToTake()` (which splits on commas) matched nothing and returned `null`, silently
dropping the timing.

Fixed at the connection layer — `config/db.js` looks up every enum-array OID from `pg_catalog` and
registers a `postgres-array` parser, with `pool.query` awaiting registration. Looked up, not
hard-coded: a user-defined type's OID differs per database.

That exposed the next one. **`timing_category` is null on all 124,625 active medications** — nothing
has ever written it — so every medicine fell to the `UNSLOTTED` bucket and the card's twelve slots
were dead code. Meanwhile 76,641 rows carry `when_to_take`, the same information. `medicineCard.js`
now falls back to a `when_to_take` → slot map, with `timing_category` still checked first. Two slots
added (`🌅 Empty stomach`, `🕐 Any time`) because the vocabulary says them and means them. The
vocabulary moved to `shared/giniflowMedTiming.js` so a form recording a medicine offers the same
list the card groups by.

Coverage after: 55% of medicines slot correctly; the remaining 45% have no `when_to_take` at all, so
"Timing not set" is now the truth rather than the default.

### 4.3 Private-bucket 404s

`patient-files` is a **private** bucket, so the `/object/public/<bucket>/<path>` URL Supabase
composes resolves to _"Bucket not found"_. Both the referral letter and the lab report were storing
and handing out that URL.

Both now store the authenticated object path and proxy the bytes with the service key
(`fetchStoredLetter`, `fetchStoredReport`), accepting **both URL shapes** so rows written before the
fix still open. The lab route echoes the stored object's real content type — the one report on file
is a PNG, not a PDF — and is gated on `GINIFLOW_VIEW`, not `GINIFLOW_STATION_LAB`: the MO and the
consultant are the whole reason an upload notifies anybody.

### 4.4 Per-category SLA (brief §3 `category_overrides`)

The column shipped in `2026-08-31_giniflow_sla_config.sql` and nothing read it. A red-category
patient is _meant_ to take the doctor longer than an in-control follow-up; judged against one number
the board lied twice — the careful consultation showed red, the rushed one green.

`board.budgetLookup(slaConfig)` resolves `(station, category) → minutes`, falling back to the station
budget for anything missing, null or non-positive. Now used by the board, MO, doctor, vitals and
pharmacy queues and the timeline modal. `budgetMap` remains for day averages and `lab_total`, which
are across all categories by definition. The Flow Manager drawer edits overrides per station, with a
count on the folded row; `total_journey` is excluded because it is the sum of the others.

Schema uses `z.partialRecord` — Zod 4's `z.record` over an enum demands every key, which would have
forced sending all five categories to override one.

### 4.5 Promotion into the shared clinical record — `06-PHASE-2-PLAN.md` question 12, answered

`giniflow_vitals` and `giniflow_lab_orders` deliberately stopped short of `vitals` and `documents`,
both citing the same risk: _"a third writer while two floor modules run in parallel invites the same
patient being recorded twice with different numbers."_

That risk does not go away by deciding to promote. It goes away by making promotion impossible to do
twice — so `2026-09-02_giniflow_promotion.sql` puts the Gini Flow row's id on the shared row under a
**partial unique index**, and every promotion in `services/giniflow/promote.js` is an upsert on that
key. Re-saving a reading updates one row; re-uploading a report replaces one document; a replayed
call changes nothing. Both fire after the commit — a station that could not save a reading because
the copy failed would be worse than a chart briefly missing one — and `backfillPromotions()` closes
any gap.

**A guard the first run made necessary.** The backfill promoted the three real `giniflow_vitals`
rows onto three real charts, and every one was empty: they carry a height and nothing else,
leftovers from the empty-save bug `saveVitals` now guards against. Three vitals entries with nothing
under them, and three empty points on a trend line — precisely the pollution the original migration
refused to risk. Those rows were deleted, and `promoteVitals` now refuses a reading where every
measured value is null. Height is a standing attribute, not something taken today.

Covered by `npm run smoke:giniflow-promote` — 16 checks, every destructive path run twice.

### 4.6 External-medicine context (brief §3 `external_medicines`)

Nine of the brief's twelve fields already mapped onto `medications`. Three did not, and
`addExternal()` was squashing them:

| Brief field            | Was going to            | Problem                                                                  |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `prescriber_specialty` | `notes`, joined `" · "` | Two facts in one string — unrenderable apart, unqueryable                |
| `prescriber_hospital`  | `notes`, same string    | ditto                                                                    |
| `interaction_flag`     | `clinical_note`         | **Shared with the reason a Gini dose changed.** One column, two meanings |
| `condition`            | nowhere                 | —                                                                        |

`2026-09-02_external_medicine_context.sql` gives each its own column. The interaction flag is the one
that mattered: the brief's example is _"dual RAAS block with Telma AM"_, a flag a human wrote after
checking a pair, and it cannot render as a warning while it is indistinguishable from a dose note.
It is never generated — an unchecked pair shows nothing.

They were also **unrenderable**: `medicineCard.js` selected only `external_doctor`, so even stored
context never reached a screen. The pharmacy row now reads
`Prescribed by: Dr X · Cardiology · Fortis Mohali` / `For hypertension` / `⚠ <flag>`.

### 4.7 Referral return leg (brief §4.7, `19` §12.3)

A referral was write-only. What the specialist said came back on paper and stayed there — which
means Gini's prescriber could not see the medicines the specialist had just started. That is the
interaction check failing silently, not a filing problem.

`2026-09-02_giniflow_referral_response.sql` adds `response_note`, `response_at`, `response_by`.
`recordResponse()` writes them and the medicines in one transaction, attributing each medicine to
**the specialist**, not to whoever typed it in. The medicines go to `medications` via `addExternal()`
— see §2.3.

### 4.8 Referral letter and form

`2026-09-02_giniflow_referral_ref_no.sql` adds `ref_no BIGSERIAL`, printed as `REF-2026-000001`:
nobody reads a UUID down a phone line, and a clinic that cannot quote the reference back cannot be
traced against. The letter also gained the patient's DOB (age alone cannot identify a patient at the
receiving end), the referring clinician's own callback number, and a reply line quoting the
reference. `URGENCIES` carries `hours` so SLA reporting does not have to parse "within 48 hrs".

The form gained per-field validation with `aria-invalid` and focus-on-submit, two named field groups,
an `auto-fit` responsive grid, and an allergies control rebuilt from a `<select>` into a segmented
radio group — a closed dropdown showed one option and hid the other two, and its default, _Not
asked_, is the one that prints an amber warning on a clinical letter.

### 4.9 Pharmacy, lab and reception behaviour

- **Dispensing after a visit closed.** `dispenseAll` had refused a closed visit since it was written;
  `dispenseItem` never did. Every press after `exited` still wrote to `medicine_collections` — after
  the card had gone to the patient. Now a 409, with the row rendering its recorded outcome as a
  label rather than a control.
- **Dead-end "+ 52 more".** Three lists named the rows they were hiding and gave nobody a way to
  reach them. All three are now expandable; the pharmacy board is split left/right, waiting against
  done, with an empty state on each.

---

## 5. Corrections to this audit's first revision

Three rows were wrong. Recording them because the wrong version was acted on.

**"MHG hooks absent — zero code" — wrong.** The brief's Phase 4 assumes a _push_ model. That model
was **deleted on 2026-05-01** across the whole repo: `genieSync.js` logs _"disabled — dual-DB routing
replaces sync"_, and 20 call sites in `visit.js`, `documents.js`, `health-logs.js`, `appointments.js`,
`opd.js`, `consultations.js` and `prescriptionAutoSave.js` are stubbed `const syncXToGenie = noop`.
The patient app reads this Postgres directly, so a row landing in `medications` or `documents` **is**
delivery. The medicine card already reached the app; what did not was Gini Flow's own tables — which
§4.5 fixes. Building a push would have created a second writer to reconcile.

**"No `external_medicines` table — interaction flags unstorable" — half wrong.** They were storable,
just squashed into general-purpose columns, and — the part the row missed entirely — _unrenderable_.
See §4.6.

**"`category_overrides` unused"** was right, but the drawer's hint told users the feature did not
exist, which is worse than an unused column. Both fixed in §4.4.

---

## 6. Open, ranked

| #   | Gap                                        | Why it matters                                                                                                                                                                                                                                               | Code? |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| 1   | **Nobody works the stations**              | Everything below is theoretical until this changes. Today: 57 `exited`, 28 `checked_in`, **0** `doctor_done`, **0** `pharmacy_pending` — and no visit has entered either status at any point today. All 57 exits written by `system` from the HealthRay sync | No    |
| 2   | **WhatsApp templates unapproved**          | Zero `MSG91_WA_*_TEMPLATE_NAME` set. All three senders return `{sent:false, dev:true}`. The medicine card and referral letter cannot reach a patient. Longest lead time of anything here — the brief flagged it for week 1                                   | No    |
| 3   | **`pharmacy_inventory`: 6 rows, 0 prices** | Stock chips, the out-of-stock alternatives flow and per-row pricing are code with no data behind them                                                                                                                                                        | No    |
| 4   | **Referral attachments**                   | The specialist's report _file_. The reply text and medicines land (§4.7); the document does not. Needs the upload + private-bucket proxy pattern §4.3 established                                                                                            | Yes   |
| 5   | **Tests are not ordered at Finalize**      | Brief §2.3 trigger 4 lists it; the build orders them immediately from the Tests section instead. Defensible, but it is a documented deviation                                                                                                                | Yes   |
| 6   | **Realtime phases 2–3**                    | Broadcast is connected and verified but rides alongside the 1s SSE tailer. Phase 2 publishes from the write sites (including the worker); phase 3 deletes the tailer. Zero user-visible benefit at 0 patients                                                | Yes   |
| 7   | **Enum drift: `With milk`**                | The Postgres `when_to_take_pill` enum has an eleventh value that `WHEN_TO_TAKE_PILLS` in `schemas/index.js` does not list. 25 active rows. Left unmapped in §4.2 — it names an instruction, not a time                                                       | Yes   |
| 8   | **Separate domain + role landing**         | Brief §1.1 / §2.1, see §2.1–2.2                                                                                                                                                                                                                              | Yes   |
| 9   | **Triage MHG boxes**                       | Omitted on purpose (`triage.js` §6) rather than invented                                                                                                                                                                                                     | Yes   |

Items 2 and 3 are the highest value per hour and neither is a code change. Item 4 is the cheapest
remaining code item.

---

## 7. Verification

Everything in §4 is covered by the repo's own checks, all passing as of 2 Sep 2026:

```
npm run format:check                    # prettier, the only repo-wide check
npx vite build                          # client
node scripts/check-giniflow-undefined.mjs
node scripts/smoke-giniflow-render.mjs
cd server && npm run smoke:giniflow-promote     # new — 16 checks
                 smoke:giniflow-doctor
                 smoke:giniflow-sync
                 smoke:giniflow-referrals
```

Live-data figures quoted above were read from the production database on 2 Sep 2026. Demo data
(`ZZDEMO_*`) has been removed: 0 patients, 0 visits, 0 referrals.
