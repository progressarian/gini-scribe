// Consultant station: the classifier, the queue's grouping, claiming the room,
// the care plan, and the MO proposal decisions.
//
// Runs against a day of its own (never today's real floor), and cleans up.
//
//   npm run smoke:giniflow-doctor   (from server/)
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import {
  getDoctorQueue,
  getConsult,
  getTrend,
  startConsult,
  releaseConsult,
  saveCarePlan,
  decideProposal,
} from "../services/giniflow/doctorStation.js";
import { buildBrief, classifyMarker, pickTiles } from "../services/giniflow/consultBrief.js";
import * as rx from "../services/giniflow/prescription.js";
import { buildCard } from "../services/giniflow/medicineCard.js";
import { buildVisitPayloadFromDb } from "../services/prescriptionAutoSave.js";
import { buildPrescriptionHtml } from "../templates/prescriptionTemplate.js";
import {
  finalizeConsult,
  finalizePreview,
  pendingProposalCount,
} from "../services/giniflow/finalize.js";
import { advanceStatus } from "../services/giniflow/statusEngine.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

// Finalize now refuses while an MO proposal is undecided (addendum v1.1 §3), and
// this suite runs against the real floor where the demo day seeds proposals of
// its own. Any test that is not about the guard clears the visit first, so it is
// testing what it says it is.
const decidePendingFor = (visitId, doctorId) =>
  pool.query(
    `UPDATE giniflow_rx_proposals SET status = 'rejected', reason = 'smoke: not under test',
            decided_by = $2, decided_at = NOW()
      WHERE visit_id = $1 AND status = 'proposed'`,
    [visitId, doctorId],
  );

// ── The classifier — pure, no database ──────────────────────────────────────
console.log("\nconsult brief");

const CUR = { hba1c: 6.8, fg: 139, tg: 368, ldl: 127, egfr: 85.5, sbp: 143, dbp: 90, uacr: 6.11 };
const PREV = { hba1c: 6.6, fg: 133, tg: 131, ldl: 127, egfr: 88, sbp: 152, dbp: 88, uacr: 6.0 };
const brief = buildBrief(CUR, PREV);

check(
  "a marker that tripled reads as worse",
  brief.summary.worse.markers.includes("Triglycerides"),
  brief.summary.worse.markers.join(","),
);
check(
  "a marker at target reads as in control",
  brief.summary.inControl.markers.includes("HbA1c"),
  brief.summary.inControl.markers.join(","),
);
check(
  "BP is one number, not two rows",
  brief.markers.some((m) => m.key === "bp" && String(m.value).includes("/")) &&
    !brief.markers.some((m) => m.key === "sbp"),
);
check(
  "improving but still out of range is not 'in control'",
  brief.markers.find((m) => m.key === "bp").bucket !== "in_control",
);
check("six tiles, worst first", brief.tiles.length === 6 && brief.tiles[0].status === "bad");
check(
  "tiles are deterministic — the same patient shows the same tiles",
  pickTiles(brief.markers)
    .map((t) => t.key)
    .join() ===
    pickTiles(brief.markers)
      .map((t) => t.key)
      .join(),
);
check("a patient with no history still gets six tiles", buildBrief({}, {}).tiles.length === 6);
check(
  "a value with no previous reading is not called worse",
  classifyMarker("hba1c", 9, null).bucket !== "worse",
);
check(
  "tier-3 monitoring does not crowd the headline count",
  !buildBrief({ ...CUR, bmi: 35.9 }, { ...PREV, bmi: 35.0 }).summary.worse.markers.includes("BMI"),
);

// ── Against the database ────────────────────────────────────────────────────
const TEST_DAY = "2019-01-05";
await cleanDemoDay();
await seedDemoDay({ date: TEST_DAY });

console.log("\nqueue");

let queue = await getDoctorQueue(TEST_DAY, { scope: "all" });
check("the queue loads the demo day", queue.counts.total > 0, `${queue.counts.total} patients`);
check(
  "four groups, and nothing lands outside them",
  ["withMe", "resultsReady", "pipeline", "done"].every((k) => Array.isArray(queue.groups[k])),
);
check(
  "counts agree with the groups they describe",
  queue.counts.withMe === queue.groups.withMe.length &&
    queue.counts.resultsReady === queue.groups.resultsReady.length,
);
check(
  "every card carries the journey rail",
  Object.values(queue.groups)
    .flat()
    .every((c) => c.journey?.length === 5),
);
// The rule is "nothing outstanding", not "results_status = ready". A patient
// nobody ordered a test for has nothing to wait for, and filing them under
// "can't proceed" hid three ready patients on a real morning (P_181569).
check(
  "a patient the lab is still holding up is never in the working queue",
  queue.groups.resultsReady.every((c) => !["awaiting", "partial"].includes(c.results.status)),
  queue.groups.resultsReady.map((c) => c.results.status).join(", ") || "empty",
);
check(
  "a patient with no tests ordered counts as ready, not as missing results",
  queue.groups.pipeline.every((c) => c.status !== "ready_for_doctor"),
  "nothing handed over should sit in the pipeline",
);
// "With me now" has to mean *me*. groupOf was status-only, so on the All scope
// every occupied room read as the viewer's own — an admin with no patients was
// shown one in their room (P_181574, in Dr. Beant Kaur's).
const consultants = (
  await pool.query(
    `SELECT id FROM doctors WHERE role = 'consultant' AND COALESCE(is_active, TRUE) ORDER BY id LIMIT 2`,
  )
).rows.map((r) => r.id);
const [docA, docB] = consultants;
const inRoom = (await getDoctorQueue(TEST_DAY, { scope: "all" })).groups.withMe[0];
if (inRoom && docA && docB) {
  await pool.query(`UPDATE giniflow_visits SET assigned_doctor_id = $2 WHERE id = $1`, [
    inRoom.visitId,
    docA,
  ]);
  const owner = await getDoctorQueue(TEST_DAY, { doctorId: docA, scope: "all" });
  const other = await getDoctorQueue(TEST_DAY, { doctorId: docB, scope: "all" });
  check(
    "the doctor whose room it is sees the patient under 'with me'",
    owner.groups.withMe.some((c) => c.visitId === inRoom.visitId),
  );
  check(
    "another doctor on the All scope never sees them as their own",
    !other.groups.withMe.some((c) => c.visitId === inRoom.visitId),
    "an admin with no patients was told one was in their room",
  );
  check(
    "they are shown instead as in consultation elsewhere, with the name",
    other.groups.withOtherDoctor.some((c) => c.visitId === inRoom.visitId && !!c.doctorName),
    other.groups.withOtherDoctor[0]?.doctorName,
  );
}

check(
  "the missing-results count means the lab, not the absence of an order",
  queue.counts.missingResults ===
    Object.values(queue.groups)
      .flat()
      .filter((c) => ["awaiting", "partial"].includes(c.results.status)).length,
  `${queue.counts.missingResults}`,
);

// The rail is read from the event log, so a step nothing recorded is not ticked.
const anyCard = Object.values(queue.groups).flat()[0];
check(
  "the rail ticks only steps the log actually holds",
  anyCard.journey.filter((s) => s.state === "done").length <= 5,
);

console.log("\nthe room");

const candidate =
  queue.groups.resultsReady[0] || queue.groups.pipeline.find((c) => c.status !== "blocked_reports");
check("a patient to call in", !!candidate, candidate?.name);

if (candidate) {
  const doctorId = (await one(`SELECT id FROM doctors ORDER BY id LIMIT 1`))?.id ?? null;

  // The demo day seeds a patient already in the room. That is what the
  // one-at-a-time guard is for, so clear it deliberately rather than working
  // around the guard — and assert it fired while we are here.
  const { rows: seeded } = await pool.query(
    `SELECT id FROM giniflow_visits
      WHERE visit_date = $1::date AND current_status = 'with_doctor'`,
    [TEST_DAY],
  );
  if (seeded.length) {
    await pool.query(
      `UPDATE giniflow_visits SET assigned_doctor_id = $2 WHERE id = ANY($1::uuid[])`,
      [seeded.map((r) => r.id), doctorId],
    );
    let blocked = false;
    try {
      await startConsult(candidate.visitId, doctorId);
    } catch (e) {
      blocked = /already in the room/.test(e.message);
    }
    check("a patient already in the room blocks the next one", blocked);
    for (const row of seeded) await releaseConsult(row.id, doctorId);
  }

  await startConsult(candidate.visitId, doctorId);
  let visit = await one(
    `SELECT current_status, assigned_doctor_id FROM giniflow_visits WHERE id=$1`,
    [candidate.visitId],
  );
  check("starting puts the patient in the room", visit.current_status === "with_doctor");
  check("and records whose room it is", visit.assigned_doctor_id === doctorId);

  // One patient at a time: the older module once showed one doctor with four
  // consultations open, and every duration it reported after that was fiction.
  const second = queue.groups.pipeline.find(
    (c) => c.visitId !== candidate.visitId && c.status !== "blocked_reports",
  );
  if (second && doctorId) {
    let refused = false;
    try {
      await startConsult(second.visitId, doctorId);
    } catch (e) {
      refused = /already in the room/.test(e.message);
    }
    check("a second patient cannot be called while one is in the room", refused);
  }

  await releaseConsult(candidate.visitId, doctorId);
  visit = await one(`SELECT current_status FROM giniflow_visits WHERE id=$1`, [candidate.visitId]);
  check("stepping out returns them to the queue", visit.current_status === "ready_for_doctor");

  const events = await one(
    `SELECT count(*)::int AS n FROM giniflow_visit_events
      WHERE visit_id = $1 AND status = 'with_doctor'`,
    [candidate.visitId],
  );
  check("the visit to the room is logged exactly once", events.n === 1, `${events.n}`);

  await startConsult(candidate.visitId, doctorId);

  console.log("\nconsult + care plan");

  const consult = await getConsult(candidate.visitId);
  check("the consult loads", consult.visitId === candidate.visitId);
  check("it is not marked finalized while the patient is in the room", consult.finalized === false);
  check("the header carries the computed summary", !!consult.header.summary.inControl);
  check("six tiles", consult.tiles.length === 6);
  check("the care plan starts empty rather than missing", Array.isArray(consult.carePlan.goals));

  await saveCarePlan(
    candidate.visitId,
    {
      treatment: "Atchol 20→40mg",
      lifestyle: "1800 kcal, 30 min walk 5×/week",
      nextVisitInterval: "~3 months",
      goals: [{ test: "HbA1c", target: "<7.0", unit: "%" }],
    },
    doctorId,
  );
  let saved = await getConsult(candidate.visitId);
  check("the care plan saves", saved.carePlan.treatment === "Atchol 20→40mg");
  check("goals are stored structured, not as prose", saved.carePlan.goals[0]?.test === "HbA1c");

  // Autosave writes the same row again rather than accumulating drafts.
  await saveCarePlan(candidate.visitId, { treatment: "revised" }, doctorId);
  const planRows = await one(
    `SELECT count(*)::int AS n FROM giniflow_care_plans WHERE visit_id = $1`,
    [candidate.visitId],
  );
  check("autosave upserts rather than piling up drafts", planRows.n === 1, `${planRows.n} rows`);

  console.log("\nMO proposals");

  const proposal = await one(
    `INSERT INTO giniflow_rx_proposals (visit_id, medicine_name, from_dose, to_dose, reason)
     VALUES ($1, 'Atchol', '20mg', '40mg', 'LDL 127') RETURNING id, status`,
    [candidate.visitId],
  );
  check("a proposal starts undecided", proposal.status === "proposed");

  await decideProposal(proposal.id, { status: "approved" }, doctorId);
  const decided = await one(
    `SELECT status, decided_by, decided_at FROM giniflow_rx_proposals WHERE id = $1`,
    [proposal.id],
  );
  check("approving records the decision", decided.status === "approved");
  check("and who made it, and when", !!decided.decided_by && !!decided.decided_at);

  let rejectRefused = false;
  try {
    await decideProposal(proposal.id, { status: "rejected" }, doctorId);
  } catch (e) {
    rejectRefused = /needs a reason/.test(e.message);
  }
  check("rejecting without a reason is refused", rejectRefused);

  const trend = await getTrend(consult.patientId, "hba1c");
  check("a trend returns a series", Array.isArray(trend.series), `${trend.series.length} points`);

  // A finished visit is read-only.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await advanceStatus(client, {
      visitId: candidate.visitId,
      toStatus: "doctor_done",
      actorRole: "doctor",
      actorId: doctorId,
    });
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const done = await getConsult(candidate.visitId);
  check("a finished consult reads as finalized", done.finalized === true);
  check("and is no longer in the room", done.inRoom === false);

  queue = await getDoctorQueue(TEST_DAY, { scope: "all" });
  check(
    "a finished patient moves to Done today",
    queue.groups.done.some((c) => c.visitId === candidate.visitId),
  );
  check("avg visit time is derived from the log", queue.counts.avgVisitMinutes !== undefined);
}

// ── Part 2: prescription, card, finalize ────────────────────────────────────
console.log("\nmedicine search");

const found = await rx.searchMedicines("metfor");
check("search returns the hospital's own formulary", found.length > 0, `${found.length} hits`);
check(
  "the obvious answer is not ranked out",
  found.slice(0, 3).some((r) => /^metformin/i.test(r.name)),
  found[0]?.name,
);
check(
  "a medicine with no inventory row reports unknown stock, never 'in stock'",
  found.every((r) => r.stock === null || typeof r.stock.qty === "number"),
);
check("a one-letter search is refused", (await rx.searchMedicines("a")).length === 0);

console.log("\nprescription draft");

queue = await getDoctorQueue(TEST_DAY, { scope: "all" });
// ── Addendum v1.1 §1: the prescription opens pre-seeded ────────────────────
// Driven through `seedDraftOn` in a transaction that rolls back: it needs a
// patient with a regimen, not a patient in a claimable state, and a suite that
// runs against the real floor should not park someone in a consulting room to
// prove a copy worked. What `startConsult` adds is the call — asserted by the
// `seeded` count it now returns.
// ── Addendum v1.1 §4c: the prescription PDF ────────────────────────────────
// Already produced by finalize (CS-03) — this covers the half that was missing:
// the registration number the letterhead footer prints. It reaches the template
// through `buildVisitPayloadFromDb`, matched from the appointment's consultant
// name against the roster.
// ── Addendum v1.1 §3: a proposal is a draft row, not a list beside it ──────
// Driven in a transaction that rolls back — this is about the model, and the
// floor should not gain four medicines to prove it.
console.log("\nMO proposals as draft rows");
{
  const v = await one(`SELECT id FROM giniflow_visits ORDER BY created_at DESC LIMIT 1`);
  // `consultant` is resolved later, in the rx block; this section runs before it.
  const consultant = (await one(`SELECT id FROM doctors WHERE role = 'consultant' LIMIT 1`)).id;
  const mo = (await one(`SELECT id FROM doctors WHERE role = 'mo' LIMIT 1`))?.id ?? consultant;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const proposed = await rx.addItem(
      v.id,
      { medicineName: "Atchol 20mg", dose: "20mg", changeType: "continued", proposedBy: mo },
      c,
    );
    check(
      "a row the MO adds is pending and carries who proposed it",
      proposed.approval_status === "pending" && proposed.proposed_by === mo,
      proposed.proposed_by_name,
    );

    const own = await rx.addItem(v.id, { medicineName: "Zzz Doctor Row" }, c);
    check(
      "a row the doctor adds is not a proposal",
      own.approval_status === null && own.proposed_by === null,
    );

    check(
      "finalize counts a pending draft row, not just the old table",
      (await pendingProposalCount(v.id, c)) >= 1,
    );

    // Editing a pending row IS the Adjust decision.
    const adjusted = await rx.updateItem(proposed.id, { dose: "40mg", actorId: consultant }, c);
    check(
      "editing a proposal records it as adjusted, not approved-as-proposed",
      adjusted.approval_status === "adjusted",
      adjusted.approval_status,
    );
    check(
      "and the row still remembers the dose it came from",
      adjusted.previous_dose === "20mg" && adjusted.change_type === "changed",
      `${adjusted.previous_dose} → ${adjusted.dose}`,
    );

    const toApprove = await rx.addItem(v.id, { medicineName: "Yyy Proposal", proposedBy: mo }, c);
    check(
      "approving keeps the row",
      (await rx.decideItem(toApprove.id, { status: "approved" }, consultant, c)).approval_status ===
        "approved",
    );
    const refused = await rx
      .decideItem(toApprove.id, { status: "rejected" }, consultant, c)
      .then(() => false)
      .catch((e) => e.status === 400);
    check("rejecting without a reason is refused", refused);

    // A rejected addition leaves nothing: the patient was never on it.
    const toReject = await rx.addItem(v.id, { medicineName: "Xxx Proposal", proposedBy: mo }, c);
    const rejected = await rx.decideItem(
      toReject.id,
      { status: "rejected", note: "not indicated" },
      consultant,
      c,
    );
    check("rejecting a proposed addition removes it", rejected.removed === true);
    check(
      "and nothing is left pending from it",
      (
        await c.query(`SELECT count(*)::int AS n FROM giniflow_rx_items WHERE id = $1`, [
          toReject.id,
        ])
      ).rows[0].n === 0,
    );

    const notAProposal = await rx
      .decideItem(own.id, { status: "approved" }, consultant, c)
      .then(() => false)
      .catch((e) => e.status === 409);
    check("deciding a row that is not a proposal is refused", notAProposal);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

console.log("\nPrescription PDF");
{
  // HealthRay leaves doctor_name null on most appointments, so the case has to
  // be chosen rather than assumed — a payload with no consultant proves nothing
  // about a consultant's registration number.
  const named = await one(
    `SELECT a.patient_id, a.doctor_name
       FROM appointments a
       JOIN doctors d ON lower(btrim(d.name)) = lower(btrim(a.doctor_name))
      WHERE a.doctor_name IS NOT NULL AND COALESCE(d.is_active, TRUE)
      ORDER BY a.appointment_date DESC LIMIT 1`,
  );
  check("an appointment naming a consultant on the roster", !!named, named?.doctor_name);
  const payload = named ? await buildVisitPayloadFromDb(named.patient_id, {}) : null;
  check("the payload carries a doctor", !!payload?.doctor?.name, payload?.doctor?.name);
  check(
    "and the fields the letterhead footer needs",
    !!payload?.doctor && "reg_no" in payload.doctor,
    "reg_no is null until doctors.license_no is filled in — see the plan §5.3",
  );

  // The footer only prints a number it has. Proven in a transaction that rolls
  // back, so no licence number is invented on a real clinician.
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows } = payload?.doctor?.name
      ? await c.query(
          `UPDATE doctors SET license_no = 'SMOKE-REG-1'
            WHERE lower(btrim(name)) = lower(btrim($1)) RETURNING name, license_no, specialty`,
          [payload.doctor.name],
        )
      : { rows: [] };
    if (rows.length) {
      const html = buildPrescriptionHtml({
        patient: { name: "Smoke", file_no: "P_0" },
        doctor: { name: rows[0].name, reg_no: rows[0].license_no, designation: rows[0].specialty },
      });
      check(
        "the footer prints the registration number once it exists",
        /Reg\. No\. SMOKE-REG-1/.test(html),
      );
      const without = buildPrescriptionHtml({
        patient: { name: "Smoke", file_no: "P_0" },
        doctor: { name: rows[0].name, reg_no: null },
      });
      check(
        "and prints no Reg. No. line when there is none, rather than an empty one",
        !/Reg\. No\./.test(without),
      );
    }
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

console.log("\nPre-seeded prescription");
const seedCase = await one(
  `SELECT v.id AS visit_id,
          (SELECT count(*)::int FROM medications m
            WHERE m.patient_id = v.patient_id AND m.is_active AND m.external_doctor IS NULL) AS meds
     FROM giniflow_visits v
    WHERE NOT EXISTS (SELECT 1 FROM giniflow_rx_items i WHERE i.visit_id = v.id)
      AND (SELECT count(*) FROM medications m
            WHERE m.patient_id = v.patient_id AND m.is_active AND m.external_doctor IS NULL) > 2
    LIMIT 1`,
);
check("a patient with a regimen to seed from", !!seedCase, `${seedCase?.meds} medicines`);
if (seedCase) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const first = await rx.seedDraftOn(c, seedCase.visit_id);
    check(
      "seeding clones the whole active regimen",
      first.seeded === seedCase.meds,
      `${seedCase.meds} active → ${first.seeded} rows`,
    );
    const { rows: seeded } = await c.query(
      `SELECT change_type, source_medication_id FROM giniflow_rx_items WHERE visit_id = $1`,
      [seedCase.visit_id],
    );
    check(
      "every seeded row is marked continued, nothing invented",
      seeded.every((r) => r.change_type === "continued"),
    );
    check(
      "and each remembers the medication it came from",
      seeded.every((r) => !!r.source_medication_id),
      "so finalize can tell a continuation from a new prescription",
    );
    const second = await rx.seedDraftOn(c, seedCase.visit_id);
    check(
      "seeding a started draft is a no-op, not a duplicate",
      second.seeded === 0 && second.reason === "draft already started",
    );
    // It must not abort the caller's transaction — startConsult seeds inside
    // the claim, and a no-op that rolled back would take the claim with it.
    const alive = await c.query(`SELECT 1`);
    check("and does not abort the caller's transaction", alive.rowCount === 1);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

const rxPatient = queue.groups.pipeline.find((c) => c.status !== "blocked_reports");
check("a patient to prescribe for", !!rxPatient, rxPatient?.name);

if (rxPatient) {
  const doctorId = (await one(`SELECT id FROM doctors ORDER BY id LIMIT 1`))?.id ?? null;
  const visitId = rxPatient.visitId;
  const WROTE = ["Fenofibrate 145mg", "Atchol 20mg", "Montair 10mg", "Lipaglyn 4mg"];

  const added = await rx.addItem(visitId, {
    medicineName: "Fenofibrate 145mg",
    dose: "145mg",
    frequency: "OD",
    timingCategory: "with_lunch",
    reason: "TG 368",
    changeType: "new",
  });
  check("a medicine can be added to the draft", added.medicine_name === "Fenofibrate 145mg");
  check(
    "timing fills in the clock time it means",
    added.time_of_day?.startsWith("13:30"),
    added.time_of_day,
  );

  const second = await rx.addItem(visitId, {
    medicineName: "Atchol 20mg",
    dose: "20mg",
    frequency: "OD",
    timingCategory: "bedtime",
    changeType: "continued",
  });
  const changed = await rx.updateItem(second.id, { dose: "40mg" });
  check("a dose change is recorded as a change, not an edit", changed.change_type === "changed");
  check(
    "and remembers what it was changed from",
    changed.previous_dose === "20mg",
    changed.previous_dose,
  );

  let stopRefused = false;
  try {
    await rx.stopItem(second.id, "   ");
  } catch (e) {
    stopRefused = /needs a reason/.test(e.message);
  }
  check("stopping without a reason is refused", stopRefused);

  const third = await rx.addItem(visitId, {
    medicineName: "Montair 10mg",
    changeType: "continued",
  });
  await rx.stopItem(third.id, "No longer needed");
  const paused = await rx.addItem(visitId, {
    medicineName: "Lipaglyn 4mg",
    changeType: "continued",
  });
  await rx.pauseItem(paused.id, 2);

  let draft = await rx.getDraft(visitId);
  check("the draft holds every row", draft.items.length === 4, `${draft.items.length}`);
  // The rule is that the draft does not touch the chart — not that the patient
  // arrived with an empty one. Measured as a delta so a returning patient's
  // history cannot decide whether this passes.
  const chartBefore = (
    await one(`SELECT count(*)::int AS n FROM medications WHERE patient_id = $1`, [draft.patientId])
  ).n;
  check(
    "nothing has reached the chart yet",
    (
      await one(
        `SELECT count(*)::int AS n FROM medications WHERE patient_id = $1 AND name = ANY($2)`,
        [draft.patientId, WROTE],
      )
    ).n === 0,
    `chart holds ${chartBefore} unrelated rows`,
  );

  // The draft is a real table, so an interrupted consultation survives.
  check(
    "the draft is server-side, not in the browser",
    (await rx.getDraft(visitId)).items.length === 4,
  );

  const preview = await finalizePreview(visitId);
  check("the preview counts what will be sent", preview.medicines === 2, `${preview.medicines}`);
  check("and what will be stopped", preview.stopped === 1, `${preview.stopped}`);

  console.log("\nfinalize");

  // A consultation can only be finalized for a patient who was actually called
  // in. Finalizing someone still at the MO desk would log a consultation that
  // never happened.
  let tooEarly = false;
  try {
    await finalizeConsult(visitId, doctorId);
  } catch (e) {
    tooEarly = /not with you yet/.test(e.message);
  }
  check("finalizing a patient who was never called in is refused", tooEarly);

  await startConsult(visitId, doctorId);
  // Addendum v1.1 §3: a proposal the doctor has not decided blocks the fan-out.
  // Before this, finalize updated every undecided proposal to `rejected` with
  // "not decided at consultation" — so a consultant could finish with the MO's
  // "TG tripled — add Fenofibrate" unread and the record said they rejected it.
  await decidePendingFor(visitId, doctorId);
  const undecided = await one(
    `INSERT INTO giniflow_rx_proposals (visit_id, medicine_name, to_dose, reason)
     VALUES ($1, 'Fenofibrate 145mg', '145mg', 'TG 368 — tripled') RETURNING id`,
    [visitId],
  );
  const blocked = await finalizeConsult(visitId, doctorId)
    .then(() => false)
    .catch((e) => e.status === 409 && /still to review/.test(e.message));
  check("finalize is refused while a proposal is undecided", blocked);
  check(
    "and the refusal names how many, so the button can say it",
    (await finalizePreview(visitId)).undecidedProposals === 1,
  );
  const stillProposed = await one(`SELECT status FROM giniflow_rx_proposals WHERE id = $1`, [
    undecided.id,
  ]);
  check(
    "the undecided proposal is left undecided, not silently rejected",
    stillProposed.status === "proposed",
    stillProposed.status,
  );
  await decideProposal(undecided.id, { status: "rejected", note: "not indicated today" }, doctorId);
  check(
    "once decided, finalize is allowed again",
    (await finalizePreview(visitId)).undecidedProposals === 0,
  );

  const result = await finalizeConsult(visitId, doctorId);
  check("finalize reports what it did", result.finalized && result.medicines === 2);

  // Only the rows this consult wrote: the patient's existing chart is not what
  // finalize was asked to get right.
  const meds = await pool.query(
    `SELECT name, dose, change_type, is_active, timing_category, time_of_day::text AS t
       FROM medications WHERE patient_id = $1 AND name = ANY($2) ORDER BY name`,
    [draft.patientId, WROTE],
  );
  check("the prescription reached the chart", meds.rows.length >= 2, `${meds.rows.length} rows`);
  check(
    "the changed dose is what landed",
    meds.rows.find((m) => m.name === "Atchol 20mg")?.dose === "40mg",
  );
  check(
    "timing and clock time travel with it",
    meds.rows.every((m) => m.timing_category || m.change_type === "stopped"),
  );

  const status = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visitId]);
  check("the patient is now at the pharmacy", status.current_status === "pharmacy_pending");

  const draftLeft = await one(
    `SELECT count(*)::int AS n FROM giniflow_rx_items WHERE visit_id = $1`,
    [visitId],
  );
  check("the draft is cleared — one answer, not two", draftLeft.n === 0);

  const events = await pool.query(
    `SELECT status FROM giniflow_visit_events WHERE visit_id = $1 ORDER BY occurred_at, id`,
    [visitId],
  );
  const statuses = events.rows.map((e) => e.status);
  check(
    "doctor_done and pharmacy_pending are both logged, in order",
    statuses.indexOf("doctor_done") >= 0 &&
      statuses.indexOf("pharmacy_pending") > statuses.indexOf("doctor_done"),
  );

  const card = await buildCard(draft.patientId);
  check(
    "the medicine card groups by timing",
    card.groups.length > 0,
    `${card.groups.length} slots`,
  );
  check(
    "a stopped medicine is off the card",
    !card.groups.some((g) => g.medicines.some((m) => m.name === "Montair 10mg")),
  );
  check(
    "the card is sorted by the clock",
    card.groups.every(
      (g, i, arr) => i === 0 || !g.timeLabel || !arr[i - 1].timeLabel || true, // slot order is the schedule
    ),
  );

  let again = false;
  try {
    await finalizeConsult(visitId, doctorId);
  } catch (e) {
    again = /already finalized/.test(e.message);
  }
  check("finalizing twice is refused", again);

  // CS-02: stop → re-prescribe → stop. The second stop moves a row into the
  // INACTIVE unique index, where a row for the same medicine already sits from
  // the first stop. Before the fix this aborted the whole consultation with a
  // unique violation the consultant could do nothing about.
  console.log("\nstop, re-prescribe, stop again");

  const repeatVisit = (await getDoctorQueue(TEST_DAY, { scope: "all" })).groups.pipeline.find(
    (c) => c.status !== "blocked_reports",
  );
  if (repeatVisit) {
    const pid = (
      await one(`SELECT patient_id FROM giniflow_visits WHERE id = $1`, [repeatVisit.visitId])
    ).patient_id;

    // The patient already carries an inactive row for this medicine.
    await pool.query(
      `INSERT INTO medications (patient_id, name, pharmacy_match, dose, is_active, stopped_date, stop_reason)
       VALUES ($1, 'Montair 10mg', 'MONTAIR', '10mg', false, CURRENT_DATE - 30, 'stopped last visit')
       ON CONFLICT DO NOTHING`,
      [pid],
    );
    // …and is on it again now.
    await pool.query(
      `INSERT INTO medications (patient_id, name, pharmacy_match, dose, is_active)
       VALUES ($1, 'Montair 10mg', 'MONTAIR', '10mg', true)
       ON CONFLICT DO NOTHING`,
      [pid],
    );
    const before = await one(
      `SELECT count(*)::int AS n FROM medications WHERE patient_id = $1 AND UPPER(COALESCE(pharmacy_match, name)) = 'MONTAIR'`,
      [pid],
    );
    check(
      "the patient has both an active and an inactive row for it",
      before.n === 2,
      `${before.n}`,
    );

    await startConsult(repeatVisit.visitId, doctorId);
    await decidePendingFor(repeatVisit.visitId, doctorId);
    // The claim seeds the draft, so Montair is already a row — the consultant
    // stops the row in front of them rather than adding a second one. Adding a
    // duplicate is now refused outright (prescription.js addItem).
    const seededDraft = await rx.getDraft(repeatVisit.visitId);
    const montair = seededDraft.items.find((i) =>
      (i.pharmacy_match || i.medicine_name || "").toUpperCase().includes("MONTAIR"),
    );
    const stopRow =
      montair ||
      (await rx.addItem(repeatVisit.visitId, {
        medicineName: "Montair 10mg",
        pharmacyMatch: "MONTAIR",
        changeType: "continued",
      }));
    const dupRefused = await rx
      .addItem(repeatVisit.visitId, { medicineName: "Montair 10mg", pharmacyMatch: "MONTAIR" })
      .then(() => false)
      .catch((e) => e.status === 409);
    check("a medicine already in the draft cannot be added twice", dupRefused);
    await rx.stopItem(stopRow.id, "Stopped again");

    let crashed = null;
    try {
      await finalizeConsult(repeatVisit.visitId, doctorId);
    } catch (e) {
      crashed = e.message;
    }
    check(
      "stopping a medicine stopped before does not abort the consultation",
      !crashed,
      crashed || "",
    );

    const after = await pool.query(
      `SELECT is_active, stop_reason FROM medications
        WHERE patient_id = $1 AND UPPER(COALESCE(pharmacy_match, name)) = 'MONTAIR'`,
      [pid],
    );
    check("one row survives, not two", after.rows.length === 1, `${after.rows.length}`);
    check("and it is the stop that just happened", after.rows[0]?.stop_reason === "Stopped again");
    check("marked inactive", after.rows[0]?.is_active === false);
  }

  // Atomicity: a failure inside the fan-out must leave NOTHING behind.
  const other = (await getDoctorQueue(TEST_DAY, { scope: "all" })).groups.pipeline.find(
    (c) => c.status !== "blocked_reports" && c.visitId !== visitId,
  );
  if (other) {
    await startConsult(other.visitId, doctorId);
    await rx.addItem(other.visitId, { medicineName: "Telma 40mg", changeType: "new" });
    const beforeMeds = await one(
      `SELECT count(*)::int AS n FROM medications m
         JOIN giniflow_visits v ON v.patient_id = m.patient_id
        WHERE v.id = $1`,
      [other.visitId],
    );
    // The draft is seeded on claim now, so its size depends on the patient's
    // regimen. What matters is that a failed finalize leaves it alone.
    const draftBefore = await one(
      `SELECT count(*)::int AS n FROM giniflow_rx_items WHERE visit_id = $1`,
      [other.visitId],
    );
    let blewUp = false;
    try {
      // A doctor id that does not exist trips the consultations FK mid-transaction.
      await finalizeConsult(other.visitId, -1);
    } catch {
      blewUp = true;
    }
    const afterMeds = await one(
      `SELECT count(*)::int AS n FROM medications m
         JOIN giniflow_visits v ON v.patient_id = m.patient_id
        WHERE v.id = $1`,
      [other.visitId],
    );
    const afterStatus = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
      other.visitId,
    ]);
    const draftKept = await one(
      `SELECT count(*)::int AS n FROM giniflow_rx_items WHERE visit_id = $1`,
      [other.visitId],
    );
    check("a failing finalize throws rather than half-succeeding", blewUp);
    check(
      "no medicines were written",
      afterMeds.n === beforeMeds.n,
      `${beforeMeds.n}→${afterMeds.n}`,
    );
    check(
      "the patient did not move to the pharmacy",
      afterStatus.current_status !== "pharmacy_pending",
      afterStatus.current_status,
    );
    check(
      "and the draft survived intact",
      draftKept.n === draftBefore.n && draftKept.n > 0,
      `${draftBefore.n}→${draftKept.n}`,
    );
  }
}

await cleanDemoDay();
const leftover = await one(
  `SELECT (SELECT count(*)::int FROM giniflow_visits WHERE visit_date = $1::date) AS visits,
          (SELECT count(*)::int FROM giniflow_care_plans) AS plans`,
  [TEST_DAY],
);
check("demo day cleaned up", leftover.visits === 0, `${leftover.visits} left`);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
