/**
 * Smoke test for the Doctor Management & Availability feature
 * ("available by default + working profile" model).
 *
 * Verifies — against the REAL database — that the migrations applied and the
 * resolver runs end-to-end without touching production data (read-only except
 * for rolled-back transaction probes).
 *
 * Run (from gini-scribe/server):
 *   node scripts/smoke-doctor-management.mjs   (or: npm run smoke:doctors)
 *
 * Exit code 0 = all checks passed, 1 = something failed.
 */
import "../loadEnv.js";
import pool from "../config/db.js";
import { isSlotAvailable, getDoctorDayAvailability } from "../services/availability.js";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  \x1b[31m✗ ${m}\x1b[0m`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const todayISO = () => new Date().toISOString().split("T")[0];

async function main() {
  // 1. Schema objects --------------------------------------------------------
  section("1. Schema objects");
  for (const t of [
    "slot_catalog",
    "doctor_profile",
    "doctor_unavailability",
    "appointment_reassignments",
  ]) {
    const r = await pool.query("SELECT to_regclass($1) AS reg", [`public.${t}`]);
    r.rows[0].reg ? ok(`table ${t} exists`) : bad(`table ${t} MISSING`);
  }
  for (const t of ["doctor_availability", "doctor_weekly_schedule", "doctor_recurring_breaks"]) {
    const r = await pool.query("SELECT to_regclass($1) AS reg", [`public.${t}`]);
    r.rows[0].reg ? bad(`obsolete table ${t} still exists`) : ok(`obsolete table ${t} dropped`);
  }
  const fn = await pool.query("SELECT 1 FROM pg_proc WHERE proname='resolve_doctor_id' LIMIT 1");
  fn.rows.length ? ok("resolve_doctor_id() exists") : bad("resolve_doctor_id() MISSING");

  // 2. Slot catalog ----------------------------------------------------------
  section("2. Slot catalog");
  const sc = await pool.query("SELECT label FROM slot_catalog ORDER BY sort_order");
  sc.rows.length === 28
    ? ok("slot_catalog seeded with 28 slots (full 24h)")
    : bad(`expected 28, found ${sc.rows.length}`);

  // 3. Pick a doctor ---------------------------------------------------------
  section("3. Doctor + name resolution");
  const docs = await pool.query(
    "SELECT id, name, short_name FROM doctors WHERE is_active ORDER BY id LIMIT 1",
  );
  if (!docs.rows.length) {
    bad("no active doctors found");
    return;
  }
  const d = docs.rows[0];
  const byName = await pool.query("SELECT resolve_doctor_id($1) AS id", [d.name]);
  byName.rows[0].id === d.id
    ? ok(`resolve_doctor_id("${d.name}") → ${d.id}`)
    : bad("name resolution off");

  // 4. Default availability (no profile row ⇒ Mon–Sat, all slots) ------------
  section("4. Default availability");
  const date = todayISO();
  const wd = (await pool.query("SELECT EXTRACT(DOW FROM CURRENT_DATE)::int AS w")).rows[0].w;
  const isSunday = wd === 0;
  const day = await getDoctorDayAvailability(d.id, date);
  day.length === 28
    ? ok(`getDoctorDayAvailability → all 28 catalog slots returned`)
    : bad(`expected 28 slots, got ${day.length}`);
  const freeCount = day.filter((s) => s.available).length;
  if (isSunday) {
    day.every((s) => s.blocked_by === "day_off")
      ? ok("today is Sunday → every slot day_off (default)")
      : bad("Sunday should be all day_off");
  } else {
    ok(`today is a working day (dow=${wd}) → ${freeCount}/${day.length} slots available`);
  }

  // 5. Profile overrides (rolled back) --------------------------------------
  section("5. Profile round-trip (rolled back)");
  const slot = sc.rows[0].label;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // (a) mark today a day off
    await client.query(
      `INSERT INTO doctor_profile (doctor_id, off_weekdays) VALUES ($1, ARRAY[$2]::smallint[])
       ON CONFLICT (doctor_id) DO UPDATE SET off_weekdays=EXCLUDED.off_weekdays`,
      [d.id, wd],
    );
    const a = await isSlotAvailable(d.id, date, slot, { client });
    a.reason === "day_off"
      ? ok("off_weekdays includes today → day_off")
      : bad(`expected day_off, got ${JSON.stringify(a)}`);

    // (b) working today, but hours (10:00–16:00) exclude the 9:30 slot
    await client.query(
      "UPDATE doctor_profile SET off_weekdays='{}', work_start='10:00', work_end='16:00', lunch_start=NULL, lunch_end=NULL WHERE doctor_id=$1",
      [d.id],
    );
    const b = await isSlotAvailable(d.id, date, slot, { client });
    b.reason === "not_working"
      ? ok(`work hours 10:00–16:00 exclude "${slot}" → not_working`)
      : bad(`expected not_working, got ${JSON.stringify(b)}`);

    // (c) all-day hours + lunch 09:30–10:00 covering the slot → break
    await client.query(
      "UPDATE doctor_profile SET work_start=NULL, work_end=NULL, lunch_start='09:30', lunch_end='10:00' WHERE doctor_id=$1",
      [d.id],
    );
    const c = await isSlotAvailable(d.id, date, slot, { client });
    c.reason === "break"
      ? ok(`lunch 09:30–10:00 covers "${slot}" → break`)
      : bad(`expected break, got ${JSON.stringify(c)}`);

    // (d) no lunch, all day → no longer day_off/break/not_working
    await client.query(
      "UPDATE doctor_profile SET lunch_start=NULL, lunch_end=NULL WHERE doctor_id=$1",
      [d.id],
    );
    const dd = await isSlotAvailable(d.id, date, slot, { client });
    !["day_off", "break", "not_working"].includes(dd.reason)
      ? ok(`all-day, no lunch → available${dd.available ? "" : " (or " + dd.reason + ")"}`)
      : bad(`still blocked by ${dd.reason}`);

    // (e) overnight shift 17:00–01:00 with lunch 22:00–22:30
    await client.query(
      "UPDATE doctor_profile SET work_start='17:00', work_end='01:00', lunch_start='22:00', lunch_end='22:30' WHERE doctor_id=$1",
      [d.id],
    );
    const night = await isSlotAvailable(d.id, date, "10 PM to 11 PM", { client });
    night.reason === "break"
      ? ok("overnight 17:00–01:00, lunch 22:00 → 10 PM slot is break")
      : bad(`expected break for 10 PM during overnight lunch, got ${JSON.stringify(night)}`);
    const nightOpen = await isSlotAvailable(d.id, date, "12 AM to 1 AM", { client });
    nightOpen.available === true
      ? ok("overnight shift covers past-midnight slot (12 AM–1 AM available)")
      : bad(`expected 12 AM slot available in overnight shift, got ${JSON.stringify(nightOpen)}`);
    const dayGap = await isSlotAvailable(d.id, date, "10 AM to 11 AM", { client });
    dayGap.reason === "not_working"
      ? ok("overnight shift → daytime 10 AM slot is not_working")
      : bad(`expected not_working for 10 AM, got ${JSON.stringify(dayGap)}`);

    await client.query("ROLLBACK");
    ok("profile changes rolled back — no data written");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    bad(`profile round-trip failed: ${e.message}`);
  } finally {
    client.release();
  }

  // 6. Reassignment audit write (rolled back) -------------------------------
  section("6. Reassignment audit table (rolled back)");
  const c2 = await pool.connect();
  try {
    await c2.query("BEGIN");
    await c2.query(
      "INSERT INTO appointment_reassignments (appointment_id, trigger, reason, reassigned_by) VALUES (NULL,'smoke','probe','smoke')",
    );
    await c2.query("ROLLBACK");
    ok("appointment_reassignments accepts inserts (rolled back)");
  } catch (e) {
    await c2.query("ROLLBACK").catch(() => {});
    bad(`reassignment insert failed: ${e.message}`);
  } finally {
    c2.release();
  }

  section("Result");
  console.log(
    failures === 0
      ? "  \x1b[32mAll checks passed.\x1b[0m"
      : `  \x1b[31m${failures} check(s) failed.\x1b[0m`,
  );
}

main()
  .catch((e) => {
    console.error("\x1b[31mSMOKE TEST CRASHED:\x1b[0m", e.message || e);
    failures++;
  })
  .finally(async () => {
    await pool.end();
    process.exit(failures === 0 ? 0 : 1);
  });
