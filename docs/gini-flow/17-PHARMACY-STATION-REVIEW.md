# Pharmacy station — plan 16 reviewed against the code

**Date:** 2 Sep 2026
**Reviewing:** `16-PHARMACY-STATION-PLAN.md` against what is on disk.

**Code read:** `server/services/giniflow/{pharmacyStation,counsellingNote}.js`, the pharmacy block of
`server/routes/giniflowStations.js`, `server/migrations/2026-09-02_giniflow_pharmacy.sql`,
`server/scripts/smoke-giniflow-pharmacy.mjs`, `src/pages/giniflow/PharmacyStationPage.jsx`,
`src/pages/giniflow/pharmacy/{CounsellingNote,DispenseCard}.jsx`,
`src/queries/hooks/useGiniflowPharmacy.js`, `server/services/msg91.js`, and the RBAC/router wiring.

**Method:** static review. No code changed, no migrations run, no database writes.

**Findings:** 1 critical · 1 high · 3 medium · 1 low.

---

## 1. Status: built, and the plan still says otherwise

`16` opens with **`Status: planned — not built`**. It is built: service, pure counselling module,
migration, 5 endpoints, page plus two components, a hook, and a 41-check smoke suite. §8's closing
line — "Plus `STATION_CAPS.pharmacy` in the launcher gate and an `href` on the existing Pharmacy tile
— which today has neither" — is also now false; both are present.

This is the third plan in a row to carry a stale status line. Worth a habit: flip it in the same
commit that finishes the task.

## 2. The plan's central instruction was followed

§3's whole point was to say what _not_ to build, and nothing was built twice:

- **No `giniflow_dispensing` table.** The migration adds one column (`card_sent_at`) and one index,
  and its header says why: `medicine_collections` is the dispensing record, in daily use, with a
  bulk write path and the not-collected report already on it.
- **`buildCard` is reused**, not re-implemented — the pharmacy renders the consultant's card with
  dispense controls attached.
- **`stampRxJourney` is not called** from anywhere in `server/services/giniflow/`. Open question 4
  answered by omission, which is the right answer — calling it would have re-attached Gini Flow to
  the old `flow_*` module. The confirmation the question asks for (that nothing downstream depends
  on that stamp for pharmacy-marked medicines) is still worth getting.

## 3. What is good

- **`compareQueue` is integrated correctly** — `statusMinutes` is set on each card _before_ the
  sort, and `queuePosition` carries the `queue_column` guard from BQ-06. This is exactly what the
  lab column got wrong (BQ-04); here it is right first time.
- **Stock chips are absent, not optimistic.** The SQL counts low and out-of-stock only where
  `i.stock_qty IS NOT NULL`, and `stock: low || out ? {…} : null` means a medicine the inventory has
  never heard of contributes nothing. The comment carries the CS-06 reasoning across intact.
- **The not-given rule works as specified.** `dispenseAll` marks only the still-pending rows, leaves
  `not_given` alone and returns `partial: true`; the button relabels to **"Dispense the rest"**, and
  the confirm box names how many medicines stay marked not given, with their reasons. The smoke
  suite asserts the relabel and the surviving mark.
- **A hand-moved patient still gets a pharmacy interval.** If the visit is at `doctor_done`,
  `dispenseAll` writes `pharmacy_pending` before `dispensed`, so the 10-minute budget measures
  something real instead of the column being jumped.
- **`counsellingNote.js` is pure and tested without a database** — the smoke suite runs three
  assertions on it before it touches Postgres, including that a prescription with no changes produces
  no change sentences.
- **Externals are excluded twice** — from the bulk mark (`external_doctor IS NULL`) and from the
  per-row controls.
- **MSG91, not WATI**, per §3.1, with the same dev-fallback shape as the existing OTP sender.

**Worth noting:** `dispenseAll` writes two or three events in one transaction, which is the second
instance of the `now()` collision found in the consultant review — before the `clock_timestamp()`
change, a dispensed patient's timeline could have shown `exited` above `dispensed`. Applying
`2026-09-02_giniflow_event_clock.sql` matters for this station too.

---

## 4. Critical

### 🔴 PH-01 — "Card sent" is recorded and displayed when nothing was sent

`sendMedicineCard` (`msg91.js:158`) returns `{ ok: true, dev: true }` — logging instead of sending —
whenever any of these is missing: `NODE_ENV=production`, `MSG91_AUTH_KEY`,
`MSG91_WA_INTEGRATED_NUMBER`, or **`MSG91_WA_CARD_TEMPLATE_NAME`**. That last one is the template
plan `16`'s own open question 1 says has not been submitted for approval yet.

`sendCardToPatient` does not distinguish:

```js
const result = await sendMedicineCard(visit.phone, { … });
await db.query(`UPDATE giniflow_visits SET card_sent_at = NOW() WHERE id = $1`, [visitId]);
return { sent: true, dev: !!result?.dev, phone: visit.phone };
```

So on production, with the template not yet approved, every dispensed visit gets `card_sent_at`
stamped. The queue then renders **"· Counselling done"** and the pane **"✓ Card sent"**. The `dev`
flag is returned but nothing in the UI reads it.

The second half is worse than the first. `card_sent_at` is also the idempotency guard —
`if (visit.card_sent_at && !force) return { sent: false, alreadySent: true }`. So once the template
_is_ approved, every patient dispensed before that day is permanently marked as having received their
medicine card and **will never be sent one**, unless someone finds them and forces a resend.

This is the mistake §4.2 of this same plan warns against, moved to a different field: rendering a
claim the system cannot make. There it was "all in stock"; here it is "card sent".

**Recommendation.** Stamp `card_sent_at` only on a real send, and record the dev/no-op case
separately (or not at all) so a later approval still reaches those patients. Surface `dev` on screen
— "logged, not sent (no template)" — rather than a green tick.

---

## 5. High

### 🟠 PH-02 — the WhatsApp send is awaited on the counter's request

Plan §6 puts the send **after the commit, fire-and-forget**. The route awaits it:

```js
const result = await dispenseAll(…);
const card = await sendCardToPatient(req.params.visitId).catch((e) => ({ sent: false, error: e.message }));
res.json({ ...result, card });
```

The comment above it is right that a send failure cannot undo a dispensed visit — the `catch` sees to
that. What it does not address is latency: the pharmacist's "Mark all dispensed" now blocks on an
MSG91 HTTP call with no timeout, for a visit that is already committed and closed. A slow or hanging
vendor leaves the counter watching a spinner with a queue behind them, and no way to tell that the
work is already done.

**Recommendation.** Either drop the `await` and let the UI poll `card_sent_at`, or wrap the send in a
short timeout (2–3s) and report "sending…" rather than blocking the response on it.

---

## 6. Medium and low

**🟡 PH-03 — the send and its record are not atomic.** `card_sent_at` is written after
`sendMedicineCard` returns, outside any transaction. A crash between the two sends the card and
forgets, so a retry double-sends. Inherent to calling a third party, but worth a line in the code
saying which way it errs.

**🟡 PH-04 — the capability changed name and the older plans still use the old one.**
`06` §2.11 and `13`'s stations table both say `GINIFLOW_STATION_PHARM`; `16` §8 and the code say
`GINIFLOW_STATION_PHARMACY`. The code is self-consistent and granted to `pharmacy` only (plus `admin`
via `ALL`), exactly as §8 specifies. Fix the two older plans so a grep for the capability finds one
spelling.

**🟡 PH-05 — plan `16`'s status line and §8's closing sentence are stale** (see §1).

**🔵 PH-06 — `dispenseAll` marks the whole active regimen, not this visit's prescription.** The
select is `m.is_active = true AND m.external_doctor IS NULL` for the patient, so a patient on seven
long-term medicines gets seven `medicine_collections` rows dated today. That is almost certainly
right — the counter hands over the current regimen, not only what changed — and it matches what
`buildCard` shows. Recording it because the not-collected report counts those rows, so the intended
reading of "not collected" is per-visit-regimen rather than per-new-prescription.

---

## 7. Open questions — current state

| #   | Question                     | State                                                                                                             |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | WhatsApp template + approval | **Still open, and now load-bearing** — PH-01 turns the unapproved state into silent data loss rather than a no-op |
| 2   | Stock                        | Still open, handled honestly — every stock surface is inert rather than wrong                                     |
| 3   | Printed card as well as sent | Unanswered; `prescriptionHtmlPdf.js` still exists if the answer is yes                                            |
| 4   | `stampRxJourney`             | Answered by omission — not called. Confirm nothing downstream reads it for pharmacy-marked medicines              |

---

## 8. Suggested order

1. **PH-01** — stop stamping `card_sent_at` on a no-op send, and show the dev state. Until this is
   fixed, running the station on production quietly burns the first cohort of patients' medicine
   cards.
2. **PH-02** — unblock the counter's button.
3. Submit the MSG91 template (open question 1) — it gates the last branch of §6 and the fix above is
   only worth having once a real send is possible.
4. **PH-04**, **PH-05** — three lines of plan maintenance.
5. Apply `2026-09-02_giniflow_event_clock.sql`; this station writes three events in one transaction
   and depends on it for a correct timeline.

The station itself is the cleanest build in the Gini Flow tree: it added one column where a lesser
version would have added a table, reused `buildCard` and `medicine_collections` rather than
reimplementing either, got `compareQueue` right where the lab column did not, and kept every
stock-shaped claim off the screen until there is data behind it. The one critical finding is not in
that work — it is in the seam with a vendor integration that is honest about doing nothing while the
station records it as done.
