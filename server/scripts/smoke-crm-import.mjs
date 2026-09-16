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

// The second real list (a field-force export) uses different header shapes
// again. Four of its six columns were dropped on the first pass — including
// Mobile Number, which would have thrown away 510 real phone numbers and
// imported every doctor as a skeleton.
const fieldForce = suggestMapping([
  "Doctor Name",
  "Area/Patch",
  "Division Speciality",
  "Mobile Number",
  "Clinic Name",
  "Clinic Address",
]);
eq(fieldForce["Mobile Number"], "mobile", "'Mobile Number' maps to mobile");
eq(fieldForce["Division Speciality"], "specialty", "'Division Speciality' maps to specialty");
eq(fieldForce["Area/Patch"], "area", "'Area/Patch' maps to area");
eq(fieldForce["Clinic Name"], "clinic_name", "'Clinic Name' maps to clinic");
eq(fieldForce["Clinic Address"], "address_line", "'Clinic Address' maps to address");
eq(Object.keys(fieldForce).length, 6, "no column of the field-force list is dropped");

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

console.log("\nA list large enough to need chunking");
// 528 rows meant 528 sequential inserts and the pooler dropped the connection
// mid-batch. The staging insert is chunked now; this proves a batch larger than
// one chunk stages completely.
const bigRows = Array.from({ length: 250 }, (_, i) => ({
  "Doctor Name": `Dr Bulk ${i}`,
  Territory: "Mohali",
  "Mobile Number": `98${String(70000000 + i)}`,
}));
const bigMapping = suggestMapping(Object.keys(bigRows[0]));
const big = await createBatch(CRM_USER, {
  fileName: "bulk.csv",
  headers: Object.keys(bigRows[0]),
  rows: bigRows,
  mapping: bigMapping,
});
const bigStaged = await pool.query(
  "SELECT count(*)::int AS n FROM crm.import_rows WHERE batch_id=$1",
  [big.batchId],
);
eq(bigStaged.rows[0].n, 250, "all 250 rows stage across chunk boundaries");
const bigPreview = await previewBatch(CRM_USER, big.batchId);
eq(bigPreview.rows.length, 250, "…and the preview covers every one");
eq(bigPreview.counts.create, 250, "…all importable");

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

console.log("\nField-force rules: patches, shared lines, division codes");
const FF = `Doctor Name,Area/Patch,Division Speciality,Mobile Number,Clinic Name,Clinic Address
DR ONE,MOHALI SOHANA,Pedia_1,9811100001,Clinic A,Sohana
DR TWO,CHANDIGARH TRADE,Pedia_2,9811100002,Clinic B,Sec 17
DR THREE,Panchkula Zirakpur,Chest,9811100003,Paras,Sec 6
DR FOUR,AMBALA,Chest,9811100004,Clinic D,Ambala cantt
DR FIVE,Kalanwali,Consulting physician,9811100005,Shared Clinic,Kalanwali
DR SIX,Kalanwali,Consulting physician,9811100005,Shared Clinic,Kalanwali
`;
const ffRows = parseSheet(Buffer.from(FF, "utf8"), "ff.csv").rows;
const ffMap = suggestMapping(Object.keys(ffRows[0]));
const ffBatch = await createBatch(CRM_USER, {
  fileName: "ff.csv",
  headers: Object.keys(ffRows[0]),
  rows: ffRows,
  mapping: ffMap,
});
const ffPv = await previewBatch(CRM_USER, ffBatch.batchId);
const byName = (n) => ffPv.rows.find((r) => r.values.full_name === n);

eq(byName("DR ONE").resolved_territory, "Mohali", "MOHALI SOHANA resolves to Mohali");
eq(byName("DR TWO").resolved_territory, "Chandigarh", "CHANDIGARH TRADE resolves to Chandigarh");
eq(byName("DR THREE").resolved_territory, "Panchkula", "Panchkula Zirakpur resolves to Panchkula");
eq(
  byName("DR FOUR").resolved_territory,
  "AMBALA",
  "an unknown patch resolves to itself, not a guess",
);
eq(byName("DR ONE").values.specialty, "Pediatrics", "Pedia_1 normalises to Pediatrics");
eq(byName("DR TWO").values.specialty, "Pediatrics", "Pedia_2 normalises to Pediatrics");
eq(byName("DR THREE").values.specialty, "Chest", "other division codes are preserved verbatim");

const five = byName("DR FIVE"),
  six = byName("DR SIX");
eq(five.status, "create", "the first of a shared-line pair imports");
eq(six.status, "create", "…and so does the second — not skipped as a duplicate");
eq(six.values.mobile ?? "null", "null", "…with the number off the mobile field");
eq(six.values.clinic_phone, "9811100005", "…and onto clinic_phone");
eq(
  six.flags.some((f) => /clinic line/.test(f)),
  true,
  "…and the preview says why",
);

// Same number AND same name is one doctor under two patches, not a shared line.
const SAME = `Doctor Name,Area/Patch,Mobile Number
KANWALJIT SINGH,KHARAR,9779903277
KANWALJIT SINGH,ZIRAKPUR,9779903277
`;
const sameRows = parseSheet(Buffer.from(SAME, "utf8"), "same.csv").rows;
const sameBatch = await createBatch(CRM_USER, {
  fileName: "same.csv",
  headers: Object.keys(sameRows[0]),
  rows: sameRows,
  mapping: suggestMapping(Object.keys(sameRows[0])),
});
const samePv = await previewBatch(CRM_USER, sameBatch.batchId);
eq(samePv.rows[0].status, "create", "the first listing of a doctor imports");
eq(
  samePv.rows[1].status,
  "duplicate",
  "the same name on the same number is a duplicate, not a clinic line",
);
eq(samePv.rows[1].values.clinic_phone ?? "null", "null", "…and is not rewritten as a clinic line");

console.log("\nTerritory scoping holds the rest back");
const ffBefore = (await pool.query("SELECT count(*)::int n FROM crm.doctors")).rows[0].n;
const ffCommit = await commitBatch(CRM_USER, ffBatch.batchId, [], {
  onlyTerritories: ["Mohali", "Chandigarh", "Panchkula"],
});
eq(ffCommit.created, 3, "only the three in-catchment rows import");
eq(ffCommit.heldOut, 3, "three rows held back");
const ffAfter = (await pool.query("SELECT count(*)::int n FROM crm.doctors")).rows[0].n;
eq(ffAfter - ffBefore, 3, "the universe grew by exactly three");
const stillPending = await pool.query(
  "SELECT count(*)::int n FROM crm.import_rows WHERE batch_id=$1 AND status='pending'",
  [ffBatch.batchId],
);
eq(stillPending.rows[0].n, 3, "the held rows stay staged for a later run");
const batchStatus = await pool.query("SELECT status FROM crm.import_batches WHERE id=$1", [
  ffBatch.batchId,
]);
eq(batchStatus.rows[0].status, "previewing", "…and the batch is not marked finished");
const terrCheck = await pool.query(
  `SELECT d.full_name, t.name terr, d.clinic_phone, d.mobile FROM crm.doctors d
     LEFT JOIN crm.territories t ON t.id=d.territory_id WHERE d.import_batch_id=$1 ORDER BY t.name`,
  [ffBatch.batchId],
);
eq(
  terrCheck.rows.map((r) => r.terr).join(","),
  "Chandigarh,Mohali,Panchkula",
  "each landed in its resolved territory",
);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await pool.end();
process.exit(fail === 0 ? 0 : 1);
