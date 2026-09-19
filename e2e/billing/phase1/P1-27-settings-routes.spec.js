import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs } from "../../helpers/auth.mjs";
import { query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";

const tag = crypto.randomBytes(2).toString("hex").toUpperCase();
const S = "/api/billing/settings";
const VALID_GSTIN = "27AAPFU0939F1ZV";
const ids = {};
let api = null;

const call = async (client, method, path, data) => {
  const response = await client[method](path, data === undefined ? {} : { data });
  return { status: response.status(), body: await response.json().catch(() => null) };
};
const expectOk = async (method, path, data, status = 200) => {
  const r = await call(api, method, path, data);
  expect(r.status, `${method.toUpperCase()} ${path}: ${JSON.stringify(r.body)}`).toBe(status);
  return r.body;
};
const resetSettings = () =>
  query(
    `UPDATE billing_settings SET discount_stacking = 'best_only', allow_pay_later = FALSE,
            max_codes_per_bill = NULL, gst_enabled = FALSE, gstin = NULL, state_code = NULL,
            legal_name = NULL, bill_footer = NULL`,
  );

test.describe.serial("P1-27 settings routes", () => {
  test.beforeAll(async () => {
    await resetSettings();
    api = await apiAs("admin");
  });
  test.afterAll(async () => {
    await resetSettings();
    await api?.dispose();
  });

  test("1. admin reads and changes the billing settings", async () => {
    expect(await expectOk("get", S)).toMatchObject({
      discount_stacking: "best_only",
      allow_pay_later: false,
      gst_enabled: false,
    });
    const saved = await expectOk("patch", S, {
      allow_pay_later: true,
      bill_footer: "Thank you",
      gstin: VALID_GSTIN.toLowerCase(),
    });
    expect(saved).toMatchObject({
      allow_pay_later: true,
      bill_footer: "Thank you",
      gstin: VALID_GSTIN,
      state_code: "27",
      updated_by: USERS.admin.id,
    });
    const typo = await call(api, "patch", S, { gstin: "27AAPFU0939F1ZX" });
    expect(typo.status).toBe(400);
    expect(typo.body.error).toMatch(/last character doesn't match/);
    const gst = await call(api, "patch", S, { gst_enabled: true });
    expect(gst.status).toBe(409);
    expect(gst.body.error).toMatch(/legal name/);
  });

  test("2. admin manages bill series; the next number can only go up", async () => {
    const created = await expectOk("put", `${S}/series`, {
      series: "main",
      fy: "2041-42",
      prefix: "GAC/41-42/",
    });
    expect(created).toMatchObject({ series: "MAIN", next_number: "GAC/41-42/000001" });
    await expectOk("put", `${S}/series`, { series: "MAIN", fy: "2041-42", next_no: 14413 });
    const lower = await call(api, "put", `${S}/series`, {
      series: "MAIN",
      fy: "2041-42",
      next_no: 10,
    });
    expect(lower.status).toBe(409);
    const typo = await call(api, "put", `${S}/series`, {
      series: "MIAN",
      fy: "2041-42",
      prefix: "X/",
    });
    expect(typo.status).toBe(400);
    expect(typo.body.error).toBe("Series must be one of: MAIN, RCPT");
    const list = await expectOk("get", `${S}/series`);
    expect(list.find((s) => s.series === "MAIN" && s.fy === "2041-42").next_number).toBe(
      "GAC/41-42/014413",
    );
  });

  test("3. admin manages tax codes, including the in-use refusals", async () => {
    const tax = await expectOk(
      "post",
      `${S}/tax-codes`,
      { code: `GST18-${tag}`, rate_pct: 18, sac_hsn: "999312" },
      201,
    );
    ids.tax = tax.id;
    await expectOk("patch", `${S}/tax-codes/${tax.id}`, { rate_pct: "12.5" });
    const group = await query(
      `INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`,
      [`TG-${tag}`, `Tax group ${tag}`],
    );
    const sub = await query(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'Tax sub') RETURNING id`,
      [group.rows[0].id, `TS-${tag}`],
    );
    await query(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, tax_code_id) VALUES ($1, 'Taxed item', $2, 100, 'other', $3)`,
      [`TI-${tag}`, sub.rows[0].id, tax.id],
    );
    const off = await call(api, "put", `${S}/tax-codes/${tax.id}/active`, { is_active: false });
    expect(off.status).toBe(409);
    expect(off.body.active).toEqual(["Taxed item"]);
    const del = await call(api, "delete", `${S}/tax-codes/${tax.id}`);
    expect(del.status).toBe(409);
    expect(del.body.uses[0].text).toBe(`1 item uses tax code GST18-${tag}`);
    const spare = await expectOk("post", `${S}/tax-codes`, { code: `NIL-${tag}` }, 201);
    expect(await expectOk("delete", `${S}/tax-codes/${spare.id}`)).toEqual({
      deleted: true,
      id: spare.id,
    });
    const listed = await expectOk("get", `${S}/tax-codes?activeOnly=true`);
    expect(listed.map((t) => t.code)).toContain(`GST18-${tag}`);
    const audit = await query(
      `SELECT actor_id FROM billing_audit WHERE entity = 'tax_codes' AND entity_id = $1 ORDER BY id LIMIT 1`,
      [String(tax.id)],
    );
    expect(audit.rows[0].actor_id).toBe(USERS.admin.id);
  });

  test("4. every body endpoint uses its schema", async () => {
    const bodies = [
      ["patch", S, { allow_pay_later: false }],
      ["put", `${S}/series`, { series: "MAIN", fy: "2041-42", prefix: "X/" }],
      ["post", `${S}/tax-codes`, { code: `X-${tag}` }],
      ["patch", `${S}/tax-codes/${ids.tax}`, { rate_pct: 5 }],
      ["put", `${S}/tax-codes/${ids.tax}/active`, { is_active: true }],
    ];
    for (const [method, path, body] of bodies) {
      const r = await call(api, method, path, { ...body, rogue: 1 });
      expect(r.status, `${method.toUpperCase()} ${path} with an unknown field`).toBe(400);
      expect(r.body.error).toBe("Validation failed");
    }
    for (const [method, path, body] of [
      ["patch", S, {}],
      ["patch", S, { allow_pay_later: "true" }],
      ["put", `${S}/series`, { series: "MAIN", fy: "2026" }],
      ["patch", `${S}/tax-codes/abc`, { rate_pct: 5 }],
      ["patch", `${S}/tax-codes/${ids.tax}`, { rate_pct: 101 }],
    ]) {
      expect(
        (await call(api, method, path, body)).status,
        `${method} ${path} ${JSON.stringify(body)}`,
      ).toBe(400);
    }
    expect((await call(api, "get", `${S}/tax-codes?activeOnly=yes`)).status).toBe(400);
    expect(
      (await query(`SELECT count(*)::int AS n FROM tax_codes WHERE code = $1`, [`X-${tag}`]))
        .rows[0].n,
    ).toBe(0);
  });

  test("5. only admin can reach the settings routes — not reception_admin", async () => {
    const paths = [
      ["get", S],
      ["patch", S, { allow_pay_later: true }],
      ["get", `${S}/series`],
      ["put", `${S}/series`, { series: "RCPT", fy: "2041-42" }],
      ["get", `${S}/tax-codes`],
      ["post", `${S}/tax-codes`, { code: `DENY-${tag}` }],
      ["delete", `${S}/tax-codes/${ids.tax}`],
    ];
    for (const role of ["reception_admin", "reception", "coordinator"]) {
      const other = await apiAs(role);
      for (const [method, path, data] of paths) {
        const r = await call(other, method, path, data);
        expect(r.status, `${role} ${method.toUpperCase()} ${path}`).toBe(403);
      }
      await other.dispose();
    }
    expect(
      (await query(`SELECT count(*)::int AS n FROM tax_codes WHERE code = $1`, [`DENY-${tag}`]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await query(`SELECT allow_pay_later FROM billing_settings`)).rows[0].allow_pay_later,
      "unchanged by the refused requests",
    ).toBe(true);
  });
});
