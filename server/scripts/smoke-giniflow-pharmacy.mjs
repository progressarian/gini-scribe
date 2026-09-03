// Pharmacy station: the queue, the counselling note, per-medicine dispensing,
// and the exit — docs/gini-flow/16-PHARMACY-STATION-PLAN.md §10.
//
// Runs against a day of its own (never today's real floor), and cleans up.
//
//   npm run smoke:giniflow-pharmacy   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import {
  getPharmacyQueue,
  getPharmacyPatient,
  dispenseItem,
  dispenseAll,
  sendCardToPatient,
} from "../services/giniflow/pharmacyStation.js";
import { buildCounsellingNote } from "../services/giniflow/counsellingNote.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

const TEST_DAY = "2019-01-05";

// ── The counselling note — pure, no database ────────────────────────────────
console.log("\ncounselling note");

const note = buildCounsellingNote([
  { medicationId: 1, name: "Atchol", dose: "40mg", previousDose: "20mg", changeType: "changed" },
  {
    medicationId: 2,
    name: "Fenofibrate",
    dose: "145mg",
    changeType: "new",
    reason: "very high triglycerides",
  },
  { medicationId: 3, name: "Cospiaq", dose: "25mg", changeType: "continued" },
  { medicationId: 4, name: "Pantoprazole", dose: "40mg", changeType: "new", external: true },
]);

check("Hindi is written first and is not empty", note.hindi.startsWith("आज की दवाइयाँ:"));
check("English follows it", /Two changes today/.test(note.english), note.english.slice(0, 40));
check(
  "it names exactly the changed and new medicines",
  note.changes.map((c) => c.name).join(",") === "Atchol,Fenofibrate",
  note.changes.map((c) => c.name).join(","),
);
check("a continued medicine is not called a change", !/Cospiaq/.test(note.english));
check(
  "an external medicine is never counselled on by this pharmacy",
  !/Pantoprazole/.test(note.english),
);
check(
  "the dose it changed from survives into the sentence",
  /20mg/.test(note.english) && /40mg/.test(note.english),
);

const quiet = buildCounsellingNote([{ name: "Cospiaq", changeType: "continued" }]);
check("no changes reads as no changes, in both languages", !quiet.hasChanges && !!quiet.hindi);

// ── The floor ───────────────────────────────────────────────────────────────
await cleanDemoDay();
await seedDemoDay({ date: TEST_DAY });

console.log("\npharmacy queue");

let queue = await getPharmacyQueue(TEST_DAY);
check(
  "the queue has patients waiting to be dispensed",
  queue.toDispense.length > 0,
  `${queue.toDispense.length}`,
);
check(
  "and patients already dispensed today",
  queue.dispensed.length > 0,
  `${queue.dispensed.length}`,
);
// `counts.dispensed` is no longer the length of the list. The list holds every
// finished visit, and `DONE_STATUSES` includes `exited` — so on a real day it is
// full of visits the HealthRay sync closed, which this counter never touched.
// The count now reports only what was dispensed HERE, and `closedElsewhere` the
// rest; together they are still the whole list.
check(
  "three counts, and they match the lists",
  queue.counts.toDispense === queue.toDispense.length &&
    queue.counts.dispensed + queue.counts.closedElsewhere === queue.dispensed.length,
  `${queue.counts.dispensed} dispensed + ${queue.counts.closedElsewhere} closed elsewhere of ${queue.dispensed.length}`,
);
check(
  "stock warnings read 0 while the inventory is empty, never a false 'in stock'",
  queue.counts.stockWarnings === 0 && queue.toDispense.every((c) => c.stock === null),
);
check(
  "a card carries the finalized time, not the check-in time",
  queue.toDispense.every((c) => "finalizedAt" in c && "since" in c),
);
check(
  "the timer is coloured against the pharmacy budget",
  ["green", "amber", "red", "neutral"].includes(queue.toDispense[0].waitColour),
  queue.toDispense[0].waitColour,
);

const target = queue.toDispense[0];
const patientId = (
  await one(`SELECT patient_id FROM giniflow_visits WHERE id = $1`, [target.visitId])
).patient_id;

// The demo day seeds a floor, not a prescription. Give this patient a real one:
// three Gini medicines and one from another doctor.
await pool.query(
  `INSERT INTO medications
     (patient_id, name, pharmacy_match, dose, frequency, timing_category, time_of_day,
      change_type, clinical_note, instructions, is_active, last_prescribed_date)
   VALUES
     ($1, 'Cospiaq SM', 'COSPIAQ SM', '25mg', 'OD', 'with_breakfast', '08:00', 'continued',
      'Diabetes', 'Always take with food', true, $2::date),
     ($1, 'Atchol', 'ATCHOL', '40mg', 'OD', 'bedtime', '22:00', 'changed',
      'LDL 127', 'Take at bedtime', true, $2::date),
     ($1, 'Fenofibrate 145', 'FENOFIBRATE', '145mg', 'OD', 'with_lunch', '13:30', 'new',
      'TG 368', 'Take with lunch only', true, $2::date)
   ON CONFLICT DO NOTHING`,
  [patientId, TEST_DAY],
);
await pool.query(
  `INSERT INTO medications
     (patient_id, name, dose, external_doctor, timing_category, time_of_day, change_type, is_active)
   VALUES ($1, 'Pantoprazole 40', '40mg', 'Dr. Anand Sharma — Fortis', 'before_breakfast',
           '07:00', 'continued', true)
   ON CONFLICT DO NOTHING`,
  [patientId],
);
await pool.query(
  `UPDATE medications SET previous_dose = '20mg' WHERE patient_id = $1 AND name = 'Atchol'`,
  [patientId],
);

console.log("\nthe card at the counter");

let card = await getPharmacyPatient(target.visitId);
check("the pane opens on a real patient", !!card && card.visitId === target.visitId);
check(
  "it counts Gini medicines apart from external ones",
  card.totals.gini === 3 && card.totals.external === 1,
  `${card.totals.gini}/${card.totals.external}`,
);
check("nothing is dispensed yet", card.totals.pending === 3 && card.totals.given === 0);
check(
  "the counselling note names the changed and new medicines and nothing else",
  card.counselling.changes
    .map((c) => c.name)
    .sort()
    .join(",") === "Atchol,Fenofibrate 145",
  card.counselling.changes.map((c) => c.name).join(","),
);

const allMeds = card.card.groups.flatMap((g) => g.medicines);
const external = allMeds.find((m) => m.external);
check("the external medicine is shown", !!external, external?.name);
check("…with no dispense control", external?.dispensable === false);
check("…and its prescriber's name", !!external?.prescriber, external?.prescriber);
check(
  "every Gini row carries what the counter reads out",
  allMeds
    .filter((m) => m.dispensable)
    .every((m) => "instruction" in m && "form" in m && "route" in m && "note" in m),
);
check(
  "no stock line is invented for a medicine the inventory does not know",
  allMeds.every((m) => m.stock === null),
);

console.log("\ndispensing");

const gini = allMeds.filter((m) => m.dispensable);
await dispenseItem(target.visitId, gini[0].medicationId, {
  status: "given",
  actorName: "Smoke Pharmacist",
});
card = await getPharmacyPatient(target.visitId);
check(
  "one medicine marked given lands on the card",
  card.totals.given === 1,
  `${card.totals.given}`,
);

let refusedExternal = false;
try {
  await dispenseItem(target.visitId, external.medicationId, { status: "given" });
} catch (e) {
  refusedExternal = /outside Gini/.test(e.message);
}
check("an external medicine cannot be dispensed by this pharmacy", refusedExternal);

let refusedBlank = false;
try {
  await dispenseItem(target.visitId, gini[1].medicationId, { status: "not_given", reason: "  " });
} catch (e) {
  refusedBlank = /why the medicine was not given/.test(e.message);
}
check("marking not-given without a reason is refused", refusedBlank);

await dispenseItem(target.visitId, gini[1].medicationId, {
  status: "not_given",
  reason: "Out of stock",
  actorName: "Smoke Pharmacist",
});
card = await getPharmacyPatient(target.visitId);
check("a not-given row keeps its reason", card.totals.notGiven === 1);
check(
  "…and blocks the blanket button — it becomes 'Dispense the rest'",
  card.blockedByNotGiven === true,
);

console.log("\nthe exit");

const result = await dispenseAll(target.visitId, { actorName: "Smoke Pharmacist" });
check(
  "dispense-all reports what it did",
  result.dispensed && result.marked === 1,
  `${result.marked} marked`,
);
check(
  "…and says the visit was only partly dispensed",
  result.partial && result.notGiven.length === 1,
);

const marks = await pool.query(
  `SELECT m.name, m.external_doctor, mc.status
     FROM medications m
     LEFT JOIN medicine_collections mc
       ON mc.medication_id = m.id AND mc.collected_date = $2::date
    WHERE m.patient_id = $1 AND m.is_active = true`,
  [patientId, TEST_DAY],
);
check(
  "a collection row exists for every Gini medicine",
  marks.rows.filter((r) => !r.external_doctor).every((r) => !!r.status),
);
check(
  "and none for the external one",
  marks.rows.filter((r) => r.external_doctor).every((r) => r.status === null),
);
check(
  "the not-given row was NOT overwritten as given",
  marks.rows.filter((r) => r.status === "not_given").length === 1,
);

const events = await pool.query(
  `SELECT status, actor_role FROM giniflow_visit_events
    WHERE visit_id = $1 AND status = ANY('{dispensed,exited}') ORDER BY occurred_at, id`,
  [target.visitId],
);
check(
  "dispensed and exited are both logged, once each, in order",
  events.rows.length === 2 &&
    events.rows[0].status === "dispensed" &&
    events.rows[1].status === "exited",
  events.rows.map((e) => e.status).join(" → "),
);
check(
  "…attributed to the pharmacy",
  events.rows.every((e) => e.actor_role === "pharmacy"),
);

const finished = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
  target.visitId,
]);
check("the visit is over", finished.current_status === "exited");

// The WhatsApp send happens after the commit — a send failure can never undo a
// dispensed visit, and the route calls it separately for exactly that reason.
let noPhone = false;
try {
  await sendCardToPatient(target.visitId, { force: true });
} catch (e) {
  noPhone = /no phone number/.test(e.message);
}
check("a patient with no phone is told so, not silently skipped", noPhone);

await pool.query(`UPDATE patients SET phone = '919999900001' WHERE id = $1`, [patientId]);

// PH-01. Without an approved template MSG91 logs instead of sending. The station
// must NOT record that as sent: `card_sent_at` is also the idempotency guard, so
// stamping a no-op would mark the patient as served and stop the real send from
// ever reaching them once the template goes live.
const attempt = await sendCardToPatient(target.visitId, { force: true });
const stamp = await one(`SELECT card_sent_at FROM giniflow_visits WHERE id = $1`, [target.visitId]);
if (attempt.dev) {
  check("a card that was only logged is not reported as sent", attempt.sent === false);
  check("…and says why, in words the counter can act on", /template/.test(attempt.reason || ""));
  check(
    "…and leaves card_sent_at unstamped, so a real send can still reach them",
    !stamp.card_sent_at,
  );
} else {
  check("the medicine card can be sent to the patient", attempt.sent === true);
  check("…and the send is recorded", !!stamp.card_sent_at);
  const idempotent = await sendCardToPatient(target.visitId);
  check(
    "…and the automatic send does not fire twice for one visit",
    idempotent.alreadySent === true,
  );
}

// The guard itself, independent of whether this environment can really send.
await pool.query(`UPDATE giniflow_visits SET card_sent_at = NOW() WHERE id = $1`, [target.visitId]);
const guarded = await sendCardToPatient(target.visitId);
check("a visit whose card is already sent is not sent a second one", guarded.alreadySent === true);
await pool.query(`UPDATE giniflow_visits SET card_sent_at = NULL WHERE id = $1`, [target.visitId]);

let closedTwice = false;
try {
  await dispenseAll(target.visitId, {});
} catch (e) {
  closedTwice = /already been dispensed/.test(e.message);
}
check("closing the same visit twice is refused", closedTwice);

queue = await getPharmacyQueue(TEST_DAY);
check(
  "the patient has moved from To dispense to Dispensed today",
  !queue.toDispense.some((c) => c.visitId === target.visitId) &&
    queue.dispensed.some((c) => c.visitId === target.visitId),
);

await pool.query(`DELETE FROM medicine_collections WHERE patient_id = $1`, [patientId]);
await pool.query(`DELETE FROM medications WHERE patient_id = $1`, [patientId]);
await cleanDemoDay();
const leftover = await one(
  `SELECT count(*)::int AS n FROM giniflow_visits WHERE visit_date = $1::date`,
  [TEST_DAY],
);
check("demo day cleaned up", leftover.n === 0, `${leftover.n} left`);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
