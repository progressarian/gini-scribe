# 89 — The Rx MO works on the same screen as Dr Bhansali

## Problem

The Rx MO (`rx_mo`, `doctors.assists_doctor_id` = Dr Anil Bhansali) sits in
Dr Bhansali's room, in front of the patient, and writes his prescriptions
(`docs/NEW_PATIENT_WORKUP_PLAN.md`, decisions 3–4). The MO and Dr Bhansali are on
**different screens**:

| | Dr Bhansali | Rx MO today |
|---|---|---|
| Station | Chief Endocrinologist, `/giniflow/station/mo` | Consultant, `/giniflow/station/doctor` |
| His patients' status while in the room | `with_sd` (Chief Endocrinologist Assessment) | Same visit, but this screen only counts `ready_for_doctor` / `with_doctor` as "with me" |
| Result | — | The MO's queue files the patient under "pipeline". The launcher shows **0 waiting** while the patient is in front of them. |

Dr Bhansali's patients never pass through the consultant step: the journey is
Wait for Chief → Chief Endocrinologist Assessment → Rx explain. The MO is
therefore looking at a screen built for another kind of doctor. Its rail,
buttons and statuses don't match what Dr Bhansali sees, so the two of them
can't follow one patient together.

## Change

**An Rx MO gets the screen of the doctor they assist.** When the assisted doctor
works the Chief Endocrinologist station (`is_chief`, or the doctor's
`chief_step`), the MO's tile and queue are the Chief station. Otherwise they
stay the Consultant station, as today. Nothing changes for an MO assisting an
ordinary consultant.

For Dr Bhansali's MO:

1. **Launcher.** One tile, **"Chief Endocrinologist · Dr. Anil Bhansali"**,
   opening `/giniflow/station/mo`. The count reads "N assigned to you · M with
   Dr. Bhansali", using the Chief station's own counts.
2. **Queue.** The Chief station list with the same cards, rail, statuses and
   elapsed times Dr Bhansali sees. It is limited to the patients assigned to
   this MO on the triage board (`rx_mo_id`).
3. **Patient screen.** The same workup → plan → tests → prescription screen
   (`MoStationPage`), open at the same time on both computers. Each edit saves
   immediately, and the other screen refreshes on its normal poll.
4. **Actions.** Which buttons the MO may press is decision 2. Every action is
   logged under the MO's own id. Floor timings still count against
   Dr Bhansali, because the patient is in his room.
5. **The printed Rx** still shows Dr Bhansali's name, qualification and Reg. No.
   (`savePrescriptionForVisit` with the visit's appointment, unchanged).

## Server

- `stations/summary` and the launcher choose the station from the assisted
  doctor. The `rx_mo` entry in `GINIFLOW_LAUNCHER_CAPABILITY` becomes `mo_sd`
  for a chief-assisting MO.
- `rx_mo` gains `GINIFLOW_STATION_MO`.
- The fail-closed guard (`server/middleware/assistedPatientGuard.js`) opens:
  - `GET /api/giniflow/stations/mo` (the queue), forced to visits with
    `rx_mo_id` = the MO;
  - `/api/giniflow/stations/mo/:visitId/*`, only for visits assigned to the MO
    (writes: today only);
  - `stations/mo/test-panels`.

  Everything else under `/api/giniflow` stays 403, as now.
- The Chief station's ownership check (`assigned_sd_id === actor`, takeover /
  release in `moStation.js`) treats the assisting MO as Dr Bhansali, so the MO
  doesn't "take over" his patient by opening it.

## Decisions (27 Oct 2026)

1. **Queue:** only the patients assigned to this MO on the triage board
   (`rx_mo_id`), shown with the Chief station's cards.
2. **Actions:** everything Dr Bhansali can press — Start, order tests, write and
   finalise the Rx, Ready / send to the Rx desk — logged as the MO.
3. **Tiles:** the Consultant station tile is removed for a chief-assisting MO.
   They get one tile, the Chief station.

## Not in scope

- How the floor routes Dr Bhansali's patients, the Chief step, billing, and the
  Rx desk and pharmacy flow.
- MOs assisting non-chief consultants. They keep the Consultant station.

## Tests

`e2e/visit/V05-rx-mo-chief-station.spec.js` (local test DB):

1. A chief-assisting `rx_mo` sees the Chief tile, and its count includes a
   `with_sd` patient.
2. The Chief queue shows only the MO's assigned visits, never an unassigned
   one or another doctor's.
3. The MO opens a `with_sd` patient. The visit's `assigned_sd_id` stays
   Dr Bhansali (no takeover).
4. The MO writes and finalises the Rx. The print shows Dr Bhansali. The audit
   shows the MO.
5. The MO can Start, order tests and send to the Rx desk on an assigned visit,
   and is refused on an unassigned one.
6. Other `/api/giniflow` paths stay 403 for the MO.
7. An `rx_mo` assisting a non-chief consultant still gets the Consultant
   station, unchanged.
