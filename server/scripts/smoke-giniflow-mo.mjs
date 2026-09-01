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
} from "../services/giniflow/moStation.js";
import { getPaymentQueue } from "../services/giniflow/receptionStation.js";

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
check(
  "allergies are null, not an empty list",
  patient.allergies === null,
  "so the screen says 'not recorded' rather than 'none'",
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

// ── Close is green-only ─────────────────────────────────────────────────────
await pool.query(`UPDATE giniflow_visits SET category = 'worse_out_of_range' WHERE id = $1`, [
  target.visitId,
]);
const refused = await closeWithoutDoctor(target.visitId)
  .then(() => false)
  .catch((e) => e.status === 409);
check("closing a red-category patient is refused by the service", refused);

await pool.query(`UPDATE giniflow_visits SET category = 'in_control' WHERE id = $1`, [
  target.visitId,
]);
const closed = await closeWithoutDoctor(target.visitId);
check("a green-category patient can be closed", closed.skippedDoctor === true);
const final = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
  target.visitId,
]);
check(
  "closing sends them past the doctor",
  final.current_status === "doctor_done",
  final.current_status,
);

const ev = await one(
  `SELECT actor_role, meta FROM giniflow_visit_events
    WHERE visit_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
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

await cleanDemoDay();
const after = await one(`SELECT count(*)::int AS c FROM flow_visits`);
check("old flow_* module untouched", after.c === before.c, `${before.c}→${after.c}`);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
