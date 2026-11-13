import pool from "../../config/db.js";
import { flagForRange } from "../../utils/labFlag.js";
import { renderLabReportPdf } from "../lab/labReportLayout.js";

const REPORT_TITLE = "Laboratory Report";
const WATERMARK = "Provisional Report";

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const SEX_WORDS = { m: "Male", f: "Female", o: "Other" };

const ageSexText = (age, sex) => {
  const ageText = age == null || age === "" ? "" : `${age} Years`;
  const raw = String(sex || "").trim();
  const sexText = SEX_WORDS[raw.toLowerCase()] || SEX_WORDS[raw[0]?.toLowerCase()] || raw;
  return [ageText, sexText].filter(Boolean).join(" / ");
};

const doctorText = (name) => {
  const clean = String(name || "").trim();
  if (!clean) return "";
  return (/^dr\.?\s/i.test(clean) ? clean : `Dr. ${clean}`).toUpperCase();
};

const resultText = (row) => {
  if (row.result != null) return String(Number(row.result));
  return String(row.result_text || "").trim();
};

const flagLetter = (row) => {
  const direction = row.result != null ? flagForRange(row.result, row.ref_range) : null;
  const stored = String(row.flag || "").toUpperCase();
  const resolved = direction || (stored === "HIGH" || stored === "LOW" ? stored : null);
  return resolved === "HIGH" ? "H" : resolved === "LOW" ? "L" : "";
};

const RESULT_ROWS = (column) => `
  SELECT test_name, panel_name, result, result_text, unit, ref_range, flag, created_at
    FROM lab_results
   WHERE ${column} = $1
     AND (result IS NOT NULL OR NULLIF(btrim(result_text), '') IS NOT NULL)
   ORDER BY min(id) OVER (PARTITION BY COALESCE(panel_name, '')), id`;

function sectionsFrom(rows) {
  const byPanel = new Map();
  for (const r of rows) {
    const key = (r.panel_name || "").trim();
    if (!byPanel.has(key)) byPanel.set(key, []);
    byPanel.get(key).push({
      name: r.test_name,
      result: resultText(r),
      unit: r.unit || "",
      refRange: r.ref_range || "",
      flag: flagLetter(r),
    });
  }
  return [...byPanel.entries()].map(([panel, list]) => ({
    category: REPORT_TITLE,
    groupName: panel,
    rows: list,
  }));
}

const latest = (rows) =>
  rows.reduce((max, r) => (!max || r.created_at > max ? r.created_at : max), null);

const fileNameFor = (name, uhid) =>
  `${[name, uhid, "lab-report"]
    .filter(Boolean)
    .join("_")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")}.pdf`;

async function orderReportData(orderId, db) {
  const { rows } = await db.query(
    `SELECT p.name, p.sex, p.file_no,
            COALESCE(p.age, date_part('year', age(p.dob))::int) AS age,
            o.created_at AS registered_at,
            COALESCE(od.name, vd.name) AS doctor_name,
            (SELECT min(e.occurred_at) FROM giniflow_lab_order_events e
              WHERE e.lab_order_id = o.id AND e.status = 'sample_collected') AS collected_at,
            (SELECT min(e.occurred_at) FROM giniflow_lab_order_events e
              WHERE e.lab_order_id = o.id
                AND e.status IN ('sample_received', 'processing')) AS received_at
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN doctors od ON od.id = o.ordered_by
       LEFT JOIN doctors vd ON vd.id = COALESCE(v.assigned_doctor_id, v.assigned_sd_id)
      WHERE o.id = $1`,
    [orderId],
  );
  if (!rows.length) throw bad("Order not found", 404);
  const o = rows[0];
  const { rows: results } = await db.query(RESULT_ROWS("lab_order_id"), [orderId]);
  return {
    patient: {
      name: String(o.name || "").toUpperCase(),
      ageSex: ageSexText(o.age, o.sex),
      referrer: doctorText(o.doctor_name),
      uhid: o.file_no || "",
    },
    dates: {
      registered: o.registered_at,
      collected: o.collected_at,
      received: o.received_at || o.collected_at,
      reported: latest(results),
    },
    results,
  };
}

const referralName = (ref) => {
  if (!ref) return "";
  if (typeof ref === "string") return ref;
  const name = [ref.first_name, ref.last_name].filter(Boolean).join(" ");
  return name ? `${ref.title || "Dr."} ${name}` : "";
};

async function caseReportData(caseNo, db) {
  const { rows } = await db.query(
    `SELECT COALESCE(p.name, uid.name, lc.raw_list_json->'patient'->>'patient_name') AS name,
            COALESCE(p.sex, uid.sex, lc.raw_list_json->'patient'->>'gender') AS sex,
            COALESCE(p.age, uid.age, date_part('year', age(COALESCE(p.dob, uid.dob)))::int) AS age,
            COALESCE(lc.raw_list_json->'patient'->>'healthray_uid', p.file_no, uid.file_no) AS uhid,
            lc.raw_list_json->'referral_doctor' AS referral_doctor,
            lc.raw_list_json->>'registered_at' AS registered_at,
            COALESCE(lc.raw_list_json->>'collected_on', a.created_at::text) AS collected_at,
            lc.raw_list_json->>'received_on' AS received_at
       FROM lab_cases lc
       LEFT JOIN patients p ON p.id = lc.patient_id
       LEFT JOIN patients uid ON uid.file_no = lc.raw_list_json->'patient'->>'healthray_uid'
       LEFT JOIN giniflow_lab_case_actions a
              ON a.case_no = lc.case_no AND a.action = 'sample_taken'
      WHERE lc.case_no = $1
      LIMIT 1`,
    [caseNo],
  );
  if (!rows.length) throw bad("Lab case not found", 404);
  const c = rows[0];
  const { rows: results } = await db.query(RESULT_ROWS("lab_case_no"), [caseNo]);
  return {
    patient: {
      name: String(c.name || "").toUpperCase(),
      ageSex: ageSexText(c.age, c.sex),
      referrer: doctorText(referralName(c.referral_doctor)),
      uhid: c.uhid || "",
    },
    dates: {
      registered: c.registered_at,
      collected: c.collected_at,
      received: c.received_at || c.collected_at,
      reported: latest(results),
    },
    results,
  };
}

async function render({ patient, dates, results }) {
  if (!results.length) {
    throw bad("No values have been saved yet — save the results before generating a report", 409);
  }
  const pdf = await renderLabReportPdf({
    patient,
    dates,
    sections: sectionsFrom(results),
    watermark: WATERMARK,
    footerNote: `Generated ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} from values entered at the lab. Not valid until verified and signed.`,
  });
  return { pdf, filename: fileNameFor(patient.name, patient.uhid) };
}

export async function typedOrderReport(orderId, db = pool) {
  return render(await orderReportData(orderId, db));
}

export async function typedCaseReport(caseNo, db = pool) {
  return render(await caseReportData(caseNo, db));
}
