# Scribe Rx waits for today's HealthRay notes

Status: plan, 2026-10-31. Not built.

## 1. The case

Vijay Kumar (P_181110), 31 Oct 2026, Dr. Beant Kaur. HealthRay prescription PDFs at 10:16 and
10:17; Scribe made its own prescription at 10:18 (`documents.source = 'visit'`). The Scribe print
had the **3 Aug medicines** (Vogli still on, Aktiv D missing, Daplo M before dinner instead of
breakfast), no labs for today, no tests for the next visit, and the Rx desk showed it as ready to
print (`rxStale = false`).

## 2. Causes in the code

| # | Cause | Where |
|---|---|---|
| C1 | When HealthRay marks the visit completed and its Rx PDF has arrived, `markAppointmentAsSeen` copies the patient's **current** medicine list into today's consultation and `autoSavePrescriptionAfterSeen` builds the Rx at once. If today's notes have not been read yet, that list is the last visit's. | `server/services/healthray/db.js`, `server/services/cron/healthraySync.js` (sync pass, "notes unchanged" branch) |
| C2 | The "clinical data extracted?" gate counts *anything* on the appointment — HealthRay's diagnosis list (arrives at once) or the medicines C1 just copied — so it never waits. | `autoSavePrescriptionAfterSeen` |
| C3 | Reading the notes can be skipped or fail **silently**: notes with follow-up dates that don't match the visit date are not parsed; a parse with no medicines/diagnoses keeps the previous visit's data. Nothing records that today's notes were not read. | `healthraySync.js` (`skipParse`, `parseHasContent`) |
| C4 | Labs marked "today" in a note are dropped when the note's follow-up date matches the visit (`parsed.labs.filter(lab.date !== "today")`), so today's FBG/HbA1c/UACR written in the note never reach the Rx. To confirm: is this deliberate (the lab feed is meant to supply them)? | `healthraySync.js` |
| C5 | "Out of date" only fires when **today's** medicine rows change after the Rx was made. Notes that changed, or were never read, don't count. | `rx_stale` in `server/services/giniflow/rxStation.js` |

Unknown until Step 0: whether Vijay's notes were read at 10:20 and gave no change (C3), or were
never read.

## 3. Step 0 — confirm on this patient (read-only, you run it)

A `BEGIN READ ONLY` script for P_181110 / 31 Oct: today's appointment (`healthray_clinical_notes`
length and whether it contains "31/10/26", `opd_backfilled_at`, `updated_at`,
`healthray_medications` count), today's consultation, `medications` rows with their
`updated_at` and `consultation_id`, and the Scribe Rx `documents` rows with `created_at`. It tells
which of C1–C4 happened. No change to anything.

## 4. Design

### 4.1 Record whether today's notes were read

New columns on `appointments` (migration, you apply it):

| Column | Meaning |
|---|---|
| `notes_read_hash` | hash of the `healthray_clinical_notes` text that was last read successfully |
| `notes_read_at` | when |
| `notes_read_status` | `read`, `skipped_date_mismatch`, `empty`, `failed` |

Written by every path that reads notes (sync pass, per-insert listener, batch result handler,
manual re-parse). **"Today's notes are read"** = `notes_read_status = 'read'` and
`notes_read_hash` = hash of the current notes text.

### 4.2 Don't make the Scribe Rx until they are read

- `autoSavePrescriptionAfterSeen` / `maybeAutoSavePrescription` build the Rx only when today's
  notes are read (4.1). Otherwise they log "waiting for today's notes" and return.
- When the notes are read later, the existing rebuild path (`maybeAutoSavePrescription` after
  the parse) makes the Rx, as today.
- Same-day sync already reads notes inline (not the batch queue); keep it so — no change.

### 4.3 Rx desk shows the waiting state

On `/giniflow/station/rx` and the patient's Rx pane, a new state beside "Out of date":

| State | Shown | Print / Download / WhatsApp |
|---|---|---|
| Waiting for HealthRay notes | "⏳ Waiting for today's HealthRay notes — since 10:18" | Disabled, tooltip says why |
| Notes couldn't be read (`skipped_date_mismatch`, `empty`, `failed`) | "⚠ Today's HealthRay notes couldn't be read — use the HealthRay prescription" | Scribe print disabled; **Open HealthRay prescription** (the synced PDF) offered instead |
| Out of date (C5 widened) | as today, also when the notes changed after the Rx was made | as today ("Rebuild") |

The "Prescription not given" list and WhatsApp row follow the same rule, so a stale Rx is never
sent.

### 4.4 Out of date also when the notes changed

`rx_stale` becomes true when the notes hash changed after the Rx was made, not only when today's
medicine rows changed.

### 4.5 Not in this change

- Fixing Vijay's record (CVA marked present, 31 Jul weight 34.25 kg, Nephropathy G?A1). These are
  data corrections; listed for a separate, asked-for script.
- C4 (today's labs from the note) — only if you confirm it should change (open question 3).

## 5. Tests (local test DB)

- Completed visit, Rx PDF in, notes **not read** → no Scribe Rx; Rx desk shows Waiting; Print
  refused by the API.
- Notes read afterwards → Rx built with today's medicines; Waiting clears.
- Notes skipped for a follow-up date mismatch / empty parse → status recorded; Rx desk shows
  "couldn't be read" with the HealthRay PDF offered.
- Notes edited after the Rx was made → Out of date.
- An old Rx from a visit before this change keeps working (no hash yet → treated as read, so
  nothing on the floor locks up the day it ships).
- Existing Rx specs: G75, G81, G93, G94, G107, G111, G114, G121.

## 6. Build order

1. Step 0 (you run the read-only script).
2. Migration (4.1) + writing the marker in every read path.
3. Gate the auto Rx (4.2).
4. Rx desk states + API refusal (4.3, 4.4).
5. Each lands with its tests; ships together.

## 7. Open questions

1. When notes can't be read, offer only the HealthRay PDF, or also let the desk print the Scribe Rx
   after a warning?
2. If notes are still not read after N minutes, keep waiting or fall back to the HealthRay PDF?
3. Today's labs written in the note (C4): keep dropping them, or put them on the Rx?
