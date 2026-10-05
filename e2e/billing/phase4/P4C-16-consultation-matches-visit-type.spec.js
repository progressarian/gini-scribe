import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { autoConsultation, extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";
import { openAddItems } from "../../helpers/addItems.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const requests = await import("../../../server/services/billing/billingRequests.js");
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
const desk = { actorId: USERS.reception.id, ip: "10.9.16.1", role: "reception" };
const admin = { actorId: USERS.reception_admin.id, ip: "10.9.16.2" };
const NEW_REFUSAL = /^This is a New Patient visit — add the New consultation$/;
const FU_REFUSAL = /^This is a Follow Up visit — add the Follow Up consultation$/;
const visits = {};
let ids;
let autoBefore;

async function search(visitId, q = tag) {
  const api = await apiAs("reception");
  const response = await api.get("/api/billing/items/search", {
    params: { q, limit: 20, ...(visitId ? { visit_id: visitId } : {}) },
  });
  const body = await response.json();
  await api.dispose();
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body;
}

async function openDraft(visitId) {
  const api = await apiAs("reception");
  const response = await api.post(`/api/billing/visits/${visitId}/bills`, { data: {} });
  const body = await response.json();
  await api.dispose();
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body;
}

async function addLine(billId, data) {
  const api = await apiAs("reception");
  const response = await api.post(`/api/billing/bills/${billId}/lines`, { data });
  const body = await response.json();
  await api.dispose();
  return { status: response.status(), body };
}

const consultationIds = (body) =>
  body.items
    .filter((item) => item.kind === "consultation")
    .map((item) => item.id)
    .sort((a, b) => a - b);
const otherIds = (body) =>
  body.items
    .filter((item) => item.kind !== "consultation")
    .map((item) => item.id)
    .sort((a, b) => a - b);
const sorted = (...values) => [...values].sort((a, b) => a - b);

const liveItems = (visitId) =>
  query(`SELECT service_item_id FROM bill_lines WHERE visit_id = $1 AND is_live ORDER BY line_no`, [
    visitId,
  ]).then((r) => r.rows.map((row) => row.service_item_id));

const addItems = (page) => page.getByRole("region", { name: "Add items" });
const results = (page) => addItems(page).getByRole("list", { name: "Item search results" });
const searchInput = (page) => addItems(page).getByRole("searchbox", { name: "Search items" });

test.describe.serial("P4C-16 consultation search and add match the visit type", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    visits.fu = await extraVisit(ids, "C16Fu", { visitType: "Follow Up" });
    visits.none = await extraVisit(ids, "C16None", { visitType: null });
    visits.invest = await extraVisit(ids, "C16Invest", { visitType: "Investigation" });
    visits.again = await extraVisit(ids, "C16Again", { visitType: "Follow Up" });
  });

  test.afterAll(async () => {
    try {
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
    } finally {
      await tearDown(ids);
    }
  });

  test("1. a New visit's search shows only New consultations", async () => {
    const body = await search(ids.visit);
    expect(body.consultation_type).toBe("New");
    expect(body.consultations_hidden).toBe(true);
    expect(consultationIds(body)).toEqual(sorted(ids.consultNew, ids.consultDoctorNew));
  });

  test("2. a Follow Up visit's search shows only the Follow Up consultation", async () => {
    const body = await search(visits.fu.visit);
    expect(body.consultation_type).toBe("Follow Up");
    expect(body.consultations_hidden).toBe(true);
    expect(consultationIds(body)).toEqual([ids.consultFu]);
  });

  test("3. a visit with no booking, an Investigation visit, or no visit shows every consultation", async () => {
    const all = sorted(ids.consultNew, ids.consultFu, ids.consultDoctorNew);
    for (const visitId of [visits.none.visit, visits.invest.visit, null]) {
      const body = await search(visitId);
      expect(body.consultation_type).toBeNull();
      expect(body.consultations_hidden).toBe(false);
      expect(consultationIds(body)).toEqual(all);
    }
  });

  test("4. other items are the same whatever the visit type", async () => {
    const expected = sorted(ids.dressing, ids.brace, ids.hba1c, ids.abi);
    for (const visitId of [ids.visit, visits.fu.visit, visits.none.visit, null]) {
      expect(otherIds(await search(visitId))).toEqual(expected);
    }
    const fu = await search(visits.fu.visit, `Dressing ${tag}`);
    expect(fu.items.map((item) => item.id)).toEqual([ids.dressing]);
    expect(fu.consultations_hidden).toBe(false);
  });

  test("5. the server refuses the other consultation type and takes the right one", async () => {
    const draft = await openDraft(ids.visit);
    const wrong = await addLine(draft.id, { item_id: ids.consultFu });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toMatch(NEW_REFUSAL);
    expect(await liveItems(ids.visit)).toEqual([]);
    const right = await addLine(draft.id, { item_id: ids.consultNew });
    expect(right.status, JSON.stringify(right.body)).toBe(200);
    expect(await liveItems(ids.visit)).toEqual([ids.consultNew]);

    const fuDraft = await openDraft(visits.fu.visit);
    const fuWrong = await addLine(fuDraft.id, { item_id: ids.consultDoctorNew });
    expect(fuWrong.status).toBe(409);
    expect(fuWrong.body.error).toMatch(FU_REFUSAL);
    const noneDraft = await openDraft(visits.none.visit);
    const anyType = await addLine(noneDraft.id, { item_id: ids.consultFu });
    expect(anyType.status, JSON.stringify(anyType.body)).toBe(200);
  });

  test("6. an approved bill-again of the other type is refused and the approval stays unused", async () => {
    const draft = await openDraft(visits.again.visit);
    const first = await addLine(draft.id, { item_id: ids.consultFu });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await query(`UPDATE appointments SET visit_type = 'New Patient' WHERE id = $1`, [
      visits.again.appointment,
    ]);
    const asked = await requests.createRepeatRequest(
      { service_item_id: ids.consultFu, visit_id: visits.again.visit, reason: "Seen twice" },
      desk,
      db,
    );
    await requests.approveRequest(asked.id, { note: "ok" }, admin, db);
    const again = await addLine(draft.id, {
      item_id: ids.consultFu,
      repeat_request_id: asked.id,
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(NEW_REFUSAL);
    const request = await one(`SELECT status FROM billing_requests WHERE id = $1`, [asked.id]);
    expect(request.status).toBe("approved");
    expect(await liveItems(visits.again.visit)).toEqual([ids.consultFu]);

    const locked = await one(`SELECT * FROM bills WHERE id = $1`, [draft.id]);
    const client = await db.connect();
    try {
      const error = await bills
        .addLineIn(client, locked, { item_id: ids.consultFu, repeat_request_id: asked.id }, desk)
        .then(() => null)
        .catch((e) => e);
      expect(error?.status).toBe(409);
      expect(error.message).toMatch(NEW_REFUSAL);
    } finally {
      client.release();
    }
  });

  test("7. the counter lists only the visit's consultation type and says so", async ({ page }) => {
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${visits.fu.visit}`, () => addItems(page));
    await openAddItems(page);
    await searchInput(page).fill(`${tag}`);
    await expect(results(page)).toContainText(`Consultation Follow Up ${tag}`);
    await expect(results(page)).toContainText(`Dressing ${tag}`);
    await expect(results(page)).not.toContainText(`Consultation New ${tag}`);
    await expect(results(page)).not.toContainText(`Consultation Dr New ${tag}`);
    await expect(addItems(page)).toContainText("Showing Follow Up consultations for this visit");

    await openAddItems(page);
    await searchInput(page).fill(`Consultation New ${tag}`);
    await expect(addItems(page)).toContainText(`No item matches`);
    await expect(addItems(page)).toContainText("Showing Follow Up consultations for this visit");
    await expect(addItems(page)).not.toContainText(`Consultation Dr New ${tag}`);

    await openAddItems(page);
    await searchInput(page).fill(`Dressing ${tag}`);
    await expect(results(page).getByRole("listitem")).toHaveCount(1);
    await expect(addItems(page)).not.toContainText("consultations for this visit");
  });
});
