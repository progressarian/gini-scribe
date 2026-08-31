# The consultant's desk — call in, work, hand on

**Status:** built and live, 2026-08-26
**Applies to:** `/flow/my-patients` · roles with `hasOwnConsultQueue` (consultant) and admin
**Related:** `docs/FLOW_STATIONS.md`, `docs/PRESCRIPTION_FLOW_PLAN.md`

---

## 1. What the page is today, and what it is missing

`/flow/my-patients` is a **worklist**: my patients on the left, the rest of the floor on the
right, one **Open chart →** per row. Every other role on the floor has a desk — a queue, a
call-in, a box holding the patient in front of them, and a completing action. The consultant
has none of that.

### Who arrives here

Patients reach `sd_consult` (#10 of 14 with tests, #4 of 8 without) **after** their lab work
and after the assistant has handed the printed report to the consultant. So most arrivals
already have results in hand — which is the entire point of the gate that holds them there.

### The numbers that shape the design

|                                         |                                    |
| --------------------------------------- | ---------------------------------- |
| Consultations started by `opd-sync`     | **1,414** of 1,429                 |
| …by a person                            | 15 (2 by a consultant)             |
| Consultations completed **by a person** | **1,338** — 41%                    |
| `sd_consult` steps ever **claimed**     | **0**                              |
| Consultant logins ever                  | 384, most recent today             |
| Median duration                         | **83 min** against a 20 min budget |

Read together: consultants **are** in the system and do close their own steps, but the start
is always the sync noticing HealthRay, and nobody has ever been able to claim a patient —
because the button does not exist. The floor therefore cannot see which consultant has whom,
and the 83-minute median is measuring sync-to-close, not time with the patient.

---

## 2. Design

### Call in — claims, never double-starts

99% of consultations are already `in_progress` before the consultant looks. So **Call in**:

- if the step is `ready`/`pending` → `POST /flow/steps/:id/start` (starts and claims)
- if the sync already started it → `POST /flow/steps/:id/claim` (claims only)

Either way the patient lands in the box with the consultant's name on them. Nothing is
double-started, and for the first time the floor can see who holds whom.

**Disabled with a reason** when the reports gate is still closed — the same treatment the
nurse's Call in gets — so the consultant sees _"Reports not ready — waiting on Lab —
processing"_ before clicking rather than as an error after.

### The box

Mirrors a station's active box, with what a consultation actually needs:

```
┌ Mr. Kishor Lal · P_181507 · 71M · as Chief ────────────── 12m ─┐
│  [lab panel — results, flags, View report]                     │
│  Consultation notes …                                          │
│  [✓ Consultation done]  [✓ Prescription written]  [Open chart →]│
│  [↩ Release]                                                   │
└────────────────────────────────────────────────────────────────┘
```

- **✓ Consultation done** → `advance`, patient moves to the prescription stage
- **✓ Prescription written** → optional; completes `rx_ready` and releases the nurse
- **Open chart →** → the existing `loadPatientDB` route into the clinical app
- **↩ Release** → hand back without completing

### Open chart stays on every row

Deliberately **not** limited to the called-in patient. Consultants read the next patient's
history while finishing the current one, and with 99% of consultations started by the sync,
gating the chart behind a button nobody presses yet would remove access they have today. The
box gets its own prominent chart button; the row buttons stay.

### Permission change

`rx_ready` is owned by `mo`, and `canWorkStationRole('consultant', 'mo')` is **false** — so
the "Prescription written" button would 403 as things stand. `results-in` needs to accept the
patient's own consultant on that stage, alongside the MO and floor managers.

---

## 3. Build order

1. `results-in`: allow a consultant on `rx_ready`. Prove an unrelated role is still refused.
2. `useFlowClaimStep` already exists — wire Call in to start-or-claim.
3. The box, built from the existing `qrow`/`station-active` styles.
4. Gate Call in on the reports stage, message matching the nurse's.
5. Responsive pass: the box sits above both columns, full width.

Each step tested against live data before the next. **All five done.**

### Verified

```
lab role closing rx_ready              → This stage belongs to another station
a DIFFERENT consultant closing it      → This stage belongs to another station
the patient's own consultant           → {"ok":true}

Take patient (claim a synced consult)  → {"ok":true,"claimed_by":"Dr. Bhansali"}
another consultant claims the same     → Dr. Bhansali is already working this patient
✓ Consultation done                    → {"status":"advanced"}
✓ Prescription written                 → {"ok":true}
nurse can then call the patient in     → {"status":"started"}
```

The consultation step afterwards:

```
SD Consultation  completed  6m  claim:Dr. Bhansali · "Reviewed labs, titrated metformin"
```

A claim, a real duration and notes on a consultation — none of which existed before, since
`sd_consult` had been claimed 0 times in its entire history.

---

## 4. What this does not fix

The 83-minute median stays misleading until consultants actually press Call in — the sync
will keep starting the step, and `started_at` will keep meaning "HealthRay flipped the
appointment". The claim gives the floor a truthful "who has whom" immediately; honest
durations only follow once calling in is habit.

---

## 5. Release vs Cancel call-in

Two different intentions, so two buttons:

|                      | Claim   | Step status         | The minutes so far                       |
| -------------------- | ------- | ------------------- | ---------------------------------------- |
| **↩ Release**        | dropped | stays `in_progress` | stay on the consultation, still counting |
| **✕ Cancel call-in** | dropped | back to `ready`     | **moved into the preceding wait step**   |

Cancel is for "I opened the wrong patient". It does not discard the elapsed time — the
patient really did sit there — it moves it where it belongs. The waiting step this call-in
closed is **re-opened, back-dated** by what it had already accrued plus the cancelled
minutes, so it keeps counting until the patient is genuinely seen:

```
before   Wait for SD  completed 25m  ·  SD Consultation in_progress (8m)
cancel   → {"returned_wait_min":8,"returned_to":"Wait for SD"}
after    Wait for SD  in_progress, clock now 33m  ·  SD Consultation ready, no clock
re-taken Wait for SD  completed 34m  ·  SD Consultation clock started fresh
```

The consultation therefore measures only time actually spent with the patient, and the wait
carries the whole truth. `data.cancelled = { by, at, returned_wait_min }` and a
`call_in_cancelled` event record who did it.

Guards: only the claim holder or a floor manager; only an `in_progress` step; and never a
patient who has already moved past it ("This patient has already moved on"). Where a visit
has no preceding waiting step, the minutes are recorded on the event rather than invented
into a step that does not exist.
