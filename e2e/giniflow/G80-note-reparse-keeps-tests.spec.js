import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { applyOpdParse } = await import("../../server/services/cron/healthraySync.js");

const tag = newTag();
let ids;

const TESTS = [
  { name: "HbA1c", urgency: "routine" },
  { name: "UACR", urgency: "routine" },
];

const followUpOf = (appointment) =>
  one(
    `SELECT healthray_investigations, healthray_follow_up, follow_up_with
       FROM appointments WHERE id = $1`,
    [appointment],
  );

const reparse = (made, parsed) =>
  applyOpdParse(
    {
      patientId: made.patient,
      healthrayId: null,
      appointmentDate: ids.day,
      apptId: made.appointment,
    },
    { diagnoses: [], medications: [], previous_medications: [], ...parsed },
  );

test.describe.serial("G80 re-reading a HealthRay note keeps its tests and follow-up", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. tests and follow-up the first read missed are stored by the re-read", async () => {
    const made = await extraVisit(ids, "Reparse", { healthray: false });
    await query(
      `UPDATE appointments SET status = 'scheduled', healthray_investigations = '[]'::jsonb
        WHERE id = $1`,
      [made.appointment],
    );

    await reparse(made, {
      investigations_to_order: TESTS,
      follow_up: { date: null, timing: "6 weeks", notes: "Fasting" },
      follow_up_with: "Fasting — HbA1c, UACR",
    });

    expect(await followUpOf(made.appointment)).toMatchObject({
      healthray_investigations: TESTS,
      healthray_follow_up: { timing: "6 weeks" },
      follow_up_with: "Fasting — HbA1c, UACR",
    });
  });

  test("2. a re-read that finds no tests leaves the stored ones alone", async () => {
    const made = await extraVisit(ids, "ReparseKeep", { healthray: false });
    await query(
      `UPDATE appointments
          SET status = 'scheduled', healthray_investigations = $2::jsonb,
              healthray_follow_up = '{"timing":"6 weeks"}'::jsonb, follow_up_with = 'Fasting'
        WHERE id = $1`,
      [made.appointment, JSON.stringify(TESTS)],
    );

    await reparse(made, { investigations_to_order: [], follow_up: null });

    expect(await followUpOf(made.appointment)).toMatchObject({
      healthray_investigations: TESTS,
      healthray_follow_up: { timing: "6 weeks" },
      follow_up_with: "Fasting",
    });
  });
});
