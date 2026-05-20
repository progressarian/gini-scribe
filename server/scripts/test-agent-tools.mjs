// server/scripts/test-agent-tools.mjs
//
// Exercises every Dr. Gini AI tool with multiple input shapes so you can
// eyeball whether each one returns sane data for a given patient.
//
// Usage (PowerShell):
//   node server/scripts/test-agent-tools.mjs <scribePatientId> [filter]
//
//   node server/scripts/test-agent-tools.mjs 178506
//   node server/scripts/test-agent-tools.mjs 178506 query_patient_data
//   node server/scripts/test-agent-tools.mjs 178506 propose_log
//
// `filter` is a substring match against the test-case name. Omit it to
// run every case.
//
// Output: a green/red summary per case + a JSON preview of the first ~600
// chars of each return value. Failing cases print the full error.
//
// Notes:
//   • DB tools call executeTool() directly — no LLM, no HTTP.
//   • UI tools (propose_log / open_document / open_doctor_chat /
//     classify_and_extract_attachment) call buildClientAction() — they
//     only build the client_action payload, never touch the DB.
//   • create_health_log DOES write to the DB. Those cases are skipped
//     by default. Pass --write to actually run them.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../config/db.js";
import { executeTool, buildClientAction, UI_TOOL_NAMES } from "../services/agent/tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const patientId = Number(args[0]);
const filter = args.find((a, i) => i > 0 && !a.startsWith("--"))?.toLowerCase() || null;
const allowWrites = args.includes("--write");
const fullJson = args.includes("--full"); // print full JSON for every case
// Dump files are written by default (so you can match results against the
// DB + the /visit page). Pass --no-save to skip the dump.
const saveLog = !args.includes("--no-save");

if (!Number.isInteger(patientId) || patientId <= 0) {
  console.error("Usage: node server/scripts/test-agent-tools.mjs <scribePatientId> [filter] [--write]");
  process.exit(1);
}

// ── Test cases ────────────────────────────────────────────────────────
// Each case: { name, tool, input, ui?, write?, expect? }
//   ui:    true → routed through buildClientAction instead of executeTool
//   write: true → skipped unless --write flag is set
//   expect: optional sync predicate against the result, for a pass/fail hint
const CASES = [
  // ── query_patient_data — one case per supported scope ──
  { name: "query_patient_data · profile", tool: "query_patient_data", input: { scope: "profile" } },
  { name: "query_patient_data · vitals (30d)", tool: "query_patient_data", input: { scope: "vitals", range_days: 30 } },
  { name: "query_patient_data · sugar", tool: "query_patient_data", input: { scope: "sugar", limit: 10 } },
  { name: "query_patient_data · bp", tool: "query_patient_data", input: { scope: "bp", limit: 10 } },
  { name: "query_patient_data · weight", tool: "query_patient_data", input: { scope: "weight", limit: 10 } },
  { name: "query_patient_data · labs (all)", tool: "query_patient_data", input: { scope: "labs", limit: 20 } },
  { name: "query_patient_data · labs (HbA1c)", tool: "query_patient_data", input: { scope: "labs", test_name: "HbA1c" } },
  { name: "query_patient_data · labs (LDL)", tool: "query_patient_data", input: { scope: "labs", test_name: "LDL" } },
  { name: "query_patient_data · meds", tool: "query_patient_data", input: { scope: "meds" } },
  { name: "query_patient_data · meals", tool: "query_patient_data", input: { scope: "meals", limit: 10 } },
  { name: "query_patient_data · symptoms", tool: "query_patient_data", input: { scope: "symptoms", limit: 10 } },
  { name: "query_patient_data · med_adherence (1d)", tool: "query_patient_data", input: { scope: "med_adherence", range_days: 1 } },
  { name: "query_patient_data · med_adherence (30d)", tool: "query_patient_data", input: { scope: "med_adherence", range_days: 30 } },
  { name: "query_patient_data · appointments", tool: "query_patient_data", input: { scope: "appointments" } },
  { name: "query_patient_data · diagnoses", tool: "query_patient_data", input: { scope: "diagnoses" } },
  { name: "query_patient_data · since_last_visit", tool: "query_patient_data", input: { scope: "vitals", since_last_visit: true } },

  // ── run_patient_sql — safe SELECTs only ──
  {
    name: "run_patient_sql · simple count",
    tool: "run_patient_sql",
    input: { sql: "SELECT COUNT(*) AS n FROM lab_results WHERE patient_id = $1", reason: "smoke test" },
  },
  {
    name: "run_patient_sql · join (last 5 lab tests)",
    tool: "run_patient_sql",
    input: {
      sql: "SELECT test_name, result, unit, test_date FROM lab_results WHERE patient_id = $1 ORDER BY test_date DESC NULLS LAST LIMIT 5",
      reason: "smoke test",
    },
  },
  {
    name: "run_patient_sql · should REJECT (no patient_id)",
    tool: "run_patient_sql",
    input: { sql: "SELECT 1 AS ok", reason: "expect rejection" },
    expect: (r) => r && r.error,
  },
  {
    name: "run_patient_sql · should REJECT (DML)",
    tool: "run_patient_sql",
    input: { sql: "DELETE FROM lab_results WHERE patient_id = $1", reason: "expect rejection" },
    expect: (r) => r && r.error,
  },

  // ── get_full_patient_context — different window sizes ──
  { name: "get_full_patient_context · default", tool: "get_full_patient_context", input: {} },
  { name: "get_full_patient_context · vitals=7d", tool: "get_full_patient_context", input: { vitals_days: 7 } },
  { name: "get_full_patient_context · vitals=180d", tool: "get_full_patient_context", input: { vitals_days: 180 } },

  // ── get_progress_summary — both window modes ──
  { name: "get_progress_summary · 7d", tool: "get_progress_summary", input: { window: "days", days: 7 } },
  { name: "get_progress_summary · 30d", tool: "get_progress_summary", input: { window: "days", days: 30 } },
  { name: "get_progress_summary · 90d", tool: "get_progress_summary", input: { window: "days", days: 90 } },
  { name: "get_progress_summary · since_last_visit", tool: "get_progress_summary", input: { window: "since_last_visit" } },

  // ── get_medication_schedule ──
  { name: "get_medication_schedule", tool: "get_medication_schedule", input: {} },

  // ── get_appointments — all scopes ──
  { name: "get_appointments · upcoming", tool: "get_appointments", input: { scope: "upcoming" } },
  { name: "get_appointments · past", tool: "get_appointments", input: { scope: "past", limit: 10 } },
  { name: "get_appointments · next", tool: "get_appointments", input: { scope: "next" } },

  // ── get_prescriptions — both scopes ──
  { name: "get_prescriptions · latest", tool: "get_prescriptions", input: { scope: "latest" } },
  { name: "get_prescriptions · all", tool: "get_prescriptions", input: { scope: "all", limit: 5 } },

  // ── propose_log (UI) — exercises the full expanded enum ──
  // Native types (should keep their own logType)
  { ui: true, name: "propose_log · BP", tool: "propose_log", input: { type: "BP", value1: "130", value2: "82", context: "Morning" } },
  { ui: true, name: "propose_log · Sugar fasting", tool: "propose_log", input: { type: "Sugar", value1: "180", context: "Fasting" } },
  { ui: true, name: "propose_log · Weight", tool: "propose_log", input: { type: "Weight", value1: "82" } },
  { ui: true, name: "propose_log · HbA1c", tool: "propose_log", input: { type: "HbA1c", value1: "7.2" } },
  { ui: true, name: "propose_log · LDL", tool: "propose_log", input: { type: "LDL", value1: "118" } },
  { ui: true, name: "propose_log · TSH", tool: "propose_log", input: { type: "TSH", value1: "3.4" } },
  { ui: true, name: "propose_log · Haemoglobin", tool: "propose_log", input: { type: "Haemoglobin", value1: "13.5" } },
  { ui: true, name: "propose_log · eGFR", tool: "propose_log", input: { type: "eGFR", value1: "92" } },

  // Extended types → should be flattened to logType='Lab' with auto test_name/unit
  { ui: true, name: "propose_log · UricAcid (flattened)", tool: "propose_log", input: { type: "UricAcid", value1: "6.5" },
    expect: (r) => r.clientAction.logType === "Lab" && r.clientAction.test_name === "Uric Acid" && r.clientAction.unit === "mg/dL" },
  { ui: true, name: "propose_log · VitaminD (flattened)", tool: "propose_log", input: { type: "VitaminD", value1: "32" },
    expect: (r) => r.clientAction.logType === "Lab" && r.clientAction.test_name === "Vitamin D" },
  { ui: true, name: "propose_log · VitaminB12 (flattened)", tool: "propose_log", input: { type: "VitaminB12", value1: "412" },
    expect: (r) => r.clientAction.logType === "Lab" && r.clientAction.unit === "pg/mL" },
  { ui: true, name: "propose_log · FreeT3 (flattened)", tool: "propose_log", input: { type: "FreeT3", value1: "3.1" } },
  { ui: true, name: "propose_log · FreeT4 (flattened)", tool: "propose_log", input: { type: "FreeT4", value1: "1.2" } },
  { ui: true, name: "propose_log · Creatinine (flattened)", tool: "propose_log", input: { type: "Creatinine", value1: "1.0" } },
  { ui: true, name: "propose_log · Triglycerides (flattened)", tool: "propose_log", input: { type: "Triglycerides", value1: "165" } },
  { ui: true, name: "propose_log · HDL (flattened)", tool: "propose_log", input: { type: "HDL", value1: "48" } },
  { ui: true, name: "propose_log · TotalCholesterol (flattened)", tool: "propose_log", input: { type: "TotalCholesterol", value1: "186" } },
  { ui: true, name: "propose_log · FBS (flattened)", tool: "propose_log", input: { type: "FBS", value1: "108" } },
  { ui: true, name: "propose_log · PPBS (flattened)", tool: "propose_log", input: { type: "PPBS", value1: "162" } },
  { ui: true, name: "propose_log · Sodium (flattened)", tool: "propose_log", input: { type: "Sodium", value1: "138" } },
  { ui: true, name: "propose_log · Potassium (flattened)", tool: "propose_log", input: { type: "Potassium", value1: "4.2" } },
  { ui: true, name: "propose_log · ALT (flattened)", tool: "propose_log", input: { type: "ALT", value1: "34" } },
  { ui: true, name: "propose_log · AST (flattened)", tool: "propose_log", input: { type: "AST", value1: "28" } },
  { ui: true, name: "propose_log · Ferritin (flattened)", tool: "propose_log", input: { type: "Ferritin", value1: "92" } },
  { ui: true, name: "propose_log · Platelets (flattened)", tool: "propose_log", input: { type: "Platelets", value1: "245" } },
  { ui: true, name: "propose_log · CRP (flattened)", tool: "propose_log", input: { type: "CRP", value1: "4.2" } },
  { ui: true, name: "propose_log · ESR (flattened)", tool: "propose_log", input: { type: "ESR", value1: "18" } },

  // Universal Lab fallback for anything not in the enum
  { ui: true, name: "propose_log · generic Lab (Homocysteine)", tool: "propose_log",
    input: { type: "Lab", value1: "14", test_name: "Homocysteine", unit: "µmol/L", ref_range: "5-15", canonical_name: "homocysteine" },
    expect: (r) => r.clientAction.logType === "Lab" && r.clientAction.test_name === "Homocysteine" },

  // Lifestyle types
  { ui: true, name: "propose_log · Food", tool: "propose_log", input: { type: "Food", value1: "Roti + dal + sabzi" } },
  { ui: true, name: "propose_log · Exercise", tool: "propose_log", input: { type: "Exercise", value1: "Walk", value2: "30" } },
  { ui: true, name: "propose_log · Sleep", tool: "propose_log", input: { type: "Sleep", value1: "7", context: "Good" } },
  { ui: true, name: "propose_log · Mood", tool: "propose_log", input: { type: "Mood", value1: "Calm" } },
  { ui: true, name: "propose_log · Symptom", tool: "propose_log", input: { type: "Symptom", value1: "Headache" } },

  // Backdating
  { ui: true, name: "propose_log · backdated BP", tool: "propose_log", input: { type: "BP", value1: "128", value2: "80", date: "2026-05-15" },
    expect: (r) => r.clientAction.date === "2026-05-15" },

  // ── create_health_log (WRITES! gated behind --write) ──
  { write: true, name: "create_health_log · Sugar fasting (writes)", tool: "create_health_log",
    input: { type: "Sugar", value1: "112", context: "Fasting", date: new Date().toISOString().slice(0, 10) } },
  { write: true, name: "create_health_log · Weight (writes)", tool: "create_health_log",
    input: { type: "Weight", value1: "82.5", date: new Date().toISOString().slice(0, 10) } },

  // ── open_document (UI) ──
  { ui: true, name: "open_document · prescription", tool: "open_document",
    input: { document_id: 1, file_url: "https://example.com/rx.pdf", title: "Prescription · 12 May 2026", doc_type: "prescription", doc_date: "2026-05-12" },
    expect: (r) => r.clientAction.type === "open_document" && r.clientAction.file_url.startsWith("http") },

  // ── open_doctor_chat (UI) ──
  { ui: true, name: "open_doctor_chat · chest pain seed", tool: "open_doctor_chat",
    input: { seed: "Patient reports chest pain — please review urgently." },
    expect: (r) => r.clientAction.type === "open_doctor_chat" && r.clientAction.seed.length > 0 },

  // ── classify_and_extract_attachment (UI) ──
  { ui: true, name: "classify_and_extract_attachment · food", tool: "classify_and_extract_attachment",
    input: { kind: "food", summary: "Lunch plate", food_items: [{ name: "Roti", kcal: 120 }, { name: "Dal", kcal: 180 }] },
    expect: (r) => r.clientAction.kind === "food" && r.clientAction.items.length === 2 },
  { ui: true, name: "classify_and_extract_attachment · lab_report", tool: "classify_and_extract_attachment",
    input: { kind: "lab_report", summary: "Lipid panel", lab_items: [{ test_name: "HDL", result: "48", unit: "mg/dL" }] },
    expect: (r) => r.clientAction.kind === "lab_report" && r.clientAction.items.length === 1 },
  { ui: true, name: "classify_and_extract_attachment · prescription", tool: "classify_and_extract_attachment",
    input: { kind: "prescription", summary: "Doctor Rx", rx_items: [{ name: "Metformin", dose: "500mg", frequency: "BD" }] },
    expect: (r) => r.clientAction.kind === "prescription" },
];

// ── Runner ────────────────────────────────────────────────────────────
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function preview(v, n = 1200) {
  try {
    const s = JSON.stringify(v, null, 2);
    if (fullJson) return s;
    return s.length > n ? s.slice(0, n) + `\n…(+${s.length - n} chars — re-run with --full to see all)` : s;
  } catch {
    return String(v);
  }
}

function shapeHint(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v);
    return `object{${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", …" : ""}}`;
  }
  return typeof v;
}

const ctx = { pool, scribePatientId: patientId };
const summary = { passed: 0, failed: 0, skipped: 0 };
const failures = [];
const runLog = []; // every case + its full result, written to disk if --save

const startedAt = new Date();
console.log(
  `\n${DIM}━━━ Dr. Gini AI · agent-tool smoke test ━━━${RESET}\n` +
    `${DIM}patient:${RESET}  ${patientId}\n` +
    `${DIM}cases:${RESET}    ${CASES.length}${filter ? ` (filter='${filter}')` : ""}\n` +
    `${DIM}writes:${RESET}   ${allowWrites ? "ENABLED" : "skipped (pass --write to enable)"}\n` +
    `${DIM}output:${RESET}   ${fullJson ? "full JSON" : "previewed"}${saveLog ? " · saving to disk" : ""}\n` +
    `${DIM}started:${RESET}  ${startedAt.toISOString()}\n`,
);

for (const c of CASES) {
  if (filter && !c.name.toLowerCase().includes(filter) && !c.tool.toLowerCase().includes(filter)) continue;
  if (c.write && !allowWrites) {
    summary.skipped++;
    console.log(`${YELLOW}SKIP${RESET}  ${c.name}   ${DIM}(write — pass --write to run)${RESET}\n`);
    runLog.push({ name: c.name, tool: c.tool, input: c.input, status: "skipped" });
    continue;
  }

  const t0 = Date.now();
  let result;
  let error = null;
  try {
    if (c.ui || UI_TOOL_NAMES.has(c.tool)) {
      result = buildClientAction(c.tool, c.input);
    } else {
      result = await executeTool(c.tool, c.input, ctx);
    }
  } catch (e) {
    error = e;
  }
  const ms = Date.now() - t0;

  // Header line
  console.log(`${DIM}────────────────────────────────────────────${RESET}`);
  console.log(`${DIM}TOOL${RESET}    ${c.tool}`);
  console.log(`${DIM}CASE${RESET}    ${c.name}`);
  console.log(`${DIM}INPUT${RESET}   ${JSON.stringify(c.input)}`);
  console.log(`${DIM}TOOK${RESET}    ${ms} ms`);

  if (error) {
    summary.failed++;
    failures.push({ name: c.name, reason: error?.message || String(error) });
    console.log(`${RED}STATUS  FAIL (exception)${RESET}`);
    console.log(`${DIM}OUTPUT${RESET}`);
    console.log(`${RED}${error?.stack || error}${RESET}\n`);
    runLog.push({
      name: c.name,
      tool: c.tool,
      input: c.input,
      status: "failed",
      ms,
      error: error?.message || String(error),
    });
    continue;
  }

  const ok = c.expect ? !!c.expect(result) : true;
  if (ok) {
    summary.passed++;
    console.log(`${GREEN}STATUS  PASS${RESET}   ${DIM}shape: ${shapeHint(result)}${RESET}`);
  } else {
    summary.failed++;
    failures.push({ name: c.name, reason: "expect() predicate returned false" });
    console.log(`${RED}STATUS  FAIL (expect predicate)${RESET}   ${DIM}shape: ${shapeHint(result)}${RESET}`);
  }
  console.log(`${DIM}OUTPUT${RESET}`);
  console.log(preview(result));
  console.log("");

  runLog.push({
    name: c.name,
    tool: c.tool,
    input: c.input,
    status: ok ? "passed" : "failed",
    ms,
    shape: shapeHint(result),
    result,
  });
}

console.log(
  `\n${DIM}─── Summary ───${RESET}\n` +
    `${GREEN}passed:${RESET}  ${summary.passed}\n` +
    `${RED}failed:${RESET}  ${summary.failed}\n` +
    `${YELLOW}skipped:${RESET} ${summary.skipped}\n`,
);

if (failures.length) {
  console.log(`${RED}Failures:${RESET}`);
  for (const f of failures) console.log(`  • ${f.name} — ${f.reason}`);
}

// ── Verification hints ─────────────────────────────────────────────────
// For each tool, where to look in the DB and on the /visit page to verify
// the agent's data matches the source of truth.
const VERIFY_HINTS = {
  query_patient_data: {
    db: {
      profile: "SELECT name, dob, sex FROM patients WHERE id = $1",
      vitals: "SELECT * FROM vitals WHERE patient_id = $1 ORDER BY recorded_at DESC",
      sugar: "SELECT * FROM vitals WHERE patient_id = $1 AND sugar IS NOT NULL ORDER BY recorded_at DESC",
      bp: "SELECT * FROM vitals WHERE patient_id = $1 AND systolic IS NOT NULL ORDER BY recorded_at DESC",
      weight: "SELECT * FROM vitals WHERE patient_id = $1 AND weight IS NOT NULL ORDER BY recorded_at DESC",
      labs: "SELECT test_name, result, unit, test_date FROM lab_results WHERE patient_id = $1 ORDER BY test_date DESC",
      meds: "SELECT * FROM medications WHERE patient_id = $1",
      meals: "SELECT * FROM patient_meal_log WHERE patient_id = $1 ORDER BY log_date DESC",
      symptoms: "SELECT * FROM patient_symptom_log WHERE patient_id = $1 ORDER BY log_date DESC",
      med_adherence: "SELECT * FROM patient_med_log WHERE patient_id = $1 ORDER BY log_date DESC, dose_time DESC",
      appointments: "SELECT * FROM appointments WHERE patient_id = $1 ORDER BY appointment_date DESC",
      diagnoses: "SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses WHERE patient_id = $1 ORDER BY diagnosis_id, is_active DESC, updated_at DESC",
    },
    visit_page: "Profile/Vitals/Labs/Medications/Diagnoses panels on /visit",
  },
  run_patient_sql: {
    db: "Whatever SELECT you authored — $1 is always bound to the patient_id.",
    visit_page: "Any data the doctor sees on /visit (use the SCHEMA_HINT recipes for parity)",
  },
  get_full_patient_context: {
    db: "Bundled read across patients + diagnoses + medications + lab_results + vitals + symptoms + appointments tables.",
    visit_page: "Match against ALL panels on /visit — Profile, Diagnoses, Medications, Labs, Vitals, Visit history.",
  },
  get_progress_summary: {
    db: "Aggregates across vitals + lab_results + medications over the requested window.",
    visit_page: "Trend chips on /visit and the dashboard.",
  },
  get_medication_schedule: {
    db: "SELECT name, dose, frequency, when_to_take, timing FROM medications WHERE patient_id = $1 AND is_active = true",
    visit_page: "Active medications panel on /visit — values should match name + dose + timing exactly.",
  },
  get_appointments: {
    db: "Mirrors /visit?tab=history merged query — server/routes/visit.js:288 (consultations UNION appointments, dedupe by date).",
    visit_page: "/visit?tab=history — every row in get_appointments(scope='past') should appear on that tab with the same date + doctor + status.",
  },
  get_prescriptions: {
    db: "SELECT * FROM documents WHERE patient_id = $1 AND doc_type = 'prescription' ORDER BY doc_date DESC",
    visit_page: "Documents/Prescriptions panel on /visit and /docs — each row.file_url should open the same PDF.",
  },
  propose_log: {
    db: "(UI tool — no DB read. Verifies the client_action payload only.)",
    visit_page: "(UI tool — opens the log modal in the RN app.)",
  },
  create_health_log: {
    db: "Writes a row to vitals / lab_results / patient_meal_log / patient_symptom_log depending on type.",
    visit_page: "New entry should appear on /visit and the relevant patient companion screen.",
  },
  open_document: { db: "(UI tool)", visit_page: "(UI tool)" },
  open_doctor_chat: { db: "(UI tool)", visit_page: "(UI tool)" },
  classify_and_extract_attachment: { db: "(UI tool)", visit_page: "(UI tool)" },
};

function hintFor(tool, input) {
  const h = VERIFY_HINTS[tool];
  if (!h) return null;
  let dbHint = h.db;
  if (tool === "query_patient_data" && input?.scope && typeof h.db === "object") {
    dbHint = h.db[input.scope] || `(no specific hint for scope='${input.scope}')`;
  }
  return { db: dbHint, visit_page: h.visit_page };
}

// ── Always dump results to disk (unless --no-save) ─────────────────────
if (saveLog) {
  const outDir = path.join(__dirname, "test-runs");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");

  // 1) Machine-readable JSON — full inputs + results + timings.
  const jsonFile = path.join(outDir, `agent-tools-${patientId}-${stamp}.json`);
  fs.writeFileSync(
    jsonFile,
    JSON.stringify(
      {
        patient_id: patientId,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        filter,
        write_enabled: allowWrites,
        summary,
        cases: runLog.map((c) => ({ ...c, verify: hintFor(c.tool, c.input) })),
      },
      null,
      2,
    ),
  );

  // 2) Human-readable Markdown — grouped by tool, with the SQL you can run
  //    to verify, the /visit panel to cross-check, and the result preview.
  const md = [];
  md.push(`# Agent tools run — patient ${patientId}`);
  md.push("");
  md.push(`- Started: \`${startedAt.toISOString()}\``);
  md.push(`- Finished: \`${new Date().toISOString()}\``);
  md.push(`- Filter: ${filter ? `\`${filter}\`` : "_(none — all cases)_"}`);
  md.push(`- Writes: ${allowWrites ? "**ENABLED**" : "skipped"}`);
  md.push(
    `- Summary: ✅ ${summary.passed} passed · ❌ ${summary.failed} failed · ⏭️ ${summary.skipped} skipped`,
  );
  md.push("");
  md.push("> Use the **DB query** and **/visit panel** columns to verify each result against the source of truth. The JSON output is what the agent would send to the model / RN app.");
  md.push("");

  const byTool = new Map();
  for (const c of runLog) {
    if (!byTool.has(c.tool)) byTool.set(c.tool, []);
    byTool.get(c.tool).push(c);
  }
  for (const [tool, cases] of byTool) {
    md.push(`## \`${tool}\``);
    md.push("");
    for (const c of cases) {
      const icon = c.status === "passed" ? "✅" : c.status === "failed" ? "❌" : "⏭️";
      const hint = hintFor(c.tool, c.input);
      md.push(`### ${icon} ${c.name}`);
      md.push("");
      md.push(`- **Input:** \`${JSON.stringify(c.input)}\``);
      if (c.ms != null) md.push(`- **Took:** ${c.ms} ms`);
      if (c.shape) md.push(`- **Shape:** \`${c.shape}\``);
      if (c.error) md.push(`- **Error:** \`${c.error}\``);
      if (hint) {
        md.push(`- **Verify in DB:**`);
        md.push("");
        md.push("  ```sql");
        md.push("  " + String(hint.db).split("\n").join("\n  "));
        md.push("  ```");
        md.push("");
        md.push(`- **Verify on /visit:** ${hint.visit_page}`);
      }
      md.push("");
      md.push("**Output (what the agent receives):**");
      md.push("");
      md.push("```json");
      try {
        md.push(JSON.stringify(c.result ?? null, null, 2));
      } catch {
        md.push(String(c.result));
      }
      md.push("```");
      md.push("");
    }
  }

  const mdFile = path.join(outDir, `agent-tools-${patientId}-${stamp}.md`);
  fs.writeFileSync(mdFile, md.join("\n"));

  console.log(`\n${DIM}Dumped to:${RESET}`);
  console.log(`  ${jsonFile}`);
  console.log(`  ${mdFile}`);
  console.log(`${DIM}Open the .md file to match each tool's output against the DB query and the /visit panel.${RESET}`);
}

await pool.end();
process.exit(summary.failed > 0 ? 1 : 0);
