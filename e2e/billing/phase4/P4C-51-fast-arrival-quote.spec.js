import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { CONSULTANTS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, healthrayBill, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../../server/services/giniflow/board.js");
const arrival = await import("../../../server/services/billing/arrivalBill.js");
const { arrivalQuote } = await import("../../../server/services/billing/arrivalQuote.js");

const db = getPool();
const tag = newTag();
let ids;

const vitals = { catalogId: "vitals", name: "Vitals", minutes: 5 };
const consultant = {
  catalogId: "sd_consult",
  name: "Consultant",
  minutes: 15,
  staffId: String(CONSULTANTS.banshali.id),
  staffName: CONSULTANTS.banshali.name,
};
const healthrayLab = () => ({
  catalogId: "blood_sample",
  name: "Blood Sample",
  minutes: 5,
  billedIn: "healthray",
  tests: [ids.hba1cName],
  billedTests: [{ name: ids.hba1cName, amount: 250 }],
});
const pickedLab = (tests) => ({
  catalogId: "blood_sample",
  name: "Blood Sample",
  minutes: 5,
  tests,
});

const shape = (view) => ({
  lines: view.lines
    .map(({ itemId, name, kind, amount }) => ({ itemId, name, kind, amount }))
    .sort((a, b) => a.itemId - b.itemId),
  outstanding: view.outstanding,
  journeyNote: view.journeyNote ?? null,
});

const counting = () => {
  let count = 0;
  return {
    db: {
      query: (...args) => {
        count++;
        return db.query(...args);
      },
      connect: async () => {
        const client = await db.connect();
        const run = client.query.bind(client);
        client.query = (...args) => {
          count++;
          return run(...args);
        };
        return client;
      },
    },
    count: () => count,
  };
};

const sameAsRehearsal = async (visit, input) => {
  const counted = counting();
  const quote = await arrivalQuote(visit, input, desk, counted.db);
  expect(quote, "the visit should take the fast quote").not.toBeNull();
  expect(counted.count()).toBeLessThan(35);
  const rehearsal = await arrival.rehearseArrivalBill(visit, input, desk, db);
  expect(shape(quote)).toEqual(shape(rehearsal));
  return quote;
};

const writtenFor = (visit) =>
  one(
    `SELECT (SELECT count(*)::int FROM bills WHERE visit_id = $1) AS bills,
            (SELECT count(*)::int FROM giniflow_lab_orders WHERE visit_id = $1) AS orders,
            (SELECT count(*)::int FROM giniflow_visit_steps WHERE visit_id = $1) AS steps,
            (SELECT current_status FROM giniflow_visits WHERE id = $1) AS status`,
    [visit],
  );

test.describe.serial("P4C-51 the arrival bill is quoted fast and matches the rehearsal", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. consultation only, with and without a journey", async () => {
    const made = await extraVisit(ids, "QConsult", { healthray: false });
    const bare = await sameAsRehearsal(made.visit, {});
    expect(bare.lines.map((l) => l.kind)).toEqual(["consultation"]);
    await sameAsRehearsal(made.visit, { plan: { steps: [vitals, consultant] } });
  });

  test("2. a HealthRay-billed lab test is quoted with the consultation", async () => {
    const made = await extraVisit(ids, "QHrLab", { healthray: false });
    await healthrayBill(ids, made.patient, [
      { desc: "Consultation", amount: 1000, category: "consultation" },
      { desc: ids.hba1cName, amount: 250, category: "lab" },
    ]);
    const quote = await sameAsRehearsal(made.visit, {
      plan: { steps: [vitals, healthrayLab(), consultant] },
    });
    expect(quote.lines.map((l) => l.itemId)).toContain(ids.hba1c);
  });

  test("3. a picked lab test and a machine step", async () => {
    const made = await extraVisit(ids, "QPicked", { healthray: false });
    await sameAsRehearsal(made.visit, {
      plan: {
        steps: [
          vitals,
          pickedLab([ids.hba1cName]),
          { catalogId: "ecg", name: "ECG", minutes: 10 },
          consultant,
        ],
      },
    });
  });

  test("4. a test outside the catalogue gives the same note and no test lines", async () => {
    const made = await extraVisit(ids, "QUnknown", { healthray: false });
    const quote = await sameAsRehearsal(made.visit, {
      plan: { steps: [vitals, pickedLab([`No such test ${tag}`]), consultant] },
    });
    expect(quote.journeyNote).toContain("Not in the test catalogue");
    expect(quote.lines.every((l) => l.kind !== "test")).toBe(true);
  });

  test("5. a desk add and a desk remove", async () => {
    const made = await extraVisit(ids, "QDesk", { healthray: false });
    const plan = { steps: [vitals, healthrayLab(), consultant] };
    const quote = await sameAsRehearsal(made.visit, { plan, add: [ids.dressing] });
    expect(quote.lines.map((l) => l.itemId)).toContain(ids.dressing);
    const removed = await sameAsRehearsal(made.visit, { plan, remove: [ids.hba1c] });
    expect(removed.lines.map((l) => l.itemId)).not.toContain(ids.hba1c);
  });

  test("6. a follow-up visit quotes the follow-up consultation", async () => {
    const made = await extraVisit(ids, "QFollow", { visitType: "Follow Up", healthray: false });
    const quote = await sameAsRehearsal(made.visit, { plan: { steps: [vitals, consultant] } });
    expect(quote.lines.map((l) => l.itemId)).toEqual([ids.consultFu]);
  });

  test("7. a visit that already has a bill takes the rehearsal", async () => {
    const made = await extraVisit(ids, "QDraft", { healthray: false });
    await query(
      `INSERT INTO bills (patient_id, visit_id, appointment_id, bill_date)
       VALUES ($1, $2, $3, $4::date)`,
      [made.patient, made.visit, made.appointment, ids.day],
    );
    expect(await arrivalQuote(made.visit, {}, desk, db)).toBeNull();
    const preview = await arrival.arrivalBillPreview(made.visit, {}, desk, db);
    expect(preview.quoted).toBeUndefined();
    expect(shape(preview)).toEqual(
      shape(await arrival.rehearseArrivalBill(made.visit, {}, desk, db)),
    );
  });

  test("8. the quote writes nothing", async () => {
    const made = await extraVisit(ids, "QClean", { healthray: false });
    const audits = async () =>
      (
        await one(
          `SELECT count(*)::int AS n FROM billing_audit WHERE after ->> 'visit_id' = $1::text`,
          [made.visit],
        )
      ).n;
    const before = await audits();
    const preview = await arrival.arrivalBillPreview(
      made.visit,
      { plan: { steps: [vitals, healthrayLab(), consultant] } },
      desk,
      db,
    );
    expect(preview.quoted).toBe(true);
    expect(await writtenFor(made.visit)).toEqual({
      bills: 0,
      orders: 0,
      steps: 0,
      status: "booked",
    });
    expect(await audits()).toBe(before);
  });
});
