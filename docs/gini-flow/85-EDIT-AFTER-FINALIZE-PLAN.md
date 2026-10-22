# 85 — Edit a consultation after Finalize

Status: **approved 22 Oct 2026** — same day only, patient stays put, reason optional, owner + Chief + admin. Asked 22 Oct 2026: "after I finalize as Chief or
consultant I want an option to edit / reopen, update anything, finalize again,
and the prescription is overridden — sometimes the consultant or Chief missed
something."

## 1. What happens today

- `finalizeConsult` (`server/services/giniflow/finalize.js`) runs in one
  transaction: inserts a `consultations` row, writes the medicines
  (stop / pause / upsert active), moves the visit `doctor_done → rx_pending`, and
  **deletes the draft** (`giniflow_rx_items`). After the commit it renders the
  prescription PDF (`savePrescriptionForVisit`) and referral letters.
- The consult screen turns read-only once the visit is past the doctor
  (`finalized: DONE_STATUSES.includes(status)`) and says *"There is no addendum
  path yet — a correction has to be made in Scribe"*.
- A second finalize is refused (`This consultation is already finalized`).
- The server does **not** block care-plan / tests / referral writes on a
  finalized visit — only the screen does. Medicine writes have nothing to write
  to, because the draft was deleted.
- The MO/Chief closing a visit uses the same function (`closedBySd`).

## 2. What we build

An **Edit prescription** button on the finalized banner. It reopens the
consult screen for editing *without moving the patient on the floor*, and
**Save changes** re-finalizes into the same consultation and replaces the
prescription PDF.

### 2.1 Who can edit

- The consultant who finalized it, or the consultant assigned to the visit.
- The Chief, for a visit the Chief closed (`closed_by_sd`).
- Admin.

Ownership uses the existing `requireOwnVisit` rule, so another consultant still
gets read-only access.

### 2.2 When

**Same visit day only.** After that the visit belongs to history, and a
correction goes through the patient's chart as today. Past days get no button
and the API refuses them.

### 2.3 The patient does not move

Reopening does **not** send the patient back to the doctor column. They may
already be at the Rx desk, the pharmacy, or home. The floor status stays where
it is; only the consultation becomes editable.

- The visit gets an `editing_*` mark (who, since when). The doctor queue shows
  them under **"Editing after finalize"** so the doctor can find them again.
- **Cancel edit** drops the draft and leaves the finalized prescription
  untouched.

### 2.4 Reopen — rebuilding the draft

The draft is rebuilt from what this consultation wrote:

- medicines with `consultation_id = this consultation`, active → their own
  `change_type` (new / changed / continued / paused);
- medicines this consultation stopped → `stopped` rows, with their reason.

The doctor sees exactly what was finalized, not a flat "continued" list.

### 2.5 Save changes — re-finalize in place

The same steps as Finalize, with four differences:

1. **Same `consultations` row** — no second consultation for the visit.
2. **A medicine this consultation added that the doctor has now removed** is
   switched off with the reason "Removed when the visit was edited", rather
   than left active.
3. **A medicine this consultation stopped that is now continued** is switched
   back on.
4. **No status move.** Instead an event `consult_amended` is written, with who,
   when, the reason, and a short before/after summary (medicines added /
   removed / changed).

After the commit, the prescription PDF is re-rendered with
`overwrite: true`. That path already exists and only retires the old PDF once
the new one is stored. New referral letters render as today.

All the existing Finalize checks still apply: undecided Chief proposals block,
and severe interactions need a reason.

### 2.6 Reason

**Save changes** offers an optional short reason, e.g. "Missed Vit D
supplement". When given it goes in the event, for the audit trail.

### 2.7 Downstream screens

| Where the patient is | What changes |
|---|---|
| Rx desk, not yet explained | Nothing. The desk reads the new prescription. |
| Already explained / at pharmacy / dispensed / gone home | Rx desk "Explained today" and the pharmacy card show **⚠ Prescription updated 15:10 by Dr X — explain the changes**, with a print button for the new PDF. |
| Pharmacy already dispensed | The same badge. The pharmacy decides whether to give the extra medicine. |

The "explained" mark is not wiped. The badge asks for the change to be
explained.

### 2.8 Screen

```
✓ Finalized 14:38 by Dr Anil Bhansali            [ ✎ Edit prescription ]

— while editing —
✎ Editing after finalize — the patient stays at Prescription Explain.
   Changes go out only when you save.      [ Cancel edit ] [ Save changes ]
```

**Save changes** opens a confirm box: the patient, what changed (+ added,
− removed, ~ changed), an optional reason, and "The prescription PDF will be
replaced".

## 3. Data

Migration `2026-12-12_consult_editing.sql`:

```sql
ALTER TABLE giniflow_visits
  ADD COLUMN editing_by INT REFERENCES doctors(id),
  ADD COLUMN editing_since TIMESTAMPTZ;
```

The edit history lives in `giniflow_visit_events` (`status` unchanged, meta
`{source:'consult_amended', reason, added, removed, changed}`). No new table.

**This migration has to run on production before the code is deployed.** A
local dev run against production would otherwise break the doctor station
(see the "new table empties local screens" memory).

## 4. API

- `POST /giniflow/stations/doctor/:visitId/edit` — same day, owner, finalized
  → sets the `editing_*` mark and rebuilds the draft. 409 otherwise.
- `POST /giniflow/stations/doctor/:visitId/edit/cancel` — clears the mark and
  the draft.
- `POST /giniflow/stations/doctor/:visitId/edit/save` `{ reason }` — §2.5.
- `getConsult` returns `editing: { by, since }`. `finalized && !editing` stays
  read-only.

## 5. Tests (`G116-edit-after-finalize.spec.js`)

1. Finalize → Edit → the draft shows the same medicines with their change
   types.
2. Add one medicine, remove one that this visit added, then Save: one
   consultation row; the added medicine is active, the removed one is inactive
   with the edit reason; the status is unchanged; there is a `consult_amended`
   event with the reason.
3. Save with no reason works; the event has no reason.
4. Cancel edit → the draft is gone and the medicines are unchanged.
5. Another consultant → 403. A past day → 409.
6. An explained patient shows "Prescription updated" on the Rx desk.
7. The PDF is re-rendered with overwrite (spy on `savePrescriptionForVisit`).

## 6. Not in this plan

- Editing past days.
- Undoing tests or bills. Tests ordered or removed while editing use the
  normal test flow, so billing follows it.
- HealthRay. These are Scribe prescriptions; nothing is pushed to HealthRay.

## 7. As built (22 Oct 2026)

- Service `server/services/giniflow/consultEdit.js`: `openEdit`, `cancelEdit`, `saveEdit`. Finalize's medicine
  writes moved into `writeMedicines` (finalize.js), so Finalize and Save changes share them.
- The edit log is `giniflow_visits.amendments` (JSONB array of `{at, by, reason, added, removed, changed}`) plus
  `amended_at` / `amended_by`, not a visit event. An event with an unchanged status would have reset the Rx-desk
  wait clock (`status_since` reads the last event).
- Reads use `to_jsonb(v)->>'…'`, so the doctor, Rx and pharmacy screens keep working before the migration runs.
  Opening an edit needs the migration.
- Who may edit = admin, the assigned consultant, the visit's Chief (`assigned_sd_id`), or whoever finalized it.
  This is the consultant page (`GINIFLOW_STATION_DOCTOR`), so a Chief with a consultant login uses it there.
  The Chief station (`/giniflow/station/mo`) has the same Edit button on a closed patient
  (`POST /giniflow/stations/mo/:visitId/edit|edit/cancel|edit/save`, MO gate). While the Chief
  edits, their added medicines are direct rows, not proposals, and the MO-gated row routes
  (`/giniflow/stations/mo/prescription/items/:itemId` patch / delete / pause / resume / stop)
  work only for the person editing that visit. Outside an edit they return 403, so the MO's
  normal proposal flow is unchanged.
- While editing, `visitOwnership` / `rowOwnership` let the editor write even if another consultant is assigned.
- Rx desk: "✎ Prescription updated HH:MM", or "⚠ … — explain the changes" when the update came after the
  explanation. Pharmacy card: "⚠ Prescription updated HH:MM — check the medicines again".
- Tests: G116 (6, consultant page), G118 (5, Chief station).
