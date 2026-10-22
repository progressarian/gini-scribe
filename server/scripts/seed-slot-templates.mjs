import "../loadEnv.js";
import pool from "../config/db.js";
import { planSeed, compareWithProfile } from "../services/slots/seedFromProfile.js";
import { profileFromRow } from "../services/slots/profileRules.js";
import { getDoctorDayAvailability } from "../services/availability.js";
import { dayPlan } from "../../shared/slotTemplates.js";
import { timeSpan, unavailabilityFor } from "../services/slots/dayView.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const APPLY = args.apply === true;
const VERIFY = args["verify-resolver"] === true;
const DAYS = Math.min(31, Math.max(1, Number(args.days) || 14));
const BATCH = Math.max(1, Number(args.batch) || 5);
const EFFECTIVE_FROM = args["effective-from"] || "2026-01-01";
const PAUSE_MS = 300;
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const NOTE = `Seeded ${TODAY} from the doctor's existing schedule (no change to their slots)`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = () => {
  try {
    const u = new URL(process.env.DATABASE_URL);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return "unknown";
  }
};
const isLocal = () => /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "");

async function preflight() {
  const { rows } = await pool.query(
    `SELECT state, count(*)::int AS n,
            COALESCE(max(EXTRACT(EPOCH FROM now() - xact_start))::int, 0) AS oldest_txn_s
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
      GROUP BY state ORDER BY state`,
  );
  console.log("Connections:", rows.map((r) => `${r.state || "none"} ${r.n}`).join(" · ") || "none");
  const stuck = rows.find((r) => r.state === "idle in transaction" && r.oldest_txn_s > 60);
  if (stuck) {
    throw new Error(
      `A session has been idle in a transaction for ${stuck.oldest_txn_s}s — the database is struggling. Not writing.`,
    );
  }
  const { rows: t } = await pool.query(
    `SELECT to_regclass('doctor_slot_templates') IS NOT NULL AS ok`,
  );
  if (!t[0].ok)
    throw new Error("doctor_slot_templates does not exist — apply the migration first.");
}

async function load() {
  const [catalog, doctors, profiles, existing] = await Promise.all([
    pool.query(
      `SELECT label, start_time::text, end_time::text FROM slot_catalog WHERE is_active ORDER BY sort_order`,
    ),
    pool.query(
      `SELECT id, name, role FROM doctors
        WHERE is_active AND lower(role) IN ('consultant', 'mo') ORDER BY role, name`,
    ),
    pool.query(
      `SELECT doctor_id, off_weekdays, work_start::text, work_end::text,
              lunch_start::text, lunch_end::text FROM doctor_profile`,
    ),
    pool.query(`SELECT DISTINCT doctor_id FROM doctor_slot_templates`),
  ]);
  return {
    catalog: catalog.rows,
    doctors: doctors.rows,
    profiles: new Map(profiles.rows.map((p) => [p.doctor_id, p])),
    existing: new Set(existing.rows.map((r) => r.doctor_id)),
  };
}

const describe = (row) => {
  if (!row) return "no profile → 24 h, Sunday off";
  const off = (row.off_weekdays || []).length;
  const hours =
    row.work_start && row.work_end
      ? `${row.work_start.slice(0, 5)}–${row.work_end.slice(0, 5)}`
      : "24 h";
  const lunch =
    row.lunch_start && row.lunch_end
      ? ` · lunch ${row.lunch_start.slice(0, 5)}–${row.lunch_end.slice(0, 5)}`
      : "";
  return `${hours}${lunch} · ${off} day(s) off`;
};

async function writeBatch(client, batch) {
  const templates = batch.map((b) => ({
    doctor_id: b.doctor.id,
    partial_last: b.plan.template.partialLast,
    note: NOTE,
  }));
  const hours = batch.flatMap((b) =>
    b.plan.template.hours.map((h) => ({
      doctor_id: b.doctor.id,
      weekday: h.weekday,
      start_time: h.start,
      end_time: h.end,
      slot_minutes: h.slotMinutes,
    })),
  );
  const breaks = batch.flatMap((b) =>
    b.plan.template.breaks.map((x) => ({
      doctor_id: b.doctor.id,
      weekday: x.weekday,
      name: x.name,
      start_time: x.start,
      end_time: x.end,
    })),
  );

  const { rows: made } = await client.query(
    `INSERT INTO doctor_slot_templates (doctor_id, effective_from, partial_last, note)
     SELECT x.doctor_id, $2::date, x.partial_last, x.note
       FROM jsonb_to_recordset($1::jsonb) AS x(doctor_id int, partial_last text, note text)
      WHERE NOT EXISTS (SELECT 1 FROM doctor_slot_templates t WHERE t.doctor_id = x.doctor_id)
     RETURNING id, doctor_id`,
    [JSON.stringify(templates), EFFECTIVE_FROM],
  );
  const ids = made.map((m) => m.id);
  const docs = made.map((m) => m.doctor_id);

  const h = await client.query(
    `INSERT INTO doctor_slot_template_hours (template_id, weekday, start_time, end_time, slot_minutes)
     SELECT t.id, x.weekday, x.start_time, x.end_time, x.slot_minutes
       FROM jsonb_to_recordset($1::jsonb)
            AS x(doctor_id int, weekday int, start_time time, end_time time, slot_minutes int)
       JOIN unnest($2::int[], $3::int[]) AS t(id, doctor_id) USING (doctor_id)`,
    [JSON.stringify(hours), ids, docs],
  );
  const br = await client.query(
    `INSERT INTO doctor_slot_template_breaks (template_id, weekday, name, start_time, end_time)
     SELECT t.id, x.weekday, x.name, x.start_time, x.end_time
       FROM jsonb_to_recordset($1::jsonb)
            AS x(doctor_id int, weekday int, name text, start_time time, end_time time)
       JOIN unnest($2::int[], $3::int[]) AS t(id, doctor_id) USING (doctor_id)`,
    [JSON.stringify(breaks), ids, docs],
  );
  return { templates: made.length, hours: h.rowCount, breaks: br.rowCount, doctorIds: docs };
}

async function readBack(client, doctorIds) {
  const { rows } = await client.query(
    `SELECT t.doctor_id, t.partial_last,
            COALESCE((SELECT json_agg(json_build_object('weekday', h.weekday, 'start', h.start_time::text,
                        'end', h.end_time::text, 'slotMinutes', h.slot_minutes))
                        FROM doctor_slot_template_hours h WHERE h.template_id = t.id), '[]') AS hours,
            COALESCE((SELECT json_agg(json_build_object('weekday', b.weekday, 'name', b.name,
                        'start', b.start_time::text, 'end', b.end_time::text))
                        FROM doctor_slot_template_breaks b WHERE b.template_id = t.id), '[]') AS breaks
       FROM doctor_slot_templates t
      WHERE t.doctor_id = ANY($1) AND t.status = 'active' AND t.effective_from = $2::date`,
    [doctorIds, EFFECTIVE_FROM],
  );
  return rows.map((r) => ({
    doctorId: r.doctor_id,
    template: { partialLast: r.partial_last, hours: r.hours, breaks: r.breaks },
  }));
}

const SCHEDULE_STATES = ["day_off", "not_working", "break"];
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

async function verifyAgainstResolver() {
  process.env.SLOT_TEMPLATES = "off";
  const { rows: seeded } = await pool.query(
    `SELECT t.doctor_id, d.name FROM doctor_slot_templates t JOIN doctors d ON d.id = t.doctor_id
      WHERE t.status = 'active' AND t.effective_from = $1::date ORDER BY d.name`,
    [EFFECTIVE_FROM],
  );
  const { rows: holidays } = await pool.query(
    `SELECT holiday_date::text AS d FROM clinic_holidays WHERE holiday_date BETWEEN $1::date AND $2::date`,
    [TODAY, addDays(TODAY, DAYS - 1)],
  );
  const holiday = new Set(holidays.map((h) => h.d));
  const { rows: timeOff } = await pool.query(
    `SELECT doctor_id, type, reason, slot_labels, start_time::text, end_time::text,
            start_date::text, end_date::text
       FROM doctor_unavailability
      WHERE status = 'active' AND end_date >= $1::date AND start_date <= $2::date`,
    [TODAY, addDays(TODAY, DAYS - 1)],
  );
  let excepted = 0;
  const templates = await readBack(
    pool,
    seeded.map((s) => s.doctor_id),
  );
  let checked = 0;
  const bad = [];
  for (const s of seeded) {
    const { template } = templates.find((t) => t.doctorId === s.doctor_id);
    for (let i = 0; i < DAYS; i += 1) {
      const date = addDays(TODAY, i);
      if (holiday.has(date)) continue;
      const offToday = timeOff.filter(
        (u) => u.doctor_id === s.doctor_id && u.start_date <= date && u.end_date >= date,
      );
      const day = await getDoctorDayAvailability(s.doctor_id, date);
      const covered = new Set(
        day
          .filter((x) =>
            unavailabilityFor(offToday, timeSpan(x.start_time, x.end_time), x.slot_label),
          )
          .map((x) => x.slot_label),
      );
      excepted += covered.size;
      const live = day.filter((x) => !covered.has(x.slot_label));
      const before = live
        .filter((x) => !SCHEDULE_STATES.includes(x.blocked_by))
        .map((x) => x.slot_label);
      const beforeBreak = live.filter((x) => x.blocked_by === "break").map((x) => x.slot_label);
      const plan = dayPlan(template, date);
      const after = plan.slots.map((x) => x.label).filter((l) => !covered.has(l));
      const afterBreak = live
        .filter((x) => {
          const [h, m] = x.start_time.split(":").map(Number);
          const t = h * 60 + m;
          return plan.breaks.some((b) =>
            [t, t + 1440].some((v) => v >= b.startMin && v < b.endMin),
          );
        })
        .map((x) => x.slot_label);
      checked += 1;
      if (!sameSet(before, after) || !sameSet(beforeBreak, afterBreak))
        bad.push({
          doctor: s.name,
          date,
          onlyLive: before.filter((l) => !after.includes(l)),
          onlyTemplate: after.filter((l) => !before.includes(l)),
        });
    }
  }
  console.log(
    `Old resolver vs template: ${seeded.length} doctors × ${DAYS} days → ${checked} doctor-days checked${holiday.size ? `, ${holiday.size} clinic holiday(s) skipped` : ""}${excepted ? `, ${excepted} slot(s) under one-off time off set aside` : ""}.`,
  );
  if (bad.length) {
    for (const b of bad.slice(0, 20))
      console.log(`  ✗ ${b.doctor} ${b.date}: ${JSON.stringify(b)}`);
    throw new Error(`${bad.length} doctor-day(s) differ`);
  }
  console.log("  ✓ identical for every doctor and day.");
}

async function main() {
  if (VERIFY) {
    console.log(
      `Target: ${target()}${isLocal() ? " (local)" : " (REMOTE)"} · read-only verification`,
    );
    return verifyAgainstResolver();
  }
  console.log(`Target: ${target()}${isLocal() ? " (local)" : " (REMOTE)"}`);
  console.log(
    `Mode: ${APPLY ? "APPLY — writes and commits" : "DRY RUN — every batch is rolled back"}`,
  );
  console.log(`Effective from ${EFFECTIVE_FROM} · ${BATCH} doctors per batch\n`);

  await preflight();
  const { catalog, doctors, profiles, existing } = await load();
  if (!catalog.length) throw new Error("slot_catalog has no active slots — nothing to copy.");

  const todo = [];
  const problems = [];
  let skipped = 0;
  for (const doctor of doctors) {
    if (existing.has(doctor.id)) {
      skipped += 1;
      continue;
    }
    const row = profiles.get(doctor.id) || null;
    const plan = planSeed(profileFromRow(row), catalog);
    if (plan.ok) todo.push({ doctor, row, plan });
    else problems.push({ doctor, row, plan });
  }

  console.log(`Consultants + MOs: ${doctors.length}`);
  console.log(`  already have a template (skipped): ${skipped}`);
  console.log(`  to seed: ${todo.length}`);
  console.log(`  cannot seed (listed below, not written): ${problems.length}`);
  const shapes = new Map();
  for (const t of todo) shapes.set(describe(t.row), (shapes.get(describe(t.row)) || 0) + 1);
  for (const [shape, n] of [...shapes].sort((a, b) => b[1] - a[1]))
    console.log(`    ${n} × ${shape}`);
  for (const p of problems) {
    console.log(`  ✗ ${p.doctor.name} (#${p.doctor.id}, ${p.doctor.role}) — ${describe(p.row)}`);
    for (const e of p.plan.errors) console.log(`      ${e.message}`);
    for (const m of p.plan.mismatches)
      console.log(`      differs on weekday ${m.weekday}: ${JSON.stringify(m)}`);
  }
  console.log("");

  const totals = { templates: 0, hours: 0, breaks: 0 };
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const wrote = await writeBatch(client, batch);
      const back = await readBack(client, wrote.doctorIds);
      for (const b of back) {
        const item = batch.find((x) => x.doctor.id === b.doctorId);
        const diff = compareWithProfile(profileFromRow(item.row), catalog, b.template);
        if (diff.length)
          throw new Error(
            `${item.doctor.name}: saved template differs after read-back ${JSON.stringify(diff)}`,
          );
      }
      await client.query(APPLY ? "COMMIT" : "ROLLBACK");
      totals.templates += wrote.templates;
      totals.hours += wrote.hours;
      totals.breaks += wrote.breaks;
      console.log(
        `Batch ${i / BATCH + 1}/${Math.ceil(todo.length / BATCH)}: ${wrote.templates} template(s), ${wrote.hours} hour row(s), ${wrote.breaks} break(s) — read back and checked — ${APPLY ? "committed" : "rolled back"}`,
      );
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (i + BATCH < todo.length) await sleep(PAUSE_MS);
  }

  console.log(
    `\n${APPLY ? "Written" : "Would write"}: ${totals.templates} templates, ${totals.hours} hour rows, ${totals.breaks} breaks.`,
  );
  if (!APPLY) console.log("Nothing was saved. Rerun with --apply to write.");
}

main()
  .catch((e) => {
    console.error(`\nStopped: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
