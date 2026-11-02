import "../loadEnv.js";
import { cronPool } from "../config/db.js";
import {
  normalizeDrug,
  summariseUnmatched,
  MOLECULE_LABELS,
} from "../services/analytics/drugNormalizer.js";

const FIXTURES = [
  ["INJ. Wegovy 0.25mg", "semaglutide_inj"],
  ["WEGOVEY", "semaglutide_inj"],
  ["WIGOVY", "semaglutide_inj"],
  ["Mounjaro 5mg", "tirzepatide"],
  ["MONJOURO", "tirzepatide"],
  ["MOUNJAO", "tirzepatide"],
  ["MOUNJERO", "tirzepatide"],
  ["Rybelsus 7mg", "semaglutide_oral"],
  ["REBYLSUS", "semaglutide_oral"],
  ["RYBLESUS", "semaglutide_oral"],
  ["Semaglutide (Erly)", "liraglutide"],
  ["INJ ERLY", "liraglutide"],
  ["SEMANEXT 0.5", "semaglutide_inj"],
  ["Inj Trulicity", "dulaglutide"],
  ["Victoza", "liraglutide"],
  ["Lirafit 6mg", "liraglutide"],
  ["Tab Metformin 500", null],
  ["Rosuvastatin 10mg", null],
  ["Telmisartan 40", null],
  ["Inj Glargine", null],
  ["Shelcal 500", null],
  ["Yurpeak", "tirzepatide"],
  ["Erl (GLP-1 agonist)", "liraglutide"],
  ["Inj Erli (GLP-1 receptor agonist)", "liraglutide"],
  ["ERLT", "liraglutide"],
  ["GLP-1 agonist (Eryl)", "liraglutide"],
  ["Gliptoza/Erely", "liraglutide"],
  ["VIGOVY", "semaglutide_inj"],
  ["Inj. Gliptoza", "liraglutide"],
  ["Eplerenone (Erly)", "liraglutide"],
  ["Semaglutide (Wegovy)", "semaglutide_inj"],
  ["Rybelsus semaglutide 7mg", "semaglutide_oral"],
  ["Semaglutide 0.5 mg", "semaglutide_inj"],
  ["Oxemia 50mg", null],
  ["Soliqua", "lixisenatide_glargine"],
  ["Saliqua", "lixisenatide_glargine"],
  ["GLP AGONIST", "glp1_unspecified"],
  ["GLP1Ra", "glp1_unspecified"],
  ["Sterling", null],
  [{ name: "INJ INSULIN R", drug_class: "GLP-1 RA" }, null],
  [{ name: "INJ HUMINSULIN 30:70", drug_class: "GLP-1 RA" }, null],
  [{ name: "CELEXIN", drug_class: "GLP-1 RA" }, null],
  [{ name: "INJ FSH", drug_class: "GLP-1 RA" }, null],
  [{ name: "TIDE PLUS", drug_class: "GLP-1 RA" }, null],
  ["TAB RYBELSUS DISCUSSED WITH PATIENT BUT DEFERRED DUE TO PAST H/O PANCREATITIS", null],
  ["TAB RYBELSUS WAS NOT STARTED AS PATIENT GET THE APPOINTMENT FROM THERE", null],
  ["TAB RYBELSUS WAS STOPPED", "semaglutide_oral"],
];

const CLASS_FIXTURES = [
  [{ name: "Soliqua" }, ["glp1", "insulin"]],
  [{ name: "INJ INSULIN R", drug_class: "GLP-1 RA" }, ["insulin"]],
  [{ name: "INJ HUMINSULIN 30:70", drug_class: "GLP-1 RA" }, ["insulin"]],
  [{ name: "INJ DEGLUDEC", drug_class: "GLP-1 RA" }, ["insulin"]],
  [{ name: "EGLUCENT", drug_class: "Insulin-Basal+GLP-1 RA" }, ["insulin"]],
  [{ name: "CELEXIN", drug_class: "GLP-1 RA" }, []],
];

function runFixtures() {
  let failures = 0;
  for (const [name, expected] of FIXTURES) {
    const med = typeof name === "string" ? { name } : name;
    const got = normalizeDrug(med).molecule;
    const ok = got === expected;
    if (!ok) failures += 1;
    console.log(`${ok ? "pass" : "FAIL"}  ${med.name.padEnd(26)} -> ${got} (expected ${expected})`);
  }
  for (const [med, expected] of CLASS_FIXTURES) {
    const got = normalizeDrug(med).classes;
    const ok = JSON.stringify([...got].sort()) === JSON.stringify([...expected].sort());
    if (!ok) failures += 1;
    console.log(
      `${ok ? "pass" : "FAIL"}  ${med.name.padEnd(26)} classes -> [${got}] (expected [${expected}])`,
    );
  }
  const total = FIXTURES.length + CLASS_FIXTURES.length;
  console.log(`\nfixtures: ${total - failures}/${total} passed\n`);
  return failures;
}

async function runAgainstDatabase() {
  const { rows } = await cronPool.query(
    "SELECT patient_id, name, composition, pharmacy_match, drug_class FROM medications",
  );
  console.log(`medication rows scanned: ${rows.length}`);

  const byMolecule = new Map();
  const byClass = new Map();
  for (const row of rows) {
    const r = normalizeDrug(row);
    if (r.molecule) {
      const e = byMolecule.get(r.molecule) || { rows: 0, patients: new Set() };
      e.rows += 1;
      e.patients.add(row.patient_id);
      byMolecule.set(r.molecule, e);
    }
    for (const cls of r.classes) {
      const e = byClass.get(cls) || { rows: 0, patients: new Set() };
      e.rows += 1;
      e.patients.add(row.patient_id);
      byClass.set(cls, e);
    }
  }

  console.log("\nIncretin molecules:");
  const incretinPatients = new Set();
  for (const [key, e] of [...byMolecule.entries()].sort(
    (a, b) => b[1].patients.size - a[1].patients.size,
  )) {
    console.log(
      `  ${(MOLECULE_LABELS[key] || key).padEnd(30)} rows=${String(e.rows).padStart(5)} patients=${e.patients.size}`,
    );
    for (const p of e.patients) incretinPatients.add(p);
  }
  console.log(`  TOTAL distinct incretin patients: ${incretinPatients.size}`);

  console.log("\nComparator classes:");
  for (const [key, e] of [...byClass.entries()].sort(
    (a, b) => b[1].patients.size - a[1].patients.size,
  )) {
    console.log(
      `  ${key.padEnd(30)} rows=${String(e.rows).padStart(6)} patients=${e.patients.size}`,
    );
  }

  const unmatched = summariseUnmatched(rows, 5);
  console.log(`\nUnmatched / unresolved strings (>=5 rows): ${unmatched.length}`);
  for (const u of unmatched.slice(0, 30)) {
    console.log(`  ${u.name.padEnd(40)} rows=${u.rows} patients=${u.patients}`);
  }
}

const failures = runFixtures();
if (!process.argv.includes("--fixtures-only")) await runAgainstDatabase();
await cronPool.end();
process.exit(failures > 0 ? 1 : 0);
