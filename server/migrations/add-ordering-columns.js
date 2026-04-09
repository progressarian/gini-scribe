// Migration: Add diagnosis and medication ordering columns
// Run: node server/migrations/add-ordering-columns.js

import pg from "pg";
const { Pool } = pg;
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from server directory
dotenv.config({ path: join(__dirname, "..", ".env") });

console.log("Starting migration...");
console.log("DATABASE_URL set:", !!process.env.DATABASE_URL);

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL not found in environment");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  console.log("Connecting to database...");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── DIAGNOSES TABLE ──────────────────────────────────────────────────────
    console.log("Adding diagnosis columns...");

    // Add category column
    await client.query(`
      ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS category TEXT
    `);

    // Add complication_type column
    await client.query(`
      ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS complication_type TEXT
    `);

    // Add external_doctor column
    await client.query(`
      ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS external_doctor TEXT
    `);

    // Add key_value column
    await client.query(`
      ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS key_value TEXT
    `);

    // Add trend column
    await client.query(`
      ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS trend TEXT
    `);

    // Add sort_order column
    await client.query(`
      ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0
    `);

    // Create index
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_diagnoses_category ON diagnoses(patient_id, category)
    `);

    // ── MEDICATIONS TABLE ────────────────────────────────────────────────────
    console.log("Adding medication columns...");

    // Add med_group column
    await client.query(`
      ALTER TABLE medications ADD COLUMN IF NOT EXISTS med_group TEXT
    `);

    // Add drug_class column
    await client.query(`
      ALTER TABLE medications ADD COLUMN IF NOT EXISTS drug_class TEXT
    `);

    // Add external_doctor column
    await client.query(`
      ALTER TABLE medications ADD COLUMN IF NOT EXISTS external_doctor TEXT
    `);

    // Add clinical_note column
    await client.query(`
      ALTER TABLE medications ADD COLUMN IF NOT EXISTS clinical_note TEXT
    `);

    // Add sort_order column
    await client.query(`
      ALTER TABLE medications ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0
    `);

    // Create index
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_medications_group ON medications(patient_id, med_group)
    `);

    await client.query("COMMIT");
    console.log("Migration completed successfully!");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate()
  .then(() => {
    console.log("Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Migration error:", err);
    process.exit(1);
  });
