import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const GROUP = `P436 Group ${tag}`;
const ITEM = `P436 Dressing ${tag}`;
const WANTED = `P436 Ankle brace ${tag}`;
const SPARE = `P436 Crutches ${tag}`;
const CLASHING = `P436 Cast shoe ${tag}`;
const SPARE_REASON = `Hired out at the counter ${tag}`;
const CLASH_REASON = `Sold with the cast ${tag}`;
const LATE_REASON = `Asked twice by mistake ${tag}`;
const FRESH = `P436 Sling ${tag}`;
const FRESH_REASON = `Arrived while the inbox was open ${tag}`;
const NEW_REASON = `Sold at the counter, not in the master ${tag}`;
const REPEAT_REASON = `Second dressing after the cast came off ${tag}`;
const PATIENT = `P436 Patient ${tag}`;
const FILE_NO = `F436-${tag}`;
const seed = {};

const waitingTable = (page) => page.getByRole("table", { name: "Requests waiting" });
const decidedTable = (page) => page.getByRole("table", { name: "Decided requests" });
const waitingRow = (page, text) => waitingTable(page).getByRole("row").filter({ hasText: text });
const decidedRow = (page, text) => decidedTable(page).getByRole("row").filter({ hasText: text });
const dialog = (page) => page.getByRole("dialog");
const field = (page, label) => dialog(page).getByLabel(label, { exact: true });

const requestRow = (id) =>
  one(
    `SELECT kind, status, decision_note, created_item_id, decided_by FROM billing_requests
      WHERE id = $1`,
    [id],
  );

async function openPage(page, role = "reception_admin") {
  await loginAs(page, role);
  await gotoReady(page, "/settings/desk-requests", () =>
    page.getByRole("heading", { name: "Waiting for an answer" }),
  );
}

test.describe.serial("P4-36 desk requests page", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    const admin = await apiAs("admin");
    const post = async (path, data) => {
      const response = await admin.post(`/api/billing/master/${path}`, { data });
      expect(response.status(), `${path} ${JSON.stringify(data)}`).toBe(201);
      return response.json();
    };
    seed.group = await post("groups", { code: `P436G_${T}`, name: GROUP });
    seed.subgroup = await post("subgroups", {
      group_id: seed.group.id,
      code: `P436S_${T}`,
      name: `Procedures ${tag}`,
    });
    seed.item = await post("items", {
      code: `P436I_${T}`,
      name: ITEM,
      subgroup_id: seed.subgroup.id,
      base_price: 500,
      kind: "procedure",
    });
    await admin.dispose();

    seed.patient = (
      await one(
        `INSERT INTO patients (name, file_no, age, sex) VALUES ($1, $2, 61, 'Male') RETURNING id`,
        [PATIENT, FILE_NO],
      )
    ).id;
    seed.visit = (
      await one(
        `INSERT INTO giniflow_visits (patient_id, visit_date) VALUES ($1, CURRENT_DATE) RETURNING id`,
        [seed.patient],
      )
    ).id;
    seed.bill = (
      await one(`INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`, [
        seed.patient,
        seed.visit,
      ])
    ).id;
    await query(
      `INSERT INTO bill_lines
         (bill_id, visit_id, line_no, service_item_id, bill_name, quantity, rate,
          listed_actual, actual_amount, taxable, patient_payable)
       VALUES ($1, $2, 1, $3, $4, 1, 500, 500, 500, 500, 500)`,
      [seed.bill, seed.visit, seed.item.id, ITEM],
    );

    const desk = await apiAs("reception");
    const ask = async (path, data) => {
      const response = await desk.post(`/api/billing/requests/${path}`, { data });
      expect(response.status(), `${path} ${await response.text()}`).toBe(201);
      return response.json();
    };
    seed.newItemRequest = await ask("new-item", {
      proposed_name: WANTED,
      proposed_group: GROUP,
      reason: NEW_REASON,
    });
    seed.spareRequest = await ask("new-item", {
      proposed_name: SPARE,
      reason: SPARE_REASON,
    });
    seed.clashRequest = await ask("new-item", {
      proposed_name: CLASHING,
      reason: CLASH_REASON,
    });
    seed.lateRequest = await ask("new-item", {
      proposed_name: `P436 Walker ${tag}`,
      reason: LATE_REASON,
    });
    seed.repeatRequest = await ask("repeat", {
      service_item_id: seed.item.id,
      visit_id: seed.visit,
      bill_id: seed.bill,
      reason: REPEAT_REASON,
    });
    await desk.dispose();
  });

  test.afterAll(async () => {
    await query(`DELETE FROM bill_lines WHERE bill_id = $1`, [seed.bill ?? null]);
    await query(`DELETE FROM billing_requests WHERE reason LIKE $1`, [`%${tag}`]);
    await query(`DELETE FROM bills WHERE patient_id = $1`, [seed.patient ?? null]);
    await query(`DELETE FROM giniflow_visits WHERE patient_id = $1`, [seed.patient ?? null]);
    await query(`DELETE FROM patients WHERE file_no = $1`, [FILE_NO]);
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P436%${T}`]);
    await query(`DELETE FROM service_subgroups WHERE code = $1`, [`P436S_${T}`]);
    await query(`DELETE FROM service_groups WHERE code = $1`, [`P436G_${T}`]);
  });

  test("1. the inbox shows both kinds with everything needed to decide, and no price", async ({
    page,
  }) => {
    await openPage(page);

    const newItem = waitingRow(page, WANTED);
    await expect(newItem).toContainText("E2E Reception");
    await expect(newItem).toContainText("New item");
    await expect(newItem).toContainText(`Group: ${GROUP}`);
    await expect(newItem).toContainText(NEW_REASON);
    await expect(newItem).toContainText("No patient — a new item only");
    await expect(newItem).not.toContainText("₹");

    const repeat = waitingRow(page, REPEAT_REASON);
    await expect(repeat).toContainText(PATIENT);
    await expect(repeat).toContainText(FILE_NO);
    await expect(repeat).toContainText("61y");
    await expect(repeat).toContainText(ITEM);
    await expect(repeat).toContainText("Bill again");
    await expect(repeat).toContainText("already on this visit's draft bill");

    const waiting = (await waitingTable(page).getByRole("row").count()) - 1;
    expect(waiting).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole("link", { name: /Desk requests/ })).toContainText(String(waiting));
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByLabel("Price (₹)", { exact: true })).toHaveCount(0);

    const priced = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'billing_requests'
          AND column_name ~ 'price|rate|amount|fee'`,
    );
    expect(priced.rows).toEqual([]);
  });

  test("2. a rejection without a note is refused; with a note it is recorded", async ({ page }) => {
    await openPage(page);
    await page.getByRole("button", { name: `Reject request for ${SPARE}` }).click();
    await dialog(page).getByRole("button", { name: "Reject request", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText(/can.t be blank|Write a note/);
    expect((await requestRow(seed.spareRequest.id)).status).toBe("pending");

    const note = `We hire these, we don't bill them ${tag}`;
    await field(page, "Note").fill(note);
    await dialog(page).getByRole("button", { name: "Reject request", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(waitingRow(page, SPARE)).toHaveCount(0);
    const decided = decidedRow(page, SPARE);
    await expect(decided).toContainText("Rejected");
    await expect(decided).toContainText(note);
    expect(await requestRow(seed.spareRequest.id)).toMatchObject({
      status: "rejected",
      decision_note: note,
    });
  });

  test("3. approving the new item really creates the item, at the admin's price", async ({
    page,
  }) => {
    await openPage(page);
    await page.getByRole("button", { name: `Create item for ${WANTED}` }).click();
    await expect(field(page, "Name")).toHaveValue(WANTED);
    await field(page, "Code").fill(`P436N_${T}`);
    await field(page, "Subgroup").selectOption(String(seed.subgroup.id));
    await field(page, "Kind").selectOption("procedure");
    await field(page, "Price (₹)").fill("1250");
    await field(page, "Note for the desk").fill(`Added to the master ${tag}`);
    await dialog(page).getByRole("button", { name: "Create item and approve" }).click();
    await expect(dialog(page)).toHaveCount(0);

    await expect(waitingRow(page, WANTED)).toHaveCount(0);
    const decided = decidedRow(page, WANTED);
    await expect(decided).toContainText("Item created");
    await expect(decided).toContainText(`P436N_${T}`);
    await expect(decided).toContainText("E2E Reception Admin");

    const created = await one(
      `SELECT code, base_price::text, kind, subgroup_id FROM service_items WHERE name = $1`,
      [WANTED],
    );
    expect(created).toMatchObject({
      code: `P436N_${T}`,
      base_price: "1250.00",
      kind: "procedure",
      subgroup_id: seed.subgroup.id,
    });
    const request = await requestRow(seed.newItemRequest.id);
    expect(request.status).toBe("approved");
    expect(request.created_item_id).not.toBeNull();
  });

  test("4. an approved repeat shows as usable, then as used once the desk spends it", async ({
    page,
  }) => {
    await openPage(page);
    await page.getByRole("button", { name: `Approve billing ${ITEM} again` }).click();
    await field(page, "Note for the desk").fill(`One extra dressing ${tag}`);
    await dialog(page).getByRole("button", { name: "Approve request", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);

    await expect(waitingRow(page, REPEAT_REASON)).toHaveCount(0);
    await expect(decidedRow(page, REPEAT_REASON)).toContainText(
      "Usable — waiting for the desk to bill it",
    );
    expect((await requestRow(seed.repeatRequest.id)).status).toBe("approved");

    await query(
      `INSERT INTO bill_lines
         (bill_id, visit_id, line_no, service_item_id, bill_name, quantity, rate,
          listed_actual, actual_amount, taxable, patient_payable, repeat_request_id)
       VALUES ($1, $2, 2, $3, $4, 1, 500, 500, 500, 500, 500, $5)`,
      [seed.bill, seed.visit, seed.item.id, ITEM, seed.repeatRequest.id],
    );
    await query(`UPDATE billing_requests SET status = 'used' WHERE id = $1`, [
      seed.repeatRequest.id,
    ]);

    await openPage(page);
    await expect(decidedRow(page, REPEAT_REASON)).toContainText("Used on this visit's draft bill");
  });

  test("5. a failed approval leaves the request waiting and creates no item", async ({ page }) => {
    await openPage(page);
    await page.getByRole("button", { name: `Create item for ${CLASHING}` }).click();
    await field(page, "Code").fill(`P436I_${T}`);
    await field(page, "Subgroup").selectOption(String(seed.subgroup.id));
    await field(page, "Price (₹)").fill("300");
    await dialog(page).getByRole("button", { name: "Create item and approve" }).click();

    await expect(dialog(page).getByRole("alert")).toContainText(`P436I_${T}`);
    await expect(dialog(page).getByRole("alert")).toContainText("already exists");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();

    expect(await requestRow(seed.clashRequest.id)).toMatchObject({
      status: "pending",
      created_item_id: null,
    });
    expect((await query(`SELECT id FROM service_items WHERE name = $1`, [CLASHING])).rows).toEqual(
      [],
    );
    await expect(waitingRow(page, CLASHING)).toHaveCount(1);
  });

  test("6. a request answered by another admin refuses in the server's own words, and the row goes", async ({
    page,
  }) => {
    await openPage(page);
    await expect(waitingRow(page, LATE_REASON)).toHaveCount(1);

    const other = await apiAs("admin");
    const answered = await other.post(
      `/api/billing/master/requests/${seed.lateRequest.id}/reject`,
      { data: { note: `Answered at the other desk ${tag}` } },
    );
    expect(answered.status()).toBe(200);
    await other.dispose();

    await page.getByRole("button", { name: /Reject request for P436 Walker/ }).click();
    await field(page, "Note").fill(`Too late ${tag}`);
    await dialog(page).getByRole("button", { name: "Reject request", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("already rejected");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();

    await expect(waitingRow(page, LATE_REASON)).toHaveCount(0);
    await expect(decidedRow(page, LATE_REASON)).toContainText(`Answered at the other desk ${tag}`);
    expect((await requestRow(seed.lateRequest.id)).decision_note).toBe(
      `Answered at the other desk ${tag}`,
    );
  });

  test("7. a request arriving while the inbox is open shows up without a reload", async ({
    page,
  }) => {
    const asked = [];
    page.on("request", (r) => asked.push(r.url()));
    await openPage(page);
    expect(asked.filter((u) => u.includes("/api/giniflow/realtime-token")).length).toBeGreaterThan(
      0,
    );
    await expect(waitingRow(page, FRESH)).toHaveCount(0);

    const desk = await apiAs("reception");
    const made = await desk.post("/api/billing/requests/new-item", {
      data: { proposed_name: FRESH, reason: FRESH_REASON },
    });
    expect(made.status()).toBe(201);
    await desk.dispose();

    await expect(waitingRow(page, FRESH)).toHaveCount(1, { timeout: 30000 });
  });

  test("8. a decided request is not offered again, and the server refuses a second answer", async ({
    page,
  }) => {
    await openPage(page);
    await expect(decidedRow(page, WANTED)).toHaveCount(1);
    await expect(decidedRow(page, REPEAT_REASON)).toHaveCount(1);
    await expect(page.getByRole("button", { name: `Reject request for ${ITEM}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Create item for ${WANTED}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Approve billing ${ITEM} again` })).toHaveCount(
      0,
    );

    const admin = await apiAs("admin");
    const again = await admin.post(
      `/api/billing/master/requests/${seed.newItemRequest.id}/reject`,
      { data: { note: `Changed my mind ${tag}` } },
    );
    expect(again.status()).toBe(409);
    expect((await again.json()).error).toMatch(/already approved/);
    await admin.dispose();
    expect((await requestRow(seed.newItemRequest.id)).status).toBe("approved");
  });

  test("9. the billing desk itself cannot reach the inbox, and never asks for it", async ({
    page,
  }) => {
    const asked = [];
    page.on("request", (r) => asked.push(r.url()));
    await loginAs(page, "reception");
    await gotoReady(page, "/settings/desk-requests", () => page.locator(".tabs"));
    await expect(page).not.toHaveURL(/\/settings/);
    await expect(page.getByRole("heading", { name: "Waiting for an answer" })).toHaveCount(0);
    expect(asked.filter((u) => u.includes("/api/billing/master/requests"))).toEqual([]);
  });

  test("10. a coordinator, holding neither billing capability, cannot reach it either", async ({
    page,
  }) => {
    await loginAs(page, "coordinator");
    await gotoReady(page, "/settings/desk-requests", () => page.locator(".tabs"));
    await expect(page).not.toHaveURL(/\/settings/);
    await expect(page.getByRole("heading", { name: "Waiting for an answer" })).toHaveCount(0);

    const api = await apiAs("coordinator");
    const refused = await api.get("/api/billing/master/requests");
    expect(refused.status()).toBe(403);
    await api.dispose();
  });
});
