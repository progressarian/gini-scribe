#!/usr/bin/env node
// Fails when shared/crmVocab.js and the CRM's CHECK constraints disagree.
//
// The vocabularies used to be Postgres enums, where divergence was impossible
// because there was only one list. Moving to TEXT + CHECK bought the ability to
// grow a vocabulary without DDL, and the price is two lists that can drift: a
// stage added to the UI but not the CHECK fails at INSERT, and a stage added to
// the CHECK but not the UI renders as a raw slug. This closes that gap.
//
// Reads the constraints from SQL rather than a live database so it runs in CI
// with no service, and so a mismatch is caught before the migration is applied.
//
// Run: node server/crm/checkVocabSync.mjs

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SQL = join(REPO_ROOT, "server", "migrations", "2026-09-16_crm_phase1.sql");
const VOCAB = join(REPO_ROOT, "shared", "crmVocab.js");

// column name in SQL -> exported *_VALUES array in shared/crmVocab.js
const PAIRS = [
  ["role", "CRM_ROLE_VALUES"],
  ["priority", "DOCTOR_PRIORITY_VALUES", { table: "doctors" }],
  ["relationship_stage", "RELATIONSHIP_STAGE_VALUES"],
  ["visit_type", "VISIT_TYPE_VALUES"],
  ["outcome", "VISIT_OUTCOME_VALUES"],
  ["source", "REFERRAL_SOURCE_VALUES", { table: "doctor_referrals" }],
  ["answer_type", "REFERRAL_ANSWER_TYPE_VALUES"],
  ["attribution_status", "ATTRIBUTION_STATUS_VALUES"],
  ["urgency", "URGENCY_VALUES"],
  ["status", "REFERRAL_STATUS_VALUES", { table: "doctor_referrals" }],
  ["priority", "TASK_PRIORITY_VALUES", { table: "tasks" }],
  ["status", "TASK_STATUS_VALUES", { table: "tasks" }],
  ["status", "CONSENT_STATUS_VALUES", { table: "patient_consents" }],
  ["source", "REVENUE_SOURCE_VALUES", { table: "revenue_records" }],
  ["status", "IMPORT_ROW_STATUS_VALUES", { table: "import_rows" }],
];

const sql = await readFile(SQL, "utf8");
const vocabSrc = await readFile(VOCAB, "utf8");
const vocab = await import(`file://${VOCAB}`);

// Every `check (<col> in ('a', 'b'))` in the file, tagged with the table whose
// CREATE TABLE block it sits inside.
const checks = [];
let currentTable = null;
for (const line of sql.split("\n")) {
  const t = /^create table (?:if not exists )?crm\.(\w+)/.exec(line);
  if (t) currentTable = t[1];
  // Nullable columns read `check (col is null or col in (...))`, so match the
  // `<col> in (...)` clause wherever it sits rather than anchoring to "check (".
  const c = /(\w+) in \((\s*'[^)]*)\)/.exec(line);
  if (c) {
    checks.push({
      table: currentTable,
      column: c[1],
      values: [...c[2].matchAll(/'([^']*)'/g)].map((m) => m[1]),
    });
  }
}

const problems = [];
for (const [column, exportName, opts = {}] of PAIRS) {
  const jsValues = vocab[exportName];
  if (!Array.isArray(jsValues)) {
    problems.push(`shared/crmVocab.js does not export ${exportName}`);
    continue;
  }
  const match = checks.find(
    (c) => c.column === column && (!opts.table || c.table === opts.table),
  );
  if (!match) {
    problems.push(`no CHECK found for ${opts.table ?? "?"}.${column} (expected ${exportName})`);
    continue;
  }
  const inSqlOnly = match.values.filter((v) => !jsValues.includes(v));
  const inJsOnly = jsValues.filter((v) => !match.values.includes(v));
  if (inSqlOnly.length || inJsOnly.length) {
    problems.push(
      `${match.table}.${column} vs ${exportName}` +
        (inSqlOnly.length ? `\n      only in SQL CHECK: ${inSqlOnly.join(", ")}` : "") +
        (inJsOnly.length ? `\n      only in crmVocab:  ${inJsOnly.join(", ")}` : ""),
    );
  }
}

// The derived vocabularies have no CHECK to compare against — v_doctor_visit_due
// computes due_state, and v_doctor_kpis buckets statuses — so verify instead
// that every value they name is one the journey vocabulary actually contains.
for (const name of ["CONVERTED_STATUSES", "ADMITTED_STATUSES"]) {
  const stray = vocab[name].filter((v) => !vocab.REFERRAL_STATUS_VALUES.includes(v));
  if (stray.length) problems.push(`${name} names unknown statuses: ${stray.join(", ")}`);
}
if (!/due_state/.test(sql) && !vocabSrc.includes("VISIT_DUE_STATES")) {
  problems.push("VISIT_DUE_STATES has no counterpart in the schema");
}

if (problems.length) {
  console.error("CRM VOCABULARY DRIFT\n");
  problems.forEach((p) => console.error(`  - ${p}`));
  console.error(
    "\nshared/crmVocab.js and the CHECK constraints in\n" +
      "server/migrations/2026-09-16_crm_phase1.sql must list the same values.\n" +
      "A value in only one of them either fails at INSERT or renders as a raw slug.\n",
  );
  process.exit(1);
}

console.log(`CRM vocabulary: ${PAIRS.length} lists agree between crmVocab.js and the CHECK constraints`);
