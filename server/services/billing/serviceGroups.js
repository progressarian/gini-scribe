import pool from "../../config/db.js";
import { checkItemPrices } from "./paymentRules.js";
import { writeAudit } from "./audit.js";
import { httpError, inTransaction } from "./transaction.js";
import {
  assertCodeFree as codeFree,
  auditFields,
  cleanActive,
  cleanCode,
  cleanName,
  cleanOrder,
  deleteUnused,
  duplicateCodeError,
  hasField,
  lockRow as lockById,
  wholeNumber,
} from "./common.js";

const LEVELS = {
  group: {
    table: "service_groups",
    noun: "group",
    usage: "group",
    columns: ["code", "name", "sort_order"],
    children: { table: "service_subgroups", column: "group_id", noun: "subgroup" },
  },
  subgroup: {
    table: "service_subgroups",
    noun: "subgroup",
    usage: "subgroup",
    columns: ["group_id", "code", "name", "sort_order"],
    children: { table: "service_items", column: "subgroup_id", noun: "item" },
  },
};

const ROW = "id, code, name, sort_order, is_active, created_at, updated_at";

function cleanInput(level, input, { partial }) {
  const out = {};
  const has = (key) => hasField(input, key);
  if (!partial || has("code")) out.code = cleanCode(input?.code);
  if (!partial || has("name")) out.name = cleanName(input?.name);
  if (!partial || has("sort_order")) out.sort_order = cleanOrder(input?.sort_order);
  if (level === "subgroup" && (!partial || has("group_id"))) {
    const groupId = wholeNumber(input?.group_id, "Group", { min: 1 });
    if (groupId === undefined) throw httpError(400, "Choose a group");
    out.group_id = groupId;
  }
  return out;
}

const assertCodeFree = (client, level, code, exceptId = null) =>
  codeFree(client, LEVELS[level], code, exceptId);

const lockRow = (client, level, id) =>
  lockById(
    client,
    { ...LEVELS[level], columns: `${ROW}${level === "subgroup" ? ", group_id" : ""}` },
    id,
  );

async function assertNameFree(client, level, name, groupId, exceptId = null) {
  const spec = LEVELS[level];
  const sameParent = level === "subgroup" ? "AND group_id = $3" : "";
  const params = level === "subgroup" ? [name, exceptId, groupId] : [name, exceptId];
  const { rows } = await client.query(
    `SELECT name FROM ${spec.table}
      WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2 ${sameParent}`,
    params,
  );
  if (!rows.length) return;
  if (level === "subgroup") {
    const parent = await client.query(`SELECT name FROM service_groups WHERE id = $1`, [groupId]);
    throw httpError(
      409,
      `A subgroup called "${rows[0].name}" already exists in ${parent.rows[0]?.name ?? "that group"}`,
    );
  }
  throw httpError(409, `A group called "${rows[0].name}" already exists`);
}

async function activeGroup(client, groupId) {
  const { rows } = await client.query(
    `SELECT id, name, is_active FROM service_groups WHERE id = $1 FOR SHARE`,
    [groupId],
  );
  if (!rows.length) throw httpError(404, "That group no longer exists");
  if (!rows[0].is_active) {
    throw httpError(409, `${rows[0].name} is deactivated; reactivate it first`);
  }
  return rows[0];
}

const duplicateCode = (level, error) => duplicateCodeError(LEVELS[level].noun, error);

export async function listGroups({ activeOnly = false } = {}, db = pool) {
  const { rows: groups } = await db.query(
    `SELECT ${ROW} FROM service_groups
      ${activeOnly ? "WHERE is_active" : ""}
      ORDER BY sort_order, name`,
  );
  const { rows: subgroups } = await db.query(
    `SELECT s.id, s.group_id, s.code, s.name, s.sort_order, s.is_active, s.created_at, s.updated_at,
            (SELECT count(*)::int FROM service_items i WHERE i.subgroup_id = s.id) AS item_count
       FROM service_subgroups s
      ${activeOnly ? "WHERE s.is_active" : ""}
      ORDER BY s.sort_order, s.name`,
  );
  return groups.map((group) => {
    const own = subgroups.filter((s) => s.group_id === group.id);
    return {
      ...group,
      item_count: own.reduce((sum, s) => sum + s.item_count, 0),
      subgroups: own,
    };
  });
}

async function create(level, input, ctx, db) {
  const spec = LEVELS[level];
  const values = cleanInput(level, input, { partial: false });
  return inTransaction(async (client) => {
    if (level === "subgroup") await activeGroup(client, values.group_id);
    await assertCodeFree(client, level, values.code);
    await assertNameFree(client, level, values.name, values.group_id);
    const columns = spec.columns;
    const { rows } = await client
      .query(
        `INSERT INTO ${spec.table} (${columns.join(", ")}, created_by, updated_by)
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}, $${columns.length + 1}, $${columns.length + 1})
         RETURNING ${ROW}${level === "subgroup" ? ", group_id" : ""}`,
        [...columns.map((c) => values[c]), ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw duplicateCode(level, error);
      });
    await writeAudit(client, {
      entity: spec.table,
      entityId: rows[0].id,
      action: "create",
      after: rows[0],
      ...auditFields(ctx),
    });
    return rows[0];
  }, db);
}

async function update(level, id, input, ctx, db) {
  const spec = LEVELS[level];
  const values = cleanInput(level, input, { partial: true });
  const keys = Object.keys(values);
  if (!keys.length) throw httpError(400, "Nothing to change");
  return inTransaction(async (client) => {
    const before = await lockRow(client, level, id);
    if (values.group_id !== undefined && values.group_id !== before.group_id) {
      await activeGroup(client, values.group_id);
    }
    if (values.code !== undefined) await assertCodeFree(client, level, values.code, id);
    if (values.name !== undefined || values.group_id !== undefined) {
      await assertNameFree(
        client,
        level,
        values.name ?? before.name,
        values.group_id ?? before.group_id,
        id,
      );
    }
    const { rows } = await client
      .query(
        `UPDATE ${spec.table}
            SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")},
                updated_at = NOW(), updated_by = $${keys.length + 2}
          WHERE id = $1
          RETURNING ${ROW}${level === "subgroup" ? ", group_id" : ""}`,
        [id, ...keys.map((k) => values[k]), ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw duplicateCode(level, error);
      });
    if (level === "subgroup" && rows[0].group_id !== before.group_id) {
      const { rows: moved } = await client.query(
        `SELECT id FROM service_items WHERE subgroup_id = $1 AND is_active`,
        [id],
      );
      await checkItemPrices(
        client,
        moved.map((item) => item.id),
      );
    }
    await writeAudit(client, {
      entity: spec.table,
      entityId: id,
      action: "update",
      before,
      after: rows[0],
      ...auditFields(ctx),
    });
    return rows[0];
  }, db);
}

async function setActive(level, id, value, ctx, db) {
  const spec = LEVELS[level];
  const active = cleanActive(value);
  return inTransaction(async (client) => {
    const before = await lockRow(client, level, id);
    if (before.is_active === active) return before;
    if (active && level === "subgroup") await activeGroup(client, before.group_id);
    if (!active) {
      const { rows } = await client.query(
        `SELECT name FROM ${spec.children.table}
          WHERE ${spec.children.column} = $1 AND is_active ORDER BY name`,
        [id],
      );
      if (rows.length) {
        const names = rows.map((r) => r.name);
        throw httpError(
          409,
          `${before.name} still has ${rows.length} active ${spec.children.noun}${rows.length === 1 ? "" : "s"}: ${names.join(", ")}. Deactivate ${rows.length === 1 ? "it" : "them"} first.`,
          { active: names },
        );
      }
    }
    const { rows } = await client.query(
      `UPDATE ${spec.table} SET is_active = $2, updated_at = NOW(), updated_by = $3
        WHERE id = $1 RETURNING ${ROW}${level === "subgroup" ? ", group_id" : ""}`,
      [id, active, ctx?.actorId ?? null],
    );
    await writeAudit(client, {
      entity: spec.table,
      entityId: id,
      action: active ? "activate" : "deactivate",
      before,
      after: rows[0],
      ...auditFields(ctx),
    });
    return rows[0];
  }, db);
}

async function remove(level, id, ctx, db) {
  const spec = LEVELS[level];
  return inTransaction(async (client) => {
    const before = await lockRow(client, level, id);
    return deleteUnused(client, {
      table: spec.table,
      kind: spec.usage,
      id,
      label: before.name,
      before,
      ctx,
    });
  }, db);
}

export const createGroup = (input, ctx, db = pool) => create("group", input, ctx, db);
export const updateGroup = (id, input, ctx, db = pool) => update("group", id, input, ctx, db);
export const setGroupActive = (id, active, ctx, db = pool) =>
  setActive("group", id, active, ctx, db);
export const deleteGroup = (id, ctx, db = pool) => remove("group", id, ctx, db);

export const createSubgroup = (input, ctx, db = pool) => create("subgroup", input, ctx, db);
export const updateSubgroup = (id, input, ctx, db = pool) => update("subgroup", id, input, ctx, db);
export const setSubgroupActive = (id, active, ctx, db = pool) =>
  setActive("subgroup", id, active, ctx, db);
export const deleteSubgroup = (id, ctx, db = pool) => remove("subgroup", id, ctx, db);
