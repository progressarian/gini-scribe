// ── Lab HealthRay result parser ──────────────────────────────────────────────
// Extracts flat result rows from case_detail response.
// case_detail has two structures inside case_reports:
//   1. case_reports[].tests[].parameters[]          (e.g. Haematology)
//   2. case_reports[].reports[].report_tests[].test.parameters[]  (e.g. Urine Routine)

function mapParam(param, categoryName) {
  const result = param.result || {};
  const ref = param.test_ref_value || {};
  const rawVal = result.test_result;
  const numVal = parseFloat(rawVal);

  return {
    name: param.name,
    canonicalName: (param.name || "").toLowerCase().replace(/\s+/g, "_"),
    rawValue: rawVal,
    value: isNaN(numVal) ? null : numVal, // null for text results (e.g. "Positive")
    unit: param.unit || null,
    refMin: ref.min_value != null ? parseFloat(ref.min_value) : null,
    refMax: ref.max_value != null ? parseFloat(ref.max_value) : null,
    gender: ref.gender || null,
    category: categoryName || null,
    inputType: param.input_type || null, // "Single line", "Numeric", etc.
  };
}

export function parseLabCaseResults(caseDetail) {
  const results = [];

  for (const cat of caseDetail.case_reports || []) {
    const catName = cat.category_name || "";

    // Structure 1: tests[].parameters[]
    for (const test of cat.tests || []) {
      for (const param of test.parameters || []) {
        const val = param.result?.test_result;
        if (val == null || val === "") continue;
        results.push(mapParam(param, catName));
      }
    }

    // Structure 2: reports[].report_tests[].test.parameters[]
    for (const report of cat.reports || []) {
      for (const rt of report.report_tests || []) {
        const test = rt.test || {};
        for (const param of test.parameters || []) {
          const val = param.result?.test_result;
          if (val == null || val === "") continue;
          results.push(mapParam(param, catName));
        }
      }
    }
  }

  return results;
}

// Extract ordered test panel names from the list-endpoint case row
export function extractTestNames(listRow) {
  return (listRow.investigations || []).filter(Boolean).map(String);
}

// Determine best date for the case
export function extractCaseDate(listRow) {
  const raw = listRow.collected_on || listRow.registered_at || listRow.created_at;
  if (!raw) return null;
  return raw.slice(0, 10); // YYYY-MM-DD
}
