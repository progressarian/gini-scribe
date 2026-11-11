import "../loadEnv.js";
import fs from "node:fs/promises";
import path from "node:path";
import { DM_SLUG, LAB_CONFIRMED_SOURCES } from "../services/analytics/dmOutcomes.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};

const CHUNK = 2500;
const PAUSE_MS = 1500;
const RETRIES = 6;
const RETRY_WAIT_MS = 20000;
const VISIT_STATUSES = ["seen", "completed", "checkedin"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const outDir = path.resolve(arg("out", "reports/dm-outcomes"));
const dm = JSON.parse(await fs.readFile(path.join(outDir, "dm-outcomes.json"), "utf8"));
const { start, end } = dm.meta.period;
const { cronPool } = await import("../config/db.js");

async function readOnly(sql, params) {
  for (let attempt = 1; ; attempt += 1) {
    const client = await cronPool.connect().catch((error) => error);
    try {
      if (client instanceof Error) throw client;
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '30s'");
      const { rows } = await client.query(sql, params);
      return rows;
    } catch (error) {
      if (attempt >= RETRIES) throw error;
      console.log(`  retry ${attempt}: ${error.message.slice(0, 70)}`);
      await sleep(RETRY_WAIT_MS);
    } finally {
      if (!(client instanceof Error)) {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    }
  }
}

async function chunked(label, sql, maxId) {
  const out = [];
  for (let lo = 0; lo <= maxId; lo += CHUNK) {
    const t = Date.now();
    out.push(...(await readOnly(sql, [lo, lo + CHUNK])));
    console.log(`  ${((Date.now() - t) / 1000).toFixed(1)}s ${label} ${lo}`);
    await sleep(PAUSE_MS);
  }
  return out;
}

const started = Date.now();
try {
  const maxId = (await readOnly("SELECT max(id)::int AS m FROM patients"))[0].m;
  const patients = await chunked(
    "patients",
    `SELECT id, lower(trim(name)) AS nm, dob::text AS dob FROM patients WHERE id >= $1 AND id < $2`,
    maxId,
  );
  const seen = new Set(
    [
      ...(await chunked(
        "consultations",
        `SELECT DISTINCT patient_id FROM consultations
          WHERE patient_id >= $1 AND patient_id < $2 AND visit_date BETWEEN '${start}' AND '${end}'`,
        maxId,
      )),
      ...(await chunked(
        "appointments",
        `SELECT DISTINCT patient_id FROM appointments
          WHERE patient_id >= $1 AND patient_id < $2 AND status = ANY('{${VISIT_STATUSES.join(",")}}')
            AND appointment_date BETWEEN '${start}' AND '${end}'`,
        maxId,
      )),
    ].map((r) => r.patient_id),
  );
  const dmRe = new RegExp(DM_SLUG);
  const diagnosed = new Set(
    (
      await chunked(
        "diagnoses",
        `SELECT DISTINCT patient_id, diagnosis_id FROM diagnoses WHERE patient_id >= $1 AND patient_id < $2 AND is_active`,
        maxId,
      )
    )
      .filter((r) => dmRe.test(r.diagnosis_id))
      .map((r) => r.patient_id),
  );
  const tests = await chunked(
    "hba1c",
    `SELECT patient_id, test_date::text AS d, result::float8 AS v, COALESCE(source, 'unknown') AS s
       FROM lab_results WHERE patient_id >= $1 AND patient_id < $2 AND canonical_name = 'HbA1c'
        AND result BETWEEN 3 AND 20 AND test_date IS NOT NULL`,
    maxId,
  );
  const lab = new Set(LAB_CONFIRMED_SOURCES);
  const testsById = new Map();
  for (const t of tests) {
    const list = testsById.get(t.patient_id) || [];
    list.push(t);
    testsById.set(t.patient_id, list);
  }
  const labDefined = new Set();
  for (const [id, list] of testsById) {
    const high = list.filter((t) => t.v >= 6.5 && t.d <= end && t.d.slice(5) !== "01-01");
    if (
      new Set(high.map((t) => t.d)).size >= 2 &&
      (new Set(high.map((t) => t.v)).size >= 2 || high.some((t) => lab.has(t.s)))
    )
      labDefined.add(id);
  }
  const persons = new Map();
  let seenRecords = 0;
  for (const p of patients.sort((a, b) => a.id - b.id)) {
    if (!seen.has(p.id)) continue;
    seenRecords += 1;
    const key = p.dob ? `${p.nm}|${p.dob}` : `id:${p.id}`;
    const person = persons.get(key) || { ids: [], diabetes: false };
    person.ids.push(p.id);
    person.diabetes ||= diagnosed.has(p.id) || labDefined.has(p.id);
    persons.set(key, person);
  }
  const people = persons;
  const cleanDates = (ids) => {
    const rows = ids
      .flatMap((id) => testsById.get(id) || [])
      .sort((a, b) => a.d.localeCompare(b.d));
    const firstSeen = new Map();
    const dates = new Set();
    for (const t of rows) {
      if (t.d.slice(5) === "01-01") continue;
      const seenOn = firstSeen.get(t.v);
      if (!lab.has(t.s) && seenOn && seenOn < t.d) continue;
      if (!seenOn) firstSeen.set(t.v, t.d);
      dates.add(t.d);
    }
    return [...dates];
  };
  const hba1c = (filter) => {
    const group = [...persons.values()].filter(filter);
    const dated = group.map((p) => cleanDates(p.ids));
    const inPeriod = dated.map((ds) => ds.filter((d) => d >= start && d <= end));
    return {
      people: group.length,
      any_test_all_time: dated.filter((ds) => ds.length >= 1).length,
      two_plus_all_time: dated.filter((ds) => ds.length >= 2).length,
      two_plus_in_period: inPeriod.filter((ds) => ds.length >= 2).length,
      earliest_test: dated.flat().sort()[0] ?? null,
      latest_test: dated.flat().sort().at(-1) ?? null,
    };
  };
  const dailyValues = (ids) => {
    const rows = ids
      .flatMap((id) => testsById.get(id) || [])
      .sort((a, b) => a.d.localeCompare(b.d));
    const firstSeen = new Map();
    const byDay = new Map();
    for (const t of rows) {
      if (t.d.slice(5) === "01-01") continue;
      const isLab = lab.has(t.s);
      const seenOn = firstSeen.get(t.v);
      if (!isLab && seenOn && seenOn < t.d) continue;
      if (!seenOn) firstSeen.set(t.v, t.d);
      const day = byDay.get(t.d);
      if (!day) byDay.set(t.d, { d: t.d, v: t.v, labV: isLab ? t.v : null });
      else {
        if (isLab && (day.labV == null || t.v > day.labV)) day.labV = t.v;
        day.v = day.labV ?? Math.max(day.v, t.v);
      }
    }
    return [...byDay.values()]
      .filter((x) => x.d >= start && x.d <= end)
      .sort((a, b) => a.d.localeCompare(b.d));
  };
  const r2 = (x) => Math.round(x * 100) / 100;
  const pctOf = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const mid = (xs) => {
    const s2 = [...xs].sort((a, b) => a - b);
    return s2.length
      ? (s2[Math.floor((s2.length - 1) / 2)] + s2[Math.ceil((s2.length - 1) / 2)]) / 2
      : null;
  };
  const pairs = [...persons.values()]
    .filter((p) => p.diabetes)
    .map((p) => dailyValues(p.ids))
    .filter((days) => days.length >= 2)
    .map((days) => ({
      first: days[0].v,
      latest: days.at(-1).v,
      months: (Date.parse(days.at(-1).d) - Date.parse(days[0].d)) / 864e5 / 30.44,
    }));
  const change = pairs.map((x) => r2(x.latest - x.first));
  const sd = Math.sqrt(
    change.reduce((a, c) => a + (c - avg(change)) ** 2, 0) / (change.length - 1),
  );
  const count = (fn) => ({
    n: change.filter(fn).length,
    pct: pctOf(change.filter(fn).length, change.length),
  });
  const firstVsLatest = {
    patients: pairs.length,
    first_mean: r2(avg(pairs.map((x) => x.first))),
    latest_mean: r2(avg(pairs.map((x) => x.latest))),
    change_mean: r2(avg(change)),
    change_median: r2(mid(change)),
    change_ci95: [
      r2(avg(change) - (1.96 * sd) / Math.sqrt(change.length)),
      r2(avg(change) + (1.96 * sd) / Math.sqrt(change.length)),
    ],
    improved_05: count((c) => c <= -0.5),
    improved_10: count((c) => c <= -1),
    about_same: count((c) => c > -0.5 && c < 0.5),
    worsened_05: count((c) => c >= 0.5),
    below7_first: {
      n: pairs.filter((x) => x.first < 7).length,
      pct: pctOf(pairs.filter((x) => x.first < 7).length, pairs.length),
    },
    below7_latest: {
      n: pairs.filter((x) => x.latest < 7).length,
      pct: pctOf(pairs.filter((x) => x.latest < 7).length, pairs.length),
    },
    months_between_median: Math.round(mid(pairs.map((x) => x.months)) * 10) / 10,
  };
  const result = {
    period: { start, end },
    generated_at: new Date().toISOString(),
    patients_in_scribe: patients.length,
    records_seen_in_period: seenRecords,
    never_seen_in_period: patients.length - seenRecords,
    duplicate_records_merged: seenRecords - people.size,
    total_seen: people.size,
    diabetes: dm.funnel.registry,
    diabetes_recount: [...persons.values()].filter((p) => p.diabetes).length,
    first_vs_latest_diabetes: firstVsLatest,
    hba1c_tests: {
      diabetes: hba1c((p) => p.diabetes),
      all_patients: hba1c(() => true),
    },
  };
  await fs.writeFile(path.join(outDir, "all-patients-count.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
} catch (error) {
  console.error(`Stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cronPool.end();
}
