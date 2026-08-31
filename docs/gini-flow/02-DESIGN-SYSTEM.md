# Gini Flow — Design system

**One design system for every Gini Flow screen** — the Flow Manager board, the four station
screens, the triage board, and the doctor and pharmacy screens that follow. They share one theme
file (`src/styles/giniflow-theme.css`), one set of tokens and one set of interaction rules; only
the components differ per screen.

Sourced from the prototypes in `docs/Flow-Manage/`. **The prototypes are the design spec — match
them closely** — with one caveat proven in Part 3: they do _not_ all share an identical `:root`,
despite the brief saying so, and where they drift this file rules on which value wins.

| Part                       | Covers                                                                    | Applies to                  |
| -------------------------- | ------------------------------------------------------------------------- | --------------------------- |
| **1. Foundations**         | tokens, typography, layout, interaction rules                             | every screen                |
| **2. Flow Manager board**  | the board's own components                                                | `/giniflow/manager` (built) |
| **3. Stations and triage** | token reconciliation, category palette, 12 new components, responsiveness | Phase 2 screens             |

---

# Part 1 — Foundations

Shared by every Gini Flow screen. Extracted once into `src/styles/giniflow-theme.css` (Task 1.6).

## Tokens

```css
:root {
  --bg: #f4f6f9;
  --white: #fff;
  --ink: #0f172a;
  --ink2: #334155;
  --ink3: #64748b;
  --ink4: #94a3b8;
  --bd: #e2e8f0;
  --bd2: #cbd5e1;
  --nv: #0f172a;
  --red: #dc2626;
  --red-l: #fef2f2;
  --red-b: rgba(220, 38, 38, 0.14);
  --amb: #d97706;
  --amb-l: #fffbeb;
  --amb-b: rgba(217, 119, 6, 0.14);
  --grn: #16a34a;
  --grn-l: #f0fdf4;
  --grn-b: rgba(22, 163, 74, 0.14);
  --blu: #2563eb;
  --blu-l: #eff6ff;
  --blu-b: rgba(37, 99, 235, 0.14);
  --pu: #7c3aed;
  --pu-l: #f5f3ff;
  --pu-b: rgba(124, 58, 237, 0.14);
  --tl: #0d9488;
  --tl-l: #f0fdfa;
  --tl-b: rgba(13, 148, 136, 0.14);
  --fb: "Inter", sans-serif;
  --fm: "JetBrains Mono", monospace;
  --fd: "Instrument Serif", serif;
  --sh: 0 1px 2px rgba(0, 0, 0, 0.05), 0 1px 3px rgba(0, 0, 0, 0.08);
  --sh-md: 0 4px 14px rgba(0, 0, 0, 0.1);
  --r: 8px;
  --r-lg: 12px;
}
```

Each semantic colour comes as a triple: solid (`--red`), light background (`--red-l`), border
(`--red-b`). Never hand-mix an opacity — use the token.

## Typography

| Font                    | Token  | Used for                                                                  |
| ----------------------- | ------ | ------------------------------------------------------------------------- |
| Inter 300–700           | `--fb` | all UI text                                                               |
| JetBrains Mono 400/500  | `--fm` | **every number** — timers, counts, clock, budgets, stat values, durations |
| Instrument Serif italic | `--fd` | the "Gini Flow" logo and patient names in modal headers only              |

Base size 13px, line-height 1.5. The UI is deliberately dense: labels 9–11px, card names 11px,
stat values 19px. Do not scale it up.

## Layout

Full-height flex column, `overflow:hidden` on `html,body` — the page never scrolls. Only the
board (horizontal) and each column body (vertical) scroll, with 3–5px custom scrollbars.

Rail 44px navy → stats strip → bottleneck banner → board (flex:1) → performance footer.
Columns are fixed 212px, `flex-shrink:0`, background `#eef1f5`, radius 12px.

## Interaction rules

Every Gini Flow screen, not only the board.

- Timers tick every second client-side off **server** time; data refetches every 10s. Never
  refetch to advance a clock, and never increment a counter — recompute `now − enteredAt` on
  each tick, so a backgrounded tab (where browsers throttle timers) self-corrects instead of
  drifting.
- Colour is always computed against the _current_ `giniflow_sla_config` value — saving the drawer
  recolours everything immediately with no reload.
- Emoji are used as station and status icons throughout; keep them, they carry meaning for
  staff scanning the board at distance.
- The board is a wall display as much as a workstation screen — it must stay readable and
  correct when left open all day, including after a network blip (keep last good data, show a
  stale banner, never blank the screen).

---

# Part 2 — Flow Manager board

The board's own components. Stations reuse the tokens and the interaction rules above, not these.

## Components

- **Timer chip (`.tmr`)** — mono, 10px, rounded 5px, in three states: `tmr-g` green <80 % of
  budget, `tmr-a` amber 80–100 %, `tmr-r` red >100 %. The single most important element on
  the board; the same three-way rule governs the footer bars, the timeline duration pills and
  the column `hot` state.
- **Patient card (`.pc`)** — white, 1px border, radius 8px, `--sh`. Hover: `--sh-md`,
  `translateY(-1px)`, border → teal. Whole card is clickable → timeline modal. Use a
  `<button>` or a card with a real focusable control, not a `div` with `onClick`
  (repo convention).
- **Avatar (`.pc-av`)** — 24px, radius 6px, two initials, white on a per-patient dark colour
  (`#374151 #1e3a5f #14532d #7c2d12 #7f1d1d #b45309`) — pick deterministically from the
  patient id so a face keeps its colour all day.
- **Category dot** — 🔴 worse/out of range · 🟡 worse in range or getting better · ✅ in
  control · 🔵 no reports. This mapping is inferred from the board prototype's cards; the
  triage prototype (not in this repo) is the authority — confirm before relying on it.
- **`wait4` strip** — dashed top border, 9px, appended to a card to say what it is waiting
  for. `.blocked` variant turns it red and bold.
- **Hot column** — background `#fdf0ef`, header/count/border in red, SLA sub-line shows
  "avg now 22m ⚠". Applied when the column's average wait exceeds its budget.
- **Stat tile** — white, or `.dark` (navy) for the headline journey figure. Value in mono,
  label 10px `--ink3`, sub-label 9px `--ink4`.
- **Drawer** — fixed right, 380px, `right:-380px → 0` over 0.25s, navy header, footer with
  teal primary + grey secondary buttons.
- **Modal** — 520px, `rgba(0,0,0,.5)` backdrop, navy header, closes on ✕ **and** backdrop click.
- **Toast** — bottom centre, ink background, 3s auto-dismiss.
- **Live dot** — 7px green, `pulse` 1.6s opacity animation.

---

# Part 3 — Stations and triage

From `gini-flow-v2.html` (vitals, pharmacy), `gini-stations.html` (reception, lab) and
`gini-triage-v3-final.html`. Read with `06-PHASE-2-PLAN.md`.

## Token reconciliation — the prototypes do not all share one `:root`

Checked token by token against `gini-flow-manager.html`, which is what Phase 1 shipped:

| Prototype                   | Tokens | Verdict                                                                                                                                                                                            |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gini-stations.html`        | 34     | **Identical.** Reception, lab and pharmacy need no theme work                                                                                                                                      |
| `gini-flow-v2.html`         | 42     | **16 new, 3 changed.** Adds `--c0…--c7` (an 8-colour avatar palette), mid-tones `--red-m --amb-m --grn-m --blu-m --pu-m --tl-m`, `--sh-lg`, `--r-xl`; softens the shadows                          |
| `gini-triage-v3-final.html` | 35     | **24 values differ.** A whole different greyscale — `--bg #f0f2f5` vs `#f4f6f9`, `--ink #0f1923` vs `#0f172a`, and every `--ink2/3/4`, `--bd` shifted. Adds `--nv2`, `--tll`, `--tlb`, `--mid-grn` |

**Decision needed (plan question 14):** normalise everything onto the Phase 1 theme, or let triage
keep its own palette. Recommendation: **normalise**, and adopt the additions.

- The differences are drift, not intent — a 2-point shift in four greys and a slightly warmer
  background reads as sloppiness when two screens sit side by side on one floor, not as design.
- The _additions_ are real and worth keeping: `--c0…--c7` replaces the avatar colours Phase 1
  hardcoded in JS, the mid-tones are needed by the triage columns, and `--mid-grn` has no
  equivalent.
- So: `giniflow-theme.css` gains the new tokens; the 24 drifted values stay as Phase 1 has them.

## Triage category palette

Five columns, each a category with its own colour and its own rule about who leads the patient:

| Category             | Column     | Token               | Leads                            |
| -------------------- | ---------- | ------------------- | -------------------------------- |
| `getting_worse_out`  | Red        | `--red`             | Dr. Bhansali leads               |
| `getting_worse_in`   | Amber      | `--amb`             | SD leads, Dr. Bhansali validates |
| `getting_better_yet` | Mid-green  | `--mid-grn` _(new)_ | SD closes, Dr. Bhansali async    |
| `in_control`         | Dark green | `--grn`             | SD closes independently          |
| `no_reports`         | Purple     | `--pu`              | Chase reports, send phlebotomist |

Colour is never the only carrier: each column is titled, and the Phase 1 rule that a category dot
carries a text label applies here too.

**Biomarker chips** are their own three-way scale, and it is _not_ the SLA scale — it compares a
value to its own previous reading:

- `.bc-r` red — rose **and** above threshold
- `.bc-a` amber — rose but still in range
- `.bc-g` green — fell or improved
- `.bc-n` neutral — no previous value (first report / new patient)

Thresholds: HbA1c >7 · FBS >130 · LDL >100 · TG >150 · UACR >30. Format `6.9 → 7.4 HbA1c`.

## New components Phase 2 introduces

| Component               | Where                            | Notes                                                                                        |
| ----------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| Station launcher tile   | both launchers (`s-land`)        | icon, name, one-line description, live count ("4 in queue", "6 pending 4 uploaded")          |
| Queue list              | vitals, lab, reception, pharmacy | "Now / Next / timed" grouping; tap a row to load the detail pane                             |
| Two-pane station layout | vitals, pharmacy                 | queue left, work right — the shape every station screen shares                               |
| Progress rail           | lab                              | `Payment ✓ › Collect sample › Process › Upload`, current step emphasised                     |
| Bucket counters         | lab, reception, pharmacy         | 3–5 counts above the list, each a filter                                                     |
| Workflow banner         | lab, reception                   | ⚡ one line stating the cross-station effect ("upload → MO sees Results ready")              |
| Bio chip                | triage                           | `prev → current name`, four-state colour                                                     |
| Pipeline bar            | triage                           | 8 counts: total, lab in, uploaded, data complete, categorised, assigned, checked in, no-show |
| Doctor pill             | triage                           | assignment control _and_ display filter — one control, two jobs                              |
| Voice-entry panel       | vitals                           | prompt text + live fill of the form                                                          |
| Dispense checklist      | pharmacy                         | per-medicine row: change marker, route/timing, stock, quantity                               |
| Counselling note        | pharmacy                         | Hindi plain-language block, read aloud to the patient                                        |

## Responsiveness — every Phase 2 prototype is fixed-width desktop

`@media` count: **zero, in all three files.** Phase 1 settled this for the board (wall display and
desktop, ≥1024px, explicit notice below 900px). Stations cannot inherit that answer unexamined —
they are worked at a desk, and some may be worked standing:

| Station                  | Likely device                 | Implication                                                                                                                                    |
| ------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Triage board             | large screen                  | as the Flow Manager — desktop only is fine                                                                                                     |
| Reception, Lab, Pharmacy | counter PC                    | desktop only is fine                                                                                                                           |
| **Vitals**               | **tablet, possibly handheld** | the one screen with a real case for touch and a narrow layout — it is used beside the patient, and voice entry implies a device held near them |

**Decision needed (plan question 15):** which stations must work below 1024px. Cheapest honest
answer: desktop-only for triage, reception, lab and pharmacy; **vitals responsive down to tablet**,
with touch-sized targets on the queue rows and the seven inputs. Deciding this after the screens
are built is a rewrite, not an adjustment.

Two rules carry over from Phase 1 regardless: a station screen left open all day must show
staleness rather than lie, and no screen may scroll the page — the queue and the work pane scroll
independently, with `min-height: 0` at every level of the flex chain.
