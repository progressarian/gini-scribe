import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const triage = await import("../../server/services/giniflow/triage.js");
const board = await import("../../server/services/giniflow/board.js");
const vitals = await import("../../server/services/giniflow/vitalsStation.js");
const doctor = await import("../../server/services/giniflow/doctorStation.js");
const { stabilityOf, triageTier } = await import("../../shared/biomarkerClassify.js");

const tag = newTag();
let ids;
const visits = {};

async function patientWith(label, today, earlier, labs = []) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE appointments SET biomarkers = $2::jsonb WHERE id = $1`, [
    made.appointment,
    JSON.stringify(today),
  ]);
  if (earlier)
    await query(
      `INSERT INTO appointments (patient_id, patient_name, appointment_date, biomarkers)
       VALUES ($1, $2, $3::date - 90, $4::jsonb)`,
      [made.patient, `${label} ${tag}`, ids.day, JSON.stringify(earlier)],
    );
  for (const [name, result, daysAgo] of labs)
    await query(
      `INSERT INTO lab_results (patient_id, test_name, canonical_name, result, test_date)
       VALUES ($1, $2, $2, $3, $4::date - $5::int)`,
      [made.patient, name, String(result), ids.day, daysAgo],
    );
  return made;
}

const stored = async (visit) =>
  one(`SELECT stability, stability_reasons FROM giniflow_visits WHERE id = $1`, [visit]);

test.describe.serial("G68 Stable / Unstable from the test comparison", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    visits.worse = await patientWith("Worse", { hba1c: 9.4 }, { hba1c: 8.1 });
    visits.better = await patientWith("Better", { hba1c: 7.4 }, { hba1c: 8.6 });
    visits.offTarget = await patientWith("OffTarget", { hba1c: 9.6 }, { hba1c: 9.5 });
    visits.mixed = await patientWith("Mixed", { hba1c: 7.5, sbp: 152 }, { hba1c: 8.4, sbp: 126 });
    visits.labs = await patientWith("Labs", {}, null, [
      ["HbA1c", 6.4, 3],
      ["HbA1c", 6.5, 120],
    ]);
    visits.first = await patientWith("First", { hba1c: 8 }, null);
    visits.none = await patientWith("None", {}, null);
    visits.stale = await patientWith("Stale", {}, null, [
      ["HbA1c", 9.8, 200],
      ["HbA1c", 7.1, 400],
    ]);
  });

  test.afterAll(async () => {
    const patients = Object.values(visits).map((v) => v.patient);
    await query(`DELETE FROM lab_results WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1) AND id <> ALL($2)`, [
      patients,
      Object.values(visits).map((v) => v.appointment),
    ]);
    await tearDown(ids);
  });

  test("1. the shared comparison gives the old OPD screen's verdict", async () => {
    const worse = { biomarkers: { hba1c: 9.4 }, prev_biomarkers: { hba1c: 8.1 } };
    expect(stabilityOf(worse)).toMatchObject({
      stability: "unstable",
      reasons: ["HbA1c 8.1 → 9.4"],
    });
    expect(triageTier(worse).tier).toBe("red");
    const steadyGood = { biomarkers: { hba1c: 6.6 }, prev_biomarkers: { hba1c: 6.5 } };
    expect(stabilityOf(steadyGood).stability).toBe("stable");
    expect(triageTier(steadyGood).tier).toBe("green");
    const firstVisit = { biomarkers: { hba1c: 8 }, prev_biomarkers: {}, prev_hba1c: null };
    expect(stabilityOf(firstVisit).stability).toBe("first");
    expect(triageTier(firstVisit).outcome).toBe("single");
    const hdlOnly = {
      biomarkers: { sbp: 118, hba1c: 6.4, hdl: 25 },
      prev_biomarkers: { sbp: 140, hba1c: 6.5 },
    };
    const verdict = stabilityOf(hdlOnly);
    expect(verdict.stability).toBe("unstable");
    expect(verdict.reasons).toContain("HDL 25 off target");
    const betterButBad = { biomarkers: { hba1c: 10 }, prev_biomarkers: { hba1c: 11 } };
    expect(stabilityOf(betterButBad)).toMatchObject({
      stability: "unstable",
      reasons: ["HbA1c 10 off target"],
    });
    expect(triageTier(betterButBad).tier).toBe("amber");
    const firstButBad = { biomarkers: { hba1c: 11 }, prev_biomarkers: {}, prev_hba1c: null };
    expect(stabilityOf(firstButBad).stability).toBe("unstable");
    expect(triageTier(firstButBad).tier).toBe("red");
  });

  test("2. the sweep stores a verdict for every visit of the day, and a rerun changes nothing", async () => {
    const first = await triage.autoCategoriseDay(ids.day, { db });
    expect(first.stability).toBeGreaterThanOrEqual(8);
    const expected = {
      worse: "unstable",
      better: "stable",
      offTarget: "unstable",
      mixed: "unstable",
      labs: "stable",
      first: "first",
      none: "no_reports",
      stale: "no_reports",
    };
    for (const [key, state] of Object.entries(expected)) {
      expect((await stored(visits[key].visit)).stability, key).toBe(state);
    }
    expect((await stored(visits.worse.visit)).stability_reasons).toEqual(["HbA1c 8.1 → 9.4"]);
    expect((await stored(visits.offTarget.visit)).stability_reasons).toEqual([
      "HbA1c 9.6 off target",
    ]);
    expect(await triage.assessStabilityDay(ids.day, { db, force: true })).toBe(0);
  });

  test("3. a new report changes the verdict on the next sweep", async () => {
    await query(`UPDATE appointments SET biomarkers = '{"hba1c": 9.8}'::jsonb WHERE id = $1`, [
      visits.better.appointment,
    ]);
    await triage.assessStabilityDay(ids.day, { db, force: true });
    expect((await stored(visits.better.visit)).stability).toBe("unstable");
  });

  test("4. the board, the vitals station and the consult carry the verdict", async () => {
    const day = await board.getDayBoard(ids.day, await board.getSlaConfig(db), new Date(), db);
    const card = day.cards.find((c) => c.id === visits.worse.visit);
    expect(card.stability).toEqual({ state: "unstable", reasons: ["HbA1c 8.1 → 9.4"] });
    const patient = await vitals.getVitalsPatient(visits.worse.visit, db);
    expect(patient.stability.state).toBe("unstable");
    const consult = await doctor.getConsult(visits.mixed.visit, db);
    expect(consult.stability.state).toBe("unstable");
  });

  test("5. the Flow Manager card shows the chip with its reason", async ({ page }) => {
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      visits.worse.visit,
    ]);
    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/manager", () =>
      page.locator(`[data-card-id="${visits.worse.visit}"]`),
    );
    const chip = page.locator(`[data-card-id="${visits.worse.visit}"] .stab-chip`);
    await expect(chip).toHaveText("⚠ Unstable");
    await expect(chip).toHaveAttribute("title", /HbA1c 8\.1 → 9\.4/);
  });
});
