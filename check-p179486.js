import pg from 'pg';

const dbUrl = 'postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function check() {
  try {
    // Find patient
    const patRes = await pool.query(
      `SELECT id, name, file_no, phone FROM patients WHERE file_no = 'P_179486'`
    );
    
    if (!patRes.rows[0]) {
      console.log('❌ Patient P_179486 not found in DB');
      await pool.end();
      return;
    }
    
    const patient = patRes.rows[0];
    console.log('✅ Patient Found:', patient.name, '| ID:', patient.id);
    
    // Get all appointments with HealthRay data
    const apptRes = await pool.query(
      `SELECT id, healthray_id, appointment_date, status,
              healthray_clinical_notes,
              healthray_diagnoses,
              healthray_medications
       FROM appointments 
       WHERE patient_id = $1
       ORDER BY appointment_date DESC`,
      [patient.id]
    );
    
    console.log(`\n📅 Appointments: ${apptRes.rows.length} total\n`);
    
    apptRes.rows.forEach((appt, i) => {
      const dxCount = appt.healthray_diagnoses?.length || 0;
      const medCount = appt.healthray_medications?.length || 0;
      const hasNotes = appt.healthray_clinical_notes ? `${appt.healthray_clinical_notes.length} chars` : 'NULL';
      console.log(`${i+1}. [${appt.appointment_date}] HealthRay ID: ${appt.healthray_id || 'NULL'}`);
      console.log(`   Status: ${appt.status} | Notes: ${hasNotes}`);
      console.log(`   healthray_diagnoses: ${dxCount} | healthray_medications: ${medCount}`);
      
      if (dxCount > 0) {
        console.log(`   Diagnoses:`, JSON.stringify(appt.healthray_diagnoses));
      }
      console.log();
    });
    
    // Check diagnoses table
    const dxRes = await pool.query(
      `SELECT * FROM diagnoses WHERE patient_id = $1`,
      [patient.id]
    );
    console.log(`🏥 diagnoses table: ${dxRes.rows.length} records`);
    if (dxRes.rows.length > 0) {
      dxRes.rows.forEach(d => console.log(`   - ${d.label} (${d.status}) notes: ${d.notes}`));
    }
    
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

check();
