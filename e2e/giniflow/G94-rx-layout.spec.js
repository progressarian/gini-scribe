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

  test("1b. investigations ordered leaves out the tests for the next visit", () => {
    const chips = (html) => [...html.matchAll(/rx-summary-test-chip">([^<]*)</g)].map((m) => m[1]);
    expect(chips(base())).toEqual(["Lipids"]);

    const healthray = base({
      consultations: [],
      appt_plan: {
        investigations_to_order: ["FBG", "PP", "Rheumatoid Factor", "ANCA", "SMBG"].map((name) => ({
          name,
          urgency: "routine",
        })),
        follow_up: "2026-12-01",
        follow_up_with: "With FBG, PP, Rheumatoid Factor, ANCA, SMBG",
      },
    });
    expect(healthray).not.toContain("Investigations ordered");
    at(healthray, "Reports to bring");
    at(healthray, "Rheumatoid Factor");

    const mixed = base({
      consultations: [],
      appt_plan: {
        investigations_to_order: [
          { name: "TSH", urgency: "routine" },
          { name: "HbA1c", urgency: "next_visit" },
          { name: "FBG", urgency: "routine" },
        ],
        follow_up: "2026-12-01",
        follow_up_with: "Come fasting with FBG",
      },
    });
    expect(chips(mixed)).toEqual(["TSH"]);
  });

  test("1d. tests and the follow-up note print once, as a checklist beside the next appointment", () => {
    const items = (html) => [...html.matchAll(/rx-nv-box[^>]*><\/span>([^<]*)</g)].map((m) => m[1]);
    const plan = (follow_up_with, follow_up = { date: "2099-01-15", timing: "6 weeks" }) =>
      base({
        consultations: [],
        appt_plan: {
          investigations_to_order: ["FBG", "PP", "ANCA"].map((name) => ({
            name,
            urgency: "routine",
          })),
          follow_up,
          follow_up_with,
        },
      });

    const same = plan("With FBG, PP, ANCA");
    expect(items(same)).toEqual(["FBG", "PP", "ANCA"]);
    expect(same).not.toContain("Instructions:");
    expect(same).not.toContain("Follow up with");
    expect(same).toContain("Follow-up appointment");
    expect(same).toContain("15 January 2099");
    expect(same).toContain("Thursday · in 6 weeks");
    expect(same).toContain("Please bring all the reports above to your next visit.");

    const extra = plan("Come fasting with FBG");
    expect(items(extra)).toEqual(["FBG", "PP", "ANCA"]);
    expect(extra).toContain("<b>Instructions:</b> Come fasting with FBG");

    const undated = plan("", null);
    expect(undated).toMatch(/rx-nv-date">To be scheduled</);
  });

  test("1e. trends plot a repeated report once and never mistake Anti-TG for triglycerides", () => {
    const html = base({
      activeDx: [
        { diagnosis_id: "dm2", label: "Type 2 Diabetes Mellitus", status: "Present" },
        { diagnosis_id: "dyslipidemia", label: "Dyslipidemia", status: "Present" },
      ],
      labResults: [
        { test_name: "HbA1c", canonical_name: "HbA1c", result: 9.5, test_date: "2026-07-16" },
        {
          test_name: "TG",
          canonical_name: "Triglycerides",
          result: 105.4,
          test_date: "2026-07-16",
        },
      ],
      labHistory: {
        HbA1c: [
          { result: 9.5, date: "2026-07-16" },
          { result: 9.5, date: "2026-07-15" },
          { result: 10.7, date: "2026-05-11" },
          { result: 13.4, date: "2026-03-12" },
        ],
        "Anti-TG": [{ result: 17.27, date: "2026-07-16" }],
        Triglycerides: [
          { result: 105.4, date: "2026-07-16" },
          { result: 105.4, date: "2026-07-15" },
          { result: 172, date: "2026-05-11" },
        ],
      },
    });
    const card = (label) => {
      const start = html.indexOf(label);
      expect(start, label).toBeGreaterThan(-1);
      return html.slice(start, html.indexOf("sp-dates", start) + 400);
    };
    const values = (chunk) => [...chunk.matchAll(/sp-val">([^<]*)</g)].map((m) => m[1]);
    const dates = (chunk) => [...chunk.matchAll(/sp-date[^"]*">([^<]*)</g)].map((m) => m[1]);
    expect(values(card("HbA1c (%)"))).toEqual(["13.4", "10.7", "9.5"]);
    expect(dates(card("HbA1c (%)")).at(-1)).toBe("15 Jul");
    expect(values(card("TG (mg/dL)"))).toEqual(["172", "105.4"]);
    expect(html).not.toContain(">17.3<");
  });

  test("1c. diagnoses print one row each, deduped, in consistent case, primary first", () => {
    const html = base({
      activeDx: [
        {
          diagnosis_id: "dm2",
          label: "TYPE 2 DM",
          status: "Present",
          since_year: "2017",
          notes: "SINCE 2017",
        },
        { diagnosis_id: "dual_adiposity", label: "Dual Adiposity", status: "New" },
        { diagnosis_id: "dual_adiposity_hr", label: "DUAL ADIPOSITY", status: "Present" },
        { diagnosis_id: "perianal", label: "LEFT SIDE PERIANAL ABSCESS", status: "Present" },
        { diagnosis_id: "gmi", label: "SGLT2 INDUCED GMI", status: "Present", notes: "TOLERABLE" },
      ],
    });
    const names = [...html.matchAll(/class="rx-dx-name">([^<]*)</g)].map((m) => m[1]);
    expect(names).toEqual([
      "Type 2 DM",
      "Dual Adiposity",
      "Left Side Perianal Abscess",
      "SGLT2 Induced GMI",
    ]);
    expect(html).not.toContain("rx-dx--primary");
    expect(html).toContain('<span class="rx-dx-meta">Since 2017</span>');
    expect(html).toContain('<span class="rx-dx-meta">Tolerable</span>');
  });

  test("2. the parameter table comes after diagnoses, trends come last", () => {
    const html = base();
    const table = at(html, "Vitals &amp; biomarkers</div>");
    const dx = at(html, ">Diagnosis<");
    const referrals = at(html, "Referrals &amp; tests for next visit");
    const trends = at(html, "Biomarker trends — last 4 visits");
    expect(dx).toBeLessThan(table);
    expect(html).not.toContain("biomarkers — last visits");
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
