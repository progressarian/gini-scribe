import pool from "../../config/db.js";
import {
  CONSULTATION_VISIT_TYPES,
  PATIENT_PAYS,
  RESERVED_CATEGORY_CODES,
} from "../../../shared/billingVocab.js";
import { isLabOnlyDoctor } from "../../../shared/labOnly.js";
import { indiaToday } from "./categoryResolver.js";
import { httpError, inTransaction } from "./transaction.js";
import { cleanDate, hasField, INT_MAX, readNumber } from "./common.js";
import { deleteRate, saveRate } from "./categoryRates.js";
import { createPaymentRule, deletePaymentRule, updatePaymentRule } from "./paymentRules.js";

const GENERAL = RESERVED_CATEGORY_CODES[0];
const RATE_FIELDS = ["fee", "bill_name", "bill_code"];
const RULE_FIELDS = ["patient_pays", "patient_value", "remainder"];
const TAKES_VALUE = ["amount", "percent"];
const SCOPES = ["item", "subgroup", "group", "category"];

const num = (value) => (value === null || value === undefined ? null : Number(value));
const rupees = (amount) => `₹${Number(amount).toLocaleString("en-IN")}`;

function dayBefore(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function cleanId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const id = readNumber(value, `Choose a valid ${label}`);
  if (!Number.isInteger(id) || id <= 0 || id > INT_MAX) {
    throw httpError(400, `Choose a valid ${label}`);
  }
  return id;
}

function cleanCategory(value, label = "a category") {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!code) throw httpError(400, `Choose ${label}`);
  return code;
}

function cleanColumn(value, label) {
  const code = cleanCategory(value, label);
  if (RESERVED_CATEGORY_CODES.includes(code)) {
    throw httpError(
      400,
      "The General fee is the consultation item's own price; change it on the Services page",
    );
  }
  return code;
}

const RATE_ON = (scheme, item, date) => `
  SELECT r.rate, r.bill_name, r.bill_code, r.valid_from::text AS valid_from,
         r.valid_to::text AS valid_to
    FROM category_item_rates r
   WHERE r.scheme_code = ${scheme} AND r.service_item_id = ${item}
     AND r.valid_from <= ${date} AND (r.valid_to IS NULL OR r.valid_to >= ${date})
   ORDER BY r.valid_from DESC LIMIT 1`;

const RULE_MATCH = (date) => `
  r.is_active
  AND r.valid_from <= ${date} AND (r.valid_to IS NULL OR r.valid_to >= ${date})
  AND (r.visit_types IS NULL OR it.visit_type = ANY (r.visit_types))`;

const SCOPE_RANK = `CASE WHEN r.service_item_id IS NOT NULL THEN 0
                         WHEN r.subgroup_id IS NOT NULL THEN 1
                         WHEN r.group_id IS NOT NULL THEN 2
                         ELSE 3 END`;

const RULE_COLUMNS = `r.id, r.name, r.scheme_code, r.patient_pays, r.patient_value, r.remainder,
                      r.valid_from::text AS valid_from, r.valid_to::text AS valid_to,
                      r.visit_types, r.priority`;

const CELLS_SQL = `
  WITH it AS (
    SELECT i.id, i.subgroup_id, sg.group_id, i.visit_type, i.base_price
      FROM service_items i JOIN service_subgroups sg ON sg.id = i.subgroup_id
     WHERE i.id = ANY ($1::int[])
  ),
  cols AS (
    SELECT code, parent_code FROM patient_schemes WHERE code = ANY ($2::text[])
  )
  SELECT it.id AS item_id, c.code,
         own.rate AS own_rate, own.bill_name AS own_bill_name, own.bill_code AS own_bill_code,
         own.valid_from AS own_valid_from, own.valid_to AS own_valid_to,
         par.rate AS parent_rate, par.bill_name AS parent_bill_name,
         par.bill_code AS parent_bill_code,
         (SELECT min(f.valid_from)::text FROM category_item_rates f
           WHERE f.scheme_code = c.code AND f.service_item_id = it.id AND f.valid_from > $3::date)
           AS next_valid_from,
         to_jsonb(orule) AS own_rule,
         to_jsonb(res) AS resolved
    FROM it CROSS JOIN cols c
    LEFT JOIN LATERAL (${RATE_ON("c.code", "it.id", "$3::date")}) own ON TRUE
    LEFT JOIN LATERAL (${RATE_ON("c.parent_code", "it.id", "$3::date")}) par ON TRUE
    LEFT JOIN LATERAL (
      SELECT ${RULE_COLUMNS}
        FROM category_payment_rules r
       WHERE r.scheme_code = c.code AND r.service_item_id = it.id AND ${RULE_MATCH("$3::date")}
       ORDER BY r.priority, r.id LIMIT 1
    ) orule ON TRUE
    LEFT JOIN LATERAL (
      SELECT ${RULE_COLUMNS}, r.scheme_code <> c.code AS from_parent, ${SCOPE_RANK} AS rank
        FROM category_payment_rules r
       WHERE (r.scheme_code = c.code OR r.scheme_code = c.parent_code)
         AND ${RULE_MATCH("$3::date")}
         AND (r.service_item_id = it.id
              OR r.subgroup_id = it.subgroup_id
              OR r.group_id = it.group_id
              OR (r.service_item_id IS NULL AND r.subgroup_id IS NULL AND r.group_id IS NULL))
       ORDER BY r.scheme_code <> c.code, ${SCOPE_RANK}, r.priority, r.id LIMIT 1
    ) res ON TRUE`;

const pick = (own, parent, fallback) =>
  own !== null && own !== undefined
    ? { value: own, source: "own" }
    : parent !== null && parent !== undefined
      ? { value: parent, source: "parent" }
      : { value: fallback, source: fallback === null ? null : "base" };

const ruleShape = (rule) =>
  rule && {
    id: rule.id,
    name: rule.name,
    scheme_code: rule.scheme_code,
    patient_pays: rule.patient_pays,
    patient_value: num(rule.patient_value),
    remainder: rule.remainder,
    valid_from: rule.valid_from,
    valid_to: rule.valid_to,
    visit_types: rule.visit_types,
    priority: rule.priority,
  };

function payShape(resolved, ownRule) {
  if (!resolved) {
    return {
      patient_pays: "full",
      patient_value: null,
      remainder: null,
      rule: null,
      scope: null,
      from_parent: false,
      source: "none",
      inherited: false,
    };
  }
  const own = Boolean(ownRule) && resolved.id === ownRule.id;
  return {
    patient_pays: resolved.patient_pays,
    patient_value: num(resolved.patient_value),
    remainder: resolved.patient_pays === "full" ? null : resolved.remainder,
    rule: ruleShape(resolved),
    scope: SCOPES[resolved.rank],
    from_parent: resolved.from_parent,
    source: own ? "own" : resolved.from_parent ? "parent" : "category",
    inherited: !own,
  };
}

function cellShape(row, item) {
  const fee = pick(num(row.own_rate), num(row.parent_rate), item.base_price);
  const billName = pick(row.own_bill_name, row.parent_bill_name, item.name);
  const billCode = pick(row.own_bill_code, row.parent_bill_code, null);
  const pays = payShape(row.resolved, row.own_rule);
  return {
    fee: fee.value,
    fee_source: fee.source,
    fee_inherited: fee.source !== "own",
    bill_name: billName.value,
    bill_name_source: billName.source,
    bill_code: billCode.value,
    bill_code_source: billCode.source,
    own:
      row.own_valid_from === null
        ? null
        : {
            rate: num(row.own_rate),
            bill_name: row.own_bill_name,
            bill_code: row.own_bill_code,
            valid_from: row.own_valid_from,
            valid_to: row.own_valid_to,
          },
    next_valid_from: row.next_valid_from,
    pays,
    own_rule: ruleShape(row.own_rule),
    pays_inherited: pays.inherited,
    inherited: fee.source !== "own" && pays.source !== "own",
  };
}

const generalCell = (item) => ({
  fee: item.base_price,
  fee_source: "base",
  fee_inherited: false,
  bill_name: item.name,
  bill_name_source: "base",
  bill_code: null,
  bill_code_source: null,
  own: null,
  next_valid_from: null,
  pays: payShape(null, null),
  own_rule: null,
  pays_inherited: false,
  inherited: false,
  general: true,
});

async function cellsFor(db, items, codes, date) {
  const cells = new Map(items.map((item) => [item.id, { [GENERAL]: generalCell(item) }]));
  if (!items.length || !codes.length) return cells;
  const { rows } = await db.query(CELLS_SQL, [items.map((i) => i.id), codes, date]);
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const row of rows) cells.get(row.item_id)[row.code] = cellShape(row, byId.get(row.item_id));
  return cells;
}

async function loadColumns(db, schemeCode) {
  const params = [];
  let filter = "";
  if (schemeCode) {
    params.push(schemeCode);
    filter = "AND (s.code = $1 OR s.parent_code = $1)";
  }
  const { rows } = await db.query(
    `SELECT s.code, s.label, s.parent_code, s.payer_name,
            COALESCE(s.payer_name, p.payer_name) AS effective_payer_name,
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS display_label,
            EXISTS (SELECT 1 FROM patient_schemes c WHERE c.parent_code = s.code AND c.is_active)
              AS has_sub_categories
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.is_active AND COALESCE(p.is_active, TRUE) ${filter}
      ORDER BY COALESCE(p.sort_order, s.sort_order), COALESCE(p.label, s.label),
               s.parent_code IS NOT NULL, s.sort_order, s.label`,
    params,
  );
  if (schemeCode && !rows.length) {
    const { rows: found } = await db.query(`SELECT 1 FROM patient_schemes WHERE code = $1`, [
      schemeCode,
    ]);
    throw found.length
      ? httpError(409, "That category is retired")
      : httpError(404, "That category doesn't exist");
  }
  return rows;
}

const GENERAL_COLUMN = {
  code: GENERAL,
  label: "General",
  parent_code: null,
  payer_name: null,
  effective_payer_name: null,
  display_label: "General",
  has_sub_categories: false,
};

async function loadRows(db, doctorId) {
  const { rows: doctors } = await db.query(
    `SELECT d.id, d.name, d.short_name, d.role, COALESCE(d.is_active, TRUE) AS is_active
       FROM doctors d
      WHERE ((d.role = 'consultant' AND COALESCE(d.is_active, TRUE))
             OR EXISTS (SELECT 1 FROM service_items i
                         WHERE i.kind = 'consultation' AND i.is_active AND i.doctor_id = d.id))
        AND ($1::int IS NULL OR d.id = $1)
      ORDER BY d.name, d.id`,
    [doctorId],
  );
  if (doctorId && !doctors.length) {
    const { rows } = await db.query(`SELECT 1 FROM doctors WHERE id = $1`, [doctorId]);
    if (!rows.length) throw httpError(404, "That doctor doesn't exist");
  }
  const { rows: items } = await db.query(
    `SELECT i.id, i.code, i.name, i.base_price, i.doctor_id, i.visit_type, i.subgroup_id
       FROM service_items i
      WHERE i.kind = 'consultation' AND i.is_active
        AND ($1::int IS NULL OR i.doctor_id = $1)
      ORDER BY i.id`,
    [doctorId],
  );
  const { rows: retired } = await db.query(
    `SELECT DISTINCT ON (i.doctor_id, i.visit_type) i.id, i.code, i.doctor_id, i.visit_type
       FROM service_items i
      WHERE i.kind = 'consultation' AND NOT i.is_active AND i.doctor_id IS NOT NULL
        AND ($1::int IS NULL OR i.doctor_id = $1)
      ORDER BY i.doctor_id, i.visit_type, i.id DESC`,
    [doctorId],
  );
  return {
    doctors: doctors.filter((d) => !isLabOnlyDoctor(d.name)),
    items: items.map((i) => ({ ...i, base_price: Number(i.base_price) })),
    retired,
  };
}

const itemShape = (item) => ({
  id: item.id,
  code: item.code,
  name: item.name,
  base_price: item.base_price,
  subgroup_id: item.subgroup_id,
});

export async function consultantFeeGrid(options = {}, db = pool) {
  const doctorId = cleanId(options.doctorId ?? options.doctor_id, "doctor");
  const rawScheme = options.schemeCode ?? options.scheme_code;
  const schemeCode =
    rawScheme === undefined || rawScheme === null || rawScheme === ""
      ? null
      : cleanCategory(rawScheme);
  const date = cleanDate(options.date, "Date") ?? indiaToday();
  const onlyGeneral = schemeCode !== null && RESERVED_CATEGORY_CODES.includes(schemeCode);
  const categories = onlyGeneral ? [] : await loadColumns(db, schemeCode);
  const columns = [GENERAL_COLUMN, ...categories];
  const { doctors, items, retired } = await loadRows(db, doctorId);
  const cells = await cellsFor(
    db,
    items,
    categories.map((c) => c.code),
    date,
  );
  const itemFor = (id, visitType) =>
    items.find((i) => i.doctor_id === id && i.visit_type === visitType) ?? null;
  const defaults = new Map(items.filter((i) => i.doctor_id === null).map((i) => [i.visit_type, i]));
  const rows = [];
  const notPriced = [];
  for (const doctor of doctors) {
    for (const visitType of CONSULTATION_VISIT_TYPES) {
      const item = itemFor(doctor.id, visitType);
      const who = {
        doctor_id: doctor.id,
        doctor_name: doctor.name,
        short_name: doctor.short_name,
        doctor_active: doctor.is_active,
        visit_type: visitType,
      };
      if (item) {
        rows.push({ ...who, is_default: false, item: itemShape(item), cells: cells.get(item.id) });
        continue;
      }
      const old = retired.find((r) => r.doctor_id === doctor.id && r.visit_type === visitType);
      notPriced.push({
        ...who,
        status: old ? "item_deactivated" : "no_item",
        item_id: old?.id ?? null,
        item_code: old?.code ?? null,
        default_covers: defaults.has(visitType),
      });
    }
  }
  if (!doctorId) {
    for (const visitType of CONSULTATION_VISIT_TYPES) {
      const item = defaults.get(visitType);
      if (!item) continue;
      rows.push({
        doctor_id: null,
        doctor_name: null,
        short_name: null,
        doctor_active: null,
        visit_type: visitType,
        is_default: true,
        item: itemShape(item),
        cells: cells.get(item.id),
      });
    }
  }
  return {
    date,
    today: indiaToday(),
    visit_types: CONSULTATION_VISIT_TYPES,
    patient_pays: PATIENT_PAYS,
    columns,
    rows,
    not_priced: notPriced,
  };
}

async function loadItem(client, itemId) {
  const { rows } = await client.query(
    `SELECT i.id, i.code, i.name, i.kind, i.is_active, i.doctor_id, i.visit_type, i.base_price,
            d.name AS doctor_name
       FROM service_items i LEFT JOIN doctors d ON d.id = i.doctor_id
      WHERE i.id = $1`,
    [itemId],
  );
  if (!rows.length) throw httpError(404, "That item doesn't exist");
  const item = rows[0];
  if (item.kind !== "consultation") {
    throw httpError(409, `${item.name} isn't a consultation item, so it has no consultant fee`);
  }
  if (!item.is_active) throw httpError(409, `${item.name} is deactivated`);
  return { ...item, base_price: Number(item.base_price) };
}

async function loadCategory(client, code) {
  const { rows } = await client.query(
    `SELECT s.code, s.parent_code,
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS name
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1`,
    [code],
  );
  if (!rows.length) throw httpError(404, "That category doesn't exist");
  return rows[0];
}

async function ownRate(client, code, itemId, date) {
  const { rows } = await client.query(RATE_ON("$1", "$2", "$3::date"), [code, itemId, date]);
  return rows[0] ? { ...rows[0], rate: num(rows[0].rate) } : null;
}

async function ownRules(client, code, item, date) {
  const { rows } = await client.query(
    `SELECT ${RULE_COLUMNS}
       FROM category_payment_rules r CROSS JOIN (SELECT $3::text AS visit_type) it
      WHERE r.scheme_code = $1 AND r.service_item_id = $2 AND ${RULE_MATCH("$4::date")}
      ORDER BY r.priority, r.id`,
    [code, item.id, item.visit_type, date],
  );
  return rows.map(ruleShape);
}

export const laterRuleText = (item, category, rule) =>
  `${item} in ${category} already has the payment rule "${rule.name}" from ${rule.valid_from}; give this one a To date of ${dayBefore(rule.valid_from)} or earlier, or change that rule`;

async function checkNoLaterRule(client, category, item, span) {
  const { rows } = await client.query(
    `SELECT r.name, r.valid_from::text AS valid_from
       FROM category_payment_rules r
      WHERE r.scheme_code = $1 AND r.service_item_id = $2 AND r.is_active
        AND r.id IS DISTINCT FROM $3
        AND (r.visit_types IS NULL OR $4::text = ANY (r.visit_types))
        AND r.valid_from > $5::date AND ($6::date IS NULL OR r.valid_from <= $6::date)
      ORDER BY r.valid_from, r.id LIMIT 1`,
    [category.code, item.id, span.id ?? null, item.visit_type, span.from, span.to],
  );
  if (rows.length) throw httpError(409, laterRuleText(item.name, category.name, rows[0]));
}

async function inheritedFee(client, category, item, date) {
  const parent = category.parent_code
    ? await ownRate(client, category.parent_code, item.id, date)
    : null;
  return parent?.rate ?? item.base_price;
}

async function feeOn(client, category, item, date) {
  const own = await ownRate(client, category.code, item.id, date);
  return own?.rate ?? inheritedFee(client, category, item, date);
}

async function freeRuleName(client, code, item, start) {
  for (const name of [item.name, `${item.name} from ${start}`]) {
    const { rows } = await client.query(
      `SELECT 1 FROM category_payment_rules WHERE scheme_code = $1 AND lower(name) = lower($2)`,
      [code, name],
    );
    if (!rows.length) return name;
  }
  return `${item.name} from ${start} (${Date.now()})`;
}

function cleanCellInput(input) {
  const scheme = cleanColumn(input?.scheme_code, "a category");
  const itemId = cleanId(input?.service_item_id, "consultation item");
  if (itemId === null) throw httpError(400, "Choose a consultation item");
  const touchesRate = RATE_FIELDS.some((key) => hasField(input, key));
  const touchesRule = hasField(input, "patient_pays");
  if (!touchesRule && RULE_FIELDS.some((key) => hasField(input, key))) {
    throw httpError(400, "Choose what the patient pays (full, amount, percent or nothing)");
  }
  if (!touchesRate && !touchesRule) {
    throw httpError(
      400,
      "Nothing to save: give a fee, a bill name or code, or what the patient pays",
    );
  }
  if (touchesRule && !PATIENT_PAYS.includes(input.patient_pays)) {
    throw httpError(400, `Patient pays must be one of: ${PATIENT_PAYS.join(", ")}`);
  }
  return {
    scheme,
    itemId,
    touchesRate,
    touchesRule,
    validFrom: cleanDate(input?.valid_from, "From date"),
    validTo: hasField(input, "valid_to") ? cleanDate(input.valid_to, "To date") : undefined,
  };
}

async function checkAmount(client, input, category, item, start) {
  if (input.patient_pays !== "amount") return;
  const amount = readNumber(input.patient_value, "The value must be a number");
  if (amount === undefined) return;
  const given = hasField(input, "fee")
    ? readNumber(input.fee, "Fee must be an amount in rupees")
    : undefined;
  const fee =
    given !== undefined
      ? given
      : hasField(input, "fee")
        ? await inheritedFee(client, category, item, start)
        : await feeOn(client, category, item, start);
  if (amount <= fee) return;
  throw httpError(
    409,
    `The patient can't pay ${rupees(amount)} for ${item.name} in ${category.name}: the fee there is ${rupees(fee)}. Lower the amount, or raise the fee.`,
    { items: [{ id: item.id, code: item.code, name: item.name, price: fee, sub_category: null }] },
  );
}

async function writeRate(client, input, parsed, existing, start, ctx) {
  const keep = existing && existing.valid_from === start;
  const field = (key, column) => (hasField(input, key) ? input[key] : (existing?.[column] ?? null));
  return saveRate(
    {
      scheme_code: parsed.scheme,
      service_item_id: parsed.itemId,
      valid_from: start,
      valid_to: parsed.validTo !== undefined ? parsed.validTo : keep ? existing.valid_to : null,
      rate: field("fee", "rate"),
      bill_name: field("bill_name", "bill_name"),
      bill_code: field("bill_code", "bill_code"),
    },
    ctx,
    client,
  );
}

const sameRule = (rule, values) =>
  rule.patient_pays === values.patient_pays &&
  (rule.patient_value ?? null) === (values.patient_value ?? null) &&
  (!hasField(values, "remainder") || rule.remainder === values.remainder);

async function writeRule(client, input, parsed, category, item, ctx) {
  const pays = input.patient_pays;
  const values = { patient_pays: pays };
  if (TAKES_VALUE.includes(pays)) values.patient_value = input.patient_value;
  if (hasField(input, "remainder")) values.remainder = input.remainder;
  const on = parsed.validFrom ?? indiaToday();
  const [current] = await ownRules(client, category.code, item, on);
  const extra = parsed.validTo !== undefined ? { valid_to: parsed.validTo } : {};
  const keepsCurrent =
    current &&
    (!parsed.validFrom ||
      parsed.validFrom === current.valid_from ||
      sameRule(current, { ...values, patient_value: num(values.patient_value) }));
  const stretched =
    hasField(extra, "valid_to") &&
    (extra.valid_to === null || (current?.valid_to !== null && extra.valid_to > current?.valid_to));
  if (keepsCurrent && stretched) {
    await checkNoLaterRule(client, category, item, {
      id: current.id,
      from: current.valid_from,
      to: extra.valid_to,
    });
  }
  if (current && (!parsed.validFrom || parsed.validFrom === current.valid_from)) {
    return updatePaymentRule(current.id, { ...values, ...extra }, ctx, client);
  }
  if (current && sameRule(current, { ...values, patient_value: num(values.patient_value) })) {
    return Object.keys(extra).length ? updatePaymentRule(current.id, extra, ctx, client) : current;
  }
  if (current) {
    await updatePaymentRule(current.id, { valid_to: dayBefore(on) }, ctx, client);
  }
  const start = parsed.validFrom ?? indiaToday();
  await checkNoLaterRule(client, category, item, { from: start, to: extra.valid_to ?? null });
  return createPaymentRule(
    {
      scheme_code: category.code,
      name: await freeRuleName(client, category.code, item, start),
      service_item_id: item.id,
      valid_from: start,
      ...values,
      ...extra,
    },
    ctx,
    client,
  );
}

const refusedByPrices = (error) =>
  error?.status === 409 && (Array.isArray(error.conflicts) || Array.isArray(error.items));

async function attempt(client, steps) {
  await client.query("SAVEPOINT consultant_fee_try");
  try {
    const out = {};
    for (const [key, step] of steps) out[key] = await step();
    await client.query("RELEASE SAVEPOINT consultant_fee_try");
    return { ok: true, out };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT consultant_fee_try");
    return { ok: false, error };
  }
}

async function saveCellIn(client, input, ctx) {
  const parsed = cleanCellInput(input);
  const item = await loadItem(client, parsed.itemId);
  const category = await loadCategory(client, parsed.scheme);
  const existing = await ownRate(client, category.code, item.id, parsed.validFrom ?? indiaToday());
  const start = parsed.validFrom ?? existing?.valid_from ?? indiaToday();
  if (parsed.touchesRule) await checkAmount(client, input, category, item, start);
  const rateStep = ["rate", () => writeRate(client, input, parsed, existing, start, ctx)];
  const ruleStep = ["rule", () => writeRule(client, input, parsed, category, item, ctx)];
  const steps = [parsed.touchesRate && rateStep, parsed.touchesRule && ruleStep].filter(Boolean);
  const first = await attempt(client, steps);
  if (first.ok) return { item, category, ...first.out };
  if (steps.length < 2 || !refusedByPrices(first.error)) throw first.error;
  const second = await attempt(client, [...steps].reverse());
  if (second.ok) return { item, category, ...second.out };
  throw first.error;
}

async function cellOf(client, itemId, code, date) {
  const { rows } = await client.query(
    `SELECT i.id, i.code, i.name, i.base_price FROM service_items i WHERE i.id = $1`,
    [itemId],
  );
  const item = { ...rows[0], base_price: Number(rows[0].base_price) };
  const cells = await cellsFor(client, [item], [code], date);
  return cells.get(itemId)[code];
}

export async function saveConsultantFee(input, ctx, db = pool) {
  return inTransaction(async (client) => {
    const saved = await saveCellIn(client, input, ctx);
    return {
      scheme_code: saved.category.code,
      service_item_id: saved.item.id,
      rate: saved.rate?.rate ?? null,
      closed: saved.rate?.closed ?? [],
      starts_in_past: saved.rate?.starts_in_past ?? false,
      rule: saved.rule ?? null,
      cell: await cellOf(client, saved.item.id, saved.category.code, indiaToday()),
    };
  }, db);
}

export async function clearConsultantFee(input, ctx, db = pool) {
  const scheme = cleanColumn(input?.scheme_code, "a category");
  const itemId = cleanId(input?.service_item_id, "consultation item");
  if (itemId === null) throw httpError(400, "Choose a consultation item");
  const date = cleanDate(input?.date, "Date") ?? indiaToday();
  return inTransaction(async (client) => {
    const item = await loadItem(client, itemId);
    const category = await loadCategory(client, scheme);
    const rules = await ownRules(client, category.code, item, date);
    const rate = await ownRate(client, category.code, item.id, date);
    if (!rules.length && !rate) {
      throw httpError(
        404,
        `${item.name} has no fee or payment rule of its own in ${category.name}`,
      );
    }
    for (const rule of rules) await deletePaymentRule(rule.id, ctx, client);
    if (rate) {
      await deleteRate(
        { scheme_code: category.code, service_item_id: item.id, valid_from: rate.valid_from },
        ctx,
        client,
      );
    }
    return {
      scheme_code: category.code,
      service_item_id: item.id,
      deleted_rate: rate,
      deleted_rules: rules,
      cell: await cellOf(client, item.id, category.code, indiaToday()),
    };
  }, db);
}

export async function copyConsultantFees(input, ctx, db = pool) {
  const from = cleanColumn(input?.from_scheme_code, "the category to copy from");
  const to = cleanColumn(input?.to_scheme_code, "the category to copy to");
  if (from === to) throw httpError(400, "Choose two different categories");
  const date = cleanDate(input?.date, "Date") ?? indiaToday();
  const validFrom = cleanDate(input?.valid_from, "From date");
  return inTransaction(async (client) => {
    const source = await loadCategory(client, from);
    const target = await loadCategory(client, to);
    const { rows: items } = await client.query(
      `SELECT i.id, i.code, i.name, i.visit_type FROM service_items i
        WHERE i.kind = 'consultation' AND i.is_active ORDER BY i.id`,
    );
    const copied = [];
    for (const item of items) {
      const rate = await ownRate(client, source.code, item.id, date);
      const [rule] = await ownRules(client, source.code, item, date);
      if (!rate && !rule) continue;
      const cell = { scheme_code: target.code, service_item_id: item.id };
      if (validFrom) cell.valid_from = validFrom;
      if (rate) {
        cell.fee = rate.rate;
        cell.bill_name = rate.bill_name;
        cell.bill_code = rate.bill_code;
      }
      if (rule) {
        cell.patient_pays = rule.patient_pays;
        if (TAKES_VALUE.includes(rule.patient_pays)) cell.patient_value = rule.patient_value;
        cell.remainder = rule.remainder;
      }
      await saveCellIn(client, cell, ctx);
      copied.push({
        service_item_id: item.id,
        code: item.code,
        name: item.name,
        cell: await cellOf(client, item.id, target.code, indiaToday()),
      });
    }
    return {
      from_scheme_code: source.code,
      to_scheme_code: target.code,
      copied: copied.length,
      cells: copied,
    };
  }, db);
}
