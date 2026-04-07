import pg from "pg";

const dbUrl =
  "postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres";
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function checkStoppedMedicines() {
  try {
    // Get patient info
    const patRes = await pool.query(`SELECT id FROM patients WHERE file_no = 'P_178687'`);

    if (!patRes.rows[0]) {
      console.log("Patient not found");
      await pool.end();
      return;
    }

    const patientId = patRes.rows[0].id;

    // Get latest appointment
    const apptRes = await pool.query(
      `SELECT id, healthray_id, appointment_date, healthray_medications
       FROM appointments 
       WHERE patient_id = $1 
       ORDER BY appointment_date DESC LIMIT 1`,
      [patientId],
    );

    const latestAppt = apptRes.rows[0];

    console.log("\n========================================");
    console.log("PREVIOUS/STOPPED MEDICINES - P_178687");
    console.log("========================================\n");

    // Get ALL medications (active + inactive) for patient
    const allMeds = await pool.query(
      `SELECT id, name, dose, frequency, is_active, stopped_date, stop_reason, notes, created_at
       FROM medications 
       WHERE patient_id = $1
       ORDER BY is_active DESC, created_at DESC`,
      [patientId],
    );

    console.log(`Total medicines in database: ${allMeds.rows.length}\n`);

    const activeMeds = allMeds.rows.filter((m) => m.is_active);
    const inactiveMeds = allMeds.rows.filter((m) => !m.is_active);

    console.log(`✅ ACTIVE (${activeMeds.length}):`);
    activeMeds.forEach((med, i) => {
      console.log(`   ${i + 1}. ${med.name} - ${med.dose || "N/A"} ${med.frequency || ""}`);
      console.log(`      From: ${med.notes || "Manual entry"}`);
    });

    console.log(`\n❌ INACTIVE/STOPPED (${inactiveMeds.length}):`);
    inactiveMeds.forEach((med, i) => {
      console.log(`   ${i + 1}. ${med.name}`);
      console.log(`      Dose: ${med.dose || "N/A"} ${med.frequency || "N/A"}`);
      console.log(`      Stopped: ${med.stopped_date || "N/A"}`);
      console.log(`      Reason: ${med.stop_reason || "N/A"}`);
      console.log(`      From: ${med.notes || "Manual entry"}`);
      console.log();
    });

    // Check current appointment for previous medicines
    console.log(`\n📋 Clinical Notes from Latest Appointment:`);
    console.log(`   "PREVIOUS MEDICATION: NMZ 10 FOR LAST 3 DAYS"`);
    console.log(`   This should be marked as stopped/changed\n`);

    // Check if NMZ with dose 10 exists as stopped
    const nmsz10 = inactiveMeds.find(
      (m) => m.name.toUpperCase().includes("NMZ") && m.dose === "10",
    );

    if (nmsz10) {
      console.log(`✅ NMZ 10 mg found in stopped medicines:`);
      console.log(`   Stopped date: ${nmsz10.stopped_date || "Not recorded"}`);
      console.log(`   Stop reason: ${nmsz10.stop_reason || "Dose changed to 20mg"}`);
    } else {
      console.log(`⚠️  NMZ 10 mg NOT found in stopped medicines`);
      console.log(`   The previous medicine should be tracked when dose changes`);
    }

    await pool.end();
  } catch (err) {
    console.error("Error:", err.message);
  }
}

checkStoppedMedicines();
