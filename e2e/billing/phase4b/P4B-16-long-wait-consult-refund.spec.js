import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { apiAs } from "../../helpers/auth.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  askRefund,
  db,
  dropShifts,
  finalBill,
  inCash,
  lineFor,
  openDeskShift,
  prepareCategory,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const requests = await import("../../../server/services/billing/billingRequests.js");
const { counterPatients } = await import("../../../server/services/billing/counterPatients.js");

const tag = newTag();
let ids;

async function consultBill(label, status) {
  const { visit, bill } = await finalBill(
    ids,
    label,
    [{ item: ids.consultNew }, { item: ids.brace }],
    { pay: inCash },
  );
  await query(`UPDATE giniflow_visits SET current_status = $2 WHERE id = $1`, [visit, status]);
  return { visit, bill };
}

const askFor = (bill, items, reason_code, note) =>
  askRefund(
    bill.id,
    items.map((item) => ({ line_id: lineFor(bill, item).id })),
    { reason_code, ...(note ? { note } : { reason: undefined }) },
  );

const visitStatus = async (visit) =>
  (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visit])).current_status;

const exitEvents = (visit) =>
  query(
    `SELECT actor_id, meta FROM giniflow_visit_events WHERE visit_id = $1 AND status = 'exited'`,
    [visit],
  ).then((r) => r.rows);

const onCounter = async (visit) => {
  const list = await counterPatients(ids.day, "", new Date(), db);
  return [...list.toBill, ...list.billed, ...list.waiting].find((row) => row.visitId === visit);
};

test.describe.serial("P4B-16 a consultation refund for a long wait ends the visit", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. approving a long-wait consultation refund marks the waiting patient as left", async () => {
    const { visit, bill } = await consultBill("Waited", "ready_for_doctor");
    const request = await askFor(bill, [ids.consultNew], "long_wait");
    const api = await apiAs("admin");
    const response = await api.post(`/api/billing/master/requests/${request.id}/approve`, {
      data: {},
    });
    const body = await response.json();
    await api.dispose();
    expect(response.status(), body.error).toBe(200);
    expect(body.visit_left).toEqual({ ended: true, from: "ready_for_doctor" });
    expect(await visitStatus(visit)).toBe("exited");
    const [exit] = await exitEvents(visit);
    expect(exit.actor_id).toBe(USERS.admin.id);
    expect(exit.meta).toMatchObject({
      source: "counter_end_visit",
      from: "ready_for_doctor",
      refund_request_id: request.id,
      refund_reason: "long_wait",
    });
    const row = await onCounter(visit);
    expect(row.status).toBe("exited");
    expect(row.hints.consultation).toBe(false);
  });

  test("2. a patient who declined before the doctor also leaves", async () => {
    const { visit, bill } = await consultBill("Declined", "vitals_done");
    const request = await askFor(bill, [ids.consultNew, ids.brace], "patient_declined");
    const approved = await requests.approveRequest(request.id, {}, admin, db);
    expect(approved.visit_left).toEqual({ ended: true, from: "vitals_done" });
    expect(await visitStatus(visit)).toBe("exited");
  });

  test("3. a patient the doctor has already seen, or is seeing, is left alone", async () => {
    for (const status of ["doctor_done", "with_doctor", "rx_pending"]) {
      const { visit, bill } = await consultBill(`Seen${status}`, status);
      const request = await askFor(bill, [ids.consultNew], "long_wait");
      const approved = await requests.approveRequest(request.id, {}, admin, db);
      expect(approved.visit_left, status).toEqual({ ended: false, why: "seen" });
      expect(await visitStatus(visit)).toBe(status);
      expect(await exitEvents(visit)).toEqual([]);
    }
    const { visit, bill } = await consultBill("SeenBefore", "ready_for_doctor");
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, 'doctor_done', 'consultant', NOW() - interval '5 minutes')`,
      [visit],
    );
    const request = await askFor(bill, [ids.consultNew], "long_wait");
    const approved = await requests.approveRequest(request.id, {}, admin, db);
    expect(approved.visit_left).toEqual({ ended: false, why: "seen" });
    expect(await visitStatus(visit)).toBe("ready_for_doctor");
  });

  test("4. other reasons, or a refund without the consultation, leave the visit alone", async () => {
    const reasons = [
      ["doctor_cancelled", null],
      ["billed_by_mistake", null],
      ["other", "Came back tomorrow instead"],
    ];
    for (const [reason, note] of reasons) {
      const { visit, bill } = await consultBill(`Other${reason}`, "ready_for_doctor");
      const request = await askFor(bill, [ids.consultNew], reason, note);
      const approved = await requests.approveRequest(request.id, {}, admin, db);
      expect(approved.visit_left, reason).toBeNull();
      expect(await visitStatus(visit)).toBe("ready_for_doctor");
    }
    const { visit, bill } = await consultBill("BraceOnly", "ready_for_doctor");
    const request = await askFor(bill, [ids.brace], "long_wait");
    const approved = await requests.approveRequest(request.id, {}, admin, db);
    expect(approved.visit_left).toBeNull();
    expect(await visitStatus(visit)).toBe("ready_for_doctor");
  });

  test("5. a visit already closed or never arrived is not touched", async () => {
    for (const status of ["exited", "booked"]) {
      const { visit, bill } = await consultBill(`Closed${status}`, status);
      const request = await askFor(bill, [ids.consultNew], "long_wait");
      const approved = await requests.approveRequest(request.id, {}, admin, db);
      expect(approved.visit_left, status).toEqual({ ended: false, why: "not_on_floor" });
      expect(await visitStatus(visit)).toBe(status);
    }
  });

  test("6. a rejected long-wait refund leaves the visit alone", async () => {
    const { visit, bill } = await consultBill("Rejected", "ready_for_doctor");
    const request = await askFor(bill, [ids.consultNew], "long_wait");
    const rejected = await requests.rejectRequest(
      request.id,
      { note: "Doctor is free now" },
      admin,
      db,
    );
    expect(rejected.visit_left).toBeUndefined();
    expect(await visitStatus(visit)).toBe("ready_for_doctor");
  });
});
