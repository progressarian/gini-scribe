# 50 · Any order across the four test stations

Status: built 16 Sep 2026 — Phases 1–6. Migration `2026-10-06_lab_collection_started.sql` not yet applied.

## The rule, in the floor's words

A patient appears on **every** test station they have an open test for — four
tests, four stations; three, three; one, one. **Any** of those stations may start
its test. **Once one station has started, the others wait until that station
marks its step Done**, and then any of them may take the patient next.

Decided:

- **Machine tests may start before Lab 1 has drawn blood.** The "Lab 1 first"
  gate goes.
- **No message to the patient.** No tracker update, no WhatsApp. The floor calls
  the patient by voice; the screens only need to agree on who has them.

The four stations: Lab 1 (collection), Machine Room, X-Ray, Echo.

## What the code does today (checked, 16 Sep 2026)

**Visibility is already right.** Each machine station's queue
(`machineStation.js:~300`) lists every machine order whose tests belong to that
station, whatever the board shows; Lab 1 lists every undrawn lab order and
HealthRay case. A patient with four tests is already on four screens.

**Machine-to-machine order is already free.** `assertMachineFree`
(`machineStation.js:172`) only stops one _machine_ taking two patients. Nothing
stops X-Ray starting before the Machine Room.

**One gate does all the sequencing.** `assertReadyToStart`
(`machineStation.js:212`) refuses every machine while `BLOOD_NOT_DRAWN_SQL`
finds blood still to draw — _"Lab 1 draws the sample before the {machine}"_ —
and the queue shows the same reason (`needsBloodFirst`, `machineStation.js:~378`).
This is what is being removed.

**Nothing stops two machine stations having the patient at once.** The lab
already refuses to collect while a machine test is running (`on_machine` in
`labStation.js` `assertPatientIsFree`), but nothing checks the other directions:
`assertMachineFree` checks the _machine_, never the patient, so the Machine Room
and X-Ray can both start the same person, and with the blood gate gone a machine
could start while Lab 1 is mid-draw. **The blood gate was accidentally covering
one of those collisions**, so it cannot go without the lock below going in
alongside it.

**Lab 1 has no "started" moment.** `LAB_RUNGS` (`shared/labStages.js`) goes
`pending` → `collected` in one tap, "✓ Mark sample collected". Machines have a
real `in_progress` (`shared/machineStages.js`). The rule needs both.

**The board would lie.** `placementFor` (`board.js:580`) checks
`labUndrawn > 0` _before_ a machine, so with the gate gone a patient on the X-Ray
table who has not been bled yet would show in the Lab column.

**Kept, unchanged:** vitals before any test (clinical; lab-only patients
exempt); **X-ray before Echo** (`flow_step_catalog.machine_requires_before`,
plan 46 — Echo keeps showing the patient with "X-ray must be done first");
payment before any test; one board column per patient; machine budgets; no exit
with an open test.

## The design

No new table, no "called" state, no timeout. **The lock is the running test.**

A patient is _busy_ when any station has a test for them in its started state:

| Station                     | Started         | Done — patient free again |
| --------------------------- | --------------- | ------------------------- |
| Lab 1                       | `drawing` (new) | `sample_collected`        |
| Machine Room / X-Ray / Echo | `in_progress`   | `done`                    |

A machine releases the patient at `done`, not `reported`: the report can follow
later without them (`needsPatient: false` on the `reported` rung). Lab 1 releases
at `sample_collected`: send, receive, process and upload happen without the
patient.

### Phase 1 — Lab 1 gets a start

- A new rung `drawing` between `pending` and `collected` in `LAB_RUNGS`:
  action **"▶ Start collection"**, `needsPatient: true`, room `collection`.
- Orders: sample status `drawing` (not `collecting`, which was already a bucket name). `sample_status` has no CHECK, so no migration; it joins `UNDRAWN_SAMPLE_STATUSES` automatically (a tube is not drawn until it is collected).
- HealthRay cases: case action `drawing_started`, which does need the migration (the action list is CHECK-constrained). `CASE_ACTION_VERBS` is
  derived from the rungs, so it comes for free.
- **Cost to the floor:** one extra tap per patient at Lab 1. This is what the
  rule needs; without it Lab 1 can never hold a patient.
- "Cancel start" on both sides, so a mistaken start doesn't hold the patient —
  `drawing` → back to its previous status, `in_progress` → back to its previous status; the start event is erased and the cancel logged on a `station` track.

### Phase 2 — one station at a time, enforced by the database

One service function, `busyElsewhere(client, visitId, station)`, used by every
start:

1. `SELECT … FROM giniflow_visits WHERE id = $1 FOR UPDATE` — serialises
   every start for this patient, so two stations pressing Start in the same
   second cannot both pass the check. Same pattern `advanceStatus` already uses.
2. Busy if any machine order for the visit is `in_progress` at a **different**
   station, or any lab order is `drawing` / case has `drawing_started` without `sample_taken`.
3. Refuse with 409 and the station's name: _"Rama is on the X-Ray — wait until
   X-Ray marks it done"_.

Called from `advanceMachineTest` (start only) and Lab 1's collection start. A
test already running is never blocked from finishing.

**Within one station the station decides** (today's behaviour): the Machine Room
holding the patient may run ABI then VPT back to back, or together. The lock is
between stations, not between machines.

### Phase 3 — remove the blood gate

- Drop `blood_not_drawn` from `assertReadyToStart` and `needsBloodFirst` from the
  machine queue's `blockedReason`.
- Valve for rollback, as with every floor rule: `SCRIBE_BLOOD_BEFORE_MACHINE=1`
  brings the old gate back. **Default is the new behaviour** — the floor has
  decided.
- Ships in the same deploy as Phase 2, never before it (see "Nothing stops two
  stations" above).

### Phase 4 — the screens

- The same busy check feeds `blockedReason` on all four queues, so a busy patient
  shows _"🔒 On the X-Ray — wait until done"_ with Start disabled, instead of a
  button the service will refuse. The four screens already refresh on the
  `lab_order` event stream, so the lock appears within a second of Start without
  new plumbing.
- When the station releases, the card becomes startable again with no action
  from anyone.

### Phase 5 — the board

Still one column per patient (plan 47, settled). Precedence in `placementFor` and
`owningMachineStation` becomes:

1. the station with a started test — Lab 1 (`drawing`) or a machine
   (`in_progress`);
2. otherwise today's order.

So a patient on the X-Ray table shows in X-Ray, not Lab, even with blood still to
draw. The card subtitle lists what is still open ("Next: Lab 1 · Echo") so the
coordinator can see the choice the floor has.

### Phase 6 — the stuck lock, and the test

- **A start nobody finishes locks the patient out of the other three rooms.**
  There is no automatic timeout — the rule is "wait until Done". Instead the
  lock shows its age against the test's own budget (`planned_duration_min`), and
  the coordinator (`GINIFLOW_MANAGE_QUEUE`) gets **Release** on the board,
  recorded with who and why.
- `server/scripts/smoke-test-station-lock.mjs` (`npm run smoke:station-lock`, 33 checks): two stations start the same
  patient at once (one succeeds, one 409); a machine starts with blood undrawn;
  Lab 1 is refused while X-Ray is running; release at `done` / `sample_collected`
  frees the other three; Echo is still refused before X-ray; same-station back to
  back still works.

## One thing to watch

A machine test cannot be marked `done` without values or a report attached
(the evidence gate, `machineStation.js:795`) unless the machine `hands_over`.
Under this rule that gate now also decides how long the patient is locked: a
technician who has finished the scan but not yet attached the printout keeps the
other three rooms waiting. If that bites, the fix is to release the patient at
"test finished" and keep the evidence gate on `reported` — a change to the
machine rungs, left out until the floor sees whether it matters.

## Sequencing

Phase 1 (Lab 1 start) can ship on its own. Phases 2 + 3 ship together. Phases
4–5 make it visible, Phase 6 before it runs unattended.
