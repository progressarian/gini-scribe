// Demo patients for the machine room
// (docs/gini-flow/36-MACHINE-TEST-STATION-PLAN.md).
//
// One patient per rung, at least one per machine, plus every case the rules have
// to handle: an unpaid test, a patient another station is holding, a patient who
// has gone home, a machine already busy, a finished test with nothing to file and
// one with a value typed, and a test name that matches no machine at all.
//
// ⚠️ `DATABASE_URL` is production. Everything written here is prefixed ZZMR_ and
// nothing else is touched, so `--clean` removes exactly what `--seed` made —
// including the chart rows and stored files a test upload leaves behind, which
// the first lab seeder forgot and which then blocked its own cleanup.
//
// Deliberately NOT flagged `is_demo`: nothing reads that column except
// `cleanDemoDay`, which deletes every visit carrying it regardless of who wrote
// it — and that cost a whole seeded set the first time a smoke script ran.
//
//   npm run seed:machine-room          (from server/)
//   npm run seed:machine-room -- --clean
import "../loadEnv.js";
import pool from "../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";

const FILE_PREFIX = "ZZMR_";
const clean = process.argv.includes("--clean");
let removedFiles = 0;

const ago = (minutes) => new Date(Date.now() - minutes * 60_000);

// `status` is where the PATIENT is standing, which is a separate question from
// where the test is — and the machine room needs both, because the patient is
// the sample here.
const PEOPLE = [
  // ── Waiting, and workable ────────────────────────────────────────────────
  {
    key: "abi_wait",
    name: "Demo ABI Waiting",
    age: 58,
    sex: "Female",
    test: "ABI",
    status: "vitals_done",
    stage: "paid",
    minutes: 25,
  },
  {
    key: "vpt_wait",
    name: "Demo VPT Waiting",
    age: 64,
    sex: "Male",
    test: "VPT",
    status: "vitals_done",
    stage: "paid",
    minutes: 18,
  },
  {
    key: "fundus_wait",
    name: "Demo Fundus Waiting",
    age: 51,
    sex: "Female",
    test: "Fundus",
    status: "sd_pending",
    stage: "paid",
    minutes: 40,
  },

  // ── The three things that stop a test starting ───────────────────────────
  {
    key: "unpaid",
    name: "Demo Unpaid",
    age: 47,
    sex: "Male",
    test: "TMT",
    status: "vitals_done",
    stage: "paid",
    payment: "pending",
    minutes: 12,
  },
  {
    key: "in_room",
    name: "Demo In A Room",
    age: 39,
    sex: "Female",
    test: "ECG",
    status: "with_doctor",
    stage: "paid",
    minutes: 30,
  },
  {
    key: "gone",
    name: "Demo Left The Floor",
    age: 71,
    sex: "Male",
    test: "VPT",
    status: "exited",
    stage: "paid",
    minutes: 90,
  },

  // ── The machine that is busy, and the patient queued behind it ───────────
  {
    key: "abi_running",
    name: "Demo ABI Running",
    age: 55,
    sex: "Male",
    test: "ABI",
    status: "sd_pending",
    stage: "in_progress",
    minutes: 6,
  },
  {
    key: "abi_queued",
    name: "Demo ABI Queued",
    age: 62,
    sex: "Female",
    test: "ABI",
    status: "vitals_done",
    stage: "paid",
    minutes: 15,
  },

  // ── Finished, with and without something to show ─────────────────────────
  {
    key: "done_empty",
    name: "Demo Done No Report",
    age: 68,
    sex: "Male",
    test: "TMT",
    status: "ready_for_doctor",
    stage: "done",
    minutes: 35,
  },
  {
    key: "done_valued",
    name: "Demo Done With Value",
    age: 44,
    sex: "Female",
    test: "VPT",
    status: "ready_for_doctor",
    stage: "done",
    minutes: 28,
    values: [
      ["VPT Right", 12],
      ["VPT Left", 14],
    ],
  },

  // ── Closed ───────────────────────────────────────────────────────────────
  {
    key: "reported",
    name: "Demo Reported",
    age: 60,
    sex: "Male",
    test: "ECG",
    status: "with_doctor",
    stage: "reported",
    minutes: 120,
    values: [["ECG", 1]],
  },

  // ── Ordered as a machine test, but nothing matches a machine ─────────────
  {
    key: "unmatched",
    name: "Demo Unmatched Test",
    age: 49,
    sex: "Female",
    test: "Holter Monitor",
    status: "vitals_done",
    stage: "paid",
    minutes: 20,
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

  // Always clean first, so seeding twice cannot leave two of anybody and the
  // clean path is exercised on every run.
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
    // Orders and their tests cascade from the visit.
    await client.query(`DELETE FROM giniflow_visits WHERE patient_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
  }

  if (clean) {
    await client.query("COMMIT");
    console.log(
      `Removed ${ids.length} demo patients, their machine tests and ${removedFiles} report${
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

      const payment = person.payment || "paid";
      const { rows: order } = await client.query(
        `INSERT INTO giniflow_lab_orders
           (visit_id, ordered_by, urgency, payment_status, amount_total, amount_paid,
            sample_status, kind, created_at, updated_at)
         VALUES ($1, $2, 'today', $3, 600, $4, $5, 'machine', $6, $6)
         RETURNING id`,
        [
          visit[0].id,
          orderedBy,
          payment,
          payment === "paid" ? 600 : 0,
          person.stage,
          ago(person.minutes),
        ],
      );
      const orderId = order[0].id;

      await client.query(
        `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
         VALUES ($1, $2, 600)`,
        [orderId, person.test],
      );

      // One event per rung already passed, so the card's timer reads from the
      // last thing that actually happened rather than from the order's creation.
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
    console.log(`Seeded ${PEOPLE.length} demo patients for the machine room today.`);
    console.log(`  Machine room  http://localhost:3000/giniflow/station/machine`);
    console.log(`\nRemove them with:  npm run seed:machine-room -- --clean`);
  }
} catch (e) {
  await client.query("ROLLBACK");
  console.error(e);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
