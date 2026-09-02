# Referrals station — plan 19 reviewed against the code

**Date:** 2 Sep 2026
**Reviewing:** `19-REFERRALS-STATION-PLAN.md` against what is on disk.

**Code read:** `server/services/giniflow/referralsStation.js`,
`server/templates/referralLetterTemplate.js`, `shared/giniflowReferrals.js`, the referrals block of
`server/routes/giniflowStations.js`, `server/migrations/2026-09-02_giniflow_referrals.sql`,
`server/scripts/smoke-giniflow-referrals.mjs`, `src/pages/giniflow/ReferralsStationPage.jsx`,
`src/pages/giniflow/referrals/{ReferralForm,ReferralCard}.jsx`,
`src/pages/giniflow/consult/ReferralChips.jsx`, `src/queries/hooks/useGiniflowReferrals.js`,
`server/services/giniflow/{finalize,stationSummary}.js`, `server/services/msg91.js`, and the
RBAC/router wiring.

**Method:** static review. No code changed, no migrations run, no database writes.

**Findings:** 0 critical · 1 high · 3 medium · 1 low.

---

## 1. Status: built — and the plan's status line is the most specific one yet to be wrong

`19` opens with:

> **Status:** planned — nothing built; no `giniflow_referrals` table, service, route, page or hook exists

Every clause of that is now false: the table, the service (11 exported functions), 8 endpoints, the
page plus two components, the consult chips, the hook, the letter template, and a 37-check smoke
suite all exist. Fourth plan in a row shipping with a stale status.

## 2. The plan was followed closely — including its harder instructions

- **Parallel, not a chain status.** Nothing was added to `CHAIN`, `STATUS_LABEL`,
  `STATUS_TO_SLA_KEY`, `BOARD_COLUMNS` or `ACTOR_ROLES`; `current_status` never moves for a referral.
  The migration's banner states the rule and names `giniflow_lab_orders.sample_status` as the
  precedent, exactly as §2 asked.
- **`giniflow_referrals` separate from the existing `referrals` table**, with the debt §3.2 requires
  stated in the migration rather than discovered later: a referral made in Scribe's visit page will
  not appear here, and vice versa.
- **The letter is generated after the commit in Finalize** (`finalize.js:256`), never inside it, and
  the comment gives §6's reason: a Puppeteer render holding a row lock is the failure that file
  already warns about. A referral is explicitly not a reason to block Finalize.
- **`generateLetter` is idempotent on `letter_file_url`** and only advances `created`, so a
  regenerate cannot walk a booked or completed referral backwards.
- **`removeReferral` refuses once a letter exists**, with a sentence the desk can act on — the plan's
  "a letter may already be on its way to a specialist".
- **The public-URL exposure is a recorded decision, not an accident.** §7.3 states it, and
  `uploadLetter` implements exactly what it describes, matching `labStation.uploadReport`. Consistent
  rather than new — and the migration path (`documents` + signed URLs) is written down.
- **37 smoke checks** including the chip toggle, the no-phone refusal, the dev-mode send, closing
  twice, and a closed referral refusing a new appointment.

### The best thing here: PH-01 was learned from

`sendLetter` is modelled on `sendCardToPatient` **with the pharmacy review's critical finding already
fixed**:

```js
if (result?.dev) {
  return {
    sent: false,
    dev: true,
    to,
    phone,
    reason: "The WhatsApp referral template is not live yet — the letter was logged, not sent",
  };
}
// …only then stamp letter_sent_at
```

The comment above it spells out why: stamping on a no-op "would permanently mark a patient as having
been sent a letter they never got — and stop the real send from ever reaching them once the template
goes live." That is PH-01 stated back correctly and designed out before it shipped.

**Which makes RF-01 below the one that matters.**

---

## 3. High

### 🟠 RF-01 — the pharmacy still has the bug this station fixed

`pharmacyStation.sendCardToPatient` continues to stamp `card_sent_at` on a dev-mode send and report
`sent: true`. The correct implementation now sits two files away in `referralsStation.sendLetter`,
with a comment citing the pharmacy line number it was modelled on.

So the repo currently holds both the bug and its fix, and the bug is on the busier path — every
dispensed patient, versus every referral. Nothing in this review's scope is wrong; the finding is
that the fix stopped one file short.

**Recommendation.** Port the three-line guard back to `pharmacyStation.js:525`. Consider extracting
the shared shape — "send, and stamp only on a real send" — since a third caller now exists.

---

## 4. Medium

**🟡 RF-02 — the create form can silently rewrite a referral that has already gone out.**
`createReferral` upserts on `(visit_id, specialty)` with `DO UPDATE`, which is right for the
consultant's chip toggle — a double tap must not produce two letters. But the same function backs
the coordinator's create form, and the upsert has **no status guard**. A coordinator who creates
"Cardiology → Dr. B" for a visit that already has "Cardiology → Dr. A" does not get an error or a
second referral: `to_doctor` is overwritten to Dr. B and `urgency` replaced, while `letter_file_url`,
`letter_generated_at`, `letter_sent_at` and `status` are all left untouched.

The result is a referral that says it was sent, links a stored PDF naming Dr. A, and now claims to be
addressed to Dr. B. The coordinator believes they created a new referral.

**Recommendation.** Guard the `DO UPDATE` on `status = 'created' AND letter_file_url IS NULL`, and
refuse from the station path with the reason ("Cardiology already has a letter for this visit"),
keeping the silent upsert for the chip toggle only.

**🟡 RF-03 — `GINIFLOW_REFERRALS` went to `consultant` as well as `coordinator`, which §9 does not
say.** The plan grants it to "`coordinator` and `admin`". The code grants `consultant` too, which is
_necessary_ — the consult chips call the same referrals endpoints — but it has a second effect
nobody wrote down: `src/config/routes.js` maps `/giniflow/station/referrals` to the same capability,
so a consultant can now open the coordinator's referrals desk, search every patient's referrals for
the day, book appointments and close loops. That may be fine; it is not what §9 describes.

**Recommendation.** Either record the widening in §9, or split the chip's write path onto
`GINIFLOW_STATION_DOCTOR` and keep the desk on `GINIFLOW_REFERRALS`.

**🟡 RF-04 — one referral per specialty per visit is now a schema rule.** The unique index on
`(visit_id, specialty)` is well argued for the chips, and the migration explains it. The consequence
is unstated: a visit cannot carry two referrals to the same specialty — two different cardiologists,
or a second opinion — and the attempt silently edits the first (RF-02). Worth a line in the plan so
the first person who needs it knows it was a decision.

---

## 5. Low

**🔵 RF-05 — `letter.pdf` renders on every request.** `GET /:id/letter.pdf` calls `renderLetter`,
which builds the PDF fresh, while `letter_file_url` already holds a stored copy. Correct in one
respect — the stored file could be stale after an edit — but it means a Puppeteer render per view, on
a route a coordinator may click several times, and the served bytes can differ from the bytes the
patient received on WhatsApp. Worth deciding which is authoritative: the stored letter, or the live
render.

---

## 6. Open questions — current state

| §    | Question                            | State                                                                                                      |
| ---- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 12.1 | MSG91 referral template             | Still unapproved — but handled correctly (no stamp, actionable reason). This is the model for the pharmacy |
| 12.2 | —                                   | Carried in the plan                                                                                        |
| 12.3 | The return leg (specialist replies) | Deferred as planned; `addExternal` remains the hook for it                                                 |
| §3.2 | The older `referrals` table         | Divergence accepted and documented. Nothing merges the two; a Scribe-side referral stays invisible here    |

---

## 7. Suggested order

1. **RF-01** — port the dev-send guard back to the pharmacy. The referrals station proves the fix
   works; the pharmacy is where it matters more.
2. **RF-02** — status-guard the upsert so the desk cannot rewrite a sent referral.
3. **RF-03**, **RF-04** — two lines of plan maintenance, or one capability split.
4. **RF-05** — decide whether the stored letter or the live render is authoritative.
5. Flip `19`'s status line.

This is the most faithful plan-to-code match in the Gini Flow tree, and the first station to ship
with a previous review's finding already designed out rather than repeated. The findings are all at
the edges — a capability grant that outgrew its plan, an upsert doing double duty for two callers
with different needs, and a fix that should now travel back one file.
