# OPD Live Dashboard — Sections & Conditions

**Page:** `/opd?tab=dashboard`
**Code:** `src/components/opd/LiveDashboard.jsx` · classifier `src/utils/biomarkerClassify.js` · data `server/routes/opd.js`

This doc answers one question: **on which condition does a patient land in which section, and why.**

---

## 1. Where the data comes from

Each appointment row arrives from the OPD appointments API with:

| Field | Meaning |
|---|---|
| `biomarkers` | Today's readings (HbA1c, SBP, TSH, FBS, LDL, TG, …), key-normalised (`bpSys → sbp`) |
| `prev_biomarkers` | The **previous** reading per marker, picked per-key from the freshest earlier source (lab_results → vitals → patient-app → appointment history) |
| `status` | Workflow state: `pending` / `checkedin` / `in_visit` / `seen` / `no_show` / `cancelled` |
| `compliance.medPct` | Medicine adherence % |
| `category` | `ctrl` (controlled) or other |

> Important: `prev` is chosen per biomarker, not per visit. HbA1c's "previous" may come from a different date than SBP's "previous".

**Filters first.** Everything below is computed on `filteredAppointments` — the day's list after the **date picker**, **specialization filter** and **doctor filter** are applied. Change a filter and every count/section recomputes.

---

## 2. The classification pipeline (per patient)

```
biomarkers + prev_biomarkers
        │
        ▼
 classifyBiomarker(key, cur, prev)   ──►  better | worse | stable | unknown   (per marker)
        │
        ▼
 classifyComposite(all markers)      ──►  better | worse | mixed | stable | partial
        │
        ▼
 outcome  (forced to "single" if NO marker had a comparable prior)
        │
        ▼
 Patient is placed in exactly ONE trend bucket
```

### Step A — per-biomarker trend: `classifyBiomarker`

Evaluated in this order:

1. **Zone crossing wins.** Each value maps to a target zone — `good` / `warn` / `bad` (see targets below).
   - Moved to a worse zone (good→warn, warn→bad, good→bad) → **worse**
   - Moved to a better zone (bad→warn, warn→good, bad→good) → **better**
   - *Why:* a small numeric move that crosses a clinical threshold matters more than a big move inside one zone.
2. **Both readings in `good`** → **stable**. *Why:* ignore within-target jitter (LDL 66 → 89 is not "worsening").
3. **Change smaller than the stability threshold** → **stable**.
   `HbA1c ±0.3 · SBP ±5 · DBP ±5 · TSH ±0.5 · FBS ±15 · PPBS ±20 · LDL ±10 · TG ±20 · UACR ±10 · eGFR ±5 · HDL ±3` (markers with no threshold use ±5%).
4. **Otherwise, direction decides** — for lower-is-better markers a drop is better; for HDL/eGFR a rise is better; for TSH, moving toward the mid-range is better.
5. Missing current or prior value → **unknown** (that marker takes no part).

**Target zones (`BIO_TARGET`)**

| Marker | good | warn | bad |
|---|---|---|---|
| HbA1c | ≤ 7 | ≤ 9 | > 9 |
| SBP | ≤ 130 | ≤ 140 | > 140 |
| DBP | ≤ 80 | ≤ 90 | > 90 |
| FBS | ≤ 130 | ≤ 180 | > 180 |
| PPBS | ≤ 180 | ≤ 250 | > 250 |
| LDL | ≤ 100 | ≤ 130 | > 130 |
| TG | ≤ 150 | ≤ 200 | > 200 |
| HDL | ≥ 40 | ≥ 35 | < 35 |
| UACR | ≤ 30 | ≤ 300 | > 300 |
| eGFR | ≥ 60 | ≥ 45 | < 45 |
| TSH | 0.5 – 4.5 | ±50 % buffer | outside |

### Step B — tiers

| Tier | Markers | Role |
|---|---|---|
| **Tier 1** | `hba1c`, `sbp`, `tsh` | Headline. Decides the outcome. |
| **Tier 2** | `fg`, `ppbs`, `ldl`, `tg`, `hdl`, `uacr`, `egfr` | Supporting. Can turn a "better" into "mixed". |
| **Tier 3** | `weight`, `bmi`, `dbp`, `alt`, `ast`, `hb`, `wbc` | Monitored only — **excluded** from the outcome. |

### Step C — composite outcome: `classifyComposite`

Rules are evaluated top-down; the first match wins.

| # | Condition | Outcome | Why |
|---|---|---|---|
| 1 | No Tier-1 marker has a usable trend | `partial` | Nothing to compare on the headline metric |
| 2 | One Tier-1 better **and** another Tier-1 worse | **mixed** | Contradiction inside the headline metrics |
| 3 | Any Tier-1 worse | **worse** | Headline deterioration overrides everything else |
| 4 | Tier-1 better **and** any Tier-2 worse | **mixed** | e.g. "HbA1c improving but LDL rising — review" |
| 5 | Tier-1 better **and** a Tier-2 sits in the `bad` zone | **mixed** | Off-target supporting marker still needs a look |
| 6 | All Tier-1 better, no Tier-2 problem | **better** | Clean improvement |
| 7 | Tier-1 stable **and** any Tier-2 worse | **mixed** | Early deterioration warning |
| 8 | Tier-1 stable **and** a Tier-2 in `bad` zone | **mixed** | Chronically off-target supporting marker |
| 9 | Everything else (all Tier-1 stable) | **stable** | No meaningful change |

### Step D — the `single` override

The dashboard overrides the composite result to **`single`** whenever *no* Tier-1 or Tier-2 marker had both a current *and* a prior value (`anyTrend === false`) — i.e. this is a first reading with nothing to compare against.

> ⚠️ **Edge case:** if a patient has a Tier-2 trend but **no** Tier-1 trend, `anyTrend` is true and the composite returns `partial`. `partial` is not `better/worse/mixed/stable/single`, so that patient appears in the **total** but in **none** of the five outcome tiles or trend cards.

---

## 3. Section-by-section: which patient goes where

### 3.1 Top KPI row (7 tiles)

| Tile | Condition | Why |
|---|---|---|
| Today's appointments | all filtered rows | Denominator for everything |
| HbA1c on file | `hba1c` present, shown as `n / total` | Data-completeness check before clinic starts |
| Getting worse ↑ | `outcome === "worse"` | Rule 2/3 above |
| ⚠ Mixed signals | `outcome === "mixed"` | Conflicting signals — needs a human |
| Stable | `outcome === "stable"` | No meaningful change |
| Getting better ↓ | `outcome === "better"` | Clean improvement |
| First reading — no prior | `outcome === "single"` | Baseline visit |

These five outcome tiles are **mutually exclusive** — one patient sits in exactly one of them (except the `partial` edge case above).

### 3.2 Biomarker Coverage ring

- **Ring %** = `HbA1c present / total`. Green ≥ 80 %, amber ≥ 60 %, else red.
- Shows "⚠ N missing — enter before visit" when any row lacks HbA1c.
- *Why:* the whole dashboard is blind without HbA1c, so coverage is the first thing to fix.

### 3.3 HbA1c Trend ring (stacked donut)

- **Denominator = `trendable`** — rows whose outcome is `better`, `worse`, `mixed`, or `stable`. `single` rows are excluded.
- Segments: Worse (red) · Stable (amber, computed as the remainder `100 − better% − worse%`) · Better (green).
- *Why:* percentages should describe only patients who actually have a comparison.

### 3.4 Today's visit flow

Driven purely by `status`, not by biomarkers:

| Row | Condition |
|---|---|
| Seen | `status === "seen"` |
| With doctor | `status === "in_visit"` |
| Checked in | `status === "checkedin"` |
| Pending | `total − seen − in_visit − checkedin − no_show − cancelled` (everything not yet actioned) |
| No-show | `status === "no_show"` |
| Cancelled | `status === "cancelled"` |

Rows with a zero count are hidden. Pending is a *remainder*, so the six rows always add up to the total.

### 3.5 The trend cards

| Card | Condition | Sort | Why |
|---|---|---|---|
| 📉 **Getting worse — Tier 1** | `outcome === "worse"` | biggest HbA1c rise first | Escalate the worst deterioration first |
| 📈 **Getting better — Tier 1** | `outcome === "better"` | biggest HbA1c drop first | Positive reinforcement / confirm the plan works |
| ⚠ **Flag for review** | `outcome === "mixed"` | list order | Tier-1 and Tier-2 disagree — **do not label these "improving"** without a doctor review |
| ➖ **Stable — Tier 1** | `outcome === "stable"` | list order | No meaningful change (HbA1c ±0.3 · SBP ±5). Adds a sub-note "stable but HbA1c > 9 / SBP ≥ 130" — stable ≠ at target |

Each row shows the **trigger chips first** — the markers named in the composite reason string (e.g. "TSH worsening" → the TSH chip leads), then the standard set `HbA1c · BP · FBS · LDL · TG`. Chip colour follows `targetStatus`, not the trend. The right-hand delta shows the first trigger marker that has both readings, falling back to HbA1c.

### 3.6 The three action cards (independent of outcome)

These use **HbA1c-only / status-only rules** and **overlap with each other and with the trend cards** — the same patient can appear in a trend card *and* here.

| Card | Condition (any one is enough) | Why |
|---|---|---|
| ⚠ **Needs extra attention** | `hba1c > 9` **OR** (`hba1c > prevHba1c` **and** `hba1c > 8`) **OR** `medPct < 60` | Worklist for the coordinator: severe, rising-from-a-high-base, or non-adherent |
| ✅ **On track today** | `hba1c ≤ 7.5` **AND** (no prior **OR** `hba1c ≤ prevHba1c`) | At/near target and not drifting up. Sorted lowest HbA1c first. Label reads "Controlled" if `category === "ctrl"`, else "Improving" |
| ⚠ **No biomarkers yet** | `hba1c` missing **AND** `status ≠ cancelled` **AND** `status ≠ no_show` | Actionable data gap — cancelled/no-show patients are excluded because nobody will enter their values |

---

## 4. Interaction

- **Click a row** → opens that appointment via `onSelectAppt`.
- **Ctrl / Cmd / Shift / middle-click** → opens `/visit?patient=<id>&appt=<id>` in a new tab, keeping the dashboard open.
- **Date picker**: today shows a green "Live · Updated hh:mm:ss" pill and auto-refreshes; any past date shows an amber "Historical view". Future dates are blocked.

---

## 5. Quick reference — "why is this patient here?"

| Situation | Lands in |
|---|---|
| HbA1c 8.2 → 9.4 (warn → bad) | Getting worse · also Needs extra attention (>9 and rising from >8) |
| HbA1c 9.8 → 8.6, LDL 95 → 140 | Flag for review (Tier-1 better, Tier-2 crossed to bad) |
| HbA1c 7.1 → 7.2, SBP 128 → 126 | Stable (both within stability threshold) |
| HbA1c 6.8, first ever visit | First reading — no prior; also On track today (≤ 7.5, no prior) |
| No HbA1c, status `pending` | No biomarkers yet; counts against Biomarker Coverage |
| No HbA1c, status `cancelled` | Excluded from "No biomarkers yet"; still counts in total |
| Only LDL has a prior, no Tier-1 prior | `partial` — counted in total but shown in **no** outcome tile |
