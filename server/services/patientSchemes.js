import pool from "../config/db.js";
import { writeAudit } from "./billing/audit.js";
import { RESERVED_CATEGORY_CODES } from "./billing/importColumns.js";
import { httpError, inTransaction } from "./billing/transaction.js";
import {
  auditFields,
  cleanActive,
  cleanFlag,
  cleanOrder,
  deleteUnused,
  INT_MAX,
  readNumber,
} from "./billing/common.js";

// The scheme vocabulary, read from patient_schemes rather than the hardcoded
// array shared/patientCategories.js used to be (33-PATIENT-SCHEME-PLAN.md §1).
//
// `code` is the join key every later feature hangs off — category rates,
// category rules, the daily cap — so a code is never renamed, and is deleted
// only when nothing uses it (billing plan D9). Retiring a scheme flips
// is_active, which keeps historical appointments resolving their label.

const COLUMNS = `s.code, s.label, s.color, s.is_active, s.requires_ref, s.daily_cap, s.sort_order,
                 s.parent_code, s.payer_name, s.requires_referral, s.requires_referral_doc,
                 s.print_category_on_bill, s.allow_pay_later,
                 p.label AS parent_label, p.sort_order AS parent_sort,
                 CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS display_label`;

const FROM = `FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code`;

const ORDER = `ORDER BY COALESCE(p.sort_order, s.sort_order), COALESCE(p.label, s.label),
                        (s.parent_code IS NOT NULL), s.sort_order, s.label`;

const shape = ({ parent_sort, ...r }) => ({
  ...r,
  daily_cap: r.daily_cap === null ? null : Number(r.daily_cap),
});

export async function listSchemes({ all = false } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM} ${all ? "" : "WHERE s.is_active AND COALESCE(p.is_active, TRUE)"} ${ORDER}`,
  );
  return rows.map(shape);
}

export async function listSchemeTree({ all = false } = {}, db = pool) {
  const flat = await listSchemes({ all }, db);
  const tops = flat.filter((r) => !r.parent_code);
  return tops.map((top) => ({
    ...top,
    sub_categories: flat.filter((r) => r.parent_code === top.code),
  }));
}

// The server's own validator. Reads the table rather than a cached list on
// purpose: a scheme added a minute ago must be accepted by the very next PATCH,
// and a cold cache would reject it (§2).
export async function isKnownScheme(code, db = pool) {
  if (!code) return true; // "" / null is General — the absence of a scheme
  const { rows } = await db.query(
    `SELECT 1 FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1 AND s.is_active AND COALESCE(p.is_active, TRUE)`,
    [code],
  );
  return rows.length > 0;
}

const CODE_RE = /^[a-z0-9_]{2,32}$/;

const FLAGS = [
  "requires_ref",
  "requires_referral",
  "requires_referral_doc",
  "print_category_on_bill",
];
const FLAG_LABELS = {
  requires_ref: "Card number required",
  requires_referral: "Referral required",
  requires_referral_doc: "Referral document required",
  print_category_on_bill: "Print category on bill",
};

function cleanLabel(value) {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label) throw httpError(400, "A scheme needs a label");
  return label;
}

function cleanPayer(value) {
  if (value === undefined || value === null) return null;
  const payer = typeof value === "string" ? value.trim() : "";
  if (typeof value !== "string") throw httpError(400, "Payer name must be text");
  return payer || null;
}

function cleanPayLater(value) {
  if (value === undefined || value === null || value === "") return null;
  return cleanFlag(value, "Allow pay later");
}

function cleanParent(value) {
  if (value === undefined || value === null || value === "") return null;
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!CODE_RE.test(code)) throw httpError(400, "Choose a valid parent category");
  return code;
}

const CLEANERS = {
  label: cleanLabel,
  color: (v) => (typeof v === "string" && v.trim() ? v.trim() : "gray"),
  is_active: cleanActive,
  daily_cap: (v) => normalizeCap(v),
  sort_order: cleanOrder,
  parent_code: cleanParent,
  payer_name: cleanPayer,
  allow_pay_later: cleanPayLater,
  ...Object.fromEntries(FLAGS.map((f) => [f, (v) => cleanFlag(v, FLAG_LABELS[f])])),
};

function cleanFields(input, keys) {
  const out = {};
  for (const key of keys) {
    if (input && Object.prototype.hasOwnProperty.call(input, key))
      out[key] = CLEANERS[key](input[key]);
  }
  return out;
}

async function lockScheme(client, code) {
  const { rows } = await client.query(
    `SELECT code, label, color, is_active, requires_ref, daily_cap, sort_order, parent_code,
            payer_name, requires_referral, requires_referral_doc, print_category_on_bill,
            allow_pay_later
       FROM patient_schemes WHERE code = $1 FOR UPDATE`,
    [code],
  );
  if (!rows.length) throw httpError(404, "Scheme not found");
  return rows[0];
}

async function checkParent(client, parentCode, childCode) {
  if (!parentCode) return;
  if (parentCode === childCode) throw httpError(400, "A category can't be its own parent");
  const { rows } = await client.query(
    `SELECT label, is_active, parent_code FROM patient_schemes WHERE code = $1`,
    [parentCode],
  );
  if (!rows.length) throw httpError(404, "That parent category doesn't exist");
  if (!rows[0].is_active) throw httpError(409, `${rows[0].label} is retired; bring it back first`);
  if (rows[0].parent_code) {
    throw httpError(
      409,
      `${rows[0].label} is already a sub-category, so nothing can go under it: only two levels are allowed`,
    );
  }
}

async function checkLabelFree(client, label, parentCode, exceptCode) {
  const { rows } = await client.query(
    `SELECT label FROM patient_schemes
      WHERE lower(label) = lower($1) AND parent_code IS NOT DISTINCT FROM $2
        AND code IS DISTINCT FROM $3`,
    [label, parentCode, exceptCode],
  );
  if (rows.length) {
    throw httpError(
      409,
      parentCode
        ? `A sub-category called "${rows[0].label}" already exists under that category`
        : `A category called "${rows[0].label}" already exists`,
    );
  }
}

async function rulesToMove(client, parentCode) {
  if (!parentCode) return [];
  const { rows } = await client.query(
    `SELECT id, name FROM category_rules WHERE scheme_code = $1 ORDER BY name`,
    [parentCode],
  );
  return rows;
}

const treeError = (error) =>
  error?.code === "23514" && /only two levels/.test(error.message || "")
    ? httpError(409, error.message)
    : error;

export async function createScheme(input, db = pool, ctx = null) {
  const code = String(input?.code || "")
    .trim()
    .toLowerCase();
  if (!CODE_RE.test(code)) {
    throw httpError(400, "Code must be 2–32 characters: a–z, 0–9 and _ only");
  }
  if (RESERVED_CATEGORY_CODES.includes(code)) {
    throw httpError(400, `"${code}" is reserved: it means patients with no category`);
  }
  const values = {
    label: cleanLabel(input?.label),
    color: CLEANERS.color(input?.color),
    daily_cap: normalizeCap(input?.daily_cap),
    sort_order: cleanOrder(input?.sort_order),
    ...cleanFields(input, ["parent_code", "payer_name", "allow_pay_later", ...FLAGS]),
  };
  return inTransaction(async (client) => {
    await checkParent(client, values.parent_code ?? null, code);
    await checkLabelFree(client, values.label, values.parent_code ?? null, null);
    const hadChildren = values.parent_code
      ? (
          await client.query(`SELECT 1 FROM patient_schemes WHERE parent_code = $1 LIMIT 1`, [
            values.parent_code,
          ])
        ).rows.length > 0
      : true;
    const keys = Object.keys(values);
    const { rows } = await client
      .query(
        `INSERT INTO patient_schemes (code, ${keys.join(", ")})
         VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")})
         RETURNING code`,
        [code, ...keys.map((k) => values[k])],
      )
      .catch((e) => {
        if (e.code === "23505") throw httpError(409, `A scheme with code "${code}" already exists`);
        throw treeError(e);
      });
    const created = await lockScheme(client, rows[0].code);
    await writeAudit(client, {
      entity: "patient_schemes",
      entityId: code,
      action: "create",
      after: created,
      ...auditFields(ctx),
    });
    const result = shape(
      (await client.query(`SELECT ${COLUMNS} ${FROM} WHERE s.code = $1`, [code])).rows[0],
    );
    return hadChildren
      ? result
      : { ...result, rules_to_move: await rulesToMove(client, values.parent_code) };
  }, db);
}

// A cap of 0 is meaningful — "we are not taking any today" — so only an absent
// or blank value means unlimited.
function normalizeCap(v) {
  const n = readNumber(v, "Daily cap must be a whole number, 0 or more");
  if (n === undefined) return null;
  if (!Number.isInteger(n) || n < 0 || n > INT_MAX) {
    throw Object.assign(new Error("Daily cap must be a whole number, 0 or more"), { status: 400 });
  }
  return n;
}

const EDITABLE = [
  "label",
  "color",
  "is_active",
  "requires_ref",
  "daily_cap",
  "sort_order",
  "parent_code",
  "payer_name",
  "requires_referral",
  "requires_referral_doc",
  "print_category_on_bill",
  "allow_pay_later",
];

export async function updateScheme(code, patch, db = pool, ctx = null) {
  // The code is the join key for prices and caps; renaming it would orphan
  // every row that references it. Retire and re-add instead.
  const values = cleanFields(patch, EDITABLE);
  const keys = Object.keys(values);
  if (!keys.length) throw httpError(400, "Nothing to update");
  return inTransaction(async (client) => {
    const before = await lockScheme(client, code);
    const parent = "parent_code" in values ? values.parent_code : before.parent_code;
    let movedUnder = null;
    if ("parent_code" in values && values.parent_code !== before.parent_code) {
      await checkParent(client, values.parent_code, code);
      if (values.parent_code) movedUnder = values.parent_code;
    }
    if ("label" in values || "parent_code" in values) {
      await checkLabelFree(client, values.label ?? before.label, parent, code);
    }
    if (values.is_active === false && before.is_active) {
      const { rows } = await client.query(
        `SELECT label FROM patient_schemes WHERE parent_code = $1 AND is_active ORDER BY label`,
        [code],
      );
      if (rows.length) {
        const names = rows.map((r) => r.label);
        throw httpError(
          409,
          `${before.label} still has ${rows.length} active sub-categor${rows.length === 1 ? "y" : "ies"}: ${names.join(", ")}. Retire ${rows.length === 1 ? "it" : "them"} first.`,
          { active: names },
        );
      }
    }
    if (values.is_active === true && !before.is_active && parent) {
      await checkParent(client, parent, code);
    }
    const hadChildren = movedUnder
      ? (
          await client.query(
            `SELECT 1 FROM patient_schemes WHERE parent_code = $1 AND code <> $2 LIMIT 1`,
            [movedUnder, code],
          )
        ).rows.length > 0
      : true;
    await client
      .query(
        `UPDATE patient_schemes SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = NOW()
          WHERE code = $1`,
        [code, ...keys.map((k) => values[k])],
      )
      .catch((e) => {
        throw treeError(e);
      });
    const after = await lockScheme(client, code);
    await writeAudit(client, {
      entity: "patient_schemes",
      entityId: code,
      action: "update",
      before,
      after,
      ...auditFields(ctx),
    });
    const result = shape(
      (await client.query(`SELECT ${COLUMNS} ${FROM} WHERE s.code = $1`, [code])).rows[0],
    );
    return hadChildren
      ? result
      : { ...result, rules_to_move: await rulesToMove(client, movedUnder) };
  }, db);
}

export async function deleteScheme(code, db = pool, ctx = null) {
  return inTransaction(async (client) => {
    const before = await lockScheme(client, code);
    return deleteUnused(client, {
      table: "patient_schemes",
      key: "code",
      kind: "category",
      id: code,
      label: before.label,
      before,
      ctx,
    });
  }, db);
}
