# 82 — Prescriptions not taken: follow-up column at Prescription Explain

Status: built (2026-10-20). See "As built" at the end.

## Ask

Some patients leave without their prescription: they skip the Prescription Explain desk, or are
explained but forget to take the printout. The station should:

1. Show on every patient whether the prescription was **explained** or **not explained**.
2. Let the desk add a **remark**.
3. Keep un-explained / not-taken prescriptions in their **own column**, and keep them there on
   the **following days** until someone at the station resolves them — e.g. Nancy sends the
   prescription to the patient on WhatsApp the next morning and marks it done.

## What the code does today (read from code)

- `markRxExplained` (`server/services/giniflow/rxStation.js`) and the Rx desk's "Explained —
  patient leaving" (`endVisit` with `explained: true`, `pharmacyStation.js`) both write a
  `giniflow_visit_events` row with `meta.explained = true`. That is the only record that the
  desk explained the prescription.
- Patients who never reach the desk still end up `exited`: HealthRay completion through the sync,
  or the night sweep (`staleVisits.js`, `exited` / `abandoned`). No explained event is written.
- "Explained today" lists every visit of **today** in `pharmacy_pending / dispensed / exited`
  (`DONE_STATUSES`), so it **wrongly includes patients who were never explained**.
- The queue only reads today's date; yesterday's unresolved patients disappear.
- WhatsApp: MSG91 is wired (`server/services/msg91.js`), but the templates are not live — sends
  are logged, not delivered (`sendMedicineCard` etc.). A prescription PDF cannot be attached
  through a `wa.me` link.

## Proposal

### 1. Explained / not explained on every row

- The queue query gains `explained` = an event for the visit with `meta->>'explained' = 'true'`.
- "Explained today" becomes **"Done today"** with a badge on each row:
  **✓ Explained** or **⚠ Not explained** (label + icon, not colour alone).
- The view-only pane (opened from the done list) shows the same badge plus the remark history.

### 2. New column: "Prescription not given"

A third column on the station, listing visits that need the prescription sent:

- **Automatic:** a visit with a consultation and a prescription, now in
  `exited / dispensed / abandoned / pharmacy_pending`, with **no explained event**.
- **Manual:** the desk presses **"Not taken"** (remark required) on any patient (including an explained one who
  left the printout behind), with a remark. This covers "explained but forgot to take it".
- Excluded: online / tele visits, samples-only (Hospital Admin) visits, cancelled / no-show,
  blocked patients, visits with no consultation.
- **Carries over days:** the column reads from the go-live date (the migration day) up to today, not
  today only. Oldest first, each row shows the visit date ("Yesterday", "Mon 19 Oct").
- A row leaves the column only when resolved (below).

Row: name, file no, visit date, doctor, phone, ⚠ reason ("Not explained" / "Not taken"), last
remark, and actions.

### 3. Actions and remarks

On each row in the column:

- **View / 🖨 Print / ⬇ Download** prescription and medicine card (existing endpoints).
- **Open WhatsApp** — opens `wa.me/<phone>` with a short prefilled message, so Nancy can attach
  the downloaded PDF. (Manual send; automatic MSG91 sending is out of scope until the template
  is approved.)
- **Resolve**, each with a **required** remark:
  - **Sent on WhatsApp**
  - **Collected in person**
  - **No need** (e.g. no medicines, patient declined)
- **Add remark** without resolving (e.g. "phone switched off, try tomorrow").

Who / when / remark are shown on the row and in the pane.

### 4. Storage

New append-only table (migration `server/migrations/<date>_rx_handover_followups.sql`):

```sql
CREATE TABLE giniflow_rx_followups (
  id          bigserial PRIMARY KEY,
  visit_id    uuid NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  action      text NOT NULL CHECK (action IN
                ('not_taken', 'note', 'sent_whatsapp', 'collected', 'not_needed')),
  remark      text NOT NULL CHECK (btrim(remark) <> ''),
  actor_id    integer REFERENCES doctors(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON giniflow_rx_followups (visit_id, created_at DESC);
```

- A visit is **open** in the column if (no explained event OR it has a `not_taken` row) AND its
  latest resolving row (`sent_whatsapp / collected / not_needed`) is older than its latest
  `not_taken` (or absent).
- The visit's status is **not** changed: an exited visit stays exited. Nothing is repriced, no
  journey step is ticked.

### 5. API (`server/routes/giniflowStations.js`, `rxGate`)

- `GET /giniflow/stations/rx/queue` — rows gain `explained`; response gains `notTaken[]`
  (multi-day list).
- `POST /giniflow/stations/rx/:visitId/followup` — body `{ action, remark }`, Zod schema in
  `server/schemas/index.js`; every action requires a remark.
- Service functions in `rxStation.js`: `getRxNotTaken`, `addRxFollowup`.

### 6. UI (`src/pages/giniflow/RxStationPage.jsx`)

- Third column "📱 Prescription not given (N)", hint "Send these on WhatsApp, then mark done.
  They stay here until done."
- Small dialog for resolve / remark: patient name + file no + visit date at the top, remark
  field with label, Save / Cancel, loading and error states.
- Existing toast for success; the row moves out of the column immediately (query invalidation).

## Not changed

- The explain flow, statuses, pharmacy gate and night sweep.
- No automatic WhatsApp sending (MSG91 template not live).

## Tests (e2e, test DB only) — `e2e/giniflow/G107-rx-not-taken-followup.spec.js`

1. Visit exited with no explained event → listed in the column with "Not explained";
   "Done today" shows ⚠ Not explained.
2. Explained visit → ✓ Explained badge, not in the column.
3. "Not taken" on an explained visit with a remark → appears in the column with the remark.
4. Yesterday's unresolved visit still listed today; resolved one is not.
5. "Sent on WhatsApp" removes the row; remark and actor are stored; visit status unchanged.
6. Any action without a remark is refused (400); online / samples-only visits never listed.
7. Role without the Rx capability gets 403.

## Decisions (2026-10-20)

1. **Start date:** from go-live only; older visits are not listed.
2. **Remark:** required on every action ("Not taken", "Sent on WhatsApp", "Collected in person",
   "No need", and a plain remark).
3. **Who is listed:** automatic (every un-explained patient) plus manual "Not taken".

## As built

- Migration `server/migrations/2026-12-07_rx_followups.sql`: the table, plus
  `app_kv.rx_followups_since` = the day it is applied (the go-live date the column reads from).
- Service `server/services/giniflow/rxFollowups.js` (`getRxNotTaken`, `getRxFollowups`,
  `addRxFollowup`); the queue returns `notTaken`, and queue / patient rows carry `explained`. Until
  the migration is applied the column is empty instead of breaking the station.
- Vocabulary in `shared/rxFollowups.js`; schema `giniflowRxFollowupSchema`.
- UI: third column "📱 Prescription not given" (Open, Print, Download, WhatsApp, Mark done);
  "Explained today" renamed "Done today" with ✓ Explained / ⚠ Not explained badges; the view-only
  pane has Open WhatsApp, ⚠ Not taken, ✓ Mark done / remark and the follow-up history.
  Dialog: `src/components/giniflow/RxFollowupDialog.jsx`.
- Tests: `e2e/giniflow/G107-rx-not-taken-followup.spec.js` (8). Samples-only exclusion is by the
  shared `labOnlyPredicate`, not separately tested.
- Review fixes: online visits are excluded by the visit type **or** a tele / online / video
  booking (most online visits never get a visit type); merged and demo visits are excluded;
  Download fetches the file first (errors shown, an image keeps its extension); the WhatsApp
  button only appears for a valid 10-digit mobile.
- Known limit: the list scans every visit since go-live on each poll. Fine for months; if it
  slows, bound the automatic list or add a partial index.
- Online / tele visits are labelled "📱 Online visit" (not "Not explained") in Done today and the
  pane. They are left out of the automatic list only; the desk can still add one with "Not taken".
