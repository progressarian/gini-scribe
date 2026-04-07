import pg from 'pg';

const dbUrl = 'postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function verify() {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM appointments WHERE patient_id = (SELECT id FROM patients WHERE file_no = 'P_178687') ORDER BY appointment_date DESC LIMIT 1`
    );
    
    if (rows[0]) {
      console.log(`✅ Patient P_178687 appointment ID: ${rows[0].id}`);
      console.log(`\n📌 To re-parse diagnoses, use:\n`);
      console.log(`   POST http://localhost:3001/api/sync/backfill/diagnoses/${rows[0].id}`);
      console.log(`\n⚙️  Or using curl:\n`);
      console.log(`   curl -X POST http://localhost:3001/api/sync/backfill/diagnoses/${rows[0].id}`);
    }
    
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

verify();
