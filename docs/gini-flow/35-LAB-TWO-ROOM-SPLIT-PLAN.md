# 35 — Lab split into two station rooms

Status: PLAN (not implemented)
Supersedes nothing. Extends `28-LAB-PAYMENT-SPLIT-PLAN.md`, `32-LAB-TYPED-RESULTS-PLAN.md`,
`34-LAB-BILLING-STEP-PLAN.md`.

---

## 1. What was asked

Split the single lab station into two station rooms, one per physical bench:

**Lab Station 1 — Collection room**

1. Test ordered
2. Sample collected
3. Sample sent to lab

**Lab Station 2 — Lab room**

1. Sample received
2. Sample in processing
3. Reports ready and uploaded

Explicit constraint: **"test ordered" must not be offered as an action.** It is the state a
card arrives in, not something anybody clicks. No button, no filter chip that reads like a
verb for it.

---

## 2. Review of the current lab station

Read: `src/pages/giniflow/LabStationPage.jsx` (1610 lines),
`server/services/giniflow/labStation.js` (1286 lines),
`src/queries/hooks/useGiniflowLab.js`, `server/routes/giniflowStations.js` (lab block from
line 1181).

### 2.1 One screen, two rooms

`/giniflow/station/lab` is a single queue. A phlebotomist at the collection bench and a
technician at the analyzer see the same cards, the same five filter chips and the same
action buttons. Neither can tell which rows are theirs. This is the whole reason for the
split.

### 2.2 Three ladders already describe one sample

| Ladder                    | Where                | Steps                                                                                             |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `SAMPLE_FLOW` / `BUCKET`  | `labStation.js:50`   | ordered, payment_pending, paid, sample_collected, processing, results_ready, uploaded → 5 buckets |
| `CASE_STAGE`              | `labStation.js:~355` | pending, collected, processing, results, reported                                                 |
| `RAIL` + `RAIL_FOR_STAGE` | `labStation.js:~470` | Ordered, Collect sample, Process, Upload (4)                                                      |

`LAB_GROUPS` exists purely to translate ladder 1 into ladder 2, and `RAIL_FOR_STAGE` exists
purely to squash ladder 2 into ladder 3. Adding two more steps to three parallel ladders is
how this file becomes unmaintainable. **The split must collapse them into one shared
ladder first** (Phase 1) — that is the single most important sequencing decision in this
plan.

### 2.3 The handoff between the two rooms does not exist

There is no state between "sample collected" and "processing". A tube drawn at 09:10 and
still sitting in a rack in the collection room at 11:40 is indistinguishable from one on the
analyzer. That gap is exactly the two steps being asked for: **sent** and **received**.

### 2.4 `receivedOn` is already mislabelled

`healthrayStage()` maps HealthRay's `received_on` to stage `processing`. `received_on`
literally means the lab received the tube — it is Station 2 step 1, not step 2. The new
ladder fixes this by giving `received` its own rung, so nothing is invented: the timestamp
was always there, under the wrong name.

Caveat that constrains this whole design: HealthRay stamps collection, receipt, result and
sign-out **at the same instant** for the overwhelming majority of cases (240 of 258 reported
cases carry four identical timestamps — see `labStation.js` comment above `canHaveReport`,
and the "HealthRay lab has no intermediate steps" note). So HealthRay can never drive the
intermediate rungs. **The floor's own actions are the only live signal.** Both rooms are
therefore data _producers_ first and displays second.

### 2.5 The volume is in `lab_cases`, not `giniflow_lab_orders`

`giniflow_lab_orders` is ordered on this floor by an MO and is nearly empty in production;
the hospital runs ~40 cases/day through HealthRay into `lab_cases`. Both new rooms must
work **primarily on the HealthRay case list** (`giniflow_lab_case_actions` writes), with the
Gini order queue as the secondary track. A split that only handles Gini orders would ship
two empty screens.

### 2.6 Smaller findings

- The payment gate (`opensLabGate`) applies to Gini orders only; HealthRay cases have no
  gate. Station 1 must keep that asymmetry visible rather than silently applying one rule.
- `stageCounts` counts HealthRay only, `unifiedCounts` counts both, `bucketCounts` counts
  Gini only, `groupCounts` counts both again — four counters over two lists. Per-room
  counting will multiply this unless it goes through one helper.
- `UNREACHABLE_GROUPS` ("in a room", "left the floor") and `DONE_SPLIT` belong to Station 1
  and Station 2 respectively: only collection needs the patient present.
- The upload drop zone is offered whenever `canHaveReport()` is true. That is a Station 2
  control and must not appear in Station 1 at all.

---

## 3. Target design

### 3.1 One ladder, seven rungs, two owners

`shared/labStages.js` (new) is the single source of truth, imported by client and server —
the same pattern as `shared/giniflowStatus.js` and `shared/labPayment.js`.

| idx | key          | room | card label         | action label               | who writes it           |
| --- | ------------ | ---- | ------------------ | -------------------------- | ----------------------- |
| 0   | `ordered`    | 1    | Test ordered       | _(none — never an action)_ | the order/case arriving |
| 1   | `collected`  | 1    | Sample collected   | ✓ Mark sample collected    | Station 1               |
| 2   | `sent`       | 1    | Sample sent to lab | 📤 Mark sent to lab        | Station 1               |
| 3   | `received`   | 2    | Sample received    | ✓ Mark sample received     | Station 2               |
| 4   | `processing` | 2    | In processing      | ⚙️ Start processing        | Station 2               |
| 5   | `results`    | 2    | Results ready      | _(internal)_               | Station 2 / HealthRay   |
| 6   | `reported`   | 2    | Report uploaded    | 📤 Upload report           | Station 2               |

Rungs 5 and 6 are presented in Station 2 as **one** step, "Reports ready & uploaded", per
the ask. `results` stays in the ladder because HealthRay's `result_saved_on` genuinely lands
there and typed results (`32-LAB-TYPED-RESULTS-PLAN.md`) already write it; the UI simply
does not make the technician click through it — the upload drop zone advances 4 → 6
directly, which `advanceSample` already permits (any forward jump is legal, `toIdx > fromIdx`).

### 3.2 Rule R1 — no action on rung 0

`ordered` has `action: null` in the shared table. The action renderer derives buttons from
the table, so it is structurally impossible to render an "ordered" button. Its filter chip
is the noun "Test ordered", and in Station 1 the section heading is
"⏳ Test ordered — collect now".

### 3.3 Rule R2 — a room may only advance its own rungs

`sample_status`/case action → owning room is in the shared table. The service rejects a
Station 1 caller trying to write `processing` (403), and vice versa. Hidden buttons are not
a rule — same reasoning as the existing payment gate.

### 3.4 Rule R3 — overlap at the handoff, deliberately

- Station 1 queue shows rungs **0, 1, 2** (2 = "sent today", its own done-list).
- Station 2 queue shows rungs **2, 3, 4, 5, 6** (2 = its **inbox**: sent, not yet received).

Rung 2 appears on both screens with different framing. That is the handoff being visible
from both sides, and it is the point of the split.

### 3.5 Routes, capabilities, tiles

|             | Station 1                                | Station 2                                  | Combined (kept)         |
| ----------- | ---------------------------------------- | ------------------------------------------ | ----------------------- |
| Room        | Collection bench                         | Analyzer bench                             | —                       |
| Route       | `/giniflow/station/lab/collection`       | `/giniflow/station/lab/processing`         | `/giniflow/station/lab` |
| Capability  | `GINIFLOW_STATION_LAB_COLLECT`           | `GINIFLOW_STATION_LAB_PROCESS`             | `GINIFLOW_STATION_LAB`  |
| Roles       | `lab`, `tech` (+ `admin`, `coordinator`) | **`lab_admin`** (+ `admin`, `coordinator`) | `admin`, `coordinator`  |
| Tile        | 🩸 Lab — Collection                      | 🔬 Lab — Processing                        | 🧪 Lab (all day)        |
| Summary key | `lab_collect`                            | `lab_process`                              | `lab`                   |

`GINIFLOW_STATION_LAB` stays and remains the gate on every existing endpoint, so nothing
that works today breaks. The two new capabilities gate the two new queue views and the
per-room write rule (R2).

### 3.6 The new `lab_admin` role

`lab_admin` does not exist today — `shared/permissions.js:33` defines `lab` and `tech`, and
both currently hold `GINIFLOW_STATION_LAB`. Station 2 gets a role of its own because the
analyzer bench carries a different accountability: it signs results out, and it is the only
place a report reaches the patient.

Cheap to add, because `doctors.role` is **free text with no CHECK constraint** — see
`2026-06-04_normalize_doctor_roles.sql`, which deliberately declined to add one, "which
would block adding new roles without a follow-up migration". So no DDL. The touch points:

1. `shared/permissions.js` — `ROLES.LAB_ADMIN: "lab_admin"` plus a `ROLE_CAPABILITIES`
   entry. Start from the `LAB` block: the same `PATIENT_READ` / `PATIENT_CHART` /
   `LAB_PORTAL` / `LAB_REQUESTS` / `FLOW_*` / `GINIFLOW_VIEW` / `GINIFLOW_BOARD` set, plus
   `GINIFLOW_STATION_LAB` and `GINIFLOW_STATION_LAB_PROCESS`, and **without**
   `GINIFLOW_STATION_LAB_COLLECT`.
   ⚠️ `GINIFLOW_VIEW` is not optional. `/api/giniflow*` is prefix-gated on it in
   `middleware/auth.js` before any per-route capability runs — the `TECH` block carries a
   long comment about exactly this trap: omit it and you get a role that passes the frontend
   check and then 403s on every call. A broken screen, not an honest refusal.
2. `src/pages/LoginPage.jsx:6` — a `ROLE_GROUPS` entry,
   `{ role: "lab_admin", label: "Lab Admin", showSpecialty: false }`. Without it the role's
   accounts never appear on the login screen and nobody can sign in as one.
3. `normalizeRole()` — confirm it recognises the new value. It fails unknown roles closed to
   `guest`, so a role missing from `ROLES` silently loses every capability it was granted.
4. Data: `UPDATE doctors SET role = 'lab_admin' WHERE id IN (…)` for the analyzer-bench
   staff. **A production write against live accounts** — `SELECT` the rows first, move them
   one at a time, and expect those people to lose Station 1 the moment it lands.

**Ordering mattered, and was respected:** the role and its account move landed before Lab 2
went live, so no `lab` user was ever left without a room.

### 3.7 Data model

- `giniflow_lab_orders.sample_status` is plain `TEXT` with **no CHECK constraint**
  (`2026-08-31_giniflow_lab_orders.sql:30`) — the two new values `sample_sent` and
  `sample_received` need **no** DDL. Validation lives in `SAMPLE_FLOW` and in
  `server/schemas/index.js:732`.
- `giniflow_lab_case_actions.action` **does** have a CHECK
  (`2026-09-09_giniflow_lab_case_stage_actions.sql`) — one migration extends it with
  `sample_sent` and `sample_received`.
- No backfill. Existing rows stay valid. One visible reclassification: HealthRay cases whose
  only clock is `received_on` move from displaying "Processing" to displaying "Sample
  received" — a rename of something already true, not a data change.

⚠️ `DATABASE_URL` is production. The migration is one `ALTER … CHECK` and is additive, but
it still runs against live data — apply it with `node migrations/_runOne.mjs`, alone, and
read the output.

---

## 4. Flow, end to end

```
MO orders test  ─┐
HealthRay case  ─┴─► rung 0  ordered
                          │  (no action — R1)
      ┌───────────── STATION 1 · COLLECTION ROOM ─────────────┐
      │  payment gate (Gini orders only) ─ patient must be    │
      │  free (assertPatientIsFree) for rung 1 only           │
      │                                                       │
      │  rung 1  collected     ✓ Mark sample collected        │
      │  rung 2  sent          📤 Mark sent to lab            │
      └───────────────────────────┬───────────────────────────┘
                                  │  handoff — visible on both screens
      ┌───────────── STATION 2 ·  LAB ROOM ────────────────────┐
      │  rung 3  received      ✓ Mark sample received          │
      │  rung 4  processing    ⚙️ Start processing             │
      │  rung 5  results       (HealthRay / typed results)     │
      │  rung 6  reported      📤 Upload report  ── advances   │
      │                           4|5 → 6 in one call          │
      └───────────────────────────┬────────────────────────────┘
                                  │
        results_status = 'ready' on the visit  →  MO + consultant
        boards turn green, patient app + Labs tab pick up the file
```

Nothing downstream of rung 6 changes: `promoteLabReport`, `results_status`, the board,
Genie sync and the Labs tab all keep their current contract.

Timers, per room:

- Station 1: rung 0 → time since order (the patient is on the floor now, this is the urgent
  clock). Rung 2 → time since sent.
- Station 2: rung 2 → **time since sent, unreceived** — the new bottleneck the split makes
  visible. Rung 4 → time in analyzer. Rung 5 → results waiting (existing 15-min amber,
  `UPLOAD_WAIT_AMBER`).

---

## 5. Phase-wise tasks

Each task is small, independently verifiable, and leaves the app working. Run
`npm run format` before committing. There is no test suite — verification is the smoke
scripts plus the click-through in Phase 6.

### Phase 1 — Shared vocabulary (no behaviour change) — ✅ DONE

- **1.1** ✅ `shared/labStages.js` — `LAB_RUNGS` is now the single source of truth: one entry
  per rung carrying its keys (`key` / `bucket` / `filter`), `room`, `rail`, every label
  variant the two screens use, `healthrayAt`, `sampleStatuses`, `advanceTo` / `advanceLabel`
  (Gini order track) and `action` / `actionLabel` / `actionDone` / `actionPast` /
  `actionHint` / `needsPatient` (HealthRay case track). Helpers: `stageIndexOf`, `rungFor`,
  `rungsForRoom`, `markableRungs`, plus the derived tables `LAB_STAGES`, `LAB_SAMPLE_FLOW`,
  `SAMPLE_STATUS_TO_BUCKET`, `BUCKET_TO_STAGE`, `FILTER_TO_TARGETS`, `NEXT_SAMPLE_ACTION`,
  `FLOOR_ACTION_STAGE`, `railForStage`, `LAB_RAIL`.
- **1.2** ✅ `labStation.js` — `SAMPLE_FLOW`, `NEXT_ACTION`, `BUCKET`, `GINI_BUCKET_TO_STAGE`,
  `LAB_GROUPS`, `CASE_STAGE`, `LAB_STAGES`, `FLOOR_STAGE`, `CASE_NEXT_ACTION`, `CASE_ACTIONS`,
  `RAIL` and `RAIL_FOR_STAGE` all deleted as literals and derived from the shared table.
  Three ladders became one. −145 lines.
- **1.3** ✅ `LabStationPage.jsx` — `GROUPS`, `LAB_FILTERS`, `GROUP_TO_STAGE`, `CASE_ACTIONS`
  and `ACTION_LABEL` derived from the same table. −95 lines.
- **1.4** ✅ Verified no behaviour change, three ways:
  1. Every one of the twelve replaced tables asserted `JSON.stringify`-identical to the
     literal it replaced.
  2. `npm run smoke:giniflow-lab` — all checks pass against the live DB.
  3. A throwaway diff harness ran the HEAD `getLabQueue` and the new one side by side over
     three real days × six filter groups: **identical output on all 18**.
     Plus `npm run build` and `prettier --check`.

**Deviation from the original plan:** old task 1.2 ("add `sample_sent` / `sample_received` to
`SAMPLE_FLOW` and `BUCKET`") moved to Phase 2. Phase 1 collapses the three ladders into one
five-rung table and changes nothing else; inserting the two rungs is now a two-entry edit to
`LAB_RUNGS`, which is the whole payoff and belongs with the migration and the API that make
them writable.

### Phase 2 — Backend: the two new rungs — ✅ DONE

- **2.1** ✅ `server/migrations/2026-09-18_lab_room_split_actions.sql` **applied to
  production**. The CHECK now accepts `sample_sent` and `sample_received`; all 22 existing
  `sample_taken` rows survived untouched.
- **2.2** ✅ `server/schemas/index.js` — `giniflowSampleSchema.to` gains `sample_sent` and
  `sample_received`; `giniflowLabCaseActionSchema.action` gains both; both schemas and
  `giniflowStationQuerySchema` gain an optional `room`.
- **2.3** ✅ `shared/labStages.js` — the two rungs inserted, and with them `room`, `handoff`,
  `floorAction`, `statLabel` / `statSub`, a six-step `LAB_RAIL`
  (Ordered · Collect · Send · Receive · Process · Upload) and the helpers `visibleRungs`,
  `roomOwns`, `floorActionRungs`, `CASE_ACTION_VERBS`, `ACTION_PAST_LABEL`.
  `labStation.js` — `healthrayStage()` now maps `received_on` to the **`received`** rung
  (§2.4), `canHaveReport()` opens at `processing`, and `stepsFor()` / `labSteps()` both come
  off the shared rail.
- **2.4** ✅ R2 enforced in `advanceSample()` and `markLabCaseAction()` via `assertRoomOwns()`
  — 403 when a room writes a rung it does not own. `room` defaults to `null` (the combined
  view), which may still write anything.
- **2.5** ✅ `getLabQueue(date, q, db, { group, room })` — buckets, counts, `stages` and
  `stageCounts` all built from the ladder rather than five hardcoded keys; `room` narrows to
  `visibleRungs(room)`, giving Collection rungs 0–2 and Processing rungs 2–6 with the
  deliberate overlap at `sent`.

**Two behaviour changes worth knowing about**, both intended:

1. ~~The "✓ Results done" button is gone.~~ **Reversed — see "Where the results gate belongs"
   below.** Collapsing `results` into the upload was a misreading of "reports ready and
   uploaded": that is one STAGE with two acts, not one act.
2. **The rail grew from four steps to six.** `smoke-giniflow-lab.mjs` asserted `length === 4`;
   it is now ladder-driven (`LAB_RAIL.length`) so it will not need editing again.

**Task 6.1 pulled forward.** `server/scripts/smoke-lab-rooms.mjs` (`npm run smoke:lab-rooms`,
no database needed) already asserts the room rules: the two rooms partition the ladder with
exactly the `sent` overlap, every rung past `ordered` is owned by exactly one room, `ordered`
carries no action, `processing` reaches the report in one step, and `results_ready` is
recorded but never offered. 18 checks, all passing.

**Regression sweep:** `smoke-giniflow-` lab, lab-results, mo, journey, manager, queue,
reception all pass. Two failures are **pre-existing and unrelated** — `http`'s "nurse may
read the board" (the nurse role has never held `GINIFLOW_BOARD`, in HEAD or the working
tree, so that assertion has been wrong for a while) and `doctor`'s "timing fills in the clock
time it means" (medicine timing, likely tied to the in-flight medicine-catalog work).
Neither touches the lab ladder. `npm run build` and `npm run format:check` clean.

### Phase 4 — Downstream consumers — ✅ DONE (moved ahead of Phase 3)

Done early because these are the silent breakages and they are cheap to verify now.

- **4.1** ✅ `board.js` — `LAB_HINT` and `LAB_SUBTITLE` gain both statuses; the two
  `["sample_collected","processing","results_ready"]` membership arrays replaced by a derived
  `DRAWN_STATUSES`, so a sent-but-unreceived tube reads `collected` and `atLab` instead of
  the card claiming the patient left without giving a sample.
- **4.2** ✅ `moStation.js` — the `array_position` ladder is now built from `LAB_SAMPLE_FLOW`;
  `UNCOLLECTED` derived from the `pending` rung.
- **4.3** ✅ `journey.js` — the collected-or-beyond `IN` list derived from the ladder.
- **4.5** ✅ `MoStationPage.jsx` — `LAB_STAGE` gains "sent to the lab" and "received at the
  lab"; `sample_collected` reworded to "sample taken, not sent yet".
- **4.4** ⏳ `doctorStation.js` / `receptionStation.js` / `labResults.js` / `demo.js` — their
  predicates are all `<> 'uploaded'`, which stays correct; `demo.js` does not yet seed the
  two new rungs.

### Phase 3 — API surface — ✅ DONE

- **3.0** ✅ `lab_admin` exists — `ROLES.LAB_ADMIN`, its `ROLE_CAPABILITIES` block (the `LAB`
  set minus collection, plus `GINIFLOW_STATION_LAB_PROCESS`, and carrying `GINIFLOW_VIEW`),
  and the `LoginPage.jsx` `ROLE_GROUPS` entry. `normalizeRole("lab_admin")` resolves, and
  `verify-rbac.mjs` reports the same 2 pre-existing nurse/FLOW_STATION failures as HEAD — no
  new RBAC regressions.
- **3.0b** ✅ The account move, done. The floor already has an account literally named **"Lab
  Admin" (doctor id 17, role `lab`)** — the analyzer bench, misfiled under the collection
  role. One row:
  ```sql
  UPDATE doctors SET role = 'lab_admin' WHERE id = 17;
  ```
  `Lab Tech 1` (18) stays `lab`; the two `tech` accounts (ECG, X-Ray) keep collection, which
  is the access they had before. Verified live afterwards: `lab_admin` opens only the
  processing room, is refused both collection rungs, owns receive/process/results, may type
  results and upload, and cannot override a case report.
- **3.1** ✅ `GINIFLOW_STATION_LAB_COLLECT` → `lab`, `tech`, `coordinator`, `admin`;
  `GINIFLOW_STATION_LAB_PROCESS` → `lab_admin`, `coordinator`, `admin`. `GINIFLOW_STATION_LAB`
  is unchanged and still gates every pre-existing endpoint, so nothing that worked before
  needs a new grant.
- **3.2** ✅ `?room=` on the queue, `room` on `/advance` and `/case/:caseNo/action`.
  **The room is derived from the ROLE, not read off the request** — see the security note
  below.
- **3.3** ✅ `stationSummary.js` gains `lab_collect` (to collect · to send) and `lab_process`
  (to receive · to upload), gated by the new capabilities so a tile only appears for a room
  the role may open. Verified live on 2026-09-09.

**Security note — an escalation caught during implementation.** The first cut gated each
route on whichever room the _request_ named, falling back to the umbrella capability when
none was given. That made the split advisory: a collection technician could simply omit
`room`, land on the combined view, and mark a tube "processing" from the wrong bench — the
floor losing track of where a sample physically is, which is the whole thing the split
prevents. `attachLabRoom` now computes the room from the caller's capabilities: a role
holding one room is pinned to it whatever it asks for, a role holding both may narrow or
work the whole day, and asking for a room you do not hold is a 403.

**Task 6.3 pulled forward.** `server/scripts/smoke-lab-room-gate.mjs`
(`npm run smoke:lab-room-gate`, needs the API running) exercises this over HTTP against real
accounts: each room role opens its own room, is refused the other, and **still gets only its
own room when it omits `room` entirely**; the write side refuses a cross-room `advance` with
403 while its own rung passes the room rule; admin keeps the combined view and may narrow to
either; a role with no lab access is refused outright. All passing — `lab_admin` checks skip
until 3.0b runs.

### Phase 5 — Frontend: the two rooms — ✅ DONE

- **5.1** ✅ `src/components/giniflow/lab/LabRoom.jsx` — the whole station body, moved out of
  the page (`git mv`, so history follows) and parameterised by `room`. Groups, filter chips,
  stat tiles and both end columns are derived from `visibleRungs(room)`; only the wording of
  the two end columns is per-room, in one `ROOM_COPY` table.
- **5.2** ✅ `LabCollectionStationPage.jsx` → `<LabRoom room="collection" />`. Opens on
  "📞 To call — test ordered", closes on "📤 Sent to the lab". Keeps the in-a-room /
  left-the-floor groups — collection is the only step that needs the patient present. **No
  upload drop zone**: a Gini order can never reach `processing` here, and the HealthRay case
  pane's admin drop zone is suppressed outright (`canUploadHere`).
- **5.3** ✅ `LabProcessingStationPage.jsx` → `<LabRoom room="processing" />`. Opens on
  "📥 Inbox — sent, not received", closes on "✅ Reports uploaded", carries the drop zone,
  `LabResultsForm` and the three-way done split. No patient-presence gating — a tube at the
  bench is worked whether or not its patient is in a room.
- **5.4** ✅ Both routes added through `lazyWithRetry`; `/giniflow/station/lab` keeps the
  combined page.
- **5.5** ✅ `routes.js` maps each path to its capability.
- **5.6** ✅ Two launcher tiles (🩸 Lab 1 — Collection, 🔬 Lab 2 — Processing); the existing
  lab tile reworded to "Whole day, both rooms".
- **5.7** ✅ `useLabQueue(date, q, group, room)`, room in the query key.

**One gap found and closed.** `attachLabRoom` pins a single-room role to its own bench even
on the combined screen — so a collection technician opening `/giniflow/station/lab` would
have been shown five analyzer counters reading zero. The page now lays itself out from
`data.room ?? room`, the server's answer, so a pinned role gets the collection screen
whichever URL it arrived on.

**Verified end to end** (API running, real accounts): the combined queue returns all seven
buckets, `?room=collection` returns `pending, collecting, sent`, `?room=processing` returns
`sent, received, processing, ready, uploaded` — the handoff overlap present in both, as
designed. `smoke:lab-rooms` grew a frontend half asserting each page's capability and who may
open it (30 checks); `smoke:lab-room-gate` and `smoke:giniflow-lab` still pass; build and
`format:check` clean.

**Gap found on the floor (post-5.3).** Opening a hospital-lab case in **Lab 1** showed
"Enter results — values the doctor can trend" with a full row per test. Typing values is the
analyzer bench's work: the collection room has not run anything, so the form offers numbers
that do not exist and puts them in front of the wrong person, which is the reason there are
two rooms at all. 5.2 had suppressed the report drop zone but not the results form — one
guard, applied in one place, missing from the other.

Both panes now share one rule, `atTheBench` (`room !== "collection"`), covering the typed
results form, the admin report drop zone, the Gini order's upload zone and the "No report
file yet" hint. "Report file stored" still shows in both rooms — that a report exists is
worth knowing wherever you are standing.

Worth noting for the floor: a hospital-lab case has **no buttons on its card**. The card is
one big button that opens the detail pane, and every action lives in the pane — which is why
clicking a case appears to "open a form". That is by design and predates the split.

**Second gap found on the floor — duplicate rows in the results form.** Case 19741 in Lab 2
offered seven rows for six ordered tests: _DHEA Sulphate_ three times and _Potassium, Serum_
twice, with identical units and ranges. Pre-existing, from `32-LAB-TYPED-RESULTS-PLAN`, not
caused by this split — but it is on the analyzer bench's screen, so it is fixed here.

Cause: `lab_results.canonical_name` is not canonical. The column holds `DHEA Sulphate` (143
rows), `DHEA sulphate` (2) and `DHEA SULPHATE` (1) as three separate values, and
"Potassium, Serum" lives under both `potassium,_serum` (806) and `Potassium` (4138).
`suggestionsForTests` deduped by comparing that column literally, so each spelling claimed
its own row and burned the `PREFILL_PER_TEST` budget.

Fixed at the display layer, not by rewriting stored data: the claim is now keyed on a
flattened name (lowercased, punctuation and spaces stripped) of **both** the canonical name
and the displayed label — two rows a technician cannot tell apart are a duplicate whatever
the column underneath says. Ordering was already `seen DESC`, so the surviving spelling is
the one the lab actually uses. Case 19741 drops 7 rows → 4, case 19754 7 → 6.

**Third gap — results and upload were offered before anything had been run.** Case 19741 sat
at **Received** (Process still the live step) and the pane offered both "Enter results" and
"Upload report". There is nothing to type and no file to attach: the tube is on the bench,
not in the analyzer.

Both controls were gated at `collected` — the results form on `c.collected`, the drop zone on
`canHaveReport`, which read `healthrayStage >= collected`. They are now one rule at one bar:

```
canHaveReport = stageIndex(c) >= stageIndexOf("processing")
```

`stageIndex` is already the max of HealthRay's account and the floor's, so a case HealthRay
has signed out or saved results for still clears it however little the floor recorded — the
"four identical timestamps" case the old comment was protecting. What no longer clears it is
a sample merely collected, sent, or received. The Gini-order form moved from `collected` to
`processing` to match. Across today's cases: every `reported` case keeps both controls, every
`received` one loses them until somebody clicks ⚙️ Start processing.

**Also fixed (the open item above is now closed).** A test with no reporting history gets a
blank fallback row carrying the name it was ordered under, so `ALDOSTERONE PRA (DRC)`,
`METANEPHRINES, FREE, PLASMA` and `CREATININE EGFR , Serum` can be typed in directly instead
of vanishing from the form. Skipped when another test on the same case already covers that
name, so the fallback cannot become a duplicate itself.

### Phase 6 — Test, find gaps, fix — ✅ DONE (bar the browser click-through)

Three smoke scripts now cover the split, all registered in `server/package.json`:

| Script                          | What it proves                                                                                                                                                                              | Needs    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `npm run smoke:lab-rooms`       | The ladder and the page gating — room partition, ownership, "ordered" has no action, each page's capability and who may open it                                                             | nothing  |
| `npm run smoke:lab-steps`       | Every step of both rooms in order against a **synthetic case inside a rolled-back transaction** — sequencing, the handoff exception, room refusals, undo, and that the case leaves no trace | DB       |
| `npm run smoke:lab-room-access` | The full HTTP access surface — every endpoint × every role × both rooms                                                                                                                     | DB + API |

**Four gaps found by the audit and fixed.**

1. **Extra access — four write endpoints had no room rule at all.**
   `POST /giniflow/lab/:orderId/results`, `POST /giniflow/lab/case/:caseNo/results`,
   `POST /giniflow/stations/lab/:orderId/report` and
   `POST /giniflow/stations/lab/case/:caseNo/report` were gated on the umbrella
   `GINIFLOW_STATION_LAB`, which `lab` and `tech` both hold — so a collection technician
   could POST typed results or a report straight to the API and the room split would have
   been a matter of which buttons they were shown. All four now take `benchGate`
   (`GINIFLOW_STATION_LAB_PROCESS`). Reads (`GET` results, `test-names`) stay open to both
   rooms.
2. **Authorisation after validation.** The case-report override checked `role !== "admin"`
   _inside_ the handler, after `validate`, so a coordinator with a malformed body got 400
   before 403 — learning the shape of a request they may not make. It is now
   `reportOverrideGate`, a middleware, ahead of validation like every other route here.
3. **Broken and fragile step guards.** `ACTION_NOUN` still listed three verbs, so the two new
   ones produced "Record undefined first"; and `want` was inferred from a position in
   `CASE_ACTIONS` rather than asked of the ladder. Both now derive from `LAB_RUNGS`. An
   unknown case number also returned 500 rather than 404.
4. **A tube Lab 1 forgot to send was invisible to Lab 2.** The worst of the four: with
   `sent` as the only shared rung, a sample marked collected and physically carried over —
   but never tapped "sent" — appeared on no Lab 2 screen at all, so the room holding it could
   not record receipt. Search could not reach it either, because the queue is room-filtered.
   `collected` is now a **watched** rung for the analyzer room: Lab 2's inbox reads
   "📥 On the way from collection" and covers both `collected` and `sent`. Watching is not
   owning — the collection room still owns both rungs, and Lab 2 still cannot mark a
   collection. This is what makes the handoff exception in `markLabCaseAction` reachable from
   the screen rather than only from the API.

**The resulting shape, verified live:**

```
Lab 1 · Collection   stages  pending, collected, sent
                     chips   To call · Collected · Sent
                     layout  [📞 To call — test ordered] … 🧪 Sample collected … [📤 Sent to the lab]

Lab 2 · Processing   stages  collected, sent, received, processing, results, reported
                     chips   Collected · Sent · Received · Processing · Ready · Done
                     layout  [📥 Inbox — on the way from collection] … 🔬 Received · ⚙️ Processing ·
                             ✅ Results ready … [✅ Reports uploaded]
```

**Access matrix, as enforced (not as drawn):**

|               | queue           | collect/send | receive/process/results | type results · upload | override a case report |
| ------------- | --------------- | ------------ | ----------------------- | --------------------- | ---------------------- |
| `tech`, `lab` | collection only | ✅           | ❌ 403                  | ❌ 403                | ❌ 403                 |
| `lab_admin`   | processing only | ❌ 403       | ✅                      | ✅                    | ❌ 403                 |
| `coordinator` | either or both  | ✅           | ✅                      | ✅                    | ❌ 403                 |
| `admin`       | either or both  | ✅           | ✅                      | ✅                    | ✅                     |
| `nurse`       | ❌ 403          | ❌           | ❌                      | ❌                    | ❌                     |

Omitting `room` does not widen any of it: a role holding one bench is pinned to it.

**Not done:** 6.2, the browser click-through. The Chrome extension has been unavailable for
this whole piece of work, so no screen has been seen rendered — layout is verified only
through the response shapes and the code.

### Demo data — `npm run seed:lab-rooms`

`server/scripts/seed-lab-rooms-demo.mjs` puts fifteen patients on today's floor, one per rung
on **both** tracks — a Gini order raised on this floor and a HealthRay case arriving through
the lab sync — plus the three cases the collection room has to handle: an unpaid order, a
patient somebody else has in a room, and a patient who went home with their sample untaken.

Everything is prefixed `ZZLAB_` / `ZZLAB-` and nothing else is touched, so
`npm run seed:lab-rooms -- --clean` removes exactly what the seed made — including the
`lab_cases` and `giniflow_lab_case_actions` rows, which `cleanDemoDay` does not cover. The
seed cleans before it seeds, so running it twice cannot leave two of anybody.

Where they land, verified:

```
Lab 1  pending    Ordered · Unpaid · Case Pending · Left The Floor · In A Room
       collected  Collected · Case Collected
       sent       Sent · Case Sent

Lab 2  collected  Collected · Case Collected          ← inbox
       sent       Sent · Case Sent                    ← inbox
       received   Received · Case Received
       processing Processing
       results    Results Ready
       reported   Uploaded · Case Reported
```

**Two bugs the demo data found immediately**, both fixed:

1. **Each room was offered the other room's next step.** A sample at `sent` showed
   "✓ Mark sample received" in Lab 1, and a case at `collected` showed "📤 Mark sent to lab"
   in Lab 2 — buttons that answer 403 on tap. `nextAction` was computed from the ladder alone,
   with no idea which room was asking. It is now room-scoped on both tracks.
2. **Lab 2's inbox offered nothing on a `collected` tube** — precisely the row the handoff
   exception exists for. The offer now walks forward to the first rung the room owns, so the
   analyzer bench is offered "✓ Mark sample received" on a tube the collection room never
   marked sent. That is what makes the exception in `markLabCaseAction` reachable from a
   screen rather than only from the API. The same walk steps over `results`, which is what
   keeps Process → Upload one tap.

`smoke:lab-rooms` now asserts, for every rung × both rooms, that the offered step is one that
room owns.

### The case timeline was still HealthRay's four clocks

`hr-times` in the case pane listed Registered · Sample collected · Received by lab · Reported
— hardcoded, and HealthRay's alone. So the two rungs the split added had no line on it: a
tube the collection room had sent showed its time on a hint _underneath_ the strip while the
strip itself read "—" against every lab step.

The timeline is now built from `LAB_RUNGS`, one row per rung, taking HealthRay's clock where
it has one (`healthrayAt`) and the floor's own action where it does not. Seven rows:
Registered · Sample collected · **Sent to lab** · **Received by lab** · Processing started ·
Results done · Reported. The strip is `repeat(auto-fit, minmax(110px, 1fr))`, so it wraps
rather than overflowing.

A rung the case is demonstrably past but carries no timestamp shows **✓** rather than "—",
generalising the rule that was already applied to collection alone: the fact and the time are
two claims and only one of them is missing. Verified on the demo cases:

```
Demo Case Received   Registered ✓  Collected 11:03  Sent 11:13  Received 11:23  …
Demo Case Reported   Registered ✓  Collected ✓      Sent ✓      Received 09:53  Processing ✓
                     Results 11:43  Reported 11:53
```

`smoke:lab-rooms` asserts every rung carries a `timelineLabel`, and names the two that were
missing.

### Where the results gate belongs — a decision I got wrong twice

Reading "3. reports ready and uploaded" as a single act, I removed the "results ready" button
and let the upload carry the rung. That forced the question of when the form and drop zone
appear, and I moved the bar twice before the floor put it in the right place:

| Bar                    | What the floor saw                                       | Verdict                                                |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `collected` (original) | The form opened on a tube that had only just been drawn  | Wrong — nothing had been run                           |
| `processing`           | The form opened the moment a sample went on the analyzer | Still wrong — a tube on the machine has no numbers yet |
| **`results`**          | The form opens when somebody says the values are out     | Right                                                  |

The third bar only works if there is a way to SAY the values are out — which is the button I
had removed. So it is back, on both tracks: `processing → ✓ Results ready → 📤 Upload report`.

That is what "reports ready and uploaded" always meant: one stage, two acts. HealthRay still
clears the bar on its own (`result_saved_on` and `reported_on` both land past `results`), so a
synced case opens the form with nobody tapping anything.

The lesson worth keeping: a state nobody can enter is not a state. Collapsing the rung left
`results` reachable only by HealthRay, and every gate built on top of it then had to guess.

### The seeder wiped itself

The first version flagged its visits `is_demo = TRUE`. `cleanDemoDay` deletes **every** visit
carrying that flag regardless of which seeder wrote it, so the next smoke run took the whole
demo set with it — cases survived, visits and their lab orders did not. Nothing in the
application reads `is_demo`; it is purely the other seeder's cleanup tag. The visits no longer
carry it, and this seeder owns its own cleanup, scoped to the `ZZLAB_` prefix, which cannot
reach anybody else's rows. Verified: the full smoke suite now runs with the demo set intact
(15 patients, 15 visits, 8 orders before and after).

### Closing a case — "✓ Mark done"

Two bugs sat behind this, both proven against a synthetic case before anything was changed:

1. **Uploading a report did not close the case.** A case with a stored PDF _and_ a
   `report_uploaded` action still read stage `results` — rail stuck on "Upload", pill still
   "Results done", still counted "1 still out". The `reported` rung was `floorAction: false`,
   so `report_uploaded` never entered `FLOOR_ACTION_STAGE` and `floorStage()` capped at
   `results`. Only HealthRay's own `reported_on` could ever close a case, and for a report
   uploaded through Gini that timestamp may never come.
2. **Typed values told the MO but not the lab.** `saveCaseResults` calls
   `markCaseResultsReady`, flipping the visit to "Results ready" for the MO and consultant
   while the lab's own board went on showing the case as outstanding work. One case, two
   screens, opposite stories. The ORDER track never had this — `saveResults` calls
   `advanceSample(to: "uploaded")` — so this was the case track missing parity, not new
   behaviour being invented.

**The rule the floor set:** a case may be closed by hand at any point, provided there is
something to show for it — a report file **or** typed values, either one, never neither.

- `reported` becomes a real rung: `floorAction: true`, labelled **"✓ Mark done"**. An upload
  now closes the case on its own, and the button exists for the values-only path.
- `canMarkDone = hasReport || hasValues`, computed server-side (`hasValues` is an EXISTS on
  `lab_results.lab_case_no`). The queue withholds the action when neither is true, so the
  screen never shows a button that would be refused.
- `markLabCaseAction` re-checks the same evidence against the record and answers 409 —
  _"Nothing to mark done — type the values in, or attach the report, before closing this
  case"_. Hiding the button is not the rule; this is.
- Closing also calls `markCaseResultsReady`, so the lab board and the MO board agree. Still
  guarded, so a patient with a second sample outstanding stays amber.

Verified on three synthetic cases: no evidence → no button and a 409; PDF only → button,
allowed; values only → button, allowed. `smoke:lab-steps` pins all three.

**A fourth drift of the same kind, found by the audit:** `giniflowLabCaseActionSchema.action`
was a hand-written enum and did not know the new verb. Because validation runs _before_ the
room gate, a collection technician POSTing `report_uploaded` got **400** rather than **403** —
a refusal disguised as a malformed request, which sends whoever debugs it to the wrong place.
The enum now comes from `CASE_ACTION_VERBS`.

### The report: view, replace, remove — and then settled

Uploading and finishing are two different statements, and the first version of "Mark done"
conflated them: `uploadLabCaseReport` wrote the `report_uploaded` action itself, so with that
rung made floor-recorded the case slammed shut the instant a file landed. There was no window
in which to open the report, see it was the right one, and fix it.

The upload no longer writes that action. It stores the file, files the chart row and still
tells the MO — what it no longer does is decide the lab is finished. The FILE is the evidence
that unlocks the button; the TAP is what ends the case.

| While the case is open                  | Once marked done |
| --------------------------------------- | ---------------- |
| 📄 View report · 🔁 Replace · 🗑 Remove | 📄 View report   |

- **View** opens `PdfViewerModal`, the viewer the rest of the app already uses. The case now
  carries `reportDocId` — the `documents` row its file landed on — so nothing here invents a
  second way to look at a PDF.
- **Replace** is the existing upload, which already handles an existing file.
- **Remove** (`DELETE /giniflow/stations/lab/case/:caseNo/report`) takes the chart row, the
  case's pointer and the stored object together — leaving any one behind is how a case ends up
  claiming a report nobody can open. Bench-gated, like the upload it undoes.
- **After done it refuses**: _"This case is marked done — undo that first if the report needs
  replacing."_ At that point the report is what the MO and the consultant were told about, and
  pulling it out from under them silently is not this screen's to do. Undo "Done" first, which
  reopens the window.

Verified across the whole lifecycle: upload → `results`, `canMarkDone: true`, "✓ Mark done"
offered, `reportDocId` present; mark done → `reported`, no further action; delete refused;
undo done → delete removes the document row, clears the case pointer and drops the object.

### The analyzer bench could not file a report

Signed in as **Lab Admin**, the hospital-case pane had no "Upload report" section at all —
so the role that exists to run the analyzer bench could not perform the last step of its own
ladder. The same case opened as `admin` showed it.

Attaching a file to a HealthRay-run case overrides the sync that normally fetches it, so it
was deliberately restricted — but the restriction was written as `role === "admin"`, back when
the only lab roles were collection-side and "admin" was the nearest available stand-in for
"somebody accountable". `lab_admin` is now that somebody, and "reports ready and uploaded" is
its third step.

The gate is now the **bench capability** on both sides — `canFileReport` on the screen,
`benchGate` on the route — and the separate `reportOverrideGate` is gone, because
`GINIFLOW_STATION_LAB_PROCESS` already means exactly "the room accountable for the report".
The same rule now covers removing one. Verified over HTTP:

|                              | attach | remove |
| ---------------------------- | ------ | ------ |
| `lab_admin`, `admin`         | ✅     | ✅     |
| `lab`, `tech`, `coordinator` | 403    | 403    |

## 6. Risks

| Risk                                                                            | Mitigation                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1.3 is a large pure refactor of a 1286-line file                          | Do it alone, verify the current screen is unchanged before Phase 2                                                                                         |
| Two more rungs = more clicks for a bench that already skips `phlebotomy_status` | Station 2's "received" doubles as the inbox clear; if the floor still skips it, "Start processing" implies receipt — decide after 6.2, do not pre-optimise |
| An enumeration missed in Phase 4 silently drops a sample from a board           | 6.4 re-runs the grep as an explicit task                                                                                                                   |
| Production DB                                                                   | One additive `ALTER … CHECK`, applied alone, output read                                                                                                   |
| New `lab_admin` role leaves the analyzer bench locked out mid-day               | Ship the role and move its accounts (3.0/3.0b) before Station 2 goes live; `GINIFLOW_STATION_LAB` still gates the combined view as a fallback              |

## 7. Open questions

- ~~**O1** Which role sits at which bench?~~ **Answered:** Station 1 → `lab` + `tech`;
  Station 2 → a new `lab_admin` role (§3.5, §3.6).
- ~~**O2** Should `/giniflow/station/lab` stay as a combined view?~~ **Answered: no.** The
  floor wants two stations, not three. The launcher shows only 🩸 Lab 1 — Collection and
  🔬 Lab 2 — Processing; the old path is now a redirect to whichever room the signed-in role
  can open (collection for anyone holding both), kept only so pre-split links and bookmarks
  still land somewhere sensible. The server's roomless `getLabQueue` mode still exists — it
  is simply no longer a screen.
- **O3** Is "sample sent to lab" a per-tube act or a per-batch act? The plan models it
  per-case. If the floor sends racks, a "send all collected" bulk action belongs in 5.2.
