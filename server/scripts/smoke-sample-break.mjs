// Sample first, then a break (docs/gini-flow/55-SAMPLE-THEN-BREAK-PLAN.md).
//
// Lab 1 takes the sample before vitals and sends the patient on a break; the
// lab carries on with the tube; the patient's wait starts when they are back —
// at reception's ▶ Back, or when the vitals nurse takes them in.
//
// Runs on a date of its own inside a transaction that is always rolled back.
//
//   npm run smoke:sample-break   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";
import { advanceSample, markLabCaseAction } from "../services/giniflow/labStation.js";
import { getSlaConfig, budgetMap, getDayBoard } from "../services/giniflow/board.js";
import { getArrivals } from "../services/giniflow/receptionStation.js";
import { getMoQueue } from "../services/giniflow/moStation.js";
import { getDoctorQueue } from "../services/giniflow/doctorStation.js";
import { getVitalsQueue, startVitals } from "../services/giniflow/vitalsStation.js";
import {
  advanceStatus,
  cancelPauseTx,
  getStationTimes,
  resumeVisit,
} from "../services/giniflow/statusEngine.js";
import { SAMPLE_BREAK_REASON } from "../../shared/giniflowStatus.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const client = await pool.connect();
let depth = 0;
const nested = {
  query: (text, params) => {
    const sql = String(text).trim().toUpperCase();
    if (sql === "BEGIN") return client.query(`SAVEPOINT sp${++depth}`);
    if (sql === "COMMIT") return client.query(`RELEASE SAVEPOINT sp${depth--}`);
    if (sql === "ROLLBACK") return client.query(`ROLLBACK TO SAVEPOINT sp${depth--}`);
    return client.query(text, params);
  },
  release: () => {},
};
const db = { connect: async () => nested, query: (t, p) => client.query(t, p) };

const findCard = (tree, visitId) => {
  if (!tree || typeof tree !== "object") return null;
  if (tree.visitId === visitId) return tree;
  for (const value of Object.values(tree)) {
    const hit = findCard(value, visitId);
    if (hit) return hit;
  }
  return null;
};

const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return { message: e.message, status: e.status ?? null };
  }
};

try {
  await client.query("BEGIN");
  const { rows: d } = await client.query(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 123)::text AS day`,
  );
  const day = d[0].day;

  const make = async (tag, status = "checked_in") => {
    const { rows: p } = await client.query(
      `INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`,
      [`Probe ${tag}`, `ZZSB_${tag}_${Date.now()}`],
    );
    await client.query(
      `INSERT INTO appointments (patient_id, appointment_date, status, time_slot, doctor_name)
       VALUES ($1, $2::date, 'checkedin', '09:00', 'Dr. Anil Bhansali')`,
      [p[0].id, day],
    );
    const { rows: v } = await client.query(
      `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
       VALUES ($1, $2::date, $3, 'none') RETURNING id`,
      [p[0].id, day, status],
    );
    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, 'checked_in', 'reception', NOW() - interval '3 hours')`,
      [v[0].id],
    );
    return v[0].id;
  };

  const labOrder = async (visitId) => {
    const { rows } = await client.query(
      `INSERT INTO giniflow_lab_orders
         (visit_id, urgency, payment_status, amount_total, amount_paid, sample_status, kind)
       VALUES ($1, 'today', 'paid', 400, 400, 'paid', 'lab') RETURNING id`,
      [visitId],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
       VALUES ($1, 'HbA1c', 400)`,
      [rows[0].id],
    );
    return rows[0].id;
  };

  const visit = async (id) =>
    (
      await client.query(
        `SELECT current_status, paused_at, paused_reason FROM giniflow_visits WHERE id = $1`,
        [id],
      )
    ).rows[0];

  const checkIn = async (id) =>
    (
      await client.query(
        `SELECT occurred_at, meta, occurred_at >= NOW() - interval '1 minute' AS fresh
           FROM giniflow_visit_events
          WHERE visit_id = $1 AND status = 'checked_in'`,
        [id],
      )
    ).rows[0];

  const inGroup = async (id) => {
    const q = await getVitalsQueue(day, new Date(), db);
    return {
      waiting: q.waiting.some((r) => r.visitId === id),
      onBreak: q.onBreak.some((r) => r.visitId === id),
    };
  };

  console.log("── Lab 1 takes the sample before vitals, patient goes on break ─");
  const early = await make("EARLY");
  const earlyOrder = await labOrder(early);
  await advanceSample(earlyOrder, { to: "drawing" }, db);
  const taken = await advanceSample(earlyOrder, { to: "sample_collected", thenBreak: true }, db);
  check("the sample is recorded", taken.sampleStatus === "sample_collected");
  check("and the answer says the patient is on break", taken.onBreak === true);
  const v1 = await visit(early);
  check("the visit is paused", !!v1.paused_at);
  check("for a sample break", v1.paused_reason === SAMPLE_BREAK_REASON, v1.paused_reason);
  check("and has not moved", v1.current_status === "checked_in", v1.current_status);

  const g1 = await inGroup(early);
  check("vitals shows them On break", g1.onBreak);
  check("not in the vitals waiting list", !g1.waiting);

  console.log("\n── Every screen agrees they are away ───────────────────────");
  const sla = await getSlaConfig(db);
  const board = await getDayBoard(day, sla, new Date(), db);
  const card = board.columns
    ?.flatMap((c) => c.cards.map((x) => ({ ...x, col: c.key })))
    .find((x) => x.id === early);
  check("the board card is in Checked in", card?.col === "checked_in", card?.col);
  check("marked as a sample break", card?.paused && card?.pausedReason === SAMPLE_BREAK_REASON);
  const checkedCol = board.columns?.find((c) => c.key === "checked_in");
  check(
    "and left out of the column average",
    !checkedCol?.avgMinutes || checkedCol.avgMinutes < 60,
    String(checkedCol?.avgMinutes),
  );
  const arrivals = await getArrivals(day, "", new Date(), db);
  const row = arrivals.onFloor.find((a) => a.visitId === early);
  check(
    "reception sees them paused for a sample",
    row?.paused && row?.pausedReason === SAMPLE_BREAK_REASON,
  );
  check(
    "and counts them on break, not here",
    arrivals.counts.onFloorAway === 1,
    JSON.stringify(arrivals.counts),
  );

  console.log("\n── The lab carries on while they are away ──────────────────");
  const sent = await refusal(() => advanceSample(earlyOrder, { to: "sample_sent" }, db));
  check("the tube moves on", sent === null, sent?.message);
  check("and the patient is still on break", !!(await visit(early)).paused_at);

  console.log("\n── The vitals nurse takes them in: the wait starts now ─────");
  await startVitals(early, null, db);
  const v2 = await visit(early);
  check("the break is over", !v2.paused_at);
  check("they are at vitals", v2.current_status === "with_vitals", v2.current_status);
  const c2 = await checkIn(early);
  check("their check-in is timed from now", c2.fresh, String(c2.occurred_at));
  check(
    "and the real arrival is kept",
    !!c2.meta?.original_occurred_at,
    c2.meta?.original_occurred_at,
  );

  const times = await getStationTimes(db, early, budgetMap(sla), new Date(), { slaConfig: sla });
  const arrived = times.find((t) => t.status === "arrived_before_break");
  check("the timeline keeps the real arrival", !!arrived, arrived?.label);
  check(
    "and names the break",
    times.some((t) => t.status === "paused" && /sample given/i.test(t.label)),
    times.map((t) => t.label).join(" | "),
  );

  console.log("\n── Or reception presses ▶ Back: into the vitals queue ──────");
  const back = await make("BACK");
  const backOrder = await labOrder(back);
  await advanceSample(backOrder, { to: "drawing" }, db);
  await advanceSample(backOrder, { to: "sample_collected", thenBreak: true }, db);
  const r = await resumeVisit(back, { actorRole: "reception" }, db);
  check("the clock restarts rather than resumes", r.restarted === true);
  const g2 = await inGroup(back);
  check("they are in the vitals waiting list", g2.waiting && !g2.onBreak);
  check("timed from their return", (await checkIn(back)).fresh);

  console.log("\n── Plain Sample taken does not send anyone on break ────────");
  const stays = await make("STAYS");
  const staysOrder = await labOrder(stays);
  await advanceSample(staysOrder, { to: "drawing" }, db);
  const plain = await advanceSample(staysOrder, { to: "sample_collected" }, db);
  check("no break", plain.onBreak === false && !(await visit(stays)).paused_at);
  check("they go straight to the vitals queue", (await inGroup(stays)).waiting);

  console.log("\n── A break after vitals holds the clock instead ────────────");
  const later = await make("LATER", "vitals_done");
  await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'vitals_done', 'vitals', NOW() - interval '1 hour')`,
    [later],
  );
  const laterOrder = await labOrder(later);
  await advanceSample(laterOrder, { to: "drawing" }, db);
  await advanceSample(laterOrder, { to: "sample_collected", thenBreak: true }, db);
  check("on break at vitals_done", !!(await visit(later)).paused_at);
  await advanceSample(laterOrder, { to: "uploaded" }, db);
  check("the report lands while they are away", !!(await visit(later)).paused_at);
  const moCard = findCard(await getMoQueue(day, null, null, new Date(), db), later);
  check("the Chief's queue shows them on break", !!moCard?.pausedAt, moCard ? "" : "not listed");
  const docCard = findCard(await getDoctorQueue(day, { scope: "all" }, new Date(), db), later);
  check(
    "the consultant queue still loads",
    docCard === null || "pausedAt" in docCard,
    docCard ? "listed" : "not listed",
  );
  await advanceStatus(nested, {
    visitId: later,
    toStatus: "sd_pending",
    actorRole: "mo_sd",
    allowSkip: true,
  });
  check("paperwork moving them between queues keeps the break", !!(await visit(later)).paused_at);
  const moved = await refusal(() =>
    advanceStatus(nested, { visitId: later, toStatus: "with_sd", actorRole: "mo_sd" }),
  );
  check(
    "the Chief taking them into the room ends the break",
    moved === null && !(await visit(later)).paused_at,
    moved?.message,
  );
  check("without restarting their check-in", !(await checkIn(later)).fresh);

  console.log("\n── HealthRay opening them with the Chief ends the break ────");
  const chief = await make("CHIEF", "vitals_done");
  await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'vitals_done', 'vitals', NOW() - interval '1 hour')`,
    [chief],
  );
  const chiefOrder = await labOrder(chief);
  await advanceSample(chiefOrder, { to: "drawing" }, db);
  await advanceSample(chiefOrder, { to: "sample_collected", thenBreak: true }, db);
  await advanceSample(chiefOrder, { to: "uploaded" }, db);
  await advanceStatus(nested, {
    visitId: chief,
    toStatus: "sd_pending",
    actorRole: "system",
    allowSkip: true,
  });
  check("a sync move into a queue leaves the break open", !!(await visit(chief)).paused_at);
  await advanceStatus(nested, {
    visitId: chief,
    toStatus: "with_sd",
    actorRole: "system",
    allowSkip: true,
  });
  check("a sync move into the Chief's room ends it", !(await visit(chief)).paused_at);

  console.log("\n── A HealthRay lab case: break, then undo ──────────────────");
  const hr = await make("HRCASE");
  const { rows: hp } = await client.query(`SELECT patient_id FROM giniflow_visits WHERE id = $1`, [
    hr,
  ]);
  const caseNo = `ZZSB${Date.now()}`;
  await client.query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id, case_date,
                            test_names, raw_list_json)
     VALUES ($1, $1, $1, 0, $2, $3::date, ARRAY['HbA1c']::text[], $4::jsonb)`,
    [caseNo, hp[0].patient_id, day, JSON.stringify({ phlebotomy_status: "Pending" })],
  );
  await client.query(
    `INSERT INTO giniflow_visit_steps (visit_id, step_order, step_catalog_id, step_name, source, status)
     VALUES ($1, 1, 'lab_billing', 'lab_billing', 'added', 'done')`,
    [hr],
  );
  await markLabCaseAction(caseNo, { action: "drawing_started" }, db);
  const hrTaken = await markLabCaseAction(caseNo, { action: "sample_taken", thenBreak: true }, db);
  check("the case records the sample and the break", hrTaken.onBreak === true);
  check("the visit is on a sample break", (await visit(hr)).paused_reason === SAMPLE_BREAK_REASON);
  await markLabCaseAction(caseNo, { action: "sample_taken", undo: true }, db);
  check("undoing the sample cancels the break", !(await visit(hr)).paused_at);
  check("without moving their check-in", !(await checkIn(hr)).fresh);

  console.log("\n── Undoing the sample cancels the break ────────────────────");
  const undo = await make("UNDO");
  const undoOrder = await labOrder(undo);
  await advanceSample(undoOrder, { to: "drawing" }, db);
  await advanceSample(undoOrder, { to: "sample_collected", thenBreak: true }, db);
  const cancelled = await cancelPauseTx(nested, undo, SAMPLE_BREAK_REASON, { actorRole: "lab" });
  check("the break is cancelled", cancelled === true && !(await visit(undo)).paused_at);
  check("and no clock moved", !(await checkIn(undo)).fresh);
  const again = await cancelPauseTx(nested, undo, SAMPLE_BREAK_REASON, { actorRole: "lab" });
  check("a second cancel is a no-op", again === false);
} catch (e) {
  check("the suite ran to the end", false, `threw: ${e.message}`);
} finally {
  await client.query("ROLLBACK");
  client.release();
  const { rows: left } = await pool.query(
    `SELECT count(*)::int AS c FROM patients WHERE file_no LIKE 'ZZSB_%'`,
  );
  check("the synthetic patients left no trace", left[0].c === 0, `${left[0].c} rows`);
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  await pool.end();
  process.exit(failures ? 1 : 0);
}
