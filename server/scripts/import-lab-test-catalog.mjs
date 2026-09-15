import "../loadEnv.js";
import pool from "../config/db.js";

const apply = process.argv.includes("--apply");
const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const maxCases = Number(argOf("max-cases")) || Infinity;
const before = argOf("before");
const BATCH = Number(process.env.LAB_CATALOG_BATCH) || 50;

const flat = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const num = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
};

const GENDERS = { both: "Both", male: "Male", female: "Female" };

const QUALIFIED_NUMBER = /^[<>]=?\s*-?\d+(\.\d+)?$/;
const NUMERIC_SHARE = 0.9;

const reports = new Map();
const tests = new Map();
const ranges = new Map();
const resultKinds = new Map();
const placements = new Map();
let cases = 0;

const noteResult = (id, value) => {
  const text = String(value ?? "").trim();
  if (!text || text === "NaN" || /^-+$/.test(text)) return;
  const kind = resultKinds.get(id) || { numeric: 0, text: 0 };
  if (num(text) !== null || QUALIFIED_NUMBER.test(text)) kind.numeric++;
  else kind.text++;
  resultKinds.set(id, kind);
};

const notePlacement = (id, parentId) => {
  const seen = placements.get(id) || new Set();
  seen.add(parentId ?? "top");
  placements.set(id, seen);
};

const inputTypeOf = (test, declared) => {
  if (test.formula) return "numeric";
  const kind = resultKinds.get(test.id);
  if (kind && kind.numeric + kind.text > 0) {
    return kind.numeric / (kind.numeric + kind.text) >= NUMERIC_SHARE ? "numeric" : "text";
  }
  return declared;
};

const rangeOf = (testId, ref) => {
  if (!ref?.id || ranges.has(String(ref.id))) return;
  ranges.set(String(ref.id), {
    healthrayRefId: Number(ref.id),
    testId,
    gender: GENDERS[String(ref.gender || "both").toLowerCase()] || "Both",
    minAgeDays: Number.isInteger(num(ref.min_age)) ? num(ref.min_age) : 0,
    maxAgeDays: Number.isInteger(num(ref.max_age)) ? num(ref.max_age) : 36500,
    minValue: num(ref.min_value),
    maxValue: num(ref.max_value),
    minCritical: num(ref.min_critical_value),
    maxCritical: num(ref.max_critical_value),
    textRange: ref.result_in_words || null,
    isPregnant: ref.is_pregnant === true,
  });
};

const testOf = (test, { parentId = null, sequence = null } = {}) => {
  if (!test?.id) return null;
  const id = Number(test.id);
  if (!tests.has(id)) {
    const ref = test.test_ref_value;
    const numericRange = ref && (num(ref.min_value) !== null || num(ref.max_value) !== null);
    tests.set(id, {
      id,
      parentId,
      sequence,
      name: String(test.name_to_be_printed || test.name || "").trim(),
      unit: test.unit ? String(test.unit).trim() : null,
      declaredType: test.input_type === "Numeric" || numericRange ? "numeric" : "text",
      formula: test.formula ? String(test.formula).replace(/\s+/g, " ").trim() : null,
    });
  }
  noteResult(id, test.result?.test_result);
  notePlacement(id, parentId);
  rangeOf(id, test.test_ref_value);
  (test.parameters || []).forEach((child, i) =>
    testOf(child, { parentId: id, sequence: child.sequence ?? i + 1 }),
  );
  return id;
};

const readBatch = async (cursor, requested) => {
  let size = requested;
  for (let attempt = 1; ; attempt++) {
    try {
      const { rows } = await pool.query(
        `SELECT case_no, case_date::text AS case_date, raw_detail_json->'case_reports' AS case_reports
           FROM lab_cases
          WHERE raw_detail_json IS NOT NULL
            AND ($1::text IS NULL OR (case_date::text, case_no) < ($1::text, $2::text))
          ORDER BY case_date DESC, case_no DESC
          LIMIT $3`,
        [cursor?.date ?? null, cursor?.caseNo ?? null, size],
      );
      return rows;
    } catch (e) {
      if (attempt >= 12) throw e;
      const smaller = Math.max(5, Math.floor(size / 2));
      const wait = Math.min(60, 5 * attempt);
      console.warn(`\nbatch of ${size} failed (${e.message}) — retrying ${smaller} in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      size = smaller;
    }
  }
};

let cursor = before ? { date: before.split(",")[0], caseNo: before.split(",")[1] } : null;
for (;;) {
  const rows = await readBatch(cursor, BATCH);
  if (!rows.length) break;
  for (const row of rows) {
    cases++;
    for (const caseReport of row.case_reports || []) {
      for (const report of caseReport.reports || []) {
        if (!report?.id) continue;
        const reportId = Number(report.id);
        if (!reports.has(reportId)) {
          reports.set(reportId, {
            id: reportId,
            name: String(report.report_name || report.name_to_be_printed || "").trim(),
            printedName: String(report.name_to_be_printed || "").trim(),
            tests: new Map(),
          });
        }
        const entry = reports.get(reportId);
        for (const rt of report.report_tests || []) {
          if (rt.is_deleted) continue;
          const testId = testOf(rt.test);
          if (testId && !entry.tests.has(testId)) entry.tests.set(testId, rt.sequence ?? 0);
        }
      }
    }
  }
  const last = rows[rows.length - 1];
  cursor = { date: last.case_date, caseNo: last.case_no };
  process.stdout.write(`\rread ${cases} cases…`);
  if (cases >= maxCases) break;
}
process.stdout.write("\n");

const hasChildren = new Set([...tests.values()].map((t) => t.parentId).filter(Boolean));
for (const test of tests.values()) {
  test.inputType = hasChildren.has(test.id) ? "group" : inputTypeOf(test, test.declaredType);
}

const countTests = (ids) => {
  let total = 0;
  const visit = (id) => {
    const children = [...tests.values()].filter((t) => t.parentId === id);
    if (!children.length) total++;
    children.forEach((child) => visit(child.id));
  };
  ids.forEach(visit);
  return total;
};

const { rows: aliasSources } = await pool.query(
  `SELECT DISTINCT name FROM (
     SELECT test_name AS name FROM giniflow_test_catalog WHERE COALESCE(is_active, TRUE)
     UNION
     SELECT unnest(test_names) FROM lab_cases WHERE case_date > NOW() - INTERVAL '180 days'
   ) n WHERE name IS NOT NULL`,
);
for (const report of reports.values()) {
  const key = flat(report.name);
  const printedKey = flat(report.printedName);
  report.aliases = [
    ...new Set([
      ...(report.printedName && report.printedName !== report.name ? [report.printedName] : []),
      ...aliasSources
        .map((r) => r.name)
        .filter(
          (name) => (flat(name) === key || flat(name) === printedKey) && name !== report.name,
        ),
    ]),
  ];
}

const unresolved = [];
for (const test of tests.values()) {
  if (!test.formula) continue;
  const missing = [...test.formula.matchAll(/#(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((id) => !tests.has(id));
  if (missing.length)
    unresolved.push(`${test.name} (${test.id}): ${test.formula} — missing ${missing.join(", ")}`);
}

const withRange = new Set([...ranges.values()].map((r) => r.testId));
console.log(`cases read        ${cases}`);
console.log(`reports           ${reports.size}`);
console.log(
  `tests             ${tests.size} (${[...tests.values()].filter((t) => t.parentId).length} sub-tests)`,
);
console.log(`tests with range  ${withRange.size}`);
console.log(`ranges            ${ranges.size}`);
console.log(`formulas          ${[...tests.values()].filter((t) => t.formula).length}`);
console.log(`unresolved        ${unresolved.length}`);
unresolved.forEach((u) => console.log(`  ${u}`));
const moved = [...placements.entries()].filter(([, where]) => where.size > 1);
console.log(`placed twice      ${moved.length}`);
moved.forEach(([id, where]) =>
  console.log(`  ${tests.get(id)?.name} (${id}) under ${[...where].join(", ")} — first seen kept`),
);
const typed = [...tests.values()].filter(
  (t) => t.inputType !== t.declaredType && t.inputType !== "group",
);
console.log(
  `headings          ${[...tests.values()].filter((t) => t.inputType === "group").length}`,
);
console.log(`type from results ${typed.length}`);
typed.forEach((t) => {
  const k = resultKinds.get(t.id);
  console.log(
    `  ${t.name}: ${t.declaredType} → ${t.inputType} (${k ? `${k.numeric} numeric, ${k.text} text` : "formula"})`,
  );
});

console.log(
  `stopped after    ${cases} cases; resume with --before=${cursor.date},${cursor.caseNo}`,
);

const nameOf = (id) => tests.get(id)?.name || `#${id}`;
console.log("\nreports:");
[...reports.values()]
  .sort((a, b) => a.name.localeCompare(b.name))
  .forEach((r) =>
    console.log(
      `  ${r.name} — ${countTests([...r.tests.keys()])} field${countTests([...r.tests.keys()]) === 1 ? "" : "s"}${r.aliases.length ? ` (also: ${r.aliases.join(", ")})` : ""}`,
    ),
  );
console.log("\nformulas:");
[...tests.values()]
  .filter((t) => t.formula)
  .forEach((t) =>
    console.log(`  ${t.name} = ${t.formula.replace(/#(\d+)/g, (_, n) => nameOf(Number(n)))}`),
  );
const preview = [...reports.values()].find((r) => flat(r.name) === "lipidprofile");
if (preview) {
  console.log(
    `\n${preview.name}${preview.aliases.length ? ` (aliases: ${preview.aliases.join(", ")})` : ""}`,
  );
  [...preview.tests.entries()]
    .sort((a, b) => a[1] - b[1])
    .forEach(([id, seq]) => {
      const t = tests.get(id);
      const r = [...ranges.values()]
        .filter((x) => x.testId === id)
        .map((x) => `${x.gender} ${x.minValue ?? ""}–${x.maxValue ?? ""}`)
        .join(" | ");
      const formula = t.formula
        ? ` = ${t.formula.replace(/#(\d+)/g, (_, n) => nameOf(Number(n)))}`
        : "";
      console.log(`  ${seq}. ${t.name} [${t.unit || "—"}]${formula}${r ? ` · ${r}` : ""}`);
    });
}

if (!apply) {
  console.log("\ndry run — nothing written. Re-run with --apply to write.");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const r of reports.values()) {
    await client.query(
      `INSERT INTO lab_report_catalog (id, name, aliases, source)
       VALUES ($1, $2, $3, 'healthray')
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             aliases = ARRAY(SELECT DISTINCT unnest(lab_report_catalog.aliases || EXCLUDED.aliases)),
             updated_at = NOW()
       WHERE lab_report_catalog.edited_at IS NULL`,
      [r.id, r.name, r.aliases],
    );
  }
  const depth = (t, seen = 0) =>
    t.parentId && tests.has(t.parentId) && seen < 10
      ? 1 + depth(tests.get(t.parentId), seen + 1)
      : 0;
  const ordered = [...tests.values()].sort((a, b) => depth(a) - depth(b));
  for (const t of ordered) {
    await client.query(
      `INSERT INTO lab_test_catalog (id, parent_test_id, sequence, name, unit, input_type, formula, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'healthray')
       ON CONFLICT (id) DO UPDATE
         SET parent_test_id = EXCLUDED.parent_test_id, sequence = EXCLUDED.sequence,
             name = EXCLUDED.name, unit = EXCLUDED.unit, input_type = EXCLUDED.input_type,
             formula = EXCLUDED.formula, updated_at = NOW()
       WHERE lab_test_catalog.edited_at IS NULL`,
      [t.id, t.parentId, t.sequence, t.name, t.unit, t.inputType, t.formula],
    );
  }
  for (const r of reports.values()) {
    for (const [testId, sequence] of r.tests) {
      await client.query(
        `INSERT INTO lab_report_tests (report_id, test_id, sequence)
         VALUES ($1, $2, $3)
         ON CONFLICT (report_id, test_id) DO UPDATE
           SET sequence = EXCLUDED.sequence
         WHERE (SELECT edited_at FROM lab_report_catalog WHERE id = EXCLUDED.report_id) IS NULL`,
        [r.id, testId, sequence],
      );
    }
  }
  for (const x of ranges.values()) {
    await client.query(
      `INSERT INTO lab_test_ranges
         (test_id, gender, min_age_days, max_age_days, min_value, max_value, min_critical,
          max_critical, text_range, is_pregnant, healthray_ref_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'healthray')
       ON CONFLICT (healthray_ref_id) DO NOTHING`,
      [
        x.testId,
        x.gender,
        x.minAgeDays,
        x.maxAgeDays,
        x.minValue,
        x.maxValue,
        x.minCritical,
        x.maxCritical,
        x.textRange,
        x.isPregnant,
        x.healthrayRefId,
      ],
    );
  }
  await client.query("COMMIT");
  console.log("\nwritten.");
} catch (e) {
  await client.query("ROLLBACK");
  console.error("import failed, nothing written:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
