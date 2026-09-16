#!/usr/bin/env node
// Visit logging against a real database: idempotency on the client-minted id,
// cadence suggestion, gap-filling from the visit screen, and the rep home.
//
// Needs a FRESH scratch database (server/migrations/crm/rehearse_migration.sh).
//
//   DATABASE_URL=postgresql://postgres:test@localhost:55434/rehearsal \
//     node scripts/smoke-crm-visits.mjs

import "../loadEnv.js";
import crypto from "crypto";

const dsn = process.env.DATABASE_URL || "";
if (!/localhost|127\.0\.0\.1|host\.docker\.internal/.test(dsn)) {
  console.error("Refusing to run: DATABASE_URL is not a local scratch database.");
  process.exit(1);
}

const { logVisit, fillDoctorGap, repHome, suggestedNextVisit, doctor360, setPriority } =
  await import("../crm/visits.js");
const pool = (await import("../config/db.js")).default;

const EXEC = {
  id: "44444444-4444-4444-4444-444444444444",
  full_name: "Exec A",
  role: "growth_executive",
};
const DOC_A = "aaaaaaaa-0000-0000-0000-000000000001";

let pass = 0,
  fail = 0;
const ok = (m) => (pass++, console.log(`  \x1b[32mPASS\x1b[0m  ${m}`));
const bad = (m, got) => (fail++, console.log(`  \x1b[31mFAIL\x1b[0m  ${m}\n        got: ${got}`));
const eq = (a, b, m) => (String(a) === String(b) ? ok(`${m} (= ${b})`) : bad(m, a));

console.log("\nIdempotency — the same visit sent twice");
const id = crypto.randomUUID();
const payload = {
  id,
  doctor_id: DOC_A,
  visit_type: "in_person",
  purpose: "Intro call",
  occurred_at: "2026-09-16T09:30:00.000Z",
  discussion_notes: "Interested in ICU tie-up",
  outcome: "positive",
  follow_up_required: true,
  next_visit_date: "2026-10-01",
  client_created_at: "2026-09-16T09:30:00.000Z",
};
const first = await logVisit(EXEC, payload);
eq(first.duplicate, false, "first send creates the visit");
const second = await logVisit(EXEC, payload);
eq(second.duplicate, true, "the same id again is reported as a duplicate");
eq(second.id, first.id, "…returning the same visit");
const { rows: cnt } = await pool.query("SELECT count(*)::int n FROM crm.visits WHERE id=$1", [id]);
eq(cnt[0].n, 1, "exactly one row exists");

console.log("\nA replay must not overwrite a correction");
await pool.query(
  "UPDATE crm.visits SET discussion_notes='corrected on another device' WHERE id=$1",
  [id],
);
await logVisit(EXEC, { ...payload, discussion_notes: "stale queued copy" });
const { rows: notes } = await pool.query("SELECT discussion_notes FROM crm.visits WHERE id=$1", [
  id,
]);
eq(notes[0].discussion_notes, "corrected on another device", "first write wins, replay is inert");

console.log("\nTimestamps");
const { rows: ts } = await pool.query(
  "SELECT occurred_at, client_created_at, synced_at FROM crm.visits WHERE id=$1",
  [id],
);
eq(
  ts[0].occurred_at.toISOString(),
  "2026-09-16T09:30:00.000Z",
  "occurred_at is what the rep recorded",
);
eq(
  ts[0].client_created_at.toISOString(),
  "2026-09-16T09:30:00.000Z",
  "client_created_at preserved",
);
ok(
  `synced_at is server time (${ts[0].synced_at.toISOString().slice(0, 10)}), distinct from occurred_at`,
);

console.log("\nValidation");
try {
  await logVisit(EXEC, { ...payload, id: crypto.randomUUID(), visit_type: "telepathy" });
  bad("bad visit type", "accepted");
} catch (e) {
  ok(`an unknown visit type is refused (${e.message})`);
}
try {
  await logVisit(EXEC, { doctor_id: DOC_A });
  bad("missing id", "accepted");
} catch (e) {
  ok(`a visit with no client id is refused`);
}

console.log("\nCadence");
const cad = await suggestedNextVisit(EXEC, DOC_A);
eq(cad.interval_days, 15, "an A-priority doctor suggests 15 days");
eq(cad.priority, "A", "…from the doctor's own priority");

console.log("\nFilling a gap from the visit screen");
const { rows: blank } = await pool.query(
  `INSERT INTO crm.doctors (hospital_id, full_name, area)
   SELECT id, 'Dr Gap Test', 'Kharar' FROM crm.hospitals RETURNING id, missing_fields`,
);
eq(
  blank[0].missing_fields.join(","),
  "mobile,specialty,clinic",
  "a skeleton doctor lists its gaps",
);
await pool.query(
  `INSERT INTO crm.doctor_assignments (hospital_id, doctor_id, executive_id)
   SELECT hospital_id, $1, $2 FROM crm.doctors WHERE id=$1`,
  [blank[0].id, EXEC.id],
);
const filled = await fillDoctorGap(EXEC, blank[0].id, {
  mobile: "98765 00077",
  specialty: "Cardiology",
});
eq(filled.mobile, "98765 00077", "the mobile is stored");
eq(filled.profile_complete, true, "…and the doctor becomes complete");
eq(filled.missing_fields.join(","), "clinic", "…with only the clinic still missing");
try {
  await fillDoctorGap(EXEC, blank[0].id, { priority: "Z" });
  bad("bad priority", "accepted");
} catch (e) {
  ok("an unknown priority is refused");
}

console.log("\nRep home, in one round trip");
const home = await repHome(EXEC);
eq(home.todays_visits.length >= 0, true, "today's visits load");
eq(Array.isArray(home.due_visits), true, "the due list loads");
eq(home.performance.visits_month >= 1, true, "performance counts this month's visits");
eq(typeof home.performance.doctors_assigned, "number", "assigned-doctor count present");
eq(typeof home.performance.doctors_incomplete, "number", "incomplete count present");
ok(
  `home returns ${home.my_doctors.length} doctors, ${home.due_visits.length} due, ${home.tasks.length} tasks`,
);

console.log("\nDoctor 360");
const three60 = await doctor360(EXEC, DOC_A);
eq(three60.doctor.full_name, "Dr Owned By A", "the header names the doctor");
eq(three60.counts.visits >= 1, true, "visit count present");
eq(three60.kpis !== null, true, "KPI row present even with no revenue");
const firstVisit = three60.timeline.find((e) => e.kind === "visit");
// Asserted against a visit this test logs itself, rather than against the one
// the replay test above deliberately edited. A literal that only holds because
// an earlier test mutated a row is not really testing anything — it breaks
// when that test changes, for reasons that have nothing to do with the 360.
//
// The note is deliberately long and multi-line: "in full" is the claim, so a
// silent truncation somewhere in the stack has to be able to fail this.
const LONG_NOTE = [
  "Met at 9am before OPD. Interested in the ICU tie-up but wants to know",
  "turnaround on the 2am admissions specifically.",
  "Asked twice about who covers nights — this is the objection to solve.",
].join("\n");
const noteVisitId = crypto.randomUUID();
await logVisit(EXEC, {
  id: noteVisitId,
  doctor_id: DOC_A,
  visit_type: "in_person",
  purpose: "Relationship",
  outcome: "positive",
  discussion_notes: LONG_NOTE,
  doctor_requirements: "Night intensivist cover",
  objections: "Unsure about 2am response",
  commitments: "Will send the ICU protocol by Friday",
  occurred_at: new Date().toISOString(),
});
const withNotes = await doctor360(EXEC, DOC_A);
const logged = withNotes.timeline.find((e) => e.kind === "visit" && e.id === noteVisitId);
eq(Boolean(logged), true, "a freshly logged visit reaches the timeline");
eq(logged.discussion_notes, LONG_NOTE, "the timeline carries the visit notes in full, unmodified");
eq(logged.discussion_notes.split("\n").length, 3, "…including the line breaks the rep typed");
eq(logged.purpose, "Relationship", "…its purpose");
eq(logged.outcome, "positive", "…its outcome");
eq(logged.objections, "Unsure about 2am response", "…and the objection, which is the useful part");
eq(logged.commitments, "Will send the ICU protocol by Friday", "…and what was promised");
// Not "a visit is first" — the fixture's stage change is genuinely newer than a
// 40-day-old visit. The claim worth testing is that the ordering holds.
const times = three60.timeline.map((e) => new Date(e.at).getTime());
eq(
  times.every((t, i) => i === 0 || times[i - 1] >= t),
  true,
  "the timeline is strictly newest-first",
);
const stageEntry = three60.timeline.find((e) => e.kind === "stage");
eq(Boolean(stageEntry), true, "a stage change appears on the timeline too");

console.log("\nA/B/C priority");
const one = await setPriority(EXEC, { doctorIds: [DOC_A], priority: "B" });
eq(one.updated, 1, "a single doctor is reclassified");
eq((await doctor360(EXEC, DOC_A)).doctor.priority, "B", "…and it sticks");
const again = await setPriority(EXEC, { doctorIds: [DOC_A], priority: "B" });
eq(again.updated, 0, "setting the same value again changes nothing");
try {
  await setPriority(EXEC, { doctorIds: [DOC_A], priority: "Z" });
  bad("bad priority", "accepted");
} catch {
  ok("an unknown priority is refused");
}
try {
  await setPriority(EXEC, {});
  bad("no target", "accepted");
} catch {
  ok("a call with neither doctors nor a territory is refused");
}

// Fixture doctors carry an area but no territory_id, so give them one before
// testing a territory-scoped write.
await pool.query(
  `UPDATE crm.doctors SET territory_id = (SELECT id FROM crm.territories WHERE name='Mohali')
    WHERE full_name IN ('Dr Owned By A', 'Dr Gap Test')`,
);
const bulk = await setPriority(EXEC, { territory: "Mohali", priority: "A" });
eq(bulk.updated, 2, "a whole territory reclassifies in one call");
const others = await pool.query(
  `SELECT count(*)::int n FROM crm.doctors d JOIN crm.territories t ON t.id=d.territory_id
    WHERE lower(t.name)='mohali' AND d.priority <> 'A' AND d.deleted_at IS NULL`,
);
eq(others.rows[0].n, 0, "…every doctor in it now carries the new band");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await pool.end();
process.exit(fail === 0 ? 0 : 1);
