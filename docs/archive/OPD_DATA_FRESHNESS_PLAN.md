# OPD Dashboard — Data Freshness Plan

**Status:** proposal · nothing implemented
**Page affected:** `/opd?tab=dashboard` (and, by extension, the period report and Triage v3)
**Goal:** stop months-old readings being presented as today's, and make the cut-off configurable from a settings screen.

---

## 1. What the code does today

There is **no recency limit anywhere** in the biomarker pipeline. Four independent fallback chains each take _the most recent value available, however old it is_.

| Source                          | Where                                                 | Window today |
| ------------------------------- | ----------------------------------------------------- | ------------ |
| Latest / previous labs          | `server/routes/opd.js:635` (`labByPt`, `prevLabByPt`) | none         |
| Clinic vitals (BP, weight, BMI) | `server/routes/opd.js:684` — `ROW_NUMBER() … rn <= 2` | none         |
| Patient-app readings            | `server/routes/opd.js:722` (`appReadingsByPt`)        | none         |
| Appointment-history back-fill   | `server/routes/opd.js:776` (`prevHistByPt`)           | none         |

The history fallback is explicit about it. The comment in the source reads:

> _Walking the appointment history fills the gap with the most recent prior value **regardless of how old it is**._

These four are merged at `server/routes/opd.js:907` (`candidates`), sorted newest-first within a source-priority tier, and collapsed into one winning value per marker. The winner becomes today's reading; the runner-up becomes the "previous" reading used for the trend.

### Consequences

1. **A patient's "today" HbA1c can be eight months old.** It gets promoted into the row by the lab or history fallback with no marker of its age.
2. **The coverage tile overstates reality.** "HbA1c on file — 74/108" counts these stale promotions, so the true fresh-data coverage is lower than the ring shows.
3. **Verdicts run on stale inputs.** Getting worse / Flag for review / On track are all computed from whatever won the merge.
4. **Nothing on screen reveals the age.** `_lab_dates` is tracked internally (`opd.js:861`) but never surfaced to the UI, and no equivalent exists for the previous value at all.

---

## 2. Two traps to avoid

### Trap 1 — a single "look back N days" setting would gut the dashboard

Current values and prior values need **opposite** treatment.

Set one window to 21 days and apply it to both, and almost no patient will have a _prior_ reading inside 21 days. Every one of them collapses to the `single` outcome → **"First reading — no prior"**. Getting better, Getting worse and Flag for review all empty out and the trend ring goes blank.

The data would be fresher and the dashboard useless.

**Therefore: two windows.**

| Setting                 | Meaning                                                               | Suggested default |
| ----------------------- | --------------------------------------------------------------------- | ----------------- |
| `freshness_days`        | How recent must a value be to count as **today's** reading            | 21                |
| `baseline_max_age_days` | How old may the **comparison** value be before a trend is meaningless | 540 (18 months)   |

### Trap 2 — one number across all markers is clinically wrong

Markers have different natural cadences. A 21-day window discards essentially every HbA1c on file, because HbA1c is a quarterly test.

| Marker         | Sensible freshness | Why                          |
| -------------- | ------------------ | ---------------------------- |
| SBP / DBP      | 14–21 days         | measured at every visit      |
| FBS / PPBS     | 30 days            | routine, frequently repeated |
| HbA1c, TSH     | 90–120 days        | quarterly tests by design    |
| LDL / TG / HDL | 180 days           | typically 6–12 monthly       |
| UACR / eGFR    | 180 days           | annual-to-biannual screening |

**Therefore: one global default plus a per-marker override map**, seeded with the table above.

---

## 3. Where enforcement must live

**Server-side, inside `/api/opd/appointments`.** That endpoint is where all four fallbacks converge and collapse into a single value.

### Client-side (localStorage) cannot work as-is

The API returns only the _winning_ value, not the candidate list with dates. The browser has no way to know a value is four months old, so it cannot filter. Any client-side approach requires the same API change first — at which point the server is the right place to do it.

localStorage would also mean each coordinator sees different numbers on the same screen, with no audit trail.

### Touch points

| #   | Change                                     | File                             |
| --- | ------------------------------------------ | -------------------------------- |
| 1   | Date filter on the history back-fill query | `opd.js:776`                     |
| 2   | Date filter on the lab_results queries     | `opd.js:635`                     |
| 3   | Date filter on the vitals window function  | `opd.js:684`                     |
| 4   | Date filter on patient-app readings        | `opd.js:722`                     |
| 5   | Age check in the candidate-priority walk   | `opd.js:907`                     |
| 6   | Return the dates so the UI can show age    | `opd.js:953` (`prev_biomarkers`) |

Every candidate already carries its date (`{ val, date, priority }`), so filtering is a comparison, not new plumbing.

---

## 4. Behaviour recommendation

**Grey stale values out and exclude them from the verdict — do not hide them.**

Hiding creates a cliff: a patient's row goes blank with no explanation, and the coordinator has no idea whether data is missing or merely old.

Proposed treatment:

| State  | Chip                          | Counts toward coverage? | Feeds the verdict? |
| ------ | ----------------------------- | ----------------------- | ------------------ |
| Fresh  | `HbA1c 7.2` normal colour     | yes                     | yes                |
| Stale  | `HbA1c 7.2 · 4 mo old` greyed | **no**                  | **no**             |
| Absent | no chip                       | no                      | no                 |

This tells the doctor two things at once — the last known value _and_ that it is old — and matches the plain-language direction the rest of the dashboard has moved in.

---

## 5. Phasing

### Phase 1 — see it before changing it _(~half a day, zero risk)_

Return `biomarker_dates` and `prev_biomarker_dates` per row. Show "as of 12 Jun" on chip hover; grey anything beyond a hardcoded threshold. **No behaviour change, no setting yet.**

_Why first:_ you immediately see how much of the 74/108 is stale, which tells you what thresholds are actually right. Choosing numbers before seeing this is guesswork.

### Phase 2 — the two windows _(~1 day)_

Implement `freshness_days` and `baseline_max_age_days` across the six touch points above. **Ship defaulted to unlimited**, so deploying changes nothing until the values are turned on.

### Phase 3 — the settings feature _(~1–2 days)_

There is **no settings infrastructure in this codebase today** — no `app_settings` table, no settings page, no config endpoint. This phase builds it:

- table `app_settings (key text primary key, value jsonb, updated_at timestamptz, updated_by text)`
- `GET / PUT /api/settings/opd-dashboard`, behind the same capability gate as other admin routes
- a ⚙ panel on the OPD page: global default, per-marker overrides, baseline age
- invalidate the appointments query on save so the dashboard refreshes immediately

This is the bulk of the work. The filtering itself is comparatively easy.

### Phase 4 — make the other views agree _(~half a day)_

`OpdRangeReport` and Triage v3 share the same classifier. If the window applies only to the dashboard, the period report will disagree with it — the same class of bug already seen between Flow Reports and Flow Coordinator, where one word meant two different things on two pages.

---

## 6. Rollout safety

- **Default to current behaviour.** Unlimited windows on deploy; opt in by changing the setting.
- **Preview before applying.** The settings panel should state the impact before saving — _"With a 21-day window, HbA1c on file drops from 74 to 31."_ Without this, the first save looks like data loss.
- **Expect the tiles to move.** Coverage falls, "First reading — no prior" rises, and the trend buckets shrink. That is the point, but it needs to be communicated to whoever reads the dashboard daily.
- **Update the guides.** `docs/OPD_DASHBOARD_GUIDE.md` and `docs/OPD_DASHBOARD_FLOW.md` both describe the current unlimited behaviour and would become wrong.

---

## 7. Decisions needed before Phase 2

1. Stale values **greyed and excluded**, or **hidden entirely**?
2. **Global number only**, or global default + per-marker overrides?
3. Who may change the setting — **admin only**, or any coordinator?
4. Does the window apply to the **period report** as well, or the dashboard only?

---

## 8. Effort summary

| Phase | Deliverable                    | Effort    |
| ----- | ------------------------------ | --------- |
| 1     | Ages visible, nothing changes  | ~0.5 day  |
| 2     | Two windows, defaulted off     | ~1 day    |
| 3     | Settings table + API + ⚙ panel | ~1–2 days |
| 4     | Report + Triage aligned        | ~0.5 day  |

Phases 1–2 deliver most of the clinical value. Phase 3 is what makes it "a feature in settings".
