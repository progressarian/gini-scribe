// The MO / SD station.
//
// The rule that matters (brief §4.3): Close sends a patient to pharmacy without
// a doctor seeing them, and is green-category only. Everything else here is
// about the hand-off being complete — a patient passed on with no plan wastes
// the consultation the whole board exists to protect.
//
//   npm run smoke:giniflow-mo   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { getStationTimes } from "../services/giniflow/statusEngine.js";
import { NOT_A_MARKER_SQL, WAIT_SINCE_SQL } from "../../shared/giniflowStatus.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import {
  getMoQueue,
  releaseWorkup,
  takeOver,
  getMoPatient,
  startWorkup,
  savePlan,
  orderTests,
  readyForDoctor,
  closeWithoutDoctor,
  addProposal,
  withdrawProposal,
  getTestPanels,
  reviewReports,
} from "../services/giniflow/moStation.js";
import { getPaymentQueue } from "../services/giniflow/receptionStation.js";
import { addExternal, getDraft } from "../services/giniflow/prescription.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

const TEST_DAY = "2019-01-07";
const before = await one(`SELECT count(*)::int AS c FROM flow_visits`);

await cleanDemoDay();
await seedDemoDay({ date: TEST_DAY });

// ── Queue ───────────────────────────────────────────────────────────────────
const q = await getMoQueue(TEST_DAY);
const all = [
  ...q.withMe,
  ...q.waitingForMe,
  ...q.awaitingResults,
  ...q.missingReports,
  ...q.inPipeline,
  ...q.done,
];
check("the queue loads", all.length > 0, `${all.length} patients`);
check(
  "five working groups exist, not four",
  ["withMe", "waitingForMe", "awaitingResults", "missingReports", "done"].every((k) =>
    Array.isArray(q[k]),
  ),
);
check("counters are returned", typeof q.counters?.waitingForMe === "number");
check("a row carries its reports line", !!all[0].reports?.label, all[0].reports?.label);
check("a row knows whether it can be closed", typeof all[0].canClose === "boolean");
check(
  "a row carries the budget its wait is judged against",
  all.every((c) => "waitMinutes" in c && "waitBudget" in c && "waitColour" in c),
  "so the MO sees the same red the board does",
);
check(
  "the colour is one the stylesheet knows",
  all.every((c) => ["green", "amber", "red", "neutral"].includes(c.waitColour)),
  all[0].waitColour,
);

// ── Search runs in Postgres ────────────────────────────────────────────────
// Not in the browser: the whole day must be reachable, and a phone number is
// never sent to the client at all.
const anyone = all[0];
const byName = await getMoQueue(TEST_DAY, null, anyone.name.split(" ")[0]);
const flat = (g) => [
  ...g.withMe,
  ...g.waitingForMe,
  ...g.awaitingResults,
  ...g.missingReports,
  ...g.inPipeline,
  ...g.done,
  ...g.withOtherSd,
];
check(
  "searching by name finds the patient",
  flat(byName).some((c) => c.visitId === anyone.visitId),
  `"${anyone.name.split(" ")[0]}" → ${byName.matched} of ${byName.total}`,
);
check(
  "the counters still describe the whole day, not the search",
  byName.counters.withMe +
    byName.counters.waitingForMe +
    byName.counters.awaitingResults +
    byName.counters.missingReports +
    byName.counters.closedByMe ===
    q.counters.withMe +
      q.counters.waitingForMe +
      q.counters.awaitingResults +
      q.counters.missingReports +
      q.counters.closedByMe,
);

const byFile = await getMoQueue(TEST_DAY, null, anyone.fileNo);
check(
  "searching by file number finds the patient",
  flat(byFile).some((c) => c.visitId === anyone.visitId),
  anyone.fileNo,
);
check(
  "and hides everyone else",
  byFile.matched === 1 && byFile.total > 1,
  `${byFile.matched} of ${byFile.total}`,
);

const phone = await one(`SELECT phone FROM patients WHERE id = $1`, [anyone.patientId]);
if (phone?.phone) {
  const digits = phone.phone.replace(/\D/g, "");
  const byPhone = await getMoQueue(TEST_DAY, null, `${digits.slice(0, 5)} ${digits.slice(5)}`);
  check(
    "a phone number typed with a space still matches",
    flat(byPhone).some((c) => c.visitId === anyone.visitId),
    "digits are compared to digits",
  );
}

const noHits = await getMoQueue(TEST_DAY, null, "zzzzzznobody");
check(
  "a search that matches nobody returns empty groups",
  noHits.matched === 0 && noHits.total > 0,
);
check(
  "a % typed in the box is a character, not a wildcard",
  (await getMoQueue(TEST_DAY, null, "%")).matched === 0,
);

check(
  "the head of each queue reads Now / Next, not a clock time",
  all.every((c) => !!c.slot),
  `${all[0].name}: ${all[0].slot}`,
);

// ── Patient brief ───────────────────────────────────────────────────────────
const target = all.find((c) => !["ready_for_doctor", "doctor_done"].includes(c.status));
const patient = await getMoPatient(target.visitId);
check("the brief loads", !!patient && patient.visitId === target.visitId);
// The three states from vitals travel to the MO unchanged: "not known" is an
// answer — nobody has asked — and must not read as "no allergies".
check(
  "the allergy answer travels, in its three states",
  ["not_known", "none_known", "known"].includes(patient.allergyStatus) && "allergyNote" in patient,
  patient.allergyStatus,
);
check("no invented phase is returned", !("phase" in patient), "plan §3b.1");
check(
  "the brief exposes vitals, biomarkers, plan, proposals and orders",
  ["vitals", "biomarkers", "plan", "proposals", "orders"].every((k) => k in patient),
);

// ── MO-01: the queue belongs to the logged-in SD ────────────────────────────
const doctors = await pool.query(
  `SELECT id FROM doctors WHERE COALESCE(is_active, TRUE) ORDER BY id LIMIT 2`,
);
const [sdA, sdB] = doctors.rows.map((r) => r.id);
await pool.query(`UPDATE giniflow_visits SET current_status = 'vitals_done' WHERE id = $1`, [
  target.visitId,
]);
const inWorkingQueue = (q) =>
  [...q.withMe, ...q.waitingForMe, ...q.awaitingResults, ...q.missingReports].some(
    (c) => c.visitId === target.visitId,
  );

await pool.query(`UPDATE giniflow_visits SET assigned_sd_id = $2 WHERE id = $1`, [
  target.visitId,
  sdA,
]);
check(
  "an assigned patient is in their own SD's working queue",
  inWorkingQueue(await getMoQueue(TEST_DAY, sdA)),
);
const otherQueue = await getMoQueue(TEST_DAY, sdB);
check(
  "and not in another SD's",
  !inWorkingQueue(otherQueue),
  "brief §4.3: 'queue for the logged-in SD'",
);
check(
  "the other SD sees them as someone else's",
  otherQueue.withOtherSd.some((c) => c.visitId === target.visitId),
);

await pool.query(`UPDATE giniflow_visits SET assigned_sd_id = NULL WHERE id = $1`, [
  target.visitId,
]);
check(
  "an unassigned patient stays open to any MO",
  inWorkingQueue(await getMoQueue(TEST_DAY, sdB)),
  "first-claim, until triage owns assignment",
);

// ── Claiming ────────────────────────────────────────────────────────────────
// MO-02: claiming from before vitals would skip the vitals station entirely —
// no reading taken, the vitals budget measuring nothing, and the board showing
// the patient at the SD desk while they are still waiting for their BP.
await pool.query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
  target.visitId,
]);
const tooEarly = await startWorkup(target.visitId, null)
  .then(() => false)
  .catch((e) => e.status === 409);
check("claiming a patient who has not had vitals is refused", tooEarly);

await pool.query(`UPDATE giniflow_visits SET current_status = 'vitals_done' WHERE id = $1`, [
  target.visitId,
]);
await startWorkup(target.visitId, null);
const started = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
  target.visitId,
]);
check(
  "opening a patient moves them to with_sd",
  started.current_status === "with_sd",
  started.current_status,
);

// ── Hand-off requires a plan ───────────────────────────────────────────────
// The demo day seeds a plan for the doctor station to read, so this clears it
// first: the rule under test is "no plan, no hand-over", not "the seeder
// happens to leave one".
await pool.query(`DELETE FROM giniflow_sd_notes WHERE visit_id = $1`, [target.visitId]);
const noPlan = await readyForDoctor(target.visitId)
  .then(() => false)
  .catch((e) => e.status === 409);
check("handing over with no plan is refused", noPlan);

await savePlan(target.visitId, { plan: "TG tripled — start statin, review in 4 weeks." });
const withPlan = await getMoPatient(target.visitId);
check("the plan autosaves", withPlan.plan.startsWith("TG tripled"));

await savePlan(target.visitId, { plan: "Revised: start statin, recheck lipids in 6 weeks." });
const rows = await one(`SELECT count(*)::int AS c FROM giniflow_sd_notes WHERE visit_id = $1`, [
  target.visitId,
]);
check("editing updates in place rather than appending", rows.c === 1, `${rows.c} rows`);

// ── Ordering tests is trigger 2 ─────────────────────────────────────────────
const panels = await getTestPanels();
check("test panels load", panels.panels.length === 6, `${panels.panels.length}`);
check(
  "every test carries the gloss that says why an MO would pick it",
  panels.tests.every((t) => !!t.gloss),
  panels.tests
    .filter((t) => !t.gloss)
    .map((t) => t.name)
    .join(", ") || `${panels.tests.length} tests`,
);
check(
  "no test appears twice under two names",
  new Set(panels.tests.map((t) => t.name.toLowerCase().replace(/^vitamin /, "vit "))).size ===
    panels.tests.length,
);
check("a panel carries its tests", panels.panels[0].tests.length > 0);
check(
  "the catalogue carries prices",
  panels.tests.every((t) => t.price >= 0),
);

const receptionBefore = (await getPaymentQueue(TEST_DAY)).pending.length;
const ownerBefore = (
  await one(`SELECT assigned_sd_id FROM giniflow_visits WHERE id = $1`, [target.visitId])
).assigned_sd_id;
const order = await orderTests(target.visitId, {
  urgency: "today",
  tests: ["HbA1c", "Lipid panel"],
});
check("ordering returns a priced total", order.total > 0, `₹${order.total}`);
const stored = await one(`SELECT amount_total FROM giniflow_lab_orders WHERE id = $1`, [
  order.orderId,
]);
check(
  "the amount is stored on the order, not only displayed",
  Number(stored.amount_total) === order.total,
);

// 31 §5.2a: ordering today's tests ends the sitting. The patient goes to the
// lab, the desk is free for the next one, and they stay attached to this MO so
// the reports come back to them.
check("ordering today's tests sends the patient to the lab", order.sentToLab === true);
const afterOrder = await one(
  `SELECT current_status, assigned_sd_id FROM giniflow_visits WHERE id = $1`,
  [target.visitId],
);
check(
  "the MO's room is free again",
  afterOrder.current_status === "sd_pending",
  afterOrder.current_status,
);
check("but the patient is still theirs", afterOrder.assigned_sd_id === ownerBefore);

// The queue must now file them under "waiting on results", not "with me".
const labQueue = await getMoQueue(TEST_DAY, ownerBefore);
// The groups are spread onto the result, not nested under `groups`.
const landedIn = ["withMe", "waitingForMe", "awaitingResults", "missingReports", "done"].find((g) =>
  (labQueue[g] || []).some((r) => r.visitId === target.visitId),
);
check(
  "and they show in the MO's waiting-on-results list",
  landedIn === "awaitingResults",
  landedIn,
);

// Re-claim for the rest of the assertions below, which need them at the desk.
await startWorkup(target.visitId, ownerBefore);

const receptionAfter = (await getPaymentQueue(TEST_DAY)).pending;
check(
  "trigger 2: the order reaches reception",
  receptionAfter.length === receptionBefore + 1,
  `${receptionBefore} → ${receptionAfter.length}`,
);

// A next-visit order must not land on today's desks (lab plan §5b.1).
const later = await orderTests(target.visitId, { urgency: "next_visit", tests: ["TSH"] });
check("a next-visit order does not reach reception today", later.reachesReceptionToday === false);
const receptionLater = (await getPaymentQueue(TEST_DAY)).pending;
check("and reception's queue is unchanged by it", receptionLater.length === receptionAfter.length);

// MO-05: an uncatalogued test used to price at zero — the order created, the
// patient undercharged, and reception handed a total that did not cover it.
const unpriced = await orderTests(target.visitId, {
  urgency: "today",
  tests: ["HbA1c", "Unicorn panel"],
})
  .then(() => false)
  .catch((e) => e.status === 400);
check("a test that is not in the catalogue is refused, not priced at zero", unpriced);

// Every panel the screen offers must be orderable. The panels and the catalogue
// were seeded from different prototypes and did not agree — tapping "Lipid
// panel" ordered four tests, none of which had a price.
const panelTests = [...new Set(panels.panels.flatMap((p) => p.tests))];
const catalogued = new Set(panels.tests.map((t) => t.name));
check(
  "every test in every quick panel has a price",
  panelTests.every((t) => catalogued.has(t)),
  panelTests.filter((t) => !catalogued.has(t)).join(", ") ||
    `${panelTests.length} tests, all priced`,
);

const empty = await orderTests(target.visitId, { urgency: "today", tests: [] })
  .then(() => false)
  .catch((e) => e.status === 400);
check("ordering nothing is rejected", empty);

// MO-12: the same panel confirmed twice is two lab orders, two payment cards on
// reception's desk and two charges.
const dup = await orderTests(target.visitId, { urgency: "today", tests: ["HbA1c"] })
  .then(() => false)
  .catch((e) => e.status === 409);
check("re-ordering a test that has not been collected yet is refused", dup);

// ── Proposals ───────────────────────────────────────────────────────────────
const proposal = await addProposal(target.visitId, {
  medicineName: "Atchol",
  fromDose: "20mg",
  toDose: "40mg",
  reason: "LDL 127, target <100",
});
check(
  "a proposal is recorded",
  proposal.medicine_name === "Atchol" && proposal.status === "proposed",
);
await withdrawProposal(proposal.id);
const gone = await one(`SELECT count(*)::int AS c FROM giniflow_rx_proposals WHERE id = $1`, [
  proposal.id,
]);
check("a proposal can be withdrawn before hand-off", gone.c === 0);

// MO-15: the chain only moves forwards, so a mis-claim needs its own exit.
const beforeRelease = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
  target.visitId,
]);
await releaseWorkup(target.visitId, null);
const released = await one(
  `SELECT current_status, assigned_sd_id FROM giniflow_visits WHERE id = $1`,
  [target.visitId],
);
check(
  "an MO can put a wrongly-claimed patient back",
  released.current_status === "sd_pending" && released.assigned_sd_id === null,
  `${beforeRelease.current_status} → ${released.current_status}`,
);
const releaseEvent = await one(
  `SELECT meta FROM giniflow_visit_events WHERE visit_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
  [target.visitId],
);
check("and the correction is recorded, not silent", releaseEvent.meta?.released === true);
const twice = await releaseWorkup(target.visitId, null)
  .then(() => false)
  .catch((e) => e.status === 409);
check("releasing a patient who is not at your desk is refused", twice);

// The plan survives the release, so the work is not thrown away.
const kept = await getMoPatient(target.visitId);
check("the plan written before the release is kept", kept.plan.startsWith("Revised:"));
await startWorkup(target.visitId, null);

// MO-09: a tile shows a change, and a change needs the reading it changed from.
check(
  "the brief carries the previous readings a trend needs",
  "previousBiomarkers" in kept && Array.isArray(kept.biomarkerHistory),
);

// ── Plan §6 rule 3: one MO per patient, enforced by the service ────────────
// The screen hides the buttons; a hidden button is not a rule, and the action
// behind one of them sends a patient home without a doctor seeing them.
await pool.query(`UPDATE giniflow_visits SET assigned_sd_id = $2 WHERE id = $1`, [
  target.visitId,
  sdA,
]);
const notMine = (fn) =>
  fn()
    .then(() => false)
    .catch((e) => e.status === 409);
check(
  "another MO cannot write a plan on somebody else's patient",
  await notMine(() => savePlan(target.visitId, { plan: "not mine", actorId: sdB })),
);
check(
  "nor order tests on them",
  await notMine(() =>
    orderTests(target.visitId, { urgency: "today", tests: ["CBC"], actorId: sdB }),
  ),
);
check("nor hand them over", await notMine(() => readyForDoctor(target.visitId, sdB)));
check(
  "nor close them — the action that skips the doctor",
  await notMine(() => closeWithoutDoctor(target.visitId, sdB)),
);
check("nor put them back in the queue", await notMine(() => releaseWorkup(target.visitId, sdB)));
check(
  "the MO who holds them still can",
  !!(await savePlan(target.visitId, {
    plan: "Revised: start statin, recheck lipids in 6 weeks.",
    actorId: sdA,
  })),
);

const handover = await takeOver(target.visitId, sdB);
check("taking over reassigns the patient", handover.takenOver === true && handover.from === sdA);
const handoverEvent = await one(
  `SELECT actor_id, meta FROM giniflow_visit_events WHERE visit_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
  [target.visitId],
);
check(
  "and is recorded against both MOs, not silent",
  handoverEvent.actor_id === sdB && handoverEvent.meta?.taken_over_from === sdA,
);
check(
  "after taking over, the write goes through",
  !!(await savePlan(target.visitId, {
    plan: "Revised: start statin, recheck lipids in 6 weeks.",
    actorId: sdB,
  })),
);
check(
  "taking over a patient already yours is a no-op, not an error",
  (await takeOver(target.visitId, sdB)).takenOver === false,
);
await pool.query(`UPDATE giniflow_visits SET assigned_sd_id = NULL WHERE id = $1`, [
  target.visitId,
]);

// ── Close is gated on the MO reading the reports, not on the category ───────
// 31-MO-LED-CLOSURE-PLAN §4 D1. The category stopped being the gate: what the
// close now requires is that an MO read the reports and said they were normal.
const hasOrders = await one(
  `SELECT count(*)::int AS n FROM giniflow_lab_orders WHERE visit_id = $1`,
  [target.visitId],
);

if (hasOrders.n > 0) {
  const refusedUnreviewed = await closeWithoutDoctor(target.visitId, sdA)
    .then(() => false)
    .catch((e) => e.status === 409);
  check("closing before the reports are read is refused", refusedUnreviewed);

  await pool.query(`UPDATE giniflow_visits SET results_status = 'ready' WHERE id = $1`, [
    target.visitId,
  ]);
  await reviewReports(target.visitId, { outcome: "needs_consultant", actorId: sdA });
  const refusedReferred = await closeWithoutDoctor(target.visitId, sdA)
    .then(() => false)
    .catch((e) => e.status === 409);
  check("closing a patient the MO referred on is refused", refusedReferred);

  await reviewReports(target.visitId, { outcome: "normal", actorId: sdA });
} else {
  check("the target has lab orders to gate the close on", false);
}

// Finalize's own rule, inherited by this path rather than re-implemented: a
// medicine nobody decided cannot ride out on a prescription.
const refusedUndecided = await closeWithoutDoctor(target.visitId, sdA)
  .then(() => false)
  .catch((e) => e.status === 409 && e.pendingProposals > 0);
check("closing with an undecided proposal is refused", refusedUndecided);

await pool.query(`UPDATE giniflow_rx_items SET approval_status = 'approved' WHERE visit_id = $1`, [
  target.visitId,
]);
await pool.query(
  `UPDATE giniflow_rx_proposals SET status = 'rejected' WHERE visit_id = $1 AND status = 'proposed'`,
  [target.visitId],
);

// ── A marker is a fact, not a place ───────────────────────────────────────
// A report landing mid-wait used to be the "latest event", which is what the
// board reads as the start of the current wait — so a patient ninety minutes
// overdue turned green at the moment they were most overdue, and the SLA
// figures scored a five-minute fragment as a station hop kept within budget.
{
  const p = await one(
    `INSERT INTO patients (name, file_no, age, sex, phone)
     VALUES ('Demo Marker Timeline', 'ZZMRK_1', 61, 'Female', '9888700002')
     ON CONFLICT (file_no) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  const v = await one(
    `INSERT INTO giniflow_visits (patient_id, visit_date, current_status)
     VALUES ($1, $2::date, 'sd_pending')
     ON CONFLICT (patient_id, visit_date) DO UPDATE SET current_status = 'sd_pending'
     RETURNING id`,
    [p.id, TEST_DAY],
  );
  const at = async (status, minsAgo, role = "system") =>
    pool.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, $2, $3, NOW() - make_interval(mins => $4))`,
      [v.id, status, role, minsAgo],
    );
  await at("checked_in", 120, "reception");
  await at("sd_pending", 90);
  await at("results_received", 70, "lab");

  const times = await getStationTimes(pool, v.id, {});
  const wait = times.find((t) => t.status === "sd_pending");
  check(
    "a wait interrupted by a report keeps its whole length",
    wait && wait.totalMinutes >= 85,
    `${wait?.totalMinutes}m`,
  );
  const marker = times.find((t) => t.status === "results_received");
  check("the report is still on the timeline", !!marker);
  check(
    "as a dated fact with no duration",
    marker?.timestampOnly === true && marker.totalMinutes === 0,
  );
  check("named, not shown as a raw key", marker?.label === "Reports arrived", marker?.label);
  check("and in the order it happened", times.indexOf(marker) > times.indexOf(wait));

  // The other marker the MO writes. It was missing from the label table, so the
  // patient's timeline rendered the database key.
  await at("reports_reviewed", 60, "mo_sd");
  const withReview = await getStationTimes(pool, v.id, {});
  const reviewed = withReview.find((t) => t.status === "reports_reviewed");
  check(
    "the MO's reading is named too",
    reviewed?.label === "Reports read by the MO",
    reviewed?.label,
  );
  check("and carries no minutes either", reviewed?.totalMinutes === 0);

  // "Not my patient" must not restart the clock. A patient waiting since 12:17,
  // taken at 13:26 and handed back at 13:28 read as "0m" — the board turning
  // green at the exact moment somebody had looked at them and put them back.
  await at("with_sd", 45, "mo_sd");
  await pool.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at, meta)
     VALUES ($1, 'sd_pending', 'mo_sd', NOW() - make_interval(mins => 43), '{"released":true}')`,
    [v.id],
  );
  const releasedSince = await one(
    `SELECT e.status, EXTRACT(EPOCH FROM (NOW() - e.occurred_at)) / 60 AS mins
       FROM giniflow_visit_events e,
            (SELECT 'sd_pending'::text AS current_status) v
      WHERE e.visit_id = $1 AND ${WAIT_SINCE_SQL("e", "v")}
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1`,
    [v.id],
  );
  check(
    "a release does not restart the wait",
    Math.round(releasedSince.mins) >= 85,
    `${Math.round(releasedSince.mins)}m since ${releasedSince.status}`,
  );
  check(
    "and the room that handed them back is not the start of it",
    releasedSince.status !== "with_sd",
  );

  // A patient actually IN the room is timed from entering it — that is what a
  // station's own "at my desk" clock means.
  const atDesk = await one(
    `SELECT e.status, EXTRACT(EPOCH FROM (NOW() - e.occurred_at)) / 60 AS mins
       FROM giniflow_visit_events e,
            (SELECT 'with_sd'::text AS current_status) v
      WHERE e.visit_id = $1 AND ${WAIT_SINCE_SQL("e", "v")}
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1`,
    [v.id],
  );
  check(
    "but a patient in the room is timed from entering it",
    atDesk.status === "with_sd",
    atDesk.status,
  );

  // What the board reads to time the current wait.
  const since = await one(
    `SELECT e.status FROM giniflow_visit_events e
      WHERE e.visit_id = $1 AND ${NOT_A_MARKER_SQL("e.status")}
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1`,
    [v.id],
  );
  check(
    "the wait clock still reads from a real status",
    since.status === "sd_pending",
    since.status,
  );

  await pool.query(`DELETE FROM giniflow_visits WHERE id = $1`, [v.id]);
  await pool.query(`DELETE FROM patients WHERE file_no = 'ZZMRK_1'`);
}

const medsBefore = await one(
  `SELECT count(*)::int AS n FROM medications m
     JOIN giniflow_visits v ON v.patient_id = m.patient_id
    WHERE v.id = $1 AND m.is_active`,
  [target.visitId],
);

const closed = await closeWithoutDoctor(target.visitId, sdA);
check("a reviewed patient can be closed", closed.skippedDoctor === true);

const final = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
  target.visitId,
]);
// Past the consultant and on to the Rx desk — the same place a consultant's own
// finalize leaves a patient, because it is the same finalize.
check(
  "closing sends them past the doctor to the Rx desk",
  final.current_status === "rx_pending",
  final.current_status,
);

// ...and the MO can still see who they closed. The queue stopped at doctor_done
// while the close advances past it, so a patient the MO ended vanished off their
// screen entirely — no card, no record of the decision, no way back in.
const afterClose = await getMoQueue(TEST_DAY, sdA);
const stillListed = (afterClose.done || []).some((r) => r.visitId === target.visitId);
check("a closed patient stays on the MO's own Done list", stillListed);

// An order for another day gates nothing today. Counting it left the patient
// unclosable for ever: results_status could never reach "ready", so the review
// was refused and the close refused for wanting the review.
{
  // Its own patient: whether the demo day happens to leave somebody in this
  // group is not what the check is about.
  const p = await one(
    `INSERT INTO patients (name, file_no, age, sex, phone)
     VALUES ('Demo Next Visit Order', 'ZZMOG_1', 54, 'Male', '9888700001')
     ON CONFLICT (file_no) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  const v = await one(
    `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
     VALUES ($1, $2::date, 'vitals_done', 'ready')
     ON CONFLICT (patient_id, visit_date)
       DO UPDATE SET current_status = 'vitals_done', results_status = 'ready'
     RETURNING id`,
    [p.id, TEST_DAY],
  );
  const before = await getMoQueue(TEST_DAY, sdA);
  check(
    "a patient with nothing outstanding waits for the MO",
    (before.waitingForMe || []).some((r) => r.visitId === v.id),
  );

  const later = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total, sample_status)
     VALUES ($1, 'next_visit', 'pending', 500, 'ordered') RETURNING id`,
    [v.id],
  );
  const after = await getMoQueue(TEST_DAY, sdA);
  check(
    "an order for the NEXT visit does not put them on results-watch",
    !(after.awaitingResults || []).some((r) => r.visitId === v.id),
  );
  check(
    "they stay ready to be seen",
    (after.waitingForMe || []).some((r) => r.visitId === v.id),
  );

  // The same order raised for TODAY is a real wait — the distinction the whole
  // fix rests on.
  await pool.query(`UPDATE giniflow_lab_orders SET urgency = 'today' WHERE id = $1`, [later.id]);
  await pool.query(`UPDATE giniflow_visits SET results_status = 'none' WHERE id = $1`, [v.id]);
  const todayQ = await getMoQueue(TEST_DAY, sdA);
  check(
    "the same order raised for today does",
    (todayQ.awaitingResults || []).some((r) => r.visitId === v.id),
  );

  await pool.query(`DELETE FROM giniflow_lab_orders WHERE id = $1`, [later.id]);
  await pool.query(`DELETE FROM giniflow_visits WHERE id = $1`, [v.id]);
  await pool.query(`DELETE FROM patients WHERE file_no = 'ZZMOG_1'`);
}

// The gap this whole plan exists to close (31 §3 G4): before, the draft stayed
// a draft and the patient reached the pharmacy with nothing.
const medsAfter = await one(
  `SELECT count(*)::int AS n FROM medications m
     JOIN giniflow_visits v ON v.patient_id = m.patient_id
    WHERE v.id = $1 AND m.is_active`,
  [target.visitId],
);
const draftLeft = await one(
  `SELECT count(*)::int AS n FROM giniflow_rx_items WHERE visit_id = $1`,
  [target.visitId],
);
check(
  "closing writes the prescription, not just the status",
  medsAfter.n > 0 && draftLeft.n === 0,
  `${medsBefore.n}→${medsAfter.n} active, ${draftLeft.n} draft rows left`,
);

const ev = await one(
  `SELECT actor_role, meta FROM giniflow_visit_events
    WHERE visit_id = $1 AND status = 'doctor_done' ORDER BY occurred_at DESC LIMIT 1`,
  [target.visitId],
);
check("the close is attributed to the MO", ev.actor_role === "mo_sd", ev.actor_role);
check("and records that the doctor was skipped", ev.meta?.closed_by_sd === true);

// ── Hand-off ────────────────────────────────────────────────────────────────
const second =
  (await getMoQueue(TEST_DAY)).waitingForMe[0] || (await getMoQueue(TEST_DAY)).withMe[0];
if (second) {
  await startWorkup(second.visitId, null);
  await savePlan(second.visitId, { plan: "Stable. For review." });
  await readyForDoctor(second.visitId);
  const handed = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
    second.visitId,
  ]);
  check(
    "handing over moves the patient to the doctor queue",
    handed.current_status === "ready_for_doctor",
    handed.current_status,
  );
}

// ── What the patient is already taking (24-ADDENDUM-V11-PLAN.md §5.2) ────────
// Medicines from another hospital have to be on the chart before an MO proposes
// a dose change, and they must stay distinguishable from what this clinic
// prescribed — an outside drug is a fact to work around, not an order to repeat.
{
  const v = await one(
    `SELECT id, patient_id FROM giniflow_visits WHERE visit_date = $1::date LIMIT 1`,
    [TEST_DAY],
  );
  const ext = await addExternal(v.patient_id, {
    medicineName: "Ramipril 5mg",
    prescriberName: "Dr. Gupta",
    hospitalName: "PGI",
    dose: "5mg",
    condition: "Hypertension",
  });
  check("an outside medicine reaches the chart", !!ext?.id && ext.name === "Ramipril 5mg");
  check("attributed to the doctor who prescribed it", ext.external_doctor === "Dr. Gupta");
  const marked = await one(`SELECT med_group, external_doctor FROM medications WHERE id = $1`, [
    ext.id,
  ]);
  check(
    "and is filed as external, not as something this clinic wrote",
    marked.med_group === "external",
    marked.med_group,
  );
  // The MO reads the medicine list through the prescription draft — the same
  // component the consultant uses — so that is where it has to appear.
  const rx = await getDraft(v.id);
  check(
    "the MO sees it beside the rest of the medicine list",
    rx.external.some((m) => m.name === "Ramipril 5mg"),
    `${rx.external.length} external`,
  );
  check(
    "and it stays out of the list this clinic is prescribing",
    !rx.items.some((i) => i.name === "Ramipril 5mg"),
  );
}

await cleanDemoDay();
const after = await one(`SELECT count(*)::int AS c FROM flow_visits`);
check("old flow_* module untouched", after.c === before.c, `${before.c}→${after.c}`);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
