import pool from "../../config/db.js";
import {
  PATIENT_PAYS,
  REMAINDERS,
  RESERVED_CATEGORY_CODES,
  VISIT_TYPES,
} from "../../../shared/billingVocab.js";
import { writeAudit } from "./audit.js";
import { indiaToday } from "./categoryResolver.js";
import { httpError, inTransaction } from "./transaction.js";
import {
  auditFields,
  cleanActive,
  cleanDate,
  cleanName,
  cleanPriority,
  cleanVisitTypes,
  hasField,
  INT_MAX,
  lockRow,
  MONEY_MAX,
  NAME_KEY_SQL,
  nameKey,
  readNumber,
} from "./common.js";

const COLUMNS = [
  "id",
  "scheme_code",
  "name",
  "group_id",
  "subgroup_id",
  "service_item_id",
  "visit_types",
  "patient_pays",
  "patient_value",
  "remainder",
  "valid_from::text AS valid_from",
  "valid_to::text AS valid_to",
  "priority",
  "is_active",
  "created_at",
  "updated_at",
];

const SPEC = {
  table: "category_payment_rules",
  noun: "payment rule",
  columns: COLUMNS.join(", "),
};
const SCOPES = ["group_id", "subgroup_id", "service_item_id"];
const EDITABLE = [
  "scheme_code",
  "name",
  ...SCOPES,
  "visit_types",
  "patient_pays",
  "patient_value",
  "remainder",
  "valid_from",
  "valid_to",
  "priority",
];
const TAKES_VALUE = ["amount", "percent"];
const SHOWN_ITEMS = 10;

export const rupees = (amount) => `₹${Number(amount).toLocaleString("en-IN")}`;

const shape = (row) =>
  row && {
    ...row,
    patient_value: row.patient_value === null ? null : Number(row.patient_value),
  };

function cleanScheme(value) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!code) throw httpError(400, "Choose a category");
  return code;
}

const SCOPE_LABELS = { group_id: "group", subgroup_id: "subgroup", service_item_id: "item" };

function cleanScopeId(value, key) {
  if (value === undefined || value === null || value === "") return null;
  const message = `Choose a valid ${SCOPE_LABELS[key]}`;
  const id = readNumber(value, message);
  if (!Number.isInteger(id) || id <= 0 || id > INT_MAX) throw httpError(400, message);
  return id;
}

function cleanPatientPays(value) {
  if (!PATIENT_PAYS.includes(value)) {
    throw httpError(400, `Patient pays must be one of: ${PATIENT_PAYS.join(", ")}`);
  }
  return value;
}

function cleanValue(value) {
  const n = readNumber(value, "The value must be a number");
  return n === undefined ? null : n;
}

function cleanRemainder(value) {
  if (value === undefined || value === null || value === "") return "claim";
  if (!REMAINDERS.includes(value)) {
    throw httpError(400, `The rest must go to one of: ${REMAINDERS.join(", ")}`);
  }
  return value;
}

const CLEANERS = {
  scheme_code: cleanScheme,
  name: cleanName,
  group_id: (v) => cleanScopeId(v, "group_id"),
  subgroup_id: (v) => cleanScopeId(v, "subgroup_id"),
  service_item_id: (v) => cleanScopeId(v, "service_item_id"),
  visit_types: cleanVisitTypes,
  patient_pays: cleanPatientPays,
  patient_value: cleanValue,
  remainder: cleanRemainder,
  valid_from: (v) => cleanDate(v, "From date") ?? indiaToday(),
  valid_to: (v) => cleanDate(v, "To date"),
  priority: cleanPriority,
};

function cleanInput(input, { partial }) {
  const out = {};
  for (const key of EDITABLE) {
    if (hasField(input, key)) out[key] = CLEANERS[key](input[key]);
    else if (!partial) out[key] = CLEANERS[key](undefined);
  }
  if (
    out.patient_pays &&
    !TAKES_VALUE.includes(out.patient_pays) &&
    !hasField(input, "patient_value")
  ) {
    out.patient_value = null;
  }
  if (SCOPES.some((key) => hasField(input, key))) {
    for (const key of SCOPES) if (!hasField(input, key)) out[key] = null;
  }
  return out;
}

export function paymentRuleShapeProblem(rule) {
  const problem = (field, message) => ({ field, message });
  if (SCOPES.filter((key) => rule[key] !== null).length > 1) {
    return problem(
      "group_id",
      "Choose one of a group, a subgroup or an item — or none, for the whole category",
    );
  }
  const value = rule.patient_value;
  if (rule.patient_pays === "amount") {
    if (value === null)
      return problem("patient_value", "Enter the amount in rupees the patient pays");
    if (value < 0) return problem("patient_value", "The amount can't be negative");
    if (value > MONEY_MAX) {
      return problem("patient_value", `The amount is too large (at most ${MONEY_MAX})`);
    }
    if (Number(value.toFixed(2)) !== value) {
      return problem("patient_value", "The amount can have at most 2 decimals (paise)");
    }
  } else if (rule.patient_pays === "percent") {
    if (value === null) return problem("patient_value", "Enter the percent the patient pays");
    if (value < 0 || value > 100) {
      return problem("patient_value", "The percent must be from 0 to 100");
    }
    if (Number(value.toFixed(2)) !== value) {
      return problem("patient_value", "The percent can have at most 2 decimals");
    }
  } else if (value !== null) {
    return problem(
      "patient_value",
      `A "${rule.patient_pays}" rule takes no value; only amount and percent rules do`,
    );
  }
  if (rule.valid_to !== null && rule.valid_to < rule.valid_from) {
    return problem("valid_to", "To date can't be before the From date");
  }
  return null;
}

const DRAFT_FIELDS = [
  "group_id",
  "subgroup_id",
  "service_item_id",
  "visit_types",
  "patient_pays",
  "patient_value",
  "remainder",
];
const DRAFT_NAME = "Draft rule";

export function cleanDraftRule(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw httpError(400, "A draft rule must be an object");
  }
  const rule = Object.fromEntries(DRAFT_FIELDS.map((key) => [key, CLEANERS[key](input[key])]));
  if (!TAKES_VALUE.includes(rule.patient_pays) && !hasField(input, "patient_value")) {
    rule.patient_value = null;
  }
  const problem = paymentRuleShapeProblem({ ...rule, valid_from: null, valid_to: null });
  if (problem) throw httpError(400, problem.message);
  return rule;
}

export function draftForLine(draft, line, visitType) {
  if (!draft) return null;
  if (draft.visit_types && !draft.visit_types.includes(visitType)) return null;
  const scopes = [
    ["item", draft.service_item_id, line.item_id],
    ["subgroup", draft.subgroup_id, line.subgroup_id],
    ["group", draft.group_id, line.group_id],
  ];
  const chosen = scopes.find(([, chosenId]) => chosenId !== null);
  if (chosen && chosen[1] !== chosen[2]) return null;
  return {
    rule: { ...draft, id: null, name: DRAFT_NAME },
    patient_pays: draft.patient_pays,
    patient_value: draft.patient_value,
    remainder: draft.remainder,
    scope: chosen ? chosen[0] : "category",
    from_parent: false,
    draft: true,
  };
}

function checkShape(rule) {
  const problem = paymentRuleShapeProblem(rule);
  if (problem) throw httpError(400, problem.message);
}

async function loadCategory(client, code) {
  const { rows } = await client.query(
    `SELECT s.code, s.parent_code,
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS name,
            s.is_active AND COALESCE(p.is_active, TRUE) AS active,
            COALESCE(s.payer_name, p.payer_name) AS payer_name
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1
        FOR SHARE OF s`,
    [code],
  );
  if (!rows.length) throw httpError(404, "That category doesn't exist");
  return rows[0];
}

const SCOPE_TABLES = {
  group_id: { table: "service_groups", noun: "group" },
  subgroup_id: { table: "service_subgroups", noun: "subgroup" },
  service_item_id: { table: "service_items", noun: "item" },
};

async function checkScope(client, rule) {
  const key = SCOPES.find((k) => rule[k] !== null);
  if (!key) return;
  const { table, noun } = SCOPE_TABLES[key];
  const { rows } = await client.query(
    `SELECT name, is_active FROM ${table} WHERE id = $1 FOR SHARE`,
    [rule[key]],
  );
  if (!rows.length) throw httpError(404, `That ${noun} doesn't exist`);
  if (!rows[0].is_active) throw httpError(409, `The ${noun} ${rows[0].name} is deactivated`);
}

async function checkNameFree(client, schemeCode, name, exceptId) {
  const { rows } = await client.query(
    `SELECT name FROM category_payment_rules
      WHERE scheme_code = $1 AND ${NAME_KEY_SQL} = $2 AND id IS DISTINCT FROM $3`,
    [schemeCode, nameKey(name), exceptId],
  );
  if (rows.length) {
    throw httpError(409, `This category already has a payment rule called "${rows[0].name}"`);
  }
}

export function claimPayerProblem(category, rule) {
  if (rule.patient_pays === "full" || rule.remainder !== "claim" || category.payer_name) {
    return null;
  }
  return `${category.name} has no payer name, so there is no one to claim the rest from. Add a payer name to the category${category.parent_code ? " or its parent" : ""}, or send the rest to adjustment.`;
}

function checkPayer(category, rule) {
  const problem = claimPayerProblem(category, rule);
  if (problem) throw httpError(409, problem);
}

async function lockPriceRules(client) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('billing_price_rules'))`);
  await client.query("SET LOCAL jit = off");
}

const rateOn = (code) =>
  `(SELECT c.rate FROM category_item_rates c
     WHERE c.service_item_id = e.item_id AND c.scheme_code = ${code} AND c.rate IS NOT NULL
       AND c.valid_from <= e.day AND (c.valid_to IS NULL OR c.valid_to >= e.day)
     ORDER BY c.valid_from DESC LIMIT 1)`;

const conflictsSql = (rules, items) => `
  WITH rules AS (${rules}),
  pairs AS (
    SELECT r.*, i.id AS item_id, i.code AS item_code, i.name AS item_name, i.base_price,
           sg.code AS subgroup_code
      FROM rules r
      JOIN service_items i ON i.is_active ${items}
      JOIN service_subgroups sg ON sg.id = i.subgroup_id
     WHERE (r.group_id IS NULL OR sg.group_id = r.group_id)
       AND (r.subgroup_id IS NULL OR i.subgroup_id = r.subgroup_id)
       AND (r.service_item_id IS NULL OR i.id = r.service_item_id)
  ),
  billed AS (
    SELECT p.*, b.code AS billed_code, b.parent_code AS billed_parent,
           CASE WHEN b.code <> p.scheme_code THEN b.label END AS sub_category
      FROM pairs p
      JOIN patient_schemes b
        ON b.code = p.scheme_code OR (b.parent_code = p.scheme_code AND b.is_active)
  ),
  keyed AS (
    SELECT DISTINCT item_id, base_price, billed_code, billed_parent FROM billed
  ),
  edges AS (
    SELECT k.*, d.day
      FROM keyed k
     CROSS JOIN LATERAL (
       SELECT '-infinity'::date AS day
       UNION
       SELECT x.edge
         FROM category_item_rates c
        CROSS JOIN LATERAL (VALUES (c.valid_from), (c.valid_to + 1)) AS x(edge)
        WHERE c.service_item_id = k.item_id
          AND c.scheme_code IN (k.billed_code, k.billed_parent)
          AND x.edge IS NOT NULL
     ) d
  ),
  timeline AS (
    SELECT e.item_id, e.billed_code, e.day,
           lead(e.day) OVER (PARTITION BY e.item_id, e.billed_code ORDER BY e.day) AS next_day,
           COALESCE(${rateOn("e.billed_code")}, ${rateOn("e.billed_parent")}, e.base_price) AS price
      FROM edges e
  ),
  worst AS (
    SELECT DISTINCT ON (q.rule_id, q.item_id) q.*, t.price,
           GREATEST(t.day, q.valid_from) AS day
      FROM billed q
      JOIN timeline t ON t.item_id = q.item_id AND t.billed_code = q.billed_code
     WHERE t.day <= COALESCE(q.valid_to, 'infinity'::date)
       AND (t.next_day IS NULL OR t.next_day > q.valid_from)
       AND t.price < q.patient_value
     ORDER BY q.rule_id, q.item_id, t.price, GREATEST(t.day, q.valid_from), q.sub_category NULLS FIRST
  )
  SELECT w.rule_id, w.rule_name, w.patient_value::float8 AS amount,
         CASE WHEN sp.code IS NULL THEN s.label ELSE sp.label || ' › ' || s.label END AS category,
         w.item_id AS id, w.item_code AS code, w.item_name AS name, w.price::float8 AS price,
         w.sub_category, w.billed_code, w.billed_parent, w.subgroup_code,
         CASE WHEN w.day > w.valid_from THEN w.day::text END AS from_day
    FROM worst w
    JOIN patient_schemes s ON s.code = w.scheme_code
    LEFT JOIN patient_schemes sp ON sp.code = s.parent_code
   ORDER BY w.price, w.item_name, w.item_id, w.rule_name`;

const shapeConflict = ({ from_day, ...row }) => ({ ...row, from: from_day });

export async function itemsPricedBelow(client, rule, amount) {
  await lockPriceRules(client);
  const { rows } = await client.query(
    conflictsSql(
      `SELECT NULL::int AS rule_id, NULL::text AS rule_name, $4::text AS scheme_code,
              $1::int AS group_id, $2::int AS subgroup_id, $3::int AS service_item_id,
              $7::numeric AS patient_value, $5::date AS valid_from, $6::date AS valid_to`,
      "",
    ),
    [
      rule.group_id,
      rule.subgroup_id,
      rule.service_item_id,
      rule.scheme_code,
      rule.valid_from,
      rule.valid_to,
      amount,
    ],
  );
  return rows.map(shapeConflict).map(({ id, code, name, price, sub_category, from }) => ({
    id,
    code,
    name,
    price,
    sub_category,
    from,
  }));
}

const priceText = (item) =>
  `${item.name} (${rupees(item.price)}${item.from ? ` from ${item.from}` : ""}${item.sub_category ? ` for ${item.sub_category}` : ""})`;

export const conflictText = (conflict) =>
  `${priceText(conflict)} is below the ${rupees(conflict.amount)} the payment rule "${conflict.rule_name}" (${conflict.category}) has the patient pay`;

export async function priceConflicts(client, { itemIds = null, schemeCodes = null } = {}) {
  const params = [];
  let items = "";
  let scope = "";
  if (itemIds) {
    const ids = [...new Set(itemIds.filter((id) => Number.isInteger(id)))];
    if (!ids.length) return [];
    params.push(ids);
    items = `AND i.id = ANY($${params.length}::int[])`;
  }
  if (schemeCodes) {
    const codes = [...new Set(schemeCodes.filter(Boolean))];
    if (!codes.length) return [];
    params.push(codes);
    const n = params.length;
    scope = `AND (scheme_code = ANY($${n}::text[])
                  OR scheme_code IN (SELECT parent_code FROM patient_schemes WHERE code = ANY($${n}::text[])))`;
  }
  await lockPriceRules(client);
  const { rows } = await client.query(
    conflictsSql(
      `SELECT id AS rule_id, name AS rule_name, scheme_code, group_id, subgroup_id,
              service_item_id, patient_value, valid_from, valid_to
         FROM category_payment_rules
        WHERE is_active AND patient_pays = 'amount' ${scope}`,
      items,
    ),
    params,
  );
  return rows.map(shapeConflict);
}

export function throwPriceConflicts(conflicts) {
  if (!conflicts.length) return;
  const shown = conflicts.slice(0, SHOWN_ITEMS).map(conflictText).join("; ");
  const more = conflicts.length > SHOWN_ITEMS ? `; and ${conflicts.length - SHOWN_ITEMS} more` : "";
  throw httpError(
    409,
    `This price is too low for a payment rule: ${shown}${more}. Change or deactivate that rule first, or keep the price at or above its amount.`,
    { conflicts },
  );
}

export async function checkItemPrices(client, itemIds) {
  throwPriceConflicts(await priceConflicts(client, { itemIds }));
}

export async function checkCategoryPrices(client, schemeCode) {
  throwPriceConflicts(await priceConflicts(client, { schemeCodes: [schemeCode] }));
}

async function checkAmountCovers(client, rule) {
  if (rule.patient_pays !== "amount") return;
  const cheaper = await itemsPricedBelow(client, rule, rule.patient_value);
  if (!cheaper.length) return;
  throw httpError(409, tooCheapText(rule.patient_value, cheaper), { items: cheaper });
}

export function tooCheapText(amount, items) {
  const shown = items.slice(0, SHOWN_ITEMS).map(priceText).join(", ");
  const more = items.length > SHOWN_ITEMS ? ` and ${items.length - SHOWN_ITEMS} more` : "";
  return `The patient can't pay ${rupees(amount)} for items that cost less: ${shown}${more}. Lower the amount, or put the rule on only the items it is meant for.`;
}

const duplicateName = (error) =>
  error?.code === "23505"
    ? httpError(409, "This category already has a payment rule with that name")
    : error;

async function validate(client, rule, { id = null, before = null } = {}) {
  checkShape(rule);
  const changed = (key) => !before || String(before[key]) !== String(rule[key]);
  const category = await loadCategory(client, rule.scheme_code);
  const reviving = before && !before.is_active && rule.is_active;
  if ((changed("scheme_code") || reviving) && !category.active) {
    throw httpError(409, `${category.name} is retired; bring it back first`);
  }
  if (SCOPES.some(changed) || reviving) await checkScope(client, rule);
  if (changed("name") || changed("scheme_code")) {
    await checkNameFree(client, rule.scheme_code, rule.name, id);
  }
  if (rule.is_active === false) return;
  checkPayer(category, rule);
  await checkAmountCovers(client, rule);
}

const LIST_COLUMNS = COLUMNS.map((c) => `r.${c}`).join(", ");

export async function listPaymentRules({ schemeCode, activeOnly = false } = {}, db = pool) {
  const where = [];
  const params = [];
  if (schemeCode) {
    params.push(cleanScheme(schemeCode));
    where.push(
      `(r.scheme_code = $1 OR r.scheme_code = (SELECT parent_code FROM patient_schemes WHERE code = $1))`,
    );
  }
  if (activeOnly) where.push("r.is_active");
  const { rows } = await db.query(
    `SELECT ${LIST_COLUMNS},
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS category_label,
            CASE WHEN r.service_item_id IS NOT NULL THEN 'item'
                 WHEN r.subgroup_id IS NOT NULL THEN 'subgroup'
                 WHEN r.group_id IS NOT NULL THEN 'group'
                 ELSE 'category' END AS scope,
            COALESCE(i.name, sg.name, g.name) AS scope_label,
            ${schemeCode ? "r.scheme_code <> $1" : "FALSE"} AS inherited
       FROM category_payment_rules r
       JOIN patient_schemes s ON s.code = r.scheme_code
       LEFT JOIN patient_schemes p ON p.code = s.parent_code
       LEFT JOIN service_groups g ON g.id = r.group_id
       LEFT JOIN service_subgroups sg ON sg.id = r.subgroup_id
       LEFT JOIN service_items i ON i.id = r.service_item_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.parent_code IS NULL, r.scheme_code, r.priority, r.id`,
    params,
  );
  return rows.map(shape);
}

export async function createPaymentRule(input, ctx, db = pool) {
  const values = cleanInput(input, { partial: false });
  return inTransaction(async (client) => {
    await validate(client, { ...values, is_active: true });
    const keys = Object.keys(values);
    const { rows } = await client
      .query(
        `INSERT INTO category_payment_rules (${keys.join(", ")}, created_by, updated_by)
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, $${keys.length + 1}, $${keys.length + 1})
         RETURNING ${SPEC.columns}`,
        [...keys.map((k) => values[k]), ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw duplicateName(error);
      });
    const rule = shape(rows[0]);
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: rule.id,
      action: "create",
      after: rule,
      ...auditFields(ctx),
    });
    return rule;
  }, db);
}

export async function updatePaymentRule(id, input, ctx, db = pool) {
  const values = cleanInput(input, { partial: true });
  const keys = Object.keys(values);
  if (!keys.length) throw httpError(400, "Nothing to change");
  return inTransaction(async (client) => {
    const before = shape(await lockRow(client, SPEC, id));
    await validate(client, { ...before, ...values }, { id, before });
    const { rows } = await client
      .query(
        `UPDATE category_payment_rules
            SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")},
                updated_at = NOW(), updated_by = $${keys.length + 2}
          WHERE id = $1
          RETURNING ${SPEC.columns}`,
        [id, ...keys.map((k) => values[k]), ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw duplicateName(error);
      });
    const rule = shape(rows[0]);
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: id,
      action: "update",
      before,
      after: rule,
      ...auditFields(ctx),
    });
    return rule;
  }, db);
}

export async function setPaymentRuleActive(id, value, ctx, db = pool) {
  const active = cleanActive(value);
  return inTransaction(async (client) => {
    const before = shape(await lockRow(client, SPEC, id));
    if (before.is_active === active) return before;
    if (active) await validate(client, { ...before, is_active: true }, { id, before });
    const { rows } = await client.query(
      `UPDATE category_payment_rules SET is_active = $2, updated_at = NOW(), updated_by = $3
        WHERE id = $1 RETURNING ${SPEC.columns}`,
      [id, active, ctx?.actorId ?? null],
    );
    const rule = shape(rows[0]);
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: id,
      action: active ? "activate" : "deactivate",
      before,
      after: rule,
      ...auditFields(ctx),
    });
    return rule;
  }, db);
}

export async function deletePaymentRule(id, ctx, db = pool) {
  return inTransaction(async (client) => {
    const before = shape(await lockRow(client, SPEC, id));
    await client.query("SAVEPOINT billing_delete");
    try {
      await client.query(`DELETE FROM category_payment_rules WHERE id = $1`, [id]);
    } catch (error) {
      if (error.code !== "23503") throw error;
      await client.query("ROLLBACK TO SAVEPOINT billing_delete");
      throw httpError(
        409,
        `The payment rule "${before.name}" can't be deleted because it is still referenced. Deactivate it instead.`,
      );
    }
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: id,
      action: "delete",
      before,
      ...auditFields(ctx),
    });
    return { deleted: true, id };
  }, db);
}

export async function checkClaimPayers(client, schemeCode) {
  const { rows } = await client.query(
    `SELECT r.id, r.name,
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS category
       FROM category_payment_rules r
       JOIN patient_schemes s ON s.code = r.scheme_code
       LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE (s.code = $1 OR s.parent_code = $1)
        AND r.is_active AND r.remainder = 'claim' AND r.patient_pays <> 'full'
        AND COALESCE(s.payer_name, p.payer_name) IS NULL
      ORDER BY s.parent_code IS NOT NULL, s.label, r.name`,
    [schemeCode],
  );
  if (!rows.length) return;
  const shown = rows
    .slice(0, SHOWN_ITEMS)
    .map((r) => `"${r.name}" (${r.category})`)
    .join(", ");
  const more = rows.length > SHOWN_ITEMS ? ` and ${rows.length - SHOWN_ITEMS} more` : "";
  throw httpError(
    409,
    `This would leave no payer name for ${rows.length} payment rule${rows.length === 1 ? " that sends" : "s that send"} the rest to claim: ${shown}${more}. Keep a payer name, or send those rules' rest to adjustment first.`,
    { rules: rows },
  );
}

export async function checkBillable(db, code) {
  const { rows } = await db.query(
    `SELECT CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS name,
            s.is_active AND COALESCE(p.is_active, TRUE) AS active,
            EXISTS (SELECT 1 FROM patient_schemes c WHERE c.parent_code = s.code AND c.is_active)
              AS has_children
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1`,
    [code],
  );
  if (!rows.length) throw httpError(404, "That category doesn't exist");
  const [category] = rows;
  if (!category.active) throw httpError(409, `${category.name} is retired`);
  if (category.has_children) {
    throw httpError(
      409,
      `${category.name} has sub-categories, so a line can't be billed under it: choose one of its sub-categories`,
    );
  }
}

const SCOPE_RANK = `CASE WHEN r.service_item_id IS NOT NULL THEN 0
                         WHEN r.subgroup_id IS NOT NULL THEN 1
                         WHEN r.group_id IS NOT NULL THEN 2
                         ELSE 3 END`;

const NO_RULE = {
  rule: null,
  patient_pays: "full",
  patient_value: null,
  remainder: null,
  scope: null,
  from_parent: false,
};

export async function ruleForLine({ category, item, visitType = null, date } = {}, db = pool) {
  const itemId = cleanScopeId(item, "service_item_id");
  if (itemId === null) throw httpError(400, "Choose a valid item");
  const on = cleanDate(date, "Date") ?? indiaToday();
  if (category !== undefined && category !== null && typeof category !== "string") {
    throw httpError(400, "Category must be a category code");
  }
  const code = (category ?? "").trim().toLowerCase();
  if (visitType !== null && visitType !== undefined && !VISIT_TYPES.includes(visitType)) {
    throw httpError(400, `Visit type must be one of: ${VISIT_TYPES.join(", ")}`);
  }
  const { rows: found } = await db.query(
    `SELECT i.id, i.subgroup_id, sg.group_id
       FROM service_items i JOIN service_subgroups sg ON sg.id = i.subgroup_id
      WHERE i.id = $1`,
    [itemId],
  );
  if (!found.length) throw httpError(404, "That item doesn't exist");
  if (!code || RESERVED_CATEGORY_CODES.includes(code)) return NO_RULE;
  await checkBillable(db, code);
  const { rows } = await db.query(
    `SELECT ${LIST_COLUMNS}, r.scheme_code <> $1 AS from_parent, ${SCOPE_RANK} AS rank
       FROM category_payment_rules r
      WHERE r.is_active
        AND (r.scheme_code = $1
             OR r.scheme_code = (SELECT parent_code FROM patient_schemes WHERE code = $1))
        AND r.valid_from <= $2::date
        AND (r.valid_to IS NULL OR r.valid_to >= $2::date)
        AND (r.visit_types IS NULL OR $3::text = ANY (r.visit_types))
        AND (r.service_item_id = $4
             OR r.subgroup_id = $5
             OR r.group_id = $6
             OR (r.service_item_id IS NULL AND r.subgroup_id IS NULL AND r.group_id IS NULL))
      ORDER BY r.scheme_code <> $1, ${SCOPE_RANK}, r.priority, r.id
      LIMIT 1`,
    [code, on, visitType ?? null, found[0].id, found[0].subgroup_id, found[0].group_id],
  );
  if (!rows.length) return NO_RULE;
  const { from_parent, rank, ...rule } = shape(rows[0]);
  return {
    rule,
    patient_pays: rule.patient_pays,
    patient_value: rule.patient_value,
    remainder: rule.remainder,
    scope: ["item", "subgroup", "group", "category"][rank],
    from_parent,
  };
}
