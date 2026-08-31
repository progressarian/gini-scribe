# Gini Flow — Design system

Extracted from `docs/gini-flow-manager.html` — the only prototype in this repo. The brief
states all 8 prototypes share an identical `:root` block, so this doubles as the shared theme
for any Flow screen built later. Extract it once (Task 1.6) into `src/styles/giniflow-theme.css`
before building the board.

**The prototype IS the design spec. Match it closely.**

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

## Interaction rules

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
