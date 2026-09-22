import pool from "../../config/db.js";
import { isLabOnlyDoctor } from "../../../shared/labOnly.js";
import { normalizeTestName } from "./testNames.js";
import { suggestedGroup } from "./testListExport.js";
import {
  BILLING_ROLES,
  CONSULTATION_VISIT_TYPES,
  DISCOUNT_DB_COLUMNS,
  PAYMENT_RULE_DB_COLUMNS,
  RESERVED_CATEGORY_CODES,
  TODAY_ON_CREATE,
  VISIT_TYPES,
} from "./importColumns.js";
import { claimPayerProblem, paymentRuleShapeProblem, rupees } from "./paymentRules.js";
import { discountShapeProblem } from "./discountRules.js";
import { laterRuleText } from "./consultantFees.js";
import { indiaToday } from "./categoryResolver.js";

export const key = (code) =>
  String(code ?? "")
    .trim()
    .toLowerCase();
const looseDoctorName = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/^\s*dr\.?\s+/, "")
    .replace(/[^a-z0-9]+/g, "");
export const nameKey = (name) =>
  String(name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

export async function loadReference(db = pool) {
  const [
    groups,
    subgroups,
    items,
    doctors,
    tests,
    taxCodes,
    categories,
    rules,
    rates,
    discounts,
    paymentRules,
  ] = await Promise.all([
    db.query(`SELECT id, code, name, sort_order, is_active FROM service_groups`),
    db.query(`SELECT id, code, name, group_id, sort_order, is_active FROM service_subgroups`),
    db.query(
      `SELECT id, code, name, subgroup_id, base_price, unit, allow_quantity, max_quantity,
                tax_code_id, kind, doctor_id, visit_type, test_catalog_id, is_active
           FROM service_items`,
    ),
    db.query(`SELECT id, name, is_active FROM doctors`),
    db.query(`SELECT id, test_name, category, is_active FROM giniflow_test_catalog`),
    db.query(`SELECT id, code, is_active FROM tax_codes`),
    db.query(
      `SELECT code, label, parent_code, payer_name, requires_ref, requires_referral,
                requires_referral_doc, print_category_on_bill, allow_pay_later, daily_cap, is_active
           FROM patient_schemes`,
    ),
    db.query(
      `SELECT id, scheme_code, name, min_age, max_age, gender, requires_card, mode, priority,
                is_active
           FROM category_rules`,
    ),
    db.query(
      `SELECT scheme_code, service_item_id, valid_from::text AS valid_from,
                valid_to::text AS valid_to, rate, bill_name, bill_code
           FROM category_item_rates`,
    ),
    db.query(
      `SELECT id, code, name, method, kind, value::float8 AS value,
                max_discount::float8 AS max_discount, group_ids, subgroup_ids, service_item_ids,
                doctor_ids, visit_types, scheme_codes, min_age, max_age, gender,
                valid_from::text AS valid_from, valid_to::text AS valid_to, max_uses_total,
                max_uses_per_patient, max_uses_per_day, max_uses_per_doctor_per_day, applies_per,
                priority, stackable, applies_on_scheme_rate, allowed_roles, is_active
           FROM discount_rules`,
    ),
    db.query(
      `SELECT id, scheme_code, name, group_id, subgroup_id, service_item_id, visit_types,
                patient_pays, patient_value::float8 AS patient_value, remainder,
                valid_from::text AS valid_from, valid_to::text AS valid_to, priority, is_active
           FROM category_payment_rules`,
    ),
  ]);
  const { getMachines } = await import("../giniflow/machineCatalog.js");
  return {
    groups: groups.rows,
    subgroups: subgroups.rows,
    items: items.rows,
    doctors: doctors.rows,
    tests: tests.rows,
    taxCodes: taxCodes.rows,
    categories: categories.rows,
    rules: rules.rows,
    rates: rates.rows,
    discountCodes: discounts.rows
      .filter((d) => d.code !== null)
      .map((d) => ({ code: d.code, name: d.name })),
    discounts: discounts.rows,
    paymentRules: paymentRules.rows,
    machines: await getMachines(db),
  };
}

const rowList = (rows) =>
  rows.length > 1 ? `rows ${rows.slice(0, -1).join(", ")} and ${rows.at(-1)}` : `row ${rows[0]}`;

const fail = (row, column, message) => row.errors.push({ column, message });
const warn = (row, column, message) => row.warnings.push({ column, message });
const hasError = (row, ...columns) => row.errors.some((e) => columns.includes(e.column));

function markDuplicates(rows, keyColumns) {
  const columns = [keyColumns].flat();
  const seen = new Map();
  for (const row of rows) {
    if (hasError(row, ...columns) || columns.some((c) => !row.values[c])) continue;
    const k = columns.map((c) => key(row.values[c])).join("|");
    seen.set(k, [...(seen.get(k) ?? []), row]);
  }
  for (const group of seen.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      const others = group.filter((r) => r !== row).map((r) => r.row);
      fail(
        row,
        columns[0],
        `${columns.map((c) => row.values[c]).join(" + ")} is also on ${rowList(others)}; each ${columns.join(" + ")} can appear only once`,
      );
    }
  }
}

function finalState(dbRows, fileRows, codeColumn, fromDb, fromFile) {
  const state = new Map();
  for (const r of dbRows) state.set(key(r.code), { ...fromDb(r), inFile: false, existed: true });
  for (const row of fileRows) {
    if (hasError(row, codeColumn)) continue;
    const k = key(row.values[codeColumn]);
    const before = state.get(k);
    state.set(k, {
      ...before,
      ...fromFile(row, before),
      inFile: true,
      row,
      existed: Boolean(before),
    });
  }
  return state;
}

function missingParent(row, column, noun, sheetName, state, typed = row.values[column]) {
  const broken = state.fileRowsWithErrors[sheetName]?.get(key(typed));
  fail(
    row,
    column,
    broken
      ? `The ${noun} ${typed} has errors on the ${sheetName} sheet (${rowList(broken)}); fix those first`
      : `There is no ${noun} ${typed}, in this file or in Scribe`,
  );
}

function indexBy(entries, keyOf) {
  const index = new Map();
  for (const entry of entries) {
    const k = keyOf(entry);
    if (k == null) continue;
    index.set(k, [...(index.get(k) ?? []), entry]);
  }
  return index;
}

const others = (index, k, entry) => (index.get(k) ?? []).filter((other) => other !== entry);

function referenceIndex(ref) {
  return {
    doctorsById: indexBy(ref.doctors, (d) => String(d.id)),
    doctorsByName: indexBy(ref.doctors, (d) => nameKey(d.name)),
    doctorsByLooseName: indexBy(ref.doctors, (d) => looseDoctorName(d.name)),
    testsByName: indexBy(ref.tests, (t) => nameKey(t.test_name)),
    testsByLooseName: indexBy(ref.tests, (t) => normalizeTestName(t.test_name)),
    taxByCode: new Map(ref.taxCodes.map((t) => [key(t.code), t])),
    machines: ref.machines,
  };
}

const describeSource = (entry) => (entry.inFile ? `row ${entry.row.row}` : "Scribe");

const nameSlot = (entry) => `${entry.parent ?? ""}|${nameKey(entry.name)}`;

function checkUniqueName(row, index, entry, noun, where, column = "name") {
  const [clash] = others(index, nameSlot(entry), entry);
  if (clash) {
    fail(
      row,
      column,
      `${/^[aeiou]/.test(noun) ? "An" : "A"} ${noun} called "${clash.name}"${where} already exists (${clash.code}, ${describeSource(clash)})`,
    );
  }
}

function checkGroups(sheet, state) {
  const { groups, index } = state;
  for (const row of sheet.rows) {
    if (hasError(row, "group_code")) continue;
    const entry = groups.get(key(row.values.group_code));
    if (!hasError(row, "name")) checkUniqueName(row, index.groupNames, entry, "group", "");
    if (entry.active) continue;
    const active = others(index.subgroupsByParent, key(entry.code)).filter((s) => s.active);
    if (active.length) {
      fail(
        row,
        "active",
        `${entry.name} still has active subgroups: ${active.map((s) => s.name).join(", ")}; set them to active = no on the Subgroups sheet too`,
      );
    }
  }
}

function checkSubgroups(sheet, state) {
  const { groups, subgroups, index } = state;
  for (const row of sheet.rows) {
    if (hasError(row, "subgroup_code")) continue;
    const entry = subgroups.get(key(row.values.subgroup_code));
    if (!hasError(row, "group_code")) {
      const group = groups.get(entry.parent);
      if (!group) {
        missingParent(row, "group_code", "group", "Groups", state);
      } else {
        if (!hasError(row, "name")) {
          checkUniqueName(row, index.subgroupNames, entry, "subgroup", ` in ${group.name}`);
        }
        if ((entry.active || !entry.existed) && !group.active) {
          fail(row, "group_code", `The group ${group.name} is deactivated; reactivate it first`);
        }
      }
    }
    if (entry.active) continue;
    const active = others(index.itemsByParent, key(entry.code)).filter((i) => i.active);
    if (active.length) {
      fail(
        row,
        "active",
        `${entry.name} still has ${active.length} active item${active.length === 1 ? "" : "s"}: ${active
          .slice(0, 5)
          .map((i) => i.name)
          .join(
            ", ",
          )}${active.length > 5 ? "…" : ""}; set them to active = no on the Items sheet too`,
      );
    }
  }
}

function findDoctor(typed, lookup) {
  const byId = /^\d+$/.test(typed) ? (lookup.doctorsById.get(typed) ?? []) : [];
  const matches = byId.length ? byId : (lookup.doctorsByName.get(nameKey(typed)) ?? []);
  if (!matches.length) {
    const near = (lookup.doctorsByLooseName.get(looseDoctorName(typed)) ?? []).filter(
      (d) => d.is_active !== false,
    );
    const hint = near.length
      ? `; did you mean ${near.map((d) => `"${d.name}"`).join(" or ")}?`
      : "";
    return { error: `There is no doctor called "${typed}" in Scribe${hint}` };
  }
  if (matches.length > 1) {
    return {
      error: `${matches.length} doctors are called "${typed}"; write the doctor's id instead (${matches
        .map((d) => d.id)
        .join(" or ")})`,
    };
  }
  return { doctor: matches[0] };
}

function resolveDoctor(row, lookup) {
  const typed = row.values.doctor;
  if (typed == null) return null;
  const found = findDoctor(typed, lookup);
  if (found.error) {
    fail(row, "doctor", found.error);
    return undefined;
  }
  const { doctor } = found;
  if (doctor.is_active === false) {
    fail(row, "doctor", `${doctor.name} is not an active doctor`);
    return undefined;
  }
  if (isLabOnlyDoctor(doctor.name)) {
    fail(
      row,
      "doctor",
      `${doctor.name} is the lab-only provider; samples-only visits have no consultation fee`,
    );
    return undefined;
  }
  return doctor;
}

const NOT_IN_CATALOGUE =
  "This test isn't in the test catalogue yet — ask an admin to add it (Settings › Test catalogue), then upload again";

function resolveTest(row, lookup) {
  const typed = row.values.test_name;
  if (typed == null) return null;
  const exact = lookup.testsByName.get(nameKey(typed)) ?? [];
  const loose = exact.length
    ? exact
    : (lookup.testsByLooseName.get(normalizeTestName(typed)) ?? []);
  const active = loose.filter((t) => t.is_active);
  if (active.length > 1) {
    fail(
      row,
      "test_name",
      `"${typed}" matches more than one test in the catalogue (${active.map((t) => t.test_name).join(", ")}); write the name exactly`,
    );
    return undefined;
  }
  if (active.length === 1) return active[0];
  if (loose.length) {
    fail(row, "test_name", `${loose[0].test_name} is retired in the test catalogue`);
    return undefined;
  }
  fail(row, "test_name", NOT_IN_CATALOGUE);
  return undefined;
}

function resolveTaxCode(row, lookup) {
  const typed = row.values.tax_code;
  if (typed == null) return null;
  const tax = lookup.taxByCode.get(key(typed));
  if (!tax) {
    fail(row, "tax_code", `There is no tax code ${typed} in Scribe (Settings › Billing settings)`);
    return undefined;
  }
  if (!tax.is_active) {
    fail(row, "tax_code", `Tax code ${tax.code} is deactivated`);
    return undefined;
  }
  return tax;
}

function checkItemShape(row) {
  const v = row.values;
  if (hasError(row, "kind")) return;
  if (v.kind === "consultation") {
    if (!v.visit_type && !hasError(row, "visit_type")) {
      fail(row, "visit_type", "A consultation item needs a visit_type (New or Follow Up)");
    }
  } else {
    if (v.doctor != null) fail(row, "doctor", "Only consultation items have a doctor");
    if (v.visit_type != null) fail(row, "visit_type", "Only consultation items have a visit_type");
  }
  if (v.kind === "test" && v.test_name == null && !hasError(row, "test_name")) {
    fail(row, "test_name", "A test item needs the test_name of a test in the test catalogue");
  }
  if (v.kind !== "test" && v.test_name != null) {
    fail(row, "test_name", "Only test items are linked to the test catalogue");
  }
  if (v.max_quantity != null && v.allow_quantity === false) {
    fail(row, "max_quantity", "max_quantity only applies when allow_quantity is yes");
  }
}

function resolveItems(sheet, lookup) {
  for (const row of sheet.rows) {
    checkItemShape(row);
    row.resolved = {
      doctor: row.values.kind === "consultation" ? resolveDoctor(row, lookup) : null,
      test: row.values.kind === "test" ? resolveTest(row, lookup) : null,
      taxCode: resolveTaxCode(row, lookup),
    };
  }
}

function fitsGroup(group, expected) {
  const wanted = normalizeTestName(expected);
  return [group.name, group.code].some((text) => {
    const have = normalizeTestName(text);
    return have.includes(wanted) || (have.length >= 3 && wanted.includes(have));
  });
}

function checkItemsAgainstState(sheet, state, lookup) {
  const { groups, subgroups, items, index } = state;
  const doctorName = (id) => lookup.doctorsById.get(String(id))?.[0]?.name;
  for (const row of sheet.rows) {
    if (hasError(row, "item_code")) continue;
    const entry = items.get(key(row.values.item_code));
    const subgroup = subgroups.get(entry.parent);
    if (!hasError(row, "subgroup_code")) {
      if (!subgroup) {
        missingParent(row, "subgroup_code", "subgroup", "Subgroups", state);
      } else {
        if (!hasError(row, "name")) {
          checkUniqueName(row, index.itemNames, entry, "item", ` in ${subgroup.name}`);
        }
        if ((entry.active || !entry.existed) && !subgroup.active) {
          fail(
            row,
            "subgroup_code",
            `The subgroup ${subgroup.name} is deactivated; reactivate it first`,
          );
        }
      }
    }

    if (entry.kind === "consultation" && entry.active && entry.doctorId !== undefined) {
      const [clash] = others(index.consultations, consultSlot(entry), entry);
      if (clash) {
        const whose = entry.doctorId ? doctorName(entry.doctorId) : "the hospital default";
        fail(
          row,
          entry.doctorId ? "doctor" : "visit_type",
          `There is already an active ${entry.visitType} consultation item for ${whose}: ${clash.name} (${clash.code}, ${describeSource(clash)})`,
        );
      }
    }

    if (entry.kind === "test" && entry.testId) {
      const [clash] = others(index.itemsByTest, entry.testId, entry);
      if (clash) {
        fail(
          row,
          "test_name",
          `${row.resolved.test.test_name} already has an item: ${clash.name} (${clash.code}, ${describeSource(clash)})`,
        );
      } else if (subgroup) {
        const group = groups.get(subgroup.parent);
        const test = row.resolved.test;
        const expected = suggestedGroup(test.category, test.test_name, lookup.machines);
        if (group && !fitsGroup(group, expected)) {
          warn(
            row,
            "subgroup_code",
            `${test.test_name} is a ${expected} test, but ${subgroup.name} is in the ${group.name} group; its revenue will count under ${group.name} on the dashboards`,
          );
        }
      }
    }
  }
}

const consultSlot = (entry) =>
  entry.kind === "consultation" && entry.active && entry.doctorId !== undefined
    ? `${entry.doctorId ?? "default"}|${entry.visitType}`
    : null;

function buildState(sheets, ref) {
  const rowsOf = (name) => sheets.find((s) => s.name === name)?.rows ?? [];
  const groupById = new Map(ref.groups.map((g) => [g.id, g]));
  const subgroupById = new Map(ref.subgroups.map((s) => [s.id, s]));

  const groups = finalState(
    ref.groups,
    rowsOf("Groups"),
    "group_code",
    (g) => ({ code: g.code, name: g.name, active: g.is_active, parent: null }),
    (row) => ({
      code: row.values.group_code,
      name: row.values.name,
      active: row.values.active,
      parent: null,
    }),
  );
  const subgroups = finalState(
    ref.subgroups,
    rowsOf("Subgroups"),
    "subgroup_code",
    (s) => ({
      code: s.code,
      name: s.name,
      active: s.is_active,
      parent: key(groupById.get(s.group_id)?.code),
    }),
    (row) => ({
      code: row.values.subgroup_code,
      name: row.values.name,
      active: row.values.active,
      parent: key(row.values.group_code),
    }),
  );
  const items = finalState(
    ref.items,
    rowsOf("Items"),
    "item_code",
    (i) => ({
      code: i.code,
      name: i.name,
      active: i.is_active,
      parent: key(subgroupById.get(i.subgroup_id)?.code),
      kind: i.kind,
      doctorId: i.doctor_id,
      visitType: i.visit_type,
      testId: i.test_catalog_id,
    }),
    (row) => ({
      code: row.values.item_code,
      name: row.values.name,
      active: row.values.active,
      parent: key(row.values.subgroup_code),
      kind: row.values.kind,
      doctorId: row.resolved?.doctor === undefined ? undefined : (row.resolved.doctor?.id ?? null),
      visitType: row.values.visit_type,
      testId: row.resolved?.test?.id ?? null,
    }),
  );
  const brokenCodes = (name, column) => {
    const map = new Map();
    for (const row of rowsOf(name)) {
      if (!hasError(row, column) || !row.values[column]) continue;
      const k = key(row.values[column]);
      map.set(k, [...(map.get(k) ?? []), row.row]);
    }
    return map;
  };
  const categories = finalState(
    ref.categories ?? [],
    rowsOf("Categories"),
    "category_code",
    (c) => ({
      code: c.code,
      name: c.label,
      active: c.is_active,
      parent: c.parent_code ? key(c.parent_code) : null,
      requiresRef: c.requires_ref,
      payer: c.payer_name,
      dbCap: c.daily_cap === null ? null : Number(c.daily_cap),
      inDb: true,
    }),
    (row) => ({
      code: row.values.category_code,
      name: row.values.label,
      active: row.values.active,
      parent: row.values.parent_code ? key(row.values.parent_code) : null,
      requiresRef: row.values.requires_ref,
      payer: row.values.payer_name,
    }),
  );
  const fileRowsWithErrors = {
    Groups: brokenCodes("Groups", "group_code"),
    Subgroups: brokenCodes("Subgroups", "subgroup_code"),
    Items: brokenCodes("Items", "item_code"),
    Categories: brokenCodes("Categories", "category_code"),
  };
  const index = {
    groupNames: indexBy(groups.values(), nameSlot),
    subgroupNames: indexBy(subgroups.values(), nameSlot),
    itemNames: indexBy(items.values(), nameSlot),
    subgroupsByParent: indexBy(subgroups.values(), (s) => s.parent),
    itemsByParent: indexBy(items.values(), (i) => i.parent),
    consultations: indexBy(items.values(), consultSlot),
    itemsByTest: indexBy(items.values(), (i) => i.testId || null),
  };
  index.categoryLabels = indexBy(categories.values(), nameSlot);
  index.liveRules = liveRules(ref, sheets);
  index.categoryChildren = indexBy(categories.values(), (c) => c.parent);
  const hadChildren = new Set(
    (ref.categories ?? []).filter((c) => c.parent_code).map((c) => key(c.parent_code)),
  );
  const ruleKeys = new Set(
    (ref.rules ?? []).map((r) => `${key(r.scheme_code)}|${nameKey(r.name)}`),
  );
  const codeById = {
    groups: new Map(ref.groups.map((g) => [g.id, g.code])),
    subgroups: new Map(ref.subgroups.map((sg) => [sg.id, sg.code])),
    items: new Map(ref.items.map((i) => [i.id, i.code])),
  };
  const slotOf = (scheme, itemId) => `${key(scheme)}|${itemId}`;
  return {
    groups,
    subgroups,
    items,
    categories,
    fileRowsWithErrors,
    index,
    hadChildren,
    ruleKeys,
    codeById,
    dbItems: new Map(ref.items.map((i) => [key(i.code), i])),
    ratesBySlot: indexBy(ref.rates ?? [], (r) => slotOf(r.scheme_code, r.service_item_id)),
    rulesBySlot: indexBy(
      (ref.paymentRules ?? []).filter((r) => r.service_item_id !== null),
      (r) => slotOf(r.scheme_code, r.service_item_id),
    ),
    slotOf,
    paymentRules: new Map(
      (ref.paymentRules ?? []).map((r) => [ruleKeyOf(r.scheme_code, r.name), r]),
    ),
    discounts: new Map((ref.discounts ?? []).map((d) => [nameKey(d.name), d])),
    discountsByCode: new Map(
      (ref.discounts ?? []).filter((d) => d.code !== null).map((d) => [key(d.code), d]),
    ),
  };
}

export const ruleKeyOf = (category, name) => `${key(category)}|${nameKey(name)}`;

const CATEGORY_CODE = /^[a-z0-9_]{2,32}$/;
const MAX_AGE = 150;

function lowerCategoryCodes(sheets) {
  const columns = {
    Categories: ["category_code", "parent_code"],
    "Category rules": ["category_code"],
    "Category rates": ["category_code"],
    "Payment rules": ["category_code"],
    "Consultant fees": ["category_code"],
    Discounts: ["categories"],
  };
  for (const sheet of sheets) {
    for (const column of columns[sheet.name] ?? []) {
      for (const row of sheet.rows) {
        const value = row.values[column];
        if (typeof value === "string") row.values[column] = value.toLowerCase();
        if (Array.isArray(value)) {
          row.values[column] = [...new Set(value.map((v) => v.toLowerCase()))];
        }
      }
    }
  }
}

const categoryName = (entry, categories) => {
  const parent = entry.parent ? categories.get(entry.parent) : null;
  return parent ? `${parent.name} › ${entry.name}` : entry.name;
};

const categoryLive = (entry, categories) =>
  entry.active && (!entry.parent || categories.get(entry.parent)?.active !== false);

function checkCategoryCodes(sheet) {
  for (const row of sheet.rows) {
    if (hasError(row, "category_code")) continue;
    const code = row.values.category_code;
    if (!CATEGORY_CODE.test(code)) {
      fail(row, "category_code", "category_code must be 2–32 characters: a–z, 0–9 and _ only");
    } else if (RESERVED_CATEGORY_CODES.includes(code)) {
      fail(row, "category_code", `"${code}" is reserved: it means patients with no category`);
    }
  }
}

function liveRules(ref, sheets) {
  const rules = new Map();
  for (const r of ref.rules ?? []) {
    rules.set(`${key(r.scheme_code)}|${nameKey(r.name)}`, {
      category: key(r.scheme_code),
      name: r.name,
      active: r.is_active !== false,
    });
  }
  for (const row of sheets.find((s) => s.name === "Category rules")?.rows ?? []) {
    if (hasError(row, "category_code", "rule_name", "active")) continue;
    rules.set(`${key(row.values.category_code)}|${nameKey(row.values.rule_name)}`, {
      category: key(row.values.category_code),
      name: row.values.rule_name,
      active: row.values.active,
    });
  }
  return indexBy(
    [...rules.values()].filter((r) => r.active),
    (r) => r.category,
  );
}

function checkCategories(sheet, state, options) {
  const { categories, index } = state;
  const warned = new Set();
  for (const row of sheet.rows) {
    if (hasError(row, "category_code")) continue;
    const code = row.values.category_code;
    const entry = categories.get(key(code));
    const children = others(index.categoryChildren, key(code), entry);
    let parent = null;
    if (entry.parent && !hasError(row, "parent_code")) {
      parent = categories.get(entry.parent);
      if (entry.parent === key(code)) {
        fail(row, "parent_code", "A category can't be its own parent");
      } else if (!parent) {
        missingParent(row, "parent_code", "category", "Categories", state);
      } else if (parent.parent) {
        fail(
          row,
          "parent_code",
          `${parent.name} is already a sub-category, so nothing can go under it: only two levels are allowed`,
        );
      } else if ((entry.active || !entry.existed) && !parent.active) {
        fail(row, "parent_code", `${parent.name} is retired; bring it back first`);
      } else if (!state.hadChildren.has(entry.parent) && !warned.has(entry.parent)) {
        const rules = index.liveRules.get(entry.parent) ?? [];
        if (rules.length) {
          warned.add(entry.parent);
          warn(
            row,
            "parent_code",
            `${parent.name} has rules (${rules.map((r) => r.name).join(", ")}) that stop applying once it has sub-categories; add them for its sub-categories on the Category rules sheet, and set the old ones to active = no there`,
          );
        }
      }
      if (children.length) {
        fail(
          row,
          "parent_code",
          `${entry.name} has sub-categories (${children.map((c) => c.name).join(", ")}), so it can't go under another category: only two levels are allowed`,
        );
      }
    }
    if (!hasError(row, "label")) {
      checkUniqueName(
        row,
        index.categoryLabels,
        entry,
        entry.parent ? "sub-category" : "category",
        parent ? ` under ${parent.name}` : "",
        "label",
      );
    }
    if (!entry.active) {
      const active = children.filter((c) => c.active);
      if (active.length) {
        fail(
          row,
          "active",
          `${entry.name} still has active sub-categories: ${active.map((c) => c.name).join(", ")}; set them to active = no too`,
        );
      }
    }
    if (!options.canChangeDailyCap && !hasError(row, "daily_cap")) {
      const before = entry.inDb ? entry.dbCap : null;
      if ((row.values.daily_cap ?? null) !== before) {
        fail(
          row,
          "daily_cap",
          `Only an admin can change a category's patients-per-day limit (it is ${before ?? "no limit"} now)`,
        );
      }
    }
  }
}

function findCategory(row, state) {
  if (hasError(row, "category_code")) return null;
  const entry = state.categories.get(key(row.values.category_code));
  if (!entry) missingParent(row, "category_code", "category", "Categories", state);
  return entry ?? null;
}

function checkRules(sheet, state) {
  const { categories, index } = state;
  for (const row of sheet.rows) {
    const v = row.values;
    for (const column of ["min_age", "max_age"]) {
      if (!hasError(row, column) && v[column] != null && v[column] > MAX_AGE) {
        fail(row, column, `${column} must be ${MAX_AGE} or less`);
      }
    }
    if (!hasError(row, "min_age", "max_age") && v.min_age != null && v.max_age != null) {
      if (v.min_age > v.max_age) fail(row, "max_age", "min_age can't be more than max_age");
    }
    if (
      !hasError(row, "min_age", "max_age", "gender", "requires_card") &&
      v.min_age == null &&
      v.max_age == null &&
      v.gender == null &&
      !v.requires_card
    ) {
      fail(
        row,
        "rule_name",
        "A rule needs at least one condition (an age, a gender or a card), or it would match every patient",
      );
    }
    const category = findCategory(row, state);
    if (!category) continue;
    const name = categoryName(category, categories);
    const isNew =
      !hasError(row, "rule_name") &&
      !state.ruleKeys.has(`${key(v.category_code)}|${nameKey(v.rule_name)}`);
    if ((v.active || isNew) && !categoryLive(category, categories)) {
      fail(row, "category_code", `${name} is retired; bring it back first`);
    }
    if ((v.active || isNew) && others(index.categoryChildren, key(category.code)).length) {
      fail(
        row,
        "category_code",
        `${name} has sub-categories, so it can't be billed on its own: put the rule on one of its sub-categories`,
      );
    }
    const parent = category.parent ? categories.get(category.parent) : null;
    if (
      v.mode === "auto" &&
      v.requires_card === false &&
      (category.requiresRef || parent?.requiresRef)
    ) {
      fail(
        row,
        "requires_card",
        `${name} needs a card number, so an automatic rule for it must also require a card: set requires_card to yes, or make the rule mode suggest`,
      );
    }
  }
}

const dayBefore = (date) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const ratesOverlap = (a, b) =>
  (a.to === null || b.from <= a.to) && (b.to === null || a.from <= b.to);

const rateSpan = (r) =>
  `${r.from} to ${r.to ?? "open-ended"} (${r.inFile ? `row ${r.row.row}` : "Scribe"})`;

function rateSlots(ref, rows) {
  const itemCode = new Map(ref.items.map((i) => [i.id, key(i.code)]));
  const slots = new Map();
  const slot = (category, item) => {
    const k = `${category}|${item}`;
    if (!slots.has(k)) slots.set(k, new Map());
    return slots.get(k);
  };
  for (const r of ref.rates ?? []) {
    const item = itemCode.get(r.service_item_id);
    if (!item) continue;
    slot(key(r.scheme_code), item).set(r.valid_from, {
      from: r.valid_from,
      to: r.valid_to,
      inFile: false,
    });
  }
  for (const row of rows) {
    if (hasError(row, "category_code", "item_code", "valid_from", "valid_to")) continue;
    const v = row.values;
    slot(key(v.category_code), key(v.item_code)).set(v.valid_from, {
      from: v.valid_from,
      to: v.valid_to,
      inFile: true,
      row,
    });
  }
  return slots;
}

function checkRates(rows, state, ref, discountCodes) {
  const { categories, items } = state;
  const slots = rateSlots(ref, rows);
  const storedCodes = new Map(
    (ref.rates ?? []).map((r) => [
      `${key(r.scheme_code)}|${r.service_item_id}|${r.valid_from}`,
      key(r.bill_code),
    ]),
  );
  for (const row of rows) {
    const v = row.values;
    const itemId = state.dbItems.get(key(v.item_code))?.id;
    const kept =
      v.bill_code != null &&
      storedCodes.get(`${key(v.category_code)}|${itemId}|${v.valid_from}`) === key(v.bill_code);
    const discount = !kept && !hasError(row, "bill_code") && discountCodes.get(key(v.bill_code));
    if (discount) {
      fail(
        row,
        "bill_code",
        `${discount.code} is already the code of the discount "${discount.name}"; choose another bill code`,
      );
    }
    if (
      !hasError(row, "valid_from", "valid_to") &&
      v.valid_to != null &&
      v.valid_to < v.valid_from
    ) {
      fail(row, "valid_to", "valid_to can't be before valid_from");
    }
    if (
      !hasError(row, "rate", "bill_name", "bill_code") &&
      v.rate == null &&
      v.bill_name == null &&
      v.bill_code == null
    ) {
      fail(
        row,
        "rate",
        "Give a rate, a bill_name or a bill_code — a rate row must change something",
      );
    }
    const category = findCategory(row, state);
    if (category && !categoryLive(category, categories)) {
      fail(
        row,
        "category_code",
        `${categoryName(category, categories)} is retired; bring it back first`,
      );
    }
    let item = null;
    if (!hasError(row, "item_code")) {
      item = items.get(key(v.item_code));
      if (!item) missingParent(row, "item_code", "item", "Items", state);
      else if (!item.active) fail(row, "item_code", `${item.name} is deactivated`);
    }
    if (!category || !item || row.errors.length) continue;
    const mine = slots.get(`${key(v.category_code)}|${key(v.item_code)}`);
    const self = mine.get(v.valid_from);
    const rest = [...mine.values()].filter((r) => r !== self);
    const toClose =
      v.valid_to == null
        ? rest.filter((r) => !r.inFile && r.to === null && r.from < v.valid_from)
        : [];
    const conflicts = [
      ...rest.filter((r) => !toClose.includes(r) && ratesOverlap(r, self)),
      ...toClose.slice(1),
    ];
    if (conflicts.length) {
      const [other] = conflicts;
      const bothOpen = conflicts.length === 1 && other.to === null && self.to === null;
      const [earlier, later] = other.from < self.from ? [other, self] : [self, other];
      const fix = bothOpen
        ? `give the rate from ${earlier.from} a valid_to of ${dayBefore(later.from)}`
        : "change the dates or end that rate first";
      fail(
        row,
        "valid_from",
        `These dates overlap another rate for ${categoryName(category, categories)} / ${item.name}: ${conflicts.map(rateSpan).join("; ")}; ${fix}`,
      );
    } else if (toClose.length === 1) {
      warn(
        row,
        "valid_from",
        `The rate from ${toClose[0].from} in Scribe will end on ${dayBefore(v.valid_from)}`,
      );
    }
  }
}

const PAYMENT_RULE_COLUMN = Object.fromEntries(
  Object.entries(PAYMENT_RULE_DB_COLUMNS).map(([sheet, db]) => [db, sheet]),
);
const DISCOUNT_COLUMN = Object.fromEntries(
  Object.entries(DISCOUNT_DB_COLUMNS).map(([sheet, db]) => [db, sheet]),
);
DISCOUNT_COLUMN.applies_per = "kind";

const SCOPES = [
  { column: "group_code", field: "group_id", state: "groups", noun: "group", sheet: "Groups" },
  {
    column: "subgroup_code",
    field: "subgroup_id",
    state: "subgroups",
    noun: "subgroup",
    sheet: "Subgroups",
  },
  { column: "item_code", field: "service_item_id", state: "items", noun: "item", sheet: "Items" },
];
const TAKES_VALUE = ["amount", "percent"];
const USE_LIMITS = [
  "max_uses_total",
  "max_uses_per_patient",
  "max_uses_per_day",
  "max_uses_per_doctor_per_day",
];

const inOrder = (list, order) => (list ? order.filter((v) => list.includes(v)) : list);

const startOf = (typed, stored) =>
  typed === TODAY_ON_CREATE ? (stored ? stored.valid_from : indiaToday()) : typed;

const failOnce = (row, column, message) => {
  if (!row.errors.some((e) => e.message === message)) fail(row, column, message);
};

const warnOnce = (row, column, message) => {
  if (!row.warnings.some((w) => w.message === message)) warn(row, column, message);
};

function categoryFacts(entry, categories) {
  const parent = entry.parent ? categories.get(entry.parent) : null;
  return {
    name: categoryName(entry, categories),
    parent_code: entry.parent,
    payer_name: entry.payer ?? parent?.payer ?? null,
  };
}

function checkPaymentRules(sheet, state) {
  const { categories } = state;
  for (const row of sheet.rows) {
    const v = row.values;
    v.visit_types = inOrder(v.visit_types, VISIT_TYPES);
    const stored = hasError(row, "category_code", "rule_name")
      ? null
      : (state.paymentRules.get(ruleKeyOf(v.category_code, v.rule_name)) ?? null);
    if (!hasError(row, "valid_from")) v.valid_from = startOf(v.valid_from, stored);
    row.resolved = { stored };
    const reviving = Boolean(stored) && !stored.is_active && v.active === true;
    const scopes = SCOPES.filter((scope) => v[scope.column] != null);
    const shapeColumns = [
      "patient_pays",
      "patient_value",
      "valid_from",
      "valid_to",
      ...SCOPES.map((scope) => scope.column),
    ];
    if (!hasError(row, ...shapeColumns)) {
      const problem = paymentRuleShapeProblem({
        ...Object.fromEntries(SCOPES.map((scope) => [scope.field, v[scope.column] ?? null])),
        patient_pays: v.patient_pays,
        patient_value: v.patient_value ?? null,
        valid_from: v.valid_from,
        valid_to: v.valid_to ?? null,
      });
      if (problem) fail(row, PAYMENT_RULE_COLUMN[problem.field], problem.message);
    }
    if (scopes.length === 1 && !hasError(row, scopes[0].column)) {
      const [scope] = scopes;
      const target = state[scope.state].get(key(v[scope.column]));
      if (!target) {
        missingParent(row, scope.column, scope.noun, scope.sheet, state);
      } else {
        const before = stored ? state.codeById[scope.state].get(stored[scope.field]) : null;
        const changed = !stored || key(before) !== key(target.code);
        if ((changed || reviving) && !target.active) {
          fail(row, scope.column, `The ${scope.noun} ${target.name} is deactivated`);
        }
      }
    }
    const category = findCategory(row, state);
    if (!category) continue;
    const facts = categoryFacts(category, categories);
    if ((!stored || reviving) && !categoryLive(category, categories)) {
      fail(row, "category_code", `${facts.name} is retired; bring it back first`);
    }
    if (v.active && !hasError(row, "patient_pays", "remainder")) {
      const problem = claimPayerProblem(facts, v);
      if (problem) fail(row, "remainder", problem);
    }
  }
}

const liveOn = (entry, date) =>
  entry.valid_from <= date && (entry.valid_to === null || entry.valid_to >= date);

function ownRateOn(state, scheme, itemId, date) {
  return (
    (state.ratesBySlot.get(state.slotOf(scheme, itemId)) ?? [])
      .filter((r) => liveOn(r, date))
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0] ?? null
  );
}

function ownRuleOn(state, scheme, item, date) {
  return (
    (state.rulesBySlot.get(state.slotOf(scheme, item.id)) ?? [])
      .filter(
        (r) =>
          r.is_active &&
          liveOn(r, date) &&
          (r.visit_types === null || r.visit_types.includes(item.visit_type)),
      )
      .sort((a, b) => a.priority - b.priority || a.id - b.id)[0] ?? null
  );
}

const sameRule = (rule, values) =>
  rule.patient_pays === values.patient_pays &&
  (rule.patient_value ?? null) === (values.patient_value ?? null) &&
  rule.remainder === values.remainder;

const RULE_FIELDS = ["patient_pays", "patient_value", "remainder", "valid_to"];

function ruleChanges(before, after) {
  return RULE_FIELDS.filter((f) => String(before?.[f] ?? null) !== String(after[f] ?? null)).map(
    (f) => ({ column: f, from: before?.[f] ?? null, to: after[f] ?? null }),
  );
}

const RATE_FIELDS = [
  ["fee", "rate"],
  ["bill_name", "bill_name"],
  ["bill_code", "bill_code"],
  ["valid_to", "valid_to"],
];

function rateChanges(before, after) {
  return RATE_FIELDS.filter(([, f]) => {
    const [a, b] = [before?.[f] ?? null, after[f] ?? null];
    return f === "rate" && a !== null && b !== null ? Number(a) !== Number(b) : a !== b;
  }).map(([column, f]) => ({
    column,
    from: before?.[f] == null ? null : f === "rate" ? Number(before[f]) : before[f],
    to: after[f] ?? null,
  }));
}

function dayBeforeText(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function prepareConsultantFees(sheet, state, lookup) {
  const slots = new Map();
  for (const row of sheet.rows) {
    const v = row.values;
    row.resolved = { targets: [] };
    const doctor = resolveDoctor(row, lookup);
    if (!hasError(row, "category_code") && RESERVED_CATEGORY_CODES.includes(v.category_code)) {
      fail(
        row,
        "category_code",
        "The General fee is the consultation item's own price; change it on the Items sheet or the Services page",
      );
      continue;
    }
    const category = findCategory(row, state);
    if (!doctor || hasError(row, "visit_type")) continue;
    const items = [];
    for (const visitType of v.visit_type ? [v.visit_type] : CONSULTATION_VISIT_TYPES) {
      const [item] = state.index.consultations.get(`${doctor.id}|${visitType}`) ?? [];
      if (!item) {
        fail(
          row,
          v.visit_type ? "visit_type" : "doctor",
          `${doctor.name} has no active ${visitType} consultation item; create it first on the Services or Consultant fees page (or on the Items sheet of this file), then upload again`,
        );
      } else {
        items.push({ visitType, item });
      }
    }
    if (!category) continue;
    row.resolved = { doctor, category, items, targets: [] };
    for (const { visitType } of items) {
      const k = `${doctor.id}|${visitType}|${key(category.code)}`;
      slots.set(k, [...(slots.get(k) ?? []), { row, visitType }]);
    }
  }
  for (const group of slots.values()) {
    if (group.length < 2) continue;
    for (const { row, visitType } of group) {
      const rest = [...new Set(group.filter((g) => g.row !== row).map((g) => g.row.row))];
      if (!rest.length) continue;
      failOnce(
        row,
        "doctor",
        `${row.resolved.doctor.name} (${visitType}) in ${row.values.category_code} is also on ${rowList(rest)}; each doctor + visit_type + category_code can appear only once`,
      );
    }
  }
}

const spansMeet = (a, b) =>
  (a.valid_to === null || b.valid_from <= a.valid_to) &&
  (b.valid_to === null || a.valid_from <= b.valid_to);

const coversVisit = (rule, visitType) =>
  rule.visit_types == null || rule.visit_types.includes(visitType);

const stretches = ({ before, after }) =>
  !before ||
  after.valid_to === null ||
  (before.valid_to !== null && after.valid_to > before.valid_to);

function sheetRulesByCell(paymentRuleRows) {
  return indexBy(
    [...paymentRuleRows.values()].filter(
      (row) =>
        row.values.item_code != null &&
        row.values.active !== false &&
        !hasError(row, "item_code", "valid_from", "valid_to"),
    ),
    (row) => `${key(row.values.category_code)}|${key(row.values.item_code)}`,
  );
}

function laterStoredRule(state, scheme, dbItem, visitType, ops, op) {
  const skip = new Set(ops.map((o) => o.before?.id).filter(Boolean));
  return (
    (state.rulesBySlot.get(state.slotOf(scheme, dbItem.id)) ?? [])
      .filter(
        (r) =>
          r.is_active &&
          !skip.has(r.id) &&
          coversVisit(r, visitType) &&
          r.valid_from > op.after.valid_from &&
          (op.after.valid_to === null || r.valid_from <= op.after.valid_to),
      )
      .sort((a, b) => a.valid_from.localeCompare(b.valid_from) || a.id - b.id)[0] ?? null
  );
}

function checkConsultantFees(sheet, state, paymentRuleRows) {
  const today = indiaToday();
  const sheetRules = sheetRulesByCell(paymentRuleRows);
  const taken = new Set([...state.paymentRules.keys(), ...paymentRuleRows.keys()]);
  const freeName = (scheme, item, start) => {
    const name =
      [item.name, `${item.name} from ${start}`].find((n) => !taken.has(ruleKeyOf(scheme, n))) ??
      `${item.name} from ${start} (${Date.now()})`;
    taken.add(ruleKeyOf(scheme, name));
    return name;
  };
  const rates = [];
  for (const row of sheet.rows) {
    const { category, items } = row.resolved;
    if (!category || !items?.length || row.errors.length) continue;
    const v = row.values;
    const facts = categoryFacts(category, state.categories);
    const scheme = key(category.code);
    const payer = claimPayerProblem(facts, v);
    if (payer) fail(row, "remainder", payer);
    const given = v.valid_from === TODAY_ON_CREATE ? null : v.valid_from;
    const on = given ?? today;
    const values = {
      patient_pays: v.patient_pays,
      patient_value: TAKES_VALUE.includes(v.patient_pays) ? (v.patient_value ?? null) : null,
      remainder: v.remainder,
    };
    for (const { visitType, item } of items) {
      if (v.patient_pays === "amount" && values.patient_value !== null) {
        if (values.patient_value > v.fee) {
          fail(
            row,
            "patient_value",
            `The patient can't pay ${rupees(values.patient_value)} for ${item.name} in ${facts.name}: the fee there is ${rupees(v.fee)}. Lower the amount, or raise the fee.`,
          );
        }
      }
      const dbItem = state.dbItems.get(key(item.code));
      const existing = dbItem ? ownRateOn(state, scheme, dbItem.id, on) : null;
      const start = given ?? existing?.valid_from ?? today;
      const rateBefore = dbItem
        ? ((state.ratesBySlot.get(state.slotOf(scheme, dbItem.id)) ?? []).find(
            (r) => r.valid_from === start,
          ) ?? null)
        : null;
      const rate = {
        category_code: scheme,
        item_code: item.code,
        valid_from: start,
        valid_to: v.valid_to ?? null,
        rate: v.fee,
        bill_name: v.bill_name ?? null,
        bill_code: v.bill_code ?? null,
      };
      const current = dbItem ? ownRuleOn(state, scheme, dbItem, on) : null;
      const ops = [];
      if (current && (!given || given === current.valid_from)) {
        ops.push({ before: current, after: { ...current, ...values, valid_to: rate.valid_to } });
      } else if (current && sameRule(current, values)) {
        ops.push({ before: current, after: { ...current, valid_to: rate.valid_to } });
      } else {
        if (current) {
          ops.push({ before: current, after: { ...current, valid_to: dayBeforeText(on) } });
        }
        ops.push({
          before: null,
          after: {
            scheme_code: scheme,
            name: freeName(scheme, item, on),
            group_id: null,
            subgroup_id: null,
            item_code: item.code,
            visit_types: null,
            ...values,
            valid_from: on,
            valid_to: rate.valid_to,
            priority: 100,
            is_active: true,
          },
        });
      }
      for (const { before, after } of ops) {
        const problem = paymentRuleShapeProblem({
          group_id: null,
          subgroup_id: null,
          service_item_id: null,
          patient_pays: after.patient_pays,
          patient_value: after.patient_value,
          valid_from: after.valid_from,
          valid_to: after.valid_to,
        });
        if (problem) failOnce(row, PAYMENT_RULE_COLUMN[problem.field], problem.message);
        const clash = before && paymentRuleRows.get(ruleKeyOf(scheme, before.name));
        if (clash) {
          failOnce(
            row,
            "patient_pays",
            `This fee changes the payment rule "${before.name}", which is also on the Payment rules sheet (row ${clash.row}); change it in one place`,
          );
        }
      }
      const own = ops.at(-1);
      const touched = new Set(ops.filter((op) => op.before).map((op) => nameKey(op.before.name)));
      for (const other of sheetRules.get(`${scheme}|${key(item.code)}`) ?? []) {
        if (touched.has(nameKey(other.values.rule_name))) continue;
        if (!coversVisit(other.values, visitType) || !spansMeet(other.values, own.after)) continue;
        failOnce(
          row,
          "patient_pays",
          `The Payment rules sheet (row ${other.row}) also sets what the patient pays for ${item.name} in ${facts.name}; set it in one place`,
        );
      }
      if (dbItem) {
        for (const op of ops.filter(stretches)) {
          const later = laterStoredRule(state, scheme, dbItem, visitType, ops, op);
          if (later) failOnce(row, "valid_to", laterRuleText(item.name, facts.name, later));
        }
      }
      const ruleOps = ops.filter((op) => !op.before || ruleChanges(op.before, op.after).length);
      const changes = [
        ...rateChanges(rateBefore, rate),
        ...ruleChanges(current, ops.at(-1).after).filter((c) => c.column !== "valid_to"),
      ];
      row.resolved.targets.push({
        visitType,
        item,
        rate,
        rateChanged: !rateBefore || rateChanges(rateBefore, rate).length > 0,
        ruleOps,
        existed: Boolean(rateBefore || current),
        changes,
      });
      rates.push({ row: row.row, values: rate, errors: [], warnings: [], source: row });
    }
  }
  return rates;
}

const FEE_RATE_COLUMNS = { rate: "fee", item_code: "doctor" };

function copyRateFindings(rates, sheetRates) {
  const faulted = new Map(
    rates.map((rate) => [rate.source, new Set(rate.source.errors.map((e) => e.column))]),
  );
  const onSheet = new Map(
    sheetRates
      .filter((r) => !hasError(r, "category_code", "item_code", "valid_from"))
      .map((r) => [
        `${key(r.values.category_code)}|${key(r.values.item_code)}|${r.values.valid_from}`,
        r,
      ]),
  );
  for (const rate of rates) {
    const v = rate.values;
    const twin = onSheet.get(`${key(v.category_code)}|${key(v.item_code)}|${v.valid_from}`);
    if (twin) {
      failOnce(
        rate.source,
        "fee",
        `The rate for ${v.item_code} in ${v.category_code} from ${v.valid_from} is also on the Category rates sheet (row ${twin.row}); set it in one place`,
      );
    }
    for (const e of rate.errors) {
      const column = FEE_RATE_COLUMNS[e.column] ?? e.column;
      if (!faulted.get(rate.source).has(column)) failOnce(rate.source, column, e.message);
    }
    for (const w of rate.warnings) {
      warnOnce(rate.source, FEE_RATE_COLUMNS[w.column] ?? w.column, w.message);
    }
  }
}

function billCodesOf(rateRows, state, ref) {
  const codes = new Map();
  const describe = (code, scheme, itemName) => {
    const category = state.categories.get(key(scheme));
    codes.set(key(code), {
      code,
      item: itemName,
      category: category ? categoryName(category, state.categories) : scheme,
    });
  };
  for (const r of ref.rates ?? []) {
    if (!r.bill_code) continue;
    const item = state.items.get(key(state.codeById.items.get(r.service_item_id)));
    describe(r.bill_code, r.scheme_code, item?.name ?? r.service_item_id);
  }
  for (const r of rateRows) {
    if (!r.values.bill_code) continue;
    describe(
      r.values.bill_code,
      r.values.category_code,
      state.items.get(key(r.values.item_code))?.name ?? r.values.item_code,
    );
  }
  return codes;
}

function discountCodesOf(ref, sheet) {
  const codes = new Map((ref.discountCodes ?? []).map((d) => [key(d.code), d]));
  for (const row of sheet?.rows ?? []) {
    if (row.values.code && !hasError(row, "code", "rule_name")) {
      codes.set(key(row.values.code), { code: row.values.code, name: row.values.rule_name });
    }
  }
  return codes;
}

function keptCodes(stored, field, codeById) {
  return new Set((stored?.[field] ?? []).map((id) => key(codeById.get(id))));
}

function resolveCodes(row, column, entries, target, state, kept) {
  const typed = row.values[column];
  if (!typed || hasError(row, column)) return null;
  const found = new Map();
  const off = [];
  for (const code of typed) {
    const entry = entries.get(key(code));
    if (!entry) {
      missingParent(row, column, target.noun, target.sheet, state, code);
      continue;
    }
    if (!entry.active && !kept.has(key(entry.code))) off.push(entry.name);
    found.set(key(entry.code), entry.code);
  }
  if (off.length) {
    fail(
      row,
      column,
      `Deactivated ${target.noun}${off.length === 1 ? "" : "s"}: ${off.join(", ")}`,
    );
  }
  return found.size ? [...found.values()] : null;
}

function resolveDoctors(row, lookup, kept) {
  const typed = row.values.doctors;
  if (!typed || hasError(row, "doctors")) return null;
  const ids = new Set();
  const off = [];
  for (const text of typed) {
    const found = findDoctor(text, lookup);
    if (found.error) {
      fail(row, "doctors", found.error);
      continue;
    }
    if (found.doctor.is_active === false && !kept.has(found.doctor.id)) off.push(found.doctor.name);
    ids.add(found.doctor.id);
  }
  if (off.length) {
    fail(row, "doctors", `Deactivated doctor${off.length === 1 ? "" : "s"}: ${off.join(", ")}`);
  }
  return ids.size ? [...ids] : null;
}

function resolveDiscountCategories(row, state, kept) {
  const typed = row.values.categories;
  if (!typed || hasError(row, "categories")) return null;
  const { categories } = state;
  const found = [];
  const retired = [];
  for (const code of typed) {
    if (RESERVED_CATEGORY_CODES.includes(code)) {
      found.push({ code });
      continue;
    }
    const entry = categories.get(key(code));
    if (!entry) {
      missingParent(row, "categories", "category", "Categories", state, code);
      continue;
    }
    if (!categoryLive(entry, categories) && !kept.has(key(entry.code))) {
      retired.push(categoryName(entry, categories));
    }
    found.push(entry);
  }
  if (retired.length) fail(row, "categories", `Retired: ${retired.join(", ")}`);
  const listed = new Set(found.map((c) => key(c.code)));
  const covered = found.filter((c) => c.parent && listed.has(c.parent));
  if (covered.length) {
    const parent = categories.get(covered[0].parent);
    fail(
      row,
      "categories",
      `${parent.name} already covers its sub-categories, so ${covered
        .map((c) => categoryName(c, categories))
        .join(
          ", ",
        )} ${covered.length === 1 ? "is" : "are"} already included; choose the category or its sub-categories, not both`,
    );
  }
  return found.length ? found.map((c) => key(c.code)) : null;
}

const SHAPE_COLUMNS = [
  "method",
  "code",
  "allowed_roles",
  "kind",
  "value",
  "max_discount",
  "min_age",
  "max_age",
  "valid_from",
  "valid_to",
];

function checkDiscounts(sheet, state, lookup, billCodes) {
  for (const row of sheet.rows) {
    const v = row.values;
    const stored = hasError(row, "rule_name")
      ? null
      : (state.discounts.get(nameKey(v.rule_name)) ?? null);
    const reviving = Boolean(stored) && !stored.is_active && v.active === true;
    const before = reviving ? null : stored;
    if (
      !hasError(row, "method") &&
      v.method === "auto" &&
      !String(row.input?.allowed_roles ?? "").trim()
    ) {
      v.allowed_roles = null;
    }
    v.allowed_roles = inOrder(v.allowed_roles, BILLING_ROLES);
    v.visit_types = inOrder(v.visit_types, VISIT_TYPES);
    if (!hasError(row, "valid_from")) v.valid_from = startOf(v.valid_from, stored);
    for (const column of ["min_age", "max_age"]) {
      if (!hasError(row, column) && v[column] != null && v[column] > MAX_AGE) {
        fail(row, column, `${column} must be ${MAX_AGE} or less`);
      }
    }
    for (const column of USE_LIMITS) {
      if (!hasError(row, column) && v[column] === 0) {
        fail(row, column, `${column} must be 1 or more; leave it blank for no limit`);
      }
    }
    if (!hasError(row, ...SHAPE_COLUMNS)) {
      const problem = discountShapeProblem({
        method: v.method,
        code: v.code ?? null,
        allowed_roles: v.allowed_roles ?? null,
        kind: v.kind,
        value: v.value ?? null,
        max_discount: v.max_discount ?? null,
        applies_per: stored?.applies_per ?? "line",
        min_age: v.min_age ?? null,
        max_age: v.max_age ?? null,
        valid_from: v.valid_from ?? null,
        valid_to: v.valid_to ?? null,
      });
      if (problem) fail(row, DISCOUNT_COLUMN[problem.field], problem.message);
    }
    row.resolved = {
      stored,
      groups: resolveCodes(
        row,
        "groups",
        state.groups,
        SCOPES[0],
        state,
        keptCodes(before, "group_ids", state.codeById.groups),
      ),
      subgroups: resolveCodes(
        row,
        "subgroups",
        state.subgroups,
        SCOPES[1],
        state,
        keptCodes(before, "subgroup_ids", state.codeById.subgroups),
      ),
      items: resolveCodes(
        row,
        "items",
        state.items,
        SCOPES[2],
        state,
        keptCodes(before, "service_item_ids", state.codeById.items),
      ),
      doctors: resolveDoctors(row, lookup, new Set(before?.doctor_ids ?? [])),
      categories: resolveDiscountCategories(row, state, new Set(before?.scheme_codes ?? [])),
    };
    if (v.code && !hasError(row, "code")) {
      const other = state.discountsByCode.get(key(v.code));
      if (other && nameKey(other.name) !== nameKey(v.rule_name)) {
        fail(row, "code", `The discount "${other.name}" already uses the code ${v.code}`);
      }
      const bill = billCodes.get(key(v.code));
      if (bill) {
        fail(
          row,
          "code",
          `${bill.code} is already the bill code of ${bill.item} for ${bill.category}; choose another discount code`,
        );
      }
    }
  }
}

export function checkMasterRows(sheets, ref, options = {}) {
  for (const sheet of sheets) {
    for (const row of sheet.rows) row.warnings ??= [];
  }
  const sheetOf = (name) => sheets.find((s) => s.name === name);
  lowerCategoryCodes(sheets);
  for (const [name, columns] of [
    ["Groups", "group_code"],
    ["Subgroups", "subgroup_code"],
    ["Items", "item_code"],
    ["Categories", "category_code"],
    ["Category rules", ["category_code", "rule_name"]],
    ["Category rates", ["category_code", "item_code", "valid_from"]],
    ["Payment rules", ["category_code", "rule_name"]],
    ["Discounts", "rule_name"],
    ["Discounts", "code"],
  ]) {
    if (sheetOf(name)) markDuplicates(sheetOf(name).rows, columns);
  }
  if (sheetOf("Categories")) checkCategoryCodes(sheetOf("Categories"));
  const lookup = referenceIndex(ref);
  const items = sheetOf("Items");
  if (items) resolveItems(items, lookup);
  const state = buildState(sheets, ref);
  if (sheetOf("Groups")) checkGroups(sheetOf("Groups"), state);
  if (sheetOf("Subgroups")) checkSubgroups(sheetOf("Subgroups"), state);
  if (items) checkItemsAgainstState(items, state, lookup);
  if (sheetOf("Categories")) checkCategories(sheetOf("Categories"), state, options);
  if (sheetOf("Category rules")) checkRules(sheetOf("Category rules"), state);
  const paymentRules = sheetOf("Payment rules");
  if (paymentRules) checkPaymentRules(paymentRules, state);
  const paymentRuleRows = new Map(
    (paymentRules?.rows ?? [])
      .filter((row) => !hasError(row, "category_code", "rule_name"))
      .map((row) => [ruleKeyOf(row.values.category_code, row.values.rule_name), row]),
  );
  const fees = sheetOf("Consultant fees");
  if (fees) prepareConsultantFees(fees, state, lookup);
  const feeRates = fees ? checkConsultantFees(fees, state, paymentRuleRows) : [];
  const sheetRates = sheetOf("Category rates")?.rows ?? [];
  const discountCodes = discountCodesOf(ref, sheetOf("Discounts"));
  if (sheetRates.length || feeRates.length) {
    checkRates([...sheetRates, ...feeRates], state, ref, discountCodes);
  }
  copyRateFindings(feeRates, sheetRates);
  if (sheetOf("Discounts")) {
    checkDiscounts(
      sheetOf("Discounts"),
      state,
      lookup,
      billCodesOf([...sheetRates, ...feeRates], state, ref),
    );
  }
  return sheets;
}

export async function validateUpload(parsed, db = pool, options = {}) {
  if (parsed.problems.length) return parsed;
  const ref = await loadReference(db);
  checkMasterRows(parsed.sheets, ref, options);
  return parsed;
}
