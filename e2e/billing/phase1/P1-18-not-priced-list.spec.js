import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const svc = await import("../../../server/services/billing/serviceItems.js");

const db = getPool();
const ctx = { actorId: USERS.admin.id, ip: null };
const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
const one = (sql, params) => query(sql, params).then((r) => r.rows[0]);
const ids = {};

const mine = async () => {
  const list = await svc.notPricedList(db);
  return {
    tests: list.tests.filter((t) => t.test_name.endsWith(tag)),
    reports: list.reportsNotInCatalogue.filter((r) => r.name.endsWith(tag)),
    consultants: list.consultants.filter((c) => c.name.endsWith(tag)),
  };
};

test.describe.serial("P1-18 not-priced list", () => {
  test.beforeAll(async () => {
    const group = await one(
      `INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`,
      [`NP-G-${tag}`, `Not priced ${tag}`],
    );
    ids.sub = (
      await one(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'Any') RETURNING id`,
        [group.id, `NP-S-${tag}`],
      )
    ).id;
    const addTest = (name, category, active = true) =>
      one(
        `INSERT INTO giniflow_test_catalog (test_name, price, category, is_active) VALUES ($1, 150, $2, $3) RETURNING id`,
        [name, category, active],
      ).then((r) => r.id);
    ids.lab = await addTest(`Ferritin ${tag}`, "lab");
    ids.machine = await addTest(`Doppler ${tag}`, "machine");
    ids.retired = await addTest(`Old test ${tag}`, "lab", false);
    const addDoctor = (name, role, active = true) =>
      one(
        `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, $2, 'x', $3) RETURNING id`,
        [name, role, active],
      ).then((r) => r.id);
    ids.consultant = await addDoctor(`Dr New ${tag}`, "consultant");
    ids.mo = await addDoctor(`Dr MO ${tag}`, "mo");
    ids.left = await addDoctor(`Dr Left ${tag}`, "consultant", false);
    const labOnly = await query(
      `SELECT 1 FROM doctors WHERE lower(trim(name)) = 'dr. hospital admin' AND COALESCE(is_active, TRUE)`,
    );
    if (!labOnly.rows.length) await addDoctor("Dr. Hospital Admin", "consultant");
    const addReport = (name, aliases, active = true) =>
      query(`INSERT INTO lab_report_catalog (name, aliases, is_active) VALUES ($1, $2, $3)`, [
        name,
        aliases,
        active,
      ]);
    await addReport(`Vitamin K ${tag}`, []);
    await addReport(`Iron Studies ${tag}`, [`Ferritin ${tag}`]);
    await addReport(`Old Test ${tag}`, []);
    await addReport(`Switched off ${tag}`, [], false);
    await addTest(`CBC${tag}`, "lab");
    await addReport(`Complete Blood Count (CBC${tag})`, []);
    await addTest(`Vit B12 ${tag}`, "lab");
    await addReport(`Vitamin B12 ${tag}`, []);
  });

  test("1. active catalogue tests without an item are listed; retired ones are not", async () => {
    const { tests } = await mine();
    expect(tests.map((t) => [t.test_name, t.category, t.status, t.catalogue_price])).toEqual([
      [`CBC${tag}`, "lab", "no_item", 150],
      [`Ferritin ${tag}`, "lab", "no_item", 150],
      [`Vit B12 ${tag}`, "lab", "no_item", 150],
      [`Doppler ${tag}`, "machine", "no_item", 150],
    ]);
  });

  test("2. creating the missing item removes the test; deactivating it brings it back", async () => {
    const item = await svc.createItem(
      {
        code: `NP-FER-${tag}`,
        name: "Ferritin",
        subgroup_id: ids.sub,
        base_price: 400,
        kind: "test",
        test_catalog_id: ids.lab,
      },
      ctx,
      db,
    );
    expect((await mine()).tests.map((t) => t.test_name)).not.toContain(`Ferritin ${tag}`);
    await svc.setItemActive(item.id, false, ctx, db);
    const back = (await mine()).tests.find((t) => t.test_name === `Ferritin ${tag}`);
    expect(back).toMatchObject({
      status: "item_deactivated",
      item_id: item.id,
      item_code: `NP-FER-${tag}`,
    });
    await svc.setItemActive(item.id, true, ctx, db);
    expect((await mine()).tests.map((t) => t.test_name)).not.toContain(`Ferritin ${tag}`);
  });

  test("3. lab reports that aren't in the test catalogue are listed, with the reason", async () => {
    const { reports } = await mine();
    expect(reports).toEqual([
      { name: `Old Test ${tag}`, status: "retired_in_catalogue", possibly_same_as: [] },
      {
        name: `Vitamin B12 ${tag}`,
        status: "not_in_catalogue",
        possibly_same_as: [`Vit B12 ${tag}`],
      },
      { name: `Vitamin K ${tag}`, status: "not_in_catalogue", possibly_same_as: [] },
    ]);
    const cbc = (await svc.notPricedList(db)).reportsNotInCatalogue.find(
      (r) => r.name === `Complete Blood Count (CBC${tag})`,
    );
    expect(cbc, "a bracketed short name points at the catalogue test").toEqual({
      name: `Complete Blood Count (CBC${tag})`,
      status: "not_in_catalogue",
      possibly_same_as: [`CBC${tag}`],
    });
  });

  test("4. active consultants missing a New or Follow Up item are listed per visit type", async () => {
    const defaults = await query(
      `SELECT visit_type FROM service_items WHERE kind = 'consultation' AND is_active AND doctor_id IS NULL`,
    );
    const covered = new Set(defaults.rows.map((r) => r.visit_type));
    const { consultants } = await mine();
    expect(consultants.map((c) => [c.name, c.visit_type, c.status, c.default_covers])).toEqual([
      [`Dr New ${tag}`, "New", "no_item", covered.has("New")],
      [`Dr New ${tag}`, "Follow Up", "no_item", covered.has("Follow Up")],
    ]);
  });

  test("5. creating the doctor's item removes that visit type from the list", async () => {
    const newItem = await svc.createItem(
      {
        code: `NP-CN-${tag}`,
        name: "Consultation New",
        subgroup_id: ids.sub,
        base_price: 700,
        kind: "consultation",
        doctor_id: ids.consultant,
        visit_type: "New",
      },
      ctx,
      db,
    );
    expect((await mine()).consultants.map((c) => c.visit_type)).toEqual(["Follow Up"]);
    await svc.setItemActive(newItem.id, false, ctx, db);
    const back = (await mine()).consultants.find((c) => c.visit_type === "New");
    expect(back).toMatchObject({ status: "item_deactivated", item_id: newItem.id });
    await svc.setItemActive(newItem.id, true, ctx, db);
    await svc.createItem(
      {
        code: `NP-CF-${tag}`,
        name: "Consultation FU",
        subgroup_id: ids.sub,
        base_price: 500,
        kind: "consultation",
        doctor_id: ids.consultant,
        visit_type: "Follow Up",
      },
      ctx,
      db,
    );
    expect((await mine()).consultants).toEqual([]);
  });

  test("6. medical officers, inactive consultants and the lab-only provider are never listed", async () => {
    const list = await svc.notPricedList(db);
    const names = list.consultants.map((c) => c.name);
    expect(names).not.toContain(`Dr MO ${tag}`);
    expect(names).not.toContain(`Dr Left ${tag}`);
    expect(names.some((n) => n.trim().toLowerCase() === "dr. hospital admin")).toBe(false);
  });
});
