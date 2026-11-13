import { HOSPITAL, renderLabReportPdf } from "./labReportLayout.js";

function getPatientInfo(caseDetail) {
  const p = caseDetail.patient || {};
  const name =
    p.patient_name ||
    p.name ||
    [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ") ||
    "Unknown";

  let ageSex = "";
  if (p.age != null) ageSex += `${p.age} Years`;
  else if (p.birth_date || p.dob) {
    const dob = new Date(p.birth_date || p.dob);
    if (!isNaN(dob))
      ageSex += `${Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000))} Years`;
  }
  const gender = p.gender || p.sex || "";
  if (gender) ageSex += ageSex ? ` / ${gender}` : gender;

  const uhid = p.healthray_uid || p.uhid || p.file_no || p.patient_uhid || "";
  const referrer = caseDetail.doctor_name || caseDetail.referred_by || p.referred_by || "";

  return { name: name.toUpperCase(), ageSex, uhid, referrer: referrer.toUpperCase() };
}

function extractReportSections(caseDetail) {
  const sections = [];

  for (const cat of caseDetail.case_reports || []) {
    const categoryName = cat.category_name || "General";

    for (const test of cat.tests || []) {
      const rows = [];
      for (const param of test.parameters || []) {
        const r = param.result || {};
        const ref = param.test_ref_value || {};
        const val = r.test_result;
        if (val == null || val === "") continue;

        const numVal = parseFloat(val);
        const refMin = ref.min_value != null ? parseFloat(ref.min_value) : null;
        const refMax = ref.max_value != null ? parseFloat(ref.max_value) : null;

        let refRange = ref.ref_range || "";
        if (!refRange) {
          if (refMin != null && refMax != null) refRange = `${refMin} - ${refMax}`;
          else if (refMin != null) refRange = `> ${refMin}`;
          else if (refMax != null) refRange = `< ${refMax}`;
        }

        let flag = "";
        if (!isNaN(numVal)) {
          if (refMin != null && numVal < refMin) flag = "L";
          else if (refMax != null && numVal > refMax) flag = "H";
        }

        rows.push({
          name: param.name || "",
          result: String(val),
          unit: param.unit || "",
          refRange,
          flag,
        });
      }
      if (rows.length) {
        sections.push({
          category: categoryName,
          groupName: test.name || test.test_name || "",
          rows,
        });
      }
    }

    for (const report of cat.reports || []) {
      const rows = [];
      const reportName = report.name || report.report_name || "";

      for (const rt of report.report_tests || []) {
        const test = rt.test || {};
        const params = test.parameters && test.parameters.length > 0 ? test.parameters : [test];

        for (const param of params) {
          const r = param.result || {};
          const ref = param.test_ref_value || {};
          const val = r.test_result;
          if (val == null || val === "") continue;

          const numVal = parseFloat(val);
          const refMin = ref.min_value != null ? parseFloat(ref.min_value) : null;
          const refMax = ref.max_value != null ? parseFloat(ref.max_value) : null;

          let refRange = ref.ref_range || "";
          if (!refRange) {
            if (refMin != null && refMax != null) refRange = `${refMin} - ${refMax}`;
            else if (refMin != null) refRange = `> ${refMin}`;
            else if (refMax != null) refRange = `< ${refMax}`;
          }

          let flag = "";
          if (!isNaN(numVal)) {
            if (refMin != null && numVal < refMin) flag = "L";
            else if (refMax != null && numVal > refMax) flag = "H";
          }

          rows.push({
            name: param.name || "",
            result: String(val),
            unit: param.unit || "",
            refRange,
            flag,
          });
        }
      }
      if (rows.length) {
        sections.push({ category: categoryName, groupName: reportName, rows });
      }
    }
  }

  return sections;
}

export async function generateLabReportPdf(caseDetail, branchInfo) {
  const sections = extractReportSections(caseDetail);
  if (!sections.length) return null;
  return renderLabReportPdf({
    patient: getPatientInfo(caseDetail),
    dates: {
      registered: caseDetail.registered_at || caseDetail.created_at,
      collected: caseDetail.collected_on,
      received: caseDetail.received_on || caseDetail.collected_on,
      reported: caseDetail.reported_on || caseDetail.collected_on,
    },
    sections,
    hospital: {
      ...HOSPITAL,
      name: branchInfo?.name || branchInfo?.lab_name || HOSPITAL.name,
      address: branchInfo?.address || HOSPITAL.address,
      phone: branchInfo?.mobile_number || branchInfo?.phone || HOSPITAL.phone,
      city: branchInfo?.address ? "" : HOSPITAL.city,
    },
  });
}
