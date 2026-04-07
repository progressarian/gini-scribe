import pg from 'pg';

const dbUrl = 'postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function checkMedicines() {
  try {
    // Get patient info
    const patRes = await pool.query(
      `SELECT id, name, file_no FROM patients WHERE file_no = 'P_178687'`
    );
    
    if (!patRes.rows[0]) {
      console.log('Patient not found');
      await pool.end();
      return;
    }
    
    const patient = patRes.rows[0];
    
    // Get latest appointment with raw HealthRay medicines
    const apptRes = await pool.query(
      `SELECT id, healthray_id, appointment_date, healthray_medications FROM appointments 
       WHERE patient_id = $1 
       ORDER BY appointment_date DESC LIMIT 1`,
      [patient.id]
    );
    
    if (!apptRes.rows[0]) {
      console.log('No appointments found');
      await pool.end();
      return;
    }
    
    const appt = apptRes.rows[0];
    
    console.log('\n========================================');
    console.log('MEDICINE VERIFICATION - P_178687');
    console.log('========================================\n');
    
    console.log('📅 Latest Appointment:');
    console.log(`   Date: ${appt.appointment_date}`);
    console.log(`   HealthRay ID: ${appt.healthray_id}`);
    
    console.log('\n📝 RAW HealthRay Medicines (from appointments.healthray_medications):');
    const rawMeds = appt.healthray_medications || [];
    console.log(`   Total: ${rawMeds.length} medicines\n`);
    
    rawMeds.forEach((med, i) => {
      console.log(`   ${i + 1}. ${med.name}`);
      console.log(`      Dose: ${med.dose || 'N/A'}`);
      console.log(`      Frequency: ${med.frequency || 'N/A'}`);
      console.log(`      Timing: ${med.timing || 'N/A'}`);
      console.log(`      Route: ${med.route || 'Oral'}`);
      console.log(`      New: ${med.is_new ? 'Yes' : 'No'}`);
      console.log();
    });
    
    // Get synced medications from database
    const medRes = await pool.query(
      `SELECT id, name, dose, frequency, is_active, notes, created_at 
       FROM medications 
       WHERE patient_id = $1 AND notes LIKE '%${appt.healthray_id}%'
       ORDER BY created_at DESC`,
      [patient.id]
    );
    
    console.log('💊 SYNCED Medicines (medications table from this appointment):');
    console.log(`   Total: ${medRes.rows.length} medicines synced\n`);
    
    medRes.rows.forEach((med, i) => {
      console.log(`   ${i + 1}. ${med.name}`);
      console.log(`      Dose: ${med.dose || 'N/A'}`);
      console.log(`      Frequency: ${med.frequency || 'N/A'}`);
      console.log(`      Active: ${med.is_active ? '✅' : '❌'}`);
      console.log(`      Notes: ${med.notes || 'N/A'}`);
      console.log();
    });
    
    // Compare
    console.log('🔍 COMPARISON:');
    console.log(`   HealthRay has: ${rawMeds.length} medicines`);
    console.log(`   Database has: ${medRes.rows.length} synced from this appointment`);
    
    if (rawMeds.length === medRes.rows.length) {
      console.log(`   ✅ All medicines synced correctly!\n`);
    } else {
      console.log(`   ⚠️  Mismatch! Missing: ${rawMeds.length - medRes.rows.length}\n`);
      
      // Find missing
      const syncedNames = new Set(medRes.rows.map(m => m.name.toUpperCase()));
      const missing = rawMeds.filter(m => !syncedNames.has(m.name.toUpperCase()));
      
      if (missing.length > 0) {
        console.log('   Missing medicines:');
        missing.forEach(m => console.log(`   - ${m.name}`));
      }
    }
    
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

checkMedicines();
