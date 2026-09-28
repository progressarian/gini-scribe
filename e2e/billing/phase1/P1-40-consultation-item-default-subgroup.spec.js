import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  CONSULTATION_DEFAULT_GROUP as GROUP,
  CONSULTATION_DEFAULT_SUBGROUP as SUBGROUP,
} from "../../../shared/billingVocab.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const items = await import("../../../server/services/billing/serviceItems.js");
const groups = await import("../../../server/services/billing/serviceGroups.js");
const { billingItemCreateSchema } = await import("../../../server/schemas/billing.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.4.0.40" };
const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
const failure = (promise) => promise.then(() => null).catch((e) => e);
const DOCTOR = `Dr P140 ${tag}`;
const seed = {};

let serial = 0;
const consult = (overrides = {}) => ({
  code: `P140-${tag}-${(serial += 1)}`,
  name: `P140 consult ${serial}`,
  base_price: 500,
  kind: "consultation",
  visit_type: "New",
  ...overrides,
});

async function onEmptyMaster(work) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM service_items");
    await client.query("DELETE FROM service_subgroups");
    await client.query("DELETE FROM service_groups");
    await client.query("SET LOCAL session_replication_role = origin");
    return await work(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

const rowsOf = async (client, sql, params = []) => (await client.query(sql, params)).rows;
const countOf = async (client, table) =>
  Number((await client.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

async function makeSubgroup(client, code, groupCode = `P140G-${tag}-${code}`) {
  const group = await groups.createGroup(
    { code: groupCode, name: `P140 ${groupCode}` },
    ctx,
    client,
  );
  return groups.createSubgroup(
    { group_id: group.id, code: `${code}`, name: `P140 ${code}` },
    ctx,
    client,
  );
}

const showView = (page, name) =>
  page
    .getByRole("group", { name: "Consultant fees view" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
test.describe.serial("P1-40 consultation items land in the consultation subgroup", () => {
  test("1. with no groups at all, a consultation item creates OPD › OPD-CONS once and the next reuses it", async () => {
    await onEmptyMaster(async (client) => {
      const first = await items.createItem(consult(), ctx, client);
      const [group] = await rowsOf(client, `SELECT id, code, name, is_active FROM service_groups`);
      const [sub] = await rowsOf(
        client,
        `SELECT id, group_id, code, name, is_active FROM service_subgroups`,
      );
      expect(group).toMatchObject({ code: GROUP.code, name: GROUP.name, is_active: true });
      expect(sub).toMatchObject({
        code: SUBGROUP.code,
        name: SUBGROUP.name,
        group_id: group.id,
        is_active: true,
      });
      expect(first.subgroup_id).toBe(sub.id);

      const second = await items.createItem(consult({ visit_type: "Follow Up" }), ctx, client);
      expect(second.subgroup_id).toBe(sub.id);
      expect(await countOf(client, "service_groups")).toBe(1);
      expect(await countOf(client, "service_subgroups")).toBe(1);
    });
  });

  test("2. the subgroup already holding the most consultation items is reused, whatever its code", async () => {
    await onEmptyMaster(async (client) => {
      const busy = await makeSubgroup(client, `P140-BUSY-${tag}`);
      const quiet = await makeSubgroup(client, `P140-QUIET-${tag}`);
      const named = await makeSubgroup(client, SUBGROUP.code, `P140-OTHER-${tag}`);
      await items.createItem(consult({ subgroup_id: busy.id }), ctx, client);
      await items.createItem(
        consult({ subgroup_id: busy.id, visit_type: "Follow Up" }),
        ctx,
        client,
      );
      await items.createItem(
        { ...consult({ subgroup_id: quiet.id }), kind: "procedure", visit_type: null },
        ctx,
        client,
      );
      const doctor = await client.query(
        `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
        [`${DOCTOR} busy`],
      );
      const made = await items.createItem(consult({ doctor_id: doctor.rows[0].id }), ctx, client);
      expect(made.subgroup_id).toBe(busy.id);
      expect(made.subgroup_id).not.toBe(named.id);
      expect(await countOf(client, "service_groups")).toBe(3);
    });
  });

  test("2b. with no consultation items anywhere, an existing active OPD-CONS subgroup is reused", async () => {
    await onEmptyMaster(async (client) => {
      const named = await makeSubgroup(client, SUBGROUP.code, `P140-ELSE-${tag}`);
      const made = await items.createItem(consult(), ctx, client);
      expect(made.subgroup_id).toBe(named.id);
      expect(
        await rowsOf(client, `SELECT id FROM service_groups WHERE code = $1`, [GROUP.code]),
      ).toHaveLength(0);
    });
  });

  test("2c. an existing OPD group with no OPD-CONS gets the subgroup, not a second group", async () => {
    await onEmptyMaster(async (client) => {
      const group = await groups.createGroup({ code: GROUP.code, name: "Our OPD" }, ctx, client);
      const made = await items.createItem(consult(), ctx, client);
      const [sub] = await rowsOf(client, `SELECT id, group_id, code FROM service_subgroups`);
      expect(sub).toMatchObject({ group_id: group.id, code: SUBGROUP.code });
      expect(made.subgroup_id).toBe(sub.id);
      expect(await countOf(client, "service_groups")).toBe(1);
    });
  });

  test("3. a given subgroup is respected, even when another holds more consultation items", async () => {
    await onEmptyMaster(async (client) => {
      const busy = await makeSubgroup(client, `P140-BUSY-${tag}`);
      const chosen = await makeSubgroup(client, `P140-MINE-${tag}`);
      await items.createItem(consult({ subgroup_id: busy.id }), ctx, client);
      const made = await items.createItem(
        consult({ subgroup_id: chosen.id, visit_type: "Follow Up" }),
        ctx,
        client,
      );
      expect(made.subgroup_id).toBe(chosen.id);
    });
  });

  test("3b. editing a consultation item keeps its subgroup unless the edit changes it", async () => {
    await onEmptyMaster(async (client) => {
      const made = await items.createItem(consult(), ctx, client);
      const other = await makeSubgroup(client, `P140-MOVE-${tag}`);
      const repriced = await items.updateItem(
        made.id,
        { base_price: 650, reason: "P140 new fee" },
        ctx,
        client,
      );
      expect(repriced.subgroup_id).toBe(made.subgroup_id);
      const moved = await items.updateItem(made.id, { subgroup_id: other.id }, ctx, client);
      expect(moved.subgroup_id).toBe(other.id);
    });
  });

  test("4. every other kind still needs a subgroup, with the old message", async () => {
    await onEmptyMaster(async (client) => {
      for (const kind of ["procedure", "medicine", "other"]) {
        const error = await failure(
          items.createItem({ ...consult(), kind, visit_type: null }, ctx, client),
        );
        expect(error?.status, kind).toBe(400);
        expect(error.message, kind).toBe("Choose a subgroup");
      }
      const { id: testId } = (
        await client.query(`SELECT id FROM giniflow_test_catalog WHERE is_active LIMIT 1`)
      ).rows[0];
      const error = await failure(
        items.createItem(
          { ...consult(), kind: "test", visit_type: null, test_catalog_id: testId },
          ctx,
          client,
        ),
      );
      expect(error?.status).toBe(400);
      expect(error.message).toBe("Choose a subgroup");
      expect(await countOf(client, "service_groups")).toBe(0);
      expect(await countOf(client, "service_items")).toBe(0);
    });
    const body = { code: "P140", name: "P140", base_price: 1 };
    expect(billingItemCreateSchema.safeParse({ ...body, kind: "consultation" }).success).toBe(true);
    for (const kind of ["test", "procedure", "medicine", "other"]) {
      const parsed = billingItemCreateSchema.safeParse({ ...body, kind });
      expect(parsed.success, kind).toBe(false);
      expect(parsed.error.issues[0].path, kind).toEqual(["subgroup_id"]);
    }
  });

  test("5. a deactivated default group or subgroup is refused and nothing is created", async () => {
    await onEmptyMaster(async (client) => {
      await client.query(
        `INSERT INTO service_groups (code, name, is_active) VALUES ($1, $2, FALSE)`,
        [GROUP.code, GROUP.name],
      );
      const error = await failure(items.createItem(consult(), ctx, client));
      expect(error?.status).toBe(409);
      expect(error.message).toBe(`${GROUP.name} is deactivated; reactivate it first`);
      expect(await countOf(client, "service_groups")).toBe(1);
      expect(await countOf(client, "service_subgroups")).toBe(0);
      expect(await countOf(client, "service_items")).toBe(0);
    });
    await onEmptyMaster(async (client) => {
      const group = await groups.createGroup({ code: GROUP.code, name: GROUP.name }, ctx, client);
      await client.query(
        `INSERT INTO service_subgroups (group_id, code, name, is_active) VALUES ($1, $2, $3, FALSE)`,
        [group.id, SUBGROUP.code, SUBGROUP.name],
      );
      const error = await failure(items.createItem(consult(), ctx, client));
      expect(error?.status).toBe(409);
      expect(error.message).toBe(`${SUBGROUP.name} is deactivated; reactivate it first`);
      expect(await countOf(client, "service_groups")).toBe(1);
      expect(await countOf(client, "service_subgroups")).toBe(1);
      expect(await countOf(client, "service_items")).toBe(0);
    });
  });

  test("6. the auto-created group and subgroup are audited like a normal create", async () => {
    await onEmptyMaster(async (client) => {
      const made = await items.createItem(consult(), ctx, client);
      const audit = await rowsOf(
        client,
        `SELECT entity, action, actor_id, ip, after->>'code' AS code FROM billing_audit
          WHERE ip = $1 AND entity_id IN (
            (SELECT id::text FROM service_groups WHERE code = $2),
            (SELECT id::text FROM service_subgroups WHERE code = $3),
            $4::text)
          ORDER BY id`,
        [ctx.ip, GROUP.code, SUBGROUP.code, made.id],
      );
      expect(audit).toEqual([
        {
          entity: "service_groups",
          action: "create",
          actor_id: ctx.actorId,
          ip: ctx.ip,
          code: GROUP.code,
        },
        {
          entity: "service_subgroups",
          action: "create",
          actor_id: ctx.actorId,
          ip: ctx.ip,
          code: SUBGROUP.code,
        },
        {
          entity: "service_items",
          action: "create",
          actor_id: ctx.actorId,
          ip: ctx.ip,
          code: made.code,
        },
      ]);
    });
  });

  test.describe("UI", () => {
    test.beforeAll(async () => {
      seed.doctor = await one(
        `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
        [DOCTOR],
      );
      const group = await groups.createGroup(
        { code: `P140UIG-${tag}`, name: `P140 UI Group ${tag}` },
        ctx,
      );
      seed.subgroup = await groups.createSubgroup(
        { group_id: group.id, code: `P140UIS-${tag}`, name: `P140 UI Sub ${tag}` },
        ctx,
      );
    });

    test.afterAll(async () => {
      if (seed.doctor) {
        await query(
          `DELETE FROM service_item_price_history WHERE service_item_id IN
             (SELECT id FROM service_items WHERE doctor_id = $1)`,
          [seed.doctor.id],
        );
        await query(`DELETE FROM service_items WHERE doctor_id = $1`, [seed.doctor.id]);
        await query(`DELETE FROM doctors WHERE id = $1`, [seed.doctor.id]);
      }
      await query(`DELETE FROM service_subgroups WHERE code = $1`, [`P140UIS-${tag}`]);
      await query(`DELETE FROM service_groups WHERE code = $1`, [`P140UIG-${tag}`]);
    });

    const noGroups = (page) =>
      page.route(/\/api\/billing\/master\/groups(\?|$)/, (route) =>
        route.request().method() === "GET" ? route.fulfill({ json: [] }) : route.continue(),
      );

    test("7a. ItemDialog from + Add item hides Subgroup for Consultation and saves", async ({
      page,
    }) => {
      await loginAs(page, "reception_admin");
      const groupsPanel = page.getByRole("region", { name: "Groups" });
      await gotoReady(page, "/settings/services", () => groupsPanel);
      await groupsPanel.getByRole("button", { name: new RegExp(`^P140 UI Sub ${tag}`) }).click();
      await page.getByRole("button", { name: "+ Add item", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const field = (label) => dialog.getByLabel(label, { exact: true });
      await expect(field("Subgroup")).toBeVisible();
      await field("Kind").selectOption("consultation");
      await expect(field("Subgroup")).toHaveCount(0);
      await field("Kind").selectOption("procedure");
      await expect(field("Subgroup")).toBeVisible();
      await expect(field("Subgroup")).toHaveAttribute("required", "");
      await field("Kind").selectOption("consultation");
      await expect(field("Subgroup")).toHaveCount(0);
      await field("Visit type").selectOption("New");
      await field("Consultant").selectOption(String(seed.doctor.id));
      await field("Name").fill(`Consultation — ${DOCTOR} (New)`);
      await field("Code").fill(`P140UI-${tag}`);
      await field("Price (₹)").fill("750");
      await dialog.getByRole("button", { name: "Add item", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const item = await one(
        `SELECT i.kind, i.visit_type, i.base_price::text, s.is_active AS subgroup_active
           FROM service_items i JOIN service_subgroups s ON s.id = i.subgroup_id
          WHERE i.code = $1`,
        [`P140UI-${tag}`],
      );
      expect(item).toEqual({
        kind: "consultation",
        visit_type: "New",
        base_price: "750.00",
        subgroup_active: true,
      });
    });

    test("7b. ConsultantFeeCreateItem has no Subgroup field and saves", async ({ page }) => {
      await noGroups(page);
      await loginAs(page, "reception_admin");
      await gotoReady(page, "/settings/consultant-fees", () =>
        page.getByLabel("Category", { exact: true }),
      );
      await page.getByLabel("Doctor", { exact: true }).selectOption(String(seed.doctor.id));
      await showView(page, "Not priced");
      await page
        .getByRole("table", { name: "Not priced" })
        .getByRole("button", { name: `Create item for ${DOCTOR} (Follow Up)` })
        .click();
      const box = page.getByRole("dialog");
      await expect(box.getByLabel("Subgroup", { exact: true })).toHaveCount(0);
      await box.getByLabel("Price (₹)", { exact: true }).fill("400");
      await box.getByRole("button", { name: "Create item", exact: true }).click();
      await expect(box).toBeHidden();
      const item = await one(
        `SELECT i.base_price::text, s.is_active AS subgroup_active
           FROM service_items i JOIN service_subgroups s ON s.id = i.subgroup_id
          WHERE i.doctor_id = $1 AND i.visit_type = 'Follow Up' AND i.is_active`,
        [seed.doctor.id],
      );
      expect(item).toEqual({ base_price: "400.00", subgroup_active: true });
    });
  });
});
