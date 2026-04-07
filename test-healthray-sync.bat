@echo off
REM Test HealthRay Sync Fix for Windows

echo.
echo 🔍 HealthRay Sync Test Script (Windows)
echo ======================================
echo.

REM Configuration
set TEST_PATIENT=P_178687
set API_URL=http://localhost:3001
set DATABASE_URL=

if "%DATABASE_URL%"=="" (
    echo ❌ ERROR: DATABASE_URL environment variable not set
    echo.
    echo Please set it first:
    echo   set DATABASE_URL=postgresql://username:password@host:port/database
    exit /b 1
)

echo 📋 Configuration:
echo   Patient: %TEST_PATIENT%
echo   API: %API_URL%
echo.

REM Step 1: Get patient ID
echo Step 1️⃣  Finding patient ID...
for /f "tokens=*" %%i in ('psql %DATABASE_URL% -tc "SELECT id FROM patients WHERE file_no='%TEST_PATIENT%';" 2^>nul') do set PATIENT_ID=%%i

if "%PATIENT_ID%"=="" (
    echo ❌ Patient %TEST_PATIENT% not found
    exit /b 1
)

echo ✅ Found Patient ID: %PATIENT_ID%
echo.

REM Step 2: Count BEFORE sync
echo Step 2️⃣  Checking data BEFORE sync...
for /f "tokens=*" %%i in ('psql %DATABASE_URL% -tc "SELECT COUNT(*) FROM diagnoses WHERE patient_id=%PATIENT_ID% AND is_active=true;" 2^>nul') do set BEFORE_DX=%%i
for /f "tokens=*" %%i in ('psql %DATABASE_URL% -tc "SELECT COUNT(*) FROM medications WHERE patient_id=%PATIENT_ID% AND is_active=true;" 2^>nul') do set BEFORE_MEDS=%%i
for /f "tokens=*" %%i in ('psql %DATABASE_URL% -tc "SELECT COUNT(*) FROM medications WHERE patient_id=%PATIENT_ID% AND is_active=false;" 2^>nul') do set BEFORE_STOPPED=%%i

echo   📊 Active Diagnoses: %BEFORE_DX%
echo   💊 Active Medicines: %BEFORE_MEDS%
echo   ⛔ Stopped Medicines: %BEFORE_STOPPED%
echo.

REM Step 3: Trigger sync
echo Step 3️⃣  Triggering HealthRay sync...
for /f "tokens=1-4 delims=/ " %%a in ('date /t') do (set mydate=%%d-%%b-%%a)
echo   Syncing for date: %mydate%
echo.

echo   Calling API...
curl -s -X POST "%API_URL%/api/sync/healthray/date?date=%mydate%" -H "Content-Type: application/json"
echo.
echo.

REM Step 4: Wait
echo Step 4️⃣  Waiting for sync to complete...
timeout /t 3 /nobreak
echo   ✅ Done waiting
echo.

REM Step 5: Count AFTER sync
echo Step 5️⃣  Checking data AFTER sync...
for /f "tokens=*" %%i in ('psql %DATABASE_URL% -tc "SELECT COUNT(*) FROM diagnoses WHERE patient_id=%PATIENT_ID% AND is_active=true;" 2^>nul') do set AFTER_DX=%%i
for /f "tokens=*" %%i in ('psql %DATABASE_URL% -tc "SELECT COUNT(*) FROM medications WHERE patient_id=%PATIENT_ID% AND is_active=true;" 2^>nul') do set AFTER_MEDS=%%i

echo   📊 Active Diagnoses: %AFTER_DX%
echo   💊 Active Medicines: %AFTER_MEDS%
echo.

REM Step 6: Summary
echo ======== SUMMARY ========
echo.
echo Diagnoses: %BEFORE_DX% -^> %AFTER_DX%
echo Medicines: %BEFORE_MEDS% -^> %AFTER_MEDS%
echo.

if %AFTER_DX% gtr %BEFORE_DX% (
    echo ✅ DIAGNOSES SYNCED!
) else (
    echo ⚠️  No diagnoses synced
)

if %AFTER_MEDS% gtr %BEFORE_MEDS% (
    echo ✅ MEDICINES SYNCED!
) else (
    echo ⚠️  No medicines synced
)

echo.
if %AFTER_DX% gtr %BEFORE_DX% (
    echo 🎉 SUCCESS! Data is syncing correctly!
    exit /b 0
) else if %AFTER_MEDS% gtr %BEFORE_MEDS% (
    echo 🎉 SUCCESS! Medicines syncing works!
    exit /b 0
) else (
    echo ❌ ISSUE: No data was synced
    echo.
    echo Check server console for errors
    exit /b 1
)
