import pool from "../../config/db.js";
import {
  checkClaimPayers,
  conflictText,
  priceConflicts,
  throwPriceConflicts,
  tooCheapText,
} from "./paymentRules.js";
import { parseUpload } from "./importParse.js";
import { markStatus, summarize } from "./importPreview.js";
import { checkMasterRows, key, loadReference, nameKey, ruleKeyOf } from "./importValidate.js";
import { writeAudit, writeAuditMany } from "./audit.js";
import { auditFields } from "./common.js";
import { httpError } from "./transaction.js";

const IMPORT_LOCK = "billing_import";
const STAMP_IGNORED = new Set(["updated_at", "updated_by", "created_at", "created_by"]);

const TABLES = {
  groups: {
    table: "service_groups",
    insert: { code: "text", name: "text", sort_order: "int", is_active: "boolean" },
    update: { name: "text", sort_order: "int", is_active: "boolean" },
  },
  subgroups: {
    table: "service_subgroups",
    insert: {
      group_id: "int",
      code: "text",
      name: "text",
      sort_order: "int",
      is_active: "boolean",
    },
    update: { group_id: "int", name: "text", sort_order: "int", is_active: "boolean" },
  },
  items: {
    table: "service_items",
    insert: {
      code: "text",
      name: "text",
      subgroup_id: "int",
      base_price: "numeric",
      unit: "text",
      allow_quantity: "boolean",
      max_quantity: "int",
      tax_code_id: "int",
      kind: "text",
      doctor_id: "int",
      visit_type: "text",
      test_catalog_id: "uuid",
      is_active: "boolean",
    },
  },
  categories: {
    table: "patient_schemes",
    id: "code",
    idType: "text",
    stamped: false,
    insert: {
      code: "text",
      label: "text",
      parent_code: "text",
      payer_name: "text",
      requires_ref: "boolean",
      requires_referral: "boolean",
      requires_referral_doc: "boolean",
      print_category_on_bill: "boolean",
      allow_pay_later: "boolean",
      daily_cap: "int",
      is_active: "boolean",
    },
  },
  rules: {
    table: "category_rules",
    insert: {
      scheme_code: "text",
      name: "text",
      min_age: "int",
      max_age: "int",
      gender: "text",
      requires_card: "boolean",
      mode: "text",
      priority: "int",
      is_active: "boolean",
    },
    update: {
      min_age: "int",
      max_age: "int",
      gender: "text",
      requires_card: "boolean",
      mode: "text",
      priority: "int",
      is_active: "boolean",
    },
  },
  paymentRules: {
    table: "category_payment_rules",
    insert: {
      scheme_code: "text",
      name: "text",
      group_id: "int",
      subgroup_id: "int",
      service_item_id: "int",
      visit_types: "text[]",
      patient_pays: "text",
      patient_value: "numeric",
      remainder: "text",
      valid_from: "date",
      valid_to: "date",
      priority: "int",
      is_active: "boolean",
    },
  },
  discounts: {
    table: "discount_rules",
    insert: {
      name: "text",
      code: "text",
      method: "text",
      kind: "text",
      value: "numeric",
      max_discount: "numeric",
      group_ids: "int[]",
      subgroup_ids: "int[]",
      service_item_ids: "int[]",
      doctor_ids: "int[]",
      visit_types: "text[]",
      scheme_codes: "text[]",
      min_age: "int",
      max_age: "int",
      gender: "text",
      valid_from: "date",
      valid_to: "date",
      max_uses_total: "int",
      max_uses_per_patient: "int",
      max_uses_per_day: "int",
      max_uses_per_doctor_per_day: "int",
      priority: "int",
      stackable: "boolean",
      applies_on_scheme_rate: "boolean",
      allowed_roles: "text[]",
      is_active: "boolean",
    },
  },
};
const allBut = (types, ...skip) =>
  Object.fromEntries(Object.entries(types).filter(([column]) => !skip.includes(column)));
TABLES.paymentRules.update = allBut(TABLES.paymentRules.insert, "scheme_code", "name");
TABLES.discounts.update = allBut(TABLES.discounts.insert, "name");
TABLES.items.update = Object.fromEntries(
  Object.entries(TABLES.items.insert).filter(([column]) => column !== "code"),
);
TABLES.categories.update = Object.fromEntries(
  Object.entries(TABLES.categories.insert).filter(([column]) => column !== "code"),
);

const recordset = (types) =>
  Object.entries(types)
    .map(([column, type]) => `${column} ${type}`)
    .join(", ");

function actionFor(before, after) {
  const changed = Object.keys(after).filter(
    (k) => !STAMP_IGNORED.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  if (changed.length === 1 && changed[0] === "is_active") {
    return after.is_active ? "activate" : "deactivate";
  }
  return "update";
}

async function insertRows(client, spec, rows, ctx) {
  if (!rows.length) return [];
  const columns = Object.keys(spec.insert);
  const stamped = spec.stamped !== false;
  const { rows: created } = await client.query(
    `INSERT INTO ${spec.table} (${columns.join(", ")}${stamped ? ", created_by, updated_by" : ""})
     SELECT ${columns.map((c) => `x.${c}`).join(", ")}${stamped ? ", $2, $2" : ""}
       FROM jsonb_to_recordset($1::jsonb) AS x(${recordset(spec.insert)})
     RETURNING *`,
    stamped ? [JSON.stringify(rows), ctx.actorId] : [JSON.stringify(rows)],
  );
  return created;
}

async function updateRows(client, spec, rows, ctx) {
  if (!rows.length) return [];
  const id = spec.id ?? "id";
  const idType = spec.idType ?? "int";
  const stamped = spec.stamped !== false;
  const { rows: before } = await client.query(
    `SELECT * FROM ${spec.table} WHERE ${id} = ANY($1::${idType}[]) FOR UPDATE`,
    [rows.map((r) => r[id])],
  );
  const columns = Object.keys(spec.update);
  const { rows: after } = await client.query(
    `UPDATE ${spec.table} t
        SET ${columns.map((c) => `${c} = x.${c}`).join(", ")},
            updated_at = NOW()${stamped ? ", updated_by = $2" : ""}
       FROM jsonb_to_recordset($1::jsonb) AS x(${id} ${idType}, ${recordset(spec.update)})
      WHERE t.${id} = x.${id}
     RETURNING t.*`,
    stamped ? [JSON.stringify(rows), ctx.actorId] : [JSON.stringify(rows)],
  );
  const beforeById = new Map(before.map((r) => [r[id], r]));
  return after.map((row) => ({ before: beforeById.get(row[id]), after: row }));
}

const rowsOf = (sheets, name) =>
  (sheets.find((s) => s.name === name)?.rows ?? []).filter(
    (row) => row.status === "new" || row.status === "update",
  );

function auditOf(entity, idOf, created, updated) {
  return [
    ...created.map((after) => ({ entity, entityId: idOf(after), action: "create", after })),
    ...updated.map(({ before, after }) => ({
      entity,
      entityId: idOf(after),
      action: actionFor(before, after),
      before,
      after,
    })),
  ];
}

async function saveGroups(client, sheets, ids, ctx, audit) {
  const rows = rowsOf(sheets, "Groups");
  const values = (row) => ({
    name: row.values.name,
    sort_order: row.values.sort_order,
    is_active: row.values.active,
  });
  const updated = await updateRows(
    client,
    TABLES.groups,
    rows
      .filter((r) => r.status === "update")
      .map((r) => ({ id: ids.groups.get(key(r.values.group_code)), ...values(r) })),
    ctx,
  );
  const created = await insertRows(
    client,
    TABLES.groups,
    rows
      .filter((r) => r.status === "new")
      .map((r) => ({ code: r.values.group_code, ...values(r) })),
    ctx,
  );
  for (const g of created) ids.groups.set(key(g.code), g.id);
  audit.push(...auditOf("service_groups", (r) => r.id, created, updated));
}

async function saveSubgroups(client, sheets, ids, ctx, audit) {
  const rows = rowsOf(sheets, "Subgroups");
  const values = (row) => ({
    group_id: ids.groups.get(key(row.values.group_code)),
    name: row.values.name,
    sort_order: row.values.sort_order,
    is_active: row.values.active,
  });
  const updated = await updateRows(
    client,
    TABLES.subgroups,
    rows
      .filter((r) => r.status === "update")
      .map((r) => ({ id: ids.subgroups.get(key(r.values.subgroup_code)), ...values(r) })),
    ctx,
  );
  const created = await insertRows(
    client,
    TABLES.subgroups,
    rows
      .filter((r) => r.status === "new")
      .map((r) => ({ code: r.values.subgroup_code, ...values(r) })),
    ctx,
  );
  for (const s of created) ids.subgroups.set(key(s.code), s.id);
  audit.push(...auditOf("service_subgroups", (r) => r.id, created, updated));
}

async function saveItems(client, sheets, ids, ctx, audit, reason) {
  const rows = rowsOf(sheets, "Items");
  const values = (row) => ({
    name: row.values.name,
    subgroup_id: ids.subgroups.get(key(row.values.subgroup_code)),
    base_price: row.values.base_price,
    unit: row.values.unit,
    allow_quantity: row.values.allow_quantity,
    max_quantity: row.values.max_quantity,
    tax_code_id: row.resolved?.taxCode?.id ?? null,
    kind: row.values.kind,
    doctor_id: row.resolved?.doctor?.id ?? null,
    visit_type: row.values.visit_type,
    test_catalog_id: row.resolved?.test?.id ?? null,
    is_active: row.values.active,
  });
  const updates = rows
    .filter((r) => r.status === "update")
    .map((r) => ({ id: ids.items.get(key(r.values.item_code)), ...values(r) }));
  const updated = [
    ...(await updateRows(
      client,
      TABLES.items,
      updates.filter((u) => !u.is_active),
      ctx,
    )),
    ...(await updateRows(
      client,
      TABLES.items,
      updates.filter((u) => u.is_active),
      ctx,
    )),
  ];
  const created = await insertRows(
    client,
    TABLES.items,
    rows.filter((r) => r.status === "new").map((r) => ({ code: r.values.item_code, ...values(r) })),
    ctx,
  );
  for (const i of created) ids.items.set(key(i.code), i.id);
  audit.push(...auditOf("service_items", (r) => r.id, created, updated));

  const history = [
    ...created.map((i) => ({
      service_item_id: i.id,
      old_price: null,
      new_price: i.base_price,
      reason: "Created",
    })),
    ...updated
      .filter(({ before, after }) => Number(before.base_price) !== Number(after.base_price))
      .map(({ before, after }) => ({
        service_item_id: after.id,
        old_price: before.base_price,
        new_price: after.base_price,
        reason,
      })),
  ];
  if (history.length) {
    await client.query(
      `INSERT INTO service_item_price_history (service_item_id, old_price, new_price, reason, changed_by)
       SELECT x.service_item_id, x.old_price, x.new_price, x.reason, $2
         FROM jsonb_to_recordset($1::jsonb)
           AS x(service_item_id int, old_price numeric, new_price numeric, reason text)`,
      [JSON.stringify(history), ctx.actorId],
    );
  }
}

async function saveCategories(client, sheets, ctx, audit) {
  const rows = rowsOf(sheets, "Categories");
  const values = (row) => ({
    label: row.values.label,
    parent_code: row.values.parent_code,
    payer_name: row.values.payer_name,
    requires_ref: row.values.requires_ref,
    requires_referral: row.values.requires_referral,
    requires_referral_doc: row.values.requires_referral_doc,
    print_category_on_bill: row.values.print_on_bill,
    allow_pay_later: row.values.allow_pay_later,
    daily_cap: row.values.daily_cap,
    is_active: row.values.active,
  });
  const fresh = rows.filter((r) => r.status === "new");
  const create = (list) =>
    insertRows(
      client,
      TABLES.categories,
      list.map((r) => ({ code: r.values.category_code, ...values(r) })),
      ctx,
    );
  const tops = await create(fresh.filter((r) => !r.values.parent_code));
  const updated = await updateRows(
    client,
    TABLES.categories,
    rows
      .filter((r) => r.status === "update")
      .map((r) => ({ code: r.values.category_code, ...values(r) })),
    ctx,
  );
  const subs = await create(fresh.filter((r) => r.values.parent_code));
  for (const { before, after } of updated) {
    if (before.payer_name !== after.payer_name || before.parent_code !== after.parent_code) {
      await checkClaimPayers(client, after.code);
    }
  }
  audit.push(...auditOf("patient_schemes", (r) => r.code, [...tops, ...subs], updated));
}

async function saveRules(client, sheets, ids, ctx, audit) {
  const rows = rowsOf(sheets, "Category rules");
  const values = (row) => ({
    min_age: row.values.min_age,
    max_age: row.values.max_age,
    gender: row.values.gender,
    requires_card: row.values.requires_card,
    mode: row.values.mode,
    priority: row.values.priority,
    is_active: row.values.active,
  });
  const ruleKey = (r) => `${key(r.values.category_code)}|${nameKey(r.values.rule_name)}`;
  const updated = await updateRows(
    client,
    TABLES.rules,
    rows
      .filter((r) => r.status === "update")
      .map((r) => ({ id: ids.rules.get(ruleKey(r)), ...values(r) })),
    ctx,
  );
  const created = await insertRows(
    client,
    TABLES.rules,
    rows
      .filter((r) => r.status === "new")
      .map((r) => ({
        scheme_code: r.values.category_code,
        name: r.values.rule_name,
        ...values(r),
      })),
    ctx,
  );
  audit.push(...auditOf("category_rules", (r) => r.id, created, updated));
}

const rateId = (r) => `${r.scheme_code}:${r.service_item_id}:${r.valid_from}`;

const categoryKey = (code) => String(code ?? "").toLowerCase();

const feeTargets = (sheets) =>
  rowsOf(sheets, "Consultant fees").flatMap((row) =>
    (row.resolved?.targets ?? []).map((target) => ({ row, ...target })),
  );

async function importConflicts(client, sheets, ids, ruleCodes) {
  const itemIds = [
    ...[...rowsOf(sheets, "Items"), ...rowsOf(sheets, "Category rates")].map((r) =>
      ids.items.get(key(r.values.item_code)),
    ),
    ...feeTargets(sheets)
      .filter((t) => t.rateChanged)
      .map((t) => ids.items.get(key(t.item.code))),
  ];
  const subgroupIds = rowsOf(sheets, "Subgroups")
    .filter((r) => r.status === "update")
    .map((r) => ids.subgroups.get(key(r.values.subgroup_code)));
  if (subgroupIds.length) {
    const { rows } = await client.query(
      `SELECT id FROM service_items WHERE subgroup_id = ANY($1::int[]) AND is_active`,
      [subgroupIds],
    );
    itemIds.push(...rows.map((r) => r.id));
  }
  const schemeCodes = rowsOf(sheets, "Categories")
    .filter((r) => r.status === "update")
    .map((r) => categoryKey(r.values.category_code));
  const found = [
    ...(await priceConflicts(client, { itemIds })),
    ...(await priceConflicts(client, { schemeCodes: [...schemeCodes, ...ruleCodes] })),
  ];
  const seen = new Set();
  return found.filter((c) => {
    const id = `${c.rule_id}:${c.id}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function rowsInConflict(sheets, conflict) {
  const categories = [conflict.billed_code, conflict.billed_parent].filter(Boolean);
  const inCategories = (r) => categories.includes(categoryKey(r.values.category_code));
  const changed = (r, column) => r.changes?.some((c) => c.column === column);
  return [
    ...rowsOf(sheets, "Items")
      .filter((r) => key(r.values.item_code) === key(conflict.code))
      .map((row) => [row, "base_price"]),
    ...rowsOf(sheets, "Category rates")
      .filter((r) => key(r.values.item_code) === key(conflict.code) && inCategories(r))
      .map((row) => [row, "rate"]),
    ...feeTargets(sheets)
      .filter(
        (t) =>
          t.rateChanged &&
          key(t.item.code) === key(conflict.code) &&
          categories.includes(t.rate.category_code),
      )
      .map((t) => [t.row, "fee"]),
    ...rowsOf(sheets, "Subgroups")
      .filter(
        (r) => r.status === "update" && key(r.values.subgroup_code) === key(conflict.subgroup_code),
      )
      .map((row) => [row, "group_code"]),
    ...rowsOf(sheets, "Categories")
      .filter((r) => r.status === "update" && inCategories(r))
      .map((row) => [row, changed(row, "parent_code") ? "parent_code" : "active"]),
  ];
}

function markConflicts(parsed, conflicts, ruleRows) {
  const byRule = new Map();
  for (const conflict of conflicts) {
    const owner = ruleRows.get(conflict.rule_id);
    if (owner) byRule.set(owner, [...(byRule.get(owner) ?? []), conflict]);
  }
  const marked = conflicts.map((conflict) => [
    conflict,
    rowsInConflict(parsed.sheets, conflict).filter(
      ([row]) => row !== ruleRows.get(conflict.rule_id)?.row,
    ),
  ]);
  for (const [conflict, rows] of marked) {
    if (!rows.length && !ruleRows.has(conflict.rule_id)) {
      parsed.problems.push(conflictText(conflict));
    }
    for (const [row, column] of rows) row.errors.push({ column, message: conflictText(conflict) });
  }
  for (const [{ row, column }, list] of byRule) {
    const message = tooCheapText(list[0].amount, list);
    if (!row.errors.some((e) => e.message === message)) row.errors.push({ column, message });
    row.status = "error";
  }
  for (const [, rows] of marked) for (const [row] of rows) row.status = "error";
}

async function writeSheets(client, sheets, ref, ctx, reason) {
  const ids = idMaps(ref);
  const audit = [];
  const ruleRows = new Map();
  await saveGroups(client, sheets, ids, ctx, audit);
  await saveSubgroups(client, sheets, ids, ctx, audit);
  await saveItems(client, sheets, ids, ctx, audit, reason);
  await saveCategories(client, sheets, ctx, audit);
  await saveRules(client, sheets, ids, ctx, audit);
  await saveRates(client, sheets, ids, ctx, audit);
  await savePaymentRules(client, sheets, ids, ctx, audit, ruleRows);
  await saveConsultantFees(client, sheets, ids, ctx, audit, ruleRows);
  await saveDiscounts(client, sheets, ids, ctx, audit);
  const ruleCodes = [...new Set([...ruleRows.values()].map((r) => r.scheme))];
  for (const code of ruleCodes) await checkClaimPayers(client, code);
  return {
    audit,
    conflicts: await importConflicts(client, sheets, ids, ruleCodes),
    ruleRows,
  };
}

export async function tryUploadWrites(parsed, ref, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [IMPORT_LOCK]);
    const { conflicts, ruleRows } = await writeSheets(
      client,
      parsed.sheets,
      ref,
      { actorId: null, ip: null, importId: null },
      "Preview",
    );
    markConflicts(parsed, conflicts, ruleRows);
  } catch (error) {
    if (!error.status && !String(error.code ?? "").startsWith("23")) throw explain(error);
    parsed.problems.push(
      error.status ? error.message : `Saving this file would fail: ${error.message}`,
    );
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

const rateRow = (values, ids) => ({
  scheme_code: values.category_code,
  service_item_id: ids.items.get(key(values.item_code)),
  valid_from: values.valid_from,
  valid_to: values.valid_to,
  rate: values.rate,
  bill_name: values.bill_name,
  bill_code: values.bill_code,
});

async function saveRates(client, sheets, ids, ctx, audit) {
  const rows = rowsOf(sheets, "Category rates").map((r) => rateRow(r.values, ids));
  await writeRates(client, rows, ctx, audit);
}

const ruleValues = (rule) => ({
  group_id: rule.group_id,
  subgroup_id: rule.subgroup_id,
  service_item_id: rule.service_item_id,
  visit_types: rule.visit_types,
  patient_pays: rule.patient_pays,
  patient_value: rule.patient_value,
  remainder: rule.remainder,
  valid_from: rule.valid_from,
  valid_to: rule.valid_to,
  priority: rule.priority,
  is_active: rule.is_active,
});

async function writePaymentRules(client, updates, inserts, ctx, audit, ruleRows) {
  const updated = await updateRows(
    client,
    TABLES.paymentRules,
    updates.map(({ id, rule }) => ({ id, ...ruleValues(rule) })),
    ctx,
  );
  const created = await insertRows(
    client,
    TABLES.paymentRules,
    inserts.map(({ rule }) => ({
      scheme_code: rule.scheme_code,
      name: rule.name,
      ...ruleValues(rule),
    })),
    ctx,
  );
  const byId = new Map(updates.map((u) => [u.id, u.owner]));
  const byKey = new Map(inserts.map((i) => [ruleKeyOf(i.rule.scheme_code, i.rule.name), i.owner]));
  for (const { after } of updated)
    ruleRows.set(after.id, { ...byId.get(after.id), scheme: after.scheme_code });
  for (const rule of created) {
    ruleRows.set(rule.id, {
      ...byKey.get(ruleKeyOf(rule.scheme_code, rule.name)),
      scheme: rule.scheme_code,
    });
  }
  audit.push(...auditOf("category_payment_rules", (r) => r.id, created, updated));
}

async function savePaymentRules(client, sheets, ids, ctx, audit, ruleRows) {
  const rows = rowsOf(sheets, "Payment rules");
  const scopeId = (map, code) => (code ? map.get(key(code)) : null);
  const rule = (row) => ({
    scheme_code: row.values.category_code,
    name: row.values.rule_name,
    group_id: scopeId(ids.groups, row.values.group_code),
    subgroup_id: scopeId(ids.subgroups, row.values.subgroup_code),
    service_item_id: scopeId(ids.items, row.values.item_code),
    visit_types: row.values.visit_types,
    patient_pays: row.values.patient_pays,
    patient_value: row.values.patient_value,
    remainder: row.values.remainder,
    valid_from: row.values.valid_from,
    valid_to: row.values.valid_to,
    priority: row.values.priority,
    is_active: row.values.active,
  });
  const owner = (row) => ({ row, column: "patient_value" });
  await writePaymentRules(
    client,
    rows
      .filter((r) => r.status === "update")
      .map((r) => ({
        id: ids.paymentRules.get(ruleKeyOf(r.values.category_code, r.values.rule_name)),
        rule: rule(r),
        owner: owner(r),
      })),
    rows.filter((r) => r.status === "new").map((r) => ({ rule: rule(r), owner: owner(r) })),
    ctx,
    audit,
    ruleRows,
  );
}

async function saveConsultantFees(client, sheets, ids, ctx, audit, ruleRows) {
  const targets = feeTargets(sheets);
  if (!targets.length) return;
  await writeRates(
    client,
    targets.filter((t) => t.rateChanged).map((t) => rateRow(t.rate, ids)),
    ctx,
    audit,
  );
  const ops = targets.flatMap((t) =>
    t.ruleOps.map((op) => ({ ...op, owner: { row: t.row, column: "patient_value" } })),
  );
  await writePaymentRules(
    client,
    ops
      .filter((op) => op.before)
      .map((op) => ({ id: op.before.id, rule: op.after, owner: op.owner })),
    ops
      .filter((op) => !op.before)
      .map((op) => ({
        rule: { ...op.after, service_item_id: ids.items.get(key(op.after.item_code)) },
        owner: op.owner,
      })),
    ctx,
    audit,
    ruleRows,
  );
}

async function saveDiscounts(client, sheets, ids, ctx, audit) {
  const rows = rowsOf(sheets, "Discounts");
  if (!rows.length) return;
  const idsOf = (codes, map) => (codes ? codes.map((code) => map.get(key(code))) : null);
  const values = ({ values: v, resolved }) => ({
    code: v.code,
    method: v.method,
    kind: v.kind,
    value: v.value,
    max_discount: v.max_discount,
    group_ids: idsOf(resolved.groups, ids.groups),
    subgroup_ids: idsOf(resolved.subgroups, ids.subgroups),
    service_item_ids: idsOf(resolved.items, ids.items),
    doctor_ids: resolved.doctors,
    visit_types: v.visit_types,
    scheme_codes: resolved.categories,
    min_age: v.min_age,
    max_age: v.max_age,
    gender: v.gender,
    valid_from: v.valid_from,
    valid_to: v.valid_to,
    max_uses_total: v.max_uses_total,
    max_uses_per_patient: v.max_uses_per_patient,
    max_uses_per_day: v.max_uses_per_day,
    max_uses_per_doctor_per_day: v.max_uses_per_doctor_per_day,
    priority: v.priority,
    stackable: v.stackable,
    applies_on_scheme_rate: v.applies_on_scheme_rate,
    allowed_roles: v.allowed_roles,
    is_active: v.active,
  });
  const updated = await updateRows(
    client,
    TABLES.discounts,
    rows
      .filter((r) => r.status === "update")
      .map((r) => ({ id: ids.discounts.get(nameKey(r.values.rule_name)), ...values(r) })),
    ctx,
  );
  const created = await insertRows(
    client,
    TABLES.discounts,
    rows.filter((r) => r.status === "new").map((r) => ({ name: r.values.rule_name, ...values(r) })),
    ctx,
  );
  audit.push(...auditOf("discount_rules", (r) => r.id, created, updated));
}

async function writeRates(client, rows, ctx, audit) {
  if (!rows.length) return;
  const keys = JSON.stringify(
    rows.map(({ scheme_code, service_item_id, valid_from }) => ({
      scheme_code,
      service_item_id,
      valid_from,
    })),
  );
  const KEYS = `jsonb_to_recordset($1::jsonb) AS k(scheme_code text, service_item_id int, valid_from date)`;
  const { rows: before } = await client.query(
    `SELECT r.*
       FROM category_item_rates r JOIN ${KEYS}
         ON r.scheme_code = k.scheme_code AND r.service_item_id = k.service_item_id
        AND r.valid_from = k.valid_from
        FOR UPDATE OF r`,
    [keys],
  );
  const { rows: saved } = await client.query(
    `INSERT INTO category_item_rates
            (scheme_code, service_item_id, valid_from, valid_to, rate, bill_name, bill_code,
             created_by, updated_by)
     SELECT x.scheme_code, x.service_item_id, x.valid_from, x.valid_to, x.rate, x.bill_name,
            x.bill_code, $2, $2
       FROM jsonb_to_recordset($1::jsonb)
         AS x(scheme_code text, service_item_id int, valid_from date, valid_to date,
              rate numeric, bill_name text, bill_code text)
     ON CONFLICT (scheme_code, service_item_id, valid_from) DO UPDATE
        SET valid_to = EXCLUDED.valid_to, rate = EXCLUDED.rate, bill_name = EXCLUDED.bill_name,
            bill_code = EXCLUDED.bill_code, updated_at = NOW(), updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [JSON.stringify(rows), ctx.actorId],
  );
  const beforeById = new Map(before.map((r) => [rateId(r), r]));
  const open = rows.filter((r) => r.valid_to === null);
  const { rows: ended } = open.length
    ? await client.query(
        `UPDATE category_item_rates r
            SET valid_to = x.valid_from - 1, updated_at = NOW(), updated_by = $3
           FROM jsonb_to_recordset($1::jsonb)
             AS x(scheme_code text, service_item_id int, valid_from date)
          WHERE r.scheme_code = x.scheme_code AND r.service_item_id = x.service_item_id
            AND r.valid_to IS NULL AND r.valid_from < x.valid_from
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_to_recordset($2::jsonb)
                AS k(scheme_code text, service_item_id int, valid_from date)
               WHERE k.scheme_code = r.scheme_code AND k.service_item_id = r.service_item_id
                 AND k.valid_from = r.valid_from)
        RETURNING r.*`,
        [JSON.stringify(open), keys, ctx.actorId],
      )
    : { rows: [] };
  audit.push(
    ...saved.map((after) => {
      const prior = beforeById.get(rateId(after));
      return prior
        ? {
            entity: "category_item_rates",
            entityId: rateId(after),
            action: "update",
            before: prior,
            after,
          }
        : { entity: "category_item_rates", entityId: rateId(after), action: "create", after };
    }),
    ...ended.map((after) => ({
      entity: "category_item_rates",
      entityId: rateId(after),
      action: "update",
      before: { ...after, valid_to: null },
      after,
    })),
  );
}

function idMaps(ref) {
  return {
    groups: new Map(ref.groups.map((g) => [key(g.code), g.id])),
    subgroups: new Map(ref.subgroups.map((s) => [key(s.code), s.id])),
    items: new Map(ref.items.map((i) => [key(i.code), i.id])),
    rules: new Map(
      (ref.rules ?? []).map((r) => [`${key(r.scheme_code)}|${nameKey(r.name)}`, r.id]),
    ),
    paymentRules: new Map(
      (ref.paymentRules ?? []).map((r) => [ruleKeyOf(r.scheme_code, r.name), r.id]),
    ),
    discounts: new Map((ref.discounts ?? []).map((d) => [nameKey(d.name), d.id])),
  };
}

const sheetCounts = (preview) =>
  Object.fromEntries(
    preview.sheets
      .filter((s) => !s.later)
      .map((s) => [
        s.name,
        { new: s.counts.new, update: s.counts.update, unchanged: s.counts.unchanged },
      ]),
  );

const CHANGED_MEANWHILE = new Set(["23505", "23503", "23514", "P0001"]);

function explain(error) {
  if (CHANGED_MEANWHILE.has(error?.code)) {
    return httpError(
      409,
      "Scribe's billing data changed while the file was being saved, so nothing was saved; check the file again and upload it once more",
    );
  }
  return error;
}

async function recordFailure(db, fileName, actorId) {
  await db
    .query(
      `INSERT INTO billing_imports (file_name, imported_by, status) VALUES ($1, $2, 'failed')`,
      [fileName, actorId],
    )
    .catch(() => {});
}

export async function commitUpload(buffer, { fileName, ctx, options = {} }, db = pool) {
  const name = String(fileName ?? "").trim();
  if (!name) throw httpError(400, "The file needs a name");
  if (!ctx?.actorId) throw httpError(400, "An import must name who imported it");

  const client = await db.connect();
  let started = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [IMPORT_LOCK]);

    const parsed = await parseUpload(buffer);
    if (parsed.problems.length) {
      await client.query("ROLLBACK");
      return { saved: false, preview: summarize(parsed) };
    }
    const ref = await loadReference(client);
    checkMasterRows(parsed.sheets, ref, options);
    markStatus(parsed.sheets, ref);
    const preview = summarize(parsed);
    if (!preview.canImport) {
      await client.query("ROLLBACK");
      return { saved: false, preview };
    }

    started = true;
    const counts = sheetCounts(preview);
    const { rows } = await client.query(
      `INSERT INTO billing_imports (file_name, imported_by, counts, status)
       VALUES ($1, $2, $3, 'saved') RETURNING id, imported_at`,
      [name, ctx.actorId, counts],
    );
    const importId = rows[0].id;
    const importCtx = { actorId: ctx.actorId, ip: ctx.ip ?? null, importId };
    await writeAudit(client, {
      entity: "billing_imports",
      entityId: importId,
      action: "import",
      after: { file_name: name, counts },
      ...auditFields(importCtx),
    });

    const { audit, conflicts } = await writeSheets(
      client,
      parsed.sheets,
      ref,
      importCtx,
      `Bulk import: ${name}`,
    );
    throwPriceConflicts(conflicts);
    await writeAuditMany(client, audit, auditFields(importCtx));

    await client.query("COMMIT");
    return { saved: true, importId, importedAt: rows[0].imported_at, preview };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (started) await recordFailure(db, name, ctx.actorId);
    throw explain(error);
  } finally {
    client.release();
  }
}
