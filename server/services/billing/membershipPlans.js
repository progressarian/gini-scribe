import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { writeAudit } from "./audit.js";
import { auditFields, readNumber } from "./common.js";
import { httpError, inTransaction } from "./transaction.js";

export const MEMBERSHIP_GROUP_CODE = "MEMBERSHIP";
export const MEMBERSHIP_SUBGROUP_CODE = "MEMBERSHIP-CONS";

const PLAN_SQL = `
  SELECT p.id, p.code, p.name, p.price, p.consult_count, p.dietitian_count, p.lab_discount_pct,
         p.lab_excludes_outsourced, p.service_item_id, p.is_active, p.updated_at,
         COALESCE(d.short_name, d.name) AS updated_by_name,
         (SELECT count(*)::int FROM membership_cards c
           WHERE c.plan_id = p.id AND c.status = 'active') AS active_cards,
         (SELECT count(*)::int FROM membership_cards c
           WHERE c.plan_id = p.id AND c.status <> 'cancelled') AS cards_sold
    FROM membership_plans p
    LEFT JOIN doctors d ON d.id = p.updated_by`;

const shape = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  price: paise(row.price),
  consult_count: row.consult_count,
  dietitian_count: row.dietitian_count,
  lab_discount_pct: Number(row.lab_discount_pct),
  lab_excludes_outsourced: row.lab_excludes_outsourced,
  service_item_id: row.service_item_id,
  is_active: row.is_active,
  active_cards: row.active_cards,
  cards_sold: row.cards_sold,
  updated_at: row.updated_at,
  updated_by_name: row.updated_by_name,
});

function cleanPlanId(value) {
  const id = readNumber(value, "Choose a valid plan");
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Choose a valid plan");
  return id;
}

const itemFields = (plan) => ({
  code: `MEM-${plan.code}`,
  name: `Membership — ${plan.name}`,
  base_price: plan.price,
});

const ruleFields = (plan) => ({
  name: `Membership lab discount — ${plan.name}`,
  value: plan.lab_discount_pct,
  excludes_outsourced: plan.lab_excludes_outsourced,
  is_active: plan.is_active && plan.lab_discount_pct > 0,
});

async function membershipSubgroup(client) {
  const { rows } = await client.query(
    `SELECT s.id FROM service_subgroups s JOIN service_groups g ON g.id = s.group_id
      WHERE lower(g.code) = lower($1) AND lower(s.code) = lower($2)`,
    [MEMBERSHIP_GROUP_CODE, MEMBERSHIP_SUBGROUP_CODE],
  );
  if (!rows.length) {
    throw httpError(
      409,
      "The Membership › Consultant service group is missing — ask an administrator to run the membership migration",
    );
  }
  return rows[0].id;
}

async function refuseTakenCode(client, code, planId = null) {
  const { rows } = await client.query(
    `SELECT 1 FROM membership_plans WHERE lower(code) = lower($1) AND id IS DISTINCT FROM $2
     UNION ALL
     SELECT 1 FROM service_items WHERE lower(code) = lower($3)
       AND id IS DISTINCT FROM (SELECT service_item_id FROM membership_plans WHERE id = $2)`,
    [code, planId, `MEM-${code}`],
  );
  if (rows.length) throw httpError(409, `The plan code ${code} is already used`);
}

async function readPlan(db, id) {
  const { rows } = await db.query(`${PLAN_SQL} WHERE p.id = $1`, [id]);
  if (!rows.length) throw httpError(404, "That membership plan doesn't exist");
  return shape(rows[0]);
}

export async function listPlans({ activeOnly = false } = {}, db = pool) {
  const { rows } = await db.query(
    `${PLAN_SQL} ${activeOnly ? "WHERE p.is_active" : ""} ORDER BY p.is_active DESC, lower(p.name)`,
  );
  return rows.map(shape);
}

export async function createPlan(input, ctx, db = pool) {
  return inTransaction(async (client) => {
    await refuseTakenCode(client, input.code);
    const subgroupId = await membershipSubgroup(client);
    const item = itemFields(input);
    const actor = ctx?.actorId ?? null;
    const { rows: items } = await client.query(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'other', $5, $5) RETURNING id`,
      [item.code, item.name, subgroupId, item.base_price, actor],
    );
    const { rows } = await client.query(
      `INSERT INTO membership_plans (code, name, price, consult_count, dietitian_count,
                                     lab_discount_pct, lab_excludes_outsourced, service_item_id,
                                     created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
      [
        input.code,
        input.name,
        input.price,
        input.consult_count,
        input.dietitian_count,
        input.lab_discount_pct,
        input.lab_excludes_outsourced,
        items[0].id,
        actor,
      ],
    );
    const rule = ruleFields({ ...input, is_active: true });
    await client.query(
      `INSERT INTO discount_rules (name, method, kind, value, applies_per, priority, stackable,
                                   tests_only, excludes_outsourced, membership_plan_id, is_active,
                                   created_by, updated_by)
       VALUES ($1, 'auto', 'percent', $2, 'line', 0, FALSE, TRUE, $3, $4, $5, $6, $6)`,
      [rule.name, rule.value, rule.excludes_outsourced, rows[0].id, rule.is_active, actor],
    );
    const plan = await readPlan(client, rows[0].id);
    await writeAudit(client, {
      entity: "membership_plans",
      entityId: plan.id,
      action: "create",
      after: plan,
      ...auditFields(ctx),
    });
    return plan;
  }, db);
}

async function lockPlan(client, id) {
  const { rows } = await client.query(`SELECT id FROM membership_plans WHERE id = $1 FOR UPDATE`, [
    id,
  ]);
  if (!rows.length) throw httpError(404, "That membership plan doesn't exist");
  return readPlan(client, id);
}

async function savePlan(client, before, next, ctx) {
  const actor = ctx?.actorId ?? null;
  await client.query(
    `UPDATE membership_plans
        SET code = $2, name = $3, price = $4, consult_count = $5, dietitian_count = $6,
            lab_discount_pct = $7, lab_excludes_outsourced = $8, is_active = $9,
            updated_at = NOW(), updated_by = $10
      WHERE id = $1`,
    [
      before.id,
      next.code,
      next.name,
      next.price,
      next.consult_count,
      next.dietitian_count,
      next.lab_discount_pct,
      next.lab_excludes_outsourced,
      next.is_active,
      actor,
    ],
  );
  const item = itemFields(next);
  await client.query(
    `UPDATE service_items SET code = $2, name = $3, base_price = $4, is_active = $5,
            updated_at = NOW(), updated_by = $6
      WHERE id = $1`,
    [before.service_item_id, item.code, item.name, item.base_price, next.is_active, actor],
  );
  const rule = ruleFields(next);
  await client.query(
    `UPDATE discount_rules SET name = $2, value = $3, excludes_outsourced = $4, is_active = $5,
            updated_at = NOW(), updated_by = $6
      WHERE membership_plan_id = $1`,
    [before.id, rule.name, rule.value, rule.excludes_outsourced, rule.is_active, actor],
  );
  const after = await readPlan(client, before.id);
  await writeAudit(client, {
    entity: "membership_plans",
    entityId: before.id,
    action:
      before.is_active === after.is_active ? "update" : after.is_active ? "activate" : "deactivate",
    before,
    after,
    ...auditFields(ctx),
  });
  return after;
}

const fromPlan = (plan) => ({
  code: plan.code,
  name: plan.name,
  price: plan.price / 100,
  consult_count: plan.consult_count,
  dietitian_count: plan.dietitian_count,
  lab_discount_pct: plan.lab_discount_pct,
  lab_excludes_outsourced: plan.lab_excludes_outsourced,
  is_active: plan.is_active,
});

export async function updatePlan(idValue, input, ctx, db = pool) {
  const id = cleanPlanId(idValue);
  return inTransaction(async (client) => {
    const before = await lockPlan(client, id);
    const next = { ...fromPlan(before), ...input };
    if (next.code !== before.code) await refuseTakenCode(client, next.code, id);
    if (next.consult_count + next.dietitian_count <= 0) {
      throw httpError(400, "A plan must include at least one consultation or dietitian visit");
    }
    return savePlan(client, before, next, ctx);
  }, db);
}

export async function setPlanActive(idValue, active, ctx, db = pool) {
  const id = cleanPlanId(idValue);
  return inTransaction(async (client) => {
    const before = await lockPlan(client, id);
    return savePlan(client, before, { ...fromPlan(before), is_active: active === true }, ctx);
  }, db);
}

export async function membershipSettings(db = pool) {
  const { rows } = await db.query(
    `SELECT s.membership_dietitian_item_id AS dietitian_item_id, i.name AS dietitian_item_name
       FROM billing_settings s LEFT JOIN service_items i ON i.id = s.membership_dietitian_item_id`,
  );
  return rows[0] ?? { dietitian_item_id: null, dietitian_item_name: null };
}

export async function setMembershipSettings(input, ctx, db = pool) {
  const itemId = input.dietitian_item_id ?? null;
  return inTransaction(async (client) => {
    if (itemId !== null) {
      const { rows } = await client.query(
        `SELECT kind, is_active FROM service_items WHERE id = $1`,
        [itemId],
      );
      if (!rows.length) throw httpError(404, "That service doesn't exist");
      if (rows[0].kind === "test") {
        throw httpError(400, "Choose the dietitian consultation service, not a test");
      }
    }
    const before = await membershipSettings(client);
    await client.query(
      `UPDATE billing_settings SET membership_dietitian_item_id = $1, updated_at = NOW(),
              updated_by = $2`,
      [itemId, ctx?.actorId ?? null],
    );
    const after = await membershipSettings(client);
    await writeAudit(client, {
      entity: "billing_settings",
      entityId: "membership",
      action: "update",
      before,
      after,
      ...auditFields(ctx),
    });
    return after;
  }, db);
}
