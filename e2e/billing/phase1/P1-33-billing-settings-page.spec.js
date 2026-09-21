import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { financialYearOf } from "../../../shared/billingVocab.js";

const tag = crypto.randomBytes(3).toString("hex");
const TAX = `P133_${tag}`;
const GSTIN = "27AAPFU0939F1ZV";
const saved = {};

const card = (page, name) => page.getByRole("form", { name, exact: true });
const section = (page, name) => page.getByRole("region", { name, exact: true });

async function openSettings(page) {
  await loginAs(page, "admin");
  await gotoReady(page, "/settings/billing", () => card(page, "Bills"));
}

test.describe.serial("P1-33 billing settings page", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    saved.settings = await one(`SELECT * FROM billing_settings`);
    saved.series = (await query(`SELECT * FROM bill_series`)).rows;
    await query(`DELETE FROM bill_series`);
    await query(
      `UPDATE billing_settings SET discount_stacking = 'best_only', allow_pay_later = FALSE,
              max_codes_per_bill = NULL, gst_enabled = FALSE, gstin = NULL, state_code = NULL,
              legal_name = NULL, bill_footer = NULL`,
    );
    saved.fy = financialYearOf(
      (await one(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d,
    );
  });

  test.afterAll(async () => {
    const s = saved.settings;
    if (s) {
      await query(
        `UPDATE billing_settings SET discount_stacking = $1, allow_pay_later = $2,
                max_codes_per_bill = $3, gst_enabled = $4, gstin = $5, state_code = $6,
                legal_name = $7, bill_footer = $8`,
        [
          s.discount_stacking,
          s.allow_pay_later,
          s.max_codes_per_bill,
          s.gst_enabled,
          s.gstin,
          s.state_code,
          s.legal_name,
          s.bill_footer,
        ],
      );
    }
    await query(`DELETE FROM bill_series`);
    for (const r of saved.series ?? []) {
      await query(
        `INSERT INTO bill_series (series, fy, prefix, number_width, next_no) VALUES ($1, $2, $3, $4, $5)`,
        [r.series, r.fy, r.prefix, r.number_width, r.next_no],
      );
    }
    await query(
      `UPDATE service_items SET tax_code_id = NULL WHERE tax_code_id IN
                   (SELECT id FROM tax_codes WHERE code LIKE $1)`,
      [`P133_%${tag}%`],
    );
    await query(`DELETE FROM tax_codes WHERE code LIKE $1`, [`P133_%${tag}%`]);
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
         (SELECT id FROM service_items WHERE code LIKE $1)`,
      [`P133%${tag}`],
    );
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P133%${tag}`]);
    await query(`DELETE FROM service_subgroups WHERE code LIKE $1`, [`P133%${tag}`]);
    await query(`DELETE FROM service_groups WHERE code LIKE $1`, [`P133%${tag}`]);
  });

  test("1. the bill settings save and are still there after a reload", async ({ page }) => {
    await openSettings(page);
    const bills = card(page, "Bills");
    await bills
      .getByLabel("When several discounts apply", { exact: true })
      .selectOption("per_rule");
    await bills.getByLabel("Most codes on one bill", { exact: true }).fill("5");
    await bills.getByLabel(/Allow pay later/).check();
    await bills.getByLabel("Bill footer", { exact: true }).fill(`Thank you ${tag}`);
    await bills.getByRole("button", { name: "Save", exact: true }).click();
    await expect(bills.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect
      .poll(() =>
        one(
          `SELECT discount_stacking, max_codes_per_bill, allow_pay_later, bill_footer FROM billing_settings`,
        ),
      )
      .toEqual({
        discount_stacking: "per_rule",
        max_codes_per_bill: 5,
        allow_pay_later: true,
        bill_footer: `Thank you ${tag}`,
      });

    await page.reload();
    const again = card(page, "Bills");
    await expect(again.getByLabel("When several discounts apply", { exact: true })).toHaveValue(
      "per_rule",
    );
    await expect(again.getByLabel("Most codes on one bill", { exact: true })).toHaveValue("5");
    await expect(again.getByLabel(/Allow pay later/)).toBeChecked();
    await expect(again.getByLabel("Bill footer", { exact: true })).toHaveValue(`Thank you ${tag}`);
    await expect(again.getByRole("link", { name: "Prescription settings" })).toHaveAttribute(
      "href",
      "/settings/prescription",
    );
  });

  test("1b. saving one field never undoes a change someone else made meanwhile", async ({
    page,
  }) => {
    await openSettings(page);
    const bills = card(page, "Bills");
    await expect(bills.getByLabel("Bill footer", { exact: true })).toHaveValue(`Thank you ${tag}`);
    await bills.getByLabel("Most codes on one bill", { exact: true }).fill("9");

    const other = await apiAs("admin");
    expect(
      (
        await other.patch("/api/billing/settings", { data: { bill_footer: `Other admin ${tag}` } })
      ).status(),
    ).toBe(200);
    await other.dispose();

    const gst = card(page, "GST");
    await gst.getByLabel("Legal name", { exact: true }).fill(`Refresh ${tag}`);
    await gst.getByRole("button", { name: "Save", exact: true }).click();
    await expect(gst.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

    await bills.getByRole("button", { name: "Save", exact: true }).click();
    await expect(bills.getByLabel("Bill footer", { exact: true })).toHaveValue(
      `Other admin ${tag}`,
    );
    expect(await one(`SELECT max_codes_per_bill, bill_footer FROM billing_settings`)).toEqual({
      max_codes_per_bill: 9,
      bill_footer: `Other admin ${tag}`,
    });
    await query(`UPDATE billing_settings SET legal_name = NULL`);
  });

  test("1c. the boxes stop at the same lengths the server allows", async ({ page }) => {
    await openSettings(page);
    await expect(card(page, "Bills").getByLabel("Bill footer", { exact: true })).toHaveAttribute(
      "maxlength",
      "1000",
    );
    await expect(card(page, "GST").getByLabel("GSTIN", { exact: true })).toHaveAttribute(
      "maxlength",
      "15",
    );
    await expect(card(page, "GST").getByLabel("Legal name", { exact: true })).toHaveAttribute(
      "maxlength",
      "200",
    );
    await expect(
      section(page, "Number series").getByLabel("Bills prefix", { exact: true }),
    ).toHaveAttribute("maxlength", "30");
  });

  test("1d. review: number boxes take digits only, GSTIN and prefix drop spaces", async ({
    page,
  }) => {
    await openSettings(page);
    const most = card(page, "Bills").getByLabel("Most codes on one bill", { exact: true });
    await most.fill("");
    await most.pressSequentially("1x5.");
    await expect(most).toHaveValue("15");
    const gst = card(page, "GST");
    const gstin = gst.getByLabel("GSTIN", { exact: true });
    await gstin.fill("");
    await gstin.pressSequentially("27 aapfu");
    await expect(gstin).toHaveValue("27AAPFU");
    const state = gst.getByLabel("State code", { exact: true });
    await state.fill("");
    await state.pressSequentially("a2b7");
    await expect(state).toHaveValue("27");
    const series = section(page, "Number series");
    const prefix = series.getByLabel("Bills prefix", { exact: true });
    await prefix.fill("");
    await prefix.pressSequentially("GH / 26");
    await expect(prefix).toHaveValue("GH/26");
    const digits = series.getByLabel("Bills digits", { exact: true });
    await digits.fill("");
    await digits.pressSequentially("x5");
    await expect(digits).toHaveValue("5");
    await expect(digits).toHaveAttribute("maxlength", "2");
    const next = series.getByLabel("Bills next number", { exact: true });
    await next.fill("");
    await next.pressSequentially("4a1");
    await expect(next).toHaveValue("41");
    await expect(next).toHaveAttribute("maxlength", "12");
  });

  test("2. GST switches on with its details, and the state code comes from the GSTIN", async ({
    page,
  }) => {
    await openSettings(page);
    const gst = card(page, "GST");
    await gst.getByLabel("Charge GST on bills", { exact: true }).check();
    await gst.getByRole("button", { name: "Save", exact: true }).click();
    await expect(gst.getByRole("alert")).toContainText("GST can't be switched on");

    await gst.getByLabel("GSTIN", { exact: true }).fill(GSTIN.slice(0, 14) + "X");
    await gst.getByLabel("Legal name", { exact: true }).fill(`Gini Hospital ${tag}`);
    await gst.getByRole("button", { name: "Save", exact: true }).click();
    await expect(gst.getByRole("alert")).toContainText("last character");

    await gst.getByLabel("GSTIN", { exact: true }).fill(GSTIN.toLowerCase());
    await gst.getByRole("button", { name: "Save", exact: true }).click();
    await expect(gst.getByLabel("State code", { exact: true })).toHaveValue("27");
    await expect(gst.getByLabel("GSTIN", { exact: true })).toHaveValue(GSTIN);
    await expect(gst.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

    await page.reload();
    const again = card(page, "GST");
    await expect(again.getByLabel("Charge GST on bills", { exact: true })).toBeChecked();
    await expect(again.getByLabel("GSTIN", { exact: true })).toHaveValue(GSTIN);
    await expect(again.getByLabel("State code", { exact: true })).toHaveValue("27");
    await expect(again.getByLabel("Legal name", { exact: true })).toHaveValue(
      `Gini Hospital ${tag}`,
    );

    await again.getByLabel("Legal name", { exact: true }).fill("");
    await again.getByRole("button", { name: "Save", exact: true }).click();
    await expect(again.getByRole("alert")).toContainText("can't be cleared");
  });

  test("3. tax codes are added, edited, switched off and deleted", async ({ page }) => {
    await openSettings(page);
    const taxes = section(page, "Tax codes");
    const add = taxes.getByRole("form", { name: "Add tax code" });
    await add.getByLabel("Code", { exact: true }).fill(TAX);
    await add.getByLabel("Rate %", { exact: true }).fill("18");
    await add.getByRole("button", { name: "+ Add tax code", exact: true }).click();
    const row = taxes.getByRole("row", { name: new RegExp(TAX) });
    await expect(row).toContainText("18%");

    await taxes.getByRole("button", { name: `Edit ${TAX}`, exact: true }).click();
    await taxes.getByLabel(`Rate % for ${TAX}`, { exact: true }).fill("12.5");
    await taxes.getByLabel(`SAC/HSN for ${TAX}`, { exact: true }).fill("999312");
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row).toContainText("12.5%");
    await expect(row).toContainText("999312");

    await taxes.getByRole("button", { name: `Deactivate ${TAX}`, exact: true }).click();
    await expect(taxes.getByRole("button", { name: `Activate ${TAX}`, exact: true })).toBeVisible();

    await page.reload();
    const after = section(page, "Tax codes").getByRole("row", { name: new RegExp(TAX) });
    await expect(after).toContainText("12.5%");
    await expect(after).toContainText("999312");

    await section(page, "Tax codes")
      .getByRole("button", { name: `Delete ${TAX}`, exact: true })
      .click();
    await section(page, "Tax codes")
      .getByRole("button", { name: `Confirm delete ${TAX}`, exact: true })
      .click();
    await expect(after).toHaveCount(0);
  });

  test("3b. a tax code is added with its SAC/HSN; a bad rate is refused in the form", async ({
    page,
  }) => {
    await openSettings(page);
    const taxes = section(page, "Tax codes");
    const add = taxes.getByRole("form", { name: "Add tax code" });
    const code = `P133_sac_${tag}`;
    await add.getByLabel("Code", { exact: true }).fill(code);
    await add.getByLabel("SAC/HSN", { exact: true }).fill("999311");
    await add.getByLabel("Rate %", { exact: true }).fill("120");
    await add.getByRole("button", { name: "+ Add tax code", exact: true }).click();
    await expect(add.getByRole("alert")).toBeVisible();
    await expect(add.getByLabel("Code", { exact: true })).toHaveValue(code);
    await add.getByLabel("Rate %", { exact: true }).fill("5");
    await add.getByRole("button", { name: "+ Add tax code", exact: true }).click();
    const row = taxes.getByRole("row", { name: new RegExp(code) });
    await expect(row).toContainText("999311");
    await expect(row).toContainText("5%");
    await expect(add.getByLabel("Code", { exact: true })).toHaveValue("");
  });

  test("3c. a delete can be taken back before it is confirmed", async ({ page }) => {
    await openSettings(page);
    const taxes = section(page, "Tax codes");
    const code = `P133_sac_${tag}`;
    await taxes.getByRole("button", { name: `Delete ${code}`, exact: true }).click();
    await taxes
      .getByRole("row", { name: new RegExp(code) })
      .getByRole("button", { name: "Keep", exact: true })
      .click();
    await expect(taxes.getByRole("button", { name: `Delete ${code}`, exact: true })).toBeVisible();
    await expect(
      taxes.getByRole("button", { name: `Confirm delete ${code}`, exact: true }),
    ).toHaveCount(0);
  });

  test("3d. review: tax code boxes filter as typed and an edit error shows in its row", async ({
    page,
  }) => {
    await openSettings(page);
    const taxes = section(page, "Tax codes");
    const add = taxes.getByRole("form", { name: "Add tax code" });
    const code = `P133_R_${tag}`;
    await add.getByLabel("Code", { exact: true }).pressSequentially(`P133 _R_${tag}`);
    await expect(add.getByLabel("Code", { exact: true })).toHaveValue(code);
    await add.getByLabel("SAC/HSN", { exact: true }).pressSequentially("99a93-11");
    await expect(add.getByLabel("SAC/HSN", { exact: true })).toHaveValue("999311");
    await add.getByLabel("Rate %", { exact: true }).pressSequentially("1a8.555%");
    await expect(add.getByLabel("Rate %", { exact: true })).toHaveValue("18.55");
    await add.getByRole("button", { name: "+ Add tax code", exact: true }).click();
    const row = taxes.getByRole("row", { name: new RegExp(code) });
    await expect(row).toContainText("18.55%");

    await taxes.getByRole("button", { name: `Edit ${code}`, exact: true }).click();
    const sac = taxes.getByLabel(`SAC/HSN for ${code}`, { exact: true });
    await sac.fill("");
    await sac.pressSequentially("12x345");
    await expect(sac).toHaveValue("12345");
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row.getByRole("alert")).toHaveText("SAC/HSN must be 4, 6 or 8 digits");
    await taxes.getByLabel(`Rate % for ${code}`, { exact: true }).fill("");
    await expect(row.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row.getByRole("alert")).toHaveCount(0);
  });

  test("4. a tax code used by an item can't be deleted and says where", async ({ page }) => {
    const code = `P133_used_${tag}`;
    const admin = await apiAs("admin");
    const tax = await (
      await admin.post("/api/billing/settings/tax-codes", { data: { code, rate_pct: 5 } })
    ).json();
    const group = await (
      await admin.post("/api/billing/master/groups", {
        data: { code: `P133G_${tag}`, name: `P133 Group ${tag}` },
      })
    ).json();
    const sub = await (
      await admin.post("/api/billing/master/subgroups", {
        data: { group_id: group.id, code: `P133S_${tag}`, name: `P133 Sub ${tag}` },
      })
    ).json();
    const item = await admin.post("/api/billing/master/items", {
      data: {
        code: `P133I_${tag}`,
        name: `P133 Item ${tag}`,
        subgroup_id: sub.id,
        base_price: 100,
        kind: "other",
        tax_code_id: tax.id,
      },
    });
    expect(item.status()).toBe(201);
    await admin.dispose();

    await openSettings(page);
    const taxes = section(page, "Tax codes");
    await taxes.getByRole("button", { name: `Delete ${code}`, exact: true }).click();
    await taxes.getByRole("button", { name: `Confirm delete ${code}`, exact: true }).click();
    const blocked = page.getByRole("dialog", { name: `${code} can't be deleted` });
    await expect(blocked.getByRole("list", { name: "Used in" })).toContainText("item");
    await blocked.getByRole("button", { name: "Close", exact: true }).click();
  });

  test("5. the number series are set up, and the next number only goes up", async ({ page }) => {
    await openSettings(page);
    const series = section(page, "Number series");
    const table = series.getByRole("table", { name: `Number series ${saved.fy}` });
    const bills = table.getByRole("row", { name: /^Bills/ });
    await expect(bills).toContainText("Not set up yet");
    await table.getByLabel("Bills prefix", { exact: true }).fill(`GH/${tag}/`);
    await table.getByLabel("Bills digits", { exact: true }).fill("5");
    await table.getByLabel("Bills next number", { exact: true }).fill("41");
    await expect(bills).toContainText(`GH/${tag}/00041`);
    await table.getByRole("button", { name: "Save Bills series", exact: true }).click();
    await expect(bills).not.toContainText("Not set up yet");
    await table.getByLabel("Receipts prefix", { exact: true }).fill(`RC/${tag}/`);
    await table.getByRole("button", { name: "Save Receipts series", exact: true }).click();
    await expect(table.getByRole("row", { name: /^Receipts/ })).not.toContainText("Not set up yet");

    await page.reload();
    const again = section(page, "Number series").getByRole("table", {
      name: `Number series ${saved.fy}`,
    });
    await expect(again.getByLabel("Bills prefix", { exact: true })).toHaveValue(`GH/${tag}/`);
    await expect(again.getByLabel("Bills digits", { exact: true })).toHaveValue("5");
    await expect(again.getByLabel("Bills next number", { exact: true })).toHaveValue("41");
    await expect(again.getByLabel("Receipts prefix", { exact: true })).toHaveValue(`RC/${tag}/`);

    await again.getByLabel("Bills next number", { exact: true }).fill("7");
    await again.getByRole("button", { name: "Save Bills series", exact: true }).click();
    await expect(again.getByRole("row", { name: /^Bills/ }).getByRole("alert")).toContainText(
      "can only go up",
    );
    const rows = await query(
      `SELECT series, fy, prefix, number_width, next_no::int FROM bill_series ORDER BY series`,
    );
    expect(rows.rows).toEqual([
      { series: "MAIN", fy: saved.fy, prefix: `GH/${tag}/`, number_width: 5, next_no: 41 },
      { series: "RCPT", fy: saved.fy, prefix: `RC/${tag}/`, number_width: 6, next_no: 1 },
    ]);
  });

  test("6. next year's series can be set up ahead of April", async ({ page }) => {
    await openSettings(page);
    const series = section(page, "Number series");
    const start = Number(saved.fy.slice(0, 4)) + 1;
    const next = `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
    await series.getByLabel("Financial year", { exact: true }).selectOption(next);
    const table = series.getByRole("table", { name: `Number series ${next}` });
    await expect(table.getByRole("row", { name: /^Bills/ })).toContainText("Not set up yet");
    await table.getByLabel("Bills prefix", { exact: true }).fill(`NX/${tag}/`);
    await table.getByRole("button", { name: "Save Bills series", exact: true }).click();
    await expect
      .poll(async () => (await query(`SELECT prefix FROM bill_series WHERE fy = $1`, [next])).rows)
      .toEqual([{ prefix: `NX/${tag}/` }]);
  });

  test("7. reception_admin can't open billing settings", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/settings/billing", () => page.locator(".tabs"));
    await expect(page).not.toHaveURL(/\/settings\/billing/);
  });
});
