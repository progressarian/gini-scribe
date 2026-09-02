// Referrals station: the chips, the letter, the send guard, the appointment and
// the close.
//
// Runs against a day of its own (never today's real floor), and cleans up.
//
//   npm run smoke:giniflow-referrals   (from server/)
//
// One thing this deliberately does NOT do: upload. `.env` points at production
// storage, and a smoke run that leaves a demo patient's referral letter sitting
// in the hospital's public bucket for ever is a worse outcome than an untested
// PUT. So the render is asserted for real (`renderLetter`, no write) and the
// upload half is asserted through its guard — `letter_file_url` set means
// generateLetter is a no-op, which is the invariant Finalize depends on.
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";
import {
  getReferrals,
  searchReferralPatients,
  createReferral,
  removeReferral,
  referralsForVisit,
  renderLetter,
  storedLetterUrl,
  generateLetter,
  sendLetter,
  bookAppointment,
  completeReferral,
} from "../services/giniflow/referralsStation.js";
import { finalizePreview } from "../services/giniflow/finalize.js";
import {
  SPECIALTIES,
  URGENCIES,
  specialtyLabel,
  isValidSpecialty,
} from "../../shared/giniflowReferrals.js";
import { CHAIN, STATUS_LABEL, BOARD_COLUMNS } from "../../shared/giniflowStatus.js";
import { giniflowReferralCompleteSchema, giniflowReferralSchema } from "../schemas/index.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

const TEST_DAY = "2019-01-05";

// ── The vocabulary — pure, no database ──────────────────────────────────────
console.log("\nreferral vocabulary");

check(
  "the union of both prototypes' specialty lists is one list",
  isValidSpecialty("podiatry") && isValidSpecialty("gastroenterology"),
);
check(
  "every specialty carries an icon, so the card, the chip and the letter agree",
  SPECIALTIES.every((s) => s.icon && s.label && s.value),
);
check(
  "urgency keeps the prototype's own wording",
  URGENCIES.find((u) => u.value === "urgent").label === "Urgent (within 48 hrs)",
);

// A referral is parallel to the chain. If any of these ever change, the plan's
// central claim — "no status-chain work is needed" — has quietly stopped being
// true and this station has grown a second meaning.
check(
  "no referral status leaked into the visit status chain",
  !CHAIN.includes("letter_generated") &&
    !CHAIN.includes("appointment_booked") &&
    !Object.keys(STATUS_LABEL).includes("letter_generated") &&
    !BOARD_COLUMNS.some((c) => c.key === "referrals"),
);

check(
  "the create schema refuses a referral with no reason",
  !giniflowReferralSchema.safeParse({
    visitId: "00000000-0000-0000-0000-000000000000",
    specialty: "cardiology",
    reason: "",
  }).success,
);
check(
  "closing the loop must be confirmed",
  !giniflowReferralCompleteSchema.safeParse({ confirm: false }).success &&
    giniflowReferralCompleteSchema.safeParse({ confirm: true }).success,
);

// ── The floor ───────────────────────────────────────────────────────────────
await cleanDemoDay();
await seedDemoDay({ date: TEST_DAY });

const visit = await one(
  `SELECT v.id, v.patient_id, p.name, p.phone
     FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
    WHERE v.visit_date = $1::date ORDER BY v.created_at LIMIT 1`,
  [TEST_DAY],
);

console.log("\nthe consultant's chips");

const cardio = await createReferral(visit.id, { specialty: "cardiology" });
const ophtha = await createReferral(visit.id, { specialty: "ophthalmology" });

let onVisit = await referralsForVisit(visit.id);
check("selecting two chips creates exactly two rows", onVisit.length === 2, `${onVisit.length}`);
check(
  "one row per specialty, both created, both carrying the visit",
  onVisit.every((r) => r.status === "created" && r.visitId === visit.id) &&
    new Set(onVisit.map((r) => r.specialty)).size === 2,
);

// The chip is a toggle, and a tablet double-tap must not write a second letter.
const again = await createReferral(visit.id, { specialty: "cardiology" });
onVisit = await referralsForVisit(visit.id);
check("tapping the same chip twice is idempotent", onVisit.length === 2 && again.id === cardio.id);

check(
  "the visit's status never moved because of a referral",
  (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visit.id]))
    .current_status !== "letter_generated",
);

console.log("\nthe station's list");

let list = await getReferrals(TEST_DAY);
check("both referrals are in today's group", list.today.length === 2, `${list.today.length}`);
check("and nothing landed in the past group", list.past.length === 0);
check("the count is real, not a hard-coded string", list.counts.today === 2);

await pool.query(`UPDATE giniflow_referrals SET urgency = 'urgent' WHERE id = $1`, [ophtha.id]);
list = await getReferrals(TEST_DAY);
check(
  "urgency orders the list — there is no SLA to sort by",
  list.today[0].id === ophtha.id,
  list.today.map((r) => r.urgency).join(","),
);

const found = await getReferrals(TEST_DAY, { q: visit.name.split(/\s+/)[0] });
check("search finds the patient by name", found.today.length === 2, `${found.today.length}`);
const missed = await getReferrals(TEST_DAY, { q: "zzzznobody" });
check("and finds nothing when nobody matches", missed.today.length === 0);

const picker = await searchReferralPatients(TEST_DAY, visit.name.split(/\s+/)[0]);
check(
  "the form's patient picker only offers patients on the floor that day",
  picker.some((p) => p.visitId === visit.id),
);
check(
  "and refuses to search on one character",
  (await searchReferralPatients(TEST_DAY, "a")).length === 0,
);

console.log("\nthe letter");

const { pdf, referral } = await renderLetter(cardio.id);
// Puppeteer hands back a Uint8Array, not a Buffer — `.toString()` on that is a
// comma-separated list of byte values, which reads as a passing check right up
// until it isn't.
const head = Buffer.from(pdf.subarray(0, 8)).toString("latin1");
check("the letter renders", pdf.length > 0, `${pdf.length} bytes`);
check("and is a PDF", head.startsWith("%PDF"), head);
check("it addresses the right patient", referral.name === visit.name, referral.name);
check("and names the specialty it is being sent to", referral.specialtyLabel === "Cardiology");
check(
  "the render wrote nothing",
  !(await one(`SELECT letter_file_url FROM giniflow_referrals WHERE id = $1`, [cardio.id]))
    .letter_file_url,
);
// The upload guard, without uploading (see the note at the top of this file).
await pool.query(
  `UPDATE giniflow_referrals
      SET letter_file_url = 'https://example.invalid/letter.pdf',
          letter_generated_at = NOW(), status = 'letter_generated'
    WHERE id = $1`,
  [cardio.id],
);
const regen = await generateLetter(cardio.id);
check(
  "a referral that already has a letter is not rendered a second time",
  regen.generated === false && regen.alreadyGenerated === true,
);

check(
  "the stored letter is what the inline route serves — not a fresh render per click",
  (await storedLetterUrl(cardio.id)) === "https://example.invalid/letter.pdf",
);
check(
  "a referral with no stored letter still renders on demand",
  (await storedLetterUrl(ophtha.id)) === null,
);

// RF-02. The upsert backs two callers. A re-tapped chip is a no-op; the desk's
// create form must not silently rewrite the addressee of a letter that has
// already gone out.
const retap = await createReferral(visit.id, { specialty: "cardiology", source: "chip" });
check(
  "re-tapping a chip whose letter exists is a no-op, not an edit",
  retap.id === cardio.id && retap.toDoctor === null,
  `${retap.toDoctor}`,
);
let clash = null;
try {
  await createReferral(visit.id, {
    specialty: "cardiology",
    toDoctor: "Dr. B",
    reason: "second opinion",
  });
} catch (e) {
  clash = e;
}
check(
  "and the desk is refused rather than overwriting the sent referral",
  clash?.status === 409,
  clash?.message,
);
check(
  "the referral still names the doctor its letter was addressed to",
  (await one(`SELECT to_doctor FROM giniflow_referrals WHERE id = $1`, [cardio.id])).to_doctor ===
    null,
);

const preview = await finalizePreview(visit.id);
check(
  "Finalize names the specialties rather than counting them",
  preview.referrals.length === 2 &&
    preview.referrals.every((r) => r.label.includes("referral")) &&
    preview.referrals.some((r) => r.label.includes(specialtyLabel("ophthalmology"))),
  preview.referrals.map((r) => r.label).join(" · "),
);
check(
  "and says which letters already exist, so a second finalize adds no second file",
  preview.referrals.filter((r) => r.hasLetter).length === 1,
);

console.log("\nsending");

// `to: "doctor"` with no specialist phone on file is a refusal the desk can act
// on, not a silent no-op.
let refused = null;
try {
  await sendLetter(ophtha.id, { to: "doctor" });
} catch (e) {
  refused = e;
}
check(
  "sending to a doctor with no number on file is refused 409",
  refused?.status === 409,
  refused?.message,
);

await pool.query(`UPDATE patients SET phone = NULL WHERE id = $1`, [visit.patient_id]);
refused = null;
try {
  await sendLetter(cardio.id, { to: "patient" });
} catch (e) {
  refused = e;
}
check("and so is a patient with no number on file", refused?.status === 409, refused?.message);
await pool.query(`UPDATE patients SET phone = $2 WHERE id = $1`, [
  visit.patient_id,
  visit.phone || "9876543210",
]);

const sent = await sendLetter(cardio.id, { to: "patient" });
check("in dev the send is logged, not sent", sent.dev === true && sent.sent === false);
check(
  "and letter_sent_at is left null — stamping a no-op would block the real send for ever",
  !(await one(`SELECT letter_sent_at FROM giniflow_referrals WHERE id = $1`, [cardio.id]))
    .letter_sent_at,
);

console.log("\nappointment and close");

const booked = await bookAppointment(cardio.id, { date: "2026-09-20", note: "10:30 AM, block B" });
check(
  "an appointment stores the date and flips the status",
  booked.status === "appointment_booked" && booked.appointmentDate === "2026-09-20",
  `${booked.status} / ${booked.appointmentDate}`,
);

const closed = await completeReferral(cardio.id);
check("closing the loop marks it completed", closed.status === "completed");
check("closing it twice changes nothing", (await completeReferral(cardio.id)).unchanged === true);

refused = null;
try {
  await bookAppointment(cardio.id, { date: "2026-10-01" });
} catch (e) {
  refused = e;
}
check("a closed referral refuses a new appointment", refused?.status === 409, refused?.message);

console.log("\nremoving");

refused = null;
try {
  await removeReferral(cardio.id);
} catch (e) {
  refused = e;
}
check(
  "deselecting a chip whose letter exists is refused 409",
  refused?.status === 409,
  refused?.message,
);

const dropped = await createReferral(visit.id, { specialty: "podiatry" });
await removeReferral(dropped.id);
check(
  "deselecting a chip still in `created` removes its row",
  (await referralsForVisit(visit.id)).every((r) => r.specialty !== "podiatry"),
);

await cleanDemoDay();
const leftover = await one(
  `SELECT (SELECT count(*)::int FROM giniflow_visits WHERE visit_date = $1::date) AS visits,
          (SELECT count(*)::int FROM giniflow_referrals) AS referrals`,
  [TEST_DAY],
);
check(
  "the demo day cleaned up, and its referrals cascaded with it",
  leftover.visits === 0 && leftover.referrals === 0,
  `${leftover.visits} visits, ${leftover.referrals} referrals`,
);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
