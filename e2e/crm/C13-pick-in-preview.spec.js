import { test, expect } from "@playwright/test";
import {
  seedCrmStaff,
  seedDoctors,
  crmApi,
  stageImport,
  rowsOf,
  openOwner,
  loginCrm,
  xlsxBuffer,
  resetCrm,
} from "../helpers/crm.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one } from "../helpers/db.mjs";

test.describe("CRM import: choosing or correcting the staff member in the preview", () => {
  let users;
  let api;
  let staff;
  let doctors;
  let batchId;
  const id = (name) => staff.find((s) => s.full_name === name).id;

  test.beforeAll(async () => {
    const seeded = await seedCrmStaff();
    users = seeded.users;
    doctors = await seedDoctors(seeded.hospitalId, [
      { full_name: "Dr Pick Existing", mobile: "9922000001", territory: "Mohali" },
    ]);
    api = await crmApi(users.virender);
    staff = await (await api.get("/api/crm/import/assignees")).json();
    batchId = (
      await stageImport(api, [
        {
          "Full name": "Dr Pick New",
          Mobile: "9922000002",
          Area: "Mohali",
          "Assigned to": "Ramesh",
        },
        { "Full name": "Dr Pick Existing", Mobile: "9922000001", "Assigned to": "Sandeep Sangory" },
        { "Full name": "", Mobile: "9922000003", "Assigned to": "Rajesh" },
      ])
    ).body.batchId;
    await api.post(`/api/crm/import/batches/${batchId}/resolve`);
  });

  test.afterAll(resetCrm);

  test("1. choosing staff for a failed row fixes it before import", async () => {
    const res = await api.post(`/api/crm/import/batches/${batchId}/pick`, {
      data: { row_number: 2, assignee_id: id("Rajesh Sharma") },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).counts.failed).toBe(1);
    const row = (await rowsOf(api, batchId)).find((r) => r.row_number === 2);
    expect(row).toMatchObject({ outcome: "create", assign_status: "pending", fail_reason: null });
    expect(row.assignee.full_name).toBe("Rajesh Sharma");
    expect(row.assignee_note).toBe("Chosen in preview");
  });

  test("2. a matched row can be corrected, and its spelling flag goes away", async () => {
    await api.post(`/api/crm/import/batches/${batchId}/pick`, {
      data: { row_number: 3, assignee_id: id("Virender Satija") },
    });
    const row = (await rowsOf(api, batchId)).find((r) => r.row_number === 3);
    expect(row.assignee.full_name).toBe("Virender Satija");
    expect(row.flags.join(" ")).not.toContain("Check spelling");
  });

  test("3. a row with no doctor name cannot be fixed with a staff name", async () => {
    const res = await api.post(`/api/crm/import/batches/${batchId}/pick`, {
      data: { row_number: 4, assignee_id: id("Rajesh Sharma") },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe(
      "That row can no longer be changed — refresh the preview",
    );
  });

  test("4. the CEO cannot be chosen, and a growth executive cannot pick at all", async () => {
    const ceo = await one(`SELECT id FROM crm.users WHERE full_name = 'Sandeep'`);
    const res = await api.post(`/api/crm/import/batches/${batchId}/pick`, {
      data: { row_number: 2, assignee_id: ceo.id },
    });
    expect(res.status()).toBe(400);
    const rajesh = await crmApi(users.rajesh);
    const denied = await rajesh.post(`/api/crm/import/batches/${batchId}/pick`, {
      data: { row_number: 2, assignee_id: id("Rajesh Sharma") },
    });
    expect(denied.status()).toBe(403);
  });

  test("5. the import uses the choices", async () => {
    let s;
    for (let i = 0; i < 5; i++) {
      s = await (await api.post(`/api/crm/import/batches/${batchId}/commit`, { data: {} })).json();
      if (s.counts.pending === 0) break;
    }
    expect(s.counts).toMatchObject({ created: 1, assigned: 2, failed: 1 });
    const created = await one(`SELECT id FROM crm.doctors WHERE full_name = 'Dr Pick New'`);
    expect(await openOwner(created.id)).toBe("Rajesh Sharma");
    expect(await openOwner(doctors[0].id)).toBe("Virender Satija");
    const after = await api.post(`/api/crm/import/batches/${batchId}/pick`, {
      data: { row_number: 2, assignee_id: id("Sandeep Sangroy") },
    });
    expect(after.status()).toBe(400);
  });

  test("6. in the browser, the failed row's dropdown fixes it before importing", async ({
    page,
  }) => {
    await loginCrm(page, api);
    await gotoReady(page, "/crm/import", () =>
      page.getByRole("heading", { name: "Import doctors" }),
    );
    const buffer = await xlsxBuffer([
      { "Full name": "Dr Ui Pick", Mobile: "9922000010", Area: "Mohali", "Assigned to": "Ramesh" },
    ]);
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "ui-pick.xlsx", mimeType: "application/octet-stream", buffer });
    await page.getByRole("button", { name: "Preview import" }).click();
    await expect(page.getByRole("button", { name: /^Failed\s*1$/ })).toBeVisible();

    const picker = page.getByRole("combobox", { name: "Assign row 2 to" });
    await expect(picker.locator("option:checked")).toHaveText("Ramesh");
    await expect(page.getByText("Not matched — choose a staff member")).toBeVisible();
    await expect(picker.locator("option", { hasText: "Rajesh Sharma (suggested)" })).toHaveCount(1);
    await picker.selectOption({ label: "Rajesh Sharma (suggested)" });
    await expect(page.getByRole("button", { name: /^Failed\s*0$/ })).toBeVisible();
    await expect(page.getByText("Saving…")).toHaveCount(0);
    await expect(picker).toBeEnabled();
    await expect(picker.locator("option:checked")).toHaveText("Rajesh Sharma");

    await page.getByRole("button", { name: "Import and assign 1 rows" }).click();
    await expect(page.getByText("New doctors created")).toBeVisible();
    const created = await one(`SELECT id FROM crm.doctors WHERE full_name = 'Dr Ui Pick'`);
    expect(await openOwner(created.id)).toBe("Rajesh Sharma");
  });
});
