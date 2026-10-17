import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const { historyFromNote, referralsFromNote, healthrayNoteSections } =
  await import("../../server/services/healthray/noteSections.js");
const { buildPrescriptionHtml } = await import("../../server/templates/prescriptionTemplate.js");
const { sortDiagnoses } = await import("../../server/utils/diagnosisSort.js");

const NOTE = [
  "Diagnosis",
  "TYPE 2 DM ( SINCE 2005, AOO 43)",
  "DUAL ADIPOSITY",
  "HYPERTENSION",
  "",
  "60 YR MALE DIAGNOSED CASE OF TYPE 2 DM SINCE 2005",
  "INITIALLY HE HAD G.WEAKNESS",
  "NOW ON INSULIN SINCE 2011",
  "PAST H/O",
  "STENT IN 2012",
  "",
  "FAMILY H/O",
  "M+F HAD DIABETES",
  "",
  "COVID NO",
  "VACCINATION DONE",
  "",
  "PREVIOUS MEDICATION:",
  "INJ SAMPLE 12 UNIT OD",
  "",
  "FOLLOW UP ON 17/5/26",
  "NEUROLOGIST OPINION WAS DONE",
  "",
  "FOLLOW up on 16/10/26",
  "BP 137/86",
  "",
  "TREATMENT :",
  "- TAB SAMPLE 40MG AT 8PM",
  "",
  "ONLINE FOLLOW UP APPOINTMENT IN 6WEEKS",
  "FOLLOW UP AFTER 1 MONTH BY VIDEO CONSULTATION WITH FBG ,PP READING",
  "",
  "ADVISED CONSULT WITH RHEUMATOLOGIST FOR HIP PAIN ",
  "ADVICE- REFER TO DR SAMPLE, DEPTT OF CARDIOLOGY",
].join("\r\n");

test.describe("G100 prescription history, referrals and diagnosis order", () => {
  test("1. the short history is the narrative between the diagnosis list and the medicines", () => {
    expect(historyFromNote(NOTE)).toBe(
      [
        "60 YR MALE DIAGNOSED CASE OF TYPE 2 DM SINCE 2005. INITIALLY HE HAD G.WEAKNESS. NOW ON INSULIN SINCE 2011",
        "PAST H/O: STENT IN 2012",
        "FAMILY H/O: M+F HAD DIABETES",
      ].join("\n"),
    );
    expect(
      historyFromNote("Diagnosis\nTYPE 2 DM\nMASLD+\n\n\nFOLLOW UP TODAY ON 11/05/2026\nFBG:112"),
    ).toBeNull();
    expect(historyFromNote("FBG 112")).toBeNull();
  });

  test("2. referrals come from the current plan only, never from video follow-ups or past opinions", () => {
    expect(referralsFromNote(NOTE)).toEqual([
      {
        type: "referral",
        specialty: "Rheumatologist",
        reason: "ADVISED CONSULT WITH RHEUMATOLOGIST FOR HIP PAIN",
      },
      {
        type: "referral",
        specialty: "Cardiology",
        reason: "REFER TO DR SAMPLE, DEPTT OF CARDIOLOGY",
      },
    ]);
    const one = (line) => referralsFromNote(line).map((r) => r.reason);
    expect(one("ADVICE- UROLOGIST OPINION")).toEqual(["UROLOGIST OPINION"]);
    expect(one("ADVISED CONSULTATION WITH DR. SAMPLE AT CITY HOSPITAL")).toHaveLength(1);
    expect(one("ONLINE CONSULT WITHIN 3 DAYS")).toEqual([]);
    expect(one("ORTHO OPINION- ACUTE CERVICAL STRAIN")).toEqual([]);
    expect(one("OPTHALMOLOGIST OPINION DONE BY DR SAMPLE")).toEqual([]);
  });

  test("3. the prescription prints history before diagnoses and the referral beside the next visit", () => {
    const html = buildPrescriptionHtml({
      patient: { name: "History Patient", file_no: "P_HIST" },
      doctor: { name: "Dr Sample" },
      history: historyFromNote(NOTE),
      referrals: referralsFromNote(NOTE),
      activeDx: [{ diagnosis_id: "dm2", label: "Type 2 DM", status: "Present" }],
      appt_plan: { follow_up: { date: "2099-01-15", timing: "6 weeks" } },
    });
    const history = html.indexOf(">Clinical history<");
    expect(history).toBeGreaterThan(-1);
    expect(history).toBeLessThan(html.indexOf(">Diagnosis<"));
    expect(html).toContain("<b>PAST H/O:</b> STENT IN 2012");
    const referral = html.indexOf("CONSULT WITH RHEUMATOLOGIST FOR HIP PAIN");
    expect(referral).toBeGreaterThan(html.indexOf("Referrals &amp; tests for next visit"));
    expect(html).toContain("Rheumatologist");
  });

  test("4. diagnoses follow the consultants' order and adiposity shows BMI and waist", () => {
    const labels = [
      "MASLD",
      "Hypertension",
      "PVD",
      "CVA",
      "CAD",
      "Retinopathy",
      "Nephropathy G1A1",
      "Neuropathy",
      "Dual Adiposity",
      "Type 2 DM",
    ];
    const sorted = sortDiagnoses(labels.map((label) => ({ label, diagnosis_id: label })));
    expect(sorted.map((d) => d.label)).toEqual([...labels].reverse());

    const html = buildPrescriptionHtml({
      patient: { name: "Waist Patient" },
      activeDx: [{ diagnosis_id: "dual_adiposity", label: "Dual Adiposity", status: "Present" }],
      latestVitals: { bmi: 27.87, weight: 67.5, waist: 100.5 },
    });
    expect(html).toContain("<b>BMI 27.9</b>");
    expect(html).toContain("<b>WC 100.5 cm</b>");
  });

  test("5. any reprint picks up the latest note's history and referrals, plus Scribe referrals", async () => {
    const tag = crypto.randomBytes(3).toString("hex");
    const patient = (
      await query(
        `INSERT INTO patients (name, file_no, age, sex) VALUES ($1, $2, 60, 'Male') RETURNING id`,
        [`G100 Patient ${tag}`, `G100-${tag}`],
      )
    ).rows[0].id;
    try {
      const appt = (
        await query(
          `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, healthray_clinical_notes)
           VALUES ($1, $2, $3, '2026-07-16', $4) RETURNING id`,
          [patient, `G100 Patient ${tag}`, `G100-${tag}`, NOTE],
        )
      ).rows[0].id;
      await query(
        `INSERT INTO referrals (patient_id, doctor_name, speciality, reason, appointment_id)
         VALUES ($1, 'Dr Eye', 'Ophthalmology', 'Annual retina check', $2)`,
        [patient, appt],
      );
      const later = await healthrayNoteSections(patient, "2026-10-17", getPool());
      expect(later.history).toContain("PAST H/O: STENT IN 2012");
      expect(later.referrals.map((r) => r.specialty)).toEqual([
        "Ophthalmology",
        "Rheumatologist",
        "Cardiology",
      ]);
      expect(later.referrals[0]).toMatchObject({
        referred_to: "Dr Eye",
        reason: "Annual retina check",
      });
      const before = await healthrayNoteSections(patient, "2026-07-15", getPool());
      expect(before).toEqual({ history: null, referrals: [] });
    } finally {
      await query(`DELETE FROM referrals WHERE patient_id = $1`, [patient]);
      await query(`DELETE FROM appointments WHERE patient_id = $1`, [patient]);
      await query(`DELETE FROM patients WHERE id = $1`, [patient]);
    }
  });

  test("6. with no written history, a line is built from age, sex and dated diagnoses; goals print once", () => {
    const html = buildPrescriptionHtml({
      patient: { name: "Recorded Patient", age: 64, sex: "Male" },
      activeDx: [
        {
          diagnosis_id: "type_2_diabetes_mellitus",
          label: "TYPE 2 DIABETES MELLITUS",
          since_year: "2008",
          status: "Present",
        },
        {
          diagnosis_id: "hypertension",
          label: "HYPERTENSION",
          notes: "SINCE 2003",
          status: "Present",
        },
        {
          diagnosis_id: "alcohol_related_pancreatitis",
          label: "Alcohol Related Pancreatitis",
          notes: "1996",
          status: "Recovered",
        },
        { diagnosis_id: "masld", label: "MASLD", status: "Present" },
      ],
      goals: [
        { marker: "PPG", target_value: "140-180" },
        { marker: "Weight", target_value: "Reduce by 10%" },
        { marker: "PPG", target_value: "140-180" },
      ],
    });
    expect(html).toContain(
      "<div>64 yr male · Type 2 Diabetes Mellitus since 2008 · Hypertension since 2003 · Alcohol Related Pancreatitis (1996) — recovered</div>",
    );
    expect(html.match(/class="rx-goal-label">PPG</g)).toHaveLength(1);

    const written = buildPrescriptionHtml({
      patient: { name: "Written Patient", age: 60, sex: "M" },
      history: "Written by the doctor",
      activeDx: [{ label: "Type 2 DM", since_year: "2010" }],
    });
    expect(written).toContain("Written by the doctor");
    expect(written).not.toContain("60 yr male");

    const undated = buildPrescriptionHtml({
      patient: { name: "Undated Patient", age: 50, sex: "F" },
      activeDx: [{ label: "MASLD" }],
    });
    expect(undated).not.toContain(">Clinical history<");
  });
});
