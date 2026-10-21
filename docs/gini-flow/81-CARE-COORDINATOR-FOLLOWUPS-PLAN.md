# 81 — Care coordinator: referral and next-visit follow-ups

Status: built (20 Oct 2026). **Run the migration on production before deploying** (§7), then switch the worker job on with `CARE_FOLLOWUPS_COLLECT=1`. See "As built".

## 1. Ask

> "Add one more coordinator who manages all of this: the list of patients a consultant, MO or the Chief referred to a department, specialty, consultant, lab test or machine test. They call the patient and book the appointment if we have that department, specialty, consultant or test. If it isn't available in our hospital, they write a remark with the reason. They track and manage those patients. Make a complete plan with testing, and fix any bug, gap or issue found."

Today nobody owns these patients after they leave. The prescription prints "Referrals & tests for next visit", and that's where it ends.

## 2. Where the items come from today (checked in code, 20 Oct)

| #   | Source                                                                                                                                | What it holds                                                                    | Stored as                                                                                    | Status tracking                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| S1  | **Floor referrals**: `giniflow_referrals` (plan 19, Referrals station)                                                                | Specialty, to-doctor, hospital, urgency, reason, tests, letter, appointment date | Rows per visit; one per (visit, specialty)                                                   | `created → letter_generated → appointment_booked → completed`                                               |
| S2  | **Scribe referrals**: `referrals` (consultation screen, `POST /visit/:id/referral`)                                                   | Doctor name, speciality, reason, appointment                                     | Rows                                                                                         | `status` defaults to `pending` and **nothing ever changes it**                                              |
| S3  | **HealthRay notes**: lines like "Refer to eye OPD" or "Advise nephrology review"                                                      | Free text                                                                        | **Not stored.** `referralsFromNote()` parses the latest note each time a prescription prints | None                                                                                                        |
| S4  | **Next-visit tests, Scribe**: `giniflow_lab_orders` with `urgency = 'next_visit'` (consultant finalise, MO)                           | Test names, lab or machine                                                       | Rows                                                                                         | Carried onto the next visit when the patient returns (`carryOver.js`); nothing notices if they never return |
| S5  | **Next-visit tests, HealthRay**: `appointments.healthray_investigations` and `healthray_follow_up` (date or timing), `follow_up_with` | Tests, follow-up date, "follow up with …" (MO, Chief, a consultant)              | JSON on the appointment                                                                      | None                                                                                                        |

**What GHM offers** (needed for "if we have it"):

- consultants: `doctors` with role consultant, active, and their `specialty`;
- tests: `giniflow_test_catalog` (category `lab` or `machine`) priced through `service_items`, where `is_outsourced` marks tests sent out.

### Gaps and bugs found while checking (fixed by this plan unless noted)

- **G1. S3 referrals exist only on paper.** They are re-parsed at print time and never saved. **Not fixed here:** the user chose to leave HealthRay notes out (Q2), so S3 stays print-only.
- **G2. S2's status is dead.** Every Scribe referral reads `pending` forever, so its status can't be trusted. Fixed: the coordinator's record carries the real status; S2 is read, never written to.
- **G3. Next-visit tests have no owner.** A patient told to come back for HbA1c who never books is invisible until they walk in by themselves. Fixed: S4 and S5 become worklist items with a due date.
- **G4. Unknown availability.** `doctors.specialty` is free text ("Endocrinology", "DM Endo", "Endocrinologist"), so "do we have it?" can't be answered by matching words. Fixed: a small shared alias list (`shared/specialties.js`) maps the words doctors write to one specialty. Anything unmatched shows "Check availability" instead of a wrong guess.
- **G5. Schema drift.** `referrals` is created by `CREATE TABLE IF NOT EXISTS` inside `server/routes/visit.js` at runtime, not by a migration, so a fresh database depends on a route having run. Fixed: a migration that is a no-op where the table exists. The runtime create is left in place, so nothing changes for production.
- **G6. S1 is external-only.** The Referrals station is built around a letter to an **outside** doctor. When GHM itself has the specialty, there's no path to book internally. Fixed by the worklist's **Book here** action; S1 rows still open in the Referrals station for letters.
- **G7. One floor referral per specialty per visit** (a unique index). Not a bug; it is kept, and noted so the collector never assumes more.

## 3. Questions — please answer before build

| #   | Question                    | Recommended                                                                                                                                                                                                                                 | Other choice                                                        |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Q1  | **Who is the coordinator?** | **Decided: a new login**, role `care_coordinator` (Follow-ups page, patient lookup, GHM booking form; nothing clinical). Name still to give.                                                                                                | —                                                                   |
| Q2  | **Which sources?**          | **Decided: structured only**: S1, S2, S4, S5. HealthRay note lines (S3) are left out.                                                                                                                                                       | —                                                                   |
| Q3  | **How far back?**           | **Decided: from the day it goes live**; nothing older is loaded.                                                                                                                                                                            | —                                                                   |
| Q4  | **Booking a consultant**    | **Decided (as recommended):** Reuses the **GHM ops booking**: a Scribe appointment, prefilled with patient, consultant, visit type "Follow Up" and the reason as the note. The OBT team sees it like any booking.                           | A separate quick-book form (a second way to book, not recommended). |
| Q5  | **Booking a test**          | **Decided (as recommended):** A GHM booking with visit type **Investigation** against **Dr. Hospital Admin** (the existing tests-only route), tests in the note, and the **Home collection** tick available (plan 78).                      | Only add a remark, with reception booking it.                       |
| Q6  | **Not available here**      | **Decided (as recommended):** A reason is required (No such specialist at GHM · Test not done at GHM · Outsourced — patient prefers outside · Other + text). Optional **Refer outside**: opens the existing Referrals station for a letter. | Remark only.                                                        |
| Q7  | **Call results vocabulary** | **Decided (as recommended):** **Reuse `shared/callStatuses.js`** (Not picked up, Busy, Call later, …), the same words the OBT team uses.                                                                                                    | A separate list.                                                    |

## 4. The flow

1. **Items arrive.** A consultant, MO or the Chief refers or orders something for the next visit (S1–S5). Within 15 minutes the collector adds one worklist item per patient per thing: "Ophthalmology", "Dr Rahul Katyal", "HbA1c + Lipid profile", "ECHO".
2. **Availability is worked out** automatically:
   - **Available at GHM** (a consultant of that specialty, or the test in our list);
   - **Outsourced** (the test is sent out);
   - **Not at GHM**;
   - **Check availability** (the wording couldn't be matched).
3. **The coordinator works the list.** By default it shows open items, the most overdue first. They call the patient and log each attempt with the shared call results.
4. **Outcome**, one per item:
   - **Booked here:** opens the GHM booking, prefilled. On save, the item shows the appointment date and slot.
   - **Not available here:** a reason is required, and optionally a letter through the Referrals station.
   - **Patient declined:** reason required.
   - **Done elsewhere / already done:** a note is required.
   - **Unreachable after 3 attempts:** stays open, flagged "3 tries — no answer".
5. **Closing by itself:**
   - a booked consultant item becomes **Done** when that appointment is completed;
   - a test item becomes **Done** when a result for that test arrives (Scribe lab results or a HealthRay case) on or after the order date;
   - an item whose patient walks in and gets it anyway closes the same way, without a call.
6. Every change is kept in the item's history (who, when, what, note) and can't be edited.

## 5. Server

### 5.1 Tables — migration `2026-12-06_care_followups.sql`

```sql
CREATE TABLE IF NOT EXISTS care_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id INT NOT NULL REFERENCES patients(id),
  source TEXT NOT NULL CHECK (source IN ('gf_referral','rx_referral','next_visit_order','hr_follow_up')),
  source_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('consultant','specialty','mo','chief','lab_test','machine_test','other')),
  target TEXT NOT NULL,
  detail TEXT,
  matched_doctor_id INT REFERENCES doctors(id),
  matched_specialty TEXT,
  matched_tests TEXT[],
  availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('in_house','outsourced','not_available','unknown')),
  ordered_by_id INT REFERENCES doctors(id),
  ordered_by_name TEXT,
  ordered_on DATE NOT NULL,
  due_on DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','booked','done','not_available','declined','closed')),
  outcome_reason TEXT,
  booked_appointment_id INT REFERENCES appointments(id),
  attempts INT NOT NULL DEFAULT 0,
  last_call_status TEXT,
  last_call_at TIMESTAMPTZ,
  assigned_to INT REFERENCES doctors(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_care_followups_open ON care_followups (status, due_on);
CREATE INDEX IF NOT EXISTS idx_care_followups_patient ON care_followups (patient_id);

CREATE TABLE IF NOT EXISTS care_followup_events (
  id BIGSERIAL PRIMARY KEY,
  followup_id UUID NOT NULL REFERENCES care_followups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('call','status','note','booked','auto_done')),
  call_status TEXT,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  actor_id INT REFERENCES doctors(id),
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_care_followup_events_item ON care_followup_events (followup_id, at);
```

The events table is insert-only, enforced by a trigger like `billing_audit`, so history can't be rewritten. The same migration adds the `referrals` table definition from G5 (`IF NOT EXISTS`).

### 5.2 Collector — `server/services/careFollowups/collect.js`

- It runs in the **worker** every 15 minutes (on `cronPool`), plus a **Refresh now** button on the page.
- **Idempotent:** it upserts on `source_key`, never overwrites a coordinator's status or notes, and only fills new rows and the availability match. A stopped run continues where it left off.
- **Small batches:** about 100 rows per transaction, with progress logged and a stop on the first error (CLAUDE.md bulk rules). The first run after go-live does a dry run first and reports counts. There is no backfill (Q3): items are only collected from sources created on or after the go-live date, stored as setting `care_followups_since`.
- **Source keys:**

  | Source | Key                   | Notes                                                                                                                                         |
  | ------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
  | S1     | `gf:<referral id>`    |                                                                                                                                               |
  | S2     | `rx:<referral id>`    |                                                                                                                                               |
  | S4     | `nv:<order id>`       | One item per order; lab and machine split by catalogue category                                                                               |
  | S5     | `hf:<appointment id>` | Tests, and `follow_up_with` (MO/Chief/a consultant name) becomes `mo`, `chief` or `consultant`; the due date comes from `healthray_follow_up` |

- **Matching** (`match.js`): specialty aliases (`shared/specialties.js`), consultant names (active doctors, the same name normalisation as the GHM consultant picker), tests (`TEST_MATCHES_SQL`, aliases first). Unmatched → `unknown`.
- **Auto-done pass:** on each run, open or booked items whose booked appointment is `completed`, or whose tests have a result on or after `ordered_on`, become `done`, with an `auto_done` event.

### 5.3 API — `server/routes/careFollowups.js`, all gated by the new `CARE_FOLLOWUPS` capability

| Method | Path                              | Does                                                                                                                                                                                             |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/care-followups`             | List with filters: status, kind, availability, specialty, consultant, ordered by, date range, due (overdue, this week), search (name, file no, phone); paginated, 50 per page; counts per status |
| GET    | `/api/care-followups/:id`         | One item, its history, and the patient's other open items                                                                                                                                        |
| POST   | `/api/care-followups/:id/call`    | Log a call (`call_status` from `CALL_STATUSES`, note); increments attempts                                                                                                                       |
| POST   | `/api/care-followups/:id/outcome` | `not_available`, `declined` or `closed`, with a required reason                                                                                                                                  |
| POST   | `/api/care-followups/:id/booked`  | Links the GHM appointment created through the booking form; status `booked`                                                                                                                      |
| POST   | `/api/care-followups/:id/reopen`  | Back to `open` (wrong outcome); reason required                                                                                                                                                  |
| POST   | `/api/care-followups/refresh`     | Runs the collector now (one at a time; a second press is told "already running")                                                                                                                 |

- Zod schemas sit in `server/schemas/index.js`.
- Errors go through `handleError`.
- Every write records an event in the same transaction.

### 5.4 Permissions (`shared/permissions.js` — both sides)

- **New capability:** `CARE_FOLLOWUPS`.
- **New role `care_coordinator`:** `PATIENT_READ`, `CARE_FOLLOWUPS`, and `OBT_OPS`, so the GHM booking form opens. They are **not** added to the OBT team list (`obtTeam` filters on role `obt`), so OBT call assignments are unchanged.
- **Who else gets it:** admin (ALL), and the floor `coordinator` role gets `CARE_FOLLOWUPS` too.
- **Wiring:** the login page group "Care Coordinator", `ROLE_HOME` and the nav allow-list for the new role, and `/api/care-followups` added to `ROUTE_CAPABILITIES`.
- **Account:** a script `server/scripts/create-care-coordinator.mjs` (name from Q1). You run it in your own terminal, as with ANJALI.

## 6. Screen — `/care-followups` ("Follow-ups")

```text
Follow-ups                                              [Refresh now]  last refreshed 10:42
[Search name, file no or phone]  [Status: Open ▾] [Type: All ▾] [Available: All ▾] [Specialty ▾] [Due: All ▾]

Open 128 · Booked 34 · Not available 12 · Declined 5 · Done 210

Patient                      What                         From / when            Due       At GHM          Calls        Status
Ravi Kumar · P_101750 · 9876… Ophthalmology review         Dr Bhansali · 12 Oct   26 Oct    ✓ Available     2 · Busy     Open      [Call] [Book] [More ▾]
Sunita · P_182235 · 9812…    HbA1c, Lipid profile         MO Dr Arpita · 10 Oct  10 Jan    ✓ Available     —            Open
Anil · P_180824 · 9988…      Retina surgeon               HealthRay note · 9 Oct —         ✕ Not at GHM    1 · Spoke    Not available — "No retina surgeon"
```

- **Row actions:** **Call** (log the result), **Book** (consultant or test, prefilled booking), and **More** (Not available here, Patient declined, Done elsewhere, Reopen, Open referral letter for S1).
- **Patient drawer:** identity, all their open items together (one call can cover three items), the item history, and the latest prescription link.
- **Words, not colour only:**
  - availability badges: "✓ Available", "↗ Outsourced", "✕ Not at GHM", "? Check";
  - overdue rows show "Overdue 5 days".
- **States:**
  - loading skeleton; an empty state per filter ("No open follow-ups match these filters [Clear filters]");
  - error state with Try again; disabled buttons while saving;
  - a toast and the row updating in place after each action.
- **Layout:** a table at 1366 px; cards at 390 px with the name, what, due and status first.
- **Privacy:** phone numbers are shown only on this page and the drawer, never in URLs.

## 7. Safety and rollout (lesson from plans 77 and 78)

- The new tables are read **only** by the new page, API and worker job. No existing screen's query changes, so local dev on the production database can't go empty.
- **Order:**
  1. You run the migration on production.
  2. I confirm read-only that the tables exist.
  3. Deploy.
  4. The first collect runs as a dry run (no backfill, from go-live only) and reports counts.
  5. You approve the real first run.
- The worker job is behind `CARE_FOLLOWUPS_COLLECT=1`, so it can be switched off without a deploy.

## 8. Tests (e2e, test DB only)

`e2e/care/CF01-collect.spec.js` — collector:

1. A source created before the go-live date makes no item (Q3), and a HealthRay note line never makes one (Q2).
2. Each source makes exactly one item with the right kind, target, due date and source key: S1 floor referral, S2 Scribe referral, S4 next-visit lab and machine order, S5 HealthRay follow-up (MO, Chief, consultant, tests).
3. Running twice adds nothing and keeps a coordinator's status and notes.
4. Availability: matched consultant → available; outsourced test → outsourced; unknown wording → check; alias "DM Endo" → Endocrinology.
5. Auto-done: a completed booked appointment, and a lab result after the order date, close their items with an `auto_done` event; a result from before the order date does not.
6. A cancelled referral or cancelled order never makes an item, and an existing item for it closes as `closed` ("Cancelled at source").

`e2e/care/CF02-worklist.spec.js` — screen and API:

1. The care coordinator lands on Follow-ups; the menu shows only their pages; reception, OBT and lab get 403 on the API.
2. The filters, search (name, file no, phone), counts and paging agree with the database.
3. A logged call increments attempts, shows the result and adds an event; three no-answers show the flag.
4. Book a consultant: the GHM booking opens prefilled; after saving, the item is Booked with the date, and the appointment exists with the note.
5. Book a test: an Investigation booking against Dr. Hospital Admin with the tests in the note and Home collection available.
6. "Not available here" without a reason is refused, on screen and by the API; with a reason it shows on the row and in history.
7. Reopen requires a reason, and history keeps both entries; events can't be updated or deleted (trigger).
8. The patient drawer groups all open items of one patient.
9. 1366 px and 390 px: no sideways scroll; the keyboard reaches every action; dialogs trap focus and close on Esc.

Rerun the GHM specs (G01, G03, G23), plan 19's referrals smoke, P4C-13, and G105/G106.

## 9. Files

- **New:**
  - migration `2026-12-06_care_followups.sql`;
  - `server/services/careFollowups/{collect,match,list,actions}.js`;
  - `server/routes/careFollowups.js`;
  - `shared/specialties.js`;
  - `src/pages/care/CareFollowupsPage.jsx` and its drawer, dialogs and CSS;
  - `src/queries/hooks/useCareFollowups.js`;
  - `server/scripts/create-coordinator.mjs`;
  - specs `CF01` and `CF02`.
- **Changed:**
  - `shared/permissions.js`, `server/middleware/auth.js`, `src/config/routes.js`, `src/router.jsx`;
  - `src/pages/LoginPage.jsx` (role group), `src/components/AppLayout.jsx` (menu item);
  - `server/worker.js` (job);
  - the GHM booking form, to accept a prefill and return the new appointment id to the caller.

## 10. Order of work

1. Migration and permissions.
2. Collector and matching, with CF01.
3. API.
4. Page.
5. GHM booking prefill.
6. CF02.
7. Account script.
8. Rollout per §7.

## As built (20 Oct 2026)

- **Migration** `2026-12-06_care_followups.sql`:
  - creates `care_followups` and `care_followup_events`;
  - adds an append-only trigger: a delete is only allowed when it cascades from its follow-up being deleted;
  - turns on RLS and revokes anon and authenticated access;
  - adds the `referrals` table definition (G5, `IF NOT EXISTS`);
  - writes the go-live date to `app_kv` (`care_followups_since`) the first time it runs.
- **Sources built: S1, S2, S4, S5.** S5 holds only the **next-visit tests** from HealthRay (`healthray_investigations`), with the due date taken from `healthray_follow_up` (date, or timing from the visit day).
  - **Change from the plan:** `follow_up_with` is not used. The database describes it as the patient's preparation instructions ("come fasting…"), not the person to follow up with.
  - Plain "come back in 3 months" follow-ups stay with the OBT team.
- **Collector** (`server/services/careFollowups/collect.js`):
  - batches of 100, `ON CONFLICT (source_key) DO NOTHING`, and a dry-run mode;
  - one run at a time per process; no advisory lock, because the job is safe to run twice;
  - re-matches `unknown` test items when the test list changes.
- **Moving items automatically:**
  - booked → done when the visit is completed;
  - booked → open again when that visit is cancelled or the patient doesn't come;
  - open consultant or specialty items → booked or done when a later appointment with that doctor (or a doctor of that specialty) appears;
  - test items → done when a lab case, lab result or floor order for one of the tests appears **after** the order day;
  - next-visit orders → done when carried onto a later visit, or closed when cancelled;
  - every move writes an `auto` event.
- **Matching** (`match.js`, `shared/specialties.js`): doctor names match after removing "Dr"; specialty aliases decide; tests match the catalogue by name, and `is_outsourced` marks outsourced.
- **API:** `/api/care-followups` (list, item, call, outcome, booked, reopen, refresh), guarded by the new `CARE_FOLLOWUPS` capability.
  - Who has it: the floor `coordinator` role and admin. The separate `care_coordinator` role was dropped on 20 Oct 2026 ("merge it with coordinator") and **restored on 21 Oct 2026** ("make it separate from coordinator roles"). `care_coordinator` holds `PATIENT_READ`, `CARE_FOLLOWUPS`, `OBT_OPS`, `GINIFLOW_VIEW` and `GINIFLOW_REFERRALS`, lands on Follow-ups, and its menu is limited to Follow-ups, GHM, Find and the Referrals desk (`/giniflow/station/referrals`, via the stations launcher). The floor `coordinator` no longer holds `CARE_FOLLOWUPS` or `GINIFLOW_REFERRALS` (21 Oct 2026, "remove follow-ups from coordinator and referral also"); admin keeps both. Also on 21 Oct 2026 the care coordinator gained Triage (`GINIFLOW_TRIAGE`), the Flow Coordinator board (`GINIFLOW_BOARD`, `/giniflow/manager`) and the Consultant station (`GINIFLOW_STATION_DOCTOR`); the stations launcher shows them only those four cards with Referrals.
- **Booking** reuses the GHM ops `NewAppointmentModal`, now exported from `GHMPage.jsx`. It gained:
  - prefilled `visit_type`, `notes` and `home_collection`;
  - the new booking returned to the caller;
  - an empty prefilled doctor stays empty instead of quietly becoming the first doctor in the list;
  - a prefilled doctor who isn't in the list (Dr. Hospital Admin) is still shown.
  - Consultant items prefill the matched doctor, or the first GHM consultant of that specialty. Test items prefill Dr. Hospital Admin and the visit type "Investigation".
- **Not built:**
  - the optional **Refer outside** link (Q6);
  - `assigned_to` (one coordinator for now).
- **Account:** `server/scripts/create-care-coordinator.mjs "Full Name"` makes a `care_coordinator` login, run by you in your own terminal. "Coordinator 2" (id 98) was moved to `coordinator` on the merge, back to `care_coordinator` on 21 Oct 2026, and renamed "Care Coordinator" the same day.
- **Tests:** CF01 (7 checks) and CF02 (8 checks) pass, as do `setup/helpers`, `setup/fixtures`, P0-04 and GHM G01, G03, G14 and G23.

## HealthRay note referrals (added 20 Oct 2026)

The user reversed Q2 ("HealthRay notes: No") after seeing a prescription whose only referral — "Advised consult with rheumatologist for hip pain" — lived in Dr. Bhansali's HealthRay note and never reached the list.

- **New source `hr_note_referral`** (label "Referral in HealthRay note"). It reads `appointments.healthray_clinical_notes` from the go-live date with `referralsFromNote` — the same parser the prescription PDF uses, so the list and the printed "Referrals" section agree. Online/tele "consult within …" lines are not referrals.
- **One item per patient per referral sentence.** The key is `hn:<patient>:<hash of the sentence>`, so the same line copied into the next visit's note does not make a second item, and an item the coordinator closed is not reopened by it.
- **A named doctor is read from the sentence** ("refer to Dr Harjoban" → Dr Harjoban). A doctor on our staff is matched (consultant, in house, Book prefills them); an outside doctor shows "? Check".
- Scanned in id order (keyset), since a note with referral wording may hold no real referral and must not be re-read forever.
- **Migration** `2026-12-08_care_followups_hr_note_referral.sql` widens the `source` check. It must be applied **before** this code is deployed — otherwise the first insert fails the check and the whole collect run stops.
- **Test:** CF01 test 8.
- First real data (20 Oct): 3 referrals in 2 patients — P_182248 to Dr YK Batra (Dharma Hospital) and Dr Harjoban; P_175325 for a dermatology opinion.

## Referrals only (changed 20 Oct 2026)

The user: "I have to keep only referrals" — next-visit tests and referrals are different work, and this list is for referrals.

- **Collected now:** floor referrals (`gf_referral`), consultation referrals (`rx_referral`) and HealthRay note referrals (`hr_note_referral`).
- **No longer collected:** Scribe next-visit test orders (`next_visit_order`) and HealthRay next-visit investigations (`hr_follow_up`). Their sources, test matching (`matchTests`, `testKey`, the test catalogue in `loadCatalog`), "test done" auto-closing and the unknown-test rematch were removed.
- **The list, the drawer's "other open follow-ups" and auto-progress only read referral kinds** (`REFERRAL_KINDS` in `shared/careFollowups.js`). The Type filter offers Consultant / MO / Chief and Department / specialty; Book always prefills a consultant visit ("Follow Up").
- The 16 next-visit test items collected on 20 Oct stay in the table untouched (no calls had been logged) but are no longer shown or processed. The database `source` and `kind` checks still allow them, so nothing had to be migrated.
- **Tests:** CF01 2, 4, 5 and 6 and CF02 5 were rewritten for referrals only; CF02 5 checks that a next-visit test never shows.

## Calling-sheet layout (changed 20 Oct 2026)

The user asked for the page to work like the GHM calling sheet, a clearer Action column, and no Due column.

- The table reuses the GHM sheet's own styles (`GHMPage.css`: `.tbl`, `.pcell`, the coloured call-status dropdown) so both call lists look and behave alike.
- **Columns:** # · Patient (name, tap-to-call phone, file no, age/sex) · Referred to (who/which department, the "At GHM" badge and the doctor's own words) · Referred by (doctor, date, source) · Call status · Status · Action.
- **Call status** is set straight on the row, as on the GHM sheet: picking an outcome logs the call at once (no dialog). Below it: the number of calls and the last call date, and "N tries — no answer" after three unanswered calls. The call dialog was removed.
- **Action:** **Book appointment** (primary, open items only), **Close…** (asks what happened — not available here / patient declined / done elsewhere — with no outcome preselected, and a reason), **History** (the drawer). Closed items show **Reopen…** instead of Close.
- **Removed:** the Due column, the Due filter and the "overdue" line; the separate At GHM column (now a badge under Referred to); the "More ▾" menu.
- Fixed in this page only: a primary mini button rendered white because `.flow-btn-mini` in `flow.css` overrides `.flow-btn-primary`.
- **Tests:** CF02 3 (call status from the row, tap-to-call link, no Due column), 6 (Close… needs an outcome then a reason), 7 (History button) and 8 rewritten.
- **History drawer (same day):** a patient card (UHID, sex/age, tap-to-call phone and emergency contact, address, last completed visit, next booked appointment — read by `readFollowup`), a referral card (who, At GHM, the doctor's words, referred by, source, calls, status), the patient's other open referrals, and a timeline of calls and status changes (coloured call outcome, who, when, note).
- **Date filter (same day):** "Referred on" — ◀ [date] ▶, Today and All dates, like the GHM sheet's day picker (`DatePicker`). It filters by the referral date (`ordered_on`) through the list API's `from`/`to`; the status counts follow it.
  - **An earlier day is fetched when picked.** The list collects from the go-live date (`care_followups_since`) onwards. Picking a day before it calls `POST /api/care-followups/day` (`collectDay`): the three referral sources are read for that one day only (`BETWEEN day AND day`), inserted as usual (`ON CONFLICT DO NOTHING`), then auto-progress runs. The go-live date itself is not moved. A future day is refused (400). The page fetches each day once per visit and shows "Fetching referrals for …" meanwhile.
  - Auto-progress now looks for later visits from each batch's earliest referral date rather than from the go-live date, so an older referral can still turn Booked/Done.
  - Test: CF02 9.

## Linked with the Referrals desk (plan 83)

Desk referrals now reach Follow-ups at once and move with the desk (Booked outside, done on reply / Mark seen, closed on remove); a GHM booking here sets the desk to Appointment pending. See `83-REFERRALS-DESK-FOLLOWUPS-LINK-PLAN.md`.

## GHM Ops page hidden from the care coordinator (21 Oct 2026)

`/ghm` is in `ROLE_NAV_HIDDEN` for `care_coordinator`: no menu item, and a direct URL redirects home. `OBT_OPS` stays, because Follow-ups' **Book appointment** opens the GHM booking form and uses the GHM appointment APIs.
