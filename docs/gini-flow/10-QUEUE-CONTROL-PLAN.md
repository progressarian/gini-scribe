# Board queue control — priority, manual order, drag-to-move

**Date:** 1 Sep 2026
**Status:** implemented
**Reviewed by:** `09-QUEUE-CONTROL-REVIEW.md` (3 blocking · 2 high · 5 medium · 2 low — all settled below)

Written after the review rather than before it, which inverts the repo's convention. It is here so
"is this done, and why does it behave like this?" has a reference point.

---

## 1. The problem

The Flow Manager board showed the floor in one order: longest waiting first, per column. A
coordinator watching the board could see that the wrong patient was about to be called and had no
way to say so from the screen — the only correction was to walk to the station and tell someone.

Two things were missing, and they are different things:

- **Priority** — a property of the patient. An 82-year-old with chest pain outranks the person who
  arrived before them, at vitals, at the SD desk, and at the doctor's door. It should follow them.
- **Order** — a property of a queue. "Call this one next, here, now." It means nothing once the
  patient has moved on.

Plus the physical correction: a patient the board thinks is at vitals who is actually at the SD desk.

## 2. What was built

| Piece                                                                                                   | Where                                    |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `priority`, `queue_position`, `queue_column`, `priority_reason`, `priority_set_by/at`                   | `2026-09-01_giniflow_priority_queue.sql` |
| `PRIORITIES`, `COLUMN_ENTRY_STATUS`, `ORDERED_COLUMNS`, `nextColumn`, `canDropInColumn`, `compareQueue` | `shared/giniflowStatus.js`               |
| `setPriority`, `reorderColumn`, `moveToColumn`                                                          | `server/services/giniflow/queue.js`      |
| 3 endpoints behind `GINIFLOW_MANAGE_QUEUE`                                                              | `server/routes/giniflow.js`              |
| Optimistic cache writes                                                                                 | `src/queries/hooks/useGiniflowQueue.js`  |
| Drag, drop targets, ⋮ menu, ❗ indicator, confirm dialog                                                | `src/pages/giniflow/FlowManagerPage.jsx` |
| Sort rule, drop matrix, all three services                                                              | `smoke:giniflow-queue`                   |

The ordering rule, once, in `shared/`: **manual position → priority → longest waiting.** The board
service applies it and the client applies it again after an optimistic drag, so the two cannot
disagree about what the board should look like.

## 3. Decisions

**Priority is not an event.** Every duration in Gini Flow is the gap between consecutive
`giniflow_visit_events` rows. An event that is not a journey step would restart the patient's station
timer and split their timeline. Priority is a property of the visit, like `category` and
`blocked_reason`, and is stored the same way — with `priority_set_by/at` for attribution.

**Priority survives a status change; manual position does not.** Position means "call this one next
_at this station_". `advanceStatus` clears it on every move, and `queue_column` records which queue a
position was set for so that a status written by any other path — a backfill, the demo seeder — can
never pin a patient to the top of a column they have already left (BQ-06).

**Setting a priority clears the manual position** (BQ-01). The manager has just said something
stronger about where the patient belongs; a positioned card sorts above every unpositioned one, so
keeping the old position would pin an urgent patient below the person they were meant to overtake.

**A drag crosses exactly one column — measured in columns, not chain steps** (BQ-02). The first
implementation measured the drag against `MAX_FORWARD_JUMP = 2` on the chain, which rejected the
ordinary case: the SD column holds three statuses and pharmacy two, so a card is usually not sitting
at its column's entry status, and `vitals_done → ready_for_doctor` is one column but three steps.
Adjacency is the rule the person dragging can see, and it bounds the skip to one station however many
statuses that station contains. `moveToColumn` checks it server-side and only then sets `allowSkip`,
so a caller hitting the API directly gets the same bound. This makes the board the second legitimate
`allowSkip` caller after the HealthRay sync; the engine's comment names both.

**A drop on Done writes `dispensed`, not `exited`, and asks first** (BQ-03). `exited` skipped the
pharmacy, so pharmacy time was never measured for that visit, and it is the last status in the chain
— under append-only rules the mis-drop could never be corrected. `dispensed` is the step the drop
actually describes. `exited` is left to the HealthRay sync, which is authoritative for a visit being
finished. A confirmation dialog names what it does, because a touch wall display makes mis-drops
cheap.

**A blocked patient cannot be dragged** (BQ-05). `advanceStatus` clears `blocked_reason` on any move
out of `blocked_reports`, while GF-18 _requires_ a reason to set one. Allowing the drag would let an
undocumented gesture undo a documented decision. Blocks are cleared where they were set; the card
menu says so instead of greying out silently.

**The lab track is neither sorted nor a drop target** (BQ-04). It is timed on its own clock against
`lab_total`, so `compareQueue`'s last tiebreak — `statusMinutes` — would order it by how long the
patient has been waiting somewhere else entirely. It keeps the SQL's ordering, as Done does.

**Rearranging is off while the board is filtered, searched, or showing a past date.** A reorder sends
the column's whole order, so it can only be done against the whole column; dragging a filtered column
would write positions for the visible cards and leave everyone else unplaced beneath them.

**A partial reorder says so** (BQ-08). The board polls every 10s, so a card can move on between the
render the manager dragged and the request landing. Those ids are ignored rather than failing the
whole reorder — and returned, so the UI can say "2 patients had already moved on".

**`GINIFLOW_MANAGE_QUEUE` is coordinator and admin only** (BQ-10). Reception clearing a lab bill has
no reason to be able to move any patient to any station.

**Every drag has a keyboard equivalent.** The ⋮ menu carries priority, move up/down within the
column, and the same forward move a drop would make. Phase 1 already took findings on drag-only
interactions (GF-16).

## 4. Not done, deliberately

- **No undo.** The log only moves forward; a correction is a new forward event. The Done confirmation
  is the mitigation, not a substitute.
- **No priority history.** `priority_reason` and `priority_set_by/at` hold the current value only.
  Keeping priority out of the event log is what protects the timers (BQ-07); a separate audit table
  would be the way to add history if the floor asks for it.
- **No per-category priority budgets.** Still open from Phase 1 — a red-category patient arguably
  deserves a longer doctor budget, not just a higher place in the queue.
- **No index on the new columns** (BQ-12). The board fetches the whole day and sorts in Node.

## 5. Deploying

```bash
cd server && node migrations/_runOne.mjs migrations/2026-09-01_giniflow_priority_queue.sql
npm run smoke:giniflow-queue
```

The migration must run before the board is served: `getDayBoard` selects the new columns.
