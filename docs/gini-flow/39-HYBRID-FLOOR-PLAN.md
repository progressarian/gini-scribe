# 39 — The hybrid floor: manual stations, auto doctors, and a stuck signal

Status: **COMPLETE. All six steps shipped 11 Sep 2026.** Step 4 — the hold — went in last, at the floor's explicit second request, and carries its own switch (§14).
Follows `38-MANUAL-FLOOR-PLAN.md`, which made Scribe the system of record and switched the
HealthRay sync down to the patient list. This plan puts two stations back on auto — the ones
no human works — and turns the resulting disagreement into the point rather than the problem.

---

## 1. What was asked

> Reception marks the patient arrived by hand. Then vitals. When vitals are done the patient
> appears at Lab 1 or the Machine Room — whichever is in their billing. If **both** are
> billed, they go to lab collection first; only once the technician marks the sample collected
> does the machine test appear. Then they wait for the reports. When everything is uploaded
> they go to the consultant — **and that part syncs automatically**, because no MO and no
> Chief uses Scribe. After the consultation the patient goes to the prescription counter
> (manual) and finally to pharmacy (manual).
>
> And: **if HealthRay says the patient is with the MO or the Chief but an earlier station has
> not ticked its step, the patient must stay stuck at that earlier station in Scribe** — so we
> can see that HealthRay has them with the Chief while Scribe still has them at vitals, and
> know who is not doing their job.

The last paragraph is the real design. Everywhere else a sync disagreeing with the floor is a
bug to suppress; here it is the **measurement**. Scribe stops being a mirror of HealthRay and
becomes the thing that says which desk is not recording its work.

---

## 2. Where the floor actually is (measured, 4 days to 11 Sep 2026)

Who writes each step today — the number that decides how much of this is a code change and
how much is a change in what people do:

| Step               | Visits | By a person | By the sync | Reading                     |
| ------------------ | -----: | ----------: | ----------: | --------------------------- |
| `checked_in`       |    259 |      **10** |     **249** | reception is not doing this |
| `with_vitals`      |    144 |         144 |           0 | vitals is fully manual      |
| `vitals_done`      |    212 |         162 |          50 | mostly manual               |
| `sd_pending`       |      6 |           6 |           0 | Chief station barely used   |
| `with_sd`          |     11 |          12 |           0 | 11 visits in 4 days         |
| `ready_for_doctor` |     37 |           1 |          36 | the sync drives this        |
| `with_doctor`      |     14 |           1 |          13 | the sync drives this        |
| `rx_pending`       |     85 |           3 |          84 | the sync drives this        |
| `with_rx`          |      9 |           9 |           0 | manual, lightly used        |
| `pharmacy_pending` |     41 |          41 |           0 | manual, working             |
| `dispensed`        |     41 |          41 |           0 | manual, working             |
| `exited`           |    231 |          41 |         190 | the sync closes most visits |

Two things follow that are not code:

- **Reception has to start arriving patients.** 249 of 259 check-ins are written by the sync.
  Under this plan that number goes to zero and becomes 60–90 taps a day at the desk. On the
  morning of 11 Sep, 15 recovered walk-ins sat at `booked` while HealthRay already had 13 of
  them `checkedin` and 2 `in_visit` — two already with a doctor. That is the new normal until
  the desk works the screen.
- **The Chief column stays manual, permanently.** 11 visits in 4 days, every one written by a
  person — and §6.1 shows HealthRay has no MO patient flow to sync at all. So the Chief/MO
  station is not one of the two that go on auto; only the consultant is.

---

## 3. The sequence, station by station

| #   | Station           | Who records it           | Cannot start until                                      |
| --- | ----------------- | ------------------------ | ------------------------------------------------------- |
| 1   | Reception arrival | **person** (reception)   | —                                                       |
| 2   | Vitals            | **person** (vitals)      | arrival recorded                                        |
| 3a  | Lab 1 collection  | **person** (lab)         | vitals done¹, order billed and paid                     |
| 3b  | Machine Room      | **person** (machine)     | vitals done¹, order paid, **and every lab order drawn** |
| 4   | Reports uploaded  | **person** (lab/machine) | the test performed                                      |
| 5   | Chief / MO        | **auto** (HealthRay)     | 1–4 all recorded                                        |
| 6   | Consultant        | **auto** (HealthRay)     | 1–4 all recorded                                        |
| 7   | Rx counter        | **person** (rx)          | consultation finished                                   |
| 8   | Pharmacy          | **person** (pharmacy)    | Rx explained                                            |

¹ Except samples-only visits — see §7 D3.

Rule 3b is the one new piece of sequencing: **the blood comes first.** A patient billed for
both HbA1c and an ABI is drawn at Lab 1 and only then offered to the machine room. Expressed
through the machine card's existing `blockedReason`, so the card is _visible but not
actionable_ — the machine technician can see who is coming and why they cannot start yet,
which is strictly better than hiding the row.

---

## 4. What HealthRay is allowed to write

`38`'s flag is all-or-nothing: `SCRIBE_MANUAL_FLOOR=1` stops the sync mirroring any status.
That becomes a **per-status allowlist** instead — the sync may write only the steps no human
works:

| HealthRay status      | Writes today       | Writes under this plan                                    |
| --------------------- | ------------------ | --------------------------------------------------------- |
| `scheduled`           | `booked`           | `booked` — unchanged, creation only                       |
| `checkedin`           | `checked_in`       | **nothing** — reception's to record                       |
| `in_visit`            | `ready_for_doctor` | `with_doctor` — the consultant, and only ever that (§6.1) |
| `completed` / `seen`  | `exited`           | **`rx_pending`** — auto stops before the Rx desk          |
| `cancelled`/`no_show` | as named           | unchanged (see §7 D2)                                     |

The `completed → rx_pending` change is the important one. Today HealthRay closing a visit
writes `exited`, which jumps the patient past the Rx counter and Pharmacy in a single event —
so those two desks would never see a queue. Landing at `rx_pending` lets auto take the patient
as far as the Rx desk's door and no further. It also means **~40 auto-exits a day stop**, and
the Pharmacy queue becomes the real list of who is still in the building.

---

## 5. The no-skip rule, and the stuck signal

Two changes make "stuck" happen instead of "skipped":

**5.1 `allowSkip: false` for auto writes.** The sync currently advances with `allowSkip: true`,
which is what lets one event carry a patient from `booked` to `exited`. For the allowlisted
statuses it must refuse a jump instead.

**5.2 An explicit precondition check.** Before the sync may write `with_sd`, `with_doctor` or
`rx_pending`, all of this must already be recorded _by a person_:

- arrival (`checked_in` written by a non-`system` actor), and
- vitals (a `giniflow_vitals` row, or `vitals_done` by a person) — unless the visit is
  samples-only, and
- every one of the visit's `urgency='today'` orders at `reported` — if it has any.

If a precondition fails the sync **does not advance the chain.** It records what HealthRay
said and which station is behind, and leaves the patient where the floor left them.

**5.3 The observation is stored, not applied.** New columns on `giniflow_visits`:
`healthray_status`, `healthray_status_at`, `behind_station`. The chain position stays the
floor's; HealthRay's position rides alongside. `behind_station` is the first station in §3
whose step is unrecorded — the desk to chase.

**5.4 Two places it shows** (chosen):

- **A badge on the board card** — `⚠ HealthRay: with Chief · not ticked at Vitals`. Seen by
  whoever is already looking at the board.
- **A "Behind" panel** — every visit whose HealthRay position is ahead of its Scribe position,
  grouped by `behind_station`, with how long it has been that way. The floor manager's
  worklist, and the answer to "who is not working".

No end-of-day report for now.

---

## 6. What has to change

| #   | Work                                                                                                                    | Where                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| W1  | Per-status allowlist replacing the boolean flag                                                                         | `shared/manualFloor.js`                                  |
| W2  | Remap `HEALTHRAY_STATUS_TO_CHAIN`: drop `checkedin`, split `in_visit` by doctor role, `completed`/`seen` → `rx_pending` | `shared/giniflowStatus.js`                               |
| W3  | Preconditions + `allowSkip: false` on every auto write; compute `behind_station`                                        | `server/services/giniflow/appointmentSync.js`            |
| W4  | Migration: `healthray_status`, `healthray_status_at`, `behind_station` on `giniflow_visits`                             | `server/migrations/2026-09-11_healthray_observation.sql` |
| W5  | Vitals gate on the lab and machine queues, with the samples-only exception                                              | `labStation.js`, `machineStation.js`                     |
| W6  | Machine blocked until every lab order on the visit is drawn                                                             | `machineStation.js`                                      |
| W7  | Badge on the board card                                                                                                 | `giniflow/board.js`, board card component                |
| W8  | The "Behind" panel                                                                                                      | new service fn + a tab on the board (`GINIFLOW_BOARD`)   |
| W9  | `smoke:hybrid-floor` — asserts each gate refuses, and that an auto write never skips a manual step                      | `server/scripts/smoke-hybrid-floor.mjs`                  |

W7's gate already half exists: `results_status='ready'` and moStation's `awaitingResults` cover
"reports are in". W3 reuses that rather than inventing a second rule.

---

### 6.1 Why `in_visit` can only mean the consultant

The ask was to tell "with the Chief/MO" apart from "with the Consultant" using the booked
doctor's role. **HealthRay has no MO patient flow to read.** Measured over 90 days, by the
Scribe role of the doctor the appointment names:

| Booked doctor's role | Appointments | No-show | Actually attended |
| -------------------- | -----------: | ------: | ----------------: |
| `consultant`         |        9,334 |   2,749 |         **6,423** |
| `mo`                 |          301 |     301 |             **0** |
| no Scribe account    |          265 |     264 |                 1 |

**Every MO-booked appointment is a no-show. All 301 of them, over three months.** The only
`mo` HealthRay books at all is `Dr Beant Kaur` — 516 appointments since April, 100% `no_show`,
`is_walkin`, visit_type `OPD`, and **not one of them has ever produced a Gini Flow visit.**
They are not a patient flow; they are rows nobody attends.

Two consequences:

- **`in_visit` resolves to `with_doctor` and nothing else.** There is no data from which to
  derive "with the Chief", so D-b as originally chosen is not implementable.
- **The dot-tolerant name join is not worth doing.** It was proposed here as W0 on the belief
  it was losing 86 consultant assignments a month. Measured properly, the tolerant join
  resolves **exactly the same 2,978 consultants** as the exact one — the 86 it "gains" are all
  Dr Beant Kaur, whom the `role = 'consultant'` filter excludes either way. Gain: zero rows,
  now and under any later plan. Dropped.

None of this weakens §5. The stuck signal never needed the Chief column: HealthRay still
reports `checkedin`, `in_visit` and `completed`, and comparing those three against the manual
chain is what exposes a station that has not recorded its step.

---

## 7. Decisions

**Taken (11 Sep 2026):**

- **D-a — `completed`/`seen` land at `rx_pending`,** not `exited`. Auto stops before the Rx desk.
- **D-b — WITHDRAWN 11 Sep 2026, on the evidence in §6.1.** Chosen as "resolve Chief vs
  Consultant from the booked doctor's role", then measured: HealthRay has no MO patient flow
  (301 MO appointments in 90 days, 301 no-shows, 0 attended). `in_visit` → `with_doctor` only;
  the Chief/MO station stays manual, as it already is.
- **D-c — samples-only visits skip the vitals gate** and appear at Lab 1 as soon as reception
  arrives them. They already live in the Lab track, not the consultation columns.
- **D-d — the stuck signal shows as a card badge and a "Behind" panel.** No daily report yet.

**Still open:**

- **D1 — does anything still need the Chief column on auto?** §6.1 says it cannot be done
  from HealthRay. If the Chief's work has to appear in Scribe, the only route is the Chief
  using the MO station — which is the thing this whole plan exists to work around. Worth
  confirming that a manual-only Chief column is acceptable.
- **D2 — should `no_show` and `cancelled` stay on auto?** They are not steps a station
  performs — they are the absence of an arrival — and HealthRay writes 110 of them in 4 days
  while the desk writes none. Proposed: keep them automatic. Note this contradicts a strict
  reading of "everything manual", so it needs saying out loud.
- **D3 — the 184 appointments in 7 days with `doctor_name = NULL`.** They resolve to no role
  at all. Proposed: treat as consultant, the current default.

---

## 8. Sequencing

Each step is safe to ship on its own, and none of them empties a queue that was full:

1. **W2 `completed` → `rx_pending`, plus W1. SHIPPED 11 Sep 2026** — see §10. On its own this
   fills the Rx and Pharmacy queues with the ~40 visits a day the sync used to close, and
   changes nothing else.
2. **W4 + W3 observation only. SHIPPED 11 Sep 2026** — see §11. Store `healthray_status` and
   `behind_station`, still allowing today's advances. Nothing changes on screen; the data to
   judge the rest appears.
3. **W7 + W8 the badge and the panel. SHIPPED 11 Sep 2026** — see §12. Reading what step 2
   records. Now the floor can _see_ the disagreement before any patient gets held up by it.
4. **W3 preconditions on. SHIPPED 11 Sep 2026** — see §14. This is the step that actually
   strands patients, so it went last and only with the panel already up.
5. **W5 + W6 the routing gates. SHIPPED 11 Sep 2026** — see §13. Independent of 1–4.
6. **W9** alongside each.

Step 4 before step 3 would strand patients with nothing to show anyone why.

---

## 9. The risk worth naming

This plan deliberately makes Scribe **wrong on purpose** — a patient the hospital has already
seen will sit at `vitals_done` in Scribe because nobody ticked a box. That is the intent: the
gap is the measurement. But it means every number Scribe reports — journey time, station SLA,
the outcomes report — measures _recording behaviour_, not patient flow, until the desks are
actually working the screens. Nobody should read a Gini Flow duration as a clinical fact while
this is on.

---

## 10. What step 1 shipped (11 Sep 2026)

| Where                            | Change                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `shared/manualFloor.js`          | `HEALTHRAY_MAY_WRITE` + `healthrayMayWrite()` — the allowlist; `healthrayTarget()` — where a finished consult lands    |
| `giniflow/appointmentSync.js`    | both blanket manual-floor guards replaced by the per-status check; the implied arrival gated; medicines lookup skipped |
| `giniflow/staleVisits.js`        | an HR-completed leftover is swept `exited`, not `abandoned`                                                            |
| `cron/index.js`                  | the sync's log line now reports how many steps it refused                                                              |
| `scripts/smoke-hybrid-floor.mjs` | 27 checks, including a real sync run on a date of its own                                                              |

`HEALTHRAY_STATUS_TO_CHAIN` is deliberately **untouched** — the `completed → rx_pending`
departure lives in `healthrayTarget()` behind the flag, so `SCRIBE_MANUAL_FLOOR=0` still
restores the old behaviour exactly, which is the property 38 was built on. `SYNCABLE` therefore
still carries `checkedin`, which matters: dropping the key would stop the day's walk-ins being
fetched at all, and no visit would be created for them.

### The leak live data caught

Advancing a patient into the consultant's queue used to **imply** the arrival on the way
(`meta.implied`), writing reception's own step with `actor_role: 'system'`. The allowlist was
checked on the target, so this slipped past it — visible within minutes of the worker
restarting as one `checked_in` written by the sync. Now gated on
`healthrayMayWrite("checked_in")`, and pinned by a test asserting the sync writes **no**
`checked_in` event at all. The chain simply carries the gap, and because every rail is drawn
from events, reception's un-ticked step shows — which is what §5 wants anyway.

### Measured on the live floor, first 10 minutes

| Written by the sync today | Count | Note                                       |
| ------------------------- | ----: | ------------------------------------------ |
| `ready_for_doctor`        |     9 | the consultant step — allowlisted          |
| `no_show`                 |     7 | an absence, not a step (D2)                |
| `rx_pending`              |     2 | **finished consultations, once `exited`**  |
| `with_doctor`             |     1 | the room was free                          |
| `exited`                  | **0** | was ~40/day; the counter closes visits now |

---

## 11. What step 2 shipped (11 Sep 2026)

An observation layer. It moves nobody — every test asserts both that the right station is
named **and** that `current_status` did not budge.

| Where                                             | Change                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `migrations/2026-09-11_healthray_observation.sql` | `healthray_status`, `healthray_status_at`, `behind_station` + a partial index for the panel     |
| `giniflow/observation.js`                         | `recordHealthrayObservation()` — one statement a tick; `getBehindTheFloor()` — the panel's read |
| `giniflow/appointmentSync.js`                     | calls it last, so it reads the floor after this tick's own advances                             |
| `cron/index.js`                                   | the log line now reports how many visits are behind a desk                                      |
| `scripts/smoke-observation.mjs`                   | 24 checks                                                                                       |
| `scripts/check-behind.mjs`                        | a CLI reader for the week of watching this step exists to buy                                   |

### Design decisions taken while building

- **Five stations can be behind, not eight**: `reception → vitals → lab → lab_results →
machine`. Rx and Pharmacy are excluded because they come _after_ everything HealthRay knows
  about, so HealthRay can never be ahead of them — a slow counter is an SLA question the board
  already times. The lab is split in two because Lab 1 owing a blood draw and Lab 2 owing a
  result are different desks to chase.
- **An arrival the sync wrote does not count as an arrival.** The reception test is
  `actor_role <> 'system'`, which is the whole point of the measurement.
- **Written only when something changes**, so `healthray_status_at` means "since when" — the
  age the panel needs — rather than "last polled", and a 30-second loop does not rewrite every
  row on the floor all day.
- **A patient off the day is nobody's backlog.** Exception and terminal statuses are excluded
  entirely, so a no-show is never reported as a desk being behind.

### Measured on the live floor, first run

`0 created, 0 advanced, 63 refused (a station's own step), 14 behind a desk, 0 errors of 83`

| HealthRay says  | Scribe says        | Visits | Behind        |
| --------------- | ------------------ | -----: | ------------- |
| `scheduled`     | `booked`           |     36 | —             |
| **`checkedin`** | **`booked`**       | **14** | **Reception** |
| `checkedin`     | `vitals_done`      |      9 | — floor ahead |
| `in_visit`      | `ready_for_doctor` |      8 | —             |
| `completed`     | `rx_pending`       |      3 | —             |
| `checkedin`     | `checked_in`       |      3 | —             |
| `seen`          | `rx_pending`       |      2 | —             |
| `in_visit`      | `with_doctor`      |      1 | —             |

**Reception is the only desk behind, with all 14.** Vitals, Lab 1, Lab 2 and the Machine Room
have nothing outstanding — 9 visits are further along in Scribe than in HealthRay, which is the
floor running _ahead_ of the hospital's own record.

That is §2's prediction confirmed from the other direction: the one station that was having its
work done for it by the sync is the one station now visibly behind. It is also the argument for
step 3 before step 4 — 14 patients is a backlog the desk can clear in a morning, but only if
somebody can see it.

---

## 12. What step 3 shipped (11 Sep 2026)

The disagreement is now on screen, in two places, and still stops nobody.

| Where                               | Change                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `giniflow/board.js`                 | the card carries `behind` — station, label, HealthRay's reading, and how long the gap has stood       |
| `giniflow/observation.js`           | `getBehindVisits()` — the worklist; `healthrayChainStatus()` — HealthRay's status as a chain position |
| `routes/giniflow.js`                | `GET /api/giniflow/behind`, on `GINIFLOW_BOARD`                                                       |
| `schemas/index.js`                  | `giniflowBehindQuerySchema` — the station validated against the shared list, not free text            |
| `FlowManagerPage.jsx`               | the card badge, and the collapsible Behind panel above the board                                      |
| `giniflow.css`                      | `.wait4.behind` and the panel                                                                         |
| `queries/hooks/useGiniflowBoard.js` | `useGiniflowBehind()`, on the board's own poll cadence                                                |
| `scripts/smoke-observation.mjs`     | 6 more checks — 30 total                                                                              |

### Decisions taken while building

- **The badge reuses the card's existing `.wait4` line**, the same idiom as `blockedReason` and
  the lab hint — not a new component. Amber, not red: the patient is fine, the record is not.
- **A card carries the warning or nothing.** There is no "in agreement" badge, because nobody
  needs to read one 60 times a day.
- **The panel is collapsed by default.** On a floor that is keeping up it is empty, and an
  empty panel must not push the board down the page. Its header is the whole summary —
  `14 patients a desk has not ticked · Reception 14` — so it is useful shut.
- **Both readings sit side by side in every row**, HealthRay's and Scribe's. Neither is
  presented as the truth; the gap is the subject.
- **No new capability.** It answers the same question the board does and is gated on
  `GINIFLOW_BOARD`.

### Measured on the live floor

| Desk      | Waiting on a tick | Longest |
| --------- | ----------------: | ------: |
| Reception |            **14** |     11m |

Every other desk: nothing. The panel names all 14 patients, worst wait first, each showing
`HealthRay: checked_in · Scribe: booked`.

**One caveat about the ages on day one.** `healthray_status_at` is written when the observation
first _changes_, so today every gap reads 11 minutes — the age of the first run after the
column existed, not how long the patient has really been waiting on a tick. From tomorrow it
measures the real thing.

### What step 4 still needs before it is safe

Step 4 is what makes the gap actually strand a patient. The panel now says the whole backlog is
**one desk and 14 patients** — clearable in a morning. Before turning preconditions on, watch
this number for a few days: if Reception's count falls as the desk picks up the habit, step 4
costs nothing; if it stays at 14 every day, step 4 would strand a seventh of the floor.

---

## 13. What steps 5 and 6 shipped (11 Sep 2026)

The order the patient walks the floor in: **vitals → Lab 1 draw → Machine Room.**

| Where                             | Change                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `shared/labStages.js`             | `UNDRAWN_SAMPLE_STATUSES` — one definition of "still in the patient", now that two stations ask |
| `giniflow/machineStation.js`      | both gates on the card's `blockedReason`, and `assertReadyToStart()` in the service             |
| `giniflow/labStation.js`          | `assertVitalsRecorded()` on the draw                                                            |
| `giniflow/observation.js`         | uses the shared status list instead of its own copy                                             |
| `scripts/smoke-routing-gates.mjs` | 20 checks                                                                                       |

### The two rules, and what each refuses

**G1 — neither bench starts before vitals are recorded.**

- Machine card: `Vitals not recorded yet — the patient goes to vitals first`
- Service: `Probe NOVITALS has no vitals recorded yet — the patient goes to vitals before the ABI`
- Lab draw: `…the patient goes to vitals before the draw`

**G2 — a patient billed for blood as well as a machine is drawn first.**

- Machine card: `Blood not drawn yet — Lab 1 collects before the machine`
- Service: `Probe BOTH is billed for blood as well — Lab 1 draws the sample before the Fundus`

### Decisions taken while building

- **Both gates apply to STARTING the work and nothing else.** A test already on the machine, or
  a tube already drawn, must never become unfinishable because of a box nobody ticked upstream —
  that would trap a patient mid-test. Pinned by a check that finishes a running test with no
  vitals ever recorded.
- **Blocked, never hidden.** The machine card stays on screen with its reason, so the technician
  can see who is coming and why they cannot start. Pinned.
- **Recorded by a person, or not at all.** "Vitals done" means a `giniflow_vitals` row or a
  `vitals_done`/`with_vitals` event whose actor is not `system` — deliberately NOT
  `current_status`, because the sync can still write `ready_for_doctor`, which would otherwise
  count as proof of a vitals step nobody performed.
- **Samples-only registrations are exempt from G1.** They never take vitals and never see a
  doctor; requiring the step would strand every one of them — 7 of 15 walk-ins on the day this
  was written.
- **Enforced in the service, not just the card.** The existing house rule: a hidden button is
  not a rule, and a stale tab is exactly the case hiding does not cover.

### Two things the tests caught

- **`smoke:machine-steps` broke on its own fixtures** — its synthetic visits set
  `current_status = 'vitals_done'` but wrote no vitals event, so G1 correctly refused them. The
  fixtures now record vitals; the vitals gate has its own suite. A rule that breaks an older
  suite's assumptions is the rule working.
- **The suites' `finally` block could report "all checks passed" after an exception** skipped
  every remaining check. `smoke:routing-gates` now has a `catch` that fails loudly. The other
  suites share the shape and should get the same treatment.

---

## 14. What step 4 shipped (11 Sep 2026) — the hold

The requirement, in the floor's own words: _"if pt is with mo or chief in healthray that should
struck in scribe if previous step is not done by the station head"._

| Where                             | Change                                                                      |
| --------------------------------- | --------------------------------------------------------------------------- |
| `shared/manualFloor.js`           | `holdOnUnrecorded()` — its own switch, `SCRIBE_HOLD_ON_UNRECORDED`          |
| `giniflow/observation.js`         | `firstUnrecordedStation()` — the per-visit half of the panel's own question |
| `giniflow/appointmentSync.js`     | the hold, immediately before the write; refusals counted as `held`          |
| `cron/index.js`                   | the log line reports how many were held                                     |
| `scripts/smoke-floor-journey.mjs` | the whole spec as one journey — 19 checks                                   |
| `scripts/check-held.mjs`          | a CLI reader for what the hold is holding                                   |

### How it works

Before the sync writes an allowlisted chain status, it asks
`firstUnrecordedStation(visitId)`. If any station before that point still owes its step, the
write does not happen: the patient stays where the floor left them, and `behind_station` names
the desk. An absence — `no_show`, `cancelled` — is never held, because it is not a step anybody
performs.

**The gate and the panel share one definition of "recorded."** `firstUnrecordedStation` uses the
same SQL predicates as the day-wide observation, in the same module, deliberately: if they
disagreed, the floor would be held at a station the panel reports as up to date, which is worse
than either behaviour alone.

**It has its own switch.** `SCRIBE_HOLD_ON_UNRECORDED="0"` releases the hold in one environment
change while every other part of the manual floor stays as it is. This is the only rule here
that can strand a real patient on a working morning, so releasing it must not mean unpicking
anything else.

### The spec, as an executable test

`smoke:floor-journey` walks one patient — billed for blood **and** a machine — through all nine
sentences of the ask, and ends on the one that matters:

```
ok  THE PATIENT IS HELD AT THE UN-RECORDED STEP — booked — HealthRay says in_visit
```

Before step 4 that same check read `with_doctor`. It is the only assertion in the suite that
changed behaviour; the other 18 passed already.

### Measured the moment it went live

`0 created, 7 advanced, 62 refused, 4 held at an un-recorded step, 12 behind a desk, of 90`

| Desk      | HealthRay says | Scribe holds at | Patients |
| --------- | -------------- | --------------- | -------: |
| Reception | `checkedin`    | `booked`        |       21 |
| Reception | `in_visit`     | `booked`        |        2 |
| Vitals    | `in_visit`     | `checked_in`    |        1 |
| Reception | `completed`    | `booked`        |        1 |

**25 patients, 24 of them at Reception, worst wait 41 minutes.** Three of those are past the
point of no return for the day: two are with a doctor and one has finished their consultation,
and Scribe will hold all three at `booked` until somebody taps Arrived.

### The thing to watch tomorrow

This is the rule the floor asked for, and it is doing exactly what was asked. But the cost is
now real and visible: **a quarter of the day's patients are held, and one desk owns almost all
of it.** Two outcomes, and the number tells you which:

- Reception picks up the habit, the count falls toward zero, and the board becomes an honest
  record of the floor for the first time.
- The count stays at 25 every day, in which case the hold is not measuring a lazy desk — it is
  measuring a desk that cannot keep up with 60–90 arrivals, and
  `SCRIBE_HOLD_ON_UNRECORDED="0"` is the honest response while the staffing is looked at.

Watch it with `node scripts/check-held.mjs`.
