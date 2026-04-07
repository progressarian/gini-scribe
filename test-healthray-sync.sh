#!/bin/bash

# Test HealthRay Sync Fix
# This script verifies that diagnoses and medicines are syncing correctly

set -e

echo "🔍 HealthRay Sync Test Script"
echo "=============================="
echo ""

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
  echo "❌ ERROR: DATABASE_URL not set"
  echo "Set it with: export DATABASE_URL='postgresql://...'"
  exit 1
fi

# Test patient file number
TEST_PATIENT="P_178687"
API_URL="${VITE_API_URL:-http://localhost:3001}"

echo "📋 Configuration:"
echo "  Patient: $TEST_PATIENT"
echo "  API: $API_URL"
echo "  Database: $(echo $DATABASE_URL | sed 's/:[^:]*@/@/g')"
echo ""

# Step 1: Get patient ID
echo "Step 1️⃣  Finding patient ID..."
PATIENT_ID=$(psql $DATABASE_URL -tc "SELECT id FROM patients WHERE file_no='$TEST_PATIENT';" 2>/dev/null || echo "")

if [ -z "$PATIENT_ID" ]; then
  echo "❌ Patient $TEST_PATIENT not found"
  exit 1
fi

PATIENT_ID=$(echo $PATIENT_ID | xargs) # trim whitespace
echo "✅ Found Patient ID: $PATIENT_ID"
echo ""

# Step 2: Count BEFORE sync
echo "Step 2️⃣  Checking data BEFORE sync..."
BEFORE_DX=$(psql $DATABASE_URL -tc "SELECT COUNT(*) FROM diagnoses WHERE patient_id=$PATIENT_ID AND is_active=true;" 2>/dev/null || echo "0")
BEFORE_MEDS=$(psql $DATABASE_URL -tc "SELECT COUNT(*) FROM medications WHERE patient_id=$PATIENT_ID AND is_active=true;" 2>/dev/null || echo "0")
BEFORE_STOPPED=$(psql $DATABASE_URL -tc "SELECT COUNT(*) FROM medications WHERE patient_id=$PATIENT_ID AND is_active=false;" 2>/dev/null || echo "0")

echo "  📊 Active Diagnoses: $BEFORE_DX"
echo "  💊 Active Medicines: $BEFORE_MEDS"
echo "  ⛔ Stopped Medicines: $BEFORE_STOPPED"
echo ""

# Step 3: Check what's in appointments table (raw HealthRay data)
echo "Step 3️⃣  Checking raw HealthRay data in appointments..."
HR_DX_COUNT=$(psql $DATABASE_URL -tc "
SELECT COALESCE(SUM(jsonb_array_length(healthray_diagnoses)), 0)
FROM appointments
WHERE patient_id=$PATIENT_ID AND healthray_diagnoses IS NOT NULL;
" 2>/dev/null || echo "0")

HR_MED_COUNT=$(psql $DATABASE_URL -tc "
SELECT COALESCE(SUM(jsonb_array_length(healthray_medications)), 0)
FROM appointments
WHERE patient_id=$PATIENT_ID AND healthray_medications IS NOT NULL;
" 2>/dev/null || echo "0")

echo "  🔄 HealthRay Diagnoses in DB: $HR_DX_COUNT"
echo "  🔄 HealthRay Medicines in DB: $HR_MED_COUNT"
echo ""

# Step 4: Trigger sync
echo "Step 4️⃣  Triggering HealthRay sync..."
SYNC_DATE=$(date +%Y-%m-%d)
echo "  Syncing for date: $SYNC_DATE"

SYNC_RESPONSE=$(curl -s -X POST "$API_URL/api/sync/healthray/date?date=$SYNC_DATE" \
  -H "Content-Type: application/json" 2>/dev/null || echo '{"error":"Connection failed"}')

echo "  Response: $SYNC_RESPONSE"
echo ""

# Step 5: Wait for sync to complete
echo "Step 5️⃣  Waiting for sync to complete..."
sleep 3
echo "  ✅ Done waiting"
echo ""

# Step 6: Count AFTER sync
echo "Step 6️⃣  Checking data AFTER sync..."
AFTER_DX=$(psql $DATABASE_URL -tc "SELECT COUNT(*) FROM diagnoses WHERE patient_id=$PATIENT_ID AND is_active=true;" 2>/dev/null || echo "0")
AFTER_MEDS=$(psql $DATABASE_URL -tc "SELECT COUNT(*) FROM medications WHERE patient_id=$PATIENT_ID AND is_active=true;" 2>/dev/null || echo "0")
AFTER_STOPPED=$(psql $DATABASE_URL -tc "SELECT COUNT(*) FROM medications WHERE patient_id=$PATIENT_ID AND is_active=false;" 2>/dev/null || echo "0")

echo "  📊 Active Diagnoses: $AFTER_DX"
echo "  💊 Active Medicines: $AFTER_MEDS"
echo "  ⛔ Stopped Medicines: $AFTER_STOPPED"
echo ""

# Step 7: Show sample data
echo "Step 7️⃣  Sample diagnoses synced:"
psql $DATABASE_URL -tc "
SELECT '  ✓ ' || d.label || ' (' || d.status || ')'
FROM diagnoses d
WHERE d.patient_id=$PATIENT_ID AND d.is_active=true
LIMIT 5;
" 2>/dev/null || echo "  (none found)"
echo ""

echo "Step 8️⃣  Sample medicines synced:"
psql $DATABASE_URL -tc "
SELECT '  ✓ ' || m.name || ' ' || COALESCE(m.dose, '') || ' - ' || COALESCE(m.frequency, '')
FROM medications m
WHERE m.patient_id=$PATIENT_ID AND m.is_active=true AND m.source='healthray'
LIMIT 5;
" 2>/dev/null || echo "  (none found)"
echo ""

# Step 9: Test API endpoint
echo "Step 9️⃣  Testing API /visit/:patientId endpoint..."
API_DX_COUNT=$(curl -s "$API_URL/api/visit/$PATIENT_ID" 2>/dev/null | jq '.diagnoses | length' || echo "error")
API_MED_COUNT=$(curl -s "$API_URL/api/visit/$PATIENT_ID" 2>/dev/null | jq '.activeMeds | length' || echo "error")

echo "  📊 API diagnoses count: $API_DX_COUNT"
echo "  💊 API medicines count: $API_MED_COUNT"
echo ""

# Step 10: Summary
echo "Summary:"
echo "========"
echo ""
echo "  Diagnoses:"
echo "    Before: $BEFORE_DX → After: $AFTER_DX (HealthRay had: $HR_DX_COUNT)"
if [ "$AFTER_DX" -gt "$BEFORE_DX" ]; then
  echo "    ✅ DIAGNOSES SYNCED! (+$(($AFTER_DX - $BEFORE_DX)))"
else
  echo "    ⚠️  No diagnoses synced"
fi
echo ""
echo "  Medicines:"
echo "    Before: $BEFORE_MEDS → After: $AFTER_MEDS (HealthRay had: $HR_MED_COUNT)"
if [ "$AFTER_MEDS" -gt "$BEFORE_MEDS" ]; then
  echo "    ✅ MEDICINES SYNCED! (+$(($AFTER_MEDS - $BEFORE_MEDS)))"
else
  echo "    ⚠️  No medicines synced"
fi
echo ""

# Final verdict
if [ "$AFTER_DX" -gt "$BEFORE_DX" ] || [ "$AFTER_MEDS" -gt "$BEFORE_MEDS" ]; then
  echo "🎉 SUCCESS! Data is syncing correctly!"
  echo ""
  echo "Next steps:"
  echo "  1. Login to the app"
  echo "  2. Find patient $TEST_PATIENT"
  echo "  3. Open a visit"
  echo "  4. Check that diagnoses and medicines appear"
  echo "  5. Test Smart Drug Warnings in Add Medicine modal"
  exit 0
else
  echo "❌ ISSUE: No data was synced"
  echo ""
  echo "Troubleshooting:"
  echo "  1. Check server console for errors"
  echo "  2. Verify patient has HealthRay appointments"
  echo "  3. Check that sync was triggered: curl -X POST $API_URL/api/sync/healthray/today"
  exit 1
fi
