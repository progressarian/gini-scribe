import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { indiaToday } from "./categoryResolver.js";
import { bucketsOf, cleanDashboardFilters } from "./dashboardPeriods.js";
import { BILL_COLUMNS, BILLED, bucketOf, CONCESSION, GROSS } from "./dashboardSql.js";
import { SCHEME_JOIN, SIGN, VISIT_JOIN } from "./reports.js";
import { CODE_MAX, reportScope } from "./reportsFilters.js";
import { httpError } from "./transaction.js";

export const NO_GROUP = "none";
export const NO_SUBGROUP = "none";
export const PHARMACY_COLUMN = {
  key: "pharmacy",
  label: "Pharmacy Charges",
  note: "Not in Scribe — pharmacy is billed in its own system",
};

export const LINE_KIND = `CASE WHEN si.kind = 'consultation' THEN 'consultation'
       WHEN l.lab_order_id IS NOT NULL OR si.kind = 'test' THEN 'test'
       ELSE 'other' END`;

export const GROUP_KEY = `COALESCE(lower(l.group_code), '${NO_GROUP}')`;
const SUBGROUP_KEY = `COALESCE(lower(l.subgroup_code), '${NO_SUBGROUP}')`;

const FROM_LINES = `bills b JOIN bill_lines l ON l.bill_id = b.id ${SCHEME_JOIN} ${VISIT_JOIN}`;

async function namesOf(table, db) {
  const { rows } = await db.query(
    `SELECT lower(code) AS code, name, sort_order FROM ${table} ORDER BY sort_order, lower(name)`,
  );
  return rows;
}

function ordered(keys, names, none) {
  const known = names.filter((row) => keys.has(row.code));
  const columns = known.map((row) => ({ key: row.code, label: row.name }));
  for (const key of keys) {
    if (key === none || known.some((row) => row.code === key)) continue;
    columns.push({ key, label: key.toUpperCase() });
  }
  if (keys.has(none))
    columns.push({ key: none, label: none === NO_GROUP ? "No group" : "No subgroup" });
  return columns;
}

export async function chargeColumnsFor(keys, db = pool) {
  return ordered(new Set(keys), await namesOf("service_groups", db), NO_GROUP);
}

function cleanCode(value, label) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!code || /\s/.test(code) || code.length > CODE_MAX) {
    throw httpError(400, `Choose a ${label}`);
  }
  return code;
}

async function subgroupDetail(filters, group, db) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const groupParam = scope.bind(group);
  const { rows } = await db.query(
    `SELECT ${bucketOf(filters.period, "b.bill_date")}::text AS bucket, ${SUBGROUP_KEY} AS key,
            COALESCE(SUM(${SIGN} * ${GROSS}), 0) AS charges,
            COALESCE(SUM(${SIGN} * ${CONCESSION}), 0) AS discount
       FROM ${FROM_LINES}
      WHERE ${BILLED} AND ${scope.sql} AND ${GROUP_KEY} = ${groupParam}
      GROUP BY 1, 2`,
    scope.params,
  );
  const columns = ordered(
    new Set(rows.map((row) => row.key)),
    await namesOf("service_subgroups", db),
    NO_SUBGROUP,
  );
  const byBucket = new Map();
  for (const row of rows) {
    if (!byBucket.has(row.bucket)) byBucket.set(row.bucket, {});
    byBucket.get(row.bucket)[row.key] = paise(row.charges);
  }
  const shaped = bucketsOf(filters).map((bucket) => {
    const charges = Object.fromEntries(columns.map((c) => [c.key, 0]));
    Object.assign(charges, byBucket.get(bucket.bucket) ?? {});
    return { ...bucket, charges, total: Object.values(charges).reduce((a, b) => a + b, 0) };
  });
  const total = Object.fromEntries(columns.map((c) => [c.key, 0]));
  let discount = 0;
  for (const row of rows) {
    total[row.key] += paise(row.charges);
    discount += paise(row.discount);
  }
  return {
    level: "subgroup",
    columns,
    rows: shaped,
    total: { charges: total, total: Object.values(total).reduce((a, b) => a + b, 0), discount },
  };
}

async function itemDetail(filters, group, subgroup, db) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const groupParam = scope.bind(group);
  const subgroupParam = scope.bind(subgroup);
  const { rows } = await db.query(
    `SELECT l.service_item_id AS item_id, MAX(l.item_code) AS code, MAX(l.bill_name) AS name,
            COALESCE(SUM(${SIGN} * l.quantity), 0) AS quantity,
            COALESCE(SUM(${SIGN} * ${GROSS}), 0) AS charges,
            COALESCE(SUM(${SIGN} * ${CONCESSION}), 0) AS discount
       FROM ${FROM_LINES}
      WHERE ${BILLED} AND ${scope.sql} AND ${GROUP_KEY} = ${groupParam}
        AND ${SUBGROUP_KEY} = ${subgroupParam}
      GROUP BY l.service_item_id, CASE WHEN l.service_item_id IS NULL THEN l.bill_name END
      ORDER BY SUM(${SIGN} * ${GROSS}) DESC, MAX(l.bill_name)`,
    scope.params,
  );
  const items = rows.map((row, index) => ({
    key: row.item_id ?? `line-${index}`,
    item_id: row.item_id,
    code: row.code,
    name: row.name,
    quantity: Number(row.quantity),
    charges: paise(row.charges),
    discount: paise(row.discount),
    net: paise(row.charges) - paise(row.discount),
  }));
  const sum = (key) => items.reduce((total, item) => total + item[key], 0);
  return {
    level: "item",
    items,
    total: {
      quantity: sum("quantity"),
      charges: sum("charges"),
      discount: sum("discount"),
      net: sum("net"),
    },
  };
}

async function labelOf(table, code, none, db) {
  if (code === none) return none === NO_GROUP ? "No group" : "No subgroup";
  const { rows } = await db.query(`SELECT name FROM ${table} WHERE lower(code) = $1 LIMIT 1`, [
    code,
  ]);
  return rows[0]?.name ?? code.toUpperCase();
}

export async function chargeDetail(input = {}, db = pool, { today = indiaToday() } = {}) {
  const filters = cleanDashboardFilters(input, today);
  const group = cleanCode(input.group, "service group");
  const subgroup = input.subgroup ? cleanCode(input.subgroup, "subgroup") : null;
  const groupInfo = { key: group, label: await labelOf("service_groups", group, NO_GROUP, db) };
  if (!subgroup) {
    return { filters, group: groupInfo, ...(await subgroupDetail(filters, group, db)) };
  }
  return {
    filters,
    group: groupInfo,
    subgroup: {
      key: subgroup,
      label: await labelOf("service_subgroups", subgroup, NO_SUBGROUP, db),
    },
    ...(await itemDetail(filters, group, subgroup, db)),
  };
}

export async function chargeTree(filters, db = pool) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const { rows } = await db.query(
    `WITH lined AS (
       SELECT ${GROUP_KEY} AS gkey, ${SUBGROUP_KEY} AS skey,
              COALESCE(l.service_item_id::text, l.bill_name) AS item, l.bill_name,
              ${SIGN} * l.quantity AS quantity, ${SIGN} * ${GROSS} AS charges,
              ${SIGN} * ${CONCESSION} AS discount
         FROM ${FROM_LINES}
        WHERE ${BILLED} AND ${scope.sql}
     ), rolled AS (
       SELECT gkey, skey, item, GROUPING(skey) AS s_rolled, GROUPING(item) AS i_rolled,
              MAX(bill_name) AS name, COALESCE(SUM(quantity), 0) AS quantity,
              COALESCE(SUM(charges), 0) AS charges, COALESCE(SUM(discount), 0) AS discount
         FROM lined
        GROUP BY GROUPING SETS ((gkey), (gkey, skey), (gkey, skey, item))
     )
     SELECT r.*, g.name AS group_name, g.sort_order AS group_order,
            s.name AS subgroup_name, s.sort_order AS subgroup_order
       FROM rolled r
       LEFT JOIN service_groups g ON lower(g.code) = r.gkey
       LEFT JOIN service_subgroups s ON lower(s.code) = r.skey AND r.s_rolled = 0
      ORDER BY g.sort_order NULLS LAST, lower(COALESCE(g.name, r.gkey)), r.gkey,
               r.s_rolled DESC, s.sort_order NULLS LAST, lower(COALESCE(s.name, r.skey)), r.skey,
               r.i_rolled DESC, r.charges DESC, r.name`,
    scope.params,
  );
  return rows.map((row) => ({
    level: row.s_rolled ? "group" : row.i_rolled ? "subgroup" : "item",
    group: row.group_name ?? (row.gkey === NO_GROUP ? "No group" : row.gkey.toUpperCase()),
    subgroup: row.s_rolled
      ? null
      : (row.subgroup_name ?? (row.skey === NO_SUBGROUP ? "No subgroup" : row.skey.toUpperCase())),
    item: row.i_rolled ? null : row.name,
    quantity: Number(row.quantity),
    charges: paise(row.charges),
    discount: paise(row.discount),
  }));
}
