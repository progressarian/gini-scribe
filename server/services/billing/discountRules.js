import pool from "../../config/db.js";
import {
  BILLING_ROLES,
  DISCOUNT_KINDS,
  DISCOUNT_METHODS,
  GENDERS,
  RESERVED_CATEGORY_CODES,
  VISIT_TYPES,
} from "../../../shared/billingVocab.js";
import { writeAudit } from "./audit.js";
import { getSettings } from "./billingSettings.js";
import { indiaToday, normalizeGender } from "./categoryResolver.js";
import { httpError, inTransaction } from "./transaction.js";
import {
  auditFields,
  cleanActive,
  cleanDate,
  cleanFlag,
  cleanName,
  cleanPriority,
  cleanVisitTypes,
  hasField,
  INT_MAX,
  lockRow,
  MONEY_MAX,
  readNumber,
  wholeNumber,
} from "./common.js";

const COLUMNS = [
  "id",
  "code",
  "name",
  "method",
  "kind",
  "value",
  "max_discount",
  "group_ids",
  "subgroup_ids",
  "service_item_ids",
  "doctor_ids",
  "visit_types",
  "scheme_codes",
  "min_age",
  "max_age",
  "gender",
  "valid_from::text AS valid_from",
  "valid_to::text AS valid_to",
  "max_uses_total",
  "max_uses_per_patient",
  "max_uses_per_day",
  "max_uses_per_doctor_per_day",
  "applies_per",
  "priority",
  "stackable",
  "applies_on_scheme_rate",
  "allowed_roles",
  "is_active",
  "created_at",
  "updated_at",
];

const SPEC = { table: "discount_rules", noun: "discount", columns: COLUMNS.join(", ") };
const LIMITS = [
  "max_uses_total",
  "max_uses_per_patient",
  "max_uses_per_day",
  "max_uses_per_doctor_per_day",
];
const APPLIES_PER = ["line", "bill"];
const AGE_MAX = 150;
const MONEY_COLUMNS = ["value", "max_discount"];

const TARGETS = {
  group_ids: { table: "service_groups", noun: "group", label: "Groups" },
  subgroup_ids: { table: "service_subgroups", noun: "subgroup", label: "Subgroups" },
  service_item_ids: { table: "service_items", noun: "item", label: "Items" },
  doctor_ids: { table: "doctors", noun: "doctor", label: "Doctors" },
};

const shape = (row) =>
  row && {
    ...row,
    ...Object.fromEntries(
      MONEY_COLUMNS.map((column) => [column, row[column] === null ? null : Number(row[column])]),
    ),
  };

function cleanCode(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw httpError(400, "Code must be text");
  const code = value.trim();
  if (!code) return null;
  if (/\s/.test(code)) throw httpError(400, "Code can't contain spaces");
  return code;
}

const oneOf = (list, label) => (value) => {
  if (!list.includes(value)) throw httpError(400, `${label} must be one of: ${list.join(", ")}`);
  return value;
};

function cleanAmount(value, label) {
  const n = readNumber(value, `${label} must be a number`);
  return n === undefined ? null : n;
}

function cleanIds(value, key) {
  if (value === undefined || value === null || value === "") return null;
  const message = `${TARGETS[key].label} must be a list of ids`;
  if (!Array.isArray(value)) throw httpError(400, message);
  const ids = value.map((v) => readNumber(v, message));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0 || id > INT_MAX)) {
    throw httpError(400, message);
  }
  const unique = [...new Set(ids)];
  return unique.length ? unique : null;
}

function cleanSchemeCodes(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw httpError(400, "Categories must be a list of category codes");
  }
  const codes = [...new Set(value.map((v) => v.trim().toLowerCase()).filter(Boolean))];
  return codes.length ? codes : null;
}

function cleanRoles(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!Array.isArray(value)) throw httpError(400, "Roles must be a list");
  const unknown = value.filter((v) => !BILLING_ROLES.includes(v));
  if (unknown.length) {
    throw httpError(400, `Roles must be from: ${BILLING_ROLES.join(", ")}`);
  }
  const chosen = BILLING_ROLES.filter((role) => value.includes(role));
  return chosen.length ? chosen : null;
}

function cleanAge(value, label) {
  const age = wholeNumber(value, label, { min: 0, max: AGE_MAX });
  return age === undefined ? null : age;
}

function cleanGender(value) {
  if (value === undefined || value === null || value === "") return null;
  return oneOf(GENDERS, "Gender")(value);
}

function cleanLimit(value, label) {
  const limit = wholeNumber(value, label, { min: 1 });
  return limit === undefined ? null : limit;
}

const LIMIT_LABELS = {
  max_uses_total: "Total uses",
  max_uses_per_patient: "Uses per patient",
  max_uses_per_day: "Uses per day",
  max_uses_per_doctor_per_day: "Uses per doctor per day",
};

const CLEANERS = {
  code: cleanCode,
  name: cleanName,
  method: oneOf(DISCOUNT_METHODS, "Method"),
  kind: oneOf(DISCOUNT_KINDS, "Kind"),
  value: (v) => cleanAmount(v, "Value"),
  max_discount: (v) => cleanAmount(v, "Largest discount"),
  group_ids: (v) => cleanIds(v, "group_ids"),
  subgroup_ids: (v) => cleanIds(v, "subgroup_ids"),
  service_item_ids: (v) => cleanIds(v, "service_item_ids"),
  doctor_ids: (v) => cleanIds(v, "doctor_ids"),
  visit_types: cleanVisitTypes,
  scheme_codes: cleanSchemeCodes,
  min_age: (v) => cleanAge(v, "From age"),
  max_age: (v) => cleanAge(v, "To age"),
  gender: cleanGender,
  valid_from: (v) => cleanDate(v, "From date"),
  valid_to: (v) => cleanDate(v, "To date"),
  ...Object.fromEntries(LIMITS.map((key) => [key, (v) => cleanLimit(v, LIMIT_LABELS[key])])),
  applies_per: (v) =>
    v === undefined || v === null || v === "" ? "line" : oneOf(APPLIES_PER, "Applies per")(v),
  priority: cleanPriority,
  stackable: (v) => (v === undefined || v === null ? false : cleanFlag(v, "Stackable")),
  applies_on_scheme_rate: (v) =>
    v === undefined || v === null ? false : cleanFlag(v, "Also on payment-rule lines"),
  allowed_roles: cleanRoles,
};
const EDITABLE = Object.keys(CLEANERS);

function cleanInput(input, { partial }) {
  const out = {};
  for (const key of EDITABLE) {
    if (hasField(input, key)) out[key] = CLEANERS[key](input[key]);
    else if (!partial) out[key] = CLEANERS[key](undefined);
  }
  if (out.method === "auto" && !hasField(input, "code")) out.code = null;
  if (out.method === "auto" && !hasField(input, "allowed_roles")) out.allowed_roles = null;
  if (out.kind && out.kind !== "percent" && !hasField(input, "max_discount")) {
    out.max_discount = null;
  }
  return out;
}

function moneyProblem(value, label) {
  if (value < 0) return `${label} can't be negative`;
  if (value > MONEY_MAX) return `${label} is too large (at most ${MONEY_MAX})`;
  if (Number(value.toFixed(2)) !== value) return `${label} can have at most 2 decimals (paise)`;
  return null;
}

export function discountShapeProblem(rule) {
  const problem = (field, message) => ({ field, message });
  if (rule.method === "code" && !rule.code) {
    return problem("code", "A discount the desk enters by code needs a code");
  }
  if (rule.method === "auto" && rule.code) {
    return problem(
      "code",
      "An automatic discount applies by itself, so it has no code; leave the code empty",
    );
  }
  if (rule.method === "auto" && rule.allowed_roles) {
    return problem(
      "allowed_roles",
      "An automatic discount applies by itself, so no desk role enters it; leave the roles empty",
    );
  }
  if (rule.value === null) return problem("value", "Enter the discount's value");
  if (rule.value === 0 && rule.kind === "percent") {
    return problem("value", "A 0% discount takes nothing off; enter more than 0");
  }
  if (rule.value === 0 && rule.kind === "flat") {
    return problem("value", "A ₹0 discount takes nothing off; enter more than 0");
  }
  if (rule.kind === "percent") {
    if (rule.value < 0 || rule.value > 100) {
      return problem("value", "A percent discount must be more than 0 and at most 100");
    }
    if (Number(rule.value.toFixed(2)) !== rule.value) {
      return problem("value", "The percent can have at most 2 decimals");
    }
  } else {
    const money = moneyProblem(
      rule.value,
      rule.kind === "flat" ? "The amount off" : "The fixed price",
    );
    if (money) return problem("value", money);
  }
  if (rule.max_discount !== null) {
    if (rule.kind !== "percent") {
      return problem("max_discount", "Only a percent discount can have a largest discount");
    }
    const money = moneyProblem(rule.max_discount, "The largest discount");
    if (money) return problem("max_discount", money);
    if (rule.max_discount === 0) {
      return problem(
        "max_discount",
        "A largest discount of ₹0 would take nothing off; enter more than 0, or leave it empty for no limit",
      );
    }
  }
  if (rule.kind === "fixed_price" && rule.applies_per === "bill") {
    return problem(
      "applies_per",
      "A fixed price sets the price of each line, so it can't apply to the whole bill",
    );
  }
  if (rule.min_age !== null && rule.max_age !== null && rule.min_age > rule.max_age) {
    return problem("max_age", "From age can't be more than To age");
  }
  if (rule.valid_from !== null && rule.valid_to !== null && rule.valid_to < rule.valid_from) {
    return problem("valid_to", "To date can't be before the From date");
  }
  return null;
}

function checkShape(rule) {
  const problem = discountShapeProblem(rule);
  if (problem) throw httpError(400, problem.message);
}

async function checkTargets(client, rule, before) {
  for (const [key, { table, noun }] of Object.entries(TARGETS)) {
    const ids = rule[key];
    if (!ids) continue;
    const { rows } = await client.query(
      `SELECT id, name, is_active FROM ${table} WHERE id = ANY($1::int[]) FOR SHARE`,
      [ids],
    );
    const found = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw httpError(
        404,
        `${missing.length === 1 ? `That ${noun} doesn't` : `${missing.length} of the ${noun}s don't`} exist (id ${missing.join(", ")})`,
      );
    }
    const kept = new Set(before?.[key] ?? []);
    const off = rows.filter((r) => !r.is_active && !kept.has(r.id)).map((r) => r.name);
    if (off.length) {
      throw httpError(409, `Deactivated ${noun}${off.length === 1 ? "" : "s"}: ${off.join(", ")}`);
    }
  }
}

async function checkCategories(client, rule, before) {
  const codes = (rule.scheme_codes ?? []).filter((c) => !RESERVED_CATEGORY_CODES.includes(c));
  if (!codes.length) return;
  const { rows } = await client.query(
    `SELECT s.code, s.parent_code, s.is_active AND COALESCE(p.is_active, TRUE) AS active,
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS name,
            p.label AS parent_label
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = ANY($1::text[])
        FOR SHARE OF s`,
    [codes],
  );
  const found = new Map(rows.map((r) => [r.code, r]));
  const missing = codes.filter((c) => !found.has(c));
  if (missing.length) {
    throw httpError(
      404,
      `Unknown categor${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}`,
    );
  }
  const kept = new Set(before?.scheme_codes ?? []);
  const retired = rows.filter((r) => !r.active && !kept.has(r.code)).map((r) => r.name);
  if (retired.length) throw httpError(409, `Retired: ${retired.join(", ")}`);
  const covered = rows.filter((r) => r.parent_code && found.has(r.parent_code));
  if (covered.length) {
    throw httpError(
      400,
      `${covered[0].parent_label} already covers its sub-categories, so ${covered.map((r) => r.name).join(", ")} ${covered.length === 1 ? "is" : "are"} already included; choose the category or its sub-categories, not both`,
    );
  }
}

async function checkCodeFree(client, rule, id) {
  if (!rule.code) return;
  const taken = await client.query(
    `SELECT name FROM discount_rules WHERE lower(code) = lower($1) AND id IS DISTINCT FROM $2`,
    [rule.code, id],
  );
  if (taken.rows.length) {
    throw httpError(409, `The discount "${taken.rows[0].name}" already uses the code ${rule.code}`);
  }
  const { rows } = await client.query(
    `SELECT r.bill_code, i.name AS item,
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS category
       FROM category_item_rates r
       JOIN service_items i ON i.id = r.service_item_id
       JOIN patient_schemes s ON s.code = r.scheme_code
       LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE lower(r.bill_code) = lower($1)
      LIMIT 1`,
    [rule.code],
  );
  if (rows.length) {
    throw httpError(
      409,
      `${rows[0].bill_code} is already the bill code of ${rows[0].item} for ${rows[0].category}; choose another discount code`,
    );
  }
}

async function checkNameFree(client, name, id) {
  const { rows } = await client.query(
    `SELECT name FROM discount_rules WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2`,
    [name, id],
  );
  if (rows.length) throw httpError(409, `There is already a discount called "${rows[0].name}"`);
}

function explainWriteError(error) {
  if (error?.code === "23505") {
    return httpError(
      409,
      error.message.includes("bill code") || error.message.includes("discount code")
        ? error.message
        : "That code or name is already used by another discount",
    );
  }
  if (error?.code === "23503") return httpError(409, error.message);
  return error;
}

const sameList = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function validate(client, rule, { id = null, before = null } = {}) {
  checkShape(rule);
  const changed = (key) =>
    !before ||
    (Array.isArray(rule[key]) || Array.isArray(before[key])
      ? !sameList(rule[key], before[key])
      : before[key] !== rule[key]);
  const reviving = before && !before.is_active && rule.is_active;
  if (Object.keys(TARGETS).some(changed) || reviving) {
    await checkTargets(client, rule, reviving ? null : before);
  }
  if (changed("scheme_codes") || reviving) {
    await checkCategories(client, rule, reviving ? null : before);
  }
  if (changed("code") || reviving) await checkCodeFree(client, rule, id);
  if (changed("name")) await checkNameFree(client, rule.name, id);
}

const NAMES = `
  (SELECT array_agg(g.name ORDER BY g.name) FROM service_groups g WHERE g.id = ANY(d.group_ids)) AS group_names,
  (SELECT array_agg(s.name ORDER BY s.name) FROM service_subgroups s WHERE s.id = ANY(d.subgroup_ids)) AS subgroup_names,
  (SELECT array_agg(i.name ORDER BY i.name) FROM service_items i WHERE i.id = ANY(d.service_item_ids)) AS item_names,
  (SELECT array_agg(dr.name ORDER BY dr.name) FROM doctors dr WHERE dr.id = ANY(d.doctor_ids)) AS doctor_names,
  (SELECT array_agg(CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END ORDER BY s.label)
     FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
    WHERE s.code = ANY(d.scheme_codes)) AS category_names`;

export async function listDiscountRules({ activeOnly = false, method } = {}, db = pool) {
  const where = [];
  const params = [];
  if (activeOnly) where.push("d.is_active");
  if (method) {
    params.push(oneOf(DISCOUNT_METHODS, "Method")(method));
    where.push(`d.method = $${params.length}`);
  }
  const { rows } = await db.query(
    `SELECT ${COLUMNS.map((c) => `d.${c}`).join(", ")}, ${NAMES}
       FROM discount_rules d
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY d.priority, lower(d.name), d.id`,
    params,
  );
  return rows.map(shape);
}

export async function createDiscountRule(input, ctx, db = pool) {
  const values = cleanInput(input, { partial: false });
  return inTransaction(async (client) => {
    await validate(client, { ...values, is_active: true });
    const keys = Object.keys(values);
    const { rows } = await client
      .query(
        `INSERT INTO discount_rules (${keys.join(", ")}, created_by, updated_by)
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, $${keys.length + 1}, $${keys.length + 1})
         RETURNING ${SPEC.columns}`,
        [...keys.map((k) => values[k]), ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw explainWriteError(error);
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

export async function updateDiscountRule(id, input, ctx, db = pool) {
  const values = cleanInput(input, { partial: true });
  const keys = Object.keys(values);
  if (!keys.length) throw httpError(400, "Nothing to change");
  return inTransaction(async (client) => {
    const before = shape(await lockRow(client, SPEC, id));
    await validate(client, { ...before, ...values }, { id, before });
    const { rows } = await client
      .query(
        `UPDATE discount_rules
            SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")},
                updated_at = NOW(), updated_by = $${keys.length + 2}
          WHERE id = $1
          RETURNING ${SPEC.columns}`,
        [id, ...keys.map((k) => values[k]), ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw explainWriteError(error);
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

export async function setDiscountRuleActive(id, value, ctx, db = pool) {
  const active = cleanActive(value);
  return inTransaction(async (client) => {
    const before = shape(await lockRow(client, SPEC, id));
    if (before.is_active === active) return before;
    if (active) await validate(client, { ...before, is_active: true }, { id, before });
    const { rows } = await client.query(
      `UPDATE discount_rules SET is_active = $2, updated_at = NOW(), updated_by = $3
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

export async function deleteDiscountRule(id, ctx, db = pool) {
  return inTransaction(async (client) => {
    const before = shape(await lockRow(client, SPEC, id));
    await client.query("SAVEPOINT billing_delete");
    try {
      await client.query(`DELETE FROM discount_rules WHERE id = $1`, [id]);
    } catch (error) {
      if (error.code !== "23503") throw error;
      await client.query("ROLLBACK TO SAVEPOINT billing_delete");
      throw httpError(
        409,
        `The discount "${before.name}" has been used on bills, so it can't be deleted. Deactivate it instead.`,
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

export const CODE_REFUSALS = [
  "unknown",
  "inactive",
  "role",
  "not_yet_valid",
  "expired",
  "too_many_codes",
  "category",
  "patient",
  "items",
  "doctor",
  "visit_type",
  "total_limit",
  "patient_limit",
  "daily_limit",
  "doctor_daily_limit",
];

const LINE_TARGETS = {
  group_ids: "group_id",
  subgroup_ids: "subgroup_id",
  service_item_ids: "item_id",
};

const NO_USES = { total: 0, patient: 0, day: 0, doctor_day: 0 };

const uses = (join = "") => `
   FROM bill_line_discounts d
   JOIN bill_lines l ON l.id = d.bill_line_id
   JOIN bills b ON b.id = l.bill_id ${join}
  WHERE d.rule_id = ANY($1::int[]) AND b.status = 'final' AND l.is_live`;

async function usageTableExists(db) {
  const { rows } = await db.query(
    `SELECT to_regclass('public.bill_line_discounts') IS NOT NULL AS ready`,
  );
  return rows[0].ready;
}

function cleanId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const id = readNumber(value, `${label} must be an id`);
  if (!Number.isInteger(id) || id <= 0 || id > INT_MAX) {
    throw httpError(400, `${label} must be an id`);
  }
  return id;
}

function cleanRuleId(value) {
  const id = cleanId(value, "Discount");
  if (id === null) throw httpError(400, "Choose a valid discount");
  return id;
}

async function usageOf(ruleIds, { patientId, date, doctorId }, db) {
  if (!ruleIds.length || !(await usageTableExists(db))) return new Map();
  const { rows } = await db.query(
    `SELECT d.rule_id,
            count(DISTINCT b.id)::int AS total,
            count(DISTINCT b.id) FILTER (WHERE b.patient_id = $2)::int AS patient,
            count(DISTINCT b.id) FILTER (WHERE b.bill_date = $3::date)::int AS day,
            count(DISTINCT b.id) FILTER (WHERE b.bill_date = $3::date AND l.doctor_id = $4)::int
              AS doctor_day
     ${uses()}
      GROUP BY d.rule_id`,
    [ruleIds, patientId, date, doctorId],
  );
  return new Map(rows.map(({ rule_id: id, ...used }) => [id, used]));
}

export async function ruleUsage(
  ruleId,
  { patientId = null, date, doctorId = null } = {},
  db = pool,
) {
  const id = cleanRuleId(ruleId);
  const used = await usageOf(
    [id],
    {
      patientId: cleanId(patientId, "Patient"),
      date: cleanDate(date, "Date") ?? indiaToday(),
      doctorId: cleanId(doctorId, "Doctor"),
    },
    db,
  );
  return used.get(id) ?? { ...NO_USES };
}

export async function usageToday(ruleId, db = pool) {
  const id = cleanRuleId(ruleId);
  const date = indiaToday();
  if (!(await usageTableExists(db))) return { date, count: 0, by_doctor: [] };
  const { rows: total } = await db.query(
    `SELECT count(DISTINCT b.id)::int AS count ${uses()} AND b.bill_date = $2::date`,
    [[id], date],
  );
  const { rows: byDoctor } = await db.query(
    `SELECT l.doctor_id, dr.name, count(DISTINCT b.id)::int AS count
     ${uses("LEFT JOIN doctors dr ON dr.id = l.doctor_id")}
        AND b.bill_date = $2::date AND l.doctor_id IS NOT NULL
      GROUP BY l.doctor_id, dr.name
      ORDER BY dr.name, l.doctor_id`,
    [[id], date],
  );
  return { date, count: total[0].count, by_doctor: byDoctor };
}

export async function usageTodayOf(ruleIds, db = pool) {
  const ids = [...new Set(ruleIds.map(cleanRuleId))];
  const date = indiaToday();
  const empty = () => ({ date, count: 0, by_doctor: [], total: 0 });
  const usage = new Map(ids.map((id) => [id, empty()]));
  if (!ids.length || !(await usageTableExists(db))) return usage;
  const { rows: totals } = await db.query(
    `SELECT d.rule_id, count(DISTINCT b.id)::int AS total,
            count(DISTINCT b.id) FILTER (WHERE b.bill_date = $2::date)::int AS count
     ${uses()}
      GROUP BY d.rule_id`,
    [ids, date],
  );
  for (const { rule_id: id, ...row } of totals) Object.assign(usage.get(id), row);
  const { rows: byDoctor } = await db.query(
    `SELECT d.rule_id, l.doctor_id, dr.name, count(DISTINCT b.id)::int AS count
     ${uses("LEFT JOIN doctors dr ON dr.id = l.doctor_id")}
        AND b.bill_date = $2::date AND l.doctor_id IS NOT NULL
      GROUP BY d.rule_id, l.doctor_id, dr.name
      ORDER BY dr.name, l.doctor_id`,
    [ids, date],
  );
  for (const { rule_id: id, ...row } of byDoctor) usage.get(id).by_doctor.push(row);
  return usage;
}

export async function listDiscountRulesWithUsage(options = {}, db = pool) {
  const rules = await listDiscountRules(options, db);
  const usage = await usageTodayOf(
    rules.map((rule) => rule.id),
    db,
  );
  return rules.map((rule) => {
    const { total, ...today } = usage.get(rule.id);
    return { ...rule, uses_total: total, usage_today: today };
  });
}

function cleanLine(line) {
  if (line === undefined || line === null) return null;
  if (typeof line !== "object") throw httpError(400, "A line must be an object");
  const visitType = line.visit_type ?? null;
  if (visitType !== null && !VISIT_TYPES.includes(visitType)) {
    throw httpError(400, `Visit type must be one of: ${VISIT_TYPES.join(", ")}`);
  }
  return {
    item_id: cleanId(line.item_id, "Item"),
    subgroup_id: cleanId(line.subgroup_id, "Subgroup"),
    group_id: cleanId(line.group_id, "Group"),
    doctor_id: cleanId(line.doctor_id, "Doctor"),
    visit_type: visitType,
  };
}

function knownAge(value) {
  const age = readNumber(value, "Age must be a number");
  return Number.isInteger(age) && age >= 0 && age <= AGE_MAX ? age : null;
}

function cleanPatient(patient) {
  return {
    id: cleanId(patient?.id, "Patient"),
    age: knownAge(patient?.age),
    gender: normalizeGender(patient?.gender),
  };
}

async function categoryOf(db, category) {
  if (category !== undefined && category !== null && typeof category !== "string") {
    throw httpError(400, "Category must be a category code");
  }
  const code = (category ?? "").trim().toLowerCase();
  if (!code || RESERVED_CATEGORY_CODES.includes(code)) {
    return { codes: RESERVED_CATEGORY_CODES, name: null };
  }
  const { rows } = await db.query(
    `SELECT s.code, s.parent_code,
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS name
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1`,
    [code],
  );
  if (!rows.length) throw httpError(404, "That category doesn't exist");
  return { codes: [rows[0].code, rows[0].parent_code].filter(Boolean), name: rows[0].name };
}

async function matchFacts(line, context, db) {
  const codesOnBill = wholeNumber(context?.codesOnBill, "Codes on the bill");
  return {
    line: cleanLine(line),
    category: await categoryOf(db, context?.category),
    patient: cleanPatient(context?.patient),
    date: cleanDate(context?.date, "Date") ?? indiaToday(),
    role: typeof context?.role === "string" ? context.role : null,
    codesOnBill: codesOnBill ?? 0,
  };
}

function ruleMiss(rule, { line, category, patient }) {
  if (rule.scheme_codes && !rule.scheme_codes.some((c) => category.codes.includes(c))) {
    return "category";
  }
  if (rule.min_age !== null && (patient.age === null || patient.age < rule.min_age)) {
    return "patient";
  }
  if (rule.max_age !== null && (patient.age === null || patient.age > rule.max_age)) {
    return "patient";
  }
  if (rule.gender !== null && patient.gender !== rule.gender) return "patient";
  if (!line || rule.applies_per === "bill") return null;
  const targets = Object.keys(LINE_TARGETS).filter((key) => rule[key]);
  if (targets.length && !targets.some((key) => rule[key].includes(line[LINE_TARGETS[key]]))) {
    return "items";
  }
  if (rule.doctor_ids && !rule.doctor_ids.includes(line.doctor_id)) return "doctor";
  if (rule.visit_types && !rule.visit_types.includes(line.visit_type)) return "visit_type";
  return null;
}

const limitsOf = (rule) => LIMITS.some((key) => rule[key] !== null);

async function usageFor(rules, { line, patient, date }, db) {
  const limited = rules.filter(limitsOf).map((rule) => rule.id);
  return usageOf(limited, { patientId: patient.id, date, doctorId: line?.doctor_id ?? null }, db);
}

function limitMiss(rule, usage, { line }) {
  if (!limitsOf(rule)) return null;
  const used = usage.get(rule.id) ?? NO_USES;
  const checks = [
    ["total_limit", used.total, rule.max_uses_total],
    ["patient_limit", used.patient, rule.max_uses_per_patient],
    ["daily_limit", used.day, rule.max_uses_per_day],
    [
      "doctor_daily_limit",
      used.doctor_day,
      line?.doctor_id ? rule.max_uses_per_doctor_per_day : null,
    ],
  ];
  const hit = checks.find(([, count, limit]) => limit !== null && count >= limit);
  return hit ? { reason: hit[0], used: hit[1], limit: hit[2] } : null;
}

async function tooManyCodes(codesOnBill, db) {
  if (!codesOnBill) return null;
  const { max_codes_per_bill: max } = await getSettings(db);
  return max !== null && codesOnBill >= max ? { max, count: codesOnBill } : null;
}

async function doctorNames(db, ids) {
  const { rows } = await db.query(
    `SELECT name FROM doctors WHERE id = ANY($1::int[]) ORDER BY name`,
    [ids],
  );
  return rows.map((r) => r.name);
}

function ageText(rule) {
  if (rule.min_age !== null && rule.max_age !== null) {
    return `aged ${rule.min_age} to ${rule.max_age}`;
  }
  if (rule.min_age !== null) return `aged ${rule.min_age} and over`;
  if (rule.max_age !== null) return `aged up to ${rule.max_age}`;
  return null;
}

function patientText(rule, patient) {
  const age = ageText(rule);
  const who = `${rule.gender ? `${rule.gender.toLowerCase()} ` : ""}patients${age ? ` ${age}` : ""}`;
  const unknown = [
    age && patient.age === null && "age",
    rule.gender && patient.gender === null && "gender",
  ].filter(Boolean);
  return unknown.length
    ? `${who}, and this patient's ${unknown.join(" and ")} ${unknown.length === 1 ? "isn't" : "aren't"} recorded`
    : who;
}

const MESSAGES = {
  unknown: ({ code }) => `There's no discount with the code ${code}`,
  inactive: ({ rule }) => `The code ${rule.code} is switched off`,
  role: ({ rule, role }) =>
    `The code ${rule.code} can only be entered by ${(rule.allowed_roles ?? BILLING_ROLES).join(", ")}${role ? `, not ${role}` : ""}`,
  not_yet_valid: ({ rule }) => `The code ${rule.code} can't be used before ${rule.valid_from}`,
  expired: ({ rule }) => `The code ${rule.code} expired: it was valid until ${rule.valid_to}`,
  too_many_codes: ({ max, count }) =>
    `A bill can have at most ${max} discount code${max === 1 ? "" : "s"}, and this bill already has ${count}`,
  category: ({ rule, category }) =>
    `The code ${rule.code} isn't for ${category.name ?? "patients with no category"}`,
  patient: ({ rule, patient }) => `The code ${rule.code} is only for ${patientText(rule, patient)}`,
  items: ({ rule }) => `The code ${rule.code} isn't for these items`,
  doctor: ({ rule, line, names }) =>
    line.doctor_id
      ? `The code ${rule.code} isn't for this doctor; it is only for ${names.join(", ")}`
      : `The code ${rule.code} is only for ${names.join(", ")}, and this line has no doctor`,
  visit_type: ({ rule }) =>
    `The code ${rule.code} is only for ${rule.visit_types.join(" or ")} visits`,
  total_limit: ({ used, limit }) => `Total limit reached — ${used} of ${limit} used`,
  patient_limit: ({ used, limit }) => `Limit for this patient reached — ${used} of ${limit} used`,
  daily_limit: ({ used, limit }) => `Daily limit reached — ${used} of ${limit} used today`,
  doctor_daily_limit: ({ name, used, limit }) =>
    `Daily limit for ${name} reached — ${used} of ${limit} used today`,
};

const refuse = (reason, details) => ({ ok: false, reason, message: MESSAGES[reason](details) });

async function codeMiss(rule, facts, db) {
  if (!rule.is_active) return { reason: "inactive" };
  if (!(rule.allowed_roles ?? BILLING_ROLES).includes(facts.role)) return { reason: "role" };
  if (rule.valid_from !== null && facts.date < rule.valid_from) return { reason: "not_yet_valid" };
  if (rule.valid_to !== null && facts.date > rule.valid_to) return { reason: "expired" };
  const crowded = await tooManyCodes(facts.codesOnBill, db);
  if (crowded) return { reason: "too_many_codes", ...crowded };
  const reason = ruleMiss(rule, facts);
  if (reason === "doctor") return { reason, names: await doctorNames(db, rule.doctor_ids) };
  if (reason) return { reason };
  const limit = limitMiss(rule, await usageFor([rule], facts, db), facts);
  if (limit?.reason === "doctor_daily_limit") {
    const [name] = await doctorNames(db, [facts.line.doctor_id]);
    return { ...limit, name };
  }
  return limit;
}

export async function checkCode(code, line, context, db = pool) {
  if (typeof code !== "string" || !code.trim()) throw httpError(400, "Enter a discount code");
  const text = code.trim();
  const facts = await matchFacts(line, context, db);
  const { rows } = await db.query(
    `SELECT ${SPEC.columns} FROM discount_rules WHERE method = 'code' AND lower(code) = lower($1)`,
    [text],
  );
  if (!rows.length) return refuse("unknown", { code: text });
  const rule = shape(rows[0]);
  const miss = await codeMiss(rule, facts, db);
  return miss ? refuse(miss.reason, { ...facts, ...miss, rule }) : { ok: true, rule };
}

export async function autoRulesFor(line, context, db = pool) {
  const facts = await matchFacts(line, context, db);
  const { rows } = await db.query(
    `SELECT ${SPEC.columns} FROM discount_rules
      WHERE is_active AND method = 'auto' AND applies_per = $1
        AND (valid_from IS NULL OR valid_from <= $2::date)
        AND (valid_to IS NULL OR valid_to >= $2::date)
      ORDER BY priority, id`,
    [facts.line ? "line" : "bill", facts.date],
  );
  const candidates = rows.map(shape).filter((rule) => !ruleMiss(rule, facts));
  const usage = await usageFor(candidates, facts, db);
  return candidates.filter((rule) => !limitMiss(rule, usage, facts));
}
