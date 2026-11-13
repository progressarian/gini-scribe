import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { getPool, query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import {
  LAB_FIELDS,
  LAB_REPORTS,
  removeLabCatalog,
  seedLabCatalog,
} from "../fixtures/labCatalog.mjs";
import { formulaFromText } from "../../server/services/labCatalog/formulaFromText.js";

const [LIPID] = LAB_REPORTS;
const F = LAB_FIELDS;
const ids = {};

const fakeAi = (answer) => {
  const asked = [];
  return {
    asked,
    messages: {
      parse: async (request) => {
        asked.push(request);
        return { stop_reason: "end_turn", parsed_output: answer };
      },
    },
  };
};

test.describe.serial("LC11 formula builder guards and formula from words", () => {
  test.beforeAll(async () => {
    await seedLabCatalog(query);
    ids.lipid = (
      await query(`SELECT id FROM giniflow_test_catalog WHERE test_name = 'Lipid Profile'`)
    ).rows[0].id;
  });
  test.afterAll(() => removeLabCatalog(query));

  test("1. words become a checked formula; the AI only sees this report's number fields", async () => {
    const ai = fakeAi({ formula: `#${F.triglycerides.id} / #${F.hdl.id}`, problem: "" });
    const result = await formulaFromText(
      LIPID.id,
      { text: "triglycerides divided by HDL" },
      getPool(),
      ai,
    );
    expect(result).toMatchObject({
      formula: `#${F.triglycerides.id} / #${F.hdl.id}`,
      readsAs: "Triglycerides ÷ HDL Cholesterol",
    });
    const prompt = ai.asked[0].messages[0].content;
    expect(prompt).toContain(`#${F.hdl.id}  HDL Cholesterol (mg/dl)`);
    expect(prompt).not.toContain(String(F.creatinine.id));
    expect(prompt).toContain("triglycerides divided by HDL");
  });

  test("2. an AI answer that breaks the rules is refused, and its own reason is passed on", async () => {
    const foreign = formulaFromText(
      LIPID.id,
      { text: "creatinine times 2" },
      getPool(),
      fakeAi({ formula: `#${F.creatinine.id} * 2`, problem: "" }),
    );
    await expect(foreign).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("Creatinine, Serum is not in this report"),
    });

    const broken = formulaFromText(
      LIPID.id,
      { text: "HDL plus" },
      getPool(),
      fakeAi({ formula: `#${F.hdl.id} +`, problem: "" }),
    );
    await expect(broken).rejects.toMatchObject({ status: 422 });

    const unclear = formulaFromText(
      LIPID.id,
      { text: "something about vitamin D" },
      getPool(),
      fakeAi({ formula: "", problem: "Vitamin D is not a field of this report." }),
    );
    await expect(unclear).rejects.toMatchObject({
      status: 422,
      message: "Vitamin D is not a field of this report.",
    });

    const self = formulaFromText(
      LIPID.id,
      { text: "VLDL times 2", fieldId: F.vldl.id },
      getPool(),
      fakeAi({ formula: `#${F.vldl.id} * 2`, problem: "" }),
    );
    await expect(self).rejects.toMatchObject({ status: 422 });
  });

  test("3. without an AI key the server says so instead of failing", async () => {
    const api = await apiAs("lab_admin");
    const response = await api.post(`/api/lab-catalog/reports/${LIPID.id}/formula-from-text`, {
      data: { text: "triglycerides divided by 5" },
    });
    expect(response.status()).toBe(503);
    expect((await response.json()).error).toMatch(/AI is not set up/);
  });

  test("4. on screen: only buttons that can come next are enabled", async ({ page }) => {
    await loginAs(page, "lab_admin");
    await gotoReady(page, `/settings/tests/${ids.lipid}`, () =>
      page.getByRole("heading", { level: 2, name: "Lipid Profile", exact: true }),
    );
    const add = page.getByRole("form", { name: "Add a field to LIPID PROFILE" });
    await add.getByLabel("Type").selectOption("calculated");
    const button = (name) => add.getByRole("button", { name, exact: true });
    const picker = add.getByLabel("Field", { exact: true });

    await expect(button("Insert times")).toBeDisabled();
    await expect(button("Insert close bracket")).toBeDisabled();
    await expect(button("Insert minus")).toBeDisabled();
    await expect(add.getByText("Start with a field")).toBeVisible();

    await add.getByLabel(/Uses the patient's age, sex or weight/).check();
    await picker.selectOption({ label: "Triglycerides" });
    await expect(picker).toBeDisabled();
    await expect(button("Insert the patient's age (years)")).toBeDisabled();
    await expect(button("Insert times")).toBeEnabled();
    await expect(button("Insert comma")).toBeDisabled();

    await button("Insert times").click();
    await expect(button("Insert divided by")).toBeDisabled();
    await button("Insert larger of two values").click();
    await expect(add.getByText("1 bracket still open")).toBeVisible();
    await picker.selectOption({ label: "HDL Cholesterol" });
    await expect(button("Insert close bracket")).toBeDisabled();
    await expect(button("Insert comma")).toBeEnabled();
    await button("Insert comma").click();
    await add.getByLabel("Number", { exact: true }).fill("40");
    await button("Insert number").click();
    await expect(button("Insert comma")).toBeDisabled();
    await expect(button("Insert close bracket")).toBeEnabled();
    await button("Insert close bracket").click();
    await expect(add.getByText("Reads as:")).toContainText(
      "Triglycerides × max(HDL Cholesterol, 40)",
    );
    await button("Insert to the power of").click();
    await expect(add.getByText("Not finished yet")).toBeVisible();
    await add.getByLabel("Number", { exact: true }).fill("-1.2");
    await button("Insert number").click();
    await expect(add.getByText("Reads as:")).toContainText(
      "Triglycerides × max(HDL Cholesterol, 40) ^ − 1.2",
    );
  });

  test("5. on screen: the words box reports a missing AI plainly", async ({ page }) => {
    await loginAs(page, "lab_admin");
    await gotoReady(page, `/settings/tests/${ids.lipid}`, () =>
      page.getByRole("heading", { level: 2, name: "Lipid Profile", exact: true }),
    );
    const add = page.getByRole("form", { name: "Add a field to LIPID PROFILE" });
    await add.getByLabel("Type").selectOption("calculated");
    await add.getByLabel(/Write it in words/).fill("triglycerides divided by 5");
    await add.getByRole("button", { name: "Make formula" }).click();
    await expect(add.getByRole("alert")).toContainText("AI is not set up");
  });
});
