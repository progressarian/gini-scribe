#!/usr/bin/env node
// Delete a patient + all their dependent rows from the Genie DB
// (purzqfmfycfowyxfaumc).
//
// Usage:
//   GENIE_SUPABASE_URL=... GENIE_SUPABASE_SERVICE_KEY=... \
//   node scripts/delete_test_patient.mjs "Test Patient (Companion)"
//
// Behaviour:
//   1. Look up patient(s) by name (case-insensitive exact match).
//   2. Print a per-table count of what would be deleted.
//   3. Unless --yes is passed, stop. With --yes, perform the deletes in
//      child-first order, then delete the patient row itself, then delete
//      the auth.users row if patient.auth_user_id is set.

import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const dryRun = !args.includes("--yes");
const name = args.filter((a) => !a.startsWith("--"))[0];

if (!name) {
  console.error('usage: node scripts/delete_test_patient.mjs "<patient name>" [--yes]');
  process.exit(1);
}

const url = process.env.GENIE_SUPABASE_URL;
const key = process.env.GENIE_SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error("missing GENIE_SUPABASE_URL or GENIE_SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

// Tables that hold per-patient data in the Genie DB. Order matters for
// foreign keys (children before parent). If a table doesn't exist on this
// project the delete is silently skipped (PGRST205).
const CHILD_TABLES = [
  "vitals",
  "lab_results",
  "medications",
  "medication_logs",
  "conditions",
  "goals",
  "appointments",
  "timeline_events",
  "treatment_plans",
  "activity_logs",
  "symptom_logs",
  "patient_insights",
  "patient_documents",
  "alert_channel",
  "chat_messages",
  "food_preferences",
  "meal_logs",
  "patient_messages",
];

const { data: matches, error: lookupErr } = await db
  .from("patients")
  .select("*")
  .ilike("name", name);

if (lookupErr) {
  console.error("[lookup error]", lookupErr.message);
  process.exit(1);
}
if (!matches || matches.length === 0) {
  console.log(`[no match] no patient named "${name}" in this DB.`);
  process.exit(0);
}

console.log(`[matches] ${matches.length} patient row(s):`);
for (const p of matches) {
  console.log(
    `   id=${p.id}  phone=${p.phone}  file_no=${p.file_no ?? "-"}  ` +
      `gini_patient_id=${p.gini_patient_id ?? "-"}  program_type=${p.program_type ?? "-"}  ` +
      `auth_user_id=${p.auth_user_id ?? "-"}  created=${p.created_at}`,
  );
}
console.log("");

// Per-table counts
async function countFor(table, pid) {
  const { count, error } = await db.from(table).select("id", { count: "exact", head: true }).eq("patient_id", pid);
  if (error) {
    if (error.code === "PGRST205" || /does not exist/i.test(error.message)) return null;
    return `error: ${error.message}`;
  }
  return count ?? 0;
}

for (const p of matches) {
  console.log(`[counts] patient_id=${p.id}`);
  for (const t of CHILD_TABLES) {
    const c = await countFor(t, p.id);
    if (c === null) continue; // table doesn't exist
    console.log(`   ${t.padEnd(20)} ${typeof c === "number" ? String(c).padStart(5) : c}`);
  }
  console.log("");
}

if (dryRun) {
  console.log("[dry-run] no rows deleted. Re-run with --yes to perform deletion.");
  process.exit(0);
}

// Perform deletion
for (const p of matches) {
  console.log(`[deleting] patient_id=${p.id}`);
  for (const t of CHILD_TABLES) {
    const { error, count } = await db.from(t).delete({ count: "exact" }).eq("patient_id", p.id);
    if (error) {
      if (error.code === "PGRST205" || /does not exist/i.test(error.message)) continue;
      console.warn(`   ! ${t}: ${error.message}`);
    } else {
      console.log(`   - ${t.padEnd(20)} deleted ${count ?? 0}`);
    }
  }
  const { error: pErr } = await db.from("patients").delete().eq("id", p.id);
  if (pErr) {
    console.error(`   ! patients: ${pErr.message}`);
  } else {
    console.log("   - patients            deleted 1");
  }

  if (p.auth_user_id) {
    const { error: aErr } = await db.auth.admin.deleteUser(p.auth_user_id);
    if (aErr) {
      console.warn(`   ! auth.users(${p.auth_user_id}): ${aErr.message}`);
    } else {
      console.log(`   - auth.users          deleted ${p.auth_user_id}`);
    }
  }
}

console.log("\n[done]");
