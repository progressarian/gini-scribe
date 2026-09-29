import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { fromPaise } from "../../../src/components/billing/format.js";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  payRule,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const removal = await import("../../../server/services/doctorRemoval.js");
const { priceBill } = await import("../../../server/services/billing/priceBill.js");

const db = getPool();
const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
const admin = { actorId: USERS.admin.id, ip: "10.9.17.1", role: "admin" };
const OTHER = `Dr P4C17 Other ${tag}`;
const NEW_ONLY = `Dr P4C17 NewOnly ${tag}`;
const GONE = `Dr P4C17 Gone ${tag}`;
const ours = {};
const visits = {};
let ids;
let autoBefore;

async function doctor(name) {
  const { pin } = await one(`SELECT pin FROM doctors WHERE id = $1`, [USERS.reception.id]);
  return (
    await one(
      `INSERT INTO doctors (name, short_name, role, pin, is_active)
       VALUES ($1, $1, 'consultant', $2, TRUE) RETURNING id`,
      [name, pin],
    )
  ).id;
}

async function consultation(code, name, price, visitType, doctorId) {
  return (
    await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, visit_type, doctor_id)
       VALUES ($1, $2, $3, $4, 'consultation', $5, $6) RETURNING id`,
      [`${code}-${tag}`, `${name} ${tag}`, ids.subgroup, price, visitType, doctorId],
    )
  ).id;
}

async function dropDoctors() {
  const doctors = [ours.other, ours.newOnly, ours.gone].filter(Boolean);
  if (!doctors.length) return;
  await query(`DELETE FROM service_items WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM auth_sessions WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM refresh_tokens WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM audit_log WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM audit_log WHERE entity_type = 'doctor' AND entity_id = ANY($1)`, [
    doctors,
  ]);
  await query(`DELETE FROM appointments WHERE doctor_id = ANY($1)`, [doctors]);
  await query(`DELETE FROM doctors WHERE id = ANY($1)`, [doctors]);
}

async function suggestion(billId) {
  const api = await apiAs("reception");
  const response = await api.get("/api/billing/consultation-suggestion", {
    params: { bill_id: billId },
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

const consultationLines = (visitId) =>
  query(
    `SELECT l.service_item_id, l.doctor_id, l.source
       FROM bill_lines l JOIN service_items i ON i.id = l.service_item_id
      WHERE l.visit_id = $1 AND l.is_live AND i.kind = 'consultation'
      ORDER BY l.line_no`,
    [visitId],
  ).then((r) => r.rows);

const visitTypesOf = async (itemIds) =>
  (
    await query(`SELECT DISTINCT visit_type FROM service_items WHERE id = ANY($1::int[])`, [
      itemIds,
    ])
  ).rows.map((row) => row.visit_type);

const card = (page) => page.getByRole("region", { name: "Consultation", exact: true });
const changeDoctor = (page) => card(page).getByLabel("Change doctor");
const billLines = (page) => page.getByRole("table", { name: "Bill lines" });
const addItems = (page) => page.getByRole("region", { name: "Add items" });

async function openCounter(page, visitId) {
  await gotoReady(page, `${RECEPTION}?tab=bill&visit=${visitId}`, () => addItems(page));
}

const addLabel = (type, doctorName, price) =>
  `Add ${type} consultation — ${doctorName} ${fromPaise(price)}`;

test.describe.serial("P4C-17 one-click consultation at the counter", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    ours.other = await doctor(OTHER);
    ours.newOnly = await doctor(NEW_ONLY);
    ours.gone = await doctor(GONE);
    ours.otherFu = await consultation(
      "P4-C17OF",
      "P4 Consult Other FU",
      1300,
      "Follow Up",
      ours.other,
    );
    ours.otherNew = await consultation("P4-C17ON", "P4 Consult Other New", 1700, "New", ours.other);
    ours.newOnlyNew = await consultation(
      "P4-C17NN",
      "P4 Consult NewOnly New",
      1600,
      "New",
      ours.newOnly,
    );
    ours.goneFu = await consultation("P4-C17GF", "P4 Consult Gone FU", 900, "Follow Up", ours.gone);
    await payRule(ids, ids.paid, {
      name: "paid half consult",
      service_item_id: ids.consultFu,
      visit_types: ["Follow Up"],
      patient_pays: "percent",
      patient_value: 50,
    });
    await payRule(ids, ids.pensioner, { name: "pensioner pays nothing", patient_pays: "nothing" });
    await query(
      `INSERT INTO category_item_rates (scheme_code, service_item_id, rate, valid_from)
       VALUES ($1, $2, 600, $3::date)`,
      [ids.paid, ids.consultFu, ids.day],
    );
    for (const [key, label, options] of [
      ["general", "C17Gen", { visitType: "Follow Up" }],
      ["cghs", "C17Cghs", { visitType: "Follow Up" }],
      ["change", "C17Change", { visitType: "Follow Up" }],
      ["none", "C17None", { visitType: null }],
      ["invest", "C17Invest", { visitType: "Investigation" }],
      ["final", "C17Final", { visitType: "Follow Up" }],
      ["gone", "C17Gone", { visitType: "Follow Up", doctorId: ours.gone }],
      ["quiet", "C17Quiet", { visitType: "Follow Up" }],
      ["phone", "C17Phone", { visitType: "Follow Up" }],
      ["auto", "C17Auto", { visitType: "Follow Up" }],
    ]) {
      visits[key] = await extraVisit(ids, label, options);
    }
  });

  test.afterAll(async () => {
    try {
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
      await tearDown(ids);
    } finally {
      await dropDoctors();
    }
  });

  test("1. a General Follow Up visit suggests the booked doctor's Follow Up consultation at its price", async ({
    page,
  }) => {
    const draft = await openDraft(visits.general.visit);
    const body = await suggestion(draft.id);
    expect(body.shown).toBe(true);
    expect(body.visit_type).toBe("Follow Up");
    expect(body.removed_doctor).toBeNull();
    expect(body.suggested).toMatchObject({
      item_id: ids.consultFu,
      doctor_id: CONSULTANTS.banshali.id,
      doctor_name: CONSULTANTS.banshali.name,
      price: 100000,
    });
    expect(body.choices[0].item_id).toBe(ids.consultFu);
    const offered = body.choices.map((choice) => choice.item_id);
    expect(offered).toContain(ours.otherFu);
    expect(offered).not.toContain(ids.consultNew);
    expect(offered).not.toContain(ours.otherNew);
    expect(offered).not.toContain(ours.newOnlyNew);
    expect(await visitTypesOf(offered)).toEqual(["Follow Up"]);
    expect(body.choices.find((choice) => choice.item_id === ours.otherFu).price).toBe(130000);

    await loginAs(page, "reception");
    await openCounter(page, visits.general.visit);
    await expect(
      card(page).getByRole("button", {
        name: addLabel("Follow Up", CONSULTANTS.banshali.name, 100000),
        exact: true,
      }),
    ).toBeVisible();
  });

  test("2. a CGHS patient's suggestion shows the category rate after the payment rule", async ({
    page,
  }) => {
    const draft = await openDraft(visits.cghs.visit);
    const set = await bills.setCategory(draft.id, { category: ids.paid }, desk, db);
    const expected = await priceBill(
      {
        patientId: visits.cghs.patient,
        appointmentId: visits.cghs.appointment,
        category: ids.paid,
        date: set.bill_date,
        role: desk.role,
        lines: [{ item: ids.consultFu, quantity: 1, doctorId: CONSULTANTS.banshali.id }],
      },
      db,
    );
    expect(expected.lines[0].rate).toBe(60000);
    expect(expected.lines[0].patient_payable).toBe(30000);
    const body = await suggestion(draft.id);
    expect(body.suggested.item_id).toBe(ids.consultFu);
    expect(body.suggested.price).toBe(30000);

    await loginAs(page, "reception");
    await openCounter(page, visits.cghs.visit);
    await expect(
      card(page).getByRole("button", {
        name: addLabel("Follow Up", CONSULTANTS.banshali.name, 30000),
        exact: true,
      }),
    ).toBeVisible();
  });

  test("3. one click adds the suggested consultation through the normal add, and the suggestion goes", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openCounter(page, visits.general.visit);
    const button = card(page).getByRole("button", {
      name: addLabel("Follow Up", CONSULTANTS.banshali.name, 100000),
      exact: true,
    });
    await button.click();
    await expect(billLines(page)).toContainText(`Consultation Follow Up ${tag}`);
    await expect(card(page)).toHaveCount(0);
    expect(await consultationLines(visits.general.visit)).toEqual([
      { service_item_id: ids.consultFu, doctor_id: CONSULTANTS.banshali.id, source: "added" },
    ]);
    const audit = await one(
      `SELECT count(*)::int AS n FROM billing_audit
        WHERE entity = 'bill_lines' AND action = 'create'
          AND after ->> 'visit_id' = $1 AND after ->> 'service_item_id' = $2`,
      [visits.general.visit, String(ids.consultFu)],
    );
    expect(audit.n).toBe(1);
  });

  test("4. Change doctor lists only the visit's type and adds the picked consultation", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openCounter(page, visits.change.visit);
    const select = changeDoctor(page);
    await expect(select).toBeVisible();
    const options = await select.locator("option").allTextContents();
    expect(options[0]).toBe(`${CONSULTANTS.banshali.name} — ${fromPaise(100000)}`);
    expect(options).toContain(`${OTHER} — ${fromPaise(130000)}`);
    expect(options.some((text) => text.startsWith(NEW_ONLY))).toBe(false);
    const draft = await one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft'`, [
      visits.change.visit,
    ]);
    const body = await suggestion(draft.id);
    expect(options).toHaveLength(body.choices.length);
    expect(await visitTypesOf(body.choices.map((choice) => choice.item_id))).toEqual(["Follow Up"]);

    await select.selectOption({ label: `${OTHER} — ${fromPaise(130000)}` });
    const button = card(page).getByRole("button", {
      name: addLabel("Follow Up", OTHER, 130000),
      exact: true,
    });
    await button.click();
    await expect(billLines(page)).toContainText(`P4 Consult Other FU ${tag}`);
    await expect(card(page)).toHaveCount(0);
    expect(await consultationLines(visits.change.visit)).toEqual([
      { service_item_id: ours.otherFu, doctor_id: ours.other, source: "added" },
    ]);
  });

  test("5. hidden with a consultation already on the visit, with no booking, for an Investigation, and on a final bill", async ({
    page,
  }) => {
    const general = await openDraft(visits.general.visit);
    expect((await suggestion(general.id)).shown).toBe(false);
    const none = await openDraft(visits.none.visit);
    expect((await suggestion(none.id)).shown).toBe(false);
    const invest = await openDraft(visits.invest.visit);
    expect((await suggestion(invest.id)).shown).toBe(false);

    const draft = await openDraft(visits.final.visit);
    expect((await suggestion(draft.id)).shown).toBe(true);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const set = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    const final = await bills.finaliseBill(draft.id, { version: set.version }, desk, db);
    expect(final.status).toBe("final");
    expect((await suggestion(final.id)).shown).toBe(false);

    await loginAs(page, "reception");
    for (const visit of [visits.general, visits.none, visits.invest]) {
      await openCounter(page, visit.visit);
      await expect(page.getByRole("region", { name: "Bill actions" })).toBeVisible();
      await expect(card(page)).toHaveCount(0);
    }
    await gotoReady(
      page,
      `${RECEPTION}?tab=bill&visit=${visits.final.visit}&bill=${final.id}`,
      () => page.getByRole("region", { name: "Bill actions" }),
    );
    await expect(billLines(page)).toContainText(`Dressing ${tag}`);
    await expect(card(page)).toHaveCount(0);
  });

  test("6. after the desk removes the consultation, it is suggested again", async ({ page }) => {
    const draft = await openDraft(visits.change.visit);
    const line = draft.lines.find((entry) => entry.service_item_id === ours.otherFu);
    const api = await apiAs("reception");
    const removed = await api.post(`/api/billing/bills/${draft.id}/lines/${line.id}/remove`, {
      data: {},
    });
    expect(removed.status(), await removed.text()).toBe(200);
    await api.dispose();
    expect(await consultationLines(visits.change.visit)).toEqual([]);
    const body = await suggestion(draft.id);
    expect(body.shown).toBe(true);
    expect(body.suggested.item_id).toBe(ids.consultFu);

    await loginAs(page, "reception");
    await openCounter(page, visits.change.visit);
    await expect(card(page)).toBeVisible();
    await expect(await consultationLines(visits.change.visit)).toEqual([]);
    await card(page)
      .getByRole("button", {
        name: addLabel("Follow Up", CONSULTANTS.banshali.name, 100000),
        exact: true,
      })
      .click();
    await expect(card(page)).toHaveCount(0);
    expect(await consultationLines(visits.change.visit)).toEqual([
      { service_item_id: ids.consultFu, doctor_id: CONSULTANTS.banshali.id, source: "added" },
    ]);
  });

  test("7. a removed booked doctor gets no suggestion and no note, only other doctors to choose", async ({
    page,
  }) => {
    await removal.removeDoctor(ours.gone, { reason: "Left" }, admin, db);
    const draft = await openDraft(visits.gone.visit);
    const body = await suggestion(draft.id);
    expect(body.shown).toBe(true);
    expect(body.suggested).toBeNull();
    expect(body.removed_doctor).toEqual({ id: ours.gone, name: GONE });
    const offered = body.choices.map((choice) => choice.item_id);
    expect(offered).toContain(ours.otherFu);
    expect(offered).not.toContain(ours.goneFu);
    expect(offered).not.toContain(ids.consultFu);

    const api = await apiAs("reception");
    const refused = await api.post(`/api/billing/bills/${draft.id}/lines`, {
      data: { item_id: ids.consultFu },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toMatch(new RegExp(`^${GONE} was removed, so `));
    await api.dispose();

    await loginAs(page, "reception");
    await openCounter(page, visits.gone.visit);
    await expect(card(page)).toBeVisible();
    await expect(page.getByText(`${GONE} was removed`)).toHaveCount(0);
    const button = card(page).getByRole("button", { name: "Add Follow Up consultation" });
    await expect(button).toBeDisabled();
    await expect(changeDoctor(page)).toHaveValue("");
    await changeDoctor(page).selectOption({ label: `${OTHER} — ${fromPaise(130000)}` });
    await card(page)
      .getByRole("button", { name: addLabel("Follow Up", OTHER, 130000), exact: true })
      .click();
    await expect(card(page)).toHaveCount(0);
    expect(await consultationLines(visits.gone.visit)).toEqual([
      { service_item_id: ours.otherFu, doctor_id: ours.other, source: "added" },
    ]);
  });

  test("8. nothing is added without a click: opening and reopening leaves no consultation", async ({
    page,
  }) => {
    await openDraft(visits.quiet.visit);
    await openDraft(visits.quiet.visit);
    await loginAs(page, "reception");
    await openCounter(page, visits.quiet.visit);
    await expect(card(page)).toBeVisible();
    await page.reload();
    await expect(card(page)).toBeVisible();
    await openCounter(page, visits.quiet.visit);
    await expect(card(page)).toBeVisible();
    expect(await consultationLines(visits.quiet.visit)).toEqual([]);
  });

  test("9. at phone width the suggestion fits without sideways scrolling", async ({ page }) => {
    await loginAs(page, "reception");
    await page.setViewportSize({ width: 390, height: 844 });
    await openCounter(page, visits.phone.visit);
    const button = card(page).getByRole("button", {
      name: addLabel("Follow Up", CONSULTANTS.banshali.name, 100000),
      exact: true,
    });
    await expect(button).toBeVisible();
    await expect(changeDoctor(page)).toBeVisible();
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(1);
    const box = await card(page).boundingBox();
    const within = await button.boundingBox();
    expect(within.x + within.width).toBeLessThanOrEqual(box.x + box.width + 1);
  });

  test("10. with the automatic setting on, the consultation is added and the suggestion hides", async () => {
    let draft;
    try {
      await autoConsultation(true);
      draft = await openDraft(visits.auto.visit);
    } finally {
      await autoConsultation(false);
    }
    expect(await consultationLines(visits.auto.visit)).toEqual([
      { service_item_id: ids.consultFu, doctor_id: CONSULTANTS.banshali.id, source: "visit" },
    ]);
    expect((await suggestion(draft.id)).shown).toBe(false);
  });
});
