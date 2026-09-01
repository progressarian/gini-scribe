# Reception check-in — the front door

**Date:** 2 Sep 2026
**Status:** planned — not built
**Brief:** `Gini-Flow-Developer-Brief.docx` §4.2, §5 (Phase 2)
**Completes:** `06-PHASE-2-PLAN.md` §0.4 and §2.4, which decided this and then shipped only payments
**Route:** `/giniflow/station/reception` — a second tab on the screen that exists

The one gap that can block a real patient today: **nobody can put a patient on the floor by hand.**

---

## 1. What is missing, precisely

The brief's §4.2 has two halves:

> **Check-in:** mark arrival (visit → `checked_in`). This is also where `no_show`/`cancelled` get
> set.
> **Payment queue:** lab orders with `payment_status = pending` …

The payment queue is built (`receptionStation.js`, three routes, `ReceptionStationPage.jsx`). The
check-in half is not. Verified: **nothing anywhere in `server/services/` writes `checked_in`,
`no_show` or `cancelled`.** The only source of those three statuses is the HealthRay sync.

Phase 2 §0.4 took that decision deliberately and correctly —

> Reception check-in — HealthRay already reports `checkedin`. Reception's real Phase 2 job is
> **payments**, not arrival marking. **Keep an arrival button for walk-ins and corrections.**

— and then the arrival button never got built. §2.4 repeats it in one line ("Arrival marking stays
available for walk-ins, but is not the main job"). This plan is that line, finished.

## 2. Why it matters

| Situation                       | Today                                                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Walk-in with no HealthRay slot  | **Cannot enter the flow at all.** No appointment → `appointmentSync` never creates a visit → the patient is invisible to every station and every timer    |
| HealthRay lags or its auth dies | The patient is in the waiting room; the board says `booked`. Nobody can correct it. The `HealthRay auth expiry` failure mode makes this a when, not an if |
| Patient does not turn up        | No way to mark `no_show`. They sit in "Checked in" accruing a red timer and skewing the day's SLA figures                                                 |
| Appointment cancelled at desk   | Same — no way to say so                                                                                                                                   |

The third one is not cosmetic: the board's bottleneck banner and every station average are computed
from patients who look like they are waiting. A no-show nobody can clear is a permanent false alarm.

## 3. Which prototype

`gini-stations.html` → `#s-reception` — the same section the payment queue came from. It draws the
payment queue only; **the arrival controls are not in any prototype.** So this is the one screen in
Gini Flow with no mockup behind it, and it should therefore borrow rather than invent: the vitals
station's queue row (`.sq-item`) and the board's card chrome already exist and already read the way
this hospital's screens read.

## 4. The screen — two tabs on one page

```
Reception                                    [ Arrivals · 12 ]  [ Payments · 3 ]
```

`Payments` is today's screen, unchanged. `Arrivals` is new.

### 4.1 Arrivals

Three groups, in the order the desk works:

| Group            | Holds                                             | Actions                                   |
| ---------------- | ------------------------------------------------- | ----------------------------------------- |
| **Expected**     | `booked` · `confirmed` — today's list, not yet in | **✓ Arrived** · **No-show** · **Cancel**  |
| **On the floor** | `checked_in` and past it                          | none — read-only, with where they are now |
| **Not coming**   | `no_show` · `cancelled` today                     | **Undo** (back to `booked`)               |

Per row: appointment time, name, `age/sex · file no`, phone, and how long since their slot — a
patient 40 minutes past their appointment time is the one the desk should be phoning.

**Search is the primary control, not the list.** A receptionist works from a person standing in
front of them, not by scanning 80 rows. The existing server-side search (`searchDayVisits`) already
matches name, file number and phone; reuse it rather than filtering rendered rows.

### 4.2 Walk-in — the patient with no appointment

A button beside the search: **+ Walk-in**. Given a patient (searched by file no / phone / name),
it creates today's `giniflow_visits` row and checks them in, in one action.

**It must reuse `POST /api/walkins`,** which already exists and already:

- resolves identity via `resolvePatientId({ fileNo, phone })`,
- runs `checkPatientBlocked` with the force/role rules,
- carries the WhatsApp copy and the booking record.

A second walk-in path that skipped the blocklist would be a real safety regression — the blocklist
exists because some patients must not be booked. So: create the appointment through that route, then
create the visit from it. **Never insert a `giniflow_visits` row for a patient the blocklist refuses.**

## 5. The rules this has to respect

**5.1 The sync must not undo the desk.** `appointmentSync` maps HealthRay's status to the chain and
skips any visit already at or past the target — so a manually checked-in patient whom HealthRay still
calls `scheduled` is left alone. That guard is already correct and is what makes manual check-in
safe. **The smoke suite must assert it**, because it is the one thing that would silently erase this
feature: check in by hand, run the sync, assert the patient is still `checked_in`.

**5.2 `no_show` and `cancelled` are exceptions, not steps.** `advanceStatus` already accepts them
from anywhere and already allows recovery back into the chain (`isExceptionStatus` handling), with
`resume_status` preventing a patient from being walked backwards. Undo is therefore a normal forward
transition, not an edit — no new engine work.

**5.3 A no-show that turns up is re-checked-in, not un-no-showed.** The engine comment already says
this happens on a real floor. Undo puts them back to `booked`; the desk then presses Arrived.

**5.4 Blocked patients.** `appointmentSync` excludes them from the floor entirely. Arrivals must do
the same: a blocked patient searched at the desk shows their block reason and an explanation, not an
Arrived button.

**5.5 One visit per patient per day** is a database constraint. Check-in upserts on
`(patient_id, visit_date)` rather than inserting.

## 6. Server

`server/services/giniflow/receptionStation.js` gains:

| Function                                               | Does                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `getArrivals(visitDate, q, now)`                       | the three groups + counts, search applied server-side        |
| `markArrived(visitId, actorId)`                        | → `checked_in` via `advanceStatus`, `actorRole: "reception"` |
| `markNoShow(visitId, actorId)`                         | → `no_show`                                                  |
| `markCancelled(visitId, reason, actorId)`              | → `cancelled`, reason in `meta`                              |
| `undoArrival(visitId, actorId)`                        | exception → `booked`                                         |
| `checkInWalkIn({ patientId, appointmentId }, actorId)` | upsert the visit, then `checked_in`                          |

Every one goes through `advanceStatus` — no direct `current_status` writes (the rule the consultant
station's `returnToQueue` restored).

## 7. API

Behind the existing `GINIFLOW_STATION_RECEPTION` capability — no new capability, no RBAC change:

| Method | Path                                                | Body                            |
| ------ | --------------------------------------------------- | ------------------------------- |
| GET    | `/api/giniflow/stations/reception/arrivals`         | `?date&q=`                      |
| POST   | `/api/giniflow/stations/reception/:visitId/arrived` | —                               |
| POST   | `/api/giniflow/stations/reception/:visitId/no-show` | —                               |
| POST   | `/api/giniflow/stations/reception/:visitId/cancel`  | `{ reason }`                    |
| POST   | `/api/giniflow/stations/reception/:visitId/undo`    | —                               |
| POST   | `/api/giniflow/stations/reception/walk-in`          | `{ patientId, appointmentId? }` |

⚠️ **Route order:** these are `/:visitId/...`, and `/reception/:orderId/clear` already exists on the
same prefix. Register the literal `arrivals` and `walk-in` paths **before** any parameterised one —
the consultant station shipped this exact bug (`GET /doctor/medicines` swallowed by `/doctor/:visitId`).

## 8. Client

`ReceptionStationPage.jsx` gains a tab switch and an `ArrivalsTab` component; the payments view moves
into `PaymentsTab` unchanged. New hooks in the existing `useGiniflowReception.js`.

A cancel asks for a reason before it writes — the same rule blocking has (GF-18) and stopping a
medicine has: an action another station will see needs to say why.

## 9. Smoke coverage

`smoke:giniflow-reception` extended:

- the three groups, and a `booked` patient appearing in Expected;
- Arrived → `checked_in`, one event, `actor_role = 'reception'`;
- **the sync guard (§5.1)**: check in by hand → run `syncAppointments` → still `checked_in`;
- no-show → undo → `booked` → arrived, with every hop logged and none backwards;
- a blocked patient is refused;
- a walk-in creates exactly one visit and reuses the existing walk-in path;
- a second Arrived on the same patient is a no-op, not a second event.

## 10. Open questions

1. **Should `Arrived` also write back to HealthRay?** It cannot today — the sync is pull-only and
   HealthRay has no write API in this repo. So a manually arrived patient is Gini-Flow-only until
   HealthRay catches up on its own. Worth stating on the screen.
2. **Walk-in without a patient record.** `resolvePatientId` may find nobody. Does reception create
   the patient here, or is that still the existing registration path? Recommend: keep it out of this
   screen and link to the existing one.
3. **`no_show` timing.** Should it be offered only after the appointment time has passed, or always?
   Recommend always, since the desk knows things the clock does not.
