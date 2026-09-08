// The journey reception builds at check-in, and the tick that keeps it honest.
//
// What these checks are really about: the plan must agree with the board at
// every moment, without the floor pressing anything extra, and it must never
// claim work that did not happen.
//
//   npm run smoke:giniflow-journey   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import {
  defaultPlan,
  suggestVisitType,
  checkInWithJourney,
  getJourney,
  ensurePlan,
  addStep,
  removeStep,
  reorderSteps,
  setStepStatus,
  insertLabStepsForOrder,
  syncLabStepsFromLab,
  trackByToken,
} from "../services/giniflow/journey.js";
import { advanceStatus } from "../services/giniflow/statusEngine.js";
import { clearPayment } from "../services/giniflow/receptionStation.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

// ⚠️ This writes to the production database. Its rows are cleaned up whatever
// happens — a check that throws halfway must not leave demo visits and ZZJRN_*
// patients on a real floor.
const madeVisits = [];
const cleanUp = async () => {
  try {
    if (madeVisits.length) {
      await pool.query(`DELETE FROM giniflow_visits WHERE id = ANY($1::uuid[])`, [madeVisits]);
    }
    await pool.query(`DELETE FROM patients WHERE file_no LIKE 'ZZJRN_%'`);
    await cleanDemoDay();
  } catch (e) {
    console.error("cleanup failed:", e.message);
  } finally {
    await pool.end();
  }
};
process.on("uncaughtException", async (e) => {
  console.error(e);
  await cleanUp();
  process.exit(1);
});
process.on("unhandledRejection", async (e) => {
  console.error(e);
  await cleanUp();
  process.exit(1);
});

const TEST_DAY = "2019-01-04";
const before = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS flow,
          (SELECT count(*)::int FROM flow_step_catalog) AS cat`,
);

await cleanDemoDay();
await seedDemoDay({ date: TEST_DAY });

// A visit nobody has checked in yet.
const bookedVisit = async (suffix, name) => {
  const p = await one(
    `INSERT INTO patients (name, file_no, age, sex, phone)
     VALUES ($2, $1, 44, 'Male', $3)
     ON CONFLICT (file_no) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [`ZZJRN_${suffix}`, name, `98888${suffix}`],
  );
  const visit = await one(
    `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_time, current_status, is_demo)
     VALUES ($1, $2::date, '10:00', 'booked', TRUE)
     ON CONFLICT (patient_id, visit_date)
       DO UPDATE SET current_status = 'booked', visit_type_id = NULL,
                     planned_total_min = NULL, visit_token = NULL
     RETURNING id`,
    [p.id, TEST_DAY],
  );
  madeVisits.push(visit.id);
  return visit;
};

// ── The catalog is data, and the mapping with it ────────────────────────────
const mapped = await one(
  `SELECT count(*) FILTER (WHERE chain_status IS NOT NULL)::int AS on_chain,
          count(*) FILTER (WHERE chain_status IS NULL)::int AS off_chain
     FROM flow_step_catalog`,
);
check("catalog steps carry a board column where they have one", mapped.on_chain > 0);
check(
  "and the ones the board has no column for stay unmapped",
  mapped.off_chain > 0,
  `${mapped.off_chain} off-chain`,
);

const suggestion = await suggestVisitType({ isFollowUp: true, isWalkIn: false });
check("a follow-up appointment suggests a visit type", !!suggestion, suggestion);
const walkIn = await suggestVisitType({ isFollowUp: false, isWalkIn: true });
check("a new walk-in suggests a different one", !!walkIn && walkIn !== suggestion, walkIn);
const unknown = await suggestVisitType({ isFollowUp: null, isWalkIn: null });
check("and nothing is guessed when the flags do not match", unknown === null || !!unknown);
// A booking HealthRay calls an investigation is a patient here to give samples
// and leave, not to be offered an hour of consultation.
const testsOnly = await suggestVisitType({ isFollowUp: true, isWalkIn: false, isTests: true });
check("a tests-only booking suggests the tests journey", !!testsOnly, testsOnly);
check("which is not the ordinary follow-up one", testsOnly !== suggestion);

const plan = await defaultPlan(suggestion);
check("the type's template becomes an editable plan", plan.length > 0, `${plan.length} steps`);
check(
  "every step carries what the desk edits",
  plan.every((s) => s.name && typeof s.minutes === "number" && "included" in s),
);
check(
  "optional steps are offered unticked, not forced in",
  plan.every((s) => (s.optional ? !s.included : true)),
);
const emptyPlan = await defaultPlan("ZZ_NO_SUCH_TYPE");
check("a type with no template gives an empty plan, not an error", emptyPlan.length === 0);
// The lab's own pipeline — delivered / processing / reports available, and the
// report desk's stages — is work the lab station records. Putting it on the
// desk's list asked reception to tick boxes for things they never touch.
const testsPlan = await defaultPlan(testsOnly);
check(
  "the lab's internal stages are not stops on the patient's journey",
  !testsPlan.some((s) => /^(Lab|Reports) —/.test(s.name)),
  testsPlan.map((s) => s.name).join(", "),
);
check(
  "and what is left that nobody can tick automatically is only the real stops",
  testsPlan.filter((s) => !s.chainStatus).every((s) => /Blood Sample|Billing/.test(s.name)),
);

// ── Check-in ────────────────────────────────────────────────────────────────
const v1 = await bookedVisit("901", "Demo Journey One");
const steps = plan.filter((s) => s.included);
const checkedIn = await checkInWithJourney(v1.id, {
  visitTypeId: suggestion,
  steps,
  actorId: 20,
  actorRole: "reception",
});
check("check-in records the journey", checkedIn.totalCount === steps.length);
check("with the estimate the patient is promised", checkedIn.plannedTotalMin > 0);
check("and a token for their own link", !!checkedIn.visitToken);

const status = await one(
  `SELECT current_status, visit_type_id FROM giniflow_visits WHERE id = $1`,
  [v1.id],
);
check("the board sees them checked in", status.current_status === "checked_in");
check("and the visit remembers its type", status.visit_type_id === suggestion);

const twice = await checkInWithJourney(v1.id, { visitTypeId: suggestion, steps, actorId: 20 });
check("a second press adds no second journey", twice.alreadyPlanned === true);
check("and the steps are not duplicated", twice.totalCount === steps.length);

// ── Assigning a consultant means what it looks like it means ──────────────
// The doctor's own queue reads giniflow_visits, so a name picked on the journey
// has to land there — a dropdown that only decorated the plan would be worse
// than no dropdown.
{
  const CONSULTANT = 26;
  const v = await bookedVisit("903", "Demo Journey Three");
  const withDoctor = plan
    .filter((p) => p.included)
    .map((p) =>
      p.chainStatus === "with_doctor"
        ? { ...p, staffId: String(CONSULTANT), staffName: "Dr Arpita" }
        : p,
    );
  await checkInWithJourney(v.id, { visitTypeId: suggestion, steps: withDoctor, actorId: 20 });
  const row = await one(
    `SELECT assigned_doctor_id, assigned_sd_id FROM giniflow_visits WHERE id = $1`,
    [v.id],
  );
  check(
    "the consultant picked at check-in is assigned to the visit",
    row.assigned_doctor_id === CONSULTANT,
  );

  // Whoever is in the room beats whoever was booked: a second check-in must not
  // take a patient off the consultant who already claimed them.
  await pool.query(`UPDATE giniflow_visits SET assigned_doctor_id = $2 WHERE id = $1`, [v.id, 33]);
  await checkInWithJourney(v.id, { visitTypeId: suggestion, steps: withDoctor, actorId: 20 });
  const kept = await one(`SELECT assigned_doctor_id FROM giniflow_visits WHERE id = $1`, [v.id]);
  check("and an assignment already made is never overwritten", kept.assigned_doctor_id === 33);
}

// ── The tick ────────────────────────────────────────────────────────────────
const tick = async (to, role = "system") => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await advanceStatus(client, { visitId: v1.id, toStatus: to, actorRole: role, allowSkip: true });
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  return getJourney(v1.id);
};

const atVitals = await tick("with_vitals");
const vitalsStep = atVitals.steps.find((s) => s.chainStatus === "with_vitals");
check("the step the patient is at goes live on its own", vitalsStep?.status === "in_progress");
check("and nothing else has been ticked", atVitals.doneCount === 0);

// vitals_done is skipped over entirely — the floor does that, and the plan has
// to survive it.
const atDoctor = await tick("with_doctor");
const done = atDoctor.steps.filter((s) => s.status === "done").map((s) => s.name);
check("everything the patient passed is completed", done.length >= 2, done.join(", "));
check(
  "including across a status the floor skipped",
  atDoctor.steps.find((s) => s.chainStatus === "with_vitals")?.status === "done",
);
const live = atDoctor.steps.filter((s) => s.status === "in_progress");
check("exactly one step is live at a time", live.length === 1, live.map((s) => s.name).join(", "));
check(
  "an off-chain stop is never ticked by the board",
  atDoctor.steps.filter((s) => s.manual).every((s) => s.status === "pending"),
);

// ── Editing a journey already on the floor ─────────────────────────────────
const ecg = await one(`SELECT id, name FROM flow_step_catalog WHERE id = 'ecg'`);
const withEcg = await addStep(v1.id, { catalogId: ecg.id, name: ecg.name, minutes: 10 });
check("a stop can be added mid-visit", withEcg.totalCount === atDoctor.totalCount + 1);
const added = withEcg.steps.find((s) => s.catalogId === "ecg");
check("an added ECG has no board column, so the desk ticks it", added?.manual === true);

// A stop with no board column only becomes tickable when the ones before it are
// finished. Billing sits seventh of eight in every template, and a tick offered
// from check-in let a patient be marked billed before they had seen the doctor.
{
  const billing = withEcg.steps.find((x) => x.catalogId === "billing");
  if (billing) {
    const tooSoon = await setStepStatus(billing.stepId, "done")
      .then(() => false)
      .catch((e) => e.status === 409);
    check("a template stop cannot be ticked before its turn", tooSoon, billing.name);
    const untouched = await getJourney(v1.id);
    check(
      "and the refusal leaves it alone",
      untouched.steps.find((x) => x.stepId === billing.stepId)?.status === "pending",
    );
  } else {
    check("the template has an off-chain stop to test the order on", false);
  }
}

// ...but a stop the DESK added during the visit is appended to the end of the
// list and happened now. Holding it behind the pharmacy would make it
// untickable for the entire visit.
const ticked = await setStepStatus(added.stepId, "done");
check(
  "and ticking it is recorded",
  ticked.steps.find((s) => s.stepId === added.stepId)?.status === "done",
);

// A mis-tick has to be correctable, so undo is never blocked.
const undone = await setStepStatus(added.stepId, "pending");
check(
  "a tick can be undone",
  undone.steps.find((s) => s.stepId === added.stepId)?.status === "pending",
);
await setStepStatus(added.stepId, "done");

const custom = await addStep(v1.id, { name: "Counselling with the family", minutes: 15 });
const customStep = custom.steps.find((s) => s.name === "Counselling with the family");
check("a step nobody catalogued can still be added", !!customStep);
check("and is marked as the desk's own", customStep.source === "custom");

const order = custom.steps.map((s) => s.stepId);
const reversed = [...order].reverse();
const reordered = await reorderSteps(v1.id, reversed);
check(
  "the journey can be reordered without tripping its own key",
  reordered.steps[0].stepId === reversed[0],
);
const dropped = await removeStep(customStep.stepId);
check("and a step removed", dropped.totalCount === reordered.totalCount - 1);

// ── The patient's view ─────────────────────────────────────────────────────
const track = await trackByToken(checkedIn.visitToken);
check("the patient's link resolves", !!track);
check("it shows a first name and no more", track.first_name === "Demo" && !("phone" in track));
check("with their place in the journey", track.total_steps > 0 && track.step_index >= 0);
check("and a timeline", Array.isArray(track.timeline) && track.timeline.length > 0);
check("an unknown token resolves to nothing", (await trackByToken("nosuchtoken")) === null);

// ── Leaving early ──────────────────────────────────────────────────────────
const ended = await tick("exited");
const remaining = ended.steps.filter((s) => s.status === "skipped");
check("what the patient never did is skipped", remaining.length > 0);
// The other half of the same rule: a patient who walked out having finished did
// NOT skip the pharmacy. Striking that through would tell someone holding their
// medicines that they never collected them.
const pharmacy = ended.steps.find((s) => s.chainStatus === "dispensed");
check(
  "but the stops they reached are completed, not struck through",
  !pharmacy || pharmacy.status === "done",
  pharmacy?.status,
);
check(
  "and only stops with no board column can be left skipped",
  remaining.every((s) => s.manual),
  remaining.map((s) => s.name).join(", "),
);
check(
  "and never claimed as done",
  !ended.steps.some((s) => s.manual && s.status === "done" && s.name === "Counselling"),
);
const closed = await trackByToken(checkedIn.visitToken);
check("their link stops counting down", closed.remaining_min === 0);

// ── A patient the sync checked in, who never saw this screen ───────────────
const v2 = await bookedVisit("902", "Demo Journey Two");
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await advanceStatus(client, {
    visitId: v2.id,
    toStatus: "with_sd",
    actorRole: "system",
    allowSkip: true,
  });
  await client.query("COMMIT");
} finally {
  client.release();
}
const planless = await getJourney(v2.id);
check("a visit the sync moved has no journey of its own", planless.totalCount === 0);
check("and the tick left it alone rather than failing", true);

const seeded = await ensurePlan(v2.id);
check("opening their card seeds one", seeded.seeded === true, seeded.visitTypeId);
const caught = await getJourney(v2.id);
check(
  "and it agrees with where they already are",
  caught.doneCount > 0,
  `${caught.doneCount} done`,
);
check("rather than starting them from the beginning", caught.steps[0].status !== "pending");
const again = await ensurePlan(v2.id);
check("a second look does not seed a second one", again.seeded === false);

// ── Lab Billing (33-LAB-BILLING-STEP-PLAN.md) ──────────────────────────────
const testPlan = await defaultPlan("FU_APPT_TESTS");
const billAt = testPlan.findIndex((s) => s.catalogId === "lab_billing");
const sampleAt = testPlan.findIndex((s) => s.catalogId === "blood_sample");
check("a tests journey carries a Lab Billing stop", billAt >= 0);
check("in front of the sample, which is what the lab waits on", billAt >= 0 && billAt < sampleAt);
check("and no board column claims it", !testPlan[billAt]?.chainStatus);
const plainPlan = await defaultPlan("FU_APPT");
check(
  "a journey with no tests grows no counter",
  !plainPlan.some((s) => s.catalogId === "lab_billing"),
);
check(
  "and the medicines bill at the end is untouched",
  plainPlan.some((s) => s.catalogId === "billing"),
);

const v3 = await bookedVisit("903", "Demo Journey Lab Bill");
// bookedVisit reuses the row on conflict, so a run that died mid-way leaves its
// plan behind and the check-in below would report it as already planned.
await pool.query(`DELETE FROM giniflow_visit_steps WHERE visit_id = $1`, [v3.id]);
await pool.query(`DELETE FROM giniflow_lab_orders WHERE visit_id = $1`, [v3.id]);
await checkInWithJourney(v3.id, {
  visitTypeId: "FU_APPT_TESTS",
  steps: testPlan.filter((s) => s.included),
  actorId: 20,
  actorRole: "reception",
});
const billStep = (await getJourney(v3.id)).steps.find((s) => s.catalogId === "lab_billing");
check("the stop reaches the patient's journey", !!billStep);
check("as one a person ticks, not one the board ticks", billStep?.manual === true);

const labOrder = await one(
  `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, sample_status, amount_total)
   VALUES ($1, 'today', 'pending', 'ordered', 500) RETURNING id`,
  [v3.id],
);
const client3 = await pool.connect();
try {
  await client3.query("BEGIN");
  await syncLabStepsFromLab(client3, v3.id);
  await client3.query("COMMIT");
} finally {
  client3.release();
}
const unpaid = (await getJourney(v3.id)).steps.find((s) => s.catalogId === "lab_billing");
check("an unpaid order leaves it untouched", unpaid.status === "pending");

await pool.query(`UPDATE giniflow_lab_orders SET payment_status = 'paid' WHERE id = $1`, [
  labOrder.id,
]);
const client4 = await pool.connect();
try {
  await client4.query("BEGIN");
  await syncLabStepsFromLab(client4, v3.id);
  await client4.query("COMMIT");
} finally {
  client4.release();
}
const paid = (await getJourney(v3.id)).steps.find((s) => s.catalogId === "lab_billing");
check("settling the order ticks it without anyone pressing anything", paid.status === "done");

await pool.query(
  `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, sample_status, amount_total)
   VALUES ($1, 'today', 'pending', 'ordered', 300)`,
  [v3.id],
);
const client5 = await pool.connect();
try {
  await client5.query("BEGIN");
  await syncLabStepsFromLab(client5, v3.id);
  await client5.query("COMMIT");
} finally {
  client5.release();
}
const second = (await getJourney(v3.id)).steps.find((s) => s.catalogId === "lab_billing");
check("a second unpaid order does not untick what reception recorded", second.status === "done");

// The desk settling the order is what normally ticks it, including on the
// reconcile path a drifted column takes.
const drifted = await one(
  `INSERT INTO giniflow_lab_orders
     (visit_id, urgency, payment_status, sample_status, amount_total, amount_paid)
   VALUES ($1, 'today', 'pending', 'ordered', 400, 400) RETURNING id`,
  [v3.id],
);
await pool.query(
  `UPDATE giniflow_visit_steps SET status = 'pending', completed_at = NULL
    WHERE visit_id = $1 AND step_catalog_id = 'lab_billing'`,
  [v3.id],
);
await pool.query(`UPDATE giniflow_lab_orders SET payment_status = 'paid' WHERE visit_id = $1`, [
  v3.id,
]);
await pool.query(`UPDATE giniflow_lab_orders SET payment_status = 'pending' WHERE id = $1`, [
  drifted.id,
]);
const settled = await clearPayment(drifted.id, { method: "paid", actorId: 20 });
check("a drifted order reconciles rather than dead-ending", settled.alreadySettled === true);
const afterDrift = (await getJourney(v3.id)).steps.find((s) => s.catalogId === "lab_billing");
check("and the counter is ticked on that path too", afterDrift.status === "done");

// Tests ordered mid-visit, on a journey planned without them.
const v4 = await bookedVisit("906", "Demo Journey Late Tests");
await pool.query(`DELETE FROM giniflow_visit_steps WHERE visit_id = $1`, [v4.id]);
const plainSteps = (await defaultPlan("FU_APPT")).filter((s) => s.included);
await checkInWithJourney(v4.id, {
  visitTypeId: "FU_APPT",
  steps: plainSteps,
  actorId: 20,
  actorRole: "reception",
});
const beforeOrder = await getJourney(v4.id);
check(
  "a follow-up journey starts with no lab stops",
  !beforeOrder.steps.some((s) => s.catalogId === "lab_billing"),
);
const plannedBefore = (
  await one(`SELECT planned_total_min FROM giniflow_visits WHERE id = $1`, [v4.id])
).planned_total_min;

// The first stop is done, so the insert has somewhere to go that is not the end.
await setStepStatus(beforeOrder.steps[0].stepId, "done");
const client7 = await pool.connect();
try {
  await client7.query("BEGIN");
  await insertLabStepsForOrder(client7, v4.id);
  await client7.query("COMMIT");
} finally {
  client7.release();
}
const late = await getJourney(v4.id);
const lateIds = late.steps.map((s) => s.catalogId);
check("ordering tests adds the counter and the sample", lateIds.includes("lab_billing"));
check(
  "in front of the work still to come, not after the pharmacy",
  lateIds.indexOf("lab_billing") === 1 && lateIds.indexOf("blood_sample") === 2,
  lateIds.join(" → "),
);
check("and the stop the patient already finished keeps its place", late.steps[0].status === "done");
check(
  "the estimate grows with them",
  (await one(`SELECT planned_total_min FROM giniflow_visits WHERE id = $1`, [v4.id]))
    .planned_total_min > plannedBefore,
);
const client8 = await pool.connect();
try {
  await client8.query("BEGIN");
  const again2 = await insertLabStepsForOrder(client8, v4.id);
  await client8.query("COMMIT");
  check("a second order adds no second counter", again2.added.length === 0);
} finally {
  client8.release();
}

// A HealthRay-run lab: no order here at all, and the case is the evidence.
const v5 = await bookedVisit("907", "Demo Journey HealthRay Lab");
await pool.query(`DELETE FROM giniflow_visit_steps WHERE visit_id = $1`, [v5.id]);
await checkInWithJourney(v5.id, {
  visitTypeId: "FU_APPT_TESTS",
  steps: (await defaultPlan("FU_APPT_TESTS")).filter((s) => s.included),
  actorId: 20,
  actorRole: "reception",
});
const v5row = await one(`SELECT patient_id, visit_date FROM giniflow_visits WHERE id = $1`, [
  v5.id,
]);
await pool.query(
  `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                          case_date, test_names, raw_list_json, raw_detail_json)
   VALUES ('ZZJRN-LAB', 'ZZJRN-LAB', 'ZZJRN-LAB-UID', -9001, $1, $2::date, ARRAY['HBA1C'],
           '{"phlebotomy_status":"Completed"}'::jsonb, '{"reported_on":"2019-01-04 11:00"}'::jsonb)`,
  [v5row.patient_id, v5row.visit_date],
);
const hrEvidence = await syncLabStepsFromLab(pool, v5.id);
check("a HealthRay case counts as billed and drawn", hrEvidence.billed && hrEvidence.drawn);
const hrJourney = await getJourney(v5.id);
const hrBill = hrJourney.steps.find((s) => s.catalogId === "lab_billing");
const hrSample = hrJourney.steps.find((s) => s.catalogId === "blood_sample");
check("so the counter is not left for the desk to tick", hrBill.status === "done");
check("and neither is the sample the lab already drew", hrSample.status === "done");
await pool.query(`DELETE FROM lab_cases WHERE case_no = 'ZZJRN-LAB'`);

// The exit sweep strikes through what is still pending; lab evidence outranks it.
await pool.query(
  `UPDATE giniflow_visit_steps SET status = 'skipped'
    WHERE visit_id = $1 AND step_catalog_id IN ('lab_billing', 'blood_sample')`,
  [v5.id],
);
await pool.query(
  `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, sample_status, amount_total)
   VALUES ($1, 'today', 'paid', 'processing', 250)`,
  [v5.id],
);
await syncLabStepsFromLab(pool, v5.id);
const unskipped = await getJourney(v5.id);
check(
  "a stop struck through on the way out is corrected by what the lab recorded",
  unskipped.steps.find((s) => s.catalogId === "lab_billing").status === "done" &&
    unskipped.steps.find((s) => s.catalogId === "blood_sample").status === "done",
);

const noPlan = await bookedVisit("904", "Demo Journey No Plan");
const client6 = await pool.connect();
try {
  await client6.query("BEGIN");
  await syncLabStepsFromLab(client6, noPlan.id);
  await client6.query("COMMIT");
  check("a visit with no journey is a no-op, not an error", true);
} catch (e) {
  check("a visit with no journey is a no-op, not an error", false, e.message);
} finally {
  client6.release();
}

// ── The older module is not touched ────────────────────────────────────────
const after = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS flow,
          (SELECT count(*)::int FROM flow_step_catalog) AS cat`,
);
check("old flow_* visits untouched", after.flow === before.flow, `${before.flow}→${after.flow}`);
check("and its catalog intact", after.cat === before.cat, `${before.cat}→${after.cat}`);

console.log(failures ? `\n${failures} checks failed` : "\nall checks passed");
await cleanUp();
process.exit(failures ? 1 : 0);
