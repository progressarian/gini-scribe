# Testing HealthRay Sync Fix

This guide walks you through testing that diagnoses and medicines are now syncing correctly from HealthRay.

## Fix Summary

**Problem:** Patient data (diagnoses, medicines) extracted from HealthRay was not being saved to the database tables.

**Solution:** 
- Added `syncDiagnoses()` function to save diagnoses to `diagnoses` table
- Added `syncStoppedMedications()` function to mark stopped medicines as inactive
- Fixed `syncMedications()` to handle duplicate records (active and inactive)

---

## Quick Test (Windows)

### Option 1: Automated Script

```bash
cd "C:\Users\hp\OneDrive\Documents\My Projects\Gini\gini-scribe"

# Run the test script
.\test-healthray-sync.bat
```

The script will:
1. ✅ Count diagnoses BEFORE
2. ✅ Count medicines BEFORE
3. ✅ Trigger HealthRay sync
4. ✅ Count diagnoses AFTER
5. ✅ Count medicines AFTER
6. ✅ Show success/failure

Expected output:
```
Diagnoses: 2 -> 8
Medicines: 5 -> 12

✅ DIAGNOSES SYNCED!
✅ MEDICINES SYNCED!

🎉 SUCCESS! Data is syncing correctly!
```

### Option 2: Manual Commands

Open PowerShell and run these:

```powershell
# Set database connection
$env:DATABASE_URL = "postgresql://username:password@host:port/database"

# Get patient ID for P_178687
$patientId = psql $env:DATABASE_URL -tc "SELECT id FROM patients WHERE file_no='P_178687';"

# Check data BEFORE sync
psql $env:DATABASE_URL -c "
SELECT COUNT(*) as diagnoses
FROM diagnoses 
WHERE patient_id=$patientId AND is_active=true;
"

psql $env:DATABASE_URL -c "
SELECT COUNT(*) as medicines
FROM medications 
WHERE patient_id=$patientId AND is_active=true;
"

# Trigger sync
curl -X POST http://localhost:3001/api/sync/healthray/date?date=2026-04-03

# Wait 5 seconds
Start-Sleep -Seconds 5

# Check data AFTER sync
psql $env:DATABASE_URL -c "
SELECT COUNT(*) as diagnoses_after
FROM diagnoses 
WHERE patient_id=$patientId AND is_active=true;
"

psql $env:DATABASE_URL -c "
SELECT COUNT(*) as medicines_after
FROM medications 
WHERE patient_id=$patientId AND is_active=true;
"
```

---

## Detailed Manual Testing

### Step 1: Setup Database Connection

```bash
# Set environment variable (PowerShell)
$env:DATABASE_URL = "postgresql://user:pass@localhost:5432/gini-scribe"

# Or (CMD)
set DATABASE_URL=postgresql://user:pass@localhost:5432/gini-scribe
```

### Step 2: Check Patient Before Sync

```sql
-- Query 1: Get patient ID
SELECT id, file_no, name 
FROM patients 
WHERE file_no = 'P_178687';

-- Query 2: Check diagnoses (should be empty or few)
SELECT d.label, d.status, d.notes
FROM diagnoses d
JOIN patients p ON d.patient_id = p.id
WHERE p.file_no = 'P_178687'
AND d.is_active = true;

-- Query 3: Check medicines (should be empty or few)
SELECT m.name, m.dose, m.frequency, m.is_active, m.source
FROM medications m
JOIN patients p ON m.patient_id = p.id
WHERE p.file_no = 'P_178687'
AND m.is_active = true;

-- Query 4: Check what HealthRay data exists (raw)
SELECT 
  a.appointment_date,
  jsonb_array_length(a.healthray_diagnoses) as dx_count,
  jsonb_array_length(a.healthray_medications) as med_count,
  LENGTH(a.healthray_clinical_notes) as notes_len
FROM appointments a
JOIN patients p ON a.patient_id = p.id
WHERE p.file_no = 'P_178687'
ORDER BY a.appointment_date DESC
LIMIT 5;
```

### Step 3: Trigger Sync

**Via curl:**
```bash
# Sync today's appointments
curl -X POST http://localhost:3001/api/sync/healthray/today

# Or sync a specific date
curl -X POST http://localhost:3001/api/sync/healthray/date?date=2026-04-03

# Or full sync (slower)
curl -X POST http://localhost:3001/api/sync/healthray/full
```

**Check server console for logs:**
```
[HealthRay Sync] Starting for 2026-04-03...
[HealthRay Sync] Dr. Name: 5 appointments
[HealthRay Sync] Enrich <id>: 8 dx, 12 meds, 3 labs
[HealthRay Sync] Done 2026-04-03 in 15.2s — created: 2, enriched: 1, skipped: 2, errors: 0
```

If you see `8 dx, 12 meds` → data was extracted! ✅

### Step 4: Check Patient After Sync

Run the same SQL queries from Step 2.

**Expected changes:**
```
Query 2 (Diagnoses):
  Before: 0-2 rows
  After:  5-10 rows ✅

Query 3 (Medicines):
  Before: 2-5 rows
  After:  8-15 rows ✅
  
Query 3b (Check source):
  Should see: source = 'healthray' ✅
  Should see: notes contains 'healthray:' ✅
```

### Step 5: View in Frontend

1. **Login to app** → navigate to patient P_178687
2. **Open a visit** → click on any recent appointment
3. **Check diagnoses section** → should show:
   - List of diagnoses with status badges
   - At least 5+ diagnoses from HealthRay
4. **Check medicines section** → should show:
   - List of active medicines
   - Only medicines with `is_active=true`
   - Stopped medicines should be GONE
5. **Open "Add Medicine" modal** → type "Metformin"
   - Should see Smart Warning banner
   - Warning uses diagnoses data (so if diagnoses are missing, warning won't show!)

---

## Troubleshooting

### Issue: No diagnoses appear after sync

**Check 1:** Was data extracted from HealthRay?
```sql
SELECT jsonb_array_length(healthray_diagnoses)
FROM appointments
WHERE patient_id = <id>
LIMIT 1;
```
- If result is `0` → HealthRay didn't have diagnoses for this patient
- If result is `>0` → Data was extracted, but not synced to diagnoses table

**Check 2:** Did the sync function run?
```bash
# Look in server console for errors like:
# [HealthRay Sync] ERROR: function syncDiagnoses not found
# [HealthRay Sync] ERROR: Duplicate key value...
```

**Check 3:** Is the diagnoses table getting records?
```sql
SELECT COUNT(*) FROM diagnoses 
WHERE created_at > NOW() - INTERVAL '10 minutes';
```
- If `0` → sync is not writing to diagnoses table
- If `>0` → working!

### Issue: "duplicate key value violates unique constraint" error

This was **just fixed** in this update. The error happens when:
- HealthRay tries to insert a medicine that already exists as inactive
- Old code used `DO NOTHING`, so it failed silently

**Solution:** Already applied - `syncMedications()` now uses `DO UPDATE` to handle all cases.

If you still see this error:
```bash
# Make sure you have the latest code
git pull origin main

# Rebuild
npm run build

# Restart server
npm run serve
```

### Issue: Medicines show as "stopped" when they should be active

**Check:** Are `previous_medications` being parsed?
```sql
SELECT healthray_medications, healthray_stopped_medications
FROM appointments
WHERE patient_id = <id>
LIMIT 1 \G
```

If `stopped_medications` field is null, the parser didn't find stopped medicines in the clinical notes.

---

## Verification Checklist

After syncing patient P_178687, verify:

- [ ] **Diagnoses table has data**
  ```sql
  SELECT COUNT(*) FROM diagnoses WHERE patient_id=... AND is_active=true;
  -- Should be > 0
  ```

- [ ] **Medicines synced from HealthRay**
  ```sql
  SELECT COUNT(*) FROM medications 
  WHERE patient_id=... AND source='healthray' AND is_active=true;
  -- Should be > 0
  ```

- [ ] **Stopped medicines marked inactive**
  ```sql
  SELECT COUNT(*) FROM medications 
  WHERE patient_id=... AND is_active=false AND notes LIKE '%healthray%';
  -- Should be > 0 (if patient had stopped meds)
  ```

- [ ] **Visit API returns diagnoses**
  ```bash
  curl http://localhost:3001/api/visit/<patientId> | jq '.diagnoses | length'
  -- Should be > 0
  ```

- [ ] **Smart warnings work**
  - Open Add Medicine modal
  - Type "Metformin"
  - Should see warning (only if diagnoses are loaded!)

---

## Quick Reference

**Sync Endpoints:**
```
POST /api/sync/healthray/today          — Sync today only
POST /api/sync/healthray/date?date=...  — Sync specific date
POST /api/sync/healthray/full           — Sync all dates
POST /api/sync/healthray/range?from=...&to=...  — Date range
```

**Key Database Changes:**
```
diagnoses table        ← Now receives HealthRay data
medications table      ← Fixed duplicate handling
appointments table     ← healthray_diagnoses, healthray_medications (already existed)
```

**Files Changed:**
```
server/services/healthray/db.js         → Added syncDiagnoses(), syncStoppedMedications()
server/services/cron/healthraySync.js   → Calls new sync functions
src/utils/drugWarnings.js               → Smart warnings (uses diagnoses data)
src/components/visit/modals/AddMedicationModal.jsx  → Displays warnings
```

---

## Next Steps

✅ **After testing passes:**
1. Commit changes to git
2. Deploy to production
3. Re-sync all patients from HealthRay
4. Verify data in production

🎯 **Smart Warnings** will now work correctly because:
- Diagnoses are properly synced
- Medicines are correctly marked active/inactive
- Warning engine has complete patient data to check
