import pg from 'pg';

const dbUrl = 'postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function verify() {
  try {
    const patRes = await pool.query(
      `SELECT id FROM patients WHERE file_no = 'P_178687'`
    );
    
    const patientId = patRes.rows[0].id;
    
    // Get all medications
    const allMeds = await pool.query(
      `SELECT id, name, dose, frequency, is_active, stopped_date, stop_reason, notes
       FROM medications 
       WHERE patient_id = $1
       ORDER BY is_active DESC, name, dose DESC`,
      [patientId]
    );
    
    console.log('\n========================================');
    console.log('MEDICINES VERIFICATION (UPDATED)');
    console.log('========================================\n');
    
    const activeMeds = allMeds.rows.filter(m => m.is_active);
    const inactiveMeds = allMeds.rows.filter(m => !m.is_active);
    
    console.log(`✅ ACTIVE MEDICINES (${activeMeds.length}):\n`);
    activeMeds.forEach((m, i) => {
      console.log(`  ${i + 1}. ${m.name} ${m.dose ? '- ' + m.dose : ''} ${m.frequency || ''}`);
    });
    
    console.log(`\n❌ STOPPED/PREVIOUS MEDICINES (${inactiveMeds.length}):\n`);
    inactiveMeds.forEach((m, i) => {
      console.log(`  ${i + 1}. ${m.name} ${m.dose ? '- ' + m.dose : ''}`);
      console.log(`     Stopped: ${m.stopped_date ? m.stopped_date.toISOString().split('T')[0] : 'N/A'}`);
      console.log(`     Reason: ${m.stop_reason || 'N/A'}`);
      console.log();
    });
    
    // Check specifically for NMZ 10mg
    const nmz10 = inactiveMeds.find(m => m.name.toUpperCase().includes('NMZ') && m.dose === '10mg');
    
    console.log('🎯 DOSE CHANGE TRACKING:');
    if (nmz10) {
      console.log(`  ✅ NMZ 10mg found in stopped medicines`);
      console.log(`     Stop reason: ${nmz10.stop_reason}`);
    } else {
      const nmz10_alt = inactiveMeds.find(m => m.name.toUpperCase().includes('NMZ') && (m.dose === '10' || m.dose === '10 mg'));
      if (nmz10_alt) {
        console.log(`  ✅ NMZ (10) found: ${nmz10_alt.dose}`);
        console.log(`     Stop reason: ${nmz10_alt.stop_reason}`);
      } else {
        console.log(`  ⚠️  NMZ 10mg not yet synced as stopped medicine`);
      }
    }
    
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

verify();
