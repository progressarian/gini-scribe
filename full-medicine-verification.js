import pg from 'pg';

const dbUrl = 'postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres';
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function verify() {
  try {
    const patRes = await pool.query(
      `SELECT id FROM patients WHERE file_no = 'P_178687'`
    );
    
    const patientId = patRes.rows[0].id;
    
    // Get ALL medications
    const allMeds = await pool.query(
      `SELECT id, name, dose, frequency, is_active, stopped_date, stop_reason, notes, created_at
       FROM medications 
       WHERE patient_id = $1
       ORDER BY is_active DESC, UPPER(name), dose DESC, created_at DESC`,
      [patientId]
    );
    
    console.log('\n========================================');
    console.log('COMPLETE MEDICINE VERIFICATION');
    console.log('P_178687 - Mrs. Jasmeet Kaur');
    console.log('========================================\n');
    
    const activeCount = allMeds.rows.filter(m => m.is_active).length;
    const inactiveCount = allMeds.rows.filter(m => !m.is_active).length;
    
    console.log(`📊 Summary: ${activeCount} active, ${inactiveCount} stopped\n`);
    
    console.log('✅ ACTIVE MEDICINES:\n');
    allMeds.rows.filter(m => m.is_active).forEach((m, i) => {
      console.log(`${i + 1}. ${m.name}`);
      console.log(`   Dose: ${m.dose || 'N/A'} | Freq: ${m.frequency || 'N/A'}`);
      console.log(`   Source: ${m.notes || 'Manual'}`);
    });
    
    console.log(`\n❌ STOPPED/PREVIOUS MEDICINES:\n`);
    allMeds.rows.filter(m => !m.is_active).forEach((m, i) => {
      console.log(`${i + 1}. ${m.name} - ${m.dose || 'N/A'}`);
      console.log(`   Reason: ${m.stop_reason || 'Unknown'}`);
    });
    
    console.log('\n📋 ISSUES FOUND:\n');
    
    // Check for NMZ 10mg
    const hasNMZ10 = allMeds.rows.some(m => 
      m.name.toUpperCase().includes('NMZ') && 
      m.dose && 
      m.dose.includes('10')
    );
    
    if (!hasNMZ10) {
      console.log('⚠️  NMZ 10mg (previous dose) not recorded');
      console.log('   The dose change from 10mg → 20mg is not being tracked');
    } else {
      console.log('✅ NMZ 10mg (previous dose) is recorded');
    }
    
    // Check for duplicate names
    const nameGroups = {};
    allMeds.rows.forEach(m => {
      const key = m.name.toUpperCase();
      if (!nameGroups[key]) nameGroups[key] = [];
      nameGroups[key].push(m);
    });
    
    const duplicates = Object.entries(nameGroups).filter(([_, meds]) => meds.length > 1);
    if (duplicates.length > 0) {
      console.log(`⚠️  Duplicate name variations found (${duplicates.length}):`);
      duplicates.forEach(([name, meds]) => {
        console.log(`   ${name}: ${meds.map(m => m.dose).join(', ')}`);
      });
    }
    
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
}

verify();
