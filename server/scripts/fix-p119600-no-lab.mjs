import "../loadEnv.js";
import pool from "../config/db.js";
import { cancelTestIn } from "../services/giniflow/testCancel.js";
import { advanceStatus } from "../services/giniflow/statusEngine.js";
import { TESTS_HOLD_SQL, LIVE_LAB_CASE_SQL } from "../services/giniflow/testsHold.js";
import {
  HEALTHRAY_STATUS_TO_CHAIN,
  chainIndex,
  isChainStatus,
} from "../../shared/giniflowStatus.js";

const FILE_NO = "P_119600";
const DAY = "2026-09-19";
const apply = process.argv.includes("--apply");

const { rows: visits } = await pool.query(
  `SELECT v.id, v.current_status, p.id AS patient_id, p.name
     FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
    WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
  [FILE_NO, DAY],
);
if (visits.length !== 1) {
  console.error(`Expected one visit for ${FILE_NO} on ${DAY}, found ${visits.length}`);
  process.exit(1);
}
const visit = visits[0];
console.log("visit", visit);

const { rows: appts } = await pool.query(
  `SELECT id, doctor_name, visit_type, status FROM appointments
    WHERE patient_id = $1 AND appointment_date = $2::date ORDER BY id`,
  [visit.patient_id, DAY],
);
console.table(appts);

const { rows: cases } = await pool.query(
  `SELECT lc.case_no, lc.test_names, ${LIVE_LAB_CASE_SQL("lc")} AS live
     FROM lab_cases lc WHERE lc.patient_id = $1 AND lc.case_date = $2::date`,
  [visit.patient_id, DAY],
);
console.table(cases);

const { rows: orders } = await pool.query(
  `SELECT id, kind, sample_status, payment_status FROM giniflow_lab_orders
    WHERE visit_id = $1 AND urgency = 'today'`,
  [visit.id],
);
console.table(orders);

const showSteps = async (db) =>
  console.table(
    (
      await db.query(
        `SELECT step_order, step_catalog_id, step_name, status FROM giniflow_visit_steps
          WHERE visit_id = $1 ORDER BY step_order`,
        [visit.id],
      )
    ).rows,
  );
await showSteps(pool);

const RANK = { completed: 4, seen: 4, in_visit: 3, checkedin: 2, scheduled: 1 };
const furthest = appts
  .filter((a) => HEALTHRAY_STATUS_TO_CHAIN[a.status])
  .sort((a, b) => (RANK[b.status] || 0) - (RANK[a.status] || 0))[0];
const hrTarget = furthest ? HEALTHRAY_STATUS_TO_CHAIN[furthest.status] : null;
const target = hrTarget === "exited" ? "rx_pending" : hrTarget;
const behind =
  target &&
  isChainStatus(target) &&
  isChainStatus(visit.current_status) &&
  chainIndex(visit.current_status) < chainIndex(target);

const liveCases = cases.filter((c) => c.live).map((c) => c.case_no);
console.log(`\nWill cancel HealthRay lab case(s) in Scribe: ${liveCases.join(", ") || "none"}`);
if (orders.some((o) => !["uploaded", "reported"].includes(o.sample_status))) {
  console.log(
    "Note: Scribe lab/machine orders are open on this visit — not touched by this script",
  );
}
console.log(
  `HealthRay: ${furthest?.status ?? "no appointment"} → Scribe should be at ${target ?? "?"}; Scribe is at ${visit.current_status}` +
    (behind ? ` — will move to ${target}` : " — no status change"),
);

if (!apply) {
  console.log("\nDry run. Re-run with --apply to write.");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  if (liveCases.length) {
    const r = await cancelTestIn(client, {
      target: { caseNos: liveCases, patientId: visit.patient_id, date: DAY },
      reason: "not_on_bill",
      source: "healthray",
      actorRole: "admin",
      refundAmount: 0,
    });
    console.log("cancelled:", r);
  }
  if (behind) {
    await advanceStatus(client, {
      visitId: visit.id,
      toStatus: target,
      actorRole: "system",
      allowSkip: true,
      meta: { source: "healthray", healthray_status: furthest.status, repair: "fix-p119600" },
    });
  }
  const {
    rows: [hold],
  } = await client.query(
    `SELECT h.tests_pending, v.current_status FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       CROSS JOIN LATERAL (${TESTS_HOLD_SQL("v", "p")}) h WHERE v.id = $1`,
    [visit.id],
  );
  console.log("after:", hold);
  await showSteps(client);
  await client.query("COMMIT");
  console.log("\nApplied.");
} catch (e) {
  await client.query("ROLLBACK");
  console.error("Rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
