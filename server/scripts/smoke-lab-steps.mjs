// Every step of both lab rooms, in order, against a synthetic case
// (docs/gini-flow/35-LAB-TWO-ROOM-SPLIT-PLAN.md §3.1, §4).
//
// Runs inside one transaction that is ALWAYS rolled back: `DATABASE_URL` is
// production, and a fake case must not survive the test that used it.
//
//   npm run smoke:lab-steps   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";
import { markLabCaseAction, getLabQueue } from "../services/giniflow/labStation.js";
import { LAB_RUNGS, LAB_ROOMS, floorActionRungs } from "../../shared/labStages.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const CASE_NO = `smoke-steps-${Date.now()}`;
const UID = "SMOKE-UID";

const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return { message: e.message, status: e.status ?? null };
  }
};

const client = await pool.connect();
let patientId = null;
let fatal = null;
try {
  await client.query("BEGIN");

  // The two handoff verbs live behind a CHECK constraint
  // (2026-09-18_lab_room_split_actions.sql). If production has not had it
  // applied yet, apply it HERE — inside the transaction that is about to be
  // rolled back — so the steps can still be proven end to end, and say so
  // loudly rather than failing with a constraint error nobody can read.
  const { rows: con } = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'giniflow_lab_case_actions_action_check'`,
  );
  const migrated = (con[0]?.def || "").includes("sample_sent");
  console.log(
    migrated
      ? "  --   the room-split migration is applied on this database"
      : "  ⚠️   the room-split migration is NOT applied — applying it inside this\n" +
          "       rolled-back transaction so the steps below can still be verified.\n" +
          "       Run it for real: node migrations/_runOne.mjs \\\n" +
          "         migrations/2026-09-18_lab_room_split_actions.sql",
  );
  if (!migrated) {
    await client.query(
      `ALTER TABLE giniflow_lab_case_actions
         DROP CONSTRAINT IF EXISTS giniflow_lab_case_actions_action_check`,
    );
    await client.query(
      `ALTER TABLE giniflow_lab_case_actions
         ADD CONSTRAINT giniflow_lab_case_actions_action_check
         CHECK (action IN ('chased', 'sample_taken', 'sample_sent', 'sample_received',
                           'processing', 'results_ready', 'report_uploaded'))`,
    );
  }

  const { rows: pat } = await client.query(
    `INSERT INTO patients (name, file_no) VALUES ('Smoke Steps', $1) RETURNING id`,
    [`ZZSTEPS_${Date.now()}`],
  );
  patientId = pat[0].id;

  await client.query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id, case_date,
                            test_names, raw_list_json)
     VALUES ($1, $1, $1, 0, $3, CURRENT_DATE, ARRAY['Potassium, Serum']::text[], $2::jsonb)`,
    [
      CASE_NO,
      JSON.stringify({
        patient: { patient_name: "Smoke Test", healthray_uid: UID },
        phlebotomy_status: "Pending",
      }),
      patientId,
    ],
  );

  // What the screen would be offered, asked of the same query the screen reads.
  const canMarkDone = async () => {
    const q = await getLabQueue(new Date().toISOString().slice(0, 10), "Smoke Test", client, {
      room: LAB_ROOMS.PROCESSING,
    });
    const found = q.healthray.flatMap((r) => r.caseList).find((c) => c.caseNo === CASE_NO);
    return !!found?.canMarkDone;
  };

  const mark = (action, room) =>
    markLabCaseAction(CASE_NO, { action, room, actorRole: "lab" }, client);

  console.log("\n── Out of order, before anything is recorded ────────────────");
  for (const rung of floorActionRungs().slice(1)) {
    const r = await refusal(() => mark(rung.action, null));
    // The handoff is the one deliberate exception, and it needs collection first.
    check(
      `"${rung.action}" is refused on a case with nothing recorded`,
      r?.status === 409,
      r?.message ?? "it was ALLOWED",
    );
  }

  console.log("\n── The collection room, in order ────────────────────────────");
  const collect = await refusal(() => mark("sample_taken", LAB_ROOMS.COLLECTION));
  check("collection may record the sample", collect === null, collect?.message);

  const wrongRoom = await refusal(() => mark("sample_received", LAB_ROOMS.COLLECTION));
  check(
    "collection may not record receipt at the lab",
    wrongRoom?.status === 403,
    wrongRoom?.message ?? "it was ALLOWED",
  );

  console.log("\n── The handoff ─────────────────────────────────────────────");
  // Lab 1 drew the tube and walked it over without tapping "sent". Lab 2 is
  // holding it, and the other room's paperwork is not Lab 2's to fix.
  const straightToReceived = await refusal(() => mark("sample_received", LAB_ROOMS.PROCESSING));
  check(
    "the lab room may record receipt even when 'sent' was never tapped",
    straightToReceived === null,
    straightToReceived?.message,
  );
  await client.query(`DELETE FROM giniflow_lab_case_actions WHERE case_no = $1 AND action = $2`, [
    CASE_NO,
    "sample_received",
  ]);

  const send = await refusal(() => mark("sample_sent", LAB_ROOMS.COLLECTION));
  check("collection may send the sample", send === null, send?.message);

  console.log("\n── The analyzer room, in order ─────────────────────────────");
  const skipAhead = await refusal(() => mark("results_ready", LAB_ROOMS.PROCESSING));
  check(
    "the lab room may not jump to results before processing",
    skipAhead?.status === 409,
    skipAhead?.message ?? "it was ALLOWED",
  );

  for (const action of ["sample_received", "processing", "results_ready"]) {
    const r = await refusal(() => mark(action, LAB_ROOMS.PROCESSING));
    check(`the lab room records "${action}"`, r === null, r?.message);
  }

  const backToCollection = await refusal(() => mark("sample_taken", LAB_ROOMS.PROCESSING));
  check(
    "the lab room may not record a collection",
    backToCollection?.status === 403,
    backToCollection?.message ?? "it was ALLOWED",
  );

  console.log("\n── What was written ────────────────────────────────────────");
  const { rows: written } = await client.query(
    `SELECT action FROM giniflow_lab_case_actions WHERE case_no = $1 ORDER BY id`,
    [CASE_NO],
  );
  // Closing the case is the step after these, and it needs evidence — it is
  // exercised in its own section below.
  const expected = floorActionRungs()
    .filter((r) => r.action !== "report_uploaded")
    .map((r) => r.action);
  check(
    "every rung of both rooms is on the record, in order",
    written.map((r) => r.action).join(" ") === expected.join(" "),
    written.map((r) => r.action).join(" "),
  );

  console.log("\n── Undo ────────────────────────────────────────────────────");
  const undoWrongRoom = await refusal(() =>
    markLabCaseAction(
      CASE_NO,
      { action: "processing", room: LAB_ROOMS.COLLECTION, undo: true },
      client,
    ),
  );
  check(
    "a room may not undo the other room's step",
    undoWrongRoom?.status === 403,
    undoWrongRoom?.message ?? "it was ALLOWED",
  );
  const undo = await refusal(() =>
    markLabCaseAction(
      CASE_NO,
      { action: "results_ready", room: LAB_ROOMS.PROCESSING, undo: true },
      client,
    ),
  );
  check("a room may undo its own step", undo === null, undo?.message);

  // The undo above removed results_ready, which the close depends on.
  await mark("results_ready", LAB_ROOMS.PROCESSING);

  console.log("\n── Closing the case needs something to show for it ─────────");
  // "Done" says a result exists. Checked against the record, not against which
  // button the screen happened to show.
  const nothingToShow = await refusal(() => mark("report_uploaded", LAB_ROOMS.PROCESSING));
  check(
    "a case with no report and no values cannot be marked done",
    nothingToShow?.status === 409,
    nothingToShow?.message ?? "it was ALLOWED",
  );
  check("and the screen is not offered the button either", !(await canMarkDone()));

  // Values typed against the case are enough — a scan of a printout and a set of
  // numbers are two ways of having a result, and the floor may finish either way.
  await client.query(
    `INSERT INTO lab_results (patient_id, test_name, test_date, lab_case_no)
     VALUES ($1, 'Potassium, Serum', CURRENT_DATE, $2)`,
    [patientId, CASE_NO],
  );
  check("typing the values in makes the case closeable", await canMarkDone());
  const closed = await refusal(() => mark("report_uploaded", LAB_ROOMS.PROCESSING));
  check("and it can then be marked done", closed === null, closed?.message);

  const { rows: reached } = await client.query(
    `SELECT count(*)::int n FROM giniflow_lab_case_actions
      WHERE case_no = $1 AND action = 'report_uploaded'`,
    [CASE_NO],
  );
  check("which is on the record like every other step", reached[0].n === 1);

  console.log("\n── Rungs nobody may record by hand ─────────────────────────");
  const nonsense = await refusal(() => mark("teleported", LAB_ROOMS.PROCESSING));
  check("an invented action is refused", nonsense !== null, nonsense?.message ?? "it was ALLOWED");
} catch (e) {
  fatal = e;
} finally {
  await client.query("ROLLBACK");
  client.release();
  const { rows } = await pool.query(`SELECT count(*)::int n FROM lab_cases WHERE case_no = $1`, [
    CASE_NO,
  ]);
  console.log(`\n  ${rows[0].n === 0 ? "ok " : "FAIL"}  the synthetic case left no trace`);
  if (rows[0].n !== 0) failures++;
  await pool.end();
}

if (fatal) {
  console.error(fatal);
  process.exit(1);
}
console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
