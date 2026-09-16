import { readFileSync } from "node:fs";
import "../loadEnv.js";
import pool from "../config/db.js";
import {
  getMachineQueue,
  advanceMachineTest,
  cancelMachineStart,
} from "../services/giniflow/machineStation.js";
import {
  getLabQueue,
  advanceSample,
  cancelDrawing,
  markLabCaseAction,
} from "../services/giniflow/labStation.js";
import { releaseVisit } from "../services/giniflow/stationRelease.js";
import { busyStations } from "../services/giniflow/stationLock.js";
import { placementFor } from "../services/giniflow/board.js";
import { orderTests } from "../services/giniflow/moStation.js";

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

const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return { message: e.message, status: e.status ?? null };
  }
};

delete process.env.SCRIBE_BLOOD_BEFORE_MACHINE;

try {
  await client.query("BEGIN");
  await client.query(
    readFileSync(
      new URL("../migrations/2026-10-06_lab_collection_started.sql", import.meta.url),
      "utf8",
    ),
  );
  const { rows: d } = await client.query(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 123)::text AS day`,
  );
  const day = d[0].day;

  await client.query(
    `INSERT INTO giniflow_test_catalog (test_name, category, price, is_active)
     VALUES ('Lipid', 'lab', 400, TRUE)
     ON CONFLICT (test_name) DO UPDATE SET is_active = TRUE`,
  );
  for (const name of ["ABI", "VPT", "X-Ray", "2D Echo"]) {
    await client.query(
      `INSERT INTO giniflow_test_catalog (test_name, category, price, is_active)
       VALUES ($1, 'machine', 400, TRUE)
       ON CONFLICT (test_name) DO UPDATE SET category = 'machine', is_active = TRUE`,
      [name],
    );
  }

  let seq = 0;
  const make = async (tag) => {
    const { rows: p } = await client.query(
      `INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`,
      [`Probe ${tag}`, `ZZSL_${tag}_${Date.now()}_${++seq}`],
    );
    const { rows: v } = await client.query(
      `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
       VALUES ($1, $2::date, 'vitals_done', 'none') RETURNING id`,
      [p[0].id, day],
    );
    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role)
       VALUES ($1, 'vitals_done', 'vitals')`,
      [v[0].id],
    );
    return { patientId: p[0].id, visitId: v[0].id, fileNo: `ZZSL_${tag}` };
  };

  const order = async (visitId, kind, testName) => {
    const { rows } = await client.query(
      `INSERT INTO giniflow_lab_orders
         (visit_id, urgency, payment_status, amount_total, amount_paid, sample_status, kind)
       VALUES ($1, 'today', 'paid', 400, 400, 'paid', $2) RETURNING id`,
      [visitId, kind],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 400)`,
      [rows[0].id, testName],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role)
       VALUES ($1, 'sample', 'paid', 'reception')`,
      [rows[0].id],
    );
    return rows[0].id;
  };

  const withValue = (orderId, patientId, name) =>
    client.query(
      `INSERT INTO lab_results (lab_order_id, patient_id, test_name, result, test_date)
       VALUES ($1, $2, $3, 1, CURRENT_DATE)`,
      [orderId, patientId, name],
    );

  const machineCard = async (station, visitId) => {
    const q = await getMachineQueue(day, null, db, { station });
    return (
      Object.values(q)
        .filter(Array.isArray)
        .flat()
        .find((o) => o?.visitId === visitId && o.orderId) || null
    );
  };
  const labCard = async (visitId) => {
    const q = await getLabQueue(day, null, db, { room: "collection" });
    return q.pending.find((o) => o.visitId === visitId) || null;
  };
  const statusOf = async (orderId) =>
    (await client.query(`SELECT sample_status FROM giniflow_lab_orders WHERE id = $1`, [orderId]))
      .rows[0].sample_status;

  console.log("── Machines no longer wait for Lab 1 ─────────────────────────");
  const a = await make("A");
  const aLab = await order(a.visitId, "lab", "HbA1c");
  const aAbi = await order(a.visitId, "machine", "ABI");
  const aVpt = await order(a.visitId, "machine", "VPT");
  const aXray = await order(a.visitId, "machine", "X-Ray");
  const abiCard = await machineCard("machine_room", a.visitId);
  check(
    "ABI offers Start with blood still undrawn",
    abiCard?.nextAction?.to === "in_progress",
    abiCard?.blockedReason || "offered",
  );
  const startAbi = await refusal(() =>
    advanceMachineTest(aAbi, { to: "in_progress", station: "machine_room" }, db),
  );
  check("and the service starts it", startAbi === null, startAbi?.message);

  console.log("\n── A started test holds the patient ─────────────────────────");
  const held = await labCard(a.visitId);
  check("Lab 1 hides Start collection", held && held.nextAction === null, held?.blockedReason);
  check(
    "and names the Machine Room as the reason",
    held?.heldElsewhere === true && /Machine Room/.test(held?.blockedReason || ""),
    held?.blockedReason,
  );
  const labRefused = await refusal(() => advanceSample(aLab, { to: "drawing" }, db));
  check("Lab 1's start is refused by the service", labRefused?.status === 409, labRefused?.message);
  const xrayHeld = await machineCard("xray", a.visitId);
  check(
    "X-Ray still lists the patient, blocked",
    !!xrayHeld && xrayHeld.nextAction === null && xrayHeld.heldElsewhere === true,
    xrayHeld?.blockedReason,
  );
  const xrayRefused = await refusal(() =>
    advanceMachineTest(aXray, { to: "in_progress", station: "xray" }, db),
  );
  check(
    "X-Ray's start is refused by the service",
    xrayRefused?.status === 409,
    xrayRefused?.message,
  );
  const vptOk = await refusal(() =>
    advanceMachineTest(aVpt, { to: "in_progress", station: "machine_room" }, db),
  );
  check("the same station may run its next machine", vptOk === null, vptOk?.message);
  const busy = await busyStations(db, [a.visitId]);
  check(
    "busyStations reports one station, the Machine Room",
    busy.get(a.visitId)?.length === 1 && busy.get(a.visitId)[0].station === "machine_room",
    JSON.stringify(busy.get(a.visitId)),
  );
  check(
    "the board puts a running machine ahead of undrawn blood",
    placementFor({ machine: { running: true } }, { vitalsAt: new Date(), labUndrawn: 1 }) ===
      "machine",
  );

  console.log("\n── Done releases the patient ────────────────────────────────");
  await withValue(aAbi, a.patientId, "ABI Right");
  await advanceMachineTest(aAbi, { to: "done", station: "machine_room" }, db);
  const stillHeld = await refusal(() =>
    advanceMachineTest(aXray, { to: "in_progress", station: "xray" }, db),
  );
  check("one machine done, the other still running — still held", stillHeld?.status === 409);
  await withValue(aVpt, a.patientId, "VPT Right");
  await advanceMachineTest(aVpt, { to: "done", station: "machine_room" }, db);
  const xrayNow = await refusal(() =>
    advanceMachineTest(aXray, { to: "in_progress", station: "xray" }, db),
  );
  check("both done — X-Ray may start", xrayNow === null, xrayNow?.message);
  const labWhileXray = await refusal(() => advanceSample(aLab, { to: "drawing" }, db));
  check("and now X-Ray holds the patient against Lab 1", labWhileXray?.status === 409);
  await withValue(aXray, a.patientId, "X-Ray Chest");
  await advanceMachineTest(aXray, { to: "done", station: "xray" }, db);
  const labLast = await refusal(() => advanceSample(aLab, { to: "drawing" }, db));
  check("Lab 1 goes last, once X-Ray is done", labLast === null, labLast?.message);

  console.log("\n── Lab 1 has a start of its own ─────────────────────────────");
  const b = await make("B");
  const bLab = await order(b.visitId, "lab", "Lipid");
  const bAbi = await order(b.visitId, "machine", "ABI");
  const skip = await refusal(() => advanceSample(bLab, { to: "sample_collected" }, db));
  check(
    "collected is refused without Start collection",
    skip?.status === 409 && /Start the collection/.test(skip.message),
    skip?.message,
  );
  await advanceSample(bLab, { to: "drawing" }, db);
  check("the order is at drawing", (await statusOf(bLab)) === "drawing");
  const twice = await refusal(() =>
    orderTests(b.visitId, { urgency: "today", tests: ["Lipid"] }, db),
  );
  check(
    "a test being drawn cannot be ordered a second time",
    twice?.status === 409 && /Already ordered/.test(twice.message),
    twice?.message ?? "it was ALLOWED",
  );
  const lab2 = await refusal(() => cancelDrawing(bLab, { room: "processing" }, db));
  check("the analyzer room cannot cancel Lab 1's start", lab2?.status === 403, lab2?.message);
  const abiBlocked = await machineCard("machine_room", b.visitId);
  check(
    "the machine card names Lab 1",
    abiBlocked?.heldElsewhere === true && /Lab 1/.test(abiBlocked?.blockedReason || ""),
    abiBlocked?.blockedReason,
  );
  const abiRefused = await refusal(() =>
    advanceMachineTest(bAbi, { to: "in_progress", station: "machine_room" }, db),
  );
  check("the machine start is refused while Lab 1 draws", abiRefused?.status === 409);
  await advanceSample(bLab, { to: "sample_collected" }, db);
  const abiAfter = await refusal(() =>
    advanceMachineTest(bAbi, { to: "in_progress", station: "machine_room" }, db),
  );
  check("sample collected releases the patient", abiAfter === null, abiAfter?.message);
  await withValue(bAbi, b.patientId, "ABI Left");
  await advanceMachineTest(bAbi, { to: "done", station: "machine_room" }, db);

  console.log("\n── Cancel start ─────────────────────────────────────────────");
  const c = await make("C");
  const cLab = await order(c.visitId, "lab", "TSH");
  const cAbi = await order(c.visitId, "machine", "ABI");
  await advanceSample(cLab, { to: "drawing" }, db);
  const undone = await cancelDrawing(cLab, { reason: "wrong patient" }, db);
  check("Lab 1 cancel puts the order back", undone.cancelled && (await statusOf(cLab)) === "paid");
  const { rows: trail } = await client.query(
    `SELECT track, status, meta FROM giniflow_lab_order_events WHERE lab_order_id = $1 ORDER BY seq`,
    [cLab],
  );
  check(
    "the start is erased and the cancel recorded with its reason",
    !trail.some((e) => e.status === "drawing") &&
      trail.some((e) => e.track === "station" && e.meta?.reason === "wrong patient"),
    trail.map((e) => `${e.track}/${e.status}`).join(" "),
  );
  await advanceMachineTest(cAbi, { to: "in_progress", station: "machine_room" }, db);
  const wrongStation = await refusal(() => cancelMachineStart(cAbi, { station: "xray" }, db));
  check("X-Ray cannot cancel a Machine Room start", wrongStation?.status === 403);
  const mUndone = await cancelMachineStart(cAbi, { station: "machine_room" }, db);
  check("the Machine Room can", mUndone.cancelled && (await statusOf(cAbi)) === "paid");
  const labFree = await refusal(() => advanceSample(cLab, { to: "drawing" }, db));
  check("and Lab 1 may start straight after", labFree === null, labFree?.message);

  console.log("\n── HealthRay cases lock the same way ────────────────────────");
  const h = await make("H");
  const hAbi = await order(h.visitId, "machine", "ABI");
  const caseNo = `ZZSL${Date.now()}`;
  await client.query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id, case_date,
                            results_synced, raw_list_json)
     VALUES ($1, $1, $1, 0, $2, $3::date, FALSE, '{}'::jsonb)`,
    [caseNo, h.patientId, day],
  );
  const caseSkip = await refusal(() => markLabCaseAction(caseNo, { action: "sample_taken" }, db));
  check("a case cannot be collected before it is started", caseSkip?.status === 409);
  await markLabCaseAction(caseNo, { action: "drawing_started" }, db);
  const caseBusy = await busyStations(db, [h.visitId]);
  check(
    "a started case holds the patient at Lab 1",
    caseBusy.get(h.visitId)?.[0]?.station === "lab_collection",
  );
  const hRefused = await refusal(() =>
    advanceMachineTest(hAbi, { to: "in_progress", station: "machine_room" }, db),
  );
  check("the machine waits for the case too", hRefused?.status === 409, hRefused?.message);
  await markLabCaseAction(caseNo, { action: "drawing_started", undo: true }, db);
  const hFree = await refusal(() =>
    advanceMachineTest(hAbi, { to: "in_progress", station: "machine_room" }, db),
  );
  check("undoing the start frees the patient", hFree === null, hFree?.message);

  console.log("\n── The coordinator's release ────────────────────────────────");
  const r = await make("R");
  const rAbi = await order(r.visitId, "machine", "VPT");
  const nothing = await refusal(() => releaseVisit(r.visitId, { reason: "check" }, db));
  check("nothing to release is refused", nothing?.status === 409);
  await advanceMachineTest(rAbi, { to: "in_progress", station: "machine_room" }, db);
  const released = await releaseVisit(r.visitId, { reason: "machine broke down" }, db);
  check(
    "a stuck start is released",
    released.released.length === 1 && (await statusOf(rAbi)) === "paid",
  );
  const { rows: log } = await client.query(
    `SELECT action, note FROM giniflow_triage_events WHERE visit_id = $1`,
    [r.visitId],
  );
  check(
    "and logged with its reason",
    log.some((e) => e.action === "station_release" && e.note === "machine broke down"),
  );

  console.log("\n── X-ray before Echo still holds ────────────────────────────");
  const e = await make("E");
  await order(e.visitId, "machine", "X-Ray");
  const eEcho = await order(e.visitId, "machine", "2D Echo");
  const echoFirst = await refusal(() =>
    advanceMachineTest(eEcho, { to: "in_progress", station: "echo" }, db),
  );
  check(
    "Echo is refused while X-ray is open",
    echoFirst?.status === 409 && /X-?Ray/i.test(echoFirst.message),
    echoFirst?.message,
  );
} catch (e) {
  check("the suite ran to the end", false, `threw: ${e.message}`);
} finally {
  await client.query("ROLLBACK");
  client.release();
  const { rows: left } = await pool.query(
    `SELECT count(*)::int AS c FROM patients WHERE file_no LIKE 'ZZSL_%'`,
  );
  check("the synthetic patients left no trace", left[0].c === 0, `${left[0].c} rows`);
  await pool.end();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}
