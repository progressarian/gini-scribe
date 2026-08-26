import "../loadEnv.js";
import express from "express";
import router from "../routes/analytics.js";
import pool from "../config/db.js";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const raw = req.headers["x-test-session"];
  if (raw) req.doctor = JSON.parse(raw);
  next();
});
app.use("/api", router);
const server = app.listen(0);
const { port } = server.address();

const session = { doctor_id: 1, doctor_name: "Smoke Admin", role: "admin" };

async function get(path, { raw = false } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { "x-test-session": JSON.stringify(session) },
  });
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

try {
  console.log("meta");
  const meta = await get("/api/analytics/meta");
  check("meta returns section list", Array.isArray(meta.sections) && meta.sections.length > 0);
  check("meta reports a snapshot or explicitly none", "snapshot" in meta);
  if (meta.snapshot) console.log(`  snapshot ${meta.snapshot.id} as of ${meta.snapshot.as_of}`);

  console.log("sections");
  for (const id of meta.sections) {
    const body = await get(`/api/analytics/sections/${id}`);
    const payloadKeys = Object.keys(body).filter(
      (k) => !["source", "meta", "snapshot"].includes(k),
    );
    check(`${id} returns a payload`, payloadKeys.length > 0, JSON.stringify(Object.keys(body)));
  }

  console.log("cohort filter");
  const COHORT_SECTIONS = [
    ["conditions", "s2_conditions", (x) => x.prevalence.find((r) => r.key === "diabetes").patients],
    [
      "biomarkers",
      "s4_biomarkers",
      (x) => x.control.find((r) => r.marker === "hba1c").patients_current,
    ],
    ["treatment", "s5_treatment", (x) => x.landscape.classes[0].patients_ever],
  ];
  for (const [id, key, measure] of COHORT_SECTIONS) {
    const all = await get(`/api/analytics/sections/${id}`);
    const options = all[key].cohort_options;
    check(`${id} offers cohort options`, Array.isArray(options) && options.length > 0);
    check(`${id} defaults to the whole panel`, all[key].cohort === "all");
    for (const opt of options || []) {
      const body = await get(`/api/analytics/sections/${id}?cohort=${opt.key}`);
      const section = body[key];
      check(`${id}?cohort=${opt.key} echoes the cohort`, section.cohort === opt.key);
      check(
        `${id}?cohort=${opt.key} narrows the population`,
        measure(section) <= measure(all[key]),
        `${measure(section)} vs ${measure(all[key])}`,
      );
      check(
        `${id}?cohort=${opt.key} withholds the other cohorts`,
        !JSON.stringify(section).includes('"cohorts"'),
      );
      if (key === "s4_biomarkers") {
        check(
          `${id}?cohort=${opt.key} keeps band labels on the filtered rows`,
          section.control.every((r) => r.at_goal_pct == null || r.bands?.compact),
          section.control.find((r) => r.at_goal_pct != null && !r.bands)?.marker,
        );
        check(
          `${id}?cohort=${opt.key} scopes goal attainment to the cohort`,
          section.goal_attainment.engaged_patients <= all[key].goal_attainment.engaged_patients,
          `${section.goal_attainment.engaged_patients} vs ${all[key].goal_attainment.engaged_patients}`,
        );
      }
    }
    const bogus = await get(`/api/analytics/sections/${id}?cohort=nope`);
    check(`${id} falls back to the whole panel on an unknown cohort`, bogus[key].cohort === "all");
  }

  console.log("denominators");
  const bio = await get("/api/analytics/sections/biomarkers");
  const cascade = bio.s4_biomarkers.cascade;
  check("cascade has 4 steps", cascade.steps.length === 4);
  check(
    "cascade steps are monotonically non-increasing",
    cascade.steps.every((s, i) => i === 0 || s.patients <= cascade.steps[i - 1].patients),
    cascade.steps.map((s) => s.patients).join(" -> "),
  );
  check("cascade denominator is positive", cascade.denominator > 0);

  const drugs = await get("/api/analytics/sections/drug-outcomes");
  const outcomes = drugs.s6_drug_outcomes.outcomes;
  check("drug outcomes present", outcomes.length > 0);
  check(
    "every outcome row states a paired n",
    outcomes.every((r) => Number.isFinite(r.paired_n)),
  );
  check(
    "paired n never exceeds cohort size",
    outcomes.every((r) => r.paired_n <= r.cohort_size),
  );

  console.log("privacy");
  const work = await get("/api/analytics/sections/worklists");
  const serialized = JSON.stringify(work.s8_worklists);
  check("worklists carry no name field", !/"name"\s*:/.test(serialized));
  check("worklists carry no phone field", !/"phone"\s*:/.test(serialized));
  check(
    "worklists identify patients by id",
    work.s8_worklists.lapsed_uncontrolled_diabetics.every((r) => r.patient_id != null),
  );

  console.log("unknown section");
  const bad = await fetch(`http://127.0.0.1:${port}/api/analytics/sections/nope`, {
    headers: { "x-test-session": JSON.stringify(session) },
  });
  check("unknown section returns 404", bad.status === 404, `got ${bad.status}`);

  console.log("exports");
  const xlsx = await get("/api/analytics/export.xlsx", { raw: true });
  check(
    "xlsx is a real zip archive",
    xlsx[0] === 0x50 && xlsx[1] === 0x4b,
    `magic ${xlsx[0]},${xlsx[1]}`,
  );
  check("xlsx is non-trivial in size", xlsx.length > 20000, `${xlsx.length} bytes`);

  const html = await get("/api/analytics/export.html", { raw: true });
  const htmlText = html.toString("utf8");
  check("html export renders the report", htmlText.includes("Gini clinical outcomes report"));
  check(
    "html export references no external resources",
    !/https?:\/\/|<script\s+src|@import/.test(htmlText),
  );

  console.log(failures.length ? `\nFAILED (${failures.length}): ${failures.join(", ")}` : "\nOK");
  if (failures.length) process.exitCode = 1;
} catch (e) {
  console.error("FAILED:", e.message || e);
  process.exitCode = 1;
} finally {
  server.close();
  await pool.end();
}
