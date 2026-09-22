import pool from "../../config/db.js";
import { tryUploadWrites } from "./importCommit.js";
import {
  BILLING_ROLES,
  CATEGORY_DB_COLUMNS,
  CATEGORY_RULE_DB_COLUMNS,
  DISCOUNT_DB_COLUMNS,
  IMPORT_SHEETS,
  PAYMENT_RULE_DB_COLUMNS,
} from "./importColumns.js";
import { parseUpload } from "./importParse.js";
import { checkMasterRows, key, loadReference, nameKey, ruleKeyOf } from "./importValidate.js";

export const STATUSES = ["new", "update", "unchanged", "error"];

const CODE_COLUMNS = new Set([
  "group_code",
  "subgroup_code",
  "item_code",
  "category_code",
  "parent_code",
  "tax_code",
  "groups",
  "subgroups",
  "items",
  "categories",
]);

const plain = (value) =>
  value === undefined || value === "" || (Array.isArray(value) && !value.length) ? null : value;

const byCode = (a, b) => key(a).localeCompare(key(b));
const sorted = (list, order = byCode) => (list ? [...list].sort(order) : null);
const money = (value) => (value === null || value === undefined ? null : Number(value));
const allRolesIfCode = (roles, method) => roles ?? (method === "code" ? BILLING_ROLES : null);

function same(column, a, b) {
  const x = plain(a);
  const y = plain(b);
  if (x === null || y === null) return x === y;
  if (CODE_COLUMNS.has(column)) return key(x) === key(y);
  if (typeof x === "number" || typeof y === "number") return Number(x) === Number(y);
  return String(x) === String(y);
}

function storedIndex(ref) {
  const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
  const groups = byId(ref.groups);
  const subgroups = byId(ref.subgroups);
  const taxCodes = byId(ref.taxCodes);
  const doctors = byId(ref.doctors);
  const tests = byId(ref.tests);
  const items = byId(ref.items);
  const codeOf = (map, id) => (id == null ? null : (map.get(id)?.code ?? null));
  const codesOf = (map, ids) => sorted(ids?.map((id) => codeOf(map, id)) ?? null);
  const fromColumns = (row, columns) =>
    Object.fromEntries(Object.entries(columns).map(([sheet, db]) => [sheet, row[db]]));

  const sheets = {
    Groups: {
      rows: ref.groups,
      keyOf: (g) => key(g.code),
      rowKey: (v) => key(v.group_code),
      stored: (g) => ({ name: g.name, sort_order: g.sort_order, active: g.is_active }),
    },
    Subgroups: {
      rows: ref.subgroups,
      keyOf: (s) => key(s.code),
      rowKey: (v) => key(v.subgroup_code),
      stored: (s) => ({
        group_code: codeOf(groups, s.group_id),
        name: s.name,
        sort_order: s.sort_order,
        active: s.is_active,
      }),
    },
    Items: {
      rows: ref.items,
      keyOf: (i) => key(i.code),
      rowKey: (v) => key(v.item_code),
      stored: (i) => ({
        name: i.name,
        subgroup_code: codeOf(subgroups, i.subgroup_id),
        base_price: Number(i.base_price),
        unit: i.unit,
        allow_quantity: i.allow_quantity,
        max_quantity: i.max_quantity,
        tax_code: codeOf(taxCodes, i.tax_code_id),
        kind: i.kind,
        doctor: i.doctor_id,
        visit_type: i.visit_type,
        test_name: i.test_catalog_id,
        active: i.is_active,
      }),
      compared: (row) => ({
        ...row.values,
        doctor: row.resolved?.doctor?.id ?? null,
        test_name: row.resolved?.test?.id ?? null,
        tax_code: row.resolved?.taxCode?.code ?? null,
      }),
      shown: {
        doctor: (id) => doctors.get(id)?.name ?? id,
        test_name: (id) => tests.get(id)?.test_name ?? id,
      },
    },
    Categories: {
      rows: ref.categories ?? [],
      keyOf: (c) => key(c.code),
      rowKey: (v) => key(v.category_code),
      stored: (c) => {
        const { category_code, ...rest } = fromColumns(c, CATEGORY_DB_COLUMNS);
        return {
          ...rest,
          daily_cap: rest.daily_cap === null ? null : Number(rest.daily_cap),
        };
      },
    },
    "Category rules": {
      rows: ref.rules ?? [],
      keyOf: (r) => `${key(r.scheme_code)}|${nameKey(r.name)}`,
      rowKey: (v) => `${key(v.category_code)}|${nameKey(v.rule_name)}`,
      stored: (r) => {
        const { category_code, rule_name, ...rest } = fromColumns(r, CATEGORY_RULE_DB_COLUMNS);
        return rest;
      },
    },
    "Category rates": {
      rows: ref.rates ?? [],
      keyOf: (r) =>
        `${key(r.scheme_code)}|${key(items.get(r.service_item_id)?.code)}|${r.valid_from}`,
      rowKey: (v) => `${key(v.category_code)}|${key(v.item_code)}|${v.valid_from}`,
      stored: (r) => ({
        rate: r.rate === null ? null : Number(r.rate),
        bill_name: r.bill_name,
        bill_code: r.bill_code,
        valid_to: r.valid_to,
      }),
    },
    "Payment rules": {
      rows: ref.paymentRules ?? [],
      keyOf: (r) => ruleKeyOf(r.scheme_code, r.name),
      rowKey: (v) => ruleKeyOf(v.category_code, v.rule_name),
      stored: (r) => {
        const { category_code, rule_name, ...rest } = fromColumns(r, PAYMENT_RULE_DB_COLUMNS);
        return {
          ...rest,
          group_code: codeOf(groups, r.group_id),
          subgroup_code: codeOf(subgroups, r.subgroup_id),
          item_code: codeOf(items, r.service_item_id),
          patient_value: money(r.patient_value),
        };
      },
    },
    "Consultant fees": {
      rows: [],
      keyOf: () => null,
      rowKey: () => null,
      stored: () => null,
      statusOf: (row) => {
        const targets = row.resolved?.targets ?? [];
        const seen = new Set();
        const changes = targets
          .flatMap((t) => t.changes)
          .filter((c) => {
            const id = JSON.stringify(c);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          });
        return { isNew: !targets.some((t) => t.existed), changes };
      },
    },
    Discounts: {
      rows: ref.discounts ?? [],
      keyOf: (d) => nameKey(d.name),
      rowKey: (v) => nameKey(v.rule_name),
      stored: (d) => {
        const { rule_name, ...rest } = fromColumns(d, DISCOUNT_DB_COLUMNS);
        return {
          ...rest,
          value: money(d.value),
          max_discount: money(d.max_discount),
          groups: codesOf(groups, d.group_ids),
          subgroups: codesOf(subgroups, d.subgroup_ids),
          items: codesOf(items, d.service_item_ids),
          doctors: sorted(d.doctor_ids, (a, b) => a - b),
          categories: sorted(d.scheme_codes),
          allowed_roles: allRolesIfCode(d.allowed_roles, d.method),
        };
      },
      compared: (row) => ({
        ...row.values,
        groups: sorted(row.resolved?.groups),
        subgroups: sorted(row.resolved?.subgroups),
        items: sorted(row.resolved?.items),
        doctors: sorted(row.resolved?.doctors, (a, b) => a - b),
        categories: sorted(row.resolved?.categories),
        allowed_roles: allRolesIfCode(row.values.allowed_roles, row.values.method),
      }),
      shown: {
        doctors: (ids) => ids.map((id) => doctors.get(id)?.name ?? id).join(", "),
      },
    },
  };
  for (const spec of Object.values(sheets)) {
    spec.byKey = new Map(spec.rows.map((r) => [spec.keyOf(r), spec.stored(r)]));
  }
  return sheets;
}

const PARENT = {
  Groups: { code: "group_code", name: "name", parent: () => null, dbParent: () => null },
  Subgroups: {
    code: "subgroup_code",
    name: "name",
    parent: (v) => key(v.group_code),
    dbParent: (r, ref) => key(ref.groups.find((g) => g.id === r.group_id)?.code),
  },
  Items: {
    code: "item_code",
    name: "name",
    parent: (v) => key(v.subgroup_code),
    dbParent: (r, ref) => key(ref.subgroups.find((s) => s.id === r.subgroup_id)?.code),
  },
  Categories: {
    code: "category_code",
    name: "label",
    parent: (v) => key(v.parent_code),
    dbParent: (r) => key(r.parent_code),
  },
};

function renamedCodeWarnings(sheet, ref) {
  const spec = PARENT[sheet.name];
  if (!spec) return;
  const source = {
    Groups: ref.groups,
    Subgroups: ref.subgroups,
    Items: ref.items,
    Categories: ref.categories ?? [],
  }[sheet.name];
  const inFile = new Map(
    sheet.rows
      .filter((row) => row.values[spec.code])
      .map((row) => [key(row.values[spec.code]), row]),
  );
  const byName = new Map();
  for (const r of source) {
    const k = `${spec.dbParent(r, ref)}|${nameKey(r.name ?? r.label)}`;
    const renamed = inFile.get(key(r.code));
    if (renamed && `${spec.parent(renamed.values)}|${nameKey(renamed.values[spec.name])}` !== k) {
      continue;
    }
    byName.set(k, [...(byName.get(k) ?? []), r]);
  }
  for (const row of sheet.rows) {
    if (row.status !== "new" && !(row.status === "error" && row.isNew)) continue;
    const v = row.values;
    const match = (byName.get(`${spec.parent(v)}|${nameKey(v[spec.name])}`) ?? []).find(
      (r) => key(r.code) !== key(v[spec.code]),
    );
    if (match) {
      row.warnings.push({
        column: spec.code,
        message: `Looks like ${v[spec.code]}, which now has code ${match.code} — was the code changed on the admin screen?`,
      });
    }
  }
}

function display(spec, column, value) {
  const shown = spec.shown?.[column];
  const v = plain(value);
  if (v === null) return null;
  if (shown) return shown(v);
  return Array.isArray(v) ? v.join(", ") : v;
}

function storedStatus(spec, row) {
  const stored = spec.byKey.get(spec.rowKey(row.values));
  const changes = [];
  if (stored) {
    const compared = spec.compared ? spec.compared(row) : row.values;
    for (const [column, before] of Object.entries(stored)) {
      if (!same(column, before, compared[column])) {
        changes.push({
          column,
          from: display(spec, column, before),
          to: display(spec, column, compared[column]),
        });
      }
    }
  }
  return { isNew: !stored, changes };
}

export function markStatus(sheets, ref) {
  const specs = storedIndex(ref);
  for (const sheet of sheets) {
    const spec = specs[sheet.name];
    if (!spec) continue;
    for (const row of sheet.rows) {
      row.warnings ??= [];
      const { isNew, changes } = spec.statusOf ? spec.statusOf(row) : storedStatus(spec, row);
      row.isNew = isNew;
      row.changes = changes;
      row.status = row.errors.length
        ? "error"
        : isNew
          ? "new"
          : row.changes.length
            ? "update"
            : "unchanged";
    }
    renamedCodeWarnings(sheet, ref);
  }
  return sheets;
}

const emptyCounts = () => ({ new: 0, update: 0, unchanged: 0, error: 0, warning: 0 });

export function summarize(parsed) {
  const order = IMPORT_SHEETS.map((s) => s.name);
  const total = { ...emptyCounts(), notImported: 0 };
  const sheets = parsed.sheets.map((sheet) => {
    const counts = { ...emptyCounts(), notImported: sheet.notImported };
    for (const row of sheet.rows) {
      counts[row.status] += 1;
      if (row.warnings.length) counts.warning += 1;
    }
    for (const k of Object.keys(total)) total[k] += counts[k];
    return {
      name: sheet.name,
      later: sheet.later,
      counts,
      rows: sheet.rows.map(({ row, status, input, values, errors, warnings, changes }) => ({
        row,
        status,
        input,
        values,
        errors,
        warnings,
        changes,
      })),
    };
  });
  sheets.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return {
    problems: parsed.problems,
    canImport: !parsed.problems.length && total.error === 0 && total.new + total.update > 0,
    counts: total,
    sheets,
  };
}

export async function previewUpload(buffer, db = pool, options = {}) {
  const parsed = await parseUpload(buffer);
  if (parsed.problems.length) return summarize(parsed);
  const ref = await loadReference(db);
  checkMasterRows(parsed.sheets, ref, options);
  markStatus(parsed.sheets, ref);
  if (summarize(parsed).canImport) await tryUploadWrites(parsed, ref, db);
  return summarize(parsed);
}
