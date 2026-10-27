import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, loginCrm, resetCrm } from "../helpers/crm.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one } from "../helpers/db.mjs";
import { istDate, uploadWindow } from "../../server/crm/istPeriods.js";

const SHOTS = process.env.SHOT_DIR;

test.describe("CRM doctors: add, edit, remove and visit screens", () => {
  let users;
  let hospitalId;
  let rajesh;
  let virender;

  test.beforeEach(async () => {
    test.setTimeout(120_000);
    const seeded = await seedCrmStaff();
    users = seeded.users;
    hospitalId = seeded.hospitalId;
    rajesh = await crmApi(users.rajesh);
    virender = await crmApi(users.virender);
  });

  test.afterAll(resetCrm);

  test("1. A rep adds a doctor from home, edits it and sees the change in history", async ({
    page,
  }) => {
    await loginCrm(page, rajesh);
    await gotoReady(page, "/crm/home", () => page.getByRole("link", { name: "Add doctor" }));
    await page.getByRole("link", { name: "Add doctor" }).click();
    await expect(page.getByLabel("Assigned to")).toHaveCount(0);

    await page.getByRole("textbox", { name: "Name", exact: true }).fill("DR SUNIL KUMAR VERMA");
    await page.getByRole("combobox", { name: "Specialty", exact: true }).selectOption("RMP");
    await page.getByRole("textbox", { name: "Mobile", exact: true }).fill("+91 98222 00001");
    await page.getByRole("textbox", { name: "Area", exact: true }).fill("Balongi");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/doctor-add.png`, fullPage: true });
    await page.getByRole("button", { name: "Add doctor" }).click();

    await expect(page.getByText("Doctor added.")).toBeVisible();
    await expect(page.locator(".rep__bar-title strong")).toHaveText("Dr Sunil Kumar Verma");

    await page.getByRole("link", { name: "Edit details" }).click();
    await expect(page.getByRole("textbox", { name: "Mobile", exact: true })).toHaveValue(
      "9822200001",
    );
    await page.getByLabel("Address", { exact: true }).fill("SCO 5, Main Road");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Changes saved.")).toBeVisible();

    await page.getByText("Change history").click();
    await expect(page.locator(".dfm__changes")).toContainText("SCO 5, Main Road");
    await expect(page.locator(".dfm__changes")).toContainText("Rajesh Sharma");
  });

  test("2. The add form explains what is missing and blocks a bad mobile", async ({ page }) => {
    await loginCrm(page, rajesh);
    await gotoReady(page, "/crm/doctors/new", () =>
      page.getByRole("textbox", { name: "Name", exact: true }),
    );
    await page.getByRole("button", { name: "Add doctor" }).click();
    await expect(page.getByText(/Fix \d+ highlighted fields before saving./)).toBeVisible();
    await expect(page.getByText("Enter the doctor's name.")).toBeVisible();
    await expect(page.getByText("Enter the doctor's 10-digit mobile number.")).toBeVisible();
    await expect(page.getByText("Choose a specialty.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    await seedDoctors(hospitalId, [
      { full_name: "Dr Taken", mobile: "9822200002", area: "X", owner: users.sandeep.crmId },
    ]);
    await page.getByRole("textbox", { name: "Mobile", exact: true }).fill("9822200002");
    await page.getByRole("textbox", { name: "Area", exact: true }).click();
    await expect(page.getByText(/under another team member \(Sandeep Sangroy\)/)).toBeVisible();
  });

  test("3. Admin can assign while adding; rep asks for removal; admin approves from the tab", async ({
    page,
    browser,
  }) => {
    const [doc] = await seedDoctors(hospitalId, [
      {
        full_name: "Dr Remove Me",
        mobile: "9822200003",
        area: "Kharar",
        owner: users.rajesh.crmId,
      },
    ]);
    await loginCrm(page, rajesh);
    await gotoReady(page, `/crm/doctor/${doc.id}`, () =>
      page.getByRole("button", { name: "Ask to remove this doctor…" }),
    );
    await page.getByRole("button", { name: "Ask to remove this doctor…" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Send request" })).toBeDisabled();
    await dialog.getByLabel("Reason").selectOption("not_a_doctor");
    await dialog.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByText("Removal request sent to your admin.")).toBeVisible();
    await expect(page.locator(".d360__banner")).toContainText("Waiting for admin");
    await expect(page.getByRole("button", { name: "Cancel request" })).toBeVisible();

    const admin = await browser.newPage();
    await loginCrm(admin, virender);
    await gotoReady(admin, "/crm/doctors/new", () => admin.getByLabel("Assigned to"));
    await expect(admin.getByLabel("Assigned to")).toContainText("Sandeep Sangroy");

    await gotoReady(admin, "/crm/home", () => admin.getByText(/1 removal request waiting/));
    await admin.getByRole("button", { name: /Removal requests/ }).click();
    const row = admin.locator(".rmv__row").filter({ hasText: "Dr Remove Me" });
    await expect(row).toContainText("Not a doctor");
    await expect(row).toContainText("asked by Rajesh Sharma");
    if (SHOTS) await admin.screenshot({ path: `${SHOTS}/removal-requests.png`, fullPage: true });
    await row.getByRole("button", { name: "Approve" }).click();
    await admin.getByRole("dialog").getByRole("button", { name: "Approve and remove" }).click();
    await expect(admin.getByText("Dr Remove Me removed.")).toBeVisible();

    await admin.getByRole("button", { name: "Removed doctors" }).click();
    await expect(admin.locator(".rmv__row").filter({ hasText: "Dr Remove Me" })).toBeVisible();
    await admin.close();

    await page.reload();
    await expect(page.getByText("This doctor is not on your list.")).toBeVisible();
  });

  test("4. Visit form: Doctor unavailable on an earlier date, then edit and undo it", async ({
    page,
  }) => {
    const [doc] = await seedDoctors(hospitalId, [
      { full_name: "Dr Visit Ui", mobile: "9822200004", area: "Kharar", owner: users.rajesh.crmId },
    ]);
    const today = istDate();
    const from = uploadWindow().from;
    const day = from < today ? from : today;

    await loginCrm(page, rajesh);
    await gotoReady(page, `/crm/visit/${doc.id}`, () =>
      page.getByRole("button", { name: "Doctor unavailable" }),
    );
    await page.getByRole("button", { name: "Doctor unavailable" }).click();
    await expect(page.getByRole("button", { name: "Positive" })).toHaveCount(0);
    await page.getByLabel("Visit date").fill(day);
    await page.getByRole("button", { name: "Save visit" }).click();
    await expect(page).toHaveURL(/\/crm\/home/);

    await expect
      .poll(
        async () =>
          (
            await one(
              `SELECT count(*)::int AS n FROM crm.visits
                WHERE doctor_id = $1 AND deleted_at IS NULL AND outcome = 'doctor_unavailable'
                  AND (occurred_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
              [doc.id, day],
            )
          ).n,
        { timeout: 15000 },
      )
      .toBe(1);

    await gotoReady(page, `/crm/visit/${doc.id}`, () => page.getByLabel("Visit date"));
    await page.getByLabel("Visit date").fill(day);
    await expect(page.getByText(/Already logged/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save visit" })).toBeDisabled();

    await gotoReady(page, `/crm/doctor/${doc.id}`, () =>
      page.getByRole("button", { name: "Edit visit" }),
    );
    await page.getByRole("button", { name: "Edit visit" }).click();
    const edit = page.getByRole("dialog");
    await edit.getByLabel("Status").selectOption("completed");
    await edit.getByLabel("Outcome").selectOption("positive");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Visit updated.")).toBeVisible();
    await expect(page.locator(".d360__event--visit")).toContainText("Positive");

    await page.getByRole("button", { name: "Undo visit" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Undo visit" }).click();
    await expect(page.getByText("Visit undone.")).toBeVisible();
    await expect(page.locator(".d360__event--visit")).toHaveCount(0);
  });

  test("5. Phone width: add form and doctor page have no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const [doc] = await seedDoctors(hospitalId, [
      {
        full_name: "Dr Kiran Bedi Long Name Clinic Phase Seven Extension",
        mobile: "9822200005",
        area: "Sector 70 Mohali near the long market road",
        owner: users.rajesh.crmId,
      },
    ]);
    await loginCrm(page, rajesh);
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    await gotoReady(page, "/crm/doctors/new", () =>
      page.getByRole("textbox", { name: "Name", exact: true }),
    );
    expect(await overflow()).toBeLessThanOrEqual(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/doctor-add-phone.png`, fullPage: true });
    await gotoReady(page, `/crm/doctor/${doc.id}`, () =>
      page.getByRole("link", { name: "Edit details" }),
    );
    expect(await overflow()).toBeLessThanOrEqual(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/doctor-page-phone.png`, fullPage: true });
  });

  test("6. Each field is checked as you leave it; junk like digits for a name is refused", async ({
    page,
  }) => {
    await loginCrm(page, virender);
    await gotoReady(page, "/crm/doctors/new", () =>
      page.getByRole("textbox", { name: "Name", exact: true }),
    );
    const box = (name) => page.getByRole("textbox", { name, exact: true });
    const junk = [
      ["Name", "654767567", "Use letters only, like Dr Rajesh Khanna."],
      ["Qualifications", "47675657", "Start with letters, like MBBS, MD."],
      ["WhatsApp number", "457676767", "Enter a 10-digit WhatsApp number starting 6-9."],
      ["Email", "jhj55756747", "Enter an email like name@example.com."],
      ["Clinic name", "7676576756", "Enter the clinic's name, like Care Clinic."],
      ["Address", "475675577", "Enter a street address, like SCO 12, Main Market."],
      ["Area", "467756", "Enter the area in words, like Sector 70 or Sohana."],
      ["City", "6647", "Use letters only, like Mohali."],
    ];
    for (const [label, value, message] of junk) {
      await box(label).fill(value);
      await box(label).blur();
      await expect(page.getByText(message)).toBeVisible();
      await expect(box(label)).toHaveAttribute("aria-invalid", "true");
    }
    await box("PIN").fill("12ab3");
    await expect(box("PIN")).toHaveValue("123");
    await box("PIN").blur();
    await expect(page.getByText("Enter a 6-digit PIN code, like 160062.")).toBeVisible();

    await box("City").fill("Mohali");
    await expect(page.getByText("Use letters only, like Mohali.")).toHaveCount(0);

    for (const [width, height, name] of [
      [1280, 900, "desktop"],
      [820, 1100, "tablet"],
      [390, 844, "phone"],
    ]) {
      await page.setViewportSize({ width, height });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      if (SHOTS)
        await page.screenshot({ path: `${SHOTS}/doctor-errors-${name}.png`, fullPage: true });
    }

    await page.getByRole("button", { name: "Add doctor" }).click();
    await expect(page.getByText(/Fix \d+ highlighted fields before saving./)).toBeVisible();
    await expect(box("Name")).toBeFocused();
  });
});
