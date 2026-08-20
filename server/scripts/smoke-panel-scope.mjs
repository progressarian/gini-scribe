import "../loadEnv.js";
import pool from "../config/db.js";
import {
  doctorScope,
  latestDoctorIs,
  scopeParams,
  myPatientIds,
} from "../services/patientScope.js";

const session = (role, doctor) => ({
  doctor: doctor
    ? { doctor_id: doctor.id, doctor_name: doctor.name, short_name: doctor.short_name, role }
    : { role },
});

const countWithScope = async (table, scope) => {
  const where = scope.mine ? `WHERE ${latestDoctorIs("r.patient_id", 1)}` : "";
  const params = scope.mine ? scopeParams(scope) : [];
  const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM ${table} r ${where}`, params);
  return rows[0].n;
};

try {
  const { rows: docs } = await pool.query(
    `SELECT id, name, short_name FROM doctors WHERE role='consultant' AND is_active ORDER BY id LIMIT 3`,
  );
  if (!docs.length) throw new Error("no active consultants to test with");

  for (const table of ["medication_refill_requests", "medication_dose_change_requests"]) {
    const all = await countWithScope(table, doctorScope(session("admin", docs[0])));
    let summed = 0;
    const perDoctor = [];
    for (const d of docs) {
      const scope = doctorScope(session("consultant", d));
      if (!scope.mine) throw new Error(`consultant scope did not engage for ${d.name}`);
      const n = await countWithScope(table, scope);
      perDoctor.push(`${d.short_name || d.name}=${n}`);
      summed += n;
      if (n > all) throw new Error(`${table}: ${d.name} sees ${n} > hospital ${all}`);
    }
    console.log(`${table}\n  admin(all)=${all}  ${perDoctor.join("  ")}`);
    if (summed > all)
      throw new Error(`${table}: doctor slices sum to ${summed} > ${all} — overlapping ownership`);
  }

  // Reception and pharmacy must NOT be narrowed.
  for (const role of ["reception", "pharmacy", "admin", "obt", "nurse"]) {
    const scope = doctorScope(session(role, docs[0]));
    if (scope.mine) throw new Error(`${role} was scoped to a personal list — should see all`);
  }
  console.log("\nreception / pharmacy / admin / obt / nurse all see the full queue");

  // A doctor session without a doctor_id must fall back to seeing everything
  // rather than silently showing an empty dashboard.
  if (doctorScope(session("consultant", null)).mine)
    throw new Error("consultant without a doctor_id should fall back to all");

  // The Genie path (alerts/messages) resolves in JS — check it is index-fast.
  const { rows: sample } = await pool.query(
    `SELECT DISTINCT patient_id FROM appointments WHERE patient_id IS NOT NULL LIMIT 200`,
  );
  const ids = sample.map((r) => r.patient_id);
  const scope = doctorScope(session("consultant", docs[0]));
  const t0 = Date.now();
  const mine = await myPatientIds(scope, ids);
  const ms = Date.now() - t0;
  console.log(`\nmyPatientIds: ${mine.size}/${ids.length} of a 200-patient batch in ${ms}ms`);
  if (ms > 500) throw new Error(`resolution too slow for a dashboard load: ${ms}ms`);

  console.log("\nOK");
} catch (e) {
  console.error("FAILED:", e.message || e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
