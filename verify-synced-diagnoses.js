import pg from 'pg';

const dbUrl = 'postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function verify() {
  try {
    // Get patient ID
    const patRes = await pool.query(
      `SELECT id FROM patients WHERE file_no = 'P_178687'`
    );
    
    if (!patRes.rows[0]) {
      console.log('Patient not found');
      await pool.end();
      return;
    }
    
    const patientId = patRes.rows[0].id;
    
    // Get all diagnoses for this patient
    const dxRes = await pool.query(
      `SELECT id, diagnosis_id, label, status, notes FROM diagnoses WHERE patient_id = $1 ORDER BY created_at DESC`,
      [patientId]
    );
    
    console.log('\n✅ Diagnoses Now Synced to Database:');
    console.log(`   Total: ${dxRes.rows.length} diagnoses\n`);
    
    dxRes.rows.forEach((dx, i) => {
      console.log(`   ${i + 1}. ${dx.label}`);
      console.log(`      Status: ${dx.status}`);
      console.log(`      Notes: ${dx.notes || 'N/A'}`);
      console.log();
    });
    
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

verify();
