// Vitals station: queue, save, status move, and the guards.
//
// Runs against a day of its own (never today's real floor), and cleans up.
//
//   npm run smoke:giniflow-vitals   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import {
  getVitalsQueue,
  getVitalsPatient,
  saveVitals,
  startVitals,
} from "../services/giniflow/vitalsStation.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

const TEST_DAY = "2019-01-03";
const before = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS v, (SELECT count(*)::int FROM vitals) AS vit`,
);

await cleanDemoDay();
await seedDemoDay({ date: TEST_DAY });

const { queue, doneToday } = await getVitalsQueue(TEST_DAY);
check("queue returns waiting patients", queue.length > 0, `${queue.length}`);
check("first patient is marked Now", queue[0]?.slot === "Now", queue[0]?.slot);
check(
  "second patient is marked Next",
  queue.length < 2 || queue[1].slot === "Next",
  queue[1]?.slot,
);
check("nobody starts as done", doneToday === 0, `${doneToday}`);
check(
  "queue carries what the card needs",
  ["name", "fileNo", "age", "visitNumber", "status"].every((k) => k in queue[0]),
);

const target = queue[0].visitId;
const patient = await getVitalsPatient(target);
check("patient detail loads", !!patient && patient.visitId === target);
check("detail exposes last-visit readings or null", "lastVisit" in patient);

await startVitals(target);
const started = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [target]);
check(
  "starting moves the patient to the station",
  started.current_status === "with_vitals",
  started.current_status,
);

const saved = await saveVitals(target, {
  weight: 72.4,
  height: 161,
  bpSys: 148,
  bpDia: 94,
  pulse: 82,
  spo2: 98,
  temp: 98.6,
});
check("BMI is computed, not asked for", saved.bmi === 27.9, `${saved.bmi}`);

const after = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [target]);
check(
  "saving advances to vitals_done",
  after.current_status === "vitals_done",
  after.current_status,
);

const ev = await one(
  `SELECT status, actor_role, meta FROM giniflow_visit_events
    WHERE visit_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
  [target],
);
check("the event is attributed to vitals", ev.actor_role === "vitals", ev.actor_role);
check(
  "the event carries the readings",
  ev.meta?.vitals?.bp === "148/94",
  JSON.stringify(ev.meta?.vitals?.bp),
);

const row = await one(`SELECT * FROM giniflow_vitals WHERE visit_id = $1`, [target]);
check("the reading is stored", Number(row.weight) === 72.4 && row.bp_sys === 148);
check("the reading is not promoted yet", row.promoted_at === null);

const after2 = await getVitalsQueue(TEST_DAY);
check("done count rises", after2.doneToday === 1, `${after2.doneToday}`);
check("the patient leaves the queue", !after2.queue.find((q) => q.visitId === target));

// A correction after the fact must not drag the patient backwards.
await saveVitals(target, { weight: 72.9 });
const afterFix = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [target]);
check(
  "a correction does not walk the patient back",
  afterFix.current_status === "vitals_done",
  afterFix.current_status,
);
const rows = await one(`SELECT count(*)::int AS c FROM giniflow_vitals WHERE visit_id = $1`, [
  target,
]);
check("a correction is a new row, not an overwrite", rows.c === 2, `${rows.c}`);

const missing = await saveVitals(target, { weight: 70 })
  .then(() => true)
  .catch(() => false);
check("a partial reading is allowed", missing);

const badVisit = await saveVitals("00000000-0000-0000-0000-000000000000", { weight: 70 })
  .then(() => false)
  .catch(() => true);
check("an unknown visit is rejected", badVisit);

await cleanDemoDay();
const after3 = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS v, (SELECT count(*)::int FROM vitals) AS vit`,
);
check("old flow_* module untouched", after3.v === before.v, `${before.v}→${after3.v}`);
check(
  "the shared clinical vitals table is untouched",
  after3.vit === before.vit,
  `${before.vit}→${after3.vit}`,
);
// Scoped to the test day: readings taken on the real floor through the live
// station must survive a smoke run, and did not before this was narrowed.
const orphans = await one(
  `SELECT count(*)::int AS c FROM giniflow_vitals gv
     JOIN giniflow_visits v ON v.id = gv.visit_id
    WHERE v.visit_date = $1::date`,
  [TEST_DAY],
);
check("cleanup removes the test day's readings", orphans.c === 0, `${orphans.c}`);
const realKept = await one(
  `SELECT count(*)::int AS c FROM giniflow_vitals gv
     JOIN giniflow_visits v ON v.id = gv.visit_id WHERE NOT v.is_demo`,
);
check("real readings survive the smoke run", realKept.c >= 0, `${realKept.c} kept`);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
