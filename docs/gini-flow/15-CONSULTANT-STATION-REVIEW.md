# Consultant station — plans 13 & 14 reviewed against the code

**Date:** 2 Sep 2026
**Reviewing:** `13-CONSULTANT-STATION-PLAN.md` and `14-CONSULTANT-PRESCRIPTION-PLAN.md` against what
is on disk.

**Code read:** `server/services/giniflow/{doctorStation,consultBrief,prescription,medicineCard,finalize}.js`,
the doctor block of `server/routes/giniflowStations.js`, `server/migrations/2026-09-02_{consultant_prescription,giniflow_care_plan}.sql`,
`server/scripts/smoke-giniflow-doctor.mjs`, `src/pages/giniflow/{DoctorStationPage,DoctorConsultPage}.jsx`,
`src/pages/giniflow/consult/*` (9 files), `src/queries/hooks/useGiniflowDoctor.js`, and the RBAC/router wiring.
~4,530 lines.

**Method:** static review. No code changed, no migrations run, no database writes. The production
database was not reachable from this session, so two findings below are marked as needing a live
check and carry the query to run.

**Findings:** 1 critical · 2 high · 6 medium · 3 low.

---

## 1. The headline: both plans are stale

Both files open with **`Status: planned — not built`**. The station is built, end to end: 5 services,
20 API endpoints, 2 migrations, 2 pages, 9 consult sections, a 71-check smoke suite, and full
RBAC/router wiring. Anyone picking up these documents will start work that is already done.

Three specific claims in `13` §3 were true when written and are false now:

| Plan says                                                                       | Actually                              |
| ------------------------------------------------------------------------------- | ------------------------------------- |
| `STATION_CAPS.doctor` — **currently missing**, so the launcher tile is filtered | Present, `giniflowStations.js:433`    |
| The Consultant tile **has no `href`** — add `/giniflow/station/doctor`          | Has it, `StationsLauncherPage.jsx:53` |
| Status: planned — not built                                                     | Built                                 |

The rest of `13` §3's "exactly six places to wire it" table is accurate, and I verified the one claim
it makes that is easy to get wrong: `capForPath` in `RequireCapability.jsx` really does prefix-match
with longest-key-wins, so the single `"/giniflow/station/doctor"` key does gate
`/giniflow/station/doctor/:visitId`. The comment added at `routes.js:136` saying so is correct.

Also verified true, and worth keeping in the plans: `giniflow_rx_proposals.status` / `decided_by` /
`decided_at` had never been written by anything, and this station is what writes them;
`assigned_doctor_id` already existed and the board already read it; `stationSummary.js` already
computed the doctor count.

**Recommendation.** Update both status lines and §3's three stale rows before anyone reads them as
a work list.

---

## 2. Coverage against the two plans

| Plan section                               | State        | Note                                                                                            |
| ------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------- |
| **13** §3 RBAC — consultant only           | ✅           | `GINIFLOW_STATION_DOCTOR` granted to `consultant` only; `mo` and `coordinator` correctly denied |
| **13** §4 queue — counts, groups, card     | ✅           | `getDoctorQueue` with `scope=mine\|all`, `DoctorStationPage.jsx`                                |
| **13** §5 consult shell + section nav      | ✅           | `DoctorConsultPage.jsx`, one file per section as the plan demanded                              |
| **13** §6 overview, three concern sources  | ✅           | `consultBrief.js` — `classifyMarker` / `classifyAll` / `summarise` / `pickTiles`                |
| **13** §6.3 biomarker classifier           | ✅           | `in_control \| watch \| worse`, server-side, pure, with BP folded worst-of-two                  |
| **13** §7 labs & graphs                    | ✅           | `LabsSection.jsx`, `TrendModal.jsx`, `GET /:visitId/trend/:marker`                              |
| **13** §8 care plan                        | ✅           | `giniflow_care_plans` + `saveCarePlan` upsert                                                   |
| **13** §9 read-only after finalize         | 🟡 Partial   | Read-only works; **the addendum path it promises does not exist** (CS-07)                       |
| **13** §10–11 services and API             | ✅           | All 7 service functions, all planned endpoints plus 4 sensible additions                        |
| **14** §2 prescription section             | ✅           | `RxSection.jsx` (546 lines), inline edit, draft rows                                            |
| **14** §2.3 medicine search via `medmatch` | ⚠️ Changed   | Replaced with a 3-source SQL search — documented, but see CS-04                                 |
| **14** §2.5 MO proposals strip             | ✅           | `ProposalsStrip.jsx`, `decideProposal`                                                          |
| **14** §4 tests                            | ✅           | Reuses `moStation.orderTests` as planned                                                        |
| **14** §5 medicine card                    | ✅           | `medicineCard.buildCard` — one implementation, as the plan insisted                             |
| **14** §6 Finalize fan-out                 | 🟡 Partial   | 4 of 7 branches. **No Rx PDF, no Genie/MHG push** (CS-03)                                       |
| **14** §7 stock                            | 🟡 By design | `pharmacy_inventory` created and seeded empty — correct, but the whole stock UI is dead (CS-06) |
| **14** §10 smoke coverage                  | ✅           | 71 checks across 8 sections including the full finalize path                                    |

---

## 3. What is good

- **`pharmacy_inventory` seeded empty on purpose**, with the reasoning in the migration: a row's
  absence means "unknown", never "in stock", because a false in-stock sends a patient to a counter
  that cannot serve them. That is the same judgement the allergy strip got right, applied again.
- **Finalize is genuinely one transaction**, with the slow things (status fan-out consumers) after
  the commit and a comment saying why. The ordering — stopped rows before active upserts, so a
  medicine stopped and re-prescribed in one visit cannot collide — is the kind of thing that is only
  obvious after it has bitten someone.
- **Finalize refuses a patient who was never called in.** Without it, finalizing someone at the MO
  desk would ask the chain to jump three statuses and would log a consultation that never happened.
- **Undecided proposals are auto-rejected at finalize**, with the reason appended — so the MO is
  never left believing their suggestion is still under consideration after the patient has gone home.
- **One prescription history.** The brief proposed `prescription_items`; the migration argues for
  `medications` instead and the code holds the line. DoD item 5 met.
- **The draft is deleted at finalize** — "keeping it would give the next reader two answers to the
  same question".
- **`decideProposal` requires a reason to reject.** Overriding a colleague's clinical suggestion is
  exactly where an audit trail earns its place. (Though see CS-08 — the reason can be lost.)
- **The smoke suite tests the refusals**, not just the happy path: finalizing too early, rejecting
  without a note, the draft being cleared, both status events logged in order.

---

## 4. Critical

### 🔴 CS-01 — Finalize depends on a unique index that is not in the migration chain

`finalize.js` upserts with:

```sql
ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
```

Postgres requires a matching partial unique index or it raises _"there is no unique or exclusion
constraint matching the ON CONFLICT specification"_. That index —
`medications_patient_active_name_uniq` — exists **only in `server/scripts/dedup-medications.js`**, an
ad-hoc script. It is in no migration, and `server/schema.sql` does not carry it either.

The file's own header cites those indexes as the thing that protects the invariant against two
writers. That protection is real only where somebody remembered to run a one-off script.

**Consequence.** On production it very likely works (the script was presumably run). On any database
built from the migration chain — a restore, a staging copy, the "fresh environment" the repo does not
yet have — **every Finalize fails**, and it fails at the last step of a consultation.

**Needs a live check** (read-only):

```sql
SELECT indexname FROM pg_indexes
 WHERE tablename = 'medications' AND indexname LIKE '%name_uniq%';
```

**Recommendation.** Add a migration that creates both indexes `IF NOT EXISTS`, matching the script's
definitions exactly. This is the single highest-value change in the review: it costs ten lines and
removes a silent dependency from the most important write in the module.

---

## 5. High

### 🟠 CS-02 — stopping a medicine that was stopped before can abort the whole consultation

The companion index `medications_patient_inactive_name_uniq` is unique on
`(patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = false`.

Finalize's stopped branch sets `is_active = false`. The reachable sequence:

1. A medicine is stopped at some earlier visit → an **inactive** row exists.
2. It is later re-prescribed. The active upsert conflicts only on the _active_ index, which that
   inactive row is not in, so a **new active row** is created. Patient now has one active and one
   inactive row for the same medicine — permitted, since the indexes are separate.
3. It is stopped again → the UPDATE flips the active row to `is_active = false` → two inactive rows
   → **unique violation** → the entire finalize transaction rolls back.

The consultant sees a database error at the end of a consultation and cannot finalize at all, for a
reason nothing on screen explains. The file's comments reason carefully about ordering around the
_active_ index; the inactive one is not considered.

**Recommendation.** Either delete/merge the pre-existing inactive row in the same statement, or make
the stop branch an upsert against the inactive index. Add a smoke case: stop → re-prescribe → stop.

### 🟠 CS-03 — the fan-out is missing the two branches the patient actually sees

Plan `14` §6 specifies seven branches. Implemented: consultation row, medicines, proposal
auto-reject, status. **Not implemented:**

- **`prescriptionAutoSave.savePrescriptionForVisit`** → the Rx PDF into `documents` + storage. The
  plan notes this is not new code and is idempotent.
- **Genie / MHG push** — fire-and-forget after commit.

`finalize.js` calls only `markMedicationVisitStatus`. Nothing in `server/services/giniflow/`
references `prescriptionAutoSave` or the Genie sync.

**Consequence.** A consultation finalized through Gini Flow produces no prescription PDF and never
reaches the patient's app — while the same consultation finalized through Scribe's own wizard does
both. The confirmation panel the plan specifies literally lists "📱 Patient MHG — full medicine card"
as something Finalize does.

This is the same class of gap the Phase 2 audit raised against the vitals station (a station write
that never reaches the clinical surface), and it is worth checking whether the confirmation panel
currently promises either of these.

**Recommendation.** Call `savePrescriptionForVisit` after the commit, in the existing
fire-and-forget block. If the Genie push is deliberately deferred, say so in the panel rather than
listing it.

---

## 6. Medium

**🟡 CS-04 — `medmatch` was dropped, and the two prescribing paths now match medicines differently.**
Plan `14` §2.3 mandates the existing fuzzy matcher over `medicine_db.json` (~6,900 brands) — "the
algorithm the README documents". The code replaces it, with a checkable reason: `src/medmatch.js`
imports `src/lib/medName` without a file extension, which Vite resolves and Node does not, so it
throws `ERR_MODULE_NOT_FOUND` server-side. The substitute ranks `medications` history, then
`drug_master`, then `mhg_drug_formulary`.

The reasoning is honest and the substitute is arguably better for a hospital formulary. But the
consequence is not stated anywhere: **Scribe's consultation wizard and Gini Flow's consult now search
different medicine universes with different algorithms**, and the pharmacy sees brand spellings from
whichever path was used. That is a product decision, not an implementation detail. (Adding the `.js`
extension to one import would also make the plan's original approach work — worth pricing before
accepting the fork.)

**🟡 CS-05 — `consultationSave` was not extracted, so two code paths write `medications`.**
Plan `14` §6 says Finalize **must not** write a parallel set of INSERTs, and names the risk: start
dates, form prefixes, side-effect backfill. `finalize.js` documents the deferral and its reasoning
(the wizard route is bound to `mo_data`/`con_data`/`exam_data` and there is no test suite to catch a
regression), which is a fair call. Two things follow that the plan should now record:

- Finalize writes `consultations` + `medications` only. It does **not** write `vitals` or
  `diagnoses`, which `POST /api/consultations` does — so a Gini Flow consultation produces a thinner
  record than a wizard one.
- `medication/normalize.js`, `historicalStart.js` and `commonSideEffectsAI.js` do not run.

**🟡 CS-06 — the entire stock UI is unreachable.** Correct by design (`14` §7 is still open), but
worth stating at screen level: the per-row stock column, the low-stock warning, the out-of-stock
block, the alternatives flow and `finalizePreview.outOfStock` are all shipped and permanently inert
until someone populates `pharmacy_inventory`. The prototype's §2.4 flow cannot be demonstrated.

**🟡 CS-07 — the read-only banner promises an addendum path that does not exist.**
`DoctorConsultPage.jsx:226` tells the consultant "a correction is a new addendum, never an edit".
There is no addendum endpoint, service function or UI. DoD item 4 of plan `14` is half met: read-only
yes, addendum no. A consultant who spots a mistake after Finalize currently has no path at all, and
the screen implies there is one.

**🟡 CS-08 — a rejection reason can be silently discarded.** In `decideProposal`:

```sql
reason = CASE WHEN $4::text IS NULL THEN reason ELSE reason || ' · consultant: ' || $4 END
```

`giniflow_rx_proposals.reason` is nullable and `moStation.addProposal` allows a null. When the MO
gave no reason, `NULL || ' · consultant: …'` evaluates to `NULL` — so the consultant's mandatory
justification for rejecting a colleague's suggestion is written as nothing. `COALESCE(reason, '')`
fixes it.

**🟡 CS-09 — `releaseConsult` writes `current_status` directly, bypassing the engine.**
Phase 2 task 2.3's rule was "a grep shows no `UPDATE giniflow_visits SET current_status` outside the
engine". That grep now returns two hits — `doctorStation.js:580` and `moStation.js:648`, both release
paths. The reasoning (the chain has no backward step) is sound, and the release is still logged as an
event. Two consequences: the rule is no longer true and the plan that states it should say so; and
the direct UPDATE does not clear `queue_position` the way `advanceStatus` does — harmless today only
because the `queue_column` guard from BQ-06 ignores a position belonging to a column the patient has
left. Better as an explicit `returnToQueue` primitive in the engine.

---

## 7. Low

**🔵 CS-10 — the `consultations` insert comment describes behaviour the SQL does not have.** The
comment says "Re-finalizing the same day updates it rather than creating a second consultation", but
the statement is a plain `INSERT` with no `ON CONFLICT`. What actually prevents a duplicate is the
status guard above it (409 "already finalized"). Either add the clause or fix the comment — a comment
that overstates a safety property in a clinical write path is worse than none.

**🔵 CS-11 — a no-op write in the paused branch.** `notes = COALESCE(m.notes, '')` sets `notes` to
itself, or converts `NULL` to `''`. It looks like a leftover; its only effect is to lose the
NULL/empty distinction.

**🔵 CS-12 — three stations now set `allowSkip`.** `startConsult` passes it with a documented reason
(a walk-in, or a patient the floor moved by hand), joining vitals and MO/SD. `statusEngine.js`'s
comment still says the flag "exists for one caller: the HealthRay sync — a station screen must never
set it". That comment is now false four times over. Either the rule has changed and the comment
should say what the real rule is, or the stations should stop setting it.

---

## 8. Definition of done

| DoD                                                             | Met                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| **14**.1 Open → review proposals → prescribe → tests → Finalize | ✅                                                     |
| **14**.2 Finalize atomic, nothing written on failure            | ✅ — single transaction, rollback on any throw         |
| **14**.3 One `buildCard` for consultant, pharmacy and MHG       | 🟡 — one implementation exists; pharmacy/MHG not built |
| **14**.4 Finalized visit read-only, addendum the only write     | 🟡 — read-only yes, addendum absent (CS-07)            |
| **14**.5 Nothing writes `prescription_items`                    | ✅                                                     |
| **14**.6 Smoke / rbac / build / format green                    | ⚠️ Not run in this session — smoke suite exists (71)   |
| **13**.2 One event per transition, `actor_role = 'doctor'`      | ✅ — asserted in the smoke suite                       |

---

## 9. Suggested order

1. **CS-01** — migration for the two `medications` unique indexes. Ten lines; removes a silent
   dependency under every Finalize.
2. **CS-02** — the stop-twice collision, plus the smoke case that would have caught it.
3. **CS-03** — wire `savePrescriptionForVisit` into the post-commit block, or stop the panel
   promising the patient's app.
4. **CS-08**, **CS-10**, **CS-11** — three small correctness/honesty fixes in `finalize.js` and
   `doctorStation.js`.
5. **Update both plans**: status lines, the three stale §3 rows, and record CS-04/CS-05 as accepted
   deviations with their consequences rather than leaving the plans stating the opposite.
6. **CS-07**, **CS-09**, **CS-12** — the addendum path, the release primitive, and one honest
   statement of the `allowSkip` rule.
7. **CS-06** — stock stays open until the input arrives; no code change needed, but the demo script
   should say the stock flow is inert.

The build itself is strong — the reasoning in the migrations and in `finalize.js` is the best in the
Gini Flow tree so far, and the smoke suite tests refusals rather than just the happy path. What the
review turns up is mostly at the seams: an index outside the migration chain, a fan-out two branches
short of what the patient sees, and two documents that no longer describe the system they planned.

---

# Second pass — 2 Sep 2026

All 12 findings were addressed. Re-verified each against the code rather than the summary; 10 are
closed cleanly, 1 is partial by choice, and the CS-02 fix introduced one new problem.

## Closed

| ID              | Verified                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ------------------------------------------------------------- |
| **CS-01**       | `2026-09-02_medications_unique_indexes.sql` — both indexes, definitions matching `dedup-medications.js` exactly, `IF NOT EXISTS`, and the duplicate-row failure documented as the correct failure with the repair to run first |
| **CS-03**       | `savePrescriptionForVisit` + `buildVisitPayloadFromDb` called after the commit, non-blocking, idempotent per (patient, consultation, source)                                                                                   |
| **CS-07**       | The banner no longer promises an addendum; it says there is no path and where a correction has to be made instead                                                                                                              |
| **CS-08**       | `NULLIF(CONCAT_WS(' · ', reason, 'consultant: '                                                                                                                                                                                |     | $4), '')` — the consultant's reason survives a null MO reason |
| **CS-10**       | The comment now says the status guard is what prevents a second consultation row, not the INSERT                                                                                                                               |
| **CS-11**       | The no-op `notes = COALESCE(m.notes, '')` is gone                                                                                                                                                                              |
| **CS-12**       | The `allowSkip` comment now states the real rule — "the caller knows the patient is HERE and does not claim to know every step they took" — and enumerates the four bounded callers. Better than what the review asked for     |
| **CS-04/05/06** | Recorded in the plans as accepted deviations with their consequences, rather than left as instructions the code disobeys                                                                                                       |
| Plans           | Both status lines now read **built**; `13` §3's three stale rows corrected                                                                                                                                                     |

**A correction the fix surfaced, worth keeping.** CS-03 turned out to be two-thirds of a finding: the
Rx PDF was genuinely missing, but the Genie/MHG push the plan listed alongside it **does not exist to
call** — the outbound sync was removed on 2026-05-01 and `syncDocumentsToGenie` is `null`. The
document landing in `documents` is how it reaches the patient now. That is the second stale
assumption these plans carried from the brief; the finalize comment records it.

## Partial, by choice

**CS-09** — `returnToQueue` now exists in the engine and `releaseConsult` uses it, clearing the
manual queue position the way `advanceStatus` does. `moStation.js:648` still writes `current_status`
directly, so the Phase 2 rule ("no `UPDATE giniflow_visits SET current_status` outside the engine")
is true of one of the two release paths. Consistent with MO/SD being deliberately untouched — worth
one line when that station is next opened.

## New — introduced by the CS-02 fix

### 🟠 CS-13 — the stop-collision fix deletes rows that other tables depend on

The fix resolves the unique-violation by deleting the superseded inactive row:

```sql
DELETE FROM medications old
 WHERE old.patient_id = $1 AND old.is_active = false
   AND UPPER(COALESCE(old.pharmacy_match, old.name)) = ANY($2::text[])
   AND EXISTS (SELECT 1 FROM medications cur WHERE … cur.is_active = true …)
```

The reasoning — superseded history, same policy as `dedup-medications.js` — is defensible. What is
not accounted for is what hangs off that row:

| Dependent                                | On delete                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `medicine_collections.medication_id`     | **`ON DELETE CASCADE`** — the pharmacy's record of whether the patient collected that medicine, on which day, and why not, is destroyed with it |
| `medications.parent_medication_id`       | `ON DELETE SET NULL` — a dose-change lineage loses its link                                                                                     |
| `giniflow_rx_items.source_medication_id` | `ON DELETE SET NULL` — harmless, drafts are transient                                                                                           |

So a routine "stop this medicine again" now silently deletes pharmacy fulfilment history for that
medicine. Nothing on screen says so, and the smoke test asserts the deletion is correct
(`"one row survives, not two"`) without checking what went with it.

This is the same class of problem the module gets right elsewhere — the vitals station keeps
corrections as new rows, the event log is append-only, the draft is deleted only after it has become
the prescription. Here a clinical write path deletes patient history as a side effect.

**Recommendation.** Prefer merging to deleting: re-point `medicine_collections.medication_id` at the
row being stopped before the delete (minding its `UNIQUE (medication_id, collected_date)`), or keep
the old row and drop `medications_patient_inactive_name_uniq` — that index is what forces the choice,
and it exists to prevent dedup regressions rather than to express a clinical rule. At minimum, add a
smoke assertion that a medicine with collection history keeps it through a second stop.

## Standing item

`2026-09-02_medications_unique_indexes.sql` has not been applied here. It is a no-op on production if
`dedup-medications.js` was run, and will fail loudly on duplicates if it was not — which is the
outcome the migration wants. Run it, and the CS-02 smoke case with it:

```
node migrations/_runOne.mjs migrations/2026-09-02_medications_unique_indexes.sql && npm run smoke:giniflow-doctor
```
