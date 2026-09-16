#!/usr/bin/env node
// Referral capture, the patient journey, and the attribution link (brief §6, §7).
//
// Needs a FRESH scratch database (server/migrations/crm/rehearse_migration.sh).
//
//   DATABASE_URL=postgresql://postgres:test@localhost:55434/rehearsal \
//     node scripts/smoke-crm-referrals.mjs

import "../loadEnv.js";
const dsn = process.env.DATABASE_URL || "";
if (!/localhost|127\.0\.0\.1|host\.docker\.internal/.test(dsn)) {
  console.error("Refusing to run: DATABASE_URL is not a local scratch database.");
  process.exit(1);
}

const { createReferral, advanceReferral, openReferrals, referralDetail } =
  await import("../crm/referrals.js");
const { doctor360 } = await import("../crm/visits.js");
const pool = (await import("../config/db.js")).default;

const EXEC = {
  id: "44444444-4444-4444-4444-444444444444",
  full_name: "Exec A",
  role: "growth_executive",
};
const HOG = { id: "22222222-2222-2222-2222-222222222222", full_name: "VS", role: "head_of_growth" };
const DOC_A = "aaaaaaaa-0000-0000-0000-000000000001";

let pass = 0,
  fail = 0;
const ok = (m) => (pass++, console.log(`  \x1b[32mPASS\x1b[0m  ${m}`));
const bad = (m, got) => (fail++, console.log(`  \x1b[31mFAIL\x1b[0m  ${m}\n        got: ${got}`));
const eq = (a, b, m) => (String(a) === String(b) ? ok(`${m} (= ${b})`) : bad(m, a));

console.log("\nLogging a referral");
const r = await createReferral(EXEC, {
  referring_doctor_id: DOC_A,
  patient_name: "Harbhajan Kaur",
  patient_phone: "98765 43219",
  reason_category: "Chest pain",
  urgency: "urgent",
  expected_action: "Cardiology opinion",
});
eq(r.status, "new", "a new referral starts at New");
eq(r.attribution_status, "claimed", "…and is claimed, not verified");
eq(/^REF-\d{4}-\d{6}$/.test(r.referral_code), true, `…with a human code (${r.referral_code})`);
const own = await pool.query(
  "SELECT responsible_executive_id FROM crm.doctor_referrals WHERE id=$1",
  [r.id],
);
eq(own.rows[0].responsible_executive_id, EXEC.id, "follow-up is assigned to the rep who logged it");
const opened = await referralDetail(EXEC, r.id);
eq(opened.journey.length, 1, "the journey starts with an opening entry");
eq(opened.journey[0].status, "new", "…at New");

console.log("\nValidation");
for (const [input, label] of [
  [{ patient_name: "X" }, "no doctor"],
  [{ referring_doctor_id: DOC_A }, "no patient"],
  [{ referring_doctor_id: DOC_A, patient_name: "X", urgency: "whenever" }, "bad urgency"],
]) {
  try {
    await createReferral(EXEC, input);
    bad(label, "accepted");
  } catch {
    ok(`a referral with ${label} is refused`);
  }
}

console.log("\nMoving it along the funnel");
for (const s of ["contacted", "appointment_booked", "consulted", "admitted"]) {
  const moved = await advanceReferral(EXEC, r.id, { status: s });
  eq(moved.status, s, `a rep can move it to ${s}`);
}
const same = await advanceReferral(EXEC, r.id, { status: "admitted" });
eq(same.unchanged, true, "setting the same status again is a no-op");
const detail = await referralDetail(EXEC, r.id);
eq(detail.journey.length, 5, "every move is on the journey");
eq(detail.journey[0].status, "admitted", "…newest first");

console.log("\nLost needs a reason");
const r2 = await createReferral(EXEC, { referring_doctor_id: DOC_A, patient_name: "Test Lost" });
try {
  await advanceReferral(EXEC, r2.id, { status: "lost" });
  bad("lost with no reason", "accepted");
} catch {
  ok("lost without a reason is refused");
}
const lost = await advanceReferral(EXEC, r2.id, {
  status: "lost",
  lost_reason: "Went to a competitor",
});
eq(lost.status, "lost", "…and with one it goes through");
eq(lost.lost_reason, "Went to a competitor", "…recording why");

console.log("\nOpen leads never go invisible");
const open = await openReferrals(EXEC);
eq(
  open.referrals.some((x) => x.id === r.id),
  true,
  "an in-flight referral is on the open list",
);
eq(
  open.referrals.some((x) => x.id === r2.id),
  false,
  "…a lost one is not",
);
eq(open.summary.urgent >= 1, true, "the summary counts urgent leads");
eq(open.referrals[0].urgency, "urgent", "urgent sorts first");

console.log("\nIt shows on the doctor's timeline");
const t = await doctor360(EXEC, DOC_A);
const onTimeline = t.timeline.find((e) => e.kind === "referral" && e.id === r.id);
eq(Boolean(onTimeline), true, "the referral appears on the Doctor 360");
eq(onTimeline.referral_code, r.referral_code, "…by its code");
eq(onTimeline.status, "admitted", "…at its current status");

console.log("\nAttribution: a claim confirmed at registration");
await pool.query(
  "INSERT INTO public.patients (id,name,phone) VALUES (900,'Harbhajan Kaur','9876543219') ON CONFLICT DO NOTHING",
);
// Counted, not assumed — the fixtures already give this doctor a referral, and
// "no duplicate was created" is a claim about the delta, not an absolute.
const countBefore = (
  await pool.query(
    "SELECT count(*)::int n FROM crm.doctor_referrals WHERE referring_doctor_id=$1",
    [DOC_A],
  )
).rows[0].n;
const before = await pool.query("SELECT attribution_status FROM crm.doctor_referrals WHERE id=$1", [
  r.id,
]);
eq(before.rows[0].attribution_status, "claimed", "the rep's claim is unverified beforehand");
const act = await pool.query(
  "SELECT crm.record_referral_source(900,'doctor',$1,NULL,NULL,'GACH','9876543219') AS w",
  [DOC_A],
);
eq(act.rows[0].w, true, "the registration answer is recorded");
const after = await pool.query(
  "SELECT attribution_status, patient_id FROM crm.doctor_referrals WHERE id=$1",
  [r.id],
);
eq(after.rows[0].attribution_status, "verified", "…and the rep's existing claim becomes VERIFIED");
eq(after.rows[0].patient_id, 900, "…linked to the canonical patient");
const total = await pool.query(
  "SELECT count(*)::int n FROM crm.doctor_referrals WHERE referring_doctor_id=$1",
  [DOC_A],
);
eq(
  total.rows[0].n - countBefore,
  0,
  "no duplicate referral was created — the claim was confirmed, not doubled",
);

console.log("\nAttribution: a referral nobody logged");
await pool.query(
  "INSERT INTO public.patients (id,name,phone) VALUES (901,'Walk In','9000000001') ON CONFLICT DO NOTHING",
);
await pool.query(
  "SELECT crm.record_referral_source(901,'doctor',$1,NULL,NULL,'GACH','9000000001')",
  [DOC_A],
);
const fresh = await pool.query(
  `SELECT attribution_status, status, source FROM crm.doctor_referrals
    WHERE patient_id=901 AND referring_doctor_id=$1`,
  [DOC_A],
);
eq(
  fresh.rows[0].attribution_status,
  "verified",
  "a doctor named at registration creates a VERIFIED referral",
);
eq(fresh.rows[0].source, "gini_scribe", "…sourced from Scribe");
const t2 = await doctor360(HOG, DOC_A);
// countBefore already counts the fixture referral plus the two this test
// logged, so the delta is the one registration created on its own.
eq(
  t2.timeline.filter((e) => e.kind === "referral").length - countBefore,
  1,
  "the referral registration created by itself reaches the timeline",
);

console.log("\n'none/self' creates nothing");
await pool.query(
  "INSERT INTO public.patients (id,name,phone) VALUES (902,'Self Ref','9000000002') ON CONFLICT DO NOTHING",
);
const beforeSelf = await pool.query("SELECT count(*)::int n FROM crm.doctor_referrals");
await pool.query("SELECT crm.record_referral_source(902,'none_self')");
const afterSelf = await pool.query("SELECT count(*)::int n FROM crm.doctor_referrals");
eq(afterSelf.rows[0].n, beforeSelf.rows[0].n, "a walk-in answer creates no referral");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await pool.end();
process.exit(fail === 0 ? 0 : 1);
