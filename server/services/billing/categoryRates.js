import pool from "../../config/db.js";
import { writeAudit } from "./audit.js";
import { indiaToday } from "./categoryResolver.js";
import { httpError, inTransaction } from "./transaction.js";
import { auditFields, cleanFlag, hasField, INT_MAX, MONEY_MAX, readNumber } from "./common.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanDate(value, label, { required }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw httpError(400, `${label} is required`);
    return null;
  }
  const text = typeof value === "string" ? value.trim() : "";
  const parsed = DATE.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw httpError(400, `${label} must be a date like 2026-10-01`);
  }
  return text;
}

function cleanRate(value) {
  const rate = readNumber(value, "Rate must be an amount in rupees");
  if (rate === undefined) return null;
  if (rate < 0) throw httpError(400, "Rate can't be negative");
  if (rate > MONEY_MAX) throw httpError(400, `Rate is too large (at most ${MONEY_MAX})`);
  if (Number(rate.toFixed(2)) !== rate)
    throw httpError(400, "Rate can have at most 2 decimals (paise)");
  return rate;
}

function cleanText(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw httpError(400, `${label} must be text`);
  return value.trim() || null;
}

function cleanBillCode(value) {
  const code = cleanText(value, "Bill code");
  if (code && /\s/.test(code)) throw httpError(400, "Bill code can't contain spaces");
  return code;
}

function cleanScheme(value) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!code) throw httpError(400, "Choose a category");
  return code;
}

function cleanId(value, label) {
  const id = readNumber(value, `Choose ${label}`);
  if (!Number.isInteger(id) || id <= 0 || id > INT_MAX) throw httpError(400, `Choose ${label}`);
  return id;
}

const cleanItemId = (value) => cleanId(value, "an item");

const ROW = `scheme_code, service_item_id, rate, bill_name, bill_code,
             valid_from::text AS valid_from, valid_to::text AS valid_to`;

const shape = (row) => row && { ...row, rate: row.rate === null ? null : Number(row.rate) };

const entityId = (row) => `${row.scheme_code}:${row.service_item_id}:${row.valid_from}`;

const overlaps = (a, b) =>
  (a.valid_to === null || b.valid_from <= a.valid_to) &&
  (b.valid_to === null || a.valid_from <= b.valid_to);

const span = (row) => `${row.valid_from} to ${row.valid_to ?? "open-ended"}`;

async function checkCategory(client, code) {
  const { rows } = await client.query(
    `SELECT CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS name,
            s.is_active AND COALESCE(p.is_active, TRUE) AS active
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1`,
    [code],
  );
  if (!rows.length) throw httpError(404, "That category doesn't exist");
  if (!rows[0].active) throw httpError(409, `${rows[0].name} is retired; bring it back first`);
  return rows[0].name;
}

async function checkItem(client, id) {
  const { rows } = await client.query(`SELECT name, is_active FROM service_items WHERE id = $1`, [
    id,
  ]);
  if (!rows.length) throw httpError(404, "That item doesn't exist");
  if (!rows[0].is_active) throw httpError(409, `${rows[0].name} is deactivated`);
  return rows[0].name;
}

export async function saveRate(input, ctx, db = pool) {
  const values = {
    scheme_code: cleanScheme(input?.scheme_code),
    service_item_id: cleanItemId(input?.service_item_id),
    valid_from: cleanDate(input?.valid_from, "From date", { required: false }) ?? indiaToday(),
    valid_to: cleanDate(input?.valid_to, "To date", { required: false }),
    rate: cleanRate(input?.rate),
    bill_name: cleanText(input?.bill_name, "Bill name"),
    bill_code: cleanBillCode(input?.bill_code),
  };
  if (values.valid_to !== null && values.valid_to < values.valid_from) {
    throw httpError(400, "To date can't be before the From date");
  }
  if (values.rate === null && values.bill_name === null && values.bill_code === null) {
    throw httpError(
      400,
      "Give a rate, a bill name or a bill code — a rate row must change something",
    );
  }
  return inTransaction(async (client) => {
    await checkCategory(client, values.scheme_code);
    await checkItem(client, values.service_item_id);
    await lockItem(client, values.scheme_code, values.service_item_id);
    const { rows: existing } = await client.query(
      `SELECT ${ROW} FROM category_item_rates
        WHERE scheme_code = $1 AND service_item_id = $2
        ORDER BY valid_from`,
      [values.scheme_code, values.service_item_id],
    );
    const same = existing.find((r) => r.valid_from === values.valid_from) ?? null;
    const others = existing.filter((r) => r !== same);
    const toClose =
      values.valid_to === null
        ? others.filter(
            (r) => r.valid_to === null && r.valid_from < values.valid_from && overlaps(r, values),
          )
        : [];
    const conflicts = others.filter((r) => !toClose.includes(r) && overlaps(r, values));
    if (toClose.length > 1 || conflicts.length) {
      throw httpError(
        409,
        `These dates overlap another rate for the same item (${[...conflicts, ...toClose.slice(1)].map(span).join("; ")}). Change the dates or end that rate first.`,
        { conflicts: conflicts.map(shape) },
      );
    }

    const closed = [];
    for (const row of toClose) {
      const { rows } = await client.query(
        `UPDATE category_item_rates
            SET valid_to = $4::date - 1, updated_at = NOW(), updated_by = $5
          WHERE scheme_code = $1 AND service_item_id = $2 AND valid_from = $3
          RETURNING ${ROW}`,
        [
          row.scheme_code,
          row.service_item_id,
          row.valid_from,
          values.valid_from,
          ctx?.actorId ?? null,
        ],
      );
      await writeAudit(client, {
        entity: "category_item_rates",
        entityId: entityId(row),
        action: "update",
        before: row,
        after: rows[0],
        ...auditFields(ctx),
      });
      closed.push(shape(rows[0]));
    }

    const { rows } = await client.query(
      `INSERT INTO category_item_rates
         (scheme_code, service_item_id, valid_from, valid_to, rate, bill_name, bill_code,
          created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (scheme_code, service_item_id, valid_from) DO UPDATE
          SET valid_to = EXCLUDED.valid_to, rate = EXCLUDED.rate, bill_name = EXCLUDED.bill_name,
              bill_code = EXCLUDED.bill_code, updated_at = NOW(), updated_by = EXCLUDED.updated_by
       RETURNING ${ROW}`,
      [
        values.scheme_code,
        values.service_item_id,
        values.valid_from,
        values.valid_to,
        values.rate,
        values.bill_name,
        values.bill_code,
        ctx?.actorId ?? null,
      ],
    );
    await writeAudit(client, {
      entity: "category_item_rates",
      entityId: entityId(rows[0]),
      action: same ? "update" : "create",
      before: same,
      after: rows[0],
      ...auditFields(ctx),
    });
    return { rate: shape(rows[0]), closed, starts_in_past: values.valid_from < indiaToday() };
  }, db);
}

const lockItem = (client, scheme, itemId) =>
  client.query(
    `SELECT pg_advisory_xact_lock(hashtext('category_item_rates'), hashtext($1 || ':' || $2))`,
    [scheme, String(itemId)],
  );

export async function deleteRate(input, ctx, db = pool) {
  const scheme = cleanScheme(input?.scheme_code);
  const itemId = cleanItemId(input?.service_item_id);
  const from = cleanDate(input?.valid_from, "From date", { required: true });
  const reopen = hasField(input, "reopen_previous")
    ? cleanFlag(input.reopen_previous, "Reopen previous")
    : false;
  return inTransaction(async (client) => {
    await lockItem(client, scheme, itemId);
    const { rows } = await client.query(
      `DELETE FROM category_item_rates
        WHERE scheme_code = $1 AND service_item_id = $2 AND valid_from = $3
        RETURNING ${ROW}`,
      [scheme, itemId, from],
    );
    if (!rows.length) throw httpError(404, "That rate no longer exists");
    const deleted = rows[0];
    await writeAudit(client, {
      entity: "category_item_rates",
      entityId: entityId(deleted),
      action: "delete",
      before: deleted,
      ...auditFields(ctx),
    });
    const { rows: previous } = await client.query(
      `SELECT ${ROW} FROM category_item_rates
        WHERE scheme_code = $1 AND service_item_id = $2 AND valid_to = $3::date - 1`,
      [scheme, itemId, deleted.valid_from],
    );
    if (!reopen) return { deleted: true, previous: shape(previous[0]) ?? null, reopened: null };
    if (!previous.length) {
      throw httpError(
        409,
        `No rate ends on the day before ${deleted.valid_from}, so there is nothing to reopen`,
      );
    }
    const { rows: reopened } = await client.query(
      `UPDATE category_item_rates SET valid_to = $4, updated_at = NOW(), updated_by = $5
        WHERE scheme_code = $1 AND service_item_id = $2 AND valid_from = $3
        RETURNING ${ROW}`,
      [scheme, itemId, previous[0].valid_from, deleted.valid_to, ctx?.actorId ?? null],
    );
    await writeAudit(client, {
      entity: "category_item_rates",
      entityId: entityId(previous[0]),
      action: "update",
      before: previous[0],
      after: reopened[0],
      ...auditFields(ctx),
    });
    return { deleted: true, previous: shape(reopened[0]), reopened: shape(reopened[0]) };
  }, db);
}

export async function rateHistory({ schemeCode, itemId }, db = pool) {
  const { rows } = await db.query(
    `SELECT ${ROW} FROM category_item_rates
      WHERE scheme_code = $1 AND service_item_id = $2
      ORDER BY valid_from DESC`,
    [cleanScheme(schemeCode), cleanItemId(itemId)],
  );
  return rows.map(shape);
}

export async function rateGrid(schemeCode, options = {}, db = pool) {
  const code = cleanScheme(schemeCode);
  const date = cleanDate(options.date, "Date", { required: false }) ?? indiaToday();
  const params = [code, date];
  const where = ["i.is_active"];
  if (hasField(options, "groupId") && options.groupId) {
    params.push(cleanId(options.groupId, "a group"));
    where.push(`s.group_id = $${params.length}`);
  }
  if (hasField(options, "subgroupId") && options.subgroupId) {
    params.push(cleanId(options.subgroupId, "a subgroup"));
    where.push(`i.subgroup_id = $${params.length}`);
  }
  const { rows: category } = await db.query(
    `SELECT s.code, s.parent_code,
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END AS display_label
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1`,
    [code],
  );
  if (!category.length) throw httpError(404, "That category doesn't exist");
  params.push(category[0].parent_code);
  const parentParam = `$${params.length}`;
  const current = (scheme) => `
    LEFT JOIN LATERAL (
      SELECT r.rate, r.bill_name, r.bill_code, r.valid_from::text AS valid_from,
             r.valid_to::text AS valid_to
        FROM category_item_rates r
       WHERE r.scheme_code = ${scheme} AND r.service_item_id = i.id
         AND r.valid_from <= $2::date AND (r.valid_to IS NULL OR r.valid_to >= $2::date)
       ORDER BY r.valid_from DESC LIMIT 1
    )`;
  const { rows } = await db.query(
    `SELECT i.id AS service_item_id, i.code, i.name, i.base_price, i.kind,
            g.name AS group_name, s.name AS subgroup_name,
            own.rate AS own_rate, own.bill_name AS own_bill_name, own.bill_code AS own_bill_code,
            own.valid_from AS own_valid_from, own.valid_to AS own_valid_to,
            par.rate AS parent_rate, par.bill_name AS parent_bill_name,
            par.bill_code AS parent_bill_code,
            (SELECT min(f.valid_from)::text FROM category_item_rates f
              WHERE f.scheme_code = $1 AND f.service_item_id = i.id AND f.valid_from > $2::date)
              AS next_valid_from
       FROM service_items i
       JOIN service_subgroups s ON s.id = i.subgroup_id
       JOIN service_groups g ON g.id = s.group_id
       ${current("$1")} own ON TRUE
       ${current(parentParam)} par ON TRUE
      WHERE ${where.join(" AND ")}
      ORDER BY g.sort_order, g.name, s.sort_order, s.name, i.name`,
    params,
  );
  const pick = (own, parent, base) =>
    own !== null && own !== undefined
      ? { value: own, source: "own" }
      : parent !== null && parent !== undefined
        ? { value: parent, source: "parent" }
        : { value: base, source: "base" };
  return {
    category: category[0],
    date,
    today: indiaToday(),
    items: rows.map((r) => {
      const rate = pick(
        r.own_rate === null ? null : Number(r.own_rate),
        r.parent_rate === null ? null : Number(r.parent_rate),
        Number(r.base_price),
      );
      const billName = pick(r.own_bill_name, r.parent_bill_name, r.name);
      const billCode = pick(r.own_bill_code, r.parent_bill_code, null);
      return {
        service_item_id: r.service_item_id,
        code: r.code,
        name: r.name,
        kind: r.kind,
        group_name: r.group_name,
        subgroup_name: r.subgroup_name,
        base_price: Number(r.base_price),
        own:
          r.own_valid_from === null
            ? null
            : {
                rate: r.own_rate === null ? null : Number(r.own_rate),
                bill_name: r.own_bill_name,
                bill_code: r.own_bill_code,
                valid_from: r.own_valid_from,
                valid_to: r.own_valid_to,
              },
        rate: rate.value,
        rate_source: rate.source,
        bill_name: billName.value,
        bill_name_source: billName.source,
        bill_code: billCode.value,
        bill_code_source: billCode.value === null ? null : billCode.source,
        next_valid_from: r.next_valid_from,
      };
    }),
  };
}
