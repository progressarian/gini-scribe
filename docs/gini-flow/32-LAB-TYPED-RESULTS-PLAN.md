# 32 — Typed lab values at the lab station

Planned and built 2026-09-07.

## Why

When results were ready the lab station could only attach a document. For a test
the hospital runs in-house that is the wrong shape: the technician has the
numbers on the analyser in front of them, and turning them into a PDF so the
system will accept them hands the doctor a picture of a value instead of the
value. A typed result can be trended, flagged and compared; a scanned one sits in
the Labs tab as a file somebody has to open.

So the station gets a form as well as the upload. **Either finishes the order and
a case may carry both** — the decision taken on the floor: "optional, can upload
docs as well, or finish with values, or both."

## Where the values go

`lab_results` — the table every lab number in this system already lives in, and
the one the doctor's Labs tab, the trends, the pre-visit summary, the MO/SD chips
and the patient's app all read. Consultations already write typed labs there with
`source='manual'` and `getCanonical(test_name)`
(`server/routes/consultations.js:704`), so the station does exactly the same. A
typed value is indistinguishable from a HealthRay one apart from its source tag,
and **nothing downstream needed a new screen**.

One additive column — `lab_results.lab_order_id` — so the station can find what
it typed and correct a typo
(`server/migrations/2026-09-10_lab_results_order_link.sql`).

A save **updates before it inserts**, so typing the same test twice corrects the
row rather than adding a second one. And before inserting it checks whether any
other source already reported that test today — a HealthRay feed, an OPD entry —
in which case it writes nothing and names the test back to the desk, because two
values for one test on one day with nothing to separate them is worse than a
value the technician knows was not taken.

⚠️ That check is explicit rather than a conflict clause: `server/schema.sql`
declares `uq_lab_results_per_date` over `(patient_id, canonical_name, test_date)`,
but **this database does not have that index**. Code that leaned on it would have
written the duplicate silently.

## The form

Rows are prefilled from **this hospital's own history** and every one is
removable; blank rows can be added with autocomplete. Both, as asked.

For each test on the order, the parameters this lab has actually reported under
that panel, with the unit and reference range they most often carry, read from
`lab_results` itself. No catalogue to build and nobody to maintain one. Real
output for a CBC + KFT + LFT order:

```
CBC   Hemoglobin gm/dL 13.0-17.0 · WBC 10^3/mm^3 4.0-10.0 · PCV % 40.0-50.0 …
KFT   Uric Acid mg/dL 3.5-7.2 · Creatinine mg/dL 0.80-1.30 · BUN mg/dL 8.0-23.0 …
LFT   Direct Bilirubin mg/dL 0.00-0.20 · SGPT (ALT) U/L <50 …
```

**Ten rows on the screen, the rest one pick away.** Those three panels have 192
parameters on file between them; the server takes the 12 each ordered test
reports most often, and the form shows the first ten of those and puts the
remainder behind a **"+ More from this order (26)"** picker. Thirty-six input
boxes is a form nobody reads to the bottom, and ten is also the honest shape —
the lab types the handful it has values for, not every line it might. Removing a
row returns it to the picker, so a test dropped and then printed by the analyser
does not have to be retyped. A parameter both panels claim — creatinine on a KFT
and an LFT — appears once.

## The flag rule, shared

`server/utils/labFlag.js` — `parseRefRange` reads a range the way a report prints
it ("13.0-17.0", "> 40", "< 50", an en dash), and `flagFor` decides HIGH/LOW. The
HealthRay parser's own copy of that arithmetic was replaced by a call to it
(`labHealthrayParser.js`), so a typed HbA1c and a synced one are flagged by one
rule rather than two that can drift. A range no arithmetic can read — "Negative",
"Non-reactive" — flags nothing, because no flag is better than a wrong one on a
clinical value.

The form applies the same rule as the technician types, so a value about to go on
a record as HIGH says so **before** it is saved.

## What a save does

`saveResults` — one transaction, then two follow-ups:

1. Each row upserted into `lab_results` (patient, `test_date` = the visit's date,
   canonical name, `source='manual'`, `lab_order_id`). A number **or** a word:
   "B positive" is a result too, and only the number carries a flag.
2. The order advanced to `uploaded` through the **same `advanceSample` the upload
   uses**, so the MO is notified by one code path whether the result arrived as
   numbers or as a scan — and only if it is not already there.
3. `syncBiomarkersFromLatestLabs` (`healthray/db.js:2112`), because the MO and
   doctor cards read `appointments.biomarkers`, not `lab_results`. Without it the
   numbers would be in the chart and absent from the screens the floor is looking
   at. Best-effort: a biomarker sync that fails must not lose the results.

## Who sees them

- **The lab station** — the form reopens with what was entered, for correcting.
- **The MO/SD card** — `getMoPatient` already returned the visit's orders; each
  now carries its values, so the numbers sit on the card where the MO is looking
  at the order they belong to, flagged.
- **Everyone else** — the doctor's Labs tab, trends, chips, the pre-visit
  summary, the patient's app. All of it follows from the rows being in
  `lab_results`, with no further work.

## Files

- new: `server/utils/labFlag.js`, `server/services/giniflow/labResults.js`,
  `server/migrations/2026-09-10_lab_results_order_link.sql`,
  `src/components/giniflow/LabResultsForm.jsx`,
  `server/scripts/smoke-giniflow-lab-results.mjs`
- changed: `server/services/lab/labHealthrayParser.js` (uses the shared flag
  rule), `server/services/giniflow/moStation.js`,
  `server/routes/giniflowStations.js`, `server/schemas/index.js`,
  `src/pages/giniflow/LabStationPage.jsx`,
  `src/pages/giniflow/MoStationPage.jsx`, `src/queries/hooks/useGiniflowLab.js`,
  `src/styles/giniflow-station.css`

## Verification

`npm run smoke:giniflow-lab-results` — 39 checks: the flag rule across every range
shape; an uncleared order refused with nothing written; suggestions prefilled from
real history, carrying unit and range, capped; autocomplete; a save the
**doctor's own lab query** returns; a word kept as a word with no number left
behind; a value another source owns skipped, named, and the other source left
untouched; a correction replacing rather than duplicating; the order finished with
no file pretended; the MO notified; a value added afterwards and flagged like the
rest. Plus `smoke:giniflow-lab`, `-mo` and `-journey`.

The suite writes to the production database, so it removes its rows whatever
happens — visits before patients, since a patient a visit references cannot be
deleted. It seeds no demo day and flags no visit `is_demo`, so it cannot be
disturbed by, or disturb, another suite running at the same time.

## Code review

`/code-review high`, 2026-09-07. Six findings against this feature, all fixed:

1. **The MO card rendered every value twice** — two blocks over the same data,
   left by an interrupted session. One kept.
2. **A blank value became `0`.** `z.union([z.coerce.number(), z.literal("")])`
   tries coercion first and `Number("") === 0`, so the literal arm was dead code
   and the service's own blank guard never fired. Re-saving a qualitative result
   would have written `result = 0` — a real value on a patient's record, flagged
   `LOW`. Replaced with a `preprocess` that maps blank to null and a word to a
   word.
3. **A word failed the whole batch.** The form has one value box; typing
   "Positive" failed validation and rejected all twenty other rows with a generic 400. A non-numeric value now routes to `result_text`, where it can be read but
   not trended.
4. **Typed values could leak between patients.** The detail pane is reused when
   the technician clicks from one card straight to the next, so the form kept the
   first patient's rows and would have saved them onto the second's chart. Keyed
   on the order id, which remounts it.
5. **A value another source already had was dropped silently but counted as
   saved.** Now checked explicitly before the insert, and the skipped tests are
   named in the toast — because the value already on file came from somewhere
   else and may disagree.
6. **The upload zone vanished once values were saved**, contradicting the whole
   "either finishes it, and a case may carry both" decision. `uploaded` added to
   `canUpload`.

Two things the review surfaced that were bigger than the finding:

- **`uq_lab_results_per_date` does not exist in this database.** `server/schema.sql`
  declares it, but it was never applied here — so a conflict clause alone would
  have written the duplicate rather than skipping it. The guard is an explicit
  check for that reason, and it behaves the same whether or not the index is
  there.
- **The suite no longer seeds the shared demo day.** It builds the one patient
  and order it needs, and its visit is not flagged `is_demo` — every other
  suite's `cleanDemoDay()` deletes those, which was deleting this suite's order
  out from under it whenever two runs overlapped. Four consecutive green runs.

## Also fixed: "Mark sample collected" on a case already processing

Spotted on the floor, 2026-09-07. A HealthRay case sitting in **Processing**,
with "Received by lab 15:42" printed on the same pane, still offered
**✓ Mark sample collected**.

`isCollected` read only `phlebotomy_status === "Completed"` or `collected_on`.
HealthRay leaves that field at "In progress" on cases whose tube is demonstrably
in the lab — case 19609 was received at 08:07 with `phlebotomy_status` never
updated and `collected_on` null — so the button appeared on a sample already
being run. The pane's own comment states the rule it was breaking: "an action
that cannot apply must not be offered. A sample already collected has nothing
left to mark." A tube cannot be run before it is drawn, and offering the action
anyway is how a technician is sent to draw blood twice.

Now any stage beyond collection — received, result saved, reported — counts as
collected, and `markLabCaseAction` **refuses** `sample_taken` on such a case
rather than only hiding the button: a screen left open since before the tube
arrived would otherwise write a collector's name against a sample somebody else
drew, and that name is the only record of who drew it.

Six checks in `smoke:giniflow-lab` pin the truth table. They are pure and sit
above the demo seeding, so they run whatever state the shared demo day is in.

## Also fixed: a case in the analyser was a dead card once the patient left

Same screen, same afternoon. Cases showing **Processing · 283m in analyzer** with
"Exited — has left the floor" rendered as `aria-disabled` divs: not openable, not
focusable, nothing to click. **25 of today's 32 hospital-lab patients** were in
that state.

The cause is one field used for two questions. `collectable` answers "can the lab
physically get to this patient right now" — false while another station has them
and once they go home. That is exactly right for **drawing blood**, and the stage
list was using it to disable the whole card.

But where the patient is matters only while the tube is still in their arm. Once
it is drawn, processing, reporting, reading the tests and entering the values have
nothing to do with them. So the card is now inert only when the case is still
waiting to be drawn _and_ the patient is out of reach
(`cannotBeWorked = stillNeedsThePatient(row) && !row.collectable`); a case past
collection stays openable, and the finished cases in "Lab done" opened up too —
reading a case never needed the patient present.

The detail pane had the matching contradiction: it printed "This patient has left
the floor — the sample can no longer be taken" beside a ✓ saying the sample was
taken. Only an action still outstanding can be blocked by where the patient is,
so the hint is computed from those and omitted when there are none.

## Risks worth stating

- These rows are a patient's permanent record and reach their app. That is the
  point, but it means a typo is a clinical record — hence the flag shown before
  saving and the values staying editable from the station afterwards.
- `source='manual'` sits below `opd` and `report_extract` in `SOURCE_PRIORITY`
  (`server/services/lab/db.js:12`), so a later HealthRay sync will not overwrite a
  typed value for the same test and date.
