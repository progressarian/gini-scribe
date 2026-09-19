import pool from "../../config/db.js";
import { CATEGORY_RULE_MODES, GENDERS } from "./importColumns.js";
import { writeAudit } from "./audit.js";
import { httpError, inTransaction } from "./transaction.js";
import {
  auditFields,
  cleanActive,
  cleanFlag,
  cleanName,
  hasField,
  INT_MAX,
  lockRow,
  readNumber,
} from "./common.js";

const COLUMNS = [
  "id",
  "scheme_code",
  "name",
  "min_age",
  "max_age",
  "gender",
  "requires_card",
  "mode",
  "priority",
  "is_active",
  "created_at",
  "updated_at",
];

const SPEC = { table: "category_rules", noun: "rule", columns: COLUMNS.join(", ") };
const EDITABLE = [
  "scheme_code",
  "name",
  "min_age",
  "max_age",
  "gender",
  "requires_card",
  "mode",
  "priority",
];

function cleanAge(value, label) {
  const age = readNumber(value, `${label} must be a whole number of years`);
  if (age === undefined) return null;
  if (!Number.isInteger(age) || age < 0 || age > 150) {
    throw httpError(400, `${label} must be a whole number of years, 0 to 150`);
  }
  return age;
}

function cleanGender(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!GENDERS.includes(value))
    throw httpError(400, `Gender must be one of: ${GENDERS.join(", ")}`);
  return value;
}

function cleanMode(value) {
  if (value === undefined || value === null || value === "") return "suggest";
  if (!CATEGORY_RULE_MODES.includes(value)) {
    throw httpError(400, `Mode must be one of: ${CATEGORY_RULE_MODES.join(", ")}`);
  }
  return value;
}

function cleanPriority(value) {
  const priority = readNumber(value, "Priority must be a whole number, 0 or more");
  if (priority === undefined) return 100;
  if (!Number.isInteger(priority) || priority < 0 || priority > INT_MAX) {
    throw httpError(400, "Priority must be a whole number, 0 or more");
  }
  return priority;
}

function cleanScheme(value) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!code) throw httpError(400, "Choose a category");
  return code;
}

const CLEANERS = {
  scheme_code: cleanScheme,
  name: cleanName,
  min_age: (v) => cleanAge(v, "Minimum age"),
  max_age: (v) => cleanAge(v, "Maximum age"),
  gender: cleanGender,
  requires_card: (v) => cleanFlag(v, "Card required"),
  mode: cleanMode,
  priority: cleanPriority,
};

const DEFAULTS = {
  min_age: null,
  max_age: null,
  gender: null,
  requires_card: false,
  mode: "suggest",
  priority: 100,
};

function cleanInput(input, { partial }) {
  const out = {};
  for (const key of EDITABLE) {
    if (hasField(input, key)) out[key] = CLEANERS[key](input[key]);
    else if (!partial) out[key] = key in DEFAULTS ? DEFAULTS[key] : CLEANERS[key](undefined);
  }
  return out;
}

function checkShape(rule) {
  if (rule.min_age !== null && rule.max_age !== null && rule.min_age > rule.max_age) {
    throw httpError(400, "Minimum age can't be more than the maximum age");
  }
  if (
    rule.min_age === null &&
    rule.max_age === null &&
    rule.gender === null &&
    !rule.requires_card
  ) {
    throw httpError(
      400,
      "A rule needs at least one condition (an age, a gender or a card), or it would match every patient",
    );
  }
}

async function checkCategory(client, code) {
  const { rows } = await client.query(
    `SELECT s.label, s.is_active, p.label AS parent_label, p.is_active AS parent_active
       FROM patient_schemes s
       LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1
        FOR SHARE OF s`,
    [code],
  );
  if (!rows.length) throw httpError(404, "That category doesn't exist");
  const category = rows[0];
  const name = category.parent_label
    ? `${category.parent_label} › ${category.label}`
    : category.label;
  if (!category.is_active || category.parent_active === false) {
    throw httpError(409, `${name} is retired; bring it back first`);
  }
  const children = await client.query(
    `SELECT 1 FROM patient_schemes WHERE parent_code = $1 LIMIT 1`,
    [code],
  );
  if (children.rows.length) {
    throw httpError(
      409,
      `${name} has sub-categories, so it can't be billed on its own: put the rule on one of its sub-categories`,
    );
  }
}

async function checkNameFree(client, schemeCode, name, exceptId) {
  const { rows } = await client.query(
    `SELECT name FROM category_rules
      WHERE scheme_code = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3`,
    [schemeCode, name, exceptId],
  );
  if (rows.length) {
    throw httpError(409, `This category already has a rule called "${rows[0].name}"`);
  }
}

async function checkCardForAuto(client, rule) {
  if (rule.mode !== "auto" || rule.requires_card) return;
  const { rows } = await client.query(
    `SELECT CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS name,
            s.requires_ref OR COALESCE(p.requires_ref, FALSE) AS needs_card
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1`,
    [rule.scheme_code],
  );
  if (rows[0]?.needs_card) {
    throw httpError(
      409,
      `${rows[0].name} needs a card number, so an automatic rule for it must also require a card. Tick "card required", or make the rule a suggestion the desk confirms.`,
    );
  }
}

const duplicateName = (error) =>
  error?.code === "23505"
    ? httpError(409, "This category already has a rule with that name")
    : error;

async function validate(client, rule, { id = null, before = null } = {}) {
  checkShape(rule);
  const changed = (key) => !before || before[key] !== rule[key];
  if (changed("scheme_code")) await checkCategory(client, rule.scheme_code);
  if (changed("name") || changed("scheme_code")) {
    await checkNameFree(client, rule.scheme_code, rule.name, id);
  }
  if (["mode", "requires_card", "scheme_code"].some(changed) || (before && !before.is_active)) {
    await checkCardForAuto(client, rule);
  }
}

export async function listRules({ schemeCode, activeOnly = false } = {}, db = pool) {
  const where = [];
  const params = [];
  if (schemeCode) {
    params.push(cleanScheme(schemeCode));
    where.push(`r.scheme_code = $${params.length}`);
  }
  if (activeOnly) where.push("r.is_active");
  const { rows } = await db.query(
    `SELECT ${COLUMNS.map((c) => `r.${c}`).join(", ")},
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS category_label,
            s.is_active AND COALESCE(p.is_active, TRUE) AS category_active
       FROM category_rules r
       JOIN patient_schemes s ON s.code = r.scheme_code
       LEFT JOIN patient_schemes p ON p.code = s.parent_code
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY r.priority, r.id`,
    params,
  );
  return rows;
}

export async function createRule(input, ctx, db = pool) {
  const values = cleanInput(input, { partial: false });
  return inTransaction(async (client) => {
    await validate(client, values);
    const keys = Object.keys(values);
    const { rows } = await client
      .query(
        `INSERT INTO category_rules (${keys.join(", ")}, created_by, updated_by)
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, $${keys.length + 1}, $${keys.length + 1})
         RETURNING ${SPEC.columns}`,
        [...keys.map((k) => values[k]), ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw duplicateName(error);
      });
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: rows[0].id,
      action: "create",
      after: rows[0],
      ...auditFields(ctx),
    });
    return rows[0];
  }, db);
}

export async function updateRule(id, input, ctx, db = pool) {
  const values = cleanInput(input, { partial: true });
  const keys = Object.keys(values);
  if (!keys.length) throw httpError(400, "Nothing to change");
  return inTransaction(async (client) => {
    const before = await lockRow(client, SPEC, id);
    await validate(client, { ...before, ...values }, { id, before });
    const { rows } = await client
      .query(
        `UPDATE category_rules
            SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")},
                updated_at = NOW(), updated_by = $${keys.length + 2}
          WHERE id = $1
          RETURNING ${SPEC.columns}`,
        [id, ...keys.map((k) => values[k]), ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw duplicateName(error);
      });
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: id,
      action: "update",
      before,
      after: rows[0],
      ...auditFields(ctx),
    });
    return rows[0];
  }, db);
}

export async function setRuleActive(id, value, ctx, db = pool) {
  const active = cleanActive(value);
  return inTransaction(async (client) => {
    const before = await lockRow(client, SPEC, id);
    if (before.is_active === active) return before;
    if (active) await validate(client, before, { id });
    const { rows } = await client.query(
      `UPDATE category_rules SET is_active = $2, updated_at = NOW(), updated_by = $3
        WHERE id = $1 RETURNING ${SPEC.columns}`,
      [id, active, ctx?.actorId ?? null],
    );
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: id,
      action: active ? "activate" : "deactivate",
      before,
      after: rows[0],
      ...auditFields(ctx),
    });
    return rows[0];
  }, db);
}

export async function deleteRule(id, ctx, db = pool) {
  return inTransaction(async (client) => {
    const before = await lockRow(client, SPEC, id);
    await client.query("SAVEPOINT billing_delete");
    try {
      await client.query(`DELETE FROM category_rules WHERE id = $1`, [id]);
    } catch (error) {
      if (error.code !== "23503") throw error;
      await client.query("ROLLBACK TO SAVEPOINT billing_delete");
      throw httpError(
        409,
        `The rule "${before.name}" can't be deleted because it is still referenced. Deactivate it instead.`,
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
