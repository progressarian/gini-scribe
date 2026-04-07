#!/usr/bin/env node
// Migration: Merge "Young Onset Type 2 DM" into "Type 2 DM (Young Onset)"
// Run from server directory: node migrations/merge-young-onset-diagnoses.js

import "dotenv/config.js";
import pg from "pg";

const dbUrl = process.env.DATABASE_URL;
console.log("DATABASE_URL:", dbUrl ? "✓ Loaded" : "✗ Not found");

if (!dbUrl) {
  console.error("ERROR: DATABASE_URL not set in .env file");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: dbUrl });

async function mergeDiagnoses() {
  try {
    console.log("Connecting to database...");

    // Find all cases where we have both "Type 2 DM" and "Young Onset Type 2 DM"
    console.log("\n📋 Finding patients with duplicate diagnoses...");
    const findPairsRes = await pool.query(`
      SELECT DISTINCT p1.patient_id
      FROM diagnoses p1
      JOIN diagnoses p2 ON p1.patient_id = p2.patient_id
      WHERE p1.diagnosis_id = 'type_2_dm'
        AND p2.diagnosis_id = 'young_onset_type_2_dm'
        AND p1.is_active = true
        AND p2.is_active = true
    `);

    const patientIds = findPairsRes.rows.map((r) => r.patient_id);
    console.log(`Found ${patientIds.length} patient(s) with both diagnoses\n`);

    let mergedCount = 0;

    for (const patientId of patientIds) {
      // Get both diagnoses
      const dxRes = await pool.query(
        `SELECT id, label, status, since_year, notes FROM diagnoses
         WHERE patient_id = $1
         AND diagnosis_id IN ('type_2_dm', 'young_onset_type_2_dm')
         AND is_active = true`,
        [patientId],
      );

      const diagnoses = dxRes.rows;
      const mainDx = diagnoses.find((d) => d.label && !d.label.includes("Young"));
      const youngDx = diagnoses.find((d) => d.label && d.label.includes("Young"));

      if (mainDx && youngDx) {
        // Update main diagnosis label to include qualifier
        const newLabel = `${mainDx.label} (Young Onset)`;
        await pool.query(
          `UPDATE diagnoses
           SET label = $1, updated_at = NOW()
           WHERE id = $2`,
          [newLabel, mainDx.id],
        );

        // Soft-delete the "Young Onset" entry
        await pool.query(
          `UPDATE diagnoses
           SET is_active = false, updated_at = NOW()
           WHERE id = $1`,
          [youngDx.id],
        );

        console.log(`✓ Patient ${patientId}: "${youngDx.label}" → "${newLabel}"`);
        mergedCount++;
      }
    }

    console.log(`\n✅ Migration complete! Merged ${mergedCount} diagnosis pairs.`);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

mergeDiagnoses();
