import "../loadEnv.js";
import pool from "../config/db.js";
import { getDoctorDayAvailability } from "../services/availability.js";

const cat = await pool.query(
  "SELECT label, start_time, end_time, sort_order FROM slot_catalog WHERE is_active ORDER BY sort_order",
);
console.log("=== active catalog ===");
console.table(cat.rows);

const inactive = await pool.query(
  "SELECT label FROM slot_catalog WHERE NOT is_active ORDER BY sort_order",
);
console.log(
  "retired:",
  inactive.rows.map((r) => r.label),
);

const prof = await pool.query(
  "SELECT doctor_id, work_start, work_end, lunch_start, lunch_end FROM doctor_profile ORDER BY doctor_id",
);
console.log("=== doctor_profile ===");
console.table(prof.rows);

const gaps = await pool.query(`
  SELECT a.label AS after_this, b.label AS comes_before, a.end_time, b.start_time
  FROM slot_catalog a
  JOIN slot_catalog b ON b.sort_order = a.sort_order + 1
  WHERE a.is_active AND b.is_active AND a.end_time <> b.start_time
  ORDER BY a.sort_order`);
console.log("=== ordering gaps/overlaps (should be empty) ===");
console.table(gaps.rows);

const date = process.argv[2] || "2026-08-24";
const day = await getDoctorDayAvailability(1, date);
console.log(`=== Dr. Anil Bhansali (id 1) — ${date} ===`);
console.table(
  (day.slots || day).map((s) => ({
    slot: s.slot_label ?? s.label,
    available: s.available,
    reason: s.reason || "",
  })),
);
process.exit(0);
