# 38 — Gini Flow as the system of record (HealthRay reduced to the patient list)

Status: **DECISION DOCUMENT. Nothing implemented, nothing switched off.**

## 1. What was asked

> Stop the HealthRay sync. Sync only the patient list, for reception. Every station and every
> step is then recorded by hand — nothing works automatically, and no step is read-only for
> any patient. Where HealthRay and the floor disagree, the floor is the only truth.

This is a bigger change than any station: it makes Gini Flow the **system of record** for the
OPD floor rather than a screen on top of HealthRay. That is a coherent goal, and most of the
machinery for it already exists. But three things arrive through the sync today that nothing
else produces, and they need a decision before anything is switched off.

## 2. What the sync delivers today, measured over 14 days

|                                                     | per day |
| --------------------------------------------------- | ------- |
| Visits                                              | 75.1    |
| `lab_cases` — **every patient on both lab screens** | 31.4    |
| Gini-raised lab orders — what would remain          | **1.3** |
| Documents from HealthRay                            | 70.0    |
| Documents uploaded by hand (companion, lab portal)  | 52.4    |
| **`lab_results` values from the sync**              | **913** |

## 3. The three things that stop, and what each costs

### 3.1 The lab rooms go empty until every test is ordered in Gini first

100% of today's lab patients are `lab_cases`. Gini-raised orders run at **1.3 a day against
31.4**. On the morning the sync stops, both lab rooms show nothing until an MO or consultant
raises each test through Gini Flow — which is a change to how doctors work, not to the lab.

**This is the dependency to sequence around**, and it is the same one the machine station has:
the queue only exists if somebody orders the test here.

### 3.2 913 result values a day stop reaching the chart

This is the sharpest one. Those are the numbers the doctor trends — HbA1c over three visits,
creatinine, ABI left and right. Typed by hand that is **roughly 30 values per patient, 900 a
day**, which no lab will keep up with.

Three ways out, and they are not equal:

- **Type them.** Honest, structured, trendable — and not realistically possible at that volume.
- **Upload the report PDF instead.** One upload per case rather than thirty values. The doctor
  can read it; nothing trends, and the outcomes reports, biomarker charts and the patient app
  lose their input.
- **Keep the results half of the sync** and stop the rest. The floor still owns every STEP;
  HealthRay still delivers the numbers it already produces.

### 3.3 Reports must be uploaded by hand — about 70 a day

The floor already uploads 52 a day through the companion and the lab portal, so this is a real
but familiar load: roughly a 130% increase in uploads, not a new skill.

## 4. What "everything manual" means per station

Most of this already works — the sync is a source, not a driver, in more places than it looks.

| Station                              | Today                                                              | After                                                      |
| ------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Reception                            | Checks in from the synced list                                     | **Unchanged** — the list keeps syncing                     |
| Vitals, MO, Consultant, Rx, Pharmacy | Already fully manual                                               | **Unchanged**                                              |
| Lab 1 / Lab 2                        | Patients from `lab_cases`; stage from HealthRay clocks where ahead | Patients from Gini orders only; stage from floor taps only |
| Machine room                         | Already order-driven and fully manual                              | **Unchanged**                                              |

The lab ladder already degrades correctly: `stageIndex = max(healthrayStage, floorStage)`, so
with no HealthRay timestamps arriving, `healthrayStage` is 0 and the floor drives everything.
**No code is needed to make the floor the only truth** — it is what happens when the clocks
stop. What needs work is where the patients come from.

## 5. Nothing is read-only

Every place a row is currently read-only exists because the floor had no way to record the
thing. Once the floor owns the record, each becomes an action:

- **The machine room's reconciliation column** — becomes "raise this test", or disappears
  entirely once nothing syncs.
- **The lab's hospital-case pane** — the entire `getHealthrayCases` half of the lab station
  loses its source, and the two rooms work Gini orders only.
- **"Left the floor" / "in a room"** groups stay, because they describe the patient, not a
  missing capability.

## 6. Sequencing — the part that matters

Switching the sync off first would empty the lab on a working morning. The order below never
leaves the floor without a queue:

1. **Ordering first.** Every test a doctor raises goes through Gini Flow, including the
   machine tests. Measure it: the day Gini-raised orders match `lab_cases` volume, the lab no
   longer needs the sync.
2. **Then the step clocks.** Stop reading HealthRay's timestamps — one flag, and the ladder
   already behaves.
3. **Then the case sync**, once (1) is proven for a full week.
4. **Reports and results last**, and only after §3.2 is decided.

## 7. Decisions needed

- **D1 — the 913 values (§3.2).** Type them, drop to PDFs only, or keep the results sync?
- **D2 — do doctors order every test in Gini from now on?** Without that, step 1 never
  completes and the lab has no queue.
- **D3 — historical data stays untouched?** Assumed yes: this stops new sync, it does not
  remove the 5,850 cases or 6,100 documents already on charts.

---

## 8. How it ships

`SCRIBE_MANUAL_FLOOR` is **on by default** — `manualFloor()` is true unless the variable is
literally `"0"`. Deploying needs no environment change, and a missing variable on a new host
cannot quietly hand the floor back to HealthRay. The default fails in the safe direction: the
worst it can do is make the floor record its own work.

To restore the old behaviour, set `SCRIBE_MANUAL_FLOOR=0` and restart **both** processes.

Both, not just the worker: the triage board drives the same sync from the API, so restarting
the worker alone leaves the API still syncing. Every guard reads `process.env` at call time,
so a restart is all either process needs — nothing is cached at import.

Pinned in `smoke:manual-floor` — on with no variable at all, on when set to `1`, off only for
`"0"`, and a typo (`"no"`, `"false"`, `"off"`) leaves the floor manual.
