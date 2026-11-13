import { test, expect } from "@playwright/test";
import { loginAs } from "../helpers/auth.mjs";
import { getPool, one, query } from "../helpers/db.mjs";
import { PATIENTS } from "../fixtures/data.mjs";
import { LAB_FIELDS, removeLabCatalog, seedLabCatalog } from "../fixtures/labCatalog.mjs";
import { saveResults } from "../../server/services/giniflow/labResults.js";

const ids = {};

test.describe.serial("LC14 the results form is grouped by test", () => {
  test.beforeAll(async () => {
    await seedLabCatalog(query);
    await query(
      `DELETE FROM giniflow_visits WHERE patient_id = $1
          AND visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
      [PATIENTS.general.id],
    );
    ids.visit = (
      await one(
        `INSERT INTO giniflow_visits (patient_id, visit_date, current_status)
         VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, 'arrived') RETURNING id`,
        [PATIENTS.general.id],
      )
    ).id;
    ids.order = (
      await one(
        `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total, amount_paid,
                                          sample_status, kind)
         VALUES ($1, 'today', 'paid', 900, 900, 'processing', 'lab') RETURNING id`,
        [ids.visit],
      )
    ).id;
    for (const name of ["Lipid Profile", "RFT", "LC14 Unknown Test"]) {
      await query(
        `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price, status)
         VALUES ($1, $2, 300, 'processing')`,
        [ids.order, name],
      );
    }
  });
  test.afterAll(async () => {
    await query(`DELETE FROM lab_results WHERE lab_order_id = $1`, [ids.order]);
    await query(`DELETE FROM giniflow_visits WHERE id = $1`, [ids.visit]);
    await removeLabCatalog(query);
  });

  test("one section per ordered test, the first open, the rest one line each", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/giniflow/station/lab/processing");
    await page.getByText(PATIENTS.general.name).first().click();
    const lipid = page.getByRole("button", { name: /^Lipid Profile \d/ });
    const rft = page.getByRole("button", { name: /^RFT \d/ });
    const unknown = page.getByRole("button", { name: /^LC14 Unknown Test \d/ });
    await expect(unknown).toHaveAttribute("aria-expanded", "true");
    await expect(unknown).toContainText("0 of 1 filled");
    await expect(page.getByLabel("LC14 Unknown Test result")).toBeVisible();
    await expect(lipid).toHaveAttribute("aria-expanded", "false");
    await expect(rft).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("3 tests · 0 values typed")).toBeVisible();
    await expect(lipid).toContainText("0 of 4 filled");
    await expect(page.getByLabel("Total Cholesterol result")).toHaveCount(0);

    await lipid.click();
    await page.getByLabel("Total Cholesterol result").fill("250");
    await expect(lipid).toContainText("1 of 4 filled");
    await expect(lipid).toContainText("1 abnormal");

    await rft.click();
    await expect(page.getByLabel("Creatinine, Serum result")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "More fields from RFT" })).toBeVisible();

    await page.getByRole("button", { name: "Close all" }).click();
    await expect(page.getByLabel("Total Cholesterol result")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Save 1 result/ })).toBeEnabled();
    await page.getByRole("button", { name: "Open all" }).click();
    await expect(page.getByLabel("Total Cholesterol result")).toHaveValue("250");
  });

  test("a number field ignores letters as they are typed, and the server refuses words", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await page.goto("/giniflow/station/lab/processing");
    await page.getByText(PATIENTS.general.name).first().click();
    const lipid = page.getByRole("button", { name: /^Lipid Profile \d/ });
    await lipid.click();
    const box = page.getByLabel("Triglycerides result");
    await box.pressSequentially("hghfjj");
    await expect(box).toHaveValue("");
    await box.pressSequentially("1a2.5b");
    await expect(box).toHaveValue("12.5");
    await box.fill("");
    await box.pressSequentially("123456789012");
    await expect(box).toHaveValue("1234");
    await box.fill("");
    await box.pressSequentially("1.2345");
    await expect(box).toHaveValue("1.23");
    await box.fill("");
    await box.pressSequentially("2000");
    await expect(box).toHaveValue("200");
    await expect(box.locator("xpath=..")).toContainText("HIGH");
    await box.fill("");
    await box.pressSequentially("-5");
    await expect(box).toHaveValue("5");
    await box.fill("");
    await box.pressSequentially("<0.1");
    await expect(box).toHaveValue("<0.1");
    await expect(box).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: /Save \d+ result/ })).toBeEnabled();

    const refused = saveResults(
      ids.order,
      {
        rows: [
          {
            testId: String(LAB_FIELDS.triglycerides.id),
            testName: "Triglycerides",
            value: "hghfjj",
          },
        ],
      },
      getPool(),
    );
    await expect(refused).rejects.toMatchObject({
      status: 400,
      message: "Triglycerides: enter a number, e.g. 12.5 or <0.1",
    });
  });

  test("a hand-typed range box takes number ranges only", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/giniflow/station/lab/processing");
    await page.getByText(PATIENTS.general.name).first().click();
    const unknown = page.getByRole("button", { name: /^LC14 Unknown Test \d/ });
    const range = page.getByLabel("LC14 Unknown Test reference range");
    await range.pressSequentially("gxzfbhncn");
    await expect(range).toHaveValue("");
    await range.pressSequentially("0.7 -");
    await expect(page.getByText("Like 0.7 - 1.3, <5 or >40")).toBeVisible();
    await page.getByLabel("LC14 Unknown Test result").fill("1");
    await expect(unknown).toContainText("1 to fix");
    await expect(page.getByRole("button", { name: "Fix 1 value before saving" })).toBeDisabled();
    await range.press("End");
    await range.pressSequentially(" 1.3");
    await expect(range).toHaveValue("0.7 - 1.3");
    await expect(page.getByText("Like 0.7 - 1.3, <5 or >40")).toHaveCount(0);
    await range.fill("");
    await range.pressSequentially("<5");
    await expect(range).toHaveValue("<5");
    await expect(page.getByRole("button", { name: /Save \d+ result/ })).toBeEnabled();
  });
});
