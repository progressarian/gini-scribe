import pool from "../../config/db.js";
import { ITEM_KINDS } from "../../../shared/billingVocab.js";
import { writeAudit } from "./audit.js";
import { auditFields, INT_MAX } from "./common.js";
import { CODE_MAX } from "./reportsFilters.js";
import { httpError, inTransaction } from "./transaction.js";

export const MISC_COLUMN = { key: "misc", label: "Miscellaneous Charges", kind: "other" };
export const PHARMACY_COLUMN = {
  key: "pharmacy",
  label: "Pharmacy Charges",
  note: "Not in Scribe — pharmacy is billed in its own system",
};
export const LABEL_MAX = 60;
export const TARGETS_MAX = 300;

const TARGETS = ["item_kinds", "group_codes", "subgroup_codes", "item_ids"];

const TARGET_WORDS = {
  item_kinds: "item kind",
  group_codes: "group",
  subgroup_codes: "subgroup",
  item_ids: "item",
};

export const misColumnJoin = (line = "l", item = "si") => `
  LEFT JOIN LATERAL (
    SELECT mc.key, mc.kind FROM billing_mis_columns mc
     WHERE ${line}.service_item_id = ANY(mc.item_ids)
        OR lower(${line}.subgroup_code) = ANY(mc.subgroup_codes)
        OR lower(${line}.group_code) = ANY(mc.group_codes)
        OR ${item}.kind = ANY(mc.item_kinds)
     ORDER BY CASE WHEN ${line}.service_item_id = ANY(mc.item_ids) THEN 0
                   WHEN lower(${line}.subgroup_code) = ANY(mc.subgroup_codes) THEN 1
                   WHEN lower(${line}.group_code) = ANY(mc.group_codes) THEN 2
                   ELSE 3 END,
              mc.sort_order, mc.key
     LIMIT 1
  ) mc ON TRUE`;

export const lineKind = (line = "l", item = "si") => `COALESCE(mc.kind,
  CASE WHEN ${item}.kind = 'consultation' THEN 'consultation'
       WHEN ${line}.lab_order_id IS NOT NULL OR ${item}.kind = 'test' THEN 'test'
       ELSE 'other' END)`;

const COLUMN_SQL = `SELECT key, label, kind, sort_order, item_kinds, group_codes, subgroup_codes,
                           item_ids, updated_at, updated_by
                      FROM billing_mis_columns`;

export async function chargeColumns(db = pool) {
  const { rows } = await db.query(
    `SELECT key, label, kind FROM billing_mis_columns ORDER BY sort_order, key`,
  );
  return [...rows, MISC_COLUMN];
}

export async function listMisColumns(db = pool) {
  const [{ rows }, groups, subgroups, items] = await Promise.all([
    db.query(`${COLUMN_SQL} ORDER BY sort_order, key`),
    db.query(`SELECT lower(code) AS code, name FROM service_groups`),
    db.query(`SELECT lower(code) AS code, name FROM service_subgroups`),
    db.query(
      `SELECT id, code, name FROM service_items
        WHERE id = ANY(SELECT unnest(item_ids) FROM billing_mis_columns)`,
    ),
  ]);
  const named = (list, key) => new Map(list.rows.map((row) => [row[key], row]));
  const groupNames = named(groups, "code");
  const subgroupNames = named(subgroups, "code");
  const itemNames = named(items, "id");
  return {
    columns: rows.map((row) => ({
      key: row.key,
      label: row.label,
      kind: row.kind,
      sort_order: row.sort_order,
      item_kinds: row.item_kinds,
      groups: row.group_codes.map((code) => ({ code, name: groupNames.get(code)?.name ?? null })),
      subgroups: row.subgroup_codes.map((code) => ({
        code,
        name: subgroupNames.get(code)?.name ?? null,
      })),
      items: row.item_ids.map((id) => ({
        id,
        code: itemNames.get(id)?.code ?? null,
        name: itemNames.get(id)?.name ?? null,
      })),
      updated_at: row.updated_at,
    })),
    misc: MISC_COLUMN,
    pharmacy: PHARMACY_COLUMN,
  };
}

function cleanList(value, label, clean) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw httpError(400, `${label} must be a list`);
  if (value.length > TARGETS_MAX) {
    throw httpError(400, `${label} can hold at most ${TARGETS_MAX} entries`);
  }
  return [...new Set(value.map(clean))];
}

const cleanCode = (label) => (value) => {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!code || /\s/.test(code) || code.length > CODE_MAX) {
    throw httpError(400, `Each ${label} must be a code without spaces`);
  }
  return code;
};

function cleanItemId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > INT_MAX) {
    throw httpError(400, "Each item must be an id");
  }
  return id;
}

function cleanItemKind(value) {
  const kind = typeof value === "string" ? value.trim() : "";
  if (!ITEM_KINDS.includes(kind)) {
    throw httpError(400, `Each item kind must be one of: ${ITEM_KINDS.join(", ")}`);
  }
  return kind;
}

export function cleanMisColumn(input) {
  const raw = input && typeof input === "object" ? input : {};
  const wanted = {
    item_kinds: cleanList(raw.item_kinds, "Item kinds", cleanItemKind),
    group_codes: cleanList(raw.group_codes, "Groups", cleanCode("group")),
    subgroup_codes: cleanList(raw.subgroup_codes, "Subgroups", cleanCode("subgroup")),
    item_ids: cleanList(raw.item_ids, "Items", cleanItemId),
  };
  if (raw.label !== undefined) {
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (!label || label.length > LABEL_MAX) {
      throw httpError(400, `The column name must be 1 to ${LABEL_MAX} letters`);
    }
    wanted.label = label;
  }
  return Object.fromEntries(Object.entries(wanted).filter(([, value]) => value !== undefined));
}

async function refuseUnknown(client, wanted) {
  const checks = [
    ["group_codes", `SELECT lower(code) AS v FROM service_groups WHERE lower(code) = ANY($1)`],
    [
      "subgroup_codes",
      `SELECT lower(code) AS v FROM service_subgroups WHERE lower(code) = ANY($1)`,
    ],
    ["item_ids", `SELECT id AS v FROM service_items WHERE id = ANY($1::int[])`],
  ];
  for (const [field, sql] of checks) {
    const asked = wanted[field];
    if (!asked?.length) continue;
    const { rows } = await client.query(sql, [asked]);
    const found = new Set(rows.map((row) => row.v));
    const missing = asked.filter((value) => !found.has(value));
    if (missing.length) {
      throw httpError(
        400,
        `There is no such ${TARGET_WORDS[field]}: ${missing.slice(0, 5).join(", ")}`,
      );
    }
  }
}

async function refuseTaken(client, key, wanted) {
  const { rows } = await client.query(`${COLUMN_SQL} WHERE key <> $1`, [key]);
  for (const field of TARGETS) {
    for (const value of wanted[field] ?? []) {
      const other = rows.find((row) => row[field].includes(value));
      if (other) {
        throw httpError(
          409,
          `That ${TARGET_WORDS[field]} (${value}) is already counted under ${other.label} — take it off there first`,
        );
      }
    }
  }
}

export async function updateMisColumn(key, input, ctx, db = pool) {
  const columnKey = typeof key === "string" ? key.trim() : "";
  const wanted = cleanMisColumn(input);
  if (!Object.keys(wanted).length) throw httpError(400, "Send what to change on the column");
  return inTransaction(async (client) => {
    const { rows } = await client.query(`${COLUMN_SQL} WHERE key = $1 FOR UPDATE`, [columnKey]);
    if (!rows.length) throw httpError(404, "There is no such MIS column");
    await refuseUnknown(client, wanted);
    await refuseTaken(client, columnKey, wanted);
    const before = rows[0];
    const next = { ...before, ...wanted };
    await client.query(
      `UPDATE billing_mis_columns
          SET label = $2, item_kinds = $3, group_codes = $4, subgroup_codes = $5,
              item_ids = $6::int[], updated_at = NOW(), updated_by = $7
        WHERE key = $1`,
      [
        columnKey,
        next.label,
        next.item_kinds,
        next.group_codes,
        next.subgroup_codes,
        next.item_ids,
        ctx?.actorId ?? null,
      ],
    );
    const pick = (row) =>
      Object.fromEntries(["label", ...TARGETS].map((field) => [field, row[field]]));
    await writeAudit(client, {
      entity: "billing_mis_columns",
      entityId: columnKey,
      action: "update",
      before: pick(before),
      after: pick(next),
      ...auditFields(ctx),
    });
    return (await listMisColumns(client)).columns.find((column) => column.key === columnKey);
  }, db);
}
