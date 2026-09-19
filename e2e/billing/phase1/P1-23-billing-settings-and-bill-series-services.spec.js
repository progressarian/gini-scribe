import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { query } from "../../helpers/db.mjs";
import { getPool } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const settings = await import("../../../server/services/billing/billingSettings.js");
const series = await import("../../../server/services/billing/billSeries.js");

const db = getPool();
const ctx = { actorId: USERS.admin.id, ip: "10.7.7.7" };
const tag = crypto.randomBytes(2).toString("hex").toUpperCase();
const failure = (promise) => promise.then(() => null).catch((e) => e);
const VALID_GSTIN = "27AAPFU0939F1ZV";
const OTHER_VALID = "29AAGCB7383J1Z4";

const refused = async (promise, status, message, label) => {
  const error = await failure(promise);
  expect(error?.status, label).toBe(status);
  if (message) expect(error.message, label).toMatch(message);
  return error;
};

const resetSettings = () =>
  query(
    `UPDATE billing_settings SET discount_stacking = 'best_only', allow_pay_later = FALSE,
            max_codes_per_bill = NULL, gst_enabled = FALSE, gstin = NULL, state_code = NULL,
            legal_name = NULL, bill_footer = NULL`,
  );

test.describe.serial("P1-23 billing settings and bill series services", () => {
  test.beforeAll(resetSettings);
  test.afterAll(resetSettings);

  test("1. settings start with the safe defaults", async () => {
    expect(await settings.getSettings(db)).toMatchObject({
      discount_stacking: "best_only",
      allow_pay_later: false,
      max_codes_per_bill: null,
      gst_enabled: false,
      gstin: null,
    });
  });

  test("2. settings save, reload and are audited", async () => {
    const saved = await settings.updateSettings(
      {
        discount_stacking: "per_rule",
        allow_pay_later: true,
        max_codes_per_bill: "2",
        bill_footer: "  Thank you  ",
      },
      ctx,
      db,
    );
    expect(saved).toMatchObject({
      discount_stacking: "per_rule",
      allow_pay_later: true,
      max_codes_per_bill: 2,
      bill_footer: "Thank you",
      updated_by: ctx.actorId,
    });
    expect(await settings.getSettings(db)).toMatchObject({
      discount_stacking: "per_rule",
      max_codes_per_bill: 2,
    });
    const audit = await query(
      `SELECT action, before, after, actor_id FROM billing_audit WHERE entity = 'billing_settings' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]).toMatchObject({ action: "update", actor_id: ctx.actorId });
    expect(audit.rows[0].before.discount_stacking).toBe("best_only");
    expect(audit.rows[0].after.discount_stacking).toBe("per_rule");
    await settings.updateSettings({ max_codes_per_bill: "" }, ctx, db);
    expect((await settings.getSettings(db)).max_codes_per_bill, "blank means no limit").toBeNull();
  });

  test("3. a GSTIN must have the right shape and the right check character", async () => {
    expect(settings.gstinCheckCharacter(VALID_GSTIN.slice(0, 14))).toBe("V");
    expect(settings.gstinCheckCharacter(OTHER_VALID.slice(0, 14))).toBe("4");
    const saved = await settings.updateSettings({ gstin: VALID_GSTIN.toLowerCase() }, ctx, db);
    expect(saved).toMatchObject({ gstin: VALID_GSTIN, state_code: "27" });
    await refused(
      settings.updateSettings({ gstin: "27AAPFU0939F1ZX" }, ctx, db),
      400,
      /last character doesn't match/,
    );
    await refused(
      settings.updateSettings({ gstin: "27AAPFU0939F1Z" }, ctx, db),
      400,
      /must be 15 characters/,
    );
    await refused(settings.updateSettings({ gstin: 27 }, ctx, db), 400, /must be text/);
    await refused(
      settings.updateSettings({ gstin: OTHER_VALID }, ctx, db),
      400,
      /starts with 29, but the state code is 27/,
    );
    const moved = await settings.updateSettings({ gstin: OTHER_VALID, state_code: "29" }, ctx, db);
    expect(moved).toMatchObject({ gstin: OTHER_VALID, state_code: "29" });
  });

  test("4. GST can only be switched on with the GSTIN, state code and legal name", async () => {
    await refused(
      settings.updateSettings({ gst_enabled: true }, ctx, db),
      409,
      /until the legal name is filled in/,
    );
    await settings.updateSettings({ gstin: null, state_code: null }, ctx, db);
    await refused(
      settings.updateSettings({ gst_enabled: true }, ctx, db),
      409,
      /until the GSTIN, state code, legal name are filled in/,
    );
    const on = await settings.updateSettings(
      { gst_enabled: true, gstin: VALID_GSTIN, legal_name: "Gini Health Pvt Ltd" },
      ctx,
      db,
    );
    expect(on).toMatchObject({
      gst_enabled: true,
      gstin: VALID_GSTIN,
      state_code: "27",
      legal_name: "Gini Health Pvt Ltd",
    });
    await refused(
      settings.updateSettings({ gstin: "" }, ctx, db),
      409,
      /GST is switched on, so the GSTIN can't be cleared; switch GST off first/,
    );
    const off = await settings.updateSettings({ gst_enabled: false }, ctx, db);
    expect(off.gst_enabled).toBe(false);
  });

  test("5. setting values are strictly checked", async () => {
    const cases = [
      [{ allow_pay_later: "true" }, /must be true or false/],
      [{ gst_enabled: 1 }, /must be true or false/],
      [{ max_codes_per_bill: 0 }, /1 or more/],
      [{ max_codes_per_bill: true }, /whole number/],
      [{ discount_stacking: "stack_everything" }, /must be one of: best_only, per_rule/],
      [{ bill_footer: "x".repeat(1001) }, /at most 1000/],
      [{ legal_name: 5 }, /must be text/],
      [{ state_code: "3" }, /2 digits/],
      [{}, /Nothing to change/],
    ];
    for (const [patch, message] of cases) {
      await refused(
        settings.updateSettings(patch, ctx, db),
        400,
        message,
        JSON.stringify(patch).slice(0, 60),
      );
    }
  });

  test("6. a bill series is created with its prefix and shows the next number", async () => {
    const main = await series.saveSeries(
      { series: `main${tag}`, fy: "2026-27", prefix: "GAC/26-27/" },
      ctx,
      db,
    );
    expect(main).toMatchObject({
      series: `MAIN${tag}`,
      fy: "2026-27",
      prefix: "GAC/26-27/",
      number_width: 6,
      next_no: 1,
      next_number: "GAC/26-27/000001",
    });
    const again = await series.saveSeries(
      { series: `Main${tag}`, fy: "2026-27", prefix: "GAC/2627/" },
      ctx,
      db,
    );
    expect(again.prefix, "the same series in another case updates it").toBe("GAC/2627/");
    const receipt = await series.saveSeries(
      { series: `RCPT${tag}`, fy: "2026-27", prefix: "R/", number_width: 4 },
      ctx,
      db,
    );
    expect(receipt.next_number).toBe("R/0001");
    const list = (await series.listSeries(db)).filter((s) => s.series.endsWith(tag));
    expect(list.map((s) => s.series)).toEqual([`MAIN${tag}`, `RCPT${tag}`]);
    const audit = await query(
      `SELECT action FROM billing_audit WHERE entity = 'bill_series' AND entity_id = $1 ORDER BY id`,
      [`MAIN${tag}:2026-27`],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["create", "update"]);
  });

  test("7. the next number can only go up, and must fit its width", async () => {
    const raised = await series.saveSeries(
      { series: `MAIN${tag}`, fy: "2026-27", next_no: 14413 },
      ctx,
      db,
    );
    expect(raised).toMatchObject({ next_no: 14413, next_number: "GAC/2627/014413" });
    await refused(
      series.saveSeries({ series: `MAIN${tag}`, fy: "2026-27", next_no: 100 }, ctx, db),
      409,
      /can only go up \(it is 14413\)/,
    );
    await refused(
      series.saveSeries({ series: `RCPT${tag}`, fy: "2026-27", next_no: 10000 }, ctx, db),
      400,
      /doesn't fit in 4 digits/,
    );
    const wider = await series.saveSeries(
      { series: `RCPT${tag}`, fy: "2026-27", number_width: 5, next_no: 10000 },
      ctx,
      db,
    );
    expect(wider.next_number).toBe("R/10000");
    await refused(
      series.saveSeries({ series: `MAIN${tag}`, fy: "2026-27" }, ctx, db),
      400,
      /Nothing to change/,
    );
  });

  test("8. bad series input is refused", async () => {
    const cases = [
      [{ series: "", fy: "2026-27" }, /blank or contain spaces/],
      [{ series: "MA IN", fy: "2026-27" }, /blank or contain spaces/],
      [{ series: `X${tag}`, fy: "2026-28" }, /like 2026-27/],
      [{ series: `X${tag}`, fy: "26-27" }, /like 2026-27/],
      [{ series: `X${tag}`, fy: "2026-27", prefix: "GAC 26/" }, /can't contain spaces/],
      [{ series: `X${tag}`, fy: "2026-27", prefix: 5 }, /must be text/],
      [{ series: `X${tag}`, fy: "2026-27", number_width: 0 }, /from 1 to 12/],
      [{ series: `X${tag}`, fy: "2026-27", next_no: 0 }, /whole number from 1/],
      [{ series: `X${tag}`, fy: "2026-27", next_no: "1.5" }, /whole number/],
    ];
    for (const [input, message] of cases) {
      await refused(series.saveSeries(input, ctx, db), 400, message, JSON.stringify(input));
    }
  });

  test("9. the financial year runs April to March", () => {
    expect(series.financialYear("2026-03-31")).toBe("2025-26");
    expect(series.financialYear("2026-04-01")).toBe("2026-27");
    expect(series.financialYear("2099-06-01")).toBe("2099-00");
    expect(series.formatNumber({ prefix: "GAC/", number_width: 6 }, 42)).toBe("GAC/000042");
  });
});
