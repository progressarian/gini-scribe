import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs } from "../../helpers/auth.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../../server/services/giniflow/board.js");
const arrival = await import("../../../server/services/billing/arrivalBill.js");
const journey = await import("../../../server/services/giniflow/journey.js");
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
let ids;

const bloodSample = () => ({
  catalogId: "blood_sample",
  name: "Blood Sample",
  minutes: 5,
  billedIn: "healthray",
  tests: [ids.hba1cName],
  billedTests: [{ name: ids.hba1cName, amount: 250 }],
});

const vitals = { catalogId: "vitals", name: "Vitals", minutes: 5 };

const written = async (visit) =>
  one(
    `SELECT v.current_status,
            (SELECT count(*)::int FROM giniflow_lab_orders o WHERE o.visit_id = v.id) AS orders,
            (SELECT count(*)::int FROM giniflow_visit_steps s WHERE s.visit_id = v.id) AS steps,
            (SELECT count(*)::int FROM bill_lines l WHERE l.visit_id = v.id) AS lines
       FROM giniflow_visits v WHERE v.id = $1`,
    [visit],
  );

test.describe.serial("P4C-50 Bill at arrival shows the journey's tests before check-in", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a booked patient's HealthRay-billed test is on the preview, and nothing is written", async () => {
    const made = await extraVisit(ids, "JourneyLab", { healthray: false });
    const before = await arrival.arrivalBillPreview(made.visit, {}, desk, db);
    expect(before.lines.map((l) => l.itemId)).not.toContain(ids.hba1c);

    const preview = await arrival.arrivalBillPreview(
      made.visit,
      { plan: { steps: [vitals, bloodSample()] } },
      desk,
      db,
    );
    expect(preview.journeyNote).toBeUndefined();
    expect(preview.lines.map((l) => l.itemId)).toContain(ids.hba1c);
    expect(preview.outstanding - before.outstanding).toBe(25000);
    expect(await written(made.visit)).toEqual({
      current_status: "booked",
      orders: 0,
      steps: 0,
      lines: 0,
    });
  });

  test("2. checking in with the previewed journey collects exactly the previewed amount", async () => {
    const made = await extraVisit(ids, "JourneyPay", { healthray: false });
    const steps = [vitals, bloodSample()];
    const preview = await arrival.arrivalBillPreview(made.visit, { plan: { steps } }, desk, db);

    await journey.checkInWithJourney(made.visit, { steps, actorId: desk.actorId }, db);
    const done = await arrival.commitArrivalBill(
      made.visit,
      { expectedTotal: preview.outstanding, mode: "upi", reference: `J-${tag}` },
      desk,
      db,
    );
    expect(done.status).toBe("final");
    const order = await one(
      `SELECT o.payment_status, array_agg(t.test_name) AS tests
         FROM giniflow_lab_orders o JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1 GROUP BY o.id`,
      [made.visit],
    );
    expect(order).toEqual({ payment_status: "paid", tests: [ids.hba1cName] });
  });

  test("3. a journey changed after the preview is refused at the old total, and nothing is collected", async () => {
    const made = await extraVisit(ids, "JourneyEdit", { healthray: false });
    const preview = await arrival.arrivalBillPreview(
      made.visit,
      { plan: { steps: [vitals, bloodSample()] } },
      desk,
      db,
    );
    await journey.checkInWithJourney(made.visit, { steps: [vitals], actorId: desk.actorId }, db);
    await expect(
      arrival.commitArrivalBill(
        made.visit,
        { expectedTotal: preview.outstanding, mode: "upi", reference: `J2-${tag}` },
        desk,
        db,
      ),
    ).rejects.toMatchObject({ code: "amount_changed" });
    expect((await written(made.visit)).current_status).toBe("checked_in");
    const paid = await query(
      `SELECT 1 FROM payments p JOIN bills b ON b.id = p.bill_id WHERE b.visit_id = $1`,
      [made.visit],
    );
    expect(paid.rows).toEqual([]);
  });

  test("4. a patient already checked in is previewed from what is there, not from the plan", async () => {
    const made = await extraVisit(ids, "JourneyHere", { healthray: false });
    await journey.checkInWithJourney(made.visit, { steps: [vitals], actorId: desk.actorId }, db);
    const preview = await arrival.arrivalBillPreview(
      made.visit,
      { plan: { steps: [vitals, bloodSample()] } },
      desk,
      db,
    );
    expect(preview.lines.map((l) => l.itemId)).not.toContain(ids.hba1c);
    expect((await written(made.visit)).orders).toBe(0);
  });

  test("5. the stations API previews the planned journey for the billing desk only", async () => {
    const made = await extraVisit(ids, "JourneyApi", { healthray: false });
    const url = `/api/giniflow/stations/reception/${made.visit}/arrival-bill/preview`;
    const data = { steps: [vitals, bloodSample()] };
    const reception = await apiAs("reception");
    const res = await reception.post(url, { data });
    expect(res.status()).toBe(200);
    expect((await res.json()).lines.map((l) => l.itemId)).toContain(ids.hba1c);
    expect((await written(made.visit)).orders).toBe(0);

    const coordinator = await apiAs("coordinator");
    expect((await coordinator.post(url, { data })).status()).toBe(403);
  });

  test("6. a returning visit with a draft and a journey without tests: quick preview, same total at check-in", async () => {
    const made = await extraVisit(ids, "JourneyNoTests", { visitType: "Follow Up" });
    await bills.openDraft(made.visit, desk, db);
    const steps = [vitals, { catalogId: "sd_consult", name: "SD Consultation", minutes: 20 }];
    const preview = await arrival.arrivalBillPreview(made.visit, { plan: { steps } }, desk, db);
    expect(preview.lines.map((l) => l.itemId)).toContain(ids.consultFu);
    expect(await written(made.visit)).toMatchObject({ current_status: "booked", steps: 0 });

    await journey.checkInWithJourney(made.visit, { steps, actorId: desk.actorId }, db);
    const done = await arrival.commitArrivalBill(
      made.visit,
      { expectedTotal: preview.outstanding, mode: "upi", reference: `J6-${tag}` },
      desk,
      db,
    );
    expect(done.status).toBe("final");
  });
});
