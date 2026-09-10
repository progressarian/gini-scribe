# 36 — Machine Test station (ABI · VPT · Fundus · TMT · Echo · ECG)

Status: **REVIEW + DRAFT PLAN. Nothing implemented, nothing changed.**
Companion to `35-LAB-TWO-ROOM-SPLIT-PLAN.md`, which this deliberately mirrors where the two
are alike and departs from where they are not.

---

## 1. What was asked

A station for the machine tests — **ABI, VPT, Fundus, TMT, Echo, ECG** — covering how it is
built, who manages it, and what the flow is.

---

## 2. What already exists

More than expected. Four separate parts of the system already know about these tests, and
none of them are joined up.

### 2.1 They are already journey steps — with durations and a station

`flow_step_catalog` (26 rows, read by **giniflow**'s `journey.js`, not just the retired flow
module) already carries five of the six:

| id       | name     | duration | station | role     | order |
| -------- | -------- | -------- | ------- | -------- | ----- |
| `abi`    | ABI Test | 10 min   | Lab     | lab_tech | 4     |
| `vpt`    | VPT      | 5 min    | Lab     | lab_tech | 35    |
| `fundus` | Fundus   | 10 min   | Lab     | lab_tech | 37    |
| `tmt`    | TMT      | 20 min   | Lab     | lab_tech | 36    |
| `ecg`    | ECG      | 5 min    | Lab     | lab_tech | 38    |
| `x_ray`  | X-RAY    | 15 min   | Lab     | lab_tech | 22    |

**Echo is the only one missing.** Also note `lab_delivered`, `lab_processing`, `lab_reports`,
`mo_review`, `report_printed` and `report_delivered` all carry
`attach_when_any: ["blood_sample", "abi", "x_ray"]` — so the report-chasing chain was already
designed to fire for machine tests, not just blood.

**But nobody uses them.** `giniflow_visit_steps` today holds Vitals, MO, SD, Rx, Pharmacy,
Billing and Blood Sample — **not one** ABI, VPT, Fundus, TMT or ECG step has ever been placed.
The definitions are dormant.

### 2.2 The reports already arrive on their own

Documents on the chart, all time:

| doc_type       | count | latest       |
| -------------- | ----- | ------------ |
| `vpt`          | 2,272 | today        |
| `abi`          | 2,209 | today        |
| `eye` (Fundus) | 1,611 | yesterday    |
| `xray`         | 689   | today        |
| `tmt`          | 25    | 2 days ago   |
| `ecg`          | 21    | **Apr 2026** |
| `echo`         | 3     | Jul 2026     |

**6,119 of 6,138 came from the HealthRay sync**; 16 from a Companion upload. So the station's
job is _not_ to get reports in — that already works. Two things follow:

- **ABI, VPT and Fundus are daily, high-volume work** (~4 + ~3.5 + ~2.5 a day).
- **TMT, Echo and ECG are rare.** 25, 3 and 21 reports _in the system's whole history_, and
  ECG has produced nothing since April. Whatever these three are, they are not a daily queue —
  see question **Q3**.

### 2.3 ABI and VPT already produce structured values

`lab_results` carries `ABI Right`/`ABI Left` (311 each in 90 days) and `VPT Right`/`VPT Left`
(317 each), parsed out of the report by `healthray/parser.js`, which names them explicitly.
So these two are already trendable numbers on the chart, not just PDFs.

### 2.4 The hospital already calls this a category

`healthray/billingExtractor.js` maps HealthRay's **"Machine Test"** department to
`category: "machine"` and raises a journey step per line item — beside `imaging` (RADIOLOGY)
and `lab` (PATHOLOGY). The vocabulary exists upstream; Gini reads it and then drops it on the
floor.

### 2.5 The staff exist

Two active `tech` accounts: **ECG Technician (23)** and **X-Ray Technician (24)**. They hold
`GINIFLOW_STATION_LAB_COLLECT` today — i.e. they are currently pointed at the blood
collection room, which is not what either of them does.

---

## 3. The gap, stated plainly

- A machine test ordered through Gini Flow lands in **`giniflow_lab_orders`** and therefore
  appears in the **Lab Collection room**, where the card asks a phlebotomist to draw a sample.
  `ECG` is in the live `giniflow_test_catalog` at ₹300, so this is reachable today.
- The journey steps that would put a patient at a machine are defined but never placed.
- Nothing on any screen shows a patient is _at_ a machine, so a 20-minute TMT is invisible
  floor time.
- The two technicians who run these machines have no screen of their own.

---

## 4. Proposed design

### 4.1 A machine test is not a sample

The lab ladder tracks a **tube** moving away from the patient — which is why it needs
`sent` and `received`. A machine test never leaves the patient: **the patient is the sample.**
So the ladder is shorter and the constraint is inverted — the patient must be present for the
_whole_ test, not just its first step.

```
ordered  →  in progress  →  done  →  report filed
   │            │            │            │
 billed/     patient at   test taken,  PDF on the chart
 requested   the machine  patient free (usually by sync)
```

Four rungs, one room, no handoff. `report filed` is usually reached by the HealthRay sync
rather than by anybody tapping — the station's job there is to show what has NOT arrived.

### 4.2 Where it differs from the lab rooms

|                | Lab                  | Machine                                  |
| -------------- | -------------------- | ---------------------------------------- |
| What moves     | the tube             | nobody — the patient sits at the machine |
| Patient needed | for collection only  | for the whole test                       |
| Handoff        | yes (send → receive) | none                                     |
| Duration       | uniform              | 5 min (VPT/ECG) → 20 min (TMT/Echo)      |
| Report         | uploaded by the lab  | arrives by sync; upload is the exception |
| Rooms          | two benches          | one room per machine group (**Q1**)      |

### 4.3 What to reuse rather than rebuild

`35`'s machinery generalises almost completely:

- **`shared/labStages.js` is the pattern**, not the content — a `shared/machineStages.js` with
  the same shape (rungs carrying labels, room, action verbs, timeline labels) gives the same
  guarantees, and the same class of drift bug stays impossible.
- The station scaffolding — `visibleRungs` / `roomOwns` / `attachLabRoom` / the room-derived
  capability gate — is already written and proven; it takes a second station's rungs as-is.
- `flow_step_catalog` already holds the durations, which is what an SLA needs.
- The `LabRoom` component is already parameterised; a `MachineRoom` is the same shape.

### 4.4 Who manages it

The two existing `tech` accounts are the obvious owners, with a `GINIFLOW_STATION_MACHINE`
capability. That is a proposal, not a decision — see **Q2**.

---

## 5. Questions I need answered before planning further

**Q1 — One station or several?**
ABI, VPT and Fundus are plausibly one room with one queue. TMT and Echo are cardiology and may
be a different room, possibly a different floor. Is this **one** "Machine Test" station, or
one per machine group?

**Q2 — Who staffs it?**
Use the existing `tech` role (ECG Technician, X-Ray Technician), or a new `machine_tech` role
the way `lab_admin` was added for the analyzer bench? And should they keep the collection room
they hold today, or move off it entirely?

**Q3 — Are TMT, Echo and ECG actually done in-house?**
The numbers say almost never — 25, 3 and 21 reports ever, with ECG silent since April, against
2,272 for VPT. If these are referred out, they belong in the **Referrals** station
(`19-REFERRALS-STATION-PLAN.md`), not here, and this station is really "ABI · VPT · Fundus".

**Q4 — Should X-Ray be in scope?**
You did not list it, but it is in the same step catalog, at 689 reports, and one of the two
technicians is the X-Ray Technician. Leaving it out means that person still has no screen.

**Q5 — Does the technician record values, or only that the test happened?**
ABI and VPT already produce structured L/R values through the sync. Should the station also
let a technician type them at the machine (as Lab 2 does), or is recording that the test was
performed enough, with the numbers left to the sync?

**Q6 — Is there a payment gate?**
The lab refuses collection until reception clears payment. Does a machine test have the same
gate, or is it billed with the consultation?

**Q7 — What starts one?**
Ordered by the MO/consultant like a lab test, decided at check-in from the appointment, or
read from the HealthRay "Machine Test" bill line? This is the biggest structural question —
it decides whether the queue is built from `giniflow_lab_orders`, from journey steps, or from
billing.

---

## 6. What I would do first, once those are answered

Not a commitment — the shape depends heavily on Q1, Q3 and Q7.

0. **Stop machine tests landing in the Lab room.** Independent of everything else, and worth
   doing on its own: `ECG` is orderable today and would tell a phlebotomist to draw blood.
1. Add `echo` to `flow_step_catalog`; correct the `station` on all six from "Lab" to whatever
   Q1 settles.
2. `shared/machineStages.js` — the ladder, in the shape `35` proved.
3. Capability + role per Q2, page + queue, reusing the room-gate machinery.
4. The station screen, from the parameterised `LabRoom` shape.
5. Smokes mirroring `smoke-lab-rooms` / `smoke-lab-steps` / `smoke-lab-room-access`.
