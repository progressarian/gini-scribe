# 37 — Specimen kinds in the lab rooms (urine · send-outs · derived values)

Status: **PLAN. Nothing implemented.**
Follows `35-LAB-TWO-ROOM-SPLIT-PLAN.md`, which built the two lab rooms on one assumption:
that every test is a tube a phlebotomist draws. Three groups of tests break that assumption.
None of them belong in the machine station (`36`) — they are lab work, and they stay in Lab 1
and Lab 2. What they need is for the ladder to describe them honestly.

---

## 1. The three groups, measured over 180 days

`lab_cases` carries **193 distinct test names** in that window — small enough to classify,
large enough that guessing is not good enough.

### A. Patient-provided specimens — 13 names, **2,707 line items**

| line items | test                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 2,272      | Microalbumin / Creatinine Ratio                                                                                                     |
| 309        | URINE ROUTINE Micro                                                                                                                 |
| 39         | FECAL ELASTASE                                                                                                                      |
| 36         | URINE C/S                                                                                                                           |
| 22         | Osmolality - Urine                                                                                                                  |
| 19         | Calcium/Creatinine - Ratio Spot Urine                                                                                               |
| 3          | STOOL EXAMINATION: OCCULT BLOOD                                                                                                     |
| 2          | URINE CULTURE                                                                                                                       |
| 1 each     | Stool Occult Blood · 24 Hours Urine Protein · Creatinine (Urine Spot Test) · URINE POTASSIUM CREATININE RATIO · Urine Ketone Bodies |

**Microalbumin / Creatinine Ratio alone is the most-ordered test on the floor.** Nobody draws
any of these. A container is handed over, the patient goes away, and the sample comes back —
or does not.

### B. Send-outs — 3 names, **92 line items**

| line items | test                        |
| ---------- | --------------------------- |
| 85         | GAD IAA IA2                 |
| 4          | METANEPHRINES, FREE, PLASMA |
| 3          | ALDOSTERONE PRA (DRC)       |

Drawn here, run somewhere else. "⚙️ Processing" is a courier and a reference lab, and the
turnaround is days against the ~2 hours the screen's timer implies.

### C. Derived values — 3 names, **2,261 line items**

| line items | test        |
| ---------- | ----------- |
| 1,104      | Homa IR     |
| 1,102      | Homa -B     |
| 55         | FIB 4 INDEX |

Arithmetic. HOMA-IR and HOMA-B are computed from fasting glucose and fasting insulin — of 420
cases carrying Homa IR in 60 days, **376 also carry both**. Nothing is collected, nothing is
run, nothing can be chased.

**eGFR is deliberately NOT in this group.** It is calculated too, but off a serum creatinine
that genuinely is drawn — it rides along with a real tube and needs no separate handling.
Microalbumin/Creatinine Ratio likewise: a ratio, but of a urine sample that must physically
arrive, so it belongs in group A.

---

## 2. What each group actually needs

Deliberately ordered by how much they change. Two of the three are label-and-clock work, not
new rungs.

### A. Patient-provided — the verb is wrong, and one state is missing

"✓ Mark sample collected" describes an act nobody performed. Two changes:

1. **The verb follows the specimen.** For a urine or stool sample the rung reads
   **"✓ Sample received from patient"** with the hint "Mark that the patient has brought the
   sample back." Same rung, same position in the ladder — only the words change, because the
   thing being recorded really is the same: the lab now has it.
2. **A urine-only case gets an honest waiting state.** Blood sits at "Collect now" because a
   phlebotomist has to act. A urine-only case is waiting on the _patient_, and no amount of
   staffing moves it. Those cards read **"Waiting for the patient's sample"** and are excluded
   from the collection room's "to call" pressure, because calling them achieves nothing.

**Mixed cases are the common shape, and the honest limit of this plan.** Fourteen of today's
32 cases carried a urine test _alongside_ bloods — one tick covers a tube drawn and a cup
handed over. Splitting the rung per test is a much larger change (per-test state rather than
per-case), and this plan does **not** propose it. Instead the card names the mix:
"3 tests · 1 urine" and the hint says the urine sample must be back before the case is complete.
Honest about what one tick means, without rebuilding the ladder. Q1 asks whether that is enough.

### B. Send-outs — a different bench and a different clock

`processing` keeps its rung but changes its face when the test runs offsite:

- Label: **"📮 Sent to reference lab"** rather than "⚙️ Processing".
- **The SLA is suppressed.** Today a case at `processing` goes amber on the lab's own timings.
  A send-out is not late at 45 minutes; it is normal at three days. Leaving the amber on trains
  the floor to ignore the colour, which costs more than the send-outs do.
- The case says which tests went out, so nobody chases the bench for them.

### C. Derived values — no station work at all

They should never generate a step, a chase, or an "outstanding test" count:

- Excluded from the card's test list, or grouped after it as "+ 2 derived" — they are results,
  not work.
- Excluded from "still out" counts, so a case whose real tests are all reported is not held
  open by a number nobody computes by hand.
- **Not** hidden from the chart. The doctor still sees HOMA-IR; it just stops being something
  the lab is asked to produce.

---

## 3. How a test gets classified

This is the part that must not be hand-waved. HealthRay test names are free text, 193 of them
in six months and growing.

**`shared/labSpecimens.js`** — one table, the same pattern `35` proved:

```
{ kind: "urine" | "stool" | "blood" | "derived",
  offsite: boolean,
  match: [/…/],        // ordered, first hit wins
  label, hint, pill }
```

Three rules that keep it honest:

1. **Patterns are ordered and specific-first.** `Microalbumin / Creatinine Ratio` must match
   the urine rule, not a generic `creatinine` blood rule.
2. **The default is `blood`, never a guess.** An unrecognised name behaves exactly as the floor
   behaves today — no regression from a name nobody has classified yet.
3. **Unclassified names are reported, not silently defaulted.** A `smoke:lab-specimens` check
   lists every distinct test name from the last 30 days that matched no explicit rule, so new
   names surface as a list to review rather than as a wrong label on a card.

**The admin catalogue covers the other half.** `giniflow_test_catalog` gains `specimen` and
`offsite` beside the `category` that `36` adds, so a Gini-ordered test is classified where its
price is set — by the floor, without a deploy. Patterns classify HealthRay's names; the
catalogue classifies ours.

---

## 4. Phases

### Phase 1 — Vocabulary and classification _(no visible change)_

- `shared/labSpecimens.js` with the table, the matcher and the helpers.
- `smoke:lab-specimens`: asserts the ordering rules, that `blood` is the default, and prints
  the unclassified names from the last 30 days.
- **Verify:** classify all 193 live names and read the output. Nothing on screen changes yet.

### Phase 2 — The verb follows the specimen (group A)

- Rung labels and hints derive from the case's specimen mix, not from a constant.
- The card names the mix ("3 tests · 1 urine").
- **Verify:** a urine-only case reads "received from patient"; a blood case is unchanged;
  a mixed case says so.

### Phase 3 — Waiting on the patient (group A)

- Urine-only cases get their own pill and leave the "to call" pressure.
- **Verify:** today's three urine-only cases move; the blood queue's counts are untouched.

### Phase 4 — Send-outs (group B)

- `offsite` changes the `processing` face and suppresses the SLA.
- **Verify:** the three send-out names stop going amber; everything else keeps its timings.

### Phase 5 — Derived values (group C)

- Excluded from test lists, outstanding counts and any chase.
- **Verify:** a case of FBS + Insulin + HOMA-IR + HOMA-B reads as 2 tests, not 4, and closes
  when the two real ones report.

### Phase 6 — Sweep

- Re-run the classifier over 180 days and review what still falls to default.
- Demo seeder gains a urine-only case, a mixed case and a send-out.

---

## 5. Questions

- **Q1 — Is per-case enough, or does the floor need per-test state?** This plan keeps one tick
  per case and names the mix. Per-test state would be honest for the 14-of-32 mixed cases but
  is a substantially larger change to the ladder, the queue and both screens.
- **Q2 — Who chases a urine sample that never comes back?** Today nobody, and nothing shows it.
  Should a urine-only case that has waited over some threshold appear anywhere — the collection
  room, reception, or the MO who ordered it?
- **Q3 — Are those three really the only send-outs?** 92 line items over 180 days is small
  enough that the list may be incomplete rather than short. Worth the lab confirming.
- **Q4 — Should `giniflow_test_catalog` carry `specimen`/`offsite` from the start,** or wait
  until `36` has added `category` so the admin screen changes once rather than twice?
