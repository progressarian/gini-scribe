import pool from "../../config/db.js";
import { isLabOnlyDoctor } from "../../../shared/labOnly.js";
import { CONSULTATION_VISIT_TYPES, ITEM_KINDS } from "./importColumns.js";
import { looksLikeSameTest, normalizeTestName } from "./testNames.js";
import { writeAudit } from "./audit.js";
import { httpError, inTransaction } from "./transaction.js";
import {
  assertCodeFree,
  auditFields,
  cleanActive,
  cleanCode,
  cleanFlag,
  cleanMoney,
  cleanName,
  deleteUnused,
  duplicateCodeError,
  hasField,
  INT_MAX,
  lockRow,
  readNumber,
} from "./common.js";

const COLUMNS = [
  "id",
  "code",
  "name",
  "subgroup_id",
  "base_price",
  "unit",
  "allow_quantity",
  "max_quantity",
  "tax_code_id",
  "price_includes_tax",
  "kind",
  "doctor_id",
  "visit_type",
  "test_catalog_id",
  "is_active",
  "created_at",
  "updated_at",
];

const SPEC = { table: "service_items", noun: "item", columns: COLUMNS.join(", ") };
const EDITABLE = COLUMNS.filter(
  (c) => !["id", "is_active", "created_at", "updated_at"].includes(c),
);

const shape = (row) => (row ? { ...row, base_price: Number(row.base_price) } : row);

function cleanId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const id = readNumber(value, `Choose a valid ${label}`);
  if (!Number.isInteger(id) || id <= 0 || id > INT_MAX) {
    throw httpError(400, `Choose a valid ${label}`);
  }
  return id;
}

function cleanUuid(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    throw httpError(400, "Choose a valid test from the test catalogue");
  }
  return text.toLowerCase();
}

function cleanUnit(value) {
  if (value === undefined || value === null) return "each";
  const unit = typeof value === "string" ? value.trim() : "";
  if (!unit) throw httpError(400, "Unit can't be blank");
  return unit;
}

function cleanMaxQuantity(value) {
  const max = readNumber(value, "Maximum quantity must be a whole number");
  if (max === undefined) return null;
  if (!Number.isInteger(max) || max < 1 || max > INT_MAX) {
    throw httpError(400, "Maximum quantity must be a whole number, 1 or more");
  }
  return max;
}

function cleanVisitType(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!CONSULTATION_VISIT_TYPES.includes(value)) {
    throw httpError(400, `Visit type must be one of: ${CONSULTATION_VISIT_TYPES.join(", ")}`);
  }
  return value;
}

function cleanKind(value) {
  if (!ITEM_KINDS.includes(value)) {
    throw httpError(400, `Kind must be one of: ${ITEM_KINDS.join(", ")}`);
  }
  return value;
}

const CLEANERS = {
  code: cleanCode,
  name: cleanName,
  subgroup_id: (v) => cleanId(v, "subgroup"),
  base_price: (v) => cleanMoney(v, "Base price"),
  unit: cleanUnit,
  allow_quantity: (v) => cleanFlag(v, "Allow quantity"),
  max_quantity: cleanMaxQuantity,
  tax_code_id: (v) => cleanId(v, "tax code"),
  price_includes_tax: (v) => cleanFlag(v, "Price includes tax"),
  kind: cleanKind,
  doctor_id: (v) => cleanId(v, "doctor"),
  visit_type: cleanVisitType,
  test_catalog_id: cleanUuid,
};

const CREATE_DEFAULTS = {
  unit: "each",
  allow_quantity: false,
  max_quantity: null,
  tax_code_id: null,
  price_includes_tax: false,
  doctor_id: null,
  visit_type: null,
  test_catalog_id: null,
};

function cleanInput(input, { partial }) {
  const out = {};
  for (const key of EDITABLE) {
    if (hasField(input, key)) out[key] = CLEANERS[key](input[key]);
    else if (!partial && key in CREATE_DEFAULTS) out[key] = CREATE_DEFAULTS[key];
    else if (!partial) out[key] = CLEANERS[key](undefined);
  }
  return out;
}

function checkShape(item) {
  if (!item.subgroup_id) throw httpError(400, "Choose a subgroup");
  if (item.price_includes_tax && !item.tax_code_id) {
    throw httpError(400, "Price includes tax only applies when the item has a tax code");
  }
  if (!item.allow_quantity && item.max_quantity !== null) {
    throw httpError(400, "A maximum quantity only applies when quantity is allowed");
  }
  if (item.kind === "consultation") {
    if (!item.visit_type) {
      throw httpError(
        400,
        `A consultation item needs a visit type (${CONSULTATION_VISIT_TYPES.join(" or ")})`,
      );
    }
  } else if (item.doctor_id !== null || item.visit_type !== null) {
    throw httpError(400, "Only consultation items have a doctor and a visit type");
  }
  if (item.kind === "test" && !item.test_catalog_id) {
    throw httpError(400, "A test item must be linked to a test in the test catalogue");
  }
  if (item.kind !== "test" && item.test_catalog_id) {
    throw httpError(400, "Only test items are linked to the test catalogue");
  }
}

async function checkSubgroup(client, subgroupId) {
  const { rows } = await client.query(
    `SELECT id, name, is_active FROM service_subgroups WHERE id = $1 FOR SHARE`,
    [subgroupId],
  );
  if (!rows.length) throw httpError(404, "That subgroup no longer exists");
  if (!rows[0].is_active)
    throw httpError(409, `${rows[0].name} is deactivated; reactivate it first`);
  return rows[0];
}

async function checkTaxCode(client, taxCodeId) {
  if (!taxCodeId) return;
  const { rows } = await client.query(
    `SELECT code, is_active FROM tax_codes WHERE id = $1 FOR SHARE`,
    [taxCodeId],
  );
  if (!rows.length) throw httpError(404, "That tax code no longer exists");
  if (!rows[0].is_active) throw httpError(409, `Tax code ${rows[0].code} is deactivated`);
}

async function checkDoctor(client, doctorId) {
  if (!doctorId) return;
  const { rows } = await client.query(`SELECT name, is_active FROM doctors WHERE id = $1`, [
    doctorId,
  ]);
  if (!rows.length) throw httpError(404, "That doctor no longer exists");
  if (rows[0].is_active === false) throw httpError(409, `${rows[0].name} is not an active doctor`);
  if (isLabOnlyDoctor(rows[0].name)) {
    throw httpError(
      409,
      `${rows[0].name} is the lab-only provider; samples-only visits have no consultation fee`,
    );
  }
}

async function checkTest(client, testCatalogId, exceptId) {
  if (!testCatalogId) return;
  const test = await client.query(
    `SELECT test_name, is_active FROM giniflow_test_catalog WHERE id = $1`,
    [testCatalogId],
  );
  if (!test.rows.length) throw httpError(404, "That test is not in the test catalogue");
  if (!test.rows[0].is_active) {
    throw httpError(409, `${test.rows[0].test_name} is retired in the test catalogue`);
  }
  const taken = await client.query(
    `SELECT code, name FROM service_items WHERE test_catalog_id = $1 AND id IS DISTINCT FROM $2`,
    [testCatalogId, exceptId],
  );
  if (taken.rows.length) {
    throw httpError(
      409,
      `${test.rows[0].test_name} already has an item: ${taken.rows[0].name} (${taken.rows[0].code})`,
    );
  }
}

async function checkConsultationFree(client, item, exceptId) {
  if (item.kind !== "consultation" || !item.is_active) return;
  const { rows } = await client.query(
    `SELECT i.code, i.name FROM service_items i
      WHERE i.kind = 'consultation' AND i.is_active
        AND i.doctor_id IS NOT DISTINCT FROM $1 AND i.visit_type = $2
        AND i.id IS DISTINCT FROM $3`,
    [item.doctor_id, item.visit_type, exceptId],
  );
  if (!rows.length) return;
  const whose = item.doctor_id ? "this doctor" : "the hospital default";
  throw httpError(
    409,
    `There is already an active ${item.visit_type} consultation item for ${whose}: ${rows[0].name} (${rows[0].code})`,
  );
}

async function checkNameFree(client, name, subgroupId, exceptId) {
  const { rows } = await client.query(
    `SELECT i.name, s.name AS subgroup FROM service_items i
       JOIN service_subgroups s ON s.id = i.subgroup_id
      WHERE lower(i.name) = lower($1) AND i.subgroup_id = $2 AND i.id IS DISTINCT FROM $3`,
    [name, subgroupId, exceptId],
  );
  if (rows.length) {
    throw httpError(409, `An item called "${rows[0].name}" already exists in ${rows[0].subgroup}`);
  }
}

function uniqueViolation(error) {
  if (error?.code !== "23505") return error;
  if (error.constraint === "service_items_consultation_key") {
    return httpError(
      409,
      "There is already an active consultation item for that doctor and visit type",
    );
  }
  if (error.constraint === "service_items_test_catalog_key") {
    return httpError(409, "That test already has an item");
  }
  return duplicateCodeError(SPEC.noun, error);
}

async function validate(client, item, { id = null, before = null } = {}) {
  checkShape(item);
  const changed = (key) => !before || before[key] !== item[key];
  if (changed("subgroup_id")) await checkSubgroup(client, item.subgroup_id);
  if (changed("tax_code_id")) await checkTaxCode(client, item.tax_code_id);
  if (changed("doctor_id")) await checkDoctor(client, item.doctor_id);
  if (changed("test_catalog_id")) await checkTest(client, item.test_catalog_id, id);
  if (changed("code")) await assertCodeFree(client, SPEC, item.code, id);
  if (changed("name") || changed("subgroup_id")) {
    await checkNameFree(client, item.name, item.subgroup_id, id);
  }
  if (["kind", "doctor_id", "visit_type", "is_active"].some(changed)) {
    await checkConsultationFree(client, item, id);
  }
}

async function recordPrice(client, itemId, oldPrice, newPrice, reason, ctx) {
  await client.query(
    `INSERT INTO service_item_price_history (service_item_id, old_price, new_price, reason, changed_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [itemId, oldPrice, newPrice, reason, ctx?.actorId ?? null],
  );
}

function cleanReason(value) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason) throw httpError(400, "Give a reason for the price change");
  return reason;
}

export async function listItems(filters = {}, db = pool) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  const q = typeof filters.q === "string" ? filters.q.trim() : "";
  if (q) add("(i.name ILIKE ? OR i.code ILIKE ?)", `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (filters.groupId) add("s.group_id = ?", cleanId(filters.groupId, "group"));
  if (filters.subgroupId) add("i.subgroup_id = ?", cleanId(filters.subgroupId, "subgroup"));
  if (filters.kind) add("i.kind = ?", cleanKind(filters.kind));
  if (filters.doctorId) add("i.doctor_id = ?", cleanId(filters.doctorId, "doctor"));
  if (filters.active !== undefined) add("i.is_active = ?", cleanActive(filters.active));
  const limit = Math.min(cleanId(filters.limit, "limit") ?? 200, 1000);
  const offset = readNumber(filters.offset, "Offset must be a whole number") ?? 0;
  if (!Number.isInteger(offset) || offset < 0)
    throw httpError(400, "Offset must be a whole number");
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT ${COLUMNS.map((c) => `i.${c}`).join(", ")},
            s.name AS subgroup_name, s.group_id, g.name AS group_name,
            t.code AS tax_code, d.name AS doctor_name, c.test_name,
            count(*) OVER ()::int AS total
       FROM service_items i
       JOIN service_subgroups s ON s.id = i.subgroup_id
       JOIN service_groups g ON g.id = s.group_id
       LEFT JOIN tax_codes t ON t.id = i.tax_code_id
       LEFT JOIN doctors d ON d.id = i.doctor_id
       LEFT JOIN giniflow_test_catalog c ON c.id = i.test_catalog_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY g.sort_order, g.name, s.sort_order, s.name, i.name
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { total: rows[0]?.total ?? 0, items: rows.map(({ total, ...row }) => shape(row)) };
}

export async function createItem(input, ctx, db = pool) {
  const values = cleanInput(input, { partial: false });
  return inTransaction(async (client) => {
    await validate(client, { ...values, is_active: true });
    const keys = Object.keys(values);
    const { rows } = await client
      .query(
        `INSERT INTO service_items (${keys.join(", ")}, created_by, updated_by)
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, $${keys.length + 1}, $${keys.length + 1})
         RETURNING ${SPEC.columns}`,
        [...keys.map((k) => values[k]), ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw uniqueViolation(error);
      });
    await recordPrice(client, rows[0].id, null, values.base_price, "Created", ctx);
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: rows[0].id,
      action: "create",
      after: rows[0],
      ...auditFields(ctx),
    });
    return shape(rows[0]);
  }, db);
}

export async function updateItem(id, input, ctx, db = pool) {
  const values = cleanInput(input, { partial: true });
  const keys = Object.keys(values);
  if (!keys.length) throw httpError(400, "Nothing to change");
  return inTransaction(async (client) => {
    const before = await lockRow(client, SPEC, id);
    const merged = {
      ...before,
      ...values,
      base_price: values.base_price ?? Number(before.base_price),
    };
    const priceChanged =
      values.base_price !== undefined && values.base_price !== Number(before.base_price);
    const reason = priceChanged ? cleanReason(input?.reason) : null;
    await validate(client, merged, {
      id,
      before: { ...before, base_price: Number(before.base_price) },
    });
    const { rows } = await client
      .query(
        `UPDATE service_items
            SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")},
                updated_at = NOW(), updated_by = $${keys.length + 2}
          WHERE id = $1
          RETURNING ${SPEC.columns}`,
        [id, ...keys.map((k) => values[k]), ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw uniqueViolation(error);
      });
    if (priceChanged) {
      await recordPrice(client, id, Number(before.base_price), values.base_price, reason, ctx);
    }
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: id,
      action: "update",
      before,
      after: rows[0],
      ...auditFields(ctx),
    });
    return shape(rows[0]);
  }, db);
}

export async function setItemActive(id, value, ctx, db = pool) {
  const active = cleanActive(value);
  return inTransaction(async (client) => {
    const before = await lockRow(client, SPEC, id);
    if (before.is_active === active) return shape(before);
    if (active) await validate(client, { ...before, is_active: true }, { id });
    const { rows } = await client
      .query(
        `UPDATE service_items SET is_active = $2, updated_at = NOW(), updated_by = $3
          WHERE id = $1 RETURNING ${SPEC.columns}`,
        [id, active, ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw uniqueViolation(error);
      });
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: id,
      action: active ? "activate" : "deactivate",
      before,
      after: rows[0],
      ...auditFields(ctx),
    });
    return shape(rows[0]);
  }, db);
}

export async function priceHistory(id, db = pool) {
  const { rows } = await db.query(
    `SELECT h.old_price, h.new_price, h.reason, h.changed_at, h.changed_by, d.name AS changed_by_name
       FROM service_item_price_history h
       LEFT JOIN doctors d ON d.id = h.changed_by
      WHERE h.service_item_id = $1
      ORDER BY h.changed_at DESC, h.id DESC`,
    [id],
  );
  return rows.map((r) => ({
    ...r,
    old_price: r.old_price === null ? null : Number(r.old_price),
    new_price: Number(r.new_price),
  }));
}

export async function deleteItem(id, ctx, db = pool) {
  return inTransaction(async (client) => {
    const before = await lockRow(client, SPEC, id);
    return deleteUnused(client, {
      table: SPEC.table,
      kind: "item",
      id,
      label: before.name,
      before,
      ctx,
    });
  }, db);
}

export async function notPricedList(db = pool) {
  const { rows: tests } = await db.query(
    `SELECT c.id AS test_catalog_id, c.test_name, c.category, c.price AS catalogue_price,
            i.id AS item_id, i.code AS item_code, i.is_active AS item_active
       FROM giniflow_test_catalog c
       LEFT JOIN service_items i ON i.test_catalog_id = c.id
      WHERE c.is_active AND (i.id IS NULL OR NOT i.is_active)
      ORDER BY c.category, c.test_name`,
  );

  const { rows: catalogue } = await db.query(
    `SELECT test_name, is_active FROM giniflow_test_catalog`,
  );
  const inCatalogue = new Map(catalogue.map((c) => [normalizeTestName(c.test_name), c]));
  const { rows: reports } = await db.query(
    `SELECT name, COALESCE(aliases, '{}') AS aliases FROM lab_report_catalog
      WHERE is_active ORDER BY name`,
  );
  const reportsNotInCatalogue = reports
    .map((report) => {
      const matches = [report.name, ...report.aliases]
        .map((name) => inCatalogue.get(normalizeTestName(name)))
        .filter(Boolean);
      if (matches.some((m) => m.is_active)) return null;
      const names = [report.name, ...report.aliases];
      return {
        name: report.name,
        status: matches.length ? "retired_in_catalogue" : "not_in_catalogue",
        possibly_same_as: catalogue
          .filter((c) => c.is_active && names.some((n) => looksLikeSameTest(n, c.test_name)))
          .map((c) => c.test_name)
          .sort(),
      };
    })
    .filter(Boolean);

  const { rows: consultants } = await db.query(
    `SELECT d.id AS doctor_id, d.name, d.short_name, v.visit_type,
            own.id AS item_id, own.code AS item_code, own.is_active AS item_active,
            EXISTS (SELECT 1 FROM service_items f
                     WHERE f.kind = 'consultation' AND f.is_active
                       AND f.doctor_id IS NULL AND f.visit_type = v.visit_type) AS default_covers
       FROM doctors d
      CROSS JOIN unnest($1::text[]) AS v(visit_type)
       LEFT JOIN LATERAL (
         SELECT i.id, i.code, i.is_active FROM service_items i
          WHERE i.kind = 'consultation' AND i.doctor_id = d.id AND i.visit_type = v.visit_type
          ORDER BY i.is_active DESC, i.id DESC LIMIT 1
       ) own ON TRUE
      WHERE d.role = 'consultant' AND COALESCE(d.is_active, TRUE)
        AND (own.id IS NULL OR NOT own.is_active)
      ORDER BY d.name, d.id, array_position($1::text[], v.visit_type)`,
    [CONSULTATION_VISIT_TYPES],
  );

  const status = (row) => (row.item_id ? "item_deactivated" : "no_item");
  return {
    tests: tests.map(({ item_active, ...row }) => ({
      ...row,
      catalogue_price: row.catalogue_price === null ? null : Number(row.catalogue_price),
      status: status(row),
    })),
    reportsNotInCatalogue,
    consultants: consultants
      .filter((row) => !isLabOnlyDoctor(row.name))
      .map(({ item_active, ...row }) => ({ ...row, status: status(row) })),
  };
}
