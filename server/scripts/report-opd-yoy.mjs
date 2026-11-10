import "../loadEnv.js";
import fs from "node:fs/promises";
import path from "node:path";
import { cronPool } from "../config/db.js";
import { isTestDatabaseUrl } from "../../e2e/setup/guard.mjs";
import { MOLECULE_LABELS } from "../services/analytics/drugNormalizer.js";
import { buildReport, SET_B_MIN_VISITS, TARGET } from "../services/analytics/opdYoy.js";
import { renderOpdYoyHtml } from "../services/analytics/opdYoyHtml.js";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

function methodAoa(meta) {
  return [
    ["Item", "Definition"],
    ["As at", meta.asOf],
    ["Database", meta.target],
    ["Generated", meta.generatedAt],
    [
      "Years",
      "One column per calendar year: completed years in full, the current year up to the as-at date (so it is not yet comparable with a full year). 2023 and 2024 come from Scribe imports (see below). The summary page also compares the current year with the same dates last year.",
    ],
    [
      "Visit",
      "One attended appointment day per patient (completed / seen / checked in), in-person OPD only. Tele, lab-only, leads, blocked patients, test and demo records are left out.",
    ],
    [
      "2023 and 2024",
      "Shown as stored in Scribe: HealthRay notes bulk-imported in March 2026, not appointments. Visit dates are approximate and the import often stored one visit twice, so imported dates for the same patient within 3 days are merged into one visit (checked against Mar 2025 – Feb 2026, where both exist: about 9% below the real count). Visit counts are estimates; patient counts are reliable. 2024 is incomplete, BP and waist are sparse, diagnoses are read from the raw diagnosis text and medicines only where a medicine row exists. Rough reference only; not comparable with 2025 onwards.",
    ],
    ["≥3 visits set", "Patients with at least 3 visit days within that same period."],
    [
      "Age",
      "Age written on the patient's first visit of the period; else date of birth; else stored age.",
    ],
    [
      "Age of onset",
      "Diabetic patients only. 'AOO nn' written in the diabetes diagnosis; else age on that visit minus years since the diagnosis year. Values outside 1–90 or above the current age are dropped.",
    ],
    [
      "GLP-1 / Awiqli",
      "Prescribed in the period: named on a visit prescription in the period, or a medicine row started or last prescribed in the period. Deferred / not-started entries are excluded. GLP-1 includes tirzepatide, semaglutide (injectable and oral), liraglutide, dulaglutide, exenatide and lixisenatide + glargine.",
    ],
    [
      "GLP-1 prescribed or advised",
      "Prescribed as above, or a visit note in the period names a GLP-1 next to advice wording (plan for, advised, suggested, discussed, counselled, refused, declined, did not start, wants to wait / delay). Mentions of past use (stopped, was on, h/o, side effects) are not counted. Notes are cumulative, so advice written at an earlier visit can still be read at a later one. 2025 onwards only; the 2023–2024 imports have no notes.",
    ],
    [
      "Diagnosis list",
      "The diagnoses on the patient's latest visit of the period that has one (HealthRay visit note). Conditions count only if present on that visit.",
    ],
    [
      "Dual adiposity — diagnosis",
      "Dual adiposity, dual adiposities, dual obesity or overweight with dual adiposity, not marked absent.",
    ],
    [
      "Dual adiposity — measured",
      `Latest BMI ≥ ${TARGET.bmi} and latest waist ≥ ${TARGET.waistMale} cm (men) / ≥ ${TARGET.waistFemale} cm (women) in the period, among patients with both recorded.`,
    ],
    [
      "Labs and BP",
      "Latest reading in the period. HbA1c / LDL values copied forward unchanged from an earlier HealthRay note are dropped. Patients without the reading are left out of that figure's denominator.",
    ],
    [
      "DKD",
      "Diabetic patients whose kidney entry shows eGFR stage G3a or worse, or albumin A2 or worse, unless the doctor wrote 'NEPHROPATHY-'. G1A1 / G2A1 are normal. Unstaged entries are 'unclear' and not counted. Stones, cysts, AKI, IgA and other non-diabetic kidney disease are excluded.",
    ],
    [
      "CAD",
      "The last CAD+ / CAD- sign in that visit's HealthRay note; else the recorded status. CAD with PTCA, CABG or stent counts as present.",
    ],
    [
      "Observational data",
      "Figures describe patients seen in routine care; they do not show cause and effect.",
    ],
  ];
}

function patientAoa(report) {
  const rows = [
    [
      "Period",
      "UHID",
      "Health ID",
      "Visits",
      "≥3 visits",
      "Age",
      "Age source",
      "Diabetic",
      "Type 2",
      "AOO",
      "AOO source",
      "GLP-1",
      "GLP-1 drugs",
      "GLP-1 advised (note)",
      "Awiqli",
      "Diagnosis list date",
      "Dual adiposity (dx)",
      "BMI",
      "Waist",
      "Dual adiposity (measured)",
      "HbA1c",
      "HbA1c date",
      "Systolic BP",
      "BP date",
      "LDL",
      "LDL date",
      "Kidney",
      "DKD",
      "CAD",
    ],
  ];
  const yn = (v) => (v == null ? "" : v ? "Yes" : "No");
  for (const r of report.results) {
    for (const p of r.rows) {
      rows.push([
        r.period.label,
        p.uhid,
        p.health_id,
        p.visits,
        yn(p.setB),
        p.age,
        p.ageSource,
        yn(p.diabetic),
        yn(p.type2),
        p.aoo,
        p.aooSource,
        yn(p.glp1),
        p.molecules.map((m) => MOLECULE_LABELS[m] || m).join(", "),
        yn(p.glp1Advised),
        yn(p.icodec),
        p.latestListDay,
        yn(p.dualDx),
        p.bmi,
        p.waist,
        yn(p.dualMeasured),
        p.hba1c,
        p.hba1cDate,
        p.sbp,
        p.sbpDate,
        p.ldl,
        p.ldlDate,
        p.kidney,
        yn(p.dkd),
        yn(p.cad),
      ]);
    }
  }
  return rows;
}

async function writeWorkbook(file, sheets) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  for (const [name, aoa, cols] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const sample = aoa.slice(0, 300);
    ws["!cols"] =
      cols ||
      (aoa[0] || []).map((_, i) => ({
        wch: Math.min(60, Math.max(8, ...sample.map((r) => String(r[i] ?? "").length)) + 2),
      }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  await fs.writeFile(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

const excelReport = (report) => ({
  ...report,
  results: report.results.filter((r) => !r.period.key.endsWith("-ytd")),
});

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const dayMonth = (iso) => `${Number(iso.slice(8, 10))} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]}`;
const SET_LABELS = ["All patients", `Seen ${SET_B_MIN_VISITS}+ times`];
const LAST_COL = 8;
const FILL_HEAD = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEDED" } };
const FILL_SECTION = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F2" } };
const FILL_WARN = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4CE" } };
const THIN = { style: "thin", color: { argb: "FFBFBFBF" } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const FMT_INT = "#,##0";
const FMT_DEC = "0.0";
const FMT_PCT = '0.0"%"';
const FEW_PATIENTS = 100;
const FEW_FONT = { italic: true, color: { argb: "FF8C8C8C" } };

function markFew(row, groupWidth, shares) {
  shares.forEach((x, i) => {
    if (!x || !(x.of > 0 && x.of < FEW_PATIENTS)) return;
    for (let c = 3 + i * groupWidth; c < 3 + (i + 1) * groupWidth; c++)
      row.getCell(c).font = FEW_FONT;
  });
}

function fewNote(ws) {
  const row = ws.addRow([
    "",
    `Grey italic = fewer than ${FEW_PATIENTS} patients counted; not reliable.`,
  ]);
  row.getCell(2).font = FEW_FONT;
}

const COUNT_ROWS = [
  ["1", "Total visits", (s) => s.visits],
  ["2", "Unique patients", (s) => s.patients],
];
const AGE_ROWS = [
  ["3", "Average age", (s) => s.age],
  ["4", "Age at diabetes onset — all diabetes", (s) => s.aoo],
  ["4", "Age at diabetes onset — Type 2", (s) => s.aooT2],
];
const SHARE_ROWS = [
  ["5", "On a GLP-1", "patients seen", (s) => s.glp1],
  ["5", "On a GLP-1 — diabetic patients", "diabetic patients seen", (s) => s.glp1Diabetic],
  ["5", "On a GLP-1 — CAD patients", "patients with CAD", (s) => s.glp1Cad],
  [
    "5",
    "GLP-1 prescribed or advised (advised or planned in the visit note, including patients who deferred or declined)",
    "patients seen",
    (s) => s.glp1OrAdvised,
  ],
  ["6", "On Awiqli", "patients seen", (s) => s.icodec],
  ["7", "On both GLP-1 and Awiqli", "patients seen", (s) => s.both],
  ["8", "Dual adiposity — diagnosis", "patients with a diagnosis list", (s) => s.dualDx],
  [
    "8",
    "Dual adiposity — measured (BMI ≥ 25 and waist ≥ 90 cm men / ≥ 80 cm women)",
    "patients with BMI and waist",
    (s) => s.dualMeasured,
  ],
  ["9", "HbA1c below 7", "patients with an HbA1c", (s) => s.hba1c],
  [
    "10",
    "HbA1c < 7, systolic BP < 140 and LDL < 100",
    "patients with all three measured",
    (s) => s.allThree,
  ],
  ["11", "DKD", "diabetic patients with a diagnosis list", (s) => s.dkd],
  [
    "11",
    "Kidney status unclear (not counted as DKD)",
    "diabetic patients with a diagnosis list",
    (s) => s.kidneyUnclear,
  ],
  ["11", "CAD", "patients with a diagnosis list", (s) => s.cad],
  ["11", "DKD or CAD", "patients with a diagnosis list", (s) => s.dkdOrCad],
];

function yearSheetName(period) {
  const y = period.key.slice(0, 4);
  if (period.history) return `${y} (Scribe import)`;
  return period.partial ? `${y} to ${dayMonth(period.to)}` : y;
}

function yearTitle(p) {
  const y = p.key.slice(0, 4);
  if (p.history) return `OPD ${y} — as stored in Scribe (imported notes)`;
  return p.partial
    ? `OPD ${y} — year to date, 1 Jan to ${dayMonth(p.to)} ${y}`
    : `OPD ${y} — full year, 1 Jan to 31 Dec ${y}`;
}

function yearNote(p) {
  if (p.history) {
    return "Incomplete — rough reference only, not comparable with 2025 onwards. Comes from HealthRay notes imported into Scribe in March 2026, not from appointments: visit dates are approximate (dates within 3 days for the same patient are counted as one visit, so visit counts are estimates; patient counts are reliable), BP and waist are sparse, medicines only where a medicine row exists. See the Method sheet.";
  }
  if (p.partial) {
    return "Year not finished: counts (visits, patients) cover fewer months than a full year, so compare them only with the same dates last year. Percentages can be compared across years.";
  }
  return "Full calendar year. In-person OPD visits only; tele and lab-only visits are not counted.";
}

function styleRow(row, { fill, bold, from = 1, to = LAST_COL } = {}) {
  for (let c = from; c <= to; c++) {
    const cell = row.getCell(c);
    cell.border = BORDER;
    if (fill) cell.fill = fill;
    if (bold) cell.font = { ...(cell.font || {}), bold: true };
    cell.alignment = { vertical: "middle", wrapText: true, ...(cell.alignment || {}) };
  }
}

function sectionHeader(ws, title, groupWidth) {
  ws.addRow([]);
  const label = ws.addRow([title]);
  ws.mergeCells(label.number, 1, label.number, 2 + groupWidth * 2);
  styleRow(label, { fill: FILL_SECTION, bold: true, to: 2 + groupWidth * 2 });
  const group = ws.addRow([
    "",
    "",
    SET_LABELS[0],
    ...Array(groupWidth - 1).fill(""),
    SET_LABELS[1],
  ]);
  ws.mergeCells(group.number, 3, group.number, 2 + groupWidth);
  ws.mergeCells(group.number, 3 + groupWidth, group.number, 2 + groupWidth * 2);
  styleRow(group, { fill: FILL_HEAD, bold: true, to: 2 + groupWidth * 2 });
  group.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
  group.getCell(3 + groupWidth).alignment = { horizontal: "center", vertical: "middle" };
  return group;
}

function columnHeader(ws, cols, groupWidth) {
  const row = ws.addRow(["#", "Figure", ...cols, ...cols]);
  styleRow(row, { fill: FILL_HEAD, bold: true, to: 2 + groupWidth * 2 });
  if (cols.some((c) => c.length > 12)) row.height = 30;
  for (let c = 3; c <= 2 + groupWidth * 2; c++)
    row.getCell(c).alignment = { horizontal: "right", vertical: "middle", wrapText: true };
}

function dataRow(ws, values, formats, groupWidth) {
  const row = ws.addRow(values);
  styleRow(row, { to: 2 + groupWidth * 2 });
  formats.forEach((fmt, i) => {
    if (!fmt) return;
    for (const c of [3 + i, 3 + groupWidth + i]) {
      const cell = row.getCell(c);
      cell.numFmt = fmt;
      cell.alignment = { horizontal: "right", vertical: "middle" };
    }
  });
  row.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
  const label = String(values[1] || "");
  if (label.length > 62) row.height = 15 * Math.ceil(label.length / 62);
  return row;
}

const val = (v) => (v == null || Number.isNaN(v) ? null : Number(v));

function addYearSheet(wb, result) {
  const p = result.period;
  const ws = wb.addWorksheet(yearSheetName(p), {
    views: [{ state: "frozen", ySplit: 2 }],
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      paperSize: 9,
    },
  });
  ws.columns = [{ width: 5 }, { width: 58 }, ...Array(LAST_COL - 2).fill({ width: 13 })];
  const sets = [result.all, result.setB];

  const title = ws.addRow([yearTitle(p)]);
  ws.mergeCells(1, 1, 1, LAST_COL);
  title.font = { bold: true, size: 14 };
  title.height = 22;
  const note = ws.addRow([yearNote(p)]);
  ws.mergeCells(2, 1, 2, LAST_COL);
  note.getCell(1).alignment = { wrapText: true, vertical: "top" };
  note.getCell(1).font = { italic: !p.history, bold: !!p.history };
  if (p.history) note.getCell(1).fill = FILL_WARN;
  note.height = 36;

  sectionHeader(ws, "Visits and patients", 1);
  columnHeader(ws, ["Count"], 1);
  for (const [num, label, fn] of COUNT_ROWS)
    dataRow(ws, [num, label, ...sets.map((s) => val(fn(s)))], [FMT_INT], 1);

  sectionHeader(ws, "Ages (years)", 3);
  columnHeader(ws, ["Mean", "Patients with a value", "Out of"], 3);
  for (const [num, label, fn] of AGE_ROWS) {
    dataRow(
      ws,
      [
        num,
        label,
        ...sets.flatMap((s) => {
          const d = fn(s);
          return [val(d.mean), val(d.n), val(d.of)];
        }),
      ],
      [FMT_DEC, FMT_INT, FMT_INT],
      3,
    );
  }

  sectionHeader(ws, "Treatment, weight, control and complications", 3);
  columnHeader(ws, ["Patients", "Out of", "%"], 3);
  for (const [num, label, base, fn] of SHARE_ROWS) {
    const shareRow = dataRow(
      ws,
      [
        num,
        `${label}  (out of ${base})`,
        ...sets.flatMap((s) => {
          const x = fn(s);
          return [val(x.n), val(x.of), val(x.pct)];
        }),
      ],
      [FMT_INT, FMT_INT, FMT_PCT],
      3,
    );
    markFew(
      shareRow,
      3,
      sets.map((x) => fn(x)),
    );
  }

  fewNote(ws);

  sectionHeader(ws, "GLP-1 by drug (out of patients seen)", 3);
  columnHeader(ws, ["Patients", "Out of", "%"], 3);
  const findMol = (s, k) =>
    s.molecules.find((m) => m.molecule === k) || { n: 0, of: s.patients, pct: 0 };
  const mols = [...new Set(sets.flatMap((s) => s.molecules.map((m) => m.molecule)))].sort(
    (a, b) => findMol(result.all, b).n - findMol(result.all, a).n,
  );
  if (!mols.length)
    dataRow(ws, ["", "No GLP-1 prescriptions recorded", null, null, null, null, null, null], [], 3);
  for (const m of mols) {
    const label = m === "glp1_unspecified" ? "GLP-1, drug not named" : MOLECULE_LABELS[m] || m;
    dataRow(
      ws,
      [
        "",
        label,
        ...sets.flatMap((s) => {
          const x = findMol(s, m);
          return [val(x.n), val(x.of), val(x.pct)];
        }),
      ],
      [FMT_INT, FMT_INT, FMT_PCT],
      3,
    );
  }

  sectionHeader(ws, "Data coverage", 1);
  columnHeader(ws, ["Patients"], 1);
  const coverage = [
    ["Patients seen", (s) => s.patients],
    ["Age taken from the visit record", (s) => s.ageSources.visit],
    ["Age taken from date of birth", (s) => s.ageSources.dob],
    ["Age taken from stored age", (s) => s.ageSources.stored],
    ["Diabetic patients", (s) => s.diabetics],
    ["Onset age written in the diagnosis", (s) => s.aooSources.written],
    ["Onset age worked out from the diagnosis year", (s) => s.aooSources.derived],
    ["Patients with a diagnosis list", (s) => s.hasList.n],
  ];
  for (const [label, fn] of coverage)
    dataRow(ws, ["", label, ...sets.map((s) => val(fn(s)))], [FMT_INT], 1);
}

function addMethodSheet(wb, meta) {
  const ws = wb.addWorksheet("Method", {
    pageSetup: {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      paperSize: 9,
    },
  });
  ws.columns = [{ width: 28 }, { width: 120 }];
  const rows = methodAoa(meta);
  rows.forEach((r, i) => {
    const row = ws.addRow(r);
    styleRow(row, { to: 2, fill: i === 0 ? FILL_HEAD : undefined, bold: i === 0 });
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    row.height =
      15 *
      Math.max(
        1,
        Math.ceil(String(r[1] ?? "").length / 115),
        Math.ceil(String(r[0] ?? "").length / 26),
      );
    row.getCell(1).alignment = { vertical: "top", wrapText: true };
  });
}

async function writeShareableWorkbook(file, report, meta) {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  for (const r of excelReport(report).results.slice().reverse()) addYearSheet(wb, r);
  addMethodSheet(wb, meta);
  await wb.xlsx.writeFile(file);
}

function summaryModel(report, asOf, target) {
  return {
    asOf,
    target,
    generatedAt: new Date().toISOString(),
    periods: report.periods,
    data: Object.fromEntries(
      report.results.map((r) => [r.period.key, { all: r.all, setB: r.setB }]),
    ),
  };
}

async function writeHtml(file, model) {
  await fs.writeFile(file, renderOpdYoyHtml(model, { moleculeLabels: MOLECULE_LABELS }), "utf8");
}

const renderOnly = arg("render-only", null);
if (renderOnly) {
  const model = JSON.parse(await fs.readFile(path.resolve(renderOnly), "utf8"));
  const out = path.join(
    path.dirname(path.resolve(renderOnly)),
    `opd-yoy-summary-${model.asOf}.html`,
  );
  await writeHtml(out, model);
  const xlsxOut = path.join(path.dirname(out), `opd-yoy-${model.asOf}.xlsx`);
  await writeShareableWorkbook(
    xlsxOut,
    { results: model.periods.map((p) => ({ period: p, ...model.data[p.key] })) },
    { asOf: model.asOf, target: model.target || "production", generatedAt: model.generatedAt },
  );
  console.log(`  html  ${out}`);
  console.log(`  xlsx  ${xlsxOut}`);
  await cronPool.end();
  process.exit(0);
}

const target = arg("target", null);
const asOf = arg("as-of", new Date().toISOString().slice(0, 10));
const outDir = path.resolve(arg("out", "reports"));
const onTestDb = isTestDatabaseUrl(process.env.DATABASE_URL);

if (target === "e2e" && !onTestDb) {
  console.error("--target=e2e needs DATABASE_URL set to the local e2e test database.");
  process.exit(1);
}
if (target === "production" && onTestDb) {
  console.error("--target=production but DATABASE_URL is the e2e test database.");
  process.exit(1);
}
if (target !== "e2e" && target !== "production") {
  console.error("Pass --target=e2e or --target=production.");
  process.exit(1);
}

console.log(`OPD year-on-year report as at ${asOf} (${target}) ...`);
const started = Date.now();
const client = await cronPool.connect();
let report;
try {
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '120s'");
  report = await buildReport(client, { asOf });
  await client.query("ROLLBACK");
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  client.release();
  await cronPool.end();
}

await fs.mkdir(outDir, { recursive: true });
const meta = { asOf, target, generatedAt: new Date().toISOString() };
const xlsxPath = path.join(outDir, `opd-yoy-${asOf}.xlsx`);
const internalPath = path.join(outDir, `opd-yoy-patients-INTERNAL-${asOf}.xlsx`);
const htmlPath = path.join(outDir, `opd-yoy-summary-${asOf}.html`);
const jsonPath = path.join(outDir, `opd-yoy-${asOf}.json`);
const model = summaryModel(report, asOf, target);
await writeShareableWorkbook(xlsxPath, report, meta);
await writeWorkbook(internalPath, [["Patients", patientAoa(excelReport(report))]]);
await fs.writeFile(jsonPath, JSON.stringify(model, null, 2), "utf8");
await writeHtml(htmlPath, model);

console.log(
  `  finished in ${((Date.now() - started) / 1000).toFixed(1)}s, ${report.visitRows} visit days`,
);
for (const r of report.results) {
  const s = r.all;
  console.log(
    `  ${r.period.label.padEnd(20)} visits=${s.visits} patients=${s.patients} setB=${r.setB.patients} age=${s.age.mean} aoo=${s.aoo.mean} glp1=${s.glp1.n} awiqli=${s.icodec.n} both=${s.both.n} dualDx=${s.dualDx.n}/${s.dualDx.of} hba1c<7=${s.hba1c.n}/${s.hba1c.of} all3=${s.allThree.n}/${s.allThree.of} dkd=${s.dkd.n}/${s.dkd.of} cad=${s.cad.n}/${s.cad.of}`,
  );
}
console.log(`  xlsx  ${xlsxPath}`);
console.log(`  xlsx  ${internalPath}  (contains Health IDs — internal only)`);
console.log(`  json  ${jsonPath}`);
console.log(`  html  ${htmlPath}`);
