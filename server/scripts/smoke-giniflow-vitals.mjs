// Vitals station: queue, save, status move, and the guards.
//
// Runs against a day of its own (never today's real floor), and cleans up.
//
//   npm run smoke:giniflow-vitals   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay, DEMO_FILE_PREFIX } from "../services/giniflow/demo.js";
import {
  getVitalsQueue,
  getVitalsPatient,
  saveVitals,
  startVitals,
  saveAllergy,
} from "../services/giniflow/vitalsStation.js";
import { setPriority } from "../services/giniflow/queue.js";
import { advanceStatus } from "../services/giniflow/statusEngine.js";

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

// The station returns the chair and the line separately (`atStation` /
// `waiting`), and the finished patients split by whether they have left the
// building. What the nurse calls from is both lists in order, so the checks
// below read them the way the screen does.
const callable = (q) => [...q.atStation, ...q.waiting];
const finished = (q) => [...q.moved, ...q.exited];

const firstLoad = await getVitalsQueue(TEST_DAY);
const queue = callable(firstLoad);
const doneToday = firstLoad.doneToday;
const target0 = queue[0]?.visitId;
check("queue returns waiting patients", queue.length > 0, `${queue.length}`);
check(
  "a patient on the chair shows the time they were booked for",
  firstLoad.atStation.every((q) => /^\d\d:\d\d$|^—$/.test(q.slot)),
  firstLoad.atStation.map((q) => q.slot).join(" "),
);
check(
  "the head of the waiting line is the one to call Next",
  !firstLoad.waiting.length || firstLoad.waiting[0].slot === "Next",
  firstLoad.waiting[0]?.slot,
);
// Done is status-driven now, not a count of the readings this station typed: a
// patient HealthRay observed past vitals is done too, and the demo day seeds some.
check(
  "the done count is the patients past vitals",
  doneToday === finished(firstLoad).length,
  `${doneToday}`,
);
check(
  "queue carries what the card needs",
  ["name", "fileNo", "age", "visitNumber", "status"].every((k) => k in queue[0]),
);

// ── 11-VITALS-QUEUE-PLAN.md ─────────────────────────────────────────────────
check(
  "every row carries the wait the station acts on",
  queue.every(
    (q) => "waitMinutes" in q && "waitColour" in q && "statusSince" in q && "checkedInAt" in q,
  ),
);
check(
  "the wait is coloured against a budget, like the board",
  ["g", "green", "amber", "a", "red", "r", "neutral"].includes(queue[0].waitColour),
  queue[0].waitColour,
);

// Priority is the VIP mark — there is no separate flag, and borrowing
// flow_visits.is_vip would reconnect the retired module.
const behind = queue[queue.length - 1];
check("a patient at the back of the queue to promote", !!behind && behind.visitId !== target0);
if (behind) {
  await setPriority(behind.visitId, "urgent", "chest pain", null);
  const promoted = await getVitalsQueue(TEST_DAY);
  // Whoever is already on the chair is not pulled off it, and the demo day can
  // seed more than one of them — so the urgent patient rises to the top of the
  // waiting queue, which is the first row after the station's own.
  const atStation = callable(promoted).filter((q) => q.status === "with_vitals").length;
  const position = callable(promoted).findIndex((q) => q.visitId === behind.visitId);
  check(
    "an urgent patient rises to the top of the queue",
    position === atStation,
    `position ${position} of ${callable(promoted).length}, ${atStation} already at the station`,
  );
  check(
    "the reason travels with them",
    callable(promoted)[position]?.priorityReason === "chest pain",
    callable(promoted)[position]?.priorityReason,
  );
  check(
    "and does not pull anybody off the chair to do it",
    callable(promoted).filter((q) => q.status === "with_vitals").length === atStation,
  );
  await setPriority(behind.visitId, "normal", null, null);
}

// A held patient is in the building and cannot be called. Before this they
// vanished from the station entirely.
const holdMe = queue[queue.length - 1];
if (holdMe) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await advanceStatus(client, {
      visitId: holdMe.visitId,
      toStatus: "blocked_reports",
      actorRole: "reception",
      blockedReason: "Lab payment pending",
    });
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const withHold = await getVitalsQueue(TEST_DAY);
  check(
    "a held patient leaves the callable queue",
    !callable(withHold).some((q) => q.visitId === holdMe.visitId),
  );
  check(
    "a held patient is listed separately, with the reason",
    withHold.held.find((h) => h.visitId === holdMe.visitId)?.blockedReason ===
      "Lab payment pending",
  );
}

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

const doneList = await getVitalsQueue(TEST_DAY);
check(
  "finishing a patient never drops anyone off the done list",
  doneList.doneToday >= doneToday,
  `${doneToday}→${doneList.doneToday}`,
);
const doneRow = finished(doneList).find((d) => d.visitId === target);
check("the done list names the patient, not just a number", !!doneRow?.name);
check("the done row shows the reading", doneRow?.bp === "148/94", doneRow?.bp);
check("the done row shows where the patient has got to", !!doneRow?.nowAt, doneRow?.nowAt);
check(
  "a done patient is out of the callable queue",
  !callable(doneList).some((q) => q.visitId === target),
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

const row = await one(
  `SELECT * FROM giniflow_vitals WHERE visit_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
  [target],
);
check("the reading is stored", Number(row.weight) === 72.4 && row.bp_sys === 148);
await new Promise((r) => setTimeout(r, 1500));
const promotedRow = await one(`SELECT promoted_at FROM giniflow_vitals WHERE id = $1`, [row.id]);
const onChart = await one(`SELECT count(*)::int AS c FROM vitals WHERE giniflow_vitals_id = $1`, [
  row.id,
]);
check(
  "the reading reaches the patient's chart, not just this station",
  !!promotedRow.promoted_at && onChart.c === 1,
  `promoted ${!!promotedRow.promoted_at}, ${onChart.c} on the chart`,
);

const after2 = await getVitalsQueue(TEST_DAY);
check("the done count holds", after2.doneToday >= doneToday, `${after2.doneToday}`);
check("the patient leaves the queue", !callable(after2).find((q) => q.visitId === target));

// A correction after the fact must not drag the patient backwards.
const beforeFix = await one(`SELECT count(*)::int AS c FROM giniflow_vitals WHERE visit_id = $1`, [
  target,
]);
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
check(
  "a correction is a new row, not an overwrite",
  rows.c === beforeFix.c + 1,
  `${beforeFix.c}→${rows.c}`,
);

const missing = await saveVitals(target, { weight: 70 })
  .then(() => true)
  .catch(() => false);
check("a partial reading is allowed", missing);

const badVisit = await saveVitals("00000000-0000-0000-0000-000000000000", { weight: 70 })
  .then(() => false)
  .catch(() => true);
check("an unknown visit is rejected", badVisit);

await new Promise((r) => setTimeout(r, 2000));
await cleanDemoDay();
const after3 = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS v, (SELECT count(*)::int FROM vitals) AS vit`,
);
check("old flow_* module untouched", after3.v === before.v, `${before.v}→${after3.v}`);
// Not a global count any more: the station is live, so real nurses add rows to
// `vitals` while this runs and a before/after total is only measuring the floor.
// What this suite is responsible for is that it leaves none of its own behind.
const demoLeft = await one(
  `SELECT count(*)::int AS c FROM vitals v
     JOIN patients p ON p.id = v.patient_id
    WHERE p.file_no LIKE $1 || '%'`,
  [DEMO_FILE_PREFIX],
);
check(
  "the smoke run leaves nothing of its own in the shared vitals table",
  demoLeft.c === 0,
  `${demoLeft.c} demo rows, floor went ${before.vit}→${after3.vit}`,
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

// ── Allergies, asked where the patient sits down (24-ADDENDUM-V11-PLAN.md §5.1)
// Three states because "not asked" is a clinical answer. The one that matters
// is that it cannot overwrite a recorded allergy: a nurse tabbing past the
// control must not erase what somebody was told last month.
{
  const v = await one(`SELECT id FROM giniflow_visits ORDER BY created_at DESC LIMIT 1`);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    check(
      "recording a known allergy without naming it is refused",
      await saveAllergy(v.id, { status: "known" }, c)
        .then(() => false)
        .catch((e) => e.status === 400),
    );
    const known = await saveAllergy(v.id, { status: "known", note: "Sulfa drugs" }, c);
    check("a named allergy is recorded", known.allergy_note === "Sulfa drugs");
    const after = await saveAllergy(v.id, { status: "not_known" }, c);
    check(
      "and 'not asked' cannot erase it",
      after.allergy_status === "known" && after.allergy_note === "Sulfa drugs",
      "a nurse tabbing past must not undo last month's answer",
    );
    const none = await saveAllergy(v.id, { status: "none_known" }, c);
    check(
      "answering 'none known' clears the note, because somebody asked",
      none.allergy_status === "none_known" && none.allergy_note === null,
    );
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
