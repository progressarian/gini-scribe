import pg from 'pg';

const dbUrl = 'postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function debug() {
  try {
    const patRes = await pool.query(
      `SELECT id FROM patients WHERE file_no = 'P_178687'`
    );
    
    const patientId = patRes.rows[0].id;
    
    // Get ALL NMZ entries
    const nmzMeds = await pool.query(
      `SELECT id, name, dose, frequency, is_active, stopped_date, stop_reason
       FROM medications 
       WHERE patient_id = $1 AND (UPPER(name) LIKE '%NMZ%' OR UPPER(name) LIKE '%NEOMERCAZOLE%')
       ORDER BY dose DESC, is_active DESC`,
      [patientId]
    );
    
    console.log('All NMZ entries in database:\n');
    nmzMeds.rows.forEach((m, i) => {
      console.log(`${i + 1}. Name: ${m.name}`);
      console.log(`   Dose: ${m.dose || 'NULL'}`);
      console.log(`   Active: ${m.is_active}`);
      console.log(`   Stopped: ${m.stopped_date ? m.stopped_date.toISOString().split('T')[0] : 'NULL'}`);
      console.log(`   Reason: ${m.stop_reason || 'NULL'}`);
      console.log();
    });
    
    console.log(`Expected: Should have both NMZ 20mg (active) and NMZ 10mg (stopped)`);
    
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

debug();
