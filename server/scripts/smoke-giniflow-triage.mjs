// Triage board: the future-day build, the engine's five branches, the
// coordinator override, the pipeline counts and the MO's close rule.
//
// docs/gini-flow/18-TRIAGE-BOARD-PLAN.md §11.
//
// It seeds its own patients and appointments on a day of its own — never
// today's real list — and removes every row it wrote, including the
// appointments (which the shared demo cleaner does not touch, so this script
// keeps its own file-number prefix rather than borrowing that one).
//
//   npm run smoke:giniflow-triage   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import {
  getTriageDay,
  categoriseHba1c,
  categorise,
  assign,
  autoCategoriseDay,
  getAssignableStaff,
} from "../services/giniflow/triage.js";
import { CLOSEABLE_CATEGORY } from "../services/giniflow/moStation.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const PREFIX = "ZZTRIAGE_";
// Far enough in the future that no real appointment or sync can share it.
const TEST_DAY = "2031-04-17";
const PREV_DAY = "2031-01-17";

// [key, current HbA1c, previous HbA1c, expected category, other biomarkers]
const PEOPLE = [
  ["crisis", 11.4, 8.9, "worse_out_of_range", { fg: 190, ldl: 158, tg: 227, uacr: 40, egfr: 88 }],
  ["jump", 8.4, 6.6, "worse_out_of_range", { fg: 150 }],
  ["rising", 7.9, 7.2, "worse_in_range", { fg: 140, ldl: 96 }],
  ["improving", 8.1, 9.4, "getting_better", { fg: 130, ldl: 88, tg: 140, uacr: 12, egfr: 95 }],
  ["controlled", 6.4, 6.5, "in_control", { fg: 98, ldl: 82, tg: 120, uacr: 8, egfr: 101 }],
  ["blank", null, null, "no_reports", {}],
];

const biomarkersFor = (hba1c, extra) => (hba1c === null ? extra : { hba1c, ...extra });

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = {};
    for (const [i, [key, cur, prev, , extra]] of PEOPLE.entries()) {
      const fileNo = `${PREFIX}${String(i + 1).padStart(3, "0")}`;
      const { rows } = await client.query(
        `INSERT INTO patients (name, file_no, age, sex)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (file_no) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [`Triage Test ${key}`, fileNo, 44 + i, i % 2 ? "Female" : "Male"],
      );
      const patientId = rows[0].id;
      ids[key] = { patientId, fileNo };

      // The previous visit, which is where "rising" and "improving" come from.
      if (prev !== null) {
        await client.query(
          `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status, biomarkers)
           VALUES ($1, $2, $3, $4::date, 'completed', $5::jsonb)`,
          [patientId, `Triage Test ${key}`, fileNo, PREV_DAY, JSON.stringify({ hba1c: prev })],
        );
      }

      const { rows: appt } = await client.query(
        `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status,
                                   time_slot, call_status, biomarkers)
         VALUES ($1, $2, $3, $4::date, 'scheduled', $5, $6, $7::jsonb)
         RETURNING id`,
        [
          patientId,
          `Triage Test ${key}`,
          fileNo,
          TEST_DAY,
          `${9 + i}:00 AM`,
          key === "rising" ? "rescheduled" : "called",
          JSON.stringify(biomarkersFor(cur, extra)),
        ],
      );
      ids[key].appointmentId = appt[0].id;
    }
    await client.query("COMMIT");
    return ids;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function clean() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT id FROM patients WHERE file_no LIKE $1 || '%'`, [
      PREFIX,
    ]);
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await client.query(
        `DELETE FROM giniflow_visit_events e USING giniflow_visits v
          WHERE e.visit_id = v.id AND v.patient_id = ANY($1::int[])`,
        [ids],
      );
      await client.query(`DELETE FROM giniflow_visits WHERE patient_id = ANY($1::int[])`, [ids]);
      await client.query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [ids]);
      await client.query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
    }
    await client.query("COMMIT");
    return ids.length;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── The engine, on its own, before any database is involved ─────────────────
console.log("\nEngine (§5)");
check("HbA1c over 9 is out of range", categoriseHba1c(9.6, 9.4) === "worse_out_of_range");
check(
  "a rise of more than 1.5 is out of range even inside the band",
  categoriseHba1c(8.4, 6.6) === "worse_out_of_range",
  categoriseHba1c(8.4, 6.6),
);
check("7–9 and rising is worse-in-range", categoriseHba1c(7.9, 7.2) === "worse_in_range");
check("improving but above goal is getting better", categoriseHba1c(8.1, 9.4) === "getting_better");
check("at goal and steady is in control", categoriseHba1c(6.4, 6.5) === "in_control");
check("no HbA1c at all is no_reports", categoriseHba1c(null, 7.2) === "no_reports");
check("a first reading at goal is in control", categoriseHba1c(6.2, null) === "in_control");
check(
  "a first reading above goal never lands in the closeable column",
  categoriseHba1c(8.2, null) !== "in_control",
  categoriseHba1c(8.2, null),
);
check(
  "movement inside the noise floor is not a rise",
  categoriseHba1c(6.6, 6.5) === "in_control",
  categoriseHba1c(6.6, 6.5),
);

// ── The day ─────────────────────────────────────────────────────────────────
await clean();
await seed();

console.log("\nBuilding a future day (§3.2b)");
const before = await pool.query(
  `SELECT COUNT(*)::int AS n FROM giniflow_visits WHERE visit_date = $1::date`,
  [TEST_DAY],
);
check("the day has no visit rows before the board opens", before.rows[0].n === 0, before.rows[0].n);

await getTriageDay(TEST_DAY);
const after = await pool.query(
  `SELECT COUNT(*)::int AS n FROM giniflow_visits WHERE visit_date = $1::date`,
  [TEST_DAY],
);
check(
  "opening the board builds exactly one visit per appointment",
  after.rows[0].n === PEOPLE.length,
  `${after.rows[0].n} of ${PEOPLE.length}`,
);

const again = await getTriageDay(TEST_DAY);
const twice = await pool.query(
  `SELECT COUNT(*)::int AS n FROM giniflow_visits WHERE visit_date = $1::date`,
  [TEST_DAY],
);
check("re-opening it creates nothing new", twice.rows[0].n === after.rows[0].n);

// A visit built ahead of time sits at `booked`, which OFF_BOARD_STATUSES hides
// from the floor: triaging tomorrow must not put anyone on today's board.
const early = await pool.query(
  `SELECT COUNT(*) FILTER (WHERE current_status <> 'booked')::int AS moved
     FROM giniflow_visits WHERE visit_date = $1::date`,
  [TEST_DAY],
);
check(
  "a pre-built visit stays off the floor — every one is still booked",
  early.rows[0].moved === 0,
  `${early.rows[0].moved} moved`,
);

const cardsOf = (result) => [...result.columns.flatMap((c) => c.cards), ...result.uncategorised];
const byName = (result) =>
  Object.fromEntries(cardsOf(result).map((c) => [c.name.split(" ").pop(), c]));

let cards = byName(again);

console.log("\nCategorisation");
for (const [key, , , expected] of PEOPLE) {
  check(`${key} lands in ${expected}`, cards[key]?.category === expected, cards[key]?.category);
}
check(
  "nobody is left uncategorised",
  again.uncategorised.length === 0,
  `${again.uncategorised.length}`,
);
check(
  "the no-reports column holds exactly the patients with no HbA1c",
  again.columns
    .find((c) => c.key === "no_reports")
    .cards.every((c) => !c.bios.some((b) => b.key === "hba1c")),
);

console.log("\nThe card (§4.3)");
const rich = cards.crisis;
check(
  "bio chips carry previous → current",
  rich.bios.some((b) => b.previous !== null),
);
check("an out-of-range chip is red", rich.bios.find((b) => b.key === "hba1c")?.tone === "r");
check(
  "all five required tests present reads as complete",
  rich.report.state === "ok",
  rich.report.state,
);
check("a patient with nothing reads as missing", cards.blank.report.state === "missing");
check(
  "a partial report names what is missing",
  cards.jump.report.state === "partial" && cards.jump.report.missing.length > 0,
  cards.jump.report.missing?.join(", "),
);
check(
  "a rescheduled patient is NOT shown as confirmed",
  cards.rising.confirmation?.tone === "danger",
  cards.rising.confirmation?.text,
);
check("a called patient is confirmed", cards.crisis.confirmation?.tone === "confirmed");
check(
  "nobody has arrived yet, so nobody shows a checked-in pill",
  cardsOf(again).every((c) => !c.arrived && c.confirmation),
);

console.log("\nPipeline (§4.1)");
check(
  "total counts the whole day",
  again.pipeline.total === PEOPLE.length,
  `${again.pipeline.total}`,
);
check(
  "every step counts a subset of the day",
  Object.entries(again.pipeline).every(([, n]) => n <= again.pipeline.total),
);
check(
  "categorised counts everyone once the engine has run",
  again.pipeline.categorised === PEOPLE.length,
  `${again.pipeline.categorised}`,
);
check("nobody is assigned yet", again.pipeline.assigned === 0, `${again.pipeline.assigned}`);
const filtered = await getTriageDay(TEST_DAY, { filter: "data_complete" });
check(
  "a pipeline step filters to exactly the patients it counts",
  cardsOf(filtered).length === again.pipeline.data_complete,
  `${cardsOf(filtered).length} vs ${again.pipeline.data_complete}`,
);

console.log("\nOverride (§5.3)");
const target = cards.controlled;
await categorise(target.visitId, "worse_out_of_range", null);
let overridden = byName(await getTriageDay(TEST_DAY));
check(
  "the coordinator's category is stored",
  overridden.controlled.category === "worse_out_of_range",
  overridden.controlled.category,
);
check("and is stamped as theirs", overridden.controlled.categorySource === "coordinator");

const sweep = await autoCategoriseDay(TEST_DAY);
overridden = byName(await getTriageDay(TEST_DAY, { ensure: false }));
check(
  "a re-run of the engine does not overwrite it",
  overridden.controlled.category === "worse_out_of_range",
  overridden.controlled.category,
);
check("and the sweep reports it skipped nothing else", sweep.updated === 0, `${sweep.updated}`);

await categorise(target.visitId, null, null);
const reset = byName(await getTriageDay(TEST_DAY, { ensure: false }));
// The reset clears the coordinator's stamp and re-runs the engine, which then
// writes its own answer back — so the row ends up 'auto', not sourceless. That
// IS the restoration: the engine owns the row again.
check(
  "handing it back to auto restores the engine's answer",
  reset.controlled.category === "in_control" && reset.controlled.categorySource === "auto",
  `${reset.controlled.category} / ${reset.controlled.categorySource}`,
);

console.log("\nAssignment (§7)");
const staff = await getAssignableStaff(TEST_DAY);
check("there is somebody to assign to", staff.length > 0, `${staff.length}`);
if (staff.length) {
  const before = await pool.query(
    `SELECT COUNT(*)::int AS n FROM giniflow_visit_events WHERE visit_id = $1`,
    [target.visitId],
  );
  await assign(target.visitId, { sdId: staff[0].id }, null);
  const afterAssign = await getTriageDay(TEST_DAY, { ensure: false });
  const assigned = byName(afterAssign);
  check("the SD is on the card", assigned.controlled.assignment.sdId === staff[0].id);
  check(
    "the pipeline counts them as assigned",
    afterAssign.pipeline.assigned === 1,
    `${afterAssign.pipeline.assigned}`,
  );
  const afterEvents = await pool.query(
    `SELECT COUNT(*)::int AS n FROM giniflow_visit_events WHERE visit_id = $1`,
    [target.visitId],
  );
  // A category or an assignment is a property of the visit, not a journey step:
  // logging one would restart the patient's station timer (10-QUEUE-CONTROL).
  check(
    "neither write logs a journey event",
    afterEvents.rows[0].n === before.rows[0].n,
    `${before.rows[0].n} → ${afterEvents.rows[0].n}`,
  );
}

console.log("\nThe point of it all");
const green = await pool.query(`SELECT category FROM giniflow_visits WHERE id = $1`, [
  reset.controlled.visitId,
]);
check(
  "a categorised green patient is closeable at the MO station",
  green.rows[0].category === CLOSEABLE_CATEGORY,
  green.rows[0].category,
);
check(
  "…which was impossible before, because nothing ever wrote the column",
  green.rows[0].category !== null,
);

const removed = await clean();
console.log(`\nCleaned up ${removed} test patients.`);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
await pool.end();
process.exit(failures ? 1 : 0);
