import { test, expect } from "@playwright/test";

const { buildPrescriptionHtml } = await import("../../server/templates/prescriptionTemplate.js");

const SUMMARY = "Your sugars are improving and your weight is coming down.";

const labHistory = {
  HbA1c: [
    { result: 6.2, date: "2026-10-01" },
    { result: 7.4, date: "2026-07-01" },
    { result: 8.1, date: "2026-04-01" },
  ],
  FBS: [
    { result: 104, date: "2026-10-01" },
    { result: 140, date: "2026-07-01" },
  ],
};

const base = (extra = {}) =>
  buildPrescriptionHtml({
    patient: { name: "Layout Patient", file_no: "P_LAYOUT" },
    doctor: { name: "Dr Layout" },
    visitSummaryText: SUMMARY,
    summary: { summary: SUMMARY },
    consultations: [
      {
        con_data: {
          summary: SUMMARY,
          investigations_to_order: ["HbA1c", "Lipids"],
          follow_up: { tests_to_bring: ["HbA1c"] },
        },
      },
    ],
    activeDx: [{ diagnosis_id: "dm2", label: "Type 2 Diabetes Mellitus", status: "Present" }],
    labResults: [
      { test_name: "HbA1c", canonical_name: "HbA1c", result: 6.2, test_date: "2026-10-01" },
      { test_name: "FBS", canonical_name: "FBS", result: 104, test_date: "2026-10-01" },
    ],
    labHistory,
    latestVitals: { weight: 82, bmi: 29.1 },
    rxParameters: {
      columns: [
        { date: "2026-07-01" },
        { date: "2026-08-15" },
        { date: "2026-10-15", today: true },
      ],
      rows: [
        { key: "weight", label: "Weight", unit: "kg", values: [86, null, 82] },
        { key: "hba1c", label: "HbA1c", unit: "%", values: [7.4, null, 6.2] },
        { key: "vpt", label: "VPT", values: [null, null, null] },
        { key: "abi", label: "ABI", values: [null, null, null], show: true },
      ],
    },
    ...extra,
  });

const at = (html, text) => {
  const i = html.indexOf(text);
  expect(i, `"${text}" should be on the prescription`).toBeGreaterThan(-1);
  return i;
};

test.describe("G94 prescription layout", () => {
  test("1. the visit summary is no longer printed, investigations ordered still are", () => {
    const html = base();
    expect(html).not.toContain(SUMMARY);
    expect(html).not.toMatch(/Visit summary/i);
    at(html, "Investigations ordered");
    at(html, ">Lipids<");
  });

  test("2. the parameter table comes before diagnoses, trends come last", () => {
    const html = base();
    const table = at(html, "Vitals &amp; biomarkers — last visits");
    const dx = at(html, ">Diagnoses<");
    const referrals = at(html, "Referrals &amp; tests for next visit");
    const trends = at(html, "Biomarker trends — last 4 visits");
    expect(table).toBeLessThan(dx);
    expect(referrals).toBeLessThan(trends);
    expect(trends).toBeLessThan(at(html, 'class="rx-close"'));
  });

  test("3. fasting glucose is labelled FPG", () => {
    const html = base();
    expect(html).toContain("FPG (mg/dL)");
    expect(html).not.toContain("FBS (mg/dL)");
    expect(html).not.toMatch(/>FBS</);
  });

  test("4. the table shows dates in order, dashes for gaps, and hides empty rows", () => {
    const html = base();
    const table = html.slice(at(html, '<table class="rx-ptable">'), html.indexOf("</table>"));
    expect(table.indexOf("01 Jul 26")).toBeLessThan(table.indexOf("15 Aug 26"));
    expect(table).toContain("Today (15 Oct 26)");
    expect(table).toContain('Weight<span class="unit">(kg)</span>');
    expect(table.match(/>—</g).length).toBe(5);
    expect(table).not.toContain(">VPT<");
    expect(table).toContain(">ABI<");
  });

  test("5. no table when there are no columns or no values", () => {
    expect(base({ rxParameters: null })).not.toContain('<table class="rx-ptable">');
    expect(
      base({ rxParameters: { columns: [{ date: "2026-10-15", today: true }], rows: [] } }),
    ).not.toContain('<table class="rx-ptable">');
  });
});
