import { test, expect } from "@playwright/test";
import { getPool, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const mo = await import("../../server/services/giniflow/moStation.js");
const lab = await import("../../server/services/giniflow/labStation.js");
const { HOME_PAYMENT_PENDING } = await import("../../shared/labPayment.js");
const board = await import("../../server/services/giniflow/board.js");
const reception = await import("../../server/services/giniflow/receptionStation.js");
const report = await import("../../server/services/giniflow/homeCollectionReport.js");

const db = getPool();
const tag = newTag();
const actor = { actorId: USERS.lab.id };
let ids;
const cases = [];
const patients = [];

const homeVisit = async (label, { tick = true } = {}) => {
  const made = await extraVisit(ids, label);
  patients.push(made.patient);
  if (tick) {
    await query(`UPDATE appointments SET home_collection = TRUE WHERE id = $1`, [made.appointment]);
  }
  return made;
};

const orderOf = async (visitId, tests = [ids.looseName]) => {
  await mo.orderTests(visitId, { urgency: "today", tests, actorId: USERS.admin.id }, db);
  const { rows } = await query(
    `SELECT id FROM giniflow_lab_orders WHERE visit_id = $1 AND kind = 'lab' ORDER BY created_at`,
    [visitId],
  );
  return rows.map((row) => row.id);
};

const markPaid = (orderId) =>
  query(
    `UPDATE giniflow_lab_orders
        SET payment_status = 'paid', sample_status = 'paid', amount_paid = amount_total
      WHERE id = $1`,
    [orderId],
  );

const newCase = async (made, label) => {
  const caseNo = `G98-${label}-${tag}`;
  cases.push(caseNo);
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            appointment_id, test_names, case_date, case_status, raw_list_json)
     VALUES ($1, $1, $1, 985098, $2, $3, $4, $5::date, 'Registered', $6::jsonb)`,
    [
      caseNo,
      made.patient,
      made.appointment,
      [ids.looseName],
      ids.day,
      JSON.stringify({ case_status: "Registered", patient: { healthray_uid: null } }),
    ],
  );
  return caseNo;
};

const labBillingDone = (visitId) =>
  query(
    `INSERT INTO giniflow_visit_steps (visit_id, step_order, step_catalog_id, step_name, status)
     VALUES ($1, 990, 'lab_billing', 'Lab Billing', 'done')`,
    [visitId],
  );

const collectedEvent = async (orderId) =>
  (
    await query(
      `SELECT actor_id, meta FROM giniflow_lab_order_events
        WHERE lab_order_id = $1 AND track = 'sample' AND status = 'sample_collected'`,
      [orderId],
    )
  ).rows;

const sampleEvents = async (orderId) =>
  (
    await query(
      `SELECT status FROM giniflow_lab_order_events
        WHERE lab_order_id = $1 AND track = 'sample' ORDER BY occurred_at`,
      [orderId],
    )
  ).rows.map((row) => row.status);

const takenRow = async (caseNo) =>
  (
    await query(
      `SELECT actor_id, collected_at_site, collected_at FROM giniflow_lab_case_actions
        WHERE case_no = $1 AND action = 'sample_taken'`,
      [caseNo],
    )
  ).rows[0];

const advance = (orderId, to, extra = {}) =>
  lab.advanceSample(orderId, { to, ...actor, room: null, ...extra }, db);

const caseAction = (caseNo, action, extra = {}) =>
  lab.markLabCaseAction(caseNo, { action, ...actor, room: null, ...extra }, db);

const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { status: error.status, message: error.message };
  }
  return null;
};

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

test.describe.serial("G98 home collection — where the sample was taken, and by whom", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM giniflow_lab_case_actions WHERE case_no = ANY($1)`, [cases]);
    await query(`DELETE FROM lab_cases WHERE case_no = ANY($1)`, [cases]);
    await query(`DELETE FROM lab_test_requests WHERE patient_id = ANY($1)`, [patients]);
    await tearDown(ids);
  });

  test("1. a ticked booking, paid: one collected event stamped home, by the lab user, then the sample moves on", async () => {
    const made = await homeVisit("Tick");
    const [orderId] = await orderOf(made.visit);
    await markPaid(orderId);
    const at = minutesAgo(30);
    const done = await lab.collectAtHome({ orderId }, { ...actor, collectedAt: at }, db);
    expect(done.orders).toEqual([orderId]);
    expect(await sampleEvents(orderId)).toEqual(["sample_collected"]);
    const [event] = await collectedEvent(orderId);
    expect(event.actor_id).toBe(USERS.lab.id);
    expect(event.meta).toEqual({ site: "home", collectedAt: new Date(at).toISOString() });
    await advance(orderId, "sample_sent");
    await advance(orderId, "sample_received");
    expect(await sampleEvents(orderId)).toEqual([
      "sample_collected",
      "sample_sent",
      "sample_received",
    ]);
  });

  test("2. an approved home request from the app counts the same as a ticked booking", async () => {
    const made = await homeVisit("Request", { tick: false });
    await query(
      `INSERT INTO lab_test_requests (patient_id, test_names, collection_type, address_house,
                                      address_street, address_landmark, address_pincode, status)
       VALUES ($1, $2, 'home', '12', 'Phase 7', 'Near park', '160062', 'approved')`,
      [made.patient, [ids.looseName]],
    );
    const [orderId] = await orderOf(made.visit);
    await markPaid(orderId);
    await lab.collectAtHome({ orderId }, actor, db);
    expect((await collectedEvent(orderId))[0].meta.site).toBe("home");
  });

  test("3. a HealthRay case records the site, the time and the collector", async () => {
    const made = await homeVisit("Case");
    const caseNo = await newCase(made, "case");
    const at = minutesAgo(45);
    await lab.collectAtHome({ caseNo }, { ...actor, collectedAt: at }, db);
    const row = await takenRow(caseNo);
    expect(row.actor_id).toBe(USERS.lab.id);
    expect(row.collected_at_site).toBe("home");
    expect(new Date(row.collected_at).toISOString()).toBe(new Date(at).toISOString());
    const drawn = await query(
      `SELECT 1 FROM giniflow_lab_case_actions WHERE case_no = $1 AND action = 'drawing_started'`,
      [caseNo],
    );
    expect(drawn.rows).toHaveLength(0);
  });

  test("4. a home patient who came to GHM goes through the bench and is stamped ghm", async () => {
    const made = await homeVisit("Came");
    const [orderId] = await orderOf(made.visit);
    await markPaid(orderId);
    await advance(orderId, "drawing", { room: "collection" });
    await advance(orderId, "sample_collected", { room: "collection", site: "ghm" });
    expect(await sampleEvents(orderId)).toEqual(["drawing", "sample_collected"]);
    expect((await collectedEvent(orderId))[0].meta).toEqual({ site: "ghm" });

    const caseMade = await homeVisit("CameCase");
    const caseNo = await newCase(caseMade, "came");
    await labBillingDone(caseMade.visit);
    await caseAction(caseNo, "drawing_started", { room: "collection" });
    await caseAction(caseNo, "sample_taken", { room: "collection" });
    expect((await takenRow(caseNo)).collected_at_site).toBe("ghm");
  });

  test("5. a patient who did not opt for home collection is refused a site, and the bench flow is unchanged", async () => {
    const made = await homeVisit("Plain", { tick: false });
    const [orderId] = await orderOf(made.visit);
    await markPaid(orderId);
    const home = await refusal(lab.collectAtHome({ orderId }, actor, db));
    expect(home).toEqual({ status: 400, message: "This patient did not opt for home collection" });
    const ghm = await refusal(advance(orderId, "drawing", { site: "ghm" }));
    expect(ghm?.status).toBe(400);
    await advance(orderId, "drawing", { room: "collection" });
    await advance(orderId, "sample_collected", { room: "collection" });
    expect((await collectedEvent(orderId))[0].meta).toEqual({});
  });

  test("6. unpaid home sample: collected, sent, received and run, but the report waits for payment", async () => {
    const made = await homeVisit("Unpaid");
    const [orderId] = await orderOf(made.visit);
    await lab.collectAtHome({ orderId }, actor, db);
    for (const step of ["sample_sent", "sample_received", "processing", "results_ready"]) {
      await advance(orderId, step);
    }
    expect(await refusal(advance(orderId, "uploaded"))).toEqual({
      status: 409,
      message: HOME_PAYMENT_PENDING,
    });
    await query(
      `UPDATE giniflow_lab_orders SET payment_status = 'paid', amount_paid = amount_total
        WHERE id = $1`,
      [orderId],
    );
    expect((await advance(orderId, "uploaded")).sampleStatus).toBe("uploaded");

    const caseMade = await homeVisit("UnpaidCase");
    const caseNo = await newCase(caseMade, "unpaid");
    await lab.collectAtHome({ caseNo }, actor, db);
    for (const step of ["sample_sent", "sample_received", "processing", "results_ready"]) {
      await caseAction(caseNo, step);
    }
    await query(`UPDATE lab_cases SET pdf_storage_path = $2 WHERE case_no = $1`, [
      caseNo,
      `g98/${caseNo}.pdf`,
    ]);
    expect(await refusal(caseAction(caseNo, "report_uploaded"))).toEqual({
      status: 409,
      message: HOME_PAYMENT_PENDING,
    });
    await labBillingDone(caseMade.visit);
    expect((await caseAction(caseNo, "report_uploaded")).action).toBe("report_uploaded");

    const plain = await homeVisit("PlainUnpaid", { tick: false });
    const [plainOrder] = await orderOf(plain.visit);
    const blocked = await refusal(advance(plainOrder, "drawing", { room: "collection" }));
    expect(blocked?.status).toBe(409);
    expect(blocked?.message).toMatch(/Payment is not cleared/);
  });

  test("7. the collection time can't be in the future or before the visit date", async () => {
    const made = await homeVisit("Clock");
    const [orderId] = await orderOf(made.visit);
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(
      await refusal(lab.collectAtHome({ orderId }, { ...actor, collectedAt: later }, db)),
    ).toEqual({ status: 400, message: "The collection time can't be in the future" });
    const before = new Date(`${ids.day}T00:00:00+05:30`).getTime() - 60 * 60 * 1000;
    expect(
      await refusal(
        lab.collectAtHome(
          { orderId },
          { ...actor, collectedAt: new Date(before).toISOString() },
          db,
        ),
      ),
    ).toEqual({ status: 400, message: "The collection time can't be before the visit date" });
    expect(await sampleEvents(orderId)).toEqual([]);
  });

  test("8. also marking the other samples marks every uncollected case for that patient at once", async () => {
    const made = await homeVisit("Several");
    const first = await newCase(made, "first");
    const second = await newCase(made, "second");
    const done = await lab.collectAtHome({ caseNo: first }, { ...actor, alsoOthers: true }, db);
    expect(done.cases.sort()).toEqual([first, second].sort());
    expect((await takenRow(first)).collected_at_site).toBe("home");
    expect((await takenRow(second)).collected_at_site).toBe("home");
    const again = await refusal(lab.collectAtHome({ caseNo: second }, actor, db));
    expect(again).toEqual({ status: 409, message: "This sample has already been collected" });
  });

  test("9. undoing the collection takes the site and time away with it", async () => {
    const made = await homeVisit("Undo");
    const caseNo = await newCase(made, "undo");
    await lab.collectAtHome({ caseNo }, actor, db);
    expect((await takenRow(caseNo)).collected_at_site).toBe("home");
    await caseAction(caseNo, "sample_taken", { undo: true });
    expect(await takenRow(caseNo)).toBeUndefined();
  });

  test("10. through the API: the lab marks it as itself; reception and OBT are refused", async () => {
    const made = await homeVisit("Api");
    const [orderId] = await orderOf(made.visit);
    await markPaid(orderId);
    const body = { to: "sample_collected", site: "home", room: "collection" };
    for (const role of ["reception", "obt_one"]) {
      const api = await apiAs(role);
      const response = await api.post(`/api/giniflow/stations/lab/${orderId}/advance`, {
        data: body,
      });
      expect(response.status(), role).toBe(403);
      await api.dispose();
    }
    const labApi = await apiAs("lab");
    const wrongStep = await labApi.post(`/api/giniflow/stations/lab/${orderId}/advance`, {
      data: { ...body, to: "drawing" },
    });
    expect(wrongStep.status()).toBe(400);
    const marked = await labApi.post(`/api/giniflow/stations/lab/${orderId}/advance`, {
      data: body,
    });
    expect(marked.status(), await marked.text()).toBe(200);
    expect((await collectedEvent(orderId))[0].actor_id).toBe(USERS.lab.id);

    const plain = await homeVisit("ApiPlain", { tick: false });
    const [plainOrder] = await orderOf(plain.visit);
    const refused = await labApi.post(`/api/giniflow/stations/lab/${plainOrder}/advance`, {
      data: body,
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toBe("This patient did not opt for home collection");
    await labApi.dispose();
  });

  test("11. the header counts follow the marking", async () => {
    const made = await homeVisit("Count");
    const [orderId] = await orderOf(made.visit);
    const counts = async () =>
      (await lab.getLabQueue(ids.day, `Count ${tag}`, db, { room: "collection" })).homeCounts;
    expect(await counts()).toEqual({ homeCollected: 0, homePending: 1 });
    const card = (await lab.getLabQueue(ids.day, `Count ${tag}`, db, { room: "collection" }))
      .unified[0];
    expect(card).toMatchObject({ homeCollection: true, homeCollectable: true });
    await lab.collectAtHome({ orderId }, actor, db);
    expect(await counts()).toEqual({ homeCollected: 1, homePending: 0 });
    const after = (await lab.getLabQueue(ids.day, `Count ${tag}`, db, { room: "collection" }))
      .unified[0];
    expect(after).toMatchObject({
      homeCollection: true,
      homeCollectable: false,
      collectedAtSite: "home",
      collectedBy: USERS.lab.short_name,
    });
  });

  const findCard = (value, fileNo) => {
    if (!value || typeof value !== "object") return null;
    if (value.fileNo === fileNo && "homeCollection" in value) return value;
    for (const child of Object.values(value)) {
      const found = findCard(child, fileNo);
      if (found) return found;
    }
    return null;
  };

  test("12. the coordinator board card says where the sample was taken and by whom", async () => {
    const made = await homeVisit("Board");
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      made.visit,
    ]);
    const [orderId] = await orderOf(made.visit);
    const day = async () =>
      board.getDayBoard(ids.day, await board.getSlaConfig(db), new Date(), db);
    expect(findCard(await day(), `F4Board-${tag}`)).toMatchObject({
      homeCollection: true,
      homeSample: null,
    });
    await lab.collectAtHome({ orderId }, actor, db);
    const card = findCard(await day(), `F4Board-${tag}`);
    expect(card.homeSample).toMatchObject({ site: "home", by: USERS.lab.short_name });
  });

  test("14a. reception: the unpaid home sample is tagged and has its own filter until it is paid", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const made = await homeVisit("Desk");
    const [orderId] = await orderOf(made.visit);
    const plain = await homeVisit("DeskPlain", { tick: false });
    await orderOf(plain.visit);
    await lab.collectAtHome({ orderId }, actor, db);
    const queue = await reception.getPaymentQueue(ids.day, db, { q: `Desk` });
    const pending = queue.pending.find((o) => o.orderId === orderId);
    expect(pending.homeSample).toMatchObject({ site: "home", by: USERS.lab.short_name });
    expect(queue.counts.homePaymentPending).toBeGreaterThanOrEqual(1);

    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception?tab=payments", () =>
      page.getByPlaceholder("Search payments — name, file no or phone"),
    );
    await page.getByPlaceholder("Search payments — name, file no or phone").fill(`Desk`);
    const homeCard = page.locator(".test-order-card").filter({ hasText: `P4 Desk ${tag}` });
    const plainCard = page.locator(".test-order-card").filter({ hasText: `P4 DeskPlain ${tag}` });
    await expect(homeCard.getByText(/🏠 Collected at home · Lab \d{2}:\d{2} · ₹\d/)).toBeVisible();
    await expect(plainCard).toBeVisible();
    const chip = page.getByRole("button", { name: /🏠 Home collection — payment pending/ });
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(homeCard).toBeVisible();
    await expect(plainCard).toHaveCount(0);
    await chip.click();
    await expect(plainCard).toBeVisible();

    await query(
      `UPDATE giniflow_lab_orders SET payment_status = 'paid', amount_paid = amount_total
        WHERE id = $1`,
      [orderId],
    );
    const after = await reception.getPaymentQueue(ids.day, db, { q: `Desk` });
    expect(after.pending.find((o) => o.orderId === orderId)).toBeUndefined();
  });

  test("16. Lab 2 shows the home badge as soon as the sample is marked, without a reload", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const made = await homeVisit("Bench");
    const [orderId] = await orderOf(made.visit);
    await markPaid(orderId);
    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/station/lab/processing", () =>
      page.getByRole("searchbox", { name: "Search today's lab patients" }),
    );
    await page.getByRole("searchbox", { name: "Search today's lab patients" }).fill(`Bench ${tag}`);
    const labApi = await apiAs("lab");
    const marked = await labApi.post(`/api/giniflow/stations/lab/${orderId}/advance`, {
      data: { to: "sample_collected", site: "home", room: "collection" },
    });
    expect(marked.status(), await marked.text()).toBe(200);
    const sent = await labApi.post(`/api/giniflow/stations/lab/${orderId}/advance`, {
      data: { to: "sample_sent", room: "collection" },
    });
    expect(sent.status(), await sent.text()).toBe(200);
    await labApi.dispose();
    const card = page.locator(".pt-card").filter({ hasText: `P4 Bench ${tag}` });
    await expect(card.getByText(/🏠 Home · Lab · \d{2}:\d{2}/)).toBeVisible({ timeout: 20000 });
  });

  test("13. the home collections report filters, pages and sorts on the server, and its summary matches", async () => {
    const base = { from: ids.day, to: ids.day, q: tag };
    const all = await report.listHomeCollections({ ...base, pageSize: 100 }, db);
    expect(all.total).toBeGreaterThanOrEqual(10);
    expect(all.rows).toHaveLength(all.total);
    for (const site of ["home", "ghm", "pending"]) {
      const only = await report.listHomeCollections({ ...base, site, pageSize: 100 }, db);
      expect(only.total, site).toBe(all.summary[site]);
      expect(only.rows.every((r) => r.site === site)).toBe(true);
    }
    expect(all.summary.home + all.summary.ghm + all.summary.pending).toBe(all.total);
    const atHome = all.rows.filter((r) => r.site === "home");
    expect(all.summary.byCollector).toEqual([
      { id: USERS.lab.id, name: USERS.lab.short_name, count: atHome.length },
    ]);
    const mine = await report.listHomeCollections(
      { ...base, collectorId: USERS.lab.id, pageSize: 100 },
      db,
    );
    expect(mine.rows.every((r) => r.collectedBy === USERS.lab.short_name)).toBe(true);

    const first = await report.listHomeCollections({ ...base, pageSize: 3, page: 1 }, db);
    const second = await report.listHomeCollections({ ...base, pageSize: 3, page: 2 }, db);
    expect(first.rows).toHaveLength(3);
    expect(second.total).toBe(all.total);
    expect(second.rows.map((r) => r.visitId)).not.toContain(first.rows[0].visitId);

    const sorted = await report.listHomeCollections(
      { ...base, sort: "patient_asc", pageSize: 100 },
      db,
    );
    const names = sorted.rows.map((r) => r.name);
    expect(names).toEqual(
      [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })),
    );

    const unpaid = all.rows.find((r) => r.name === `P4 Unpaid ${tag}`);
    expect(unpaid).toMatchObject({ site: "home", labStatus: "Reported", tests: [ids.looseName] });
    const pending = all.rows.find((r) => r.name === `P4 Clock ${tag}`);
    expect(pending).toMatchObject({ site: "pending", collectedBy: null, collectedAt: null });

    const labApi = await apiAs("lab");
    const capped = await labApi.get("/api/giniflow/stations/lab/home-collections", {
      params: { ...base, pageSize: 500 },
    });
    expect(capped.status()).toBe(400);
    const backwards = await labApi.get("/api/giniflow/stations/lab/home-collections", {
      params: { from: ids.day, to: "2020-01-01" },
    });
    expect(backwards.status()).toBe(400);
    expect((await backwards.json()).error).toMatch(/start date/);
    const ok = await labApi.get("/api/giniflow/stations/lab/home-collections", { params: base });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).total).toBe(all.total);
    const file = await labApi.get("/api/giniflow/stations/lab/home-collections/export.xlsx", {
      params: base,
    });
    expect(file.status()).toBe(200);
    expect(file.headers()["content-type"]).toMatch(/spreadsheetml/);
    await labApi.dispose();
    for (const role of ["reception", "obt_one"]) {
      const api = await apiAs(role);
      const refused = await api.get("/api/giniflow/stations/lab/home-collections", {
        params: base,
      });
      expect(refused.status(), role).toBe(403);
      await api.dispose();
    }
  });

  test("14. GHM: the booking chip goes from not collected to collected, and the filter follows", async () => {
    const made = await homeVisit("Ghm");
    const [orderId] = await orderOf(made.visit);
    const api = await apiAs("admin");
    const listed = async (homeSample) => {
      const response = await api.get("/api/ghm-appointments", {
        params: {
          date: ids.day,
          limit: 100,
          page: 1,
          calls: "all",
          q: `Ghm ${tag}`,
          ...(homeSample ? { home_sample: homeSample } : {}),
        },
      });
      expect(response.status(), await response.text()).toBe(200);
      return (await response.json()).data.filter((row) => row.id === made.appointment);
    };
    expect(await listed()).toMatchObject([
      { home_collection: true, home_sample_status: "not_collected", home_sample: null },
    ]);
    expect(await listed("pending")).toHaveLength(1);
    expect(await listed("collected")).toHaveLength(0);
    await lab.collectAtHome({ orderId }, actor, db);
    const [row] = await listed();
    expect(row.home_sample_status).toBe("home");
    expect(row.home_sample).toMatchObject({ site: "home", by: USERS.lab.short_name });
    expect(await listed("pending")).toHaveLength(0);
    expect(await listed("collected")).toHaveLength(1);
    await api.dispose();
  });

  const openLab1 = async (page, search) => {
    await loginAs(page, "lab");
    await gotoReady(page, "/giniflow/station/lab/collection", () =>
      page.getByRole("searchbox", { name: "Search today's lab patients" }),
    );
    await page.getByRole("searchbox", { name: "Search today's lab patients" }).fill(search);
  };

  const tile = (page, label) => page.locator(".stat").filter({ hasText: label }).locator(".sv");

  test("15. Lab 1: the home card opens the dialog, Collected at home moves it and the counts follow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const made = await homeVisit("Screen");
    await orderOf(made.visit);
    const name = `P4 Screen ${tag}`;
    await openLab1(page, `Screen ${tag}`);
    const card = page.locator(".pt-card").filter({ hasText: name });
    await expect(card.getByText("🏠 Home collection")).toBeVisible();
    await expect(tile(page, "Home pending")).toHaveText("1");
    await expect(tile(page, "Home collected")).toHaveText("0");
    await card.getByRole("button", { name: "▶ Start collection" }).click();
    const dialog = page.getByRole("dialog", { name: `Start collection — ${name}` });
    await expect(dialog).toContainText(`F4Screen-${tag}`);
    await expect(dialog).toContainText(ids.looseName);
    await expect(dialog.getByRole("note")).toContainText("Payment pending");
    await expect(dialog.getByRole("button", { name: "🏥 Patient came to GHM" })).toBeDisabled();
    await dialog.getByRole("button", { name: "🏠 Collected at home" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText(`🏠 ${name} — sample collected at home`);
    await expect(card.getByText(/🏠 Home · Lab · \d{2}:\d{2}/)).toBeVisible();
    await expect(card).toContainText("the report is held until reception records it");
    await expect(tile(page, "Home pending")).toHaveText("0");
    await expect(tile(page, "Home collected")).toHaveText("1");
  });

  test("17. keyboard: the dialog takes focus, Esc closes it and focus returns to the button", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const made = await homeVisit("Keys");
    await orderOf(made.visit);
    await openLab1(page, `Keys ${tag}`);
    const button = page
      .locator(".pt-card")
      .filter({ hasText: `P4 Keys ${tag}` })
      .getByRole("button", { name: "▶ Start collection" });
    await button.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: `Start collection — P4 Keys ${tag}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Collected at")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
  ]) {
    test(`18. ${viewport.width}px: no sideways scroll, and the dialog's buttons are easy to tap`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const made = await homeVisit(`Size${viewport.width}`);
      await orderOf(made.visit);
      await openLab1(page, `Size${viewport.width} ${tag}`);
      const card = page.locator(".pt-card").filter({ hasText: `Size${viewport.width} ${tag}` });
      await expect(card).toBeVisible();
      const overflow = () =>
        page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(await overflow()).toBeLessThanOrEqual(0);
      await card.getByRole("button", { name: "▶ Start collection" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      if (viewport.width < 640) {
        expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(viewport.height - 2);
        expect(Math.round(box.width)).toBe(viewport.width);
        for (const name of ["🏠 Collected at home", "🏥 Patient came to GHM", "Cancel"]) {
          const button = await dialog.getByRole("button", { name }).boundingBox();
          expect(button.height, name).toBeGreaterThanOrEqual(44);
        }
      }
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");

      await loginAs(page, "admin");
      await gotoReady(page, "/reports/monthly", () =>
        page.getByRole("heading", { name: "Home collections" }),
      );
      await page.getByPlaceholder("Search by patient name, UHID or phone").fill(tag);
      await expect(page.locator(".hc-table tbody tr").first()).toBeVisible();
      expect(await overflow(), "report").toBeLessThanOrEqual(0);

      await gotoReady(page, `/ghm?date=${ids.day}&collection=home`, () =>
        page.locator(".home-sample-chip").first(),
      );
      expect(await overflow(), "GHM").toBeLessThanOrEqual(0);
    });
  }

  test("14b. GHM page: the chip sits under the patient's name", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, "admin");
    await gotoReady(page, `/ghm?date=${ids.day}&collection=home`, () =>
      page.locator(".home-sample-chip").first(),
    );
    const row = (label) => page.locator("tr").filter({ hasText: `P4 ${label} ${tag}` });
    await expect(row("Ghm").locator(".home-sample-chip")).toHaveText(
      /^🏠 Collected · Lab \d{2}:\d{2}$/,
    );
    await expect(row("Clock").locator(".home-sample-chip")).toHaveText("🏠 Not collected yet");
    await expect(row("Came").locator(".home-sample-chip")).toHaveText("🏥 Came to GHM");
  });
});
