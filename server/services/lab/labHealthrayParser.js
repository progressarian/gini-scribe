import { getCanonical } from "../../utils/labCanonical.js";
import { flagFor } from "../../utils/labFlag.js";

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

  // The shared rule, so a value typed at the lab station and one that arrived
  // through this feed are flagged identically rather than by two copies.
  const flag = flagFor(numVal, { min: refMin, max: refMax });

  return {
    name: param.name,
    canonicalName:
      getCanonical(param.name) || (param.name || "").toLowerCase().replace(/\s+/g, "_"),
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
function isOutsourceTest(test) {
  if (!test) return false;
  if (test.investigation_type === "outsource_lab") return true;
  if (test.outsource_lab_id != null) return true;
  if (test.outsource_lab && typeof test.outsource_lab === "object") return true;
  return false;
}

function* iterCaseTests(listRowOrDetail) {
  for (const cat of listRowOrDetail?.case_reports || []) {
    for (const test of cat.tests || []) yield test;
    for (const report of cat.reports || []) {
      for (const rt of report.report_tests || []) {
        if (rt?.test) yield rt.test;
      }
    }
  }
}

// Returns 'inhouse' | 'mixed' | 'outsource' | 'unknown' (no tests visible).
export function classifyCaseSource(listRowOrDetail) {
  let inhouse = 0;
  let outsource = 0;
  for (const test of iterCaseTests(listRowOrDetail)) {
    if (isOutsourceTest(test)) outsource++;
    else inhouse++;
  }
  if (inhouse === 0 && outsource === 0) return "unknown";
  if (outsource === 0) return "inhouse";
  if (inhouse === 0) return "outsource";
  return "mixed";
}
function isWritableResult(testResult) {
  if (testResult == null || testResult === "") return false;
  return !isNaN(parseFloat(testResult));
}

export function countInhouseProgress(caseDetail) {
  let expected = 0;
  let ready = 0;
  for (const test of iterCaseTests(caseDetail)) {
    if (isOutsourceTest(test)) continue;
    if (test.parameters && test.parameters.length > 0) {
      for (const p of test.parameters) {
        expected++;
        if (isWritableResult(p?.result?.test_result)) ready++;
      }
    } else {
      expected++;
      if (isWritableResult(test?.result?.test_result)) ready++;
    }
  }
  return { expected, ready };
}

export function countAllInhouseResults(caseDetail) {
  let expected = 0;
  let reported = 0;
  for (const test of iterCaseTests(caseDetail)) {
    if (isOutsourceTest(test)) continue;
    if (test.parameters && test.parameters.length > 0) {
      for (const p of test.parameters) {
        expected++;
        const v = p?.result?.test_result;
        if (v != null && v !== "") reported++;
      }
    } else {
      expected++;
      const v = test?.result?.test_result;
      if (v != null && v !== "") reported++;
    }
  }
  return { expected, reported };
}

// Determine best date for the case
export function extractCaseDate(listRow) {
  const raw = listRow.collected_on || listRow.registered_at || listRow.created_at;
  if (!raw) return null;
  return raw.slice(0, 10); // YYYY-MM-DD
}

export function normalizeCaseStatus(status) {
  if (status == null) return "";
  return String(status)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "");
}

export const LAB_CASE_STATUS = {
  PRINTABLE: "printable",
  IN_PROCESS: "inprocess",
  CANCELLED: "cancelled",
};
export function isLabCasePrintable(caseStatus, caseDetail = null, _opts = {}) {
  const norm = normalizeCaseStatus(caseStatus);

  if (norm === LAB_CASE_STATUS.CANCELLED) return { ready: false, reason: "cancelled" };
  if (norm === LAB_CASE_STATUS.IN_PROCESS) return { ready: false, reason: "in-process" };

  if (caseDetail) {
    const { expected, reported } = countAllInhouseResults(caseDetail);
    if (expected > 0 && reported < expected) {
      return { ready: false, reason: `partial-results (${reported}/${expected})` };
    }
    if (expected > 0 && reported === expected) {
      return { ready: true, reason: "all-tests-reported" };
    }
  }

  if (norm === LAB_CASE_STATUS.PRINTABLE) return { ready: true, reason: "printable" };

  return { ready: false, reason: norm ? "unknown-status" : "no-detail" };
}
