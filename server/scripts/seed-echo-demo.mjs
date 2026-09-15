// Demo patients for Echo Station (docs/gini-flow/45-ECHO-STATION-PLAN.md).
//
// Same shape as seed-machine-room-demo.mjs, narrowed to one machine: waiting,
// unpaid, in another room, gone home, the machine already busy with someone
// queued behind it, done with nothing to show, done with a value typed, and
// reported.
//
// ⚠️ `DATABASE_URL` is production. Everything written here is prefixed ZZEC_
// and nothing else is touched, so `--clean` removes exactly what `--seed` made.
//
//   npm run seed:echo          (from server/)
//   npm run seed:echo -- --clean
import "../loadEnv.js";
import pool from "../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";

const FILE_PREFIX = "ZZEC_";
const TEST_NAME = "2D Echo";
const clean = process.argv.includes("--clean");
let removedFiles = 0;

const ago = (minutes) => new Date(Date.now() - minutes * 60_000);

const PEOPLE = [
  {
    key: "waiting",
    name: "Demo Echo Waiting",
    age: 57,
    sex: "Female",
    status: "vitals_done",
    stage: "paid",
    minutes: 22,
  },
  {
    key: "unpaid",
    name: "Demo Echo Unpaid",
    age: 63,
    sex: "Male",
    status: "vitals_done",
    stage: "paid",
    payment: "pending",
    minutes: 10,
  },
  {
    key: "in_room",
    name: "Demo Echo In A Room",
    age: 45,
    sex: "Female",
    status: "with_doctor",
    stage: "paid",
    minutes: 28,
  },
  {
    key: "gone",
    name: "Demo Echo Left The Floor",
    age: 70,
    sex: "Male",
    status: "exited",
    stage: "paid",
    minutes: 95,
  },
  // No pre-seeded "in_progress" patient: Echo is one machine, and P2 (one
  // patient on it at a time) would then block every other waiting patient's
  // Start button — leaving nothing callable, which defeats a demo seed. Start
  // this one from the screen instead to see the others go "busy" behind it.
  {
    key: "waiting2",
    name: "Demo Echo Waiting Two",
    age: 61,
    sex: "Female",
    status: "vitals_done",
    stage: "paid",
    minutes: 14,
  },
  {
    key: "done_empty",
    name: "Demo Echo Done No Report",
    age: 66,
    sex: "Male",
    status: "ready_for_doctor",
    stage: "done",
    minutes: 33,
  },
  {
    key: "done_valued",
    name: "Demo Echo Done With Value",
    age: 48,
    sex: "Female",
    status: "ready_for_doctor",
    stage: "done",
    minutes: 26,
    values: [["Ejection Fraction", 58]],
  },
  {
    key: "reported",
    name: "Demo Echo Reported",
    age: 59,
    sex: "Male",
    status: "with_doctor",
    stage: "reported",
    minutes: 110,
    values: [["Ejection Fraction", 55]],
  },
];

const client = await pool.connect();
try {
  await client.query("BEGIN");

  const { rows: existing } = await client.query(
    `SELECT id FROM patients WHERE file_no LIKE $1 || '%'`,
    [FILE_PREFIX],
  );
  const ids = existing.map((r) => r.id);

  if (ids.length) {
    const { rows: docs } = await client.query(
      `SELECT storage_path FROM documents
        WHERE patient_id = ANY($1::int[]) AND storage_path IS NOT NULL`,
      [ids],
    );
    for (const d of docs) {
      await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${d.storage_path}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      }).catch(() => {});
    }
    removedFiles = docs.length;
    await client.query(`DELETE FROM documents WHERE patient_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM lab_results WHERE patient_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM giniflow_visits WHERE patient_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
  }

  if (clean) {
    await client.query("COMMIT");
    console.log(
      `Removed ${ids.length} demo patients, their Echo tests and ${removedFiles} report${
        removedFiles === 1 ? "" : "s"
      }.`,
    );
  } else {
    const { rows: docs } = await client.query(
      `SELECT id FROM doctors WHERE COALESCE(is_active, TRUE) ORDER BY id LIMIT 1`,
    );
    const orderedBy = docs[0]?.id ?? null;

    for (const [i, person] of PEOPLE.entries()) {
      const fileNo = `${FILE_PREFIX}${String(i + 1).padStart(3, "0")}`;
      const { rows: pat } = await client.query(
        `INSERT INTO patients (name, file_no, age, sex) VALUES ($1, $2, $3, $4) RETURNING id`,
        [person.name, fileNo, person.age, person.sex],
      );
      const patientId = pat[0].id;

      const { rows: visit } = await client.query(
        `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
         VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, $2, 'none')
         RETURNING id`,
        [patientId, person.status],
      );

      // The station's vitals-before-machine gate (39-HYBRID-FLOOR-PLAN.md §3)
      // reads a real vitals event, not the visit's current_status — a demo
      // patient dropped straight into "vitals_done" without one is blocked at
      // the machine exactly like a real patient whose vitals were never taken.
      await client.query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
         VALUES ($1, 'vitals_done', 'vitals', $2)`,
        [visit[0].id, ago(person.minutes + 5)],
      );

      const payment = person.payment || "paid";
      const { rows: order } = await client.query(
        `INSERT INTO giniflow_lab_orders
           (visit_id, ordered_by, urgency, payment_status, amount_total, amount_paid,
            sample_status, kind, created_at, updated_at)
         VALUES ($1, $2, 'today', $3, 2200, $4, $5, 'machine', $6, $6)
         RETURNING id`,
        [
          visit[0].id,
          orderedBy,
          payment,
          payment === "paid" ? 2200 : 0,
          person.stage,
          ago(person.minutes),
        ],
      );
      const orderId = order[0].id;

      await client.query(
        `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
         VALUES ($1, $2, 2200)`,
        [orderId, TEST_NAME],
      );

      const passed = ["in_progress", "done", "reported"].slice(
        0,
        ["in_progress", "done", "reported"].indexOf(person.stage) + 1,
      );
      if (passed.length) {
        await client.query(
          `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, occurred_at)
           SELECT $1, 'sample', * FROM UNNEST($2::text[], $3::text[], $4::timestamptz[])`,
          [
            orderId,
            passed,
            passed.map(() => "machine"),
            passed.map((_, k) => ago(person.minutes - k * 4)),
          ],
        );
      }

      for (const [name, value] of person.values || []) {
        await client.query(
          `INSERT INTO lab_results (patient_id, test_name, test_date, result, lab_order_id, source)
           VALUES ($1, $2, CURRENT_DATE, $3, $4, 'manual')`,
          [patientId, name, value, orderId],
        );
      }
    }

    await client.query("COMMIT");
    console.log(`Seeded ${PEOPLE.length} demo patients for Echo Station today.`);
    console.log(`  Echo Station  http://localhost:3000/giniflow/station/echo`);
    console.log(`\nRemove them with:  npm run seed:echo -- --clean`);
  }
} catch (e) {
  await client.query("ROLLBACK");
  console.error(e);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
