#!/usr/bin/env node
// Exercises the doctor import wizard end to end: parse -> map -> stage ->
// preview -> commit, using synthetic rows that mimic the shape of a
// transcribed handwritten list (no mobile numbers, a confidence column,
// duplicate names inside one territory).
//
// Refuses to run against anything but a local scratch database. The wizard
// writes to crm.doctors, and DATABASE_URL in .env points at production.
//
// Needs a FRESH database: it asserts on dedup outcomes, so doctors left behind
// by a previous run change the answers. Rebuild first with
// server/migrations/crm/rehearse_migration.sh.
//
//   DATABASE_URL=postgresql://postgres:test@localhost:55434/rehearsal \
//     node scripts/smoke-crm-import.mjs

import "../loadEnv.js";
import * as XLSX from "xlsx";

const dsn = process.env.DATABASE_URL || "";
if (!/localhost|127\.0\.0\.1|host\.docker\.internal/.test(dsn)) {
  console.error("Refusing to run: DATABASE_URL is not a local scratch database.");
  console.error("This writes to crm.doctors. Point it at a throwaway Postgres first.");
  process.exit(1);
}

const { parseSheet, suggestMapping, interpretRow, needsVerification, rowErrors } =
  await import("../crm/importDoctors.js");
const { createBatch, previewBatch, commitBatch } = await import("../crm/importDoctors.js");
const pool = (await import("../config/db.js")).default;

const CRM_USER = { id: "22222222-2222-2222-2222-222222222222" };

// Deliberately awkward: blank mobiles throughout, a repeated name in one
// territory, a genuine duplicate of a fixture doctor, a confidence column with
// mixed casing, and one row with no name at all.
const CSV = `Doctor Name,Territory,Area,City,Qualification,Notes,Transcription Confidence
Dr Amrit Kaur,Mohali,Phase 7,Mohali,MBBS MD,Runs a busy morning OPD,high
Dr Baljit Singh,Kharar,Main Bazaar,Kharar,MBBS,,check spelling
Dr Amrit Kaur,Mohali,Phase 7,Mohali,MBBS MD,Second note from another page,high
Dr Chetan Verma,Zirakpur,VIP Road,Zirakpur,MS Ortho,Sends ortho cases elsewhere,CHECK - area unclear
Dr Owned By A,Mohali,Phase 5,Mohali,MBBS,Already in the universe,high
,Patiala,,Patiala,MBBS,Name illegible on the note,check
Dr Eshan Gill,Derabassi,Market Road,Derabassi,MBBS DNB,Interested in ICU tie-up,medium
`;

let pass = 0;
let fail = 0;
const ok = (m) => (pass++, console.log(`  \x1b[32mPASS\x1b[0m  ${m}`));
const bad = (m, got) => (fail++, console.log(`  \x1b[31mFAIL\x1b[0m  ${m}\n        got: ${got}`));
const eq = (actual, expected, m) =>
  String(actual) === String(expected) ? ok(`${m} (= ${expected})`) : bad(m, actual);

console.log("\nParsing and mapping");
const buf = Buffer.from(CSV, "utf8");
const { headers, rows } = parseSheet(buf, "synthetic.csv");
eq(rows.length, 7, "seven data rows parsed");
const mapping = suggestMapping(headers);
eq(mapping["Doctor Name"], "full_name", "'Doctor Name' maps itself");
eq(mapping["Territory"], "territory", "'Territory' maps itself");
eq(mapping["Qualification"], "qualifications", "'Qualification' maps to qualifications");
eq(
  mapping["Transcription Confidence"],
  "transcription_confidence",
  "'Transcription Confidence' maps itself",
);

// The real transcribed list uses compound header names. Both were dropped
// silently on the first run through, which is exactly the data loss the
// mapping step exists to prevent — so they are pinned here.
const compound = suggestMapping([
  "name",
  "territory",
  "area",
  "city",
  "qualification_notes",
  "other_notes",
  "transcription_confidence",
]);
eq(
  compound["qualification_notes"],
  "qualifications",
  "'qualification_notes' maps to qualifications",
);
eq(compound["other_notes"], "notes", "'other_notes' maps to notes");
eq(
  Object.keys(compound).length,
  7,
  "every column of the transcribed list maps with no manual work",
);

console.log("\nConfidence flagging");
eq(needsVerification("check spelling"), true, "'check spelling' needs verification");
eq(needsVerification("CHECK - area unclear"), true, "'CHECK - area unclear' needs verification");
eq(needsVerification("high"), false, "'high' does not");
eq(needsVerification(""), false, "an empty confidence does not");
eq(
  needsVerification("checked and correct"),
  false,
  "'checked and correct' does not — word boundary",
);

console.log("\nRow interpretation");
const first = interpretRow(rows[0], mapping);
eq(first.full_name, "Dr Amrit Kaur", "name carried through");
eq(first.priority, "unclassified", "no priority column means unclassified, not null");
eq(first.mobile ?? "null", "null", "a blank mobile stays null");
eq(rowErrors(interpretRow(rows[5], mapping)).length, 1, "the nameless row reports one error");

console.log("\nStaging and preview");
const { batchId } = await createBatch(CRM_USER, {
  fileName: "synthetic.csv",
  headers,
  rows,
  mapping,
});
const preview = await previewBatch(CRM_USER, batchId);
eq(preview.rows.length, 7, "preview covers every row");
eq(preview.counts.error || 0, 1, "one row is an error");
eq(preview.counts.possible_duplicate || 0, 2, "two possible duplicates by name + territory");
const dupRow = preview.rows.find((r) => r.values.full_name === "Dr Owned By A");
eq(dupRow.status, "possible_duplicate", "an existing fixture doctor is flagged");
eq(
  dupRow.matched_doctor?.full_name,
  "Dr Owned By A",
  "…and the preview names who it collided with",
);
const inFile = preview.rows.find((r) => r.row_number === 4);
eq(inFile.status, "possible_duplicate", "the repeated name inside the file is flagged");
eq(
  inFile.flags.some((f) => /row 2 in this file/.test(f)),
  true,
  "…pointing at the earlier row",
);
eq(
  preview.rows.filter((r) => r.flags.some((f) => /skeleton record/.test(f))).length,
  6,
  "every non-error row is flagged as a skeleton (no mobiles in this file)",
);
eq(
  preview.rows.filter((r) => r.flags.some((f) => /Transcription uncertain/.test(f))).length,
  3,
  // Three in the preview, including the nameless row: an operator fixing that
  // row should see both problems at once, not discover the second after the
  // first is solved. Only two survive to commit.
  "three rows carry the transcription warning",
);

console.log("\nNothing is written before commit");
const before = await pool.query("SELECT count(*)::int AS n FROM crm.doctors");
eq(
  (
    await pool.query("SELECT count(*)::int AS n FROM crm.doctors WHERE import_batch_id=$1", [
      batchId,
    ])
  ).rows[0].n,
  0,
  "preview wrote no doctors",
);

console.log("\nCommit");
// Skip the duplicate of the existing fixture doctor, keep the rest.
const commit = await commitBatch(CRM_USER, batchId, [dupRow.row_number]);
eq(commit.created, 5, "five doctors created");
eq(commit.skipped, 1, "one skipped by operator choice");
eq(commit.errored, 1, "one errored row not written");
const after = await pool.query("SELECT count(*)::int AS n FROM crm.doctors");
eq(after.rows[0].n - before.rows[0].n, 5, "the universe grew by exactly five");

const flagged = await pool.query(
  "SELECT count(*)::int AS n FROM crm.doctors WHERE import_batch_id=$1 AND needs_verification",
  [batchId],
);
eq(flagged.rows[0].n, 2, "two imported doctors carry needs_verification");
const incomplete = await pool.query(
  "SELECT count(*)::int AS n FROM crm.doctors WHERE import_batch_id=$1 AND NOT profile_complete",
  [batchId],
);
eq(incomplete.rows[0].n, 5, "all five are skeleton records with no mobile");
const terr = await pool.query(
  `SELECT count(*)::int AS n FROM crm.doctors d JOIN crm.territories t ON t.id=d.territory_id
    WHERE d.import_batch_id=$1`,
  [batchId],
);
eq(terr.rows[0].n, 5, "each one resolved to a real territory");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await pool.end();
process.exit(fail === 0 ? 0 : 1);
