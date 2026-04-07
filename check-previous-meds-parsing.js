import pg from 'pg';

const dbUrl = 'postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function check() {
  try {
    const res = await pool.query(
      `SELECT id, healthray_id, appointment_date, healthray_diagnoses, healthray_medications
       FROM appointments 
       WHERE patient_id = (SELECT id FROM patients WHERE file_no = 'P_178687')
       ORDER BY appointment_date DESC LIMIT 1`
    );
    
    if (!res.rows[0]) {
      console.log('No appointments found');
      await pool.end();
      return;
    }
    
    const appt = res.rows[0];
    
    console.log('\n========================================');
    console.log('MEDICINE EXTRACTION CHECK');
    console.log('========================================\n');
    
    console.log('Latest HealthRay data stored in appointments table:\n');
    console.log('Medications (Active/Current):');
    if (appt.healthray_medications) {
      appt.healthray_medications.forEach((m, i) => {
        console.log(`  ${i + 1}. ${m.name} - ${m.dose || 'no dose'} ${m.frequency || ''}`);
      });
    }
    
    console.log('\n📌 Issue: "PREVIOUS MEDICATION: NMZ 10 FOR LAST 3 DAYS"');
    console.log('   - This is in the clinical notes text');
    console.log('   - But NOT being parsed as a separate previous_medication entry');
    console.log('   - Should create stopped medicine: NMZ 10mg with reason "dose changed to 20mg"\n');
    
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

check();
