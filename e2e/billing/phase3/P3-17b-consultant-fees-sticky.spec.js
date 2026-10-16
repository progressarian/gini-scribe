import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginAs } from "../../helpers/auth.mjs";
import { getPool, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const schemes = await import("../../../server/services/patientSchemes.js");

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.17.2.17" };
const one = (sql, params) => query(sql, params).then((r) => r.rows[0].id);
const grid = (page) => page.getByRole("table", { name: "Consultant fees" });

test.describe("P3-17b consultant fees grid keeps its header and doctor column in view", () => {
  test.use({ viewport: { width: 900, height: 620 } });

  test.beforeAll(async () => {
    for (let i = 1; i <= 6; i += 1) {
      await schemes.createScheme(
        { code: `p317b_s${i}_${tag}`, label: `P317B Scheme ${i} ${tag}` },
        getPool(),
        ctx,
      );
    }
    const group = await one(
      `INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`,
      [`P317B-OPD-${T}`],
    );
    const sub = await one(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [group, `P317B-CONS-${T}`],
    );
    for (let i = 1; i <= 6; i += 1) {
      const doctor = await one(
        `INSERT INTO doctors (name, short_name, role) VALUES ($1, $1, 'consultant') RETURNING id`,
        [`Dr P317B ${i} ${tag}`],
      );
      for (const [visit, suffix] of [
        ["New", "NEW"],
        ["Follow Up", "FU"],
      ]) {
        await query(
          `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, doctor_id, visit_type)
           VALUES ($1, $1, $2, 1000, 'consultation', $3, $4)`,
          [`P317B-${i}-${suffix}-${T}`, sub, doctor, visit],
        );
      }
    }
  });

  test.afterAll(async () => {
    await query(`UPDATE service_items SET is_active = FALSE WHERE code LIKE $1`, [`P317B-%-${T}`]);
    await query(`UPDATE doctors SET is_active = FALSE WHERE name LIKE $1`, [`Dr P317B % ${tag}`]);
    await query(`UPDATE patient_schemes SET is_active = FALSE WHERE code LIKE $1`, [
      `p317b_%_${tag}`,
    ]).catch(() => {});
  });

  test("1. scrolling the grid sideways and down keeps the doctor names and column names pinned", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/settings/consultant-fees", () => grid(page));
    const scroller = page.locator(".cf-scroll");
    const header = grid(page).locator("thead th").nth(2);
    const firstDoctor = grid(page).locator("tbody th.cf-grid__who").first();
    await expect(firstDoctor).toBeVisible();

    const before = {
      header: await header.boundingBox(),
      doctor: await firstDoctor.boundingBox(),
    };
    const room = await scroller.evaluate((el) => ({
      x: el.scrollWidth - el.clientWidth,
      y: el.scrollHeight - el.clientHeight,
    }));
    expect(room.x).toBeGreaterThan(0);

    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const sideways = await firstDoctor.boundingBox();
    expect(Math.round(sideways.x)).toBe(Math.round(before.doctor.x));

    expect(room.y).toBeGreaterThan(0);
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const down = await header.boundingBox();
    expect(Math.round(down.y)).toBe(Math.round(before.header.y));
  });
});
