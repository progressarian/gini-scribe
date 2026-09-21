import pool from "../../config/db.js";
import { parseUpload } from "./importParse.js";
import { markStatus, summarize } from "./importPreview.js";
import { checkMasterRows, key, loadReference, nameKey } from "./importValidate.js";
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
};
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

async function saveRates(client, sheets, ids, ctx, audit) {
  const rows = rowsOf(sheets, "Category rates").map((r) => ({
    scheme_code: r.values.category_code,
    service_item_id: ids.items.get(key(r.values.item_code)),
    valid_from: r.values.valid_from,
    valid_to: r.values.valid_to,
    rate: r.values.rate,
    bill_name: r.values.bill_name,
    bill_code: r.values.bill_code,
  }));
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

    const ids = idMaps(ref);
    const audit = [];
    await saveGroups(client, parsed.sheets, ids, importCtx, audit);
    await saveSubgroups(client, parsed.sheets, ids, importCtx, audit);
    await saveItems(client, parsed.sheets, ids, importCtx, audit, `Bulk import: ${name}`);
    await saveCategories(client, parsed.sheets, importCtx, audit);
    await saveRules(client, parsed.sheets, ids, importCtx, audit);
    await saveRates(client, parsed.sheets, ids, importCtx, audit);
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
