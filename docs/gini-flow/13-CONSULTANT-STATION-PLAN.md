# Consultant station — Part 1: the queue and the consult shell

**Date:** 1 Sep 2026
**Status:** **built** — reviewed in `15-CONSULTANT-STATION-REVIEW.md`, findings applied 2 Sep 2026
**Brief:** `Gini-Flow-Developer-Brief.docx` §1.2, §2.2, §2.3, §4.4, §5 (Phase 3)
**Route:** `/giniflow/station/doctor` (list) → `/giniflow/station/doctor/:visitId` (consult)
**Part 2:** `14-CONSULTANT-PRESCRIPTION-PLAN.md` — prescription, tests, medicine card, Finalize

Does **not** touch the MO/SD station (`08-MO-SD-STATION-PLAN.md`); it consumes what that station
produces.

---

## 1. Which prototype files this screen comes from

The brief attaches 8 HTML files and names them the visual and interaction spec. For the consultant,
these are the ones that matter — all in `docs/Flow-Manage/`:

| File                                           | What it specifies                                                                                                                                                           | Use                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **`gini-doctor-v3.html`**                      | The doctor's **patient-list screen** — day queue grouped by status, journey rail, results status, key numbers, elapsed time                                                 | **Build** (this doc, §4)                                                   |
| **`gini-doctor-final.html`**                   | The doctor's **full consult screen** — "THE definitive doctor view" per the brief. Sections `s-overview` `s-labs` `s-rx` `s-ext` `s-tests` `s-medcard`, care plan, Finalize | **Build** (this doc §5–7, Part 2)                                          |
| `gini-prescription-v2.html`                    | Prescription mechanics — inline editing, add-medicine search with stock, alternatives modal, external medicines                                                             | **Merged into `gini-doctor-final.html` — do not build from it.** See below |
| `gini-flow-manager.html`                       | Where a consultant's patients appear to the coordinator                                                                                                                     | Built (Phase 1)                                                            |
| `gini-stations.html`                           | Pharmacy + Reception, the receiving end of Finalize                                                                                                                         | Phase 4                                                                    |
| `gini-doctor-view.html`, `gini-doctor-v2.html` | Earlier doctor-view iterations                                                                                                                                              | **Superseded — ignore entirely.** Do not read, do not reconcile            |
| `gini-addendum-mockup.html`                    | Not one of the brief's 8. Post-finalize addendum flow                                                                                                                       | Out of scope, noted in §9                                                  |

**Two files to build from — `gini-doctor-v3.html` and `gini-doctor-final.html`. That is the whole
set.** The other two doctor files are not lesser sources; they are not sources at all:

- **`gini-prescription-v2.html` is already merged into `gini-doctor-final.html`.** Its prescription
  section IS doctor-final's `s-rx`, carried across intact. So doctor-final is the single source of
  truth for prescription behaviour, and **where the two differ, doctor-final wins** — prescription-v2
  is the older draft of the same screen, not a second opinion about it. Open it only when doctor-final
  leaves an interaction unshown (a hover state, an intermediate step of the alternatives modal), and
  even then take the mechanic, not the layout.
- **`gini-doctor-view.html` and `gini-doctor-v2.html` are superseded — ignore them.** Not "check them
  last": do not read them at all. They contain earlier groupings and an earlier concerns model that
  doctor-v3 and doctor-final deliberately replaced, and reconciling a built screen against a
  superseded one is how a rejected design walks back in. `08-MO-SD-STATION-PLAN.md` §"Deliberately
  not copied" took the same decision for the MO station.

## 2. Where this sits in the journey

```
                                            ┌── Part 2 ──────────────┐
ready_for_doctor ──► with_doctor ──────────►│ Finalize (one txn)     │──► doctor_done
   (the queue)      (consult open)          │ Rx · tests · card · MHG│    └► pharmacy_pending
                                            └────────────────────────┘
```

Three chain statuses already exist and need no migration: `ready_for_doctor` (the queue —
budget `wait_doctor` 15 min), `with_doctor` (in the room — budget `doctor` 20 min), `doctor_done`.
The consultant is the floor's known bottleneck: the board's own `wait_doctor` column is the one the
whole day backs up behind, which is why the list screen leads with waiting time, not with names.

**What arrives from the MO/SD station** (all built, `08`):

| Table                      | What the consultant does with it                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `giniflow_sd_notes.plan`   | The MO's workup plan — read at the top of Overview, never edited by the consultant                                                                                                                               |
| `giniflow_rx_proposals`    | Medicine changes the MO proposed. **The consultant approves / adjusts / rejects each.** `status` and `decided_by` / `decided_at` columns exist and are currently never written — this screen is what writes them |
| `giniflow_lab_orders`      | Tests the MO already ordered — shown so the consultant does not order them twice                                                                                                                                 |
| `giniflow_visits.category` | Red/amber/green — drives the flag chip                                                                                                                                                                           |

## 3. Role, capability, RBAC

The brief says `doctor`; this repo's role vocabulary says **`consultant`** (`ROLES.CONSULTANT`,
Dr. Bhansali) with `mo` as the separate medical-officer role. Use the repo's word — a second name
for the same person is how `file_no` / `health_id` confusion started.

```js
GINIFLOW_STATION_DOCTOR: "GINIFLOW_STATION_DOCTOR"; // work the consultant's queue and consult
```

| Role          | Grant | Why                                                                                  |
| ------------- | ----- | ------------------------------------------------------------------------------------ |
| `consultant`  | ✅    | Whose station it is                                                                  |
| `admin`       | ✅    | `ALL`                                                                                |
| `mo`          | ❌    | The MO proposes; the consultant decides. Granting both collapses the two-step review |
| `coordinator` | ❌    | Can see the board, cannot prescribe                                                  |

**Exactly six places to wire it** — checked against the tree, not from memory:

| File                                          | Change                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `shared/permissions.js`                       | the capability + grants to `consultant`                                                                                          |
| `src/config/routes.js`                        | `"/giniflow/station/doctor": CAP.GINIFLOW_STATION_DOCTOR`                                                                        |
| `src/router.jsx`                              | `lazyWithRetry` import + two route entries (list, `:visitId`)                                                                    |
| `server/routes/giniflowStations.js`           | `STATION_CAPS.doctor = CAP.GINIFLOW_STATION_DOCTOR` — **currently missing**, so the launcher tile is filtered out for every role |
| `src/pages/giniflow/StationsLauncherPage.jsx` | the Consultant tile — ✅ `href: "/giniflow/station/doctor"` added                                                                |
| `server/services/giniflow/stationSummary.js`  | nothing — `doctor: { count: col("wait_doctor"), label: "N waiting" }` is already computed                                        |

Run `node server/scripts/verify-rbac.mjs` after; it asserts the matrix on both sides.

**Scoping.** `giniflow_visits.assigned_doctor_id` already exists and the board reads it. The queue
defaults to the signed-in consultant's own patients with an "all consultants" toggle — Gini runs one
main consultant today, but a query that hard-codes that assumption is a rewrite the day it stops
being true.

## 4. Screen 1 — the queue (`gini-doctor-v3.html`)

### 4.1 Header strip — five counts

From the prototype's header, in its order, because the order is the priority:

| Tile                | Value                                                                |
| ------------------- | -------------------------------------------------------------------- |
| **With me now**     | `with_doctor` — "in visit"                                           |
| **Results ready**   | `ready_for_doctor` AND `results_status = 'ready'` — "waiting for me" |
| **Completed**       | `doctor_done` or beyond, today                                       |
| **Missing results** | on the floor, `results_status <> 'ready'` — "can't proceed"          |
| **Avg visit time**  | mean `with_doctor` duration today vs the `doctor` budget             |

`Today's patients` is the total. Every count is derived from the same day query — never five.

### 4.2 Four groups, in this order

The prototype's grouping is the screen's whole argument: _who is with me, who is ready, who is
coming, who is finished._

```
🟢 With me now              with_doctor
⏳ Results ready            ready_for_doctor · results_status = ready     ← the working queue
🔵 In pipeline              checked_in…with_sd, or ready_for_doctor without results
✅ Done today               doctor_done · pharmacy_pending · dispensed · exited
```

A patient whose reports have not arrived sits in **In pipeline**, not in the working queue, however
long they have waited — calling them in is the wasted consultation the whole system exists to
prevent. Their card shows `✗ Missing · No reports yet` and an **Upload** action that deep-links to
the lab station rather than being a second upload path.

### 4.3 The card

Everything on the prototype card, and what each field reads from:

| Element                                                  | Source                                                                                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appointment time · initials · name                       | `giniflow_visits.appointment_time`, `patients.name`                                                                                                                                    |
| Category chip (`🔴 Worse` / `🟡 Flag` / `✅ In control`) | `giniflow_visits.category` — same vocabulary as the board                                                                                                                              |
| `Visit 5`                                                | the board's existing completed-appointments count                                                                                                                                      |
| Identity line                                            | `50M · P_177562 · Phase 1 Uncontrolled · T2DM` — phase and lead diagnosis from `diagnoses`                                                                                             |
| **Journey rail**                                         | `Check-in ✓ › Vitals ✓ › MO ✓ › With Dr. Bhansali › Pharmacy` — from `giniflow_visit_events`; the current step highlighted. This is the one element that makes a queue a _flow_ screen |
| Results badge                                            | `✓ Ready · Gini Lab · all tests` / `✗ Missing` — `results_status` + the lab order                                                                                                      |
| Two key numbers                                          | HbA1c and FBS (or BP where diabetes is not the lead) from `lab_results`, latest per test                                                                                               |
| Elapsed                                                  | minutes since the last event, coloured against the SLA — **live-ticking**, the board's `useTick` + server-offset rule                                                                  |
| Priority                                                 | `❗ Urgent` chip and red edge, `priority` from `10-QUEUE-CONTROL-PLAN.md`; urgent sorts to the top of its group                                                                        |

**Ordering inside a group:** priority → longest waiting. `compareQueue` in
`shared/giniflowStatus.js` already is this rule; reuse it rather than writing a third sort.

### 4.4 Actions

| Action                  | Effect                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Tap a queued card       | `POST …/start` → `with_doctor`, opens the consult                                             |
| Tap a done card         | Opens the consult **read-only** with an addendum path (§9), no status change                  |
| Tap an in-pipeline card | Opens the consult read-only. Reading ahead is exactly what a consultant does between patients |

Claiming is the same rule the vitals station uses: **one** patient may be `with_doctor` at a time per
consultant. Opening a second returns 409 naming who is already in the room — the older module's
"one doctor showed four consultations at once" bug, which `HEALTHRAY_STATUS_TO_CHAIN` already
comments on.

## 5. Screen 2 — the consult shell (`gini-doctor-final.html`)

### 5.1 Two bars, always visible

**Top rail:** back to Patients · patient name · `50M · P_177562` · category chip · **Draft /
Finalized** state · `Finalize →`.

**Patient header strip** — the prototype's identity line and six tiles, which are the entire "why is
this person here" in one glance:

```
Sandeep Kumar · 50M · P_177562 · DB #9500 · Dr. Beant Sidhu (SD) · T2DM AOO 38 yrs
                                             ↑ who worked them up, from assigned_sd_id
┌ With Gini 10 months ┬ Visit 5 of 5 ┬ HbA1c since 1st 6.6→6.8% ┬ Weight +0.5 kg ┬ BP today 143/90 ┬ Last visit 4 Nov 2025 ┐
└ Current regimen: Cospiaq · Lipaglyn · Atchol +6 more ────────────────────────────────────────────────────────────────────┘
✓ 4 in control — HbA1c · UACR · Creatinine · Retinopathy   ↑ 1 worse — TG tripled to 368   ⚠ 2 watch — BP 143/90 · LDL 127
```

That last line is a **computed triage summary**, not text anyone types: every tracked biomarker
classified against its target and counted. It is the single most useful line on the screen and the
easiest to get wrong — §6.3.

### 5.2 Section nav

`📋 Overview · 📊 Labs & graphs · 💊 Prescription · 🔬 Tests · 🗒 Medicine card`, each scrolling to
its section, each section collapsible. One page, not a wizard — deliberately unlike Scribe's
`/intake → … → /plan` route sequence, because a consultant re-reads labs while editing the
prescription and a wizard makes that a navigation.

**`🎤 Speak` and `Finalize →` are not nav targets** — they sit in the bar's right-hand group
(`.qn-r`) and stay put while the page scrolls. An earlier draft of this line listed them alongside
the sections, which would have built the microphone as somewhere to scroll to.

### 5.2b Voice, screen-level

`gini-doctor-final.html` puts a microphone in six places. Four are inside the prescription and tests
sections and belong to Part 2 §4b, which carries the design tokens, the dictation-versus-command
distinction and the safety rule. Two are this screen's own:

| Control         | Where                                                | The prototype's example         |
| --------------- | ---------------------------------------------------- | ------------------------------- |
| **🎤 Voice AI** | top nav, right of the patient's name and phase badge | _"Listening… say instructions"_ |
| **🎤 Dictate**  | care plan notes section header                       | _"Dictating care plan…"_        |

Both are plain dictation into free text, so both ship with `useDictation` as it stands — no parsing,
nothing to confirm. **`🎤 Voice AI` is the one to be careful with:** in the prototype it is unscoped
("say instructions"), which on a real screen means a command that could reach any section. Until
Part 2 §4b step 3 exists, build it as dictation into whichever field has focus, and if nothing has
focus, do nothing but say so. A microphone that appears to accept any instruction and silently
applies none is worse than no microphone.

## 6. Overview (`s-overview`)

### 6.1 Today's concerns — three sources, never merged

The prototype splits concerns into three blocks and the split is the point: a number from a machine,
a sentence from the patient, and a change over time are different kinds of evidence.

| Block                   | Source                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **🧪 From reports**     | Computed from `lab_results` — out-of-target and moved-since-last, ranked 🔴 🟡 ✅                                           |
| **💬 Patient reported** | Pre-visit intake / Genie chat / the MO's note. Quoted verbatim, Hindi kept as Hindi: _"kya dawai se weight badh raha hai?"_ |
| **📅 Since last visit** | Compliance %, weight delta, screening results, "no new outside medicines"                                                   |

Each row is `icon · bold claim · dash · the evidence`. Never a bare colour.

### 6.2 Key numbers — six tiles, each tappable to a trend graph

HbA1c · FBS · Triglycerides · LDL · eGFR · BP today. Value, unit, and a delta line
(`↑ from 6.6% · borderline`, `↑↑↑ tripled from 131`). Tap opens the trend modal (`gmod` in the
prototype) — an SVG line of every value of that test from `lab_results`, with the target band drawn
behind it. Which six is not fixed: pick the tests with targets that this patient's diagnoses point
at, falling back to the prototype's six.

### 6.3 Diagnoses

From `diagnoses`, grouped as the prototype groups them — **Primary**, then **Complications &
comorbidities** — each with its `key_value` (`G2 A2`, `VPT L 7V`, `BMI 35.9`). `+ Add` opens the
existing diagnosis editor rather than a second one.

**The in-control / worse / watch counts** come from one classifier: for every biomarker with a target
in `giniflow_test_catalog`, compare latest against target and against the previous value →
`in_control | watch | worse`. Written once, server-side, in `server/services/giniflow/consultBrief.js`,
because the same three numbers appear on the card, the header and the day report, and three
implementations would drift.

## 7. Labs & graphs (`s-labs`)

Five tabs — 🩸 Diabetes · 💛 Lipids · 🫘 Renal · ⚖️ Body/vitals · 📄 Reports — each a table of
`test · value · reference range · trend · Graph →`, driven by `giniflow_test_catalog`'s panels so the
tabs cannot drift from what the lab can order.

The **📄 Reports** tab lists the actual PDFs (`Lab Report — 17714 · 16 Jul 2026 · Gini Lab ·
View PDF →`) from the existing documents pipeline, including HealthRay-ingested scans. Reports are
opened, never re-uploaded here: uploading is the lab station's job, and `HealthRay "Other" doc
classification` is a known trap — a report filed under the wrong bucket must be fixed at the
classifier, not worked around with a second upload button.

## 8. Care plan (`s-plan`)

Four blocks from the prototype, all free text except the last:

1. **Treatment plan this visit** — auto-seeded from the prescription changes (`Atchol 20→40mg — LDL
127`), editable. Seeding it from the actual edits means the plan and the prescription cannot
   disagree.
2. **Diet & lifestyle** — dictated or typed.
3. **Next visit** — a date and an interval chip (`~3 months`).
4. **Goals for next visit** — `<7.0% HbA1c · <130 FBS · <150 TG · <130 BP`. Structured, not prose:
   these are what the next visit's "in control / worse" classifier measures against.

Voice dictation reuses **`src/hooks/useDictation.js`** — the recording, live captioning and Deepgram
fallback extracted from `useVoiceVitals` so both stations share one implementation. Not
`shared/giniflowVitalsSpeech.js`: that is a deterministic parser for six numeric vitals fields, and
nothing in it generalises to prose. Dictating a care plan needs the transcript, not a parse.

## 9. Read-only, addenda, and what this screen must not do

- **A finalized visit is read-only.** Re-opening shows the consult with every control disabled and
  one action: **Add addendum** — a new append-only note, never an edit of the finalized record.
  `gini-addendum-mockup.html` sketches this; it is not one of the brief's 8 files, so it is
  out of scope for the build and listed here so the next person knows why it exists.
  **The rest of that mockup is not out of scope** — its four speed and safety changes are planned
  in `24-ADDENDUM-V11-PLAN.md`, two of which change this screen (the pre-seeded prescription and
  the fast-path bar).
- **No unblocking, no status jumping.** Same rule as the board drag and the vitals station: a hold is
  cleared where it was set.
- **No second patient chart.** Overview, Labs and Diagnoses read the existing Scribe tables
  (`lab_results`, `diagnoses`, `medications`, `documents`). Gini Flow owns the _journey_; Scribe owns
  the _chart_. A duplicate chart is the failure mode this whole module is structured to avoid.

## 10. Server side

New service `server/services/giniflow/doctorStation.js`, mirroring `moStation.js`:

| Function                                     | Does                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `getDoctorQueue(date, doctorId, scope, now)` | the four groups + five counts, one query set                                                       |
| `getConsult(visitId)`                        | header strip, concerns, key numbers, diagnoses, labs, MO plan, proposals                           |
| `startConsult(visitId, actorId)`             | `ready_for_doctor → with_doctor`, one-at-a-time guard                                              |
| `releaseConsult(visitId)`                    | consultant stepped out; returns to `ready_for_doctor` — the MO station's `releaseWorkup` precedent |
| `saveCarePlan(visitId, plan)`                | upsert; autosaves like the MO's `savePlan`                                                         |
| `decideProposal(id, decision)`               | `approved · adjusted · rejected` + `decided_by/at` on `giniflow_rx_proposals`                      |

New service `server/services/giniflow/consultBrief.js` — the biomarker classifier of §6.3, pure and
unit-testable, used by the card, the header and the day report.

**Reuse rather than rewrite** — all of this exists and is already the source `/visit` reads from:

| Need                                   | Use                                                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest labs, lab history, vitals merge | `server/services/visitLabContext.js` — built so `/visit`, the pre-visit summary and the post-visit summary "see identical numbers". The consult is the fourth caller, not a fourth query |
| Canonical test names for trends        | `server/utils/labCanonical.js`                                                                                                                                                           |
| Visit history / last-visit deltas      | `server/services/visitHistory.js`                                                                                                                                                        |
| Report PDFs incl. HealthRay scans      | the existing `documents` pipeline + `documentClassifier.js`                                                                                                                              |

Writing a second lab query here would reintroduce exactly the disagreement `visitLabContext` was
extracted to end.

Every write goes through `advanceStatus` with `actorRole: "doctor"` (already in `ACTOR_ROLES`), in a
transaction, so timers and the board stay consistent by construction.

## 11. API

All behind `requireCapability(GINIFLOW_STATION_DOCTOR)`, Zod-validated, `server/routes/giniflowStations.js`:

| Method | Path                                                 | Body / query                                                 |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/api/giniflow/stations/doctor/queue`                | `?date&scope=mine\|all&q=`                                   |
| GET    | `/api/giniflow/stations/doctor/:visitId`             | the whole consult payload                                    |
| POST   | `/api/giniflow/stations/doctor/:visitId/start`       | —                                                            |
| POST   | `/api/giniflow/stations/doctor/:visitId/release`     | —                                                            |
| PUT    | `/api/giniflow/stations/doctor/:visitId/care-plan`   | `{ treatment, lifestyle, nextVisitDate, interval, goals[] }` |
| PATCH  | `/api/giniflow/stations/doctor/proposals/:id`        | `{ decision, adjustedDose?, note? }`                         |
| GET    | `/api/giniflow/stations/doctor/:visitId/trend/:test` | series for the graph modal                                   |

Plus Part 2's prescription, tests and Finalize endpoints.

Queue polls on the board's 15s interval with client-side ticking — the same as every other station,
because the brief's Supabase Realtime is not this repo's stack (`00-OVERVIEW.md` §2.2).

**If `12-REALTIME-PLAN.md` lands first, this screen inherits it for free** and must not be built
against polling twice: that plan replaces the transport inside `src/queries/hooks/useGiniflow*.js`,
so a doctor queue written to the existing hook shape switches over with it. Build the hook to the
convention (`useGiniflowDoctor.js`, §12) — never hand-roll an interval in the page.

## 12. Client files

Mirroring the vitals/MO stations exactly, so a fifth station reads like the first four:

| File                                                                                                                                             | Holds                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/giniflow/DoctorStationPage.jsx`                                                                                                       | the queue — header counts, four groups, cards, live tick                                                                                                                      |
| `src/pages/giniflow/DoctorConsultPage.jsx`                                                                                                       | the consult shell + section nav; each section its own component                                                                                                               |
| `src/pages/giniflow/consult/` (`OverviewSection`, `LabsSection`, `RxSection`, `TestsSection`, `MedCardSection`, `CarePlanSection`, `TrendModal`) | one file per prototype section — `DoctorConsultPage` must not become an 800-line file                                                                                         |
| `src/queries/hooks/useGiniflowDoctor.js`                                                                                                         | `useDoctorQueue` · `useConsult` · `useStartConsult` · `useSaveCarePlan` · `useDecideProposal` — the `useGiniflowVitals.js` shape, 15s poll, `placeholderData: (prev) => prev` |
| `src/styles/giniflow-station.css`                                                                                                                | extended, not forked — the station design system is one file                                                                                                                  |

## 13. Response shapes

Fixed here so the client and the service can be built in either order.

`GET …/doctor/queue`

```jsonc
{
  "date": "2026-09-01",
  "serverTime": "2026-09-01T09:11:07.792Z",
  "counts": {
    "total": 18,
    "withMe": 3,
    "resultsReady": 6,
    "completed": 8,
    "missingResults": 1,
    "avgVisitMinutes": 74,
    "visitBudgetMinutes": 20,
  },
  "groups": {
    "with_me": [
      /* cards */
    ],
    "results_ready": [],
    "pipeline": [],
    "done": [],
  },
}
```

card:

```jsonc
{
  "visitId": "uuid",
  "patientId": 5064,
  "name": "Sandeep Kumar",
  "fileNo": "P_177562",
  "age": 50,
  "sex": "M",
  "visitNumber": 5,
  "appointmentTime": "08:30",
  "category": "worse_in_range",
  "priority": "urgent",
  "priorityReason": "chest pain",
  "phase": "Phase 1 · Uncontrolled",
  "leadDiagnosis": "T2DM",
  "status": "with_doctor",
  "statusSince": "…",
  "waitMinutes": 52,
  "waitBudget": 20,
  "waitColour": "r",
  "journey": [
    { "step": "Check-in", "state": "done" },
    { "step": "Vitals", "state": "done" },
    { "step": "MO", "state": "done" },
    { "step": "With Dr. Bhansali", "state": "current" },
    { "step": "Pharmacy", "state": "todo" },
  ],
  "results": { "status": "ready", "label": "Gini Lab · all tests" },
  "keyNumbers": [
    { "test": "HbA1c", "value": "6.8", "unit": "%" },
    { "test": "FBS", "value": "139", "unit": "mg/dL" },
  ],
}
```

`GET …/doctor/:visitId` returns `{ patient, header, moPlan, proposals[], concerns{reports[],
patient[],sinceLast[]}, keyNumbers[], diagnoses[], labs{tabs[],reports[]}, carePlan, testsOrdered[],
status, finalized }`.

## 14. Definition of done

The brief's own §5 criteria, applied to this station:

1. A patient can be walked from `ready_for_doctor` to `doctor_done` in two browser windows
   (consultant + board) and both update without a refresh.
2. Every transition appears in `giniflow_visit_events` **exactly once**, `actor_role = 'doctor'`.
3. The queue's elapsed timers match a stopwatch within a few seconds, and match the board's timers
   for the same patient — they read the same events.
4. Killing and reopening the tab loses nothing: the care plan and the Rx draft are server-side.
5. `smoke:giniflow-doctor` passes; `verify-rbac.mjs` passes; `npm run build` and `format:check` clean.

## 15. Decisions taken, and the one input still needed

Resolved by reading the tree, so they are no longer open:

- **Flow consult sits BESIDE Scribe's wizard, sharing its tables.** The brief says absorbing Scribe
  "is not part of this build". `POST /api/consultations` is already the atomic
  `BEGIN…COMMIT` that writes `consultations` + `vitals` + `diagnoses` + `medications` together;
  Finalize reuses that path rather than adding a fifth set of INSERTs (Part 2 §6). A consultant may
  still use Scribe's wizard for a non-OPD-day patient; both write the same chart.
- **The six key numbers are chosen, not fixed.** Rank every test that has a target in
  `giniflow_test_catalog` and a result in the last 12 months by: out-of-target first, then moved most
  since the previous value, then recency. Take six. Where a patient has fewer than six, fall back to
  the prototype's set (HbA1c · FBS · TG · LDL · eGFR · BP). Deterministic, so the same patient shows
  the same tiles all day.
- **Scoping** — queue defaults to the signed-in consultant, with an all-consultants toggle (§3).
- **Polling, not Realtime** — `00-OVERVIEW.md` §2.2 already settled this for the whole module.

Still needed from Nikhil — **does not block this part**, blocks Part 2 §2.4 only:

- **Pharmacy stock source** (the brief's own open question #3). Part 2 ships the table empty and
  renders `Stock —` until answered.

## 16. What the review changed

`15-CONSULTANT-STATION-REVIEW.md` read the built station against this plan and Part 2. Applied:

| Finding      | Fix                                                                                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CS-01** 🔴 | `medications`' two partial unique indexes lived only in an ad-hoc script, so every Finalize on a database built from the migration chain would have failed. Now `2026-09-02_medications_unique_indexes.sql` |
| **CS-02** 🟠 | Stopping a medicine that had been stopped before collided on the INACTIVE unique index and aborted the whole consultation. The superseded inactive row is now dropped first, per the repo's dedup policy    |
| **CS-03** 🟠 | Finalize produced no prescription PDF, while the same consultation through Scribe's wizard did. Now calls `savePrescriptionForVisit` after the commit                                                       |
| **CS-07** 🟡 | The read-only banner promised an addendum path that does not exist. It now says where a correction actually has to be made                                                                                  |
| **CS-08** 🟡 | `NULL \|\| text` is NULL in Postgres, so a consultant's mandatory reason for rejecting an MO proposal was written as nothing                                                                                |
| **CS-09** 🟡 | `releaseConsult` wrote `current_status` directly; it now goes through a `returnToQueue` primitive in the engine, which also clears the queue position                                                       |
| **CS-10** 🔵 | A comment claimed the consultations INSERT was an upsert. It is not — the status guard is what prevents a duplicate                                                                                         |
| **CS-11** 🔵 | A no-op `notes = COALESCE(notes, '')` removed                                                                                                                                                               |
| **CS-12** 🔵 | The engine's `allowSkip` comment said "never a station screen" while four callers set it. It now states the real rule and what bounds each caller                                                           |

**Still open, deliberately.** CS-06: the stock column, low-stock warning and alternatives flow are
built but permanently inert until `pharmacy_inventory` has data — a demo cannot show that flow.
CS-07: the screen is now honest that no addendum path exists, but the path is still not built.
`moStation.releaseWorkup` still writes `current_status` directly — the MO/SD station is out of scope
here, so the one-writer rule has one known exception rather than three.

## 17. Build order

Roughly the brief's Phase 3, in dependency order. Each step is shippable and testable on its own.

| #   | Step                                                                  | Done when                                                       |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Capability, RBAC, routes, launcher tile — the six wiring points in §3 | The tile appears for `consultant` and opens an empty page       |
| 2   | `consultBrief.js` classifier + smoke test                             | in-control / worse / watch counts match a hand check            |
| 3   | Queue: service → API → page → live timers (§4, §10, §11)              | Groups, counts and elapsed match the board                      |
| 4   | Consult shell + Overview + Labs, read-only (§5–7)                     | Every number on screen traces to a table                        |
| 5   | Care plan + MO proposal decisions (§8)                                | `decided_by` / `decided_at` written; autosave survives a reload |
| 6   | **Part 2** — prescription, tests, medicine card, Finalize             | `14-CONSULTANT-PRESCRIPTION-PLAN.md`                            |
| 7   | `smoke:giniflow-doctor` grown at every step, not bolted on at the end | §14 passes                                                      |

Steps 1–5 are this document and are independent of the stock question; step 6 is not.
