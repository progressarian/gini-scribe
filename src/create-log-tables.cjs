require('dotenv').config({ path: '../server/.env' });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const tables = [
  {
    name: 'patient_vitals_log',
    sql: `CREATE TABLE IF NOT EXISTS patient_vitals_log (
      id SERIAL PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id),
      genie_id TEXT, recorded_date DATE NOT NULL, reading_time TEXT,
      bp_systolic REAL, bp_diastolic REAL, rbs REAL, meal_type TEXT,
      weight_kg REAL, pulse REAL, spo2 REAL, body_fat REAL, muscle_mass REAL,
      bmi REAL, waist REAL, source TEXT DEFAULT 'genie',
      synced_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ
    )`,
  },
  {
    name: 'patient_activity_log',
    sql: `CREATE TABLE IF NOT EXISTS patient_activity_log (
      id SERIAL PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id),
      genie_id TEXT, activity_type TEXT NOT NULL, value TEXT, value2 TEXT,
      context TEXT, duration_minutes REAL, mood_score REAL,
      log_date DATE NOT NULL, log_time TEXT, source TEXT DEFAULT 'genie',
      synced_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ
    )`,
  },
  {
    name: 'patient_symptom_log',
    sql: `CREATE TABLE IF NOT EXISTS patient_symptom_log (
      id SERIAL PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id),
      genie_id TEXT, symptom TEXT NOT NULL, severity REAL, body_area TEXT,
      context TEXT, notes TEXT, follow_up_needed BOOLEAN DEFAULT FALSE,
      log_date DATE NOT NULL, log_time TEXT, source TEXT DEFAULT 'genie',
      synced_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ
    )`,
  },
  {
    name: 'patient_med_log',
    sql: `CREATE TABLE IF NOT EXISTS patient_med_log (
      id SERIAL PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id),
      genie_id TEXT, medication_name TEXT, medication_dose TEXT,
      genie_medication_id TEXT, log_date DATE NOT NULL, dose_time TEXT,
      status TEXT, source TEXT DEFAULT 'genie',
      synced_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ
    )`,
  },
  {
    name: 'patient_meal_log',
    sql: `CREATE TABLE IF NOT EXISTS patient_meal_log (
      id SERIAL PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id),
      genie_id TEXT, meal_type TEXT, description TEXT,
      calories REAL, protein_g REAL, carbs_g REAL, fat_g REAL,
      log_date DATE NOT NULL, source TEXT DEFAULT 'genie',
      synced_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ
    )`,
  },
];

const indexes = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_pvl_genie ON patient_vitals_log(genie_id) WHERE genie_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_pal_genie ON patient_activity_log(genie_id) WHERE genie_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_psl_genie ON patient_symptom_log(genie_id) WHERE genie_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_pml_genie ON patient_med_log(genie_id) WHERE genie_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_pmeal_genie ON patient_meal_log(genie_id) WHERE genie_id IS NOT NULL',
];

(async () => {
  try {
    for (const t of tables) {
      await pool.query(t.sql);
      console.log(`✅ ${t.name} — OK`);
    }
    for (const idx of indexes) {
      await pool.query(idx);
    }
    console.log('✅ All indexes created');

    // Also add genie_id if table existed but column was missing
    for (const t of tables) {
      await pool.query(`ALTER TABLE ${t.name} ADD COLUMN IF NOT EXISTS genie_id TEXT`).catch(() => {});
    }
    console.log('✅ Done — all 5 log tables ready');
  } catch (e) {
    console.error('❌', e.message);
  } finally {
    pool.end();
  }
})();
