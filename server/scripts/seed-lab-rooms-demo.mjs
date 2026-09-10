// Demo patients for the two lab rooms
// (docs/gini-flow/35-LAB-TWO-ROOM-SPLIT-PLAN.md).
//
// One patient per rung, on BOTH tracks — a Gini order raised on this floor and a
// HealthRay case arriving through the lab sync — plus the three edge cases the
// collection room has to handle: an unpaid order, a patient somebody else has in
// a room, and a patient who has gone home with their sample untaken.
//
// ⚠️ `DATABASE_URL` is production. Everything written here is prefixed
// ZZLAB_ / ZZLAB- and nothing else is touched, so `--clean` removes exactly what
// `--seed` made. Run the clean when you are done.
//
//   npm run seed:lab-rooms          (from server/)
//   npm run seed:lab-rooms -- --clean
import "../loadEnv.js";
import pool from "../config/db.js";
import { LAB_RUNGS } from "../../shared/labStages.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";

const FILE_PREFIX = "ZZLAB_";
const CASE_PREFIX = "ZZLAB-";
const clean = process.argv.includes("--clean");
let removedFiles = 0;

const ago = (minutes) => new Date(Date.now() - minutes * 60_000);
const iso = (minutes) => ago(minutes).toISOString();

// Each row is one person on the floor, and the point of them is the rung they
// are parked on. `status` is where the PATIENT is standing, which is a separate
// question from where the sample is — the collection room needs both.
const PEOPLE = [
  // ── The Gini-order track ────────────────────────────────────────────────
  {
    key: "g_ordered",
    name: "Demo Ordered",
    age: 54,
    sex: "Female",
    status: "vitals_done",
    order: { sampleStatus: "paid", paymentStatus: "paid", minutes: 20 },
  },
  {
    key: "g_unpaid",
    name: "Demo Unpaid",
    age: 61,
    sex: "Male",
    status: "vitals_done",
    order: { sampleStatus: "payment_pending", paymentStatus: "pending", minutes: 15 },
  },
  {
    key: "g_collected",
    name: "Demo Collected",
    age: 47,
    sex: "Female",
    status: "vitals_done",
    order: { sampleStatus: "sample_collected", paymentStatus: "paid", minutes: 40 },
  },
  {
    key: "g_sent",
    name: "Demo Sent",
    age: 66,
    sex: "Male",
    status: "sd_pending",
    order: { sampleStatus: "sample_sent", paymentStatus: "paid", minutes: 55 },
  },
  {
    key: "g_received",
    name: "Demo Received",
    age: 39,
    sex: "Female",
    status: "sd_pending",
    order: { sampleStatus: "sample_received", paymentStatus: "paid", minutes: 70 },
  },
  {
    key: "g_processing",
    name: "Demo Processing",
    age: 58,
    sex: "Male",
    status: "wait_doctor",
    order: { sampleStatus: "processing", paymentStatus: "paid", minutes: 85 },
  },
  {
    key: "g_results",
    name: "Demo Results Ready",
    age: 44,
    sex: "Female",
    status: "wait_doctor",
    order: { sampleStatus: "results_ready", paymentStatus: "paid", minutes: 100 },
  },
  {
    key: "g_uploaded",
    name: "Demo Uploaded",
    age: 72,
    sex: "Male",
    status: "with_doctor",
    order: { sampleStatus: "uploaded", paymentStatus: "paid", minutes: 120, uploadedAgo: 10 },
  },

  // ── The HealthRay track, which is where the real volume is ──────────────
  {
    key: "h_pending",
    name: "Demo Case Pending",
    age: 50,
    sex: "Female",
    status: "vitals_done",
    hrCase: { actions: [] },
  },
  {
    key: "h_collected",
    name: "Demo Case Collected",
    age: 63,
    sex: "Male",
    status: "vitals_done",
    hrCase: { actions: [["sample_taken", 25]] },
  },
  {
    key: "h_sent",
    name: "Demo Case Sent",
    age: 41,
    sex: "Female",
    status: "sd_pending",
    hrCase: {
      actions: [
        ["sample_taken", 50],
        ["sample_sent", 35],
      ],
    },
  },
  {
    key: "h_received",
    name: "Demo Case Received",
    age: 57,
    sex: "Male",
    status: "wait_doctor",
    hrCase: {
      actions: [
        ["sample_taken", 80],
        ["sample_sent", 70],
      ],
      receivedAgo: 60,
    },
  },
  {
    key: "h_reported",
    name: "Demo Case Reported",
    age: 68,
    sex: "Female",
    status: "with_doctor",
    hrCase: { receivedAgo: 150, resultSavedAgo: 40, reportedAgo: 30, synced: true },
  },

  // ── The three the collection room has to handle ─────────────────────────
  {
    key: "e_inroom",
    name: "Demo In A Room",
    age: 35,
    sex: "Male",
    status: "with_doctor",
    hrCase: { actions: [] },
  },
  {
    key: "e_gone",
    name: "Demo Left The Floor",
    age: 70,
    sex: "Female",
    status: "exited",
    hrCase: { actions: [] },
  },
];

const TESTS = ["Potassium, Serum", "Creatinine", "TSH"];

const client = await pool.connect();
try {
  await client.query("BEGIN");

  const { rows: existing } = await client.query(
    `SELECT id FROM patients WHERE file_no LIKE $1 || '%'`,
    [FILE_PREFIX],
  );
  const ids = existing.map((r) => r.id);

  // Always clean first: seeding twice must not leave two of anybody, and the
  // clean path is the same code either way, so it is exercised on every run.
  await client.query(`DELETE FROM giniflow_lab_case_actions WHERE case_no LIKE $1 || '%'`, [
    CASE_PREFIX,
  ]);
  await client.query(`DELETE FROM lab_cases WHERE case_no LIKE $1 || '%'`, [CASE_PREFIX]);
  if (ids.length) {
    // Reports uploaded against a demo patient during testing land on the CHART,
    // like any other report — a `documents` row and an object in storage. They
    // reference the patient, so they go first or the delete below fails on the
    // foreign key and demo people stay in production. The stored files go too:
    // a bucket object nothing points at is invisible and permanent.
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
    await client.query(`DELETE FROM documents WHERE patient_id = ANY($1::int[])`, [ids]);
    // giniflow_lab_orders and its children cascade from the visit.
    await client.query(`DELETE FROM giniflow_visits WHERE patient_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM lab_results WHERE patient_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
    removedFiles = docs.length;
  }

  if (clean) {
    await client.query("COMMIT");
    console.log(
      `Removed ${ids.length} demo patients, their lab work and ${removedFiles} uploaded report${removedFiles === 1 ? "" : "s"}.`,
    );
  } else {
    const { rows: docs } = await client.query(
      `SELECT id FROM doctors WHERE COALESCE(is_active, TRUE) ORDER BY id LIMIT 1`,
    );
    const orderedBy = docs[0]?.id ?? null;

    let n = 0;
    for (const [i, p] of PEOPLE.entries()) {
      const fileNo = `${FILE_PREFIX}${String(i + 1).padStart(3, "0")}`;
      const { rows: pat } = await client.query(
        `INSERT INTO patients (name, file_no, age, sex) VALUES ($1, $2, $3, $4) RETURNING id`,
        [p.name, fileNo, p.age, p.sex],
      );
      const patientId = pat[0].id;

      // NOT is_demo. Nothing in the app reads that column — it is the OTHER
      // seeder's cleanup tag, and `cleanDemoDay` deletes every visit carrying it
      // regardless of who wrote it. Flagging these cost a whole seeded set the
      // first time a smoke script ran. This seeder owns its own cleanup, scoped
      // to the ZZLAB_ prefix, which cannot reach anybody else's rows.
      const { rows: visit } = await client.query(
        `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
         VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, $2, 'none')
         RETURNING id`,
        [patientId, p.status],
      );
      const visitId = visit[0].id;

      if (p.order) {
        const paid = p.order.paymentStatus === "paid";
        const { rows: order } = await client.query(
          `INSERT INTO giniflow_lab_orders
             (visit_id, ordered_by, urgency, payment_status, amount_total, amount_paid,
              sample_status, created_at, updated_at, uploaded_at)
           VALUES ($1, $2, 'today', $3, 900, $4, $5, $6, $6, $7) RETURNING id`,
          [
            visitId,
            orderedBy,
            p.order.paymentStatus,
            paid ? 900 : 0,
            p.order.sampleStatus,
            ago(p.order.minutes),
            p.order.uploadedAgo ? ago(p.order.uploadedAgo) : null,
          ],
        );
        await client.query(
          `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
           SELECT $1, * FROM UNNEST($2::text[], $3::numeric[])`,
          [order[0].id, TESTS, TESTS.map(() => 300)],
        );
        // One event per rung the sample has already passed, so the card's timer
        // reads from the last thing that actually happened to it.
        const reached = LAB_RUNGS.filter(
          (r) => r.advanceTo && r.sampleStatuses.includes(p.order.sampleStatus),
        );
        const passed = LAB_RUNGS.slice(1, LAB_RUNGS.indexOf(reached[0]) + 1).filter(
          (r) => r.advanceTo,
        );
        if (passed.length) {
          await client.query(
            `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, occurred_at)
             SELECT $1, 'sample', * FROM UNNEST($2::text[], $3::text[], $4::timestamptz[])`,
            [
              order[0].id,
              passed.map((r) => r.advanceTo),
              passed.map(() => "lab"),
              passed.map((_, k) => ago(p.order.minutes - k * 4)),
            ],
          );
        }
      }

      if (p.hrCase) {
        const caseNo = `${CASE_PREFIX}${String(i + 1).padStart(3, "0")}`;
        const list = {
          patient: { patient_name: p.name, healthray_uid: fileNo },
          phlebotomy_status: "Pending",
          received_on: p.hrCase.receivedAgo ? iso(p.hrCase.receivedAgo) : null,
          result_saved_on: p.hrCase.resultSavedAgo ? iso(p.hrCase.resultSavedAgo) : null,
          reported_on: p.hrCase.reportedAgo ? iso(p.hrCase.reportedAgo) : null,
        };
        await client.query(
          `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                                  case_date, test_names, results_synced, raw_list_json,
                                  raw_detail_json, fetched_at)
           VALUES ($1, $1, $1, $2, $3, (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
                   $4::text[], $5, $6::jsonb, $7::jsonb, NOW())`,
          [
            caseNo,
            -(i + 1),
            patientId,
            TESTS,
            !!p.hrCase.synced,
            JSON.stringify(list),
            p.hrCase.reportedAgo ? JSON.stringify(list) : null,
          ],
        );
        for (const [action, minutes] of p.hrCase.actions || []) {
          await client.query(
            `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role, created_at)
             VALUES ($1, $2, 'lab', $3)`,
            [caseNo, action, ago(minutes)],
          );
        }
      }
      n++;
    }
    await client.query("COMMIT");
    console.log(`Seeded ${n} demo patients for today.`);
    console.log(`  Lab 1  http://localhost:3000/giniflow/station/lab/collection`);
    console.log(`  Lab 2  http://localhost:3000/giniflow/station/lab/processing`);
    console.log(`\nRemove them with:  npm run seed:lab-rooms -- --clean`);
  }
} catch (e) {
  await client.query("ROLLBACK");
  console.error(e);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
