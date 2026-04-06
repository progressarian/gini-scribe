// ── Lab HealthRay result parser ──────────────────────────────────────────────
// Extracts flat result rows from case_detail response.
// case_detail has three structures inside case_reports:
//   1. case_reports[].tests[].parameters[]                        (e.g. Haematology sub-params)
//   2. case_reports[].reports[].report_tests[].test.parameters[]  (e.g. Microalbumin sub-params)
//   3. case_reports[].reports[].report_tests[].test (direct)      (e.g. HbA1c, FBS, Lipids — has_sub_tests=false)

function mapParam(param, categoryName) {
  const result = param.result || {};
  const ref = param.test_ref_value || {};
  const rawVal = result.test_result;
  const numVal = parseFloat(rawVal);

  const refMin = ref.min_value != null ? parseFloat(ref.min_value) : null;
  const refMax = ref.max_value != null ? parseFloat(ref.max_value) : null;

  // Build ref_range string: "0.5 - 0.9", "> 40", "< 200", or null
  let refRange = null;
  if (refMin != null && refMax != null) refRange = `${refMin} - ${refMax}`;
  else if (refMin != null) refRange = `> ${refMin}`;
  else if (refMax != null) refRange = `< ${refMax}`;

  // Compute flag from numeric value vs reference range
  let flag = null;
  if (!isNaN(numVal) && (refMin != null || refMax != null)) {
    if (refMin != null && numVal < refMin) flag = "LOW";
    else if (refMax != null && numVal > refMax) flag = "HIGH";
  }

  return {
    name: param.name,
    canonicalName: (param.name || "").toLowerCase().replace(/\s+/g, "_"),
    rawValue: rawVal,
    value: isNaN(numVal) ? null : numVal, // null for text results (e.g. "Positive")
    unit: param.unit || null,
    refRange,
    flag,
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

    // Structure 2 & 3: reports[].report_tests[].test
    for (const report of cat.reports || []) {
      for (const rt of report.report_tests || []) {
        const test = rt.test || {};
        if (test.parameters && test.parameters.length > 0) {
          // Structure 2: test has sub-parameters (e.g. Microalbumin/Creatinine Ratio)
          for (const param of test.parameters) {
            const val = param.result?.test_result;
            if (val == null || val === "") continue;
            results.push(mapParam(param, catName));
          }
        } else {
          // Structure 3: direct test result (e.g. HbA1c, FBS, Total Cholesterol)
          const val = test.result?.test_result;
          if (val == null || val === "") continue;
          results.push(mapParam(test, catName));
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

// Extract investigation summary (Reports vs Tests) from a case detail object
// Returns { reports: ["LIPID PROFILE", "HBA1C", ...], tests: ["Creatinine, Serum", ...] }
export function extractInvestigationSummary(caseDetail) {
  const reports = [];
  const tests = [];

  for (const cat of caseDetail.case_reports || []) {
    for (const report of cat.reports || []) {
      const name = report.name || report.report_name;
      if (name) reports.push(name);
    }
    for (const test of cat.tests || []) {
      const name = test.name || test.test_name;
      if (name) tests.push(name);
    }
  }

  return { reports, tests };
}

// Determine best date for the case
export function extractCaseDate(listRow) {
  const raw = listRow.collected_on || listRow.registered_at || listRow.created_at;
  if (!raw) return null;
  return raw.slice(0, 10); // YYYY-MM-DD
}
