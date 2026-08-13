# Live Dashboard — Section Guide

Every section explained with **real patients from 13 August 2026** (108 appointments).

---

## How a patient is judged

Today's reading is compared with that patient's **last reading**, test by test.

- **Main tests (decide the verdict):** HbA1c · Systolic BP · TSH
- **Supporting tests (can raise a flag):** FBS · PPBS · LDL · TG · HDL · UACR · eGFR
- **Only displayed:** Weight, BMI, Diastolic BP, liver tests, Hb

**Target bands**

| Test | Good | Borderline | Bad |
|---|---|---|---|
| HbA1c | ≤ 7 | 7–9 | > 9 |
| Systolic BP | ≤ 130 | 130–140 | > 140 |
| FBS | ≤ 130 | 130–180 | > 180 |
| PPBS | ≤ 180 | 180–250 | > 250 |
| LDL | ≤ 100 | 100–130 | > 130 |
| TG | ≤ 150 | 150–200 | > 200 |
| HDL | ≥ 40 | 35–40 | < 35 |
| UACR | ≤ 30 | 30–300 | > 300 |
| eGFR | ≥ 60 | 45–60 | < 45 |
| TSH | 0.5–4.5 | just outside | far outside |

**Four rules, in order:**

1. **Band change decides it** — even a tiny move counts if it crosses a line.
2. **Both readings in the good band → stable** (ignore healthy-range jitter).
3. **Change smaller than the minimum → stable.** HbA1c 0.3 · BP 5 · TSH 0.5 · FBS 15 · PPBS 20 · LDL 10 · TG 20 · HDL 3 · UACR 10 · eGFR 5.
4. **Otherwise direction decides.**

---

# 📊 Top row — today's numbers

| Box | Today | Meaning |
|---|---|---|
| Today's appointments | **108** | Everyone on the list |
| HbA1c on file | **74 / 108** | Amber because 69% (green needs 80%) |
| Getting worse ↑ | **13** | A main test deteriorated |
| ⚠ Mixed signals | **25** | Signals contradict each other |
| Stable | **7** | Nothing meaningfully changed |
| Getting better ↓ | **10** | Main tests improved cleanly |
| First reading — no prior | **44** | Nothing to compare against |

⚠ **13 + 25 + 7 + 10 + 44 = 99, not 108.** The missing **9** patients have a previous reading for a *supporting* test only (no old HbA1c, BP or TSH), so no verdict can be given. They are counted in the total but sit in **no** box. This is a known gap.

---

# ⭕ Biomarker Coverage — 69%

**Shows:** 74 of 108 appointments have HbA1c on file → **34 missing**.
Amber because it is under 80%. Those same 34 patients are listed in the "No biomarkers yet" card at the bottom.

**Why it matters:** without HbA1c the dashboard cannot judge that patient — they fall into "First reading" or the 9-patient gap.

---

# ⭕ HbA1c Trend — 55 trended

**Shows:** Better 10 · Stable 7 · Worse 13.

The centre says **55** because "trended" also includes the **25 Flag-for-review** patients — they had something to compare, they just came out mixed.

⚠ **Read the percentages carefully.** The card shows *"Stable 7 · 58%"*. Seven patients out of 55 is really **13%**. The Stable slice is calculated as *whatever is left over* after Better and Worse, so it silently absorbs the 25 mixed patients. Trust the **counts**, not the Stable percentage.

---

# 📋 Today's visit flow

Workflow only — lab values are ignored here.

| Row | Today | Meaning |
|---|---|---|
| With doctor | **5** | In the consultation room now |
| Checked in | **23** | Arrived, waiting |
| Pending | **69** | Booked, not yet arrived — see note below |
| No-show | **10** | Did not turn up |
| Cancelled | **1** | Cancelled |

"Seen" is missing because nobody has finished a consultation yet (it is 17:48 but the count is 0). Rows with zero are hidden. Total = 108. ✓

**Pending is not a real status — it is the leftover.** It is calculated as 108 minus Seen, With doctor, Checked in, No-show and Cancelled. That is why the six rows always add up to the total exactly, and it also means any appointment with a missing or unexpected status silently lands in Pending.

---

# 📉 Getting worse — 13 patients · 24%

### Condition
**Any main test (HbA1c, SBP or TSH) got worse.** Sorted with the biggest deterioration on top.

### Why these patients are here

| Patient | What happened | Why it counts as worse |
|---|---|---|
| **Mrs. Anjali Sharma** 12:05 | SBP **+26** | BP jumped a full band. Her FBS 140→91 and TG 136→123 improved, but supporting tests cannot rescue a main test |
| **Ms. Rajvir kaur** 15:50 | TSH **4.46 → 10.71** | Was just inside the normal range, now far outside |
| **Mr. Ramesh kumar Gandhi** 16:25 | HbA1c **6.4 → 8.8** | Good band → borderline. Biggest HbA1c jump today |
| **Hardeep singh** 13:05 | HbA1c **6.2 → 7.6** and TSH **11.69 → 55.2** | Two main tests worse at once |
| **Mrs. Hardeesh Kaur** 09:25 | HbA1c **6.8 → 7.1** | Only +0.3 — but it crossed out of the good band (Rule 1 beats Rule 3) |
| **Sukhbir Singh** 10:00 | HbA1c **7.0 → 7.2** | Only **+0.2**, well under the 0.3 threshold — but 7.0 is good and 7.2 is borderline. **Band change wins** |
| **Mrs. Evelin pathania** 14:35 | SBP **+32**, HbA1c 6.6 → 5.5 | HbA1c improved but both values are in the good band, so that counts as *stable*, not *better*. Only SBP moved → worse |

**Take-away:** a patient can land here on a 0.2 change (Sukhbir Singh) or *despite* an improving HbA1c (Mrs. Evelin pathania). Read the red reason line on each row.

---

# 📈 Getting better — 10 patients · 18%

### Condition
**All main tests improved, and no supporting test is a problem.** Biggest improvement on top.

### Why these patients are here

| Patient | What happened |
|---|---|
| **Jastej Singh** 13:00 | HbA1c **13 → 9.8** (−3.2). Biggest gain today |
| **Sushma rani** 15:05 | HbA1c **8.1 → 5.8** (−2.3). Borderline → good |
| **Mr. Roshan Lal** 16:40 | HbA1c **8.6 → 6.6** *and* SBP improving — both main tests moved the right way. TG also fell 380 → 128 |
| **Ms. Arzoo Dhiman** 09:35 | SBP **−45**, the largest BP drop |
| **Surinder Kaur** 08:50 | SBP **−17**. HbA1c 6.8 → 7.0 rose slightly, but both are in the good band → stable, so it doesn't block "better" |

⚠ **Better does not mean safe.** **Jastej Singh** is top of this list at HbA1c 9.8 — still in the bad band. He appears in **Needs extra attention** as well, and he should.

---

# ⚠ Flag for review — 25 patients

### Condition
The signals **contradict each other**. Four ways to land here:

**A. Two main tests moving opposite ways**
- **Mrs. Neelam Kumari** — *"SBP improving but HbA1c/TSH worsening"* (HbA1c 6.7 → 8.0, TSH 2.2 → 5.1)
- **Mr. Parmod gill** — *"TSH improving but HbA1c/SBP worsening"*

**B. Main test improved, supporting test rising**
- **Rajinder Mittal** — HbA1c 8.7 → 7.8 ✓ but PPBS **159 → 213** ✗
- **Mr. SURINDER KUMAR** — TSH 5.55 → 3.64 ✓ but TG **126 → 263** ✗
- **Mr. Pawan Kumar Verma** — SBP improving ✓ but FBS **90.6 → 177.5** ✗

**C. Main test improved, supporting test parked off target**
- **Mrs. Tripti Kaur Chandel** — SBP improving, but **TG 421.6**
- **Mrs. Nidhi Bishnoi** — TSH 0.105 → 3.492 (back into range) but **LDL 167, TG 296**
- **Dheeraj Diwan** — HbA1c **7.9 → 5.6** (excellent) but **HDL 34.6**, below target

**D. Main tests flat, supporting test worsening or off target**
- **Mr. Rampal** — HbA1c steady 6.8 → 6.7, but **UACR 3.5 → 42** (kidney signal appearing)
- **Mr. Ravinder Singh Sandhu** — HbA1c steady, but LDL 125 → 137 and TG 173 → 246
- **Sunita ahuja** — HbA1c 4.7 fine, but **eGFR 1.17**, far below target
- **Vipul Virmani** — TG **372 → 321**: falling, but still deep in the bad band

**Why this card exists:** every one of these looks like a success if you only glance at HbA1c. **Do not mark them "improving" without a doctor review.**

---

# ➖ Stable — 7 patients

### Condition
**Main tests did not meaningfully change** (HbA1c within ±0.3, SBP within ±5).

| Patient | Reading |
|---|---|
| **Mr. Hakam Singh** 11:10 | HbA1c 6.5 → 6.4 — only 0.1 |
| **Mr. Dr gc Bansal** 08:40 | HbA1c 6.2 → 6.6 — 0.4, but both in the good band (Rule 2) |
| **Mrs. Nidhi Aggarwal** 13:10 | HbA1c 7.2 |
| **Mr. Ashok Kumar** 10:30 | HbA1c 7.6, LDL 123.6 — both borderline, nothing moved |
| **Mrs. Hemali Angra** 09:05 | No HbA1c at all — also appears in "No biomarkers yet" |
| **Mrs. Rashvinder Kaur** | Listed **twice** (17:25 and 17:30) — a duplicate appointment, not two patients |

⚠ **Stable ≠ controlled.** Mr. Ashok Kumar at 7.6 is stable but above target. The row only prints an "above target" warning when HbA1c is **above 9** or SBP is **130+**, so a patient can sit here at 7.6 or 8.5 with no warning at all. Check the numbers yourself.

⚠ **Duplicate rows inflate every count** — Mrs. Rashvinder Kaur and Mrs. Babita Bansal each appear twice today.

---

# ⚠ Needs extra attention — 7 patients

### Condition
**Any one** of these is enough (this list ignores the verdict entirely):

- HbA1c **above 9**
- HbA1c **rising** and now **above 8**
- Medicine compliance **below 60%**

| Patient | Reason shown | Which rule |
|---|---|---|
| **Ms. Monika Sharma** 16:15 | HbA1c 10.9% | Above 9 |
| **Mr. SHAHBU DDIN** 13:00 | HbA1c 10.7% | Above 9 |
| **Jastej Singh** 13:00 | HbA1c 9.8% | Above 9 — **also in Getting better** (13 → 9.8). Improving fast, still dangerous |
| **Alka rani** 16:30 | HbA1c 9.5% | Above 9 |
| **Mr. Anil Kumar** 08:55 | HbA1c 9.2% | Above 9. FBS 276.8 too |
| **Mr. Deepak Agnihotri** 16:50 | Rising from 8.3% | 8.3 → 8.8, rising above 8 — **also in Getting worse** |
| **Mr. Ramesh kumar Gandhi** 16:25 | Rising from 6.4% | 6.4 → 8.8 — **also in Getting worse** |

**No compliance-triggered rows today** — nobody is below 60%.

---

# ✅ On track today — 38 patients

### Condition
**Both** must be true:
- HbA1c **7.5 or below**
- and it has **not risen** since last time (or this is the first reading)

This looks at **HbA1c only** — which is why the list is 38 while "Getting better" is only 10.

| Patient | Reading | Note |
|---|---|---|
| **Ms. Arzoo Dhiman** | HbA1c 4.4 | Clean |
| **Mrs. Nidhi Aggarwal** | HbA1c 7.2 | Under 7.5 — also in **Stable** |
| **Mr. Sukhbir Singh** | HbA1c 7.3 | Under 7.5 |
| **Sunita ahuja** | HbA1c 4.7 | But **eGFR 1.17** in red — also in **Flag for review** |
| **Mr. SURINDER KUMAR** | HbA1c 4.7 | But **TG 262.7** in red — also in **Flag for review** |
| **Mr. Kulbir Singh** | HbA1c 7.3 | But **TG 245.4, HDL 34.6** in red — also in **Flag for review** |

⚠ **"On track" only means the sugar is fine.** Three patients here have red chips for kidney or lipid results. Look at the chips, not just the green background.

Every row today reads "Improving" rather than "Controlled" — that label comes from the patient's saved category, and none are marked controlled.

---

# ⚠ No biomarkers yet — 34 patients

### Condition
**No HbA1c recorded**, excluding cancelled and no-show patients.

Examples: Ms. Hemanya Bishnoi 17:10 · Mrs. Gulshan ahuja 17:00 · Mr. Jobanpreet Singh 13:25 · Mr. Randeep Singh 08:30

**Why cancelled/no-show are excluded:** nobody will enter results for a patient who never came, so leaving them in would make this list permanently unfinished. All 34 here are genuine, fixable gaps.

This count matches the coverage warning exactly: **34 missing**.

⚠ **Mrs. Hemali Angra** 09:05 appears here *and* in **Stable** — she has FBS, LDL and TG on file but no HbA1c.

---

# Summary — how the sections overlap

| Section | Based on | Exclusive? |
|---|---|---|
| Getting worse / better / Flag / Stable / First reading | Full verdict | **Yes** — one patient, one box |
| Needs extra attention | HbA1c > 9, or rising above 8, or compliance < 60% | No — overlaps freely |
| On track today | HbA1c ≤ 7.5 and not rising | No |
| No biomarkers yet | HbA1c missing, not cancelled/no-show | No |

**Real overlaps today:** Jastej Singh (Getting better + Needs attention) · Ramesh kumar Gandhi and Deepak Agnihotri (Getting worse + Needs attention) · Nidhi Aggarwal (Stable + On track) · SURINDER KUMAR, Sunita ahuja, Kulbir Singh (Flag for review + On track) · Hemali Angra (Stable + No biomarkers).

---

# Three things to watch

1. **9 patients have no verdict** — the five boxes add to 99, not 108.
2. **The Stable percentage on the trend ring is misleading** — it shows 58% for 7 patients because it absorbs the 25 mixed cases. Use the counts.
3. **Duplicate appointments exist** (Rashvinder Kaur, Babita Bansal) and are counted twice everywhere.

---

**Other notes:** click a row to open the visit · Ctrl/Cmd-click opens a new tab · doctor and specialisation filters change every number on the page · green *Live* pill = today, amber *Historical view* = past date.
