# Dr. Gini AI — Agent Tool Test Script

`server/scripts/test-agent-tools.mjs` exercises every tool the Dr. Gini AI agent can call (`/api/ai/agent`) with multiple input shapes, so you can verify each tool returns sane data for a real patient.

Each case prints:
- the tool name
- the exact input you'd send to it
- the time it took
- a PASS/FAIL/SKIP status
- the **full result** (or a preview, depending on flags) so you can eyeball that the data is correct

No LLM is involved — the script imports the tool registry directly. This makes failures easy to attribute (DB vs. tool logic vs. argument shape) and avoids burning Anthropic credits while iterating.

---

## Quick start

```powershell
# Run every case for patient 178506. Writes are skipped by default.
node server/scripts/test-agent-tools.mjs 16911

# Limit to a single tool / case (substring match against case name OR tool name)
node server/scripts/test-agent-tools.mjs 178506 query_patient_data
node server/scripts/test-agent-tools.mjs 178506 propose_log
node server/scripts/test-agent-tools.mjs 178506 appointments
node server/scripts/test-agent-tools.mjs 178506 "VitaminD"

# Show the FULL JSON for every case (no preview truncation)
node server/scripts/test-agent-tools.mjs 178506 --full

# Save every case + result to a JSON file under server/scripts/test-runs/
node server/scripts/test-agent-tools.mjs 178506 --save

# Run the create_health_log cases (these WRITE rows to the patient's DB)
node server/scripts/test-agent-tools.mjs 178506 --write

# Combine flags
node server/scripts/test-agent-tools.mjs 178506 propose_log --full --save
```

### CLI arguments

| Position / flag | Meaning |
|---|---|
| `<scribePatientId>` (required) | Patient ID to run all tools against. Pick a real one with data — vitals, labs, meds, an appointment, a prescription. |
| `[filter]` (optional, positional) | Substring match against the case name or tool name. Only matching cases run. |
| `--write` | Also runs `create_health_log` cases (they INSERT real rows). Off by default. |
| `--full` | Print the full JSON result for each case instead of a truncated preview. |
| `--save` | Write every case + input + full result to `server/scripts/test-runs/agent-tools-<patientId>-<timestamp>.json`. |

---

## What each test case verifies

Every case logs its **input** and **full result** so verification is a visual check: does the data match what the patient actually has in the DB?

### `query_patient_data` (20 cases — one per scope)

| Case | Input scope | What to look for |
|---|---|---|
| profile | `profile` | name, dob, age, sex |
| vitals (30d) | `vitals` + `range_days:30` | merged BP/sugar/weight rows |
| sugar | `sugar` | recent fasting/PP entries |
| bp | `bp` | systolic + diastolic |
| weight | `weight` | recent weights, unit kg |
| labs (all) | `labs` | latest of each test |
| labs (HbA1c) | `labs` + `test_name:'HbA1c'` | only HbA1c rows |
| labs (LDL) | `labs` + `test_name:'LDL'` | only LDL rows |
| meds | `meds` | active + stopped rows; `is_active` set |
| meals | `meals` | description, calories, meal_type |
| symptoms | `symptoms` | recent symptom logs |
| activity | `activity` | merged exercise/sleep/mood/body rows |
| exercise | `exercise` | only exercise rows |
| sleep | `sleep` | only sleep rows |
| mood | `mood` | only mood rows |
| med_adherence (1d) | `med_adherence` + `range_days:1` | today's dose status |
| med_adherence (30d) | `med_adherence` + `range_days:30` | trailing adherence |
| appointments | `appointments` | merged consultations + HealthRay appts |
| diagnoses | `diagnoses` | active + sorted by priority |
| since_last_visit | `since_last_visit:true` | only post-last-visit rows |

### `run_patient_sql` (4 cases)

| Case | What it does |
|---|---|
| simple count | `SELECT COUNT(*) FROM lab_results WHERE patient_id = $1` |
| join (last 5 lab tests) | joined SELECT with `patient_id = $1` |
| should REJECT (no patient_id) | sends a query without `patient_id = $1` — guard should return `{error: …}` |
| should REJECT (DML) | sends a `DELETE` — guard should refuse |

The two "REJECT" cases pass when the guard catches them. If they return rows, your SQL guard is broken.

### `get_full_patient_context` (3 cases)
Default, `vitals_days:7`, `vitals_days:180`. Look for: profile, diagnoses, meds.active/stopped, labs.latest, vitals_recent, appointments.upcoming + recent_past.

### `get_progress_summary` (4 cases)
Windows: 7d, 30d, 90d, `since_last_visit`.

### `get_medication_schedule` (1 case)
Active meds grouped by time slot (fasting / before_breakfast / after_breakfast / before_lunch / …).

### `get_appointments` (3 cases)
`upcoming`, `past`, `next`. Each row should have `appointment_date`, `doctor_name`, `visit_type`, `status`, `source` (`'consultation'` | `'appointment'`), `follow_up` (JSONB).

### `get_prescriptions` (2 cases)
`latest` (single row or null), `all` (up to N). Each row has `id`, `doc_date`, `title`, `file_name`, `file_url`, `storage_path`.

### `propose_log` (UI tool — ~30 cases)
Exercises the full expanded enum. For each case the printed `clientAction` payload IS what the RN app receives:

- **Native types** (BP, Sugar, Weight, HbA1c, LDL, TSH, Haemoglobin, eGFR, Food, Exercise, Sleep, Mood, Symptom) → `clientAction.logType` should match the input `type` verbatim.
- **Extended/flattened types** (UricAcid, VitaminD, VitaminB12, FreeT3, FreeT4, Creatinine, Triglycerides, HDL, TotalCholesterol, FBS, PPBS, Sodium, Potassium, ALT, AST, Ferritin, Platelets, CRP, ESR, …) → `clientAction.logType` should flip to `"Lab"`, with `test_name` + `unit` + `canonical_name` auto-filled from `LAB_TYPE_MAP` in `tools.js`.
- **Universal Lab fallback** (e.g. Homocysteine) → model supplies `test_name`/`unit` directly; they pass through unchanged.
- **Backdated** → `clientAction.date` matches the input ISO date.

These cases use `expect()` predicates, so a regression in `buildClientAction` flips them red automatically.

### `create_health_log` (2 cases — DB WRITES, gated)
Skipped unless `--write` is passed. Inserts a Sugar fasting + Weight row dated today. Useful for end-to-end verification that the propose→confirm flow actually writes.

### `open_document` (1 case)
Builds a prescription `open_document` client_action. Check `type`, `file_url`, `title`, `doc_date`.

### `open_doctor_chat` (1 case)
Builds a doctor-handoff client_action with a seed message.

### `classify_and_extract_attachment` (3 cases)
`food`, `lab_report`, `prescription` kinds. Verifies the bulk-log sheet payload is the right shape.

---

## Reading the output

Each case block looks like this:

```
────────────────────────────────────────────
TOOL    query_patient_data
CASE    query_patient_data · labs (HbA1c)
INPUT   {"scope":"labs","test_name":"HbA1c"}
TOOK    34 ms
STATUS  PASS   shape: array[6]
OUTPUT
[
  {
    "test_name": "HbA1c",
    "result": 7.2,
    "unit": "%",
    "test_date": "2026-04-12",
    …
  },
  …
]
```

Look for:
- **`STATUS PASS`** + a result that matches what the patient actually has in the DB → tool works.
- **`STATUS FAIL (exception)`** → tool threw. The stack trace is printed; usually a schema/column drift.
- **`STATUS FAIL (expect predicate)`** → tool returned, but the shape/values don't match expectations. Common cause: someone edited `buildClientAction`'s flattening logic.
- **`STATUS SKIP`** → write-gated case waiting on `--write`.

The script ends with:

```
─── Summary ───
passed:  41
failed:  0
skipped: 2
```

Exit code is `0` when nothing failed, `1` otherwise — easy to wire into CI.

---

## Saving runs for the record

```powershell
node server/scripts/test-agent-tools.mjs 178506 --save
```

Drops a single JSON under `server/scripts/test-runs/` containing every case + input + full result + timing. Useful when you want to diff two runs (e.g. before/after a schema change) or attach the output to a PR.

The `test-runs/` directory is created on first save. If you don't want it tracked, add `server/scripts/test-runs/` to `.gitignore`.

---

## Common gotchas

- **Patient must exist.** Pass a real `scribePatientId` that has records. An empty patient just yields empty arrays — looks like a pass, doesn't actually verify the tool reads anything.
- **`--write` writes real rows.** Use a test patient or be ready to delete them.
- **`DATABASE_URL` env var is required.** The script imports `server/config/db.js`, which reads it from `.env`.
- **Some scopes silently return `[]`** when the patient has no data of that type (e.g. no symptoms logged). That's correct behaviour — confirm by checking the DB.
- **UI tools never touch the DB.** They just shape the `client_action` payload. If you want to verify the RN app's modal works, run them via `/api/ai/agent` through the actual chat.

---

## End-to-end testing the full agent loop

This script bypasses the LLM. For a true integration test, POST to `/api/ai/agent` and inspect `tool_log[]` + `client_actions[]` in the response:

```powershell
$body = @{
  scribePatientId = 178506
  message = "show me my prescription"
} | ConvertTo-Json

Invoke-RestMethod -Method POST -Uri "http://localhost:3000/api/ai/agent" `
  -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 10
```

Use this when you want to verify:
- the model picks the right tool for the right phrase,
- it chains tools correctly (e.g. `get_prescriptions` → `open_document`),
- the patient-facing text reads well.

Use **this script** when you want to verify the tool itself works against the DB — no model, no charges, instant feedback.
