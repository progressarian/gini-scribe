import { test, expect } from "@playwright/test";
import {
  seedCrmStaff,
  seedDoctors,
  crmApi,
  loginCrm,
  xlsxBuffer,
  readXlsx,
  openOwner,
  resetCrm,
} from "../helpers/crm.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one } from "../helpers/db.mjs";

test.describe("CRM import page: assign, fix failed rows, export", () => {
  let users;
  let doctors;

  test.beforeAll(async () => {
    const seeded = await seedCrmStaff();
    users = seeded.users;
    doctors = await seedDoctors(seeded.hospitalId, [
      {
        full_name: "Dr Ui Existing",
        mobile: "9900000001",
        territory: "Mohali",
        owner: users.rajesh.crmId,
      },
      { full_name: "Dr Ui Typo", mobile: "9900000002", territory: "Mohali" },
    ]);
  });

  test.afterAll(resetCrm);

  test("1. the full flow from upload to a fixed failed row", async ({ page }) => {
    await loginCrm(page, await crmApi(users.virender));
    await gotoReady(page, "/crm/import", () =>
      page.getByRole("heading", { name: "Import doctors" }),
    );
    await expect(page.getByRole("button", { name: "Download doctors template" })).toBeVisible();

    const buffer = await xlsxBuffer([
      { "Full name": "Dr Ui Existing", Mobile: "9900000001", "Assigned to": "Sandeep Sangory" },
      { "Full name": "Dr Ui Typo", Mobile: "9900000002", "Assigned to": "Ramesh" },
      { "Full name": "Dr Ui New", Mobile: "9900000003", Area: "Mohali", "Assigned to": "Virender" },
    ]);
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "ui-assign.xlsx", mimeType: "application/octet-stream", buffer });

    await expect(page.getByRole("combobox", { name: "Column Assigned to becomes" })).toHaveValue(
      "assigned_to",
    );
    await page.getByRole("button", { name: "Preview import" }).click();

    const failedChip = page.getByRole("button", { name: /^Failed\s*1$/ });
    await expect(failedChip).toBeVisible();
    await expect(page.getByText("Check spelling: Sandeep Sangory → Sandeep Sangroy")).toBeVisible();
    await failedChip.click();
    await expect(page.getByText("No staff named Ramesh")).toBeVisible();
    await expect(page.getByRole("cell", { name: "Dr Ui New" })).toHaveCount(0);

    await page.getByRole("button", { name: "Import and assign 2 rows" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("1 row will not be imported")).toBeVisible();
    await expect(dialog.getByText("“Ramesh”")).toBeVisible();
    await dialog.getByRole("button", { name: "Go back and fix" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Import and assign 2 rows" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Import 2 rows anyway" }).click();
    await expect(page.getByText("New doctors created")).toBeVisible();
    expect(await openOwner(doctors[0].id)).toBe("Sandeep Sangroy");

    const panel = page.getByRole("region", { name: /Failed rows/ });
    const picker = panel.getByRole("combobox", { name: "Assign row 3 to" });
    await expect(picker).toHaveValue(
      (await one(`SELECT id FROM crm.users WHERE full_name = 'Rajesh Sharma'`)).id,
    );

    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Export failed rows" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("ui-assign-failed-rows.xlsx");
    const { rows } = await readXlsx(await streamToBuffer(await file.createReadStream()));
    expect(rows[0]).toMatchObject({ "Assigned to": "Ramesh", Reason: "No staff named Ramesh" });

    await panel.getByRole("button", { name: "Retry selected (1)" }).click();
    await expect(page.getByText("1 row assigned. No failed rows remain.")).toBeVisible();
    expect(await openOwner(doctors[1].id)).toBe("Rajesh Sharma");
  });

  for (const who of ["manager", "rajesh"]) {
    test(`2. ${who} is sent away from the import page`, async ({ page }) => {
      await loginCrm(page, await crmApi(users[who]));
      await page.goto("/crm/import");
      await expect(page.getByText("You don't have access to this page")).toBeVisible();
      await expect(page).not.toHaveURL(/\/crm\/import/);
      await expect(page.getByRole("heading", { name: "Import doctors" })).toHaveCount(0);
    });
  }
});

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
