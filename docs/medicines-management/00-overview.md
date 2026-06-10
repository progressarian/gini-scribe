# Medicine Collection Tracking — Overview

> **Status:** PLAN ONLY — nothing implemented yet.
> **Created:** 2026-06-10 · revised after scope clarification.
>
> **What this is (in the team's words):** a doctor prescribes medicines to a
> patient. The patient goes to the **pharmacy counter**. The pharmacist marks,
> **per medicine**, whether the patient **got it, didn't get it, or got part of
> it** (with a reason). Doctors and management can then **see which patients
> collected which medicines**, and the **history** is preserved.
>
> This is **fulfillment / collection tracking**, NOT stock/inventory or a brand
> catalog (those were an earlier mis-scope — see §6).

| # | Doc | Covers |
|---|-----|--------|
| 00 | overview (this) | the flow, current state, model summary, decisions |
| 01 | [data-model](01-data-model.md) | `medicine_collections` table + how it maps to prescriptions |
| 02 | [pharmacy-worklist](02-pharmacy-worklist.md) | pharmacy-side UI + API to mark each medicine |
| 03 | [doctor-report-history](03-doctor-report-history.md) | doctor/management visibility + history |
| 04 | [rollout](04-rollout.md) | phases, RBAC, migrations, testing |

---

## 1. The end-to-end flow (corrected)

```
  1. Doctor consults → prescribes medicines
        → medications rows (is_active, visit_status='current', appointment_id)   [EXISTS]
  2. Patient walks to the PHARMACY counter with the prescription
  3. Pharmacist opens "Medicine Collection" → finds the patient (today's list / search)
  4. Sees the patient's current prescribed medicines (one row per medicine)
  5. For EACH medicine marks:  ✅ Given  |  ❌ Not given  |  🟡 Partial   (+ reason)
  6. Saves → one collection record per medicine for this pickup       [NEW: medicine_collections]
  7. Patient's status rolls up:  All collected / Partial / Not collected
  8. DOCTOR / MANAGEMENT report → which patients got which meds, by date, with history
```

This slots into the existing **Rx station** of the patient journey —
`station_tracking` already has `rx_checkin / rx_checkout / rx_explained_by`, so
the pharmacy step is already a recognised stop; we add *what was actually
collected* to it.

---

### Verified against production data (2026-06-10)
Three plan assumptions were checked against the live DB and **two were wrong** —
corrected throughout:
- ✅ `medications` has `visit_status` ('current'/'previous'), `is_active`,
  `last_prescribed_date`, `consultation_id`, `med_group`, `sort_order`.
- ✅ **"Prescribed today" is reliable via `last_prescribed_date`** — 62–77
  patients/day. → this is the **worklist source** (Doc 02), not appointment status.
- ⚠️ **`medications.appointment_id` is almost never set** (24 of ~79,600 rows).
  → the collection must **not** depend on it (Doc 01/03 corrected).
- ⚠️ **`CAPABILITIES.PHARMACY` does NOT exist** — only `ROLES.PHARMACY` does.
  A new capability must be **added** (Doc 04), not "reserved".

## 2. Current state (what exists, what's missing)

| Concern | Today | Where |
|---------|-------|-------|
| Prescribed medicines | `medications` table — per patient, `is_active`, `visit_status` ('current'/'previous'), `last_prescribed_date`, `appointment_id`, dose/frequency/timing… | `server/schema.sql` + migrations |
| "Current prescription" | `medications WHERE is_active AND visit_status='current'` for a patient | — |
| Rx/pharmacy step | A journey station with `rx_checkin/rx_checkout/rx_explained_by` | `station_tracking` |
| **Per-medicine collection status** | **Does not exist** | — |
| **Pharmacy worklist to mark collection** | **Does not exist** | — |
| **Doctor/management collection report** | **Does not exist** | — |

So the *prescription* exists; what's missing is **recording whether the patient
actually collected each medicine**, a **pharmacy screen to mark it**, and a
**report** to see it.

---

## 3. Key modelling insight (why a separate table)

`medications` rows **persist and continue across visits** (the same row is
re-prescribed; `last_prescribed_date` + `visit_status` are recomputed). A single
"collected?" flag on the row would be **overwritten every visit** and lose
history.

→ Collection must be its own **event log**: one record per *(medicine, pickup)*.
That preserves history ("collected on 10 Jun, not collected on 24 Jun") and rolls
up cleanly per patient/visit. See Doc 01.

---

## 4. Statuses

**Per medicine, per pickup** (stored):
| Status | Meaning |
|--------|---------|
| `given` | Patient collected this medicine |
| `not_given` | Not collected (reason required) |
| `partial` | Collected part (e.g. 15 of 30 tablets) (+ note) |
| *(no record)* | **pending** — pharmacist hasn't marked it yet |

**Reason** (for not_given / partial): `out_of_stock`, `patient_declined`,
`buying_outside`, `not_available`, `other` (+ free text).

**Per patient/visit, rolled up** (computed):
`all` (every med given) · `partial` (some) · `none` (all not_given) ·
`pending` (nothing marked yet).

---

## 5. Open decisions (recommendation in **bold**)

1. **Which medicines appear for collection?** The patient's `is_active` +
   `visit_status='current'` meds, or *all* active meds? → **Recommend
   `visit_status='current'`** (the latest prescription = what they came to
   collect); allow a toggle to show all active.
2. **Worklist source — today's OPD patients, or search-any?** → **Both**: the
   "today's patients" list is driven by **`last_prescribed_date = date`**
   (patients prescribed/updated meds that day — verified reliable), enriched with
   the day's appointment for doctor context; plus free patient search.
3. **Re-collection / refills** — a med collected again at a later visit is a
   **new** collection record (keyed by date). → **Yes**, that's the history.
4. **Reason mandatory** when not fully given? → **Yes** (`not_given`/`partial`
   require a reason) — that's the clinically useful signal for doctors.
5. **Who can mark?** `PHARMACY` role. **Who can view the report?** doctors +
   management (+ pharmacy). → confirm.

---

## 6. Explicitly OUT of scope (deferred)

Per the clarified ask, these are **not** part of this feature (can be future work):
- Stock / inventory levels, batches, expiry, reorder.
- Pharmacy brand-catalog management (the static `medicine_db.json`).
- Adherence analytics beyond "collected vs prescribed".

This keeps the build small and focused: **mark collection → report it → keep history.**
