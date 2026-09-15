// Demo patients for X-Ray Station (docs/gini-flow/46-XRAY-STATION-PLAN.md).
//
// Same shape as seed-echo-demo.mjs, plus one patient carrying both an X-ray
// and an Echo order so the new "Echo waits on X-ray" gate
// (assertReadyToStart in machineStation.js) can be exercised from the
// browser, not just the smoke check.
//
// ⚠️ `DATABASE_URL` is production. Everything written here is prefixed ZZXR_
// and nothing else is touched, so `--clean` removes exactly what `--seed` made.
//
//   npm run seed:xray          (from server/)
//   npm run seed:xray -- --clean
import "../loadEnv.js";
import pool from "../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";

const FILE_PREFIX = "ZZXR_";
const clean = process.argv.includes("--clean");
let removedFiles = 0;

const ago = (minutes) => new Date(Date.now() - minutes * 60_000);

const PEOPLE = [
  {
    key: "waiting",
    name: "Demo Xray Waiting",
    age: 55,
    sex: "Female",
    status: "vitals_done",
    stage: "paid",
    minutes: 20,
  },
  {
    key: "unpaid",
    name: "Demo Xray Unpaid",
    age: 62,
    sex: "Male",
    status: "vitals_done",
    stage: "paid",
    payment: "pending",
    minutes: 9,
  },
  {
    key: "in_room",
    name: "Demo Xray In A Room",
    age: 47,
    sex: "Female",
    status: "with_doctor",
    stage: "paid",
    minutes: 25,
  },
  {
    key: "gone",
    name: "Demo Xray Left The Floor",
    age: 68,
    sex: "Male",
    status: "exited",
    stage: "paid",
    minutes: 90,
  },
  // No pre-seeded "in_progress" patient — same reasoning as the Echo seeder:
  // one machine, and P2 would block every other Start button.
  {
    key: "waiting2",
    name: "Demo Xray Waiting Two",
    age: 59,
    sex: "Female",
    status: "vitals_done",
    stage: "paid",
    minutes: 13,
  },
  {
    key: "done_empty",
    name: "Demo Xray Done No Report",
    age: 64,
    sex: "Male",
    status: "ready_for_doctor",
    stage: "done",
    minutes: 30,
  },
  {
    key: "reported",
    name: "Demo Xray Reported",
    age: 57,
    sex: "Male",
    status: "with_doctor",
    stage: "reported",
    minutes: 100,
  },
];

// This one carries TWO open machine orders — X-ray and Echo — so opening it
// from Echo Station shows the new gate refuse the start, and opening it from
// X-Ray Station shows the X-ray itself starts freely (the rule is
// one-directional: Echo waits on X-ray, never the other way).
const BLOCKS_ECHO = {
  key: "blocks_echo",
  name: "Demo Xray Blocks Echo",
  age: 51,
  sex: "Male",
  status: "vitals_done",
  minutes: 16,
};

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
      `Removed ${ids.length} demo patients, their X-ray/Echo tests and ${removedFiles} report${
        removedFiles === 1 ? "" : "s"
      }.`,
    );
  } else {
    const { rows: docs } = await client.query(
      `SELECT id FROM doctors WHERE COALESCE(is_active, TRUE) ORDER BY id LIMIT 1`,
    );
    const orderedBy = docs[0]?.id ?? null;

    const addOrder = async (
      visitId,
      testName,
      price,
      { payment = "paid", stage = "paid", minutes },
    ) => {
      const { rows: order } = await client.query(
        `INSERT INTO giniflow_lab_orders
           (visit_id, ordered_by, urgency, payment_status, amount_total, amount_paid,
            sample_status, kind, created_at, updated_at)
         VALUES ($1, $2, 'today', $3, $4, $5, $6, 'machine', $7, $7)
         RETURNING id`,
        [visitId, orderedBy, payment, price, payment === "paid" ? price : 0, stage, ago(minutes)],
      );
      const orderId = order[0].id;
      await client.query(
        `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
        [orderId, testName, price],
      );
      const passed = ["in_progress", "done", "reported"].slice(
        0,
        ["in_progress", "done", "reported"].indexOf(stage) + 1,
      );
      if (passed.length) {
        await client.query(
          `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, occurred_at)
           SELECT $1, 'sample', * FROM UNNEST($2::text[], $3::text[], $4::timestamptz[])`,
          [
            orderId,
            passed,
            passed.map(() => "machine"),
            passed.map((_, k) => ago(minutes - k * 4)),
          ],
        );
      }
      return orderId;
    };

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
      // reads a real vitals event, not the visit's current_status.
      await client.query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
         VALUES ($1, 'vitals_done', 'vitals', $2)`,
        [visit[0].id, ago(person.minutes + 5)],
      );

      const orderId = await addOrder(visit[0].id, "X-Ray", 500, {
        payment: person.payment,
        stage: person.stage,
        minutes: person.minutes,
      });

      if (person.values) {
        for (const [name, value] of person.values) {
          await client.query(
            `INSERT INTO lab_results (patient_id, test_name, test_date, result, lab_order_id, source)
             VALUES ($1, $2, CURRENT_DATE, $3, $4, 'manual')`,
            [patientId, name, value, orderId],
          );
        }
      }
    }

    // The "blocks Echo" demo patient — X-ray and Echo both open, both paid.
    {
      const p = BLOCKS_ECHO;
      const fileNo = `${FILE_PREFIX}${String(PEOPLE.length + 1).padStart(3, "0")}`;
      const { rows: pat } = await client.query(
        `INSERT INTO patients (name, file_no, age, sex) VALUES ($1, $2, $3, $4) RETURNING id`,
        [p.name, fileNo, p.age, p.sex],
      );
      const patientId = pat[0].id;
      const { rows: visit } = await client.query(
        `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
         VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, $2, 'none')
         RETURNING id`,
        [patientId, p.status],
      );
      await client.query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
         VALUES ($1, 'vitals_done', 'vitals', $2)`,
        [visit[0].id, ago(p.minutes + 5)],
      );
      await addOrder(visit[0].id, "X-Ray", 500, { minutes: p.minutes });
      await addOrder(visit[0].id, "2D Echo", 2200, { minutes: p.minutes });
    }

    await client.query("COMMIT");
    console.log(
      `Seeded ${PEOPLE.length + 1} demo patients for X-Ray Station today (one of them also carries an open Echo order to test the "Echo waits on X-ray" gate).`,
    );
    console.log(`  X-Ray Station  http://localhost:3000/giniflow/station/xray`);
    console.log(`  Echo Station   http://localhost:3000/giniflow/station/echo`);
    console.log(`\nRemove them with:  npm run seed:xray -- --clean`);
  }
} catch (e) {
  await client.query("ROLLBACK");
  console.error(e);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
