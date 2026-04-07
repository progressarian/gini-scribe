import pg from 'pg';

const dbUrl = 'postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function checkPatient() {
  try {
    // Find patient P_178687
    const patientRes = await pool.query(
      `SELECT id, name, phone, file_no FROM patients WHERE file_no = $1 OR phone LIKE $2`,
      ['P_178687', '%178687%']
    );
    
    if (!patientRes.rows.length) {
      console.log('❌ Patient P_178687 not found');
      await pool.end();
      return;
    }
    
    const patient = patientRes.rows[0];
    console.log('\n✅ Patient Found:');
    console.log(`   ID: ${patient.id}`);
    console.log(`   Name: ${patient.name}`);
    console.log(`   File No: ${patient.file_no}`);
    console.log(`   Phone: ${patient.phone}`);
    
    // Get latest appointment with HealthRay data
    const apptRes = await pool.query(
      `SELECT id, healthray_id, appointment_date, healthray_diagnoses, healthray_medications, healthray_labs
       FROM appointments 
       WHERE patient_id = $1
       ORDER BY appointment_date DESC
       LIMIT 1`,
      [patient.id]
    );
    
    if (!apptRes.rows.length) {
      console.log('\n❌ No appointments found for this patient');
      await pool.end();
      return;
    }
    
    const appt = apptRes.rows[0];
    console.log('\n📅 Latest Appointment:');
    console.log(`   Appointment ID: ${appt.id}`);
    console.log(`   HealthRay ID: ${appt.healthray_id}`);
    console.log(`   Date: ${appt.appointment_date}`);
    
    console.log('\n📊 HealthRay Data from appointments table:');
    console.log(`   Diagnoses (count): ${appt.healthray_diagnoses?.length || 0}`);
    if (appt.healthray_diagnoses?.length > 0) {
      console.log('   ', JSON.stringify(appt.healthray_diagnoses, null, 2));
    } else {
      console.log('   ⚠️  No diagnoses data from HealthRay');
    }
    
    console.log(`\n   Medications (count): ${appt.healthray_medications?.length || 0}`);
    if (appt.healthray_medications?.length > 0) {
      console.log('   ', JSON.stringify(appt.healthray_medications, null, 2));
    } else {
      console.log('   ⚠️  No medications data from HealthRay');
    }
    
    console.log(`\n   Labs (count): ${appt.healthray_labs?.length || 0}`);
    if (appt.healthray_labs?.length > 0) {
      console.log('   ', JSON.stringify(appt.healthray_labs, null, 2));
    }
    
    // Check diagnoses table (synced data)
    const dxRes = await pool.query(
      `SELECT id, diagnosis_id, label, status, notes FROM diagnoses WHERE patient_id = $1`,
      [patient.id]
    );
    
    console.log(`\n🏥 Synced to diagnoses table: ${dxRes.rows.length} records`);
    if (dxRes.rows.length > 0) {
      dxRes.rows.forEach(dx => {
        console.log(`   - ${dx.label} (${dx.status}) [notes: ${dx.notes}]`);
      });
    } else {
      console.log('   ⚠️  No diagnoses synced to database');
    }
    
    // Check medications table (synced data)
    const medRes = await pool.query(
      `SELECT id, name, dose, frequency, is_active, notes FROM medications WHERE patient_id = $1 ORDER BY is_active DESC, created_at DESC`,
      [patient.id]
    );
    
    console.log(`\n💊 Synced to medications table: ${medRes.rows.length} records`);
    if (medRes.rows.length > 0) {
      medRes.rows.forEach(med => {
        console.log(`   - ${med.name} (${med.dose}, ${med.frequency}) [active: ${med.is_active}] [notes: ${med.notes}]`);
      });
    } else {
      console.log('   ⚠️  No medications synced to database');
    }
    
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

checkPatient();
