import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, loginCrm, resetCrm } from "../helpers/crm.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one } from "../helpers/db.mjs";

const json = async (res) => ({ status: res.status(), body: await res.json() });

test.describe("CRM referral form validation", () => {
  let rajesh;
  let doctorId;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const s = await seedCrmStaff();
    const [doc] = await seedDoctors(s.hospitalId, [
      { full_name: "Dr A Malhotra", area: "Phase 7", owner: s.users.rajesh.crmId },
    ]);
    doctorId = doc.id;
    rajesh = await crmApi(s.users.rajesh);
  });

  test.afterAll(resetCrm);

  const post = (data) =>
    rajesh
      .post("/api/crm/referrals", { data: { referring_doctor_id: doctorId, ...data } })
      .then(json);

  test("1. The API refuses bad values with a fixable message and no database error", async () => {
    const cases = [
      [{ patient_phone: "kfk" }, "Enter a 10-digit mobile number starting 6-9."],
      [{ patient_phone: "12345" }, "Enter a 10-digit mobile number starting 6-9."],
      [{ patient_name: "123" }, "Use letters only, like Ramesh Kumar."],
      [{}, "Enter the patient's name or mobile number."],
      [{ patient_name: "Ramesh", reason_category: "!!" }, "Describe it in words, like Chest pain."],
      [{ patient_name: "Ramesh", service_line_id: "x" }, "Choose a service from the list."],
      [{ patient_name: "Ramesh", urgency: "later" }, "Choose an urgency from the list."],
    ];
    for (const [data, message] of cases) {
      const { status, body } = await post(data);
      expect(status, JSON.stringify(data)).toBe(400);
      expect(body.error).toBe(message);
    }
    const bad = await rajesh
      .post("/api/crm/referrals", { data: { referring_doctor_id: "nope", patient_name: "Ramesh" } })
      .then(json);
    expect(bad.status).toBe(400);
  });

  test("2. A pasted +91 number is saved as 10 digits", async () => {
    const { status, body } = await post({
      patient_name: "  Ramesh   Kumar ",
      patient_phone: "+91 98765 43210",
    });
    expect(status).toBe(200);
    const row = await one(
      "SELECT patient_name_raw, patient_phone_raw FROM crm.doctor_referrals WHERE id = $1",
      [body.id],
    );
    expect(row).toEqual({ patient_name_raw: "Ramesh Kumar", patient_phone_raw: "9876543210" });
  });

  test("3. The form shows field errors, keeps digits only, and saves once fixed", async ({
    page,
  }) => {
    await loginCrm(page, rajesh);
    await gotoReady(page, `/crm/referral/${doctorId}?name=A%20MALHOTRA`, () =>
      page.getByRole("button", { name: "Log referral" }),
    );

    const mobile = page.getByRole("textbox", { name: "Mobile" });
    await mobile.fill("kfk98");
    await expect(mobile).toHaveValue("98");
    await page.getByRole("button", { name: "Log referral" }).click();
    await expect(page.getByText("Enter a 10-digit mobile number starting 6-9.")).toBeVisible();
    await expect(page.getByText("Fix 1 highlighted field before saving.")).toBeVisible();
    await expect(mobile).toBeFocused();
    await expect(mobile).toHaveAttribute("aria-invalid", "true");

    await mobile.fill("");
    await page.getByRole("button", { name: "Log referral" }).click();
    await expect(page.getByText("Enter the patient's name or mobile number.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();

    await page.getByRole("textbox", { name: "Name" }).fill("Sunita Devi");
    await expect(page.getByText("Enter the patient's name or mobile number.")).toHaveCount(0);
    await mobile.fill("9812345678");
    await page.getByRole("button", { name: "Urgent" }).click();
    await page.getByRole("button", { name: "Log referral" }).click();
    await expect(page).toHaveURL(/\/crm\/home\?referral=/);
  });
});
