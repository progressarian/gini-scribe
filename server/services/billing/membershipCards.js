import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { writeAudit } from "./audit.js";
import { indiaToday } from "./categoryResolver.js";
import { auditFields, readNumber } from "./common.js";
import { httpError, inTransaction } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_MAX = 25;
const TEXT_MAX = 500;

const CARD_COLUMNS = `c.id, c.card_no, c.plan_id, c.holder_patient_id, c.sold_bill_id, c.sold_line_id,
  c.price, c.consult_total, c.dietitian_total, c.consult_left, c.dietitian_left, c.status,
  c.cancelled_at, c.cancel_reason, c.created_at,
  p.name AS plan_name, p.code AS plan_code, p.lab_discount_pct,
  h.name AS holder_name, h.file_no AS holder_file_no, h.phone AS holder_phone,
  sb.bill_no AS sold_bill_no`;

const CARD_FROM = `membership_cards c
  JOIN membership_plans p ON p.id = c.plan_id
  JOIN patients h ON h.id = c.holder_patient_id
  LEFT JOIN bills sb ON sb.id = c.sold_bill_id`;

export function cleanCardId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, "Choose a valid membership card");
  return text.toLowerCase();
}

const maskPhone = (phone) => {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `••••••${digits.slice(-4)}` : null;
};

const shapeCard = (row, usedToday = false) => ({
  id: row.id,
  card_no: row.card_no,
  status: row.status,
  plan: { id: row.plan_id, code: row.plan_code, name: row.plan_name },
  holder: {
    id: row.holder_patient_id,
    name: row.holder_name,
    file_no: row.holder_file_no,
    phone: maskPhone(row.holder_phone),
  },
  price: paise(row.price),
  consult_total: row.consult_total,
  consult_left: row.consult_left,
  dietitian_total: row.dietitian_total,
  dietitian_left: row.dietitian_left,
  lab_discount_pct: Number(row.lab_discount_pct),
  lab_discount_today: Number(row.lab_discount_pct) > 0 && (row.consult_left > 0 || usedToday),
  sold_bill_no: row.sold_bill_no,
  cancelled_at: row.cancelled_at,
  cancel_reason: row.cancel_reason,
  created_at: row.created_at,
});

async function consultUsedOn(db, cardId, day) {
  const { rows } = await db.query(
    `SELECT 1 FROM membership_card_uses
      WHERE card_id = $1 AND kind = 'consultation' AND reversed_at IS NULL AND used_on = $2::date
      LIMIT 1`,
    [cardId, day],
  );
  return rows.length > 0;
}

async function dietitianItemId(db) {
  const { rows } = await db.query(
    `SELECT membership_dietitian_item_id AS id FROM billing_settings`,
  );
  return rows[0]?.id ?? null;
}

async function usedOnBill(db, billId) {
  const { rows } = await db.query(
    `SELECT kind, count(*)::int AS n FROM membership_card_uses
      WHERE bill_id = $1 AND reversed_at IS NULL GROUP BY kind`,
    [billId],
  );
  return Object.fromEntries(rows.map((row) => [row.kind, row.n]));
}

export async function membershipPricing(db, bill, lines) {
  if (!bill.membership_card_id) return null;
  const { rows } = await db.query(
    `SELECT c.id, c.plan_id, c.status, c.consult_left, c.dietitian_left, p.lab_discount_pct
       FROM membership_cards c JOIN membership_plans p ON p.id = c.plan_id WHERE c.id = $1`,
    [bill.membership_card_id],
  );
  const card = rows[0];
  if (!card || card.status === "cancelled") return null;
  const already = await usedOnBill(db, bill.id);
  const left = {
    consultation: card.consult_left + (already.consultation ?? 0),
    dietitian: card.dietitian_left + (already.dietitian ?? 0),
  };
  const dietItem = await dietitianItemId(db);
  const cover = new Map();
  for (const line of lines) {
    const benefit =
      line.item_kind === "consultation"
        ? "consultation"
        : dietItem && line.service_item_id === dietItem
          ? "dietitian"
          : null;
    if (!benefit || left[benefit] <= 0 || Number(line.quantity) !== 1) continue;
    cover.set(line.id, benefit);
    left[benefit] -= 1;
  }
  const coversConsult = [...cover.values()].includes("consultation");
  const labEligible =
    Number(card.lab_discount_pct) > 0 &&
    (card.consult_left > 0 ||
      coversConsult ||
      (await consultUsedOn(db, card.id, bill.bill_date ?? indiaToday())));
  return { cover, context: { plan_id: card.plan_id, lab_eligible: labEligible } };
}

async function planOfItem(client, itemIds) {
  if (!itemIds.length) return new Map();
  const { rows } = await client.query(
    `SELECT id, service_item_id, consult_count, dietitian_count FROM membership_plans
      WHERE service_item_id = ANY($1::int[])`,
    [itemIds],
  );
  return new Map(rows.map((row) => [row.service_item_id, row]));
}

const nextCardNo = async (client) =>
  (
    await client.query(
      `SELECT 'MEM-' || lpad(nextval('membership_card_seq')::text, 6, '0') AS card_no`,
    )
  ).rows[0].card_no;

async function lockCard(client, cardId) {
  const { rows } = await client.query(
    `SELECT id, card_no, status, consult_total, dietitian_total, consult_left, dietitian_left
       FROM membership_cards WHERE id = $1 FOR UPDATE`,
    [cardId],
  );
  if (!rows.length) throw httpError(404, "That membership card doesn't exist");
  return rows[0];
}

async function recount(client, cardId, ctx) {
  const card = await lockCard(client, cardId);
  const { rows } = await client.query(
    `SELECT kind, count(*)::int AS n FROM membership_card_uses
      WHERE card_id = $1 AND reversed_at IS NULL GROUP BY kind`,
    [cardId],
  );
  const used = Object.fromEntries(rows.map((row) => [row.kind, row.n]));
  const consultLeft = card.consult_total - (used.consultation ?? 0);
  const dietitianLeft = card.dietitian_total - (used.dietitian ?? 0);
  if (consultLeft < 0 || dietitianLeft < 0) {
    throw httpError(
      409,
      `Membership card ${card.card_no} has no ${consultLeft < 0 ? "consultations" : "dietitian visits"} left — open the bill again so it is priced without the card`,
      { code: "membership_used_up" },
    );
  }
  const status =
    card.status === "cancelled"
      ? "cancelled"
      : consultLeft === 0 && dietitianLeft === 0
        ? "exhausted"
        : "active";
  await client.query(
    `UPDATE membership_cards SET consult_left = $2, dietitian_left = $3, status = $4,
            updated_at = NOW(), updated_by = $5
      WHERE id = $1`,
    [cardId, consultLeft, dietitianLeft, status, ctx?.actorId ?? null],
  );
}

async function reconcileUses(client, bill, ctx) {
  const live = bill.status === "final" && bill.bill_type === "invoice";
  const { rows: wanted } = live
    ? await client.query(
        `SELECT id, membership_benefit FROM bill_lines
          WHERE bill_id = $1 AND is_live AND membership_benefit IS NOT NULL`,
        [bill.id],
      )
    : { rows: [] };
  const { rows: existing } = await client.query(
    `SELECT id, card_id, bill_line_id, kind FROM membership_card_uses
      WHERE bill_id = $1 AND reversed_at IS NULL`,
    [bill.id],
  );
  const wantedIds = new Set(wanted.map((line) => line.id));
  const touched = new Set();
  for (const use of existing) {
    if (wantedIds.has(use.bill_line_id) && use.card_id === bill.membership_card_id) continue;
    await client.query(
      `UPDATE membership_card_uses SET reversed_at = NOW(), reversed_by = $2, reverse_reason = $3
        WHERE id = $1`,
      [use.id, ctx?.actorId ?? null, live ? "Removed from the bill" : "Bill cancelled"],
    );
    await writeAudit(client, {
      entity: "membership_card_uses",
      entityId: use.id,
      action: "update",
      before: { reversed: false },
      after: { reversed: true, bill_no: bill.bill_no },
      ...auditFields(ctx),
    });
    touched.add(use.card_id);
  }
  const kept = new Set(
    existing
      .filter((use) => wantedIds.has(use.bill_line_id) && use.card_id === bill.membership_card_id)
      .map((use) => use.bill_line_id),
  );
  const missing = wanted.filter((line) => !kept.has(line.id));
  if (missing.length) {
    const card = await lockCard(client, bill.membership_card_id);
    if (card.status === "cancelled") {
      throw httpError(
        409,
        `Membership card ${card.card_no} was cancelled — remove it from the bill`,
      );
    }
    for (const line of missing) {
      const { rows } = await client.query(
        `INSERT INTO membership_card_uses (card_id, kind, patient_id, bill_id, bill_line_id,
                                           visit_id, used_on, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'bill', $8) RETURNING id`,
        [
          card.id,
          line.membership_benefit,
          bill.patient_id,
          bill.id,
          line.id,
          bill.visit_id,
          bill.bill_date,
          ctx?.actorId ?? null,
        ],
      );
      await writeAudit(client, {
        entity: "membership_card_uses",
        entityId: rows[0].id,
        action: "create",
        after: {
          card_no: card.card_no,
          kind: line.membership_benefit,
          patient_id: bill.patient_id,
          bill_no: bill.bill_no,
        },
        ...auditFields(ctx),
      });
    }
    touched.add(card.id);
  }
  for (const cardId of touched) await recount(client, cardId, ctx);
}

async function syncSoldCards(client, bill, ctx) {
  const live = bill.status === "final" && bill.bill_type === "invoice";
  const { rows: lines } = live
    ? await client.query(
        `SELECT id, service_item_id FROM bill_lines WHERE bill_id = $1 AND is_live`,
        [bill.id],
      )
    : { rows: [] };
  const plans = await planOfItem(
    client,
    lines.map((line) => line.service_item_id),
  );
  const saleLines = lines.filter((line) => plans.has(line.service_item_id));
  const { rows: cards } = await client.query(
    `SELECT id, card_no, sold_line_id, consult_total, consult_left, dietitian_total, dietitian_left
       FROM membership_cards WHERE sold_bill_id = $1 AND status <> 'cancelled' FOR UPDATE`,
    [bill.id],
  );
  const saleIds = new Set(saleLines.map((line) => line.id));
  for (const card of cards) {
    if (saleIds.has(card.sold_line_id)) continue;
    if (card.consult_left < card.consult_total || card.dietitian_left < card.dietitian_total) {
      throw httpError(
        409,
        `Membership card ${card.card_no} has already been used, so its sale can't be taken off the bill`,
        { code: "membership_in_use" },
      );
    }
    await client.query(
      `UPDATE membership_cards SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2,
              cancel_reason = $3, updated_at = NOW(), updated_by = $2
        WHERE id = $1`,
      [card.id, ctx?.actorId ?? null, `Sale removed from bill ${bill.bill_no ?? ""}`.trim()],
    );
    await writeAudit(client, {
      entity: "membership_cards",
      entityId: card.id,
      action: "cancel",
      before: { status: "active" },
      after: { status: "cancelled", bill_no: bill.bill_no },
      ...auditFields(ctx),
    });
  }
  const sold = new Set(cards.map((card) => card.sold_line_id));
  for (const line of saleLines) {
    if (sold.has(line.id)) continue;
    const plan = plans.get(line.service_item_id);
    const { rows: priced } = await client.query(
      `SELECT patient_payable FROM bill_lines WHERE id = $1`,
      [line.id],
    );
    const cardNo = await nextCardNo(client);
    const { rows } = await client.query(
      `INSERT INTO membership_cards (card_no, plan_id, holder_patient_id, sold_bill_id,
                                     sold_line_id, price, consult_total, dietitian_total,
                                     consult_left, dietitian_left, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7, $8, $9, $9) RETURNING id`,
      [
        cardNo,
        plan.id,
        bill.patient_id,
        bill.id,
        line.id,
        priced[0].patient_payable,
        plan.consult_count,
        plan.dietitian_count,
        ctx?.actorId ?? null,
      ],
    );
    await writeAudit(client, {
      entity: "membership_cards",
      entityId: rows[0].id,
      action: "create",
      after: {
        card_no: cardNo,
        plan_id: plan.id,
        patient_id: bill.patient_id,
        bill_no: bill.bill_no,
      },
      ...auditFields(ctx),
    });
  }
}

export async function syncMemberships(client, billId, ctx) {
  const { rows } = await client.query(
    `SELECT id, bill_no, status, bill_type, membership_card_id, patient_id, visit_id,
            bill_date::text AS bill_date
       FROM bills WHERE id = $1`,
    [billId],
  );
  if (!rows.length || rows[0].bill_type !== "invoice") return;
  await syncSoldCards(client, rows[0], ctx);
  await reconcileUses(client, rows[0], ctx);
}

export async function assertCardUsable(client, cardId) {
  const { rows } = await client.query(`SELECT ${CARD_COLUMNS} FROM ${CARD_FROM} WHERE c.id = $1`, [
    cleanCardId(cardId),
  ]);
  if (!rows.length) throw httpError(404, "That membership card doesn't exist");
  const card = rows[0];
  if (card.status === "cancelled") {
    throw httpError(409, `Membership card ${card.card_no} was cancelled and can't be used`);
  }
  const usedToday = await consultUsedOn(client, card.id, indiaToday());
  if (card.status === "exhausted" && !usedToday) {
    throw httpError(409, `Membership card ${card.card_no} has no consultations or visits left`);
  }
  return shapeCard(card, usedToday);
}

function cleanSearch(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 2) throw httpError(400, "Type at least 2 letters or digits to search");
  return text.slice(0, 60);
}

export async function searchCards(query, db = pool) {
  const text = cleanSearch(query?.q);
  const digits = text.replace(/\D/g, "");
  const { rows } = await db.query(
    `SELECT ${CARD_COLUMNS} FROM ${CARD_FROM}
      WHERE c.status <> 'cancelled'
        AND (lower(c.card_no) = lower($1) OR lower(c.card_no) LIKE '%' || lower($1)
             OR h.name ILIKE '%' || $1 || '%' OR lower(h.file_no) = lower($1)
             OR ($2 <> '' AND length($2) >= 6 AND regexp_replace(COALESCE(h.phone, ''), '\\D', '', 'g') LIKE '%' || $2))
      ORDER BY c.status = 'active' DESC, c.created_at DESC
      LIMIT ${SEARCH_MAX}`,
    [text, digits],
  );
  const today = indiaToday();
  return Promise.all(
    rows.map(async (row) => shapeCard(row, await consultUsedOn(db, row.id, today))),
  );
}

export async function cardsOfPatient(patientIdValue, db = pool) {
  const patientId = readNumber(patientIdValue, "Choose a valid patient");
  if (!Number.isInteger(patientId) || patientId <= 0)
    throw httpError(400, "Choose a valid patient");
  const { rows } = await db.query(
    `SELECT ${CARD_COLUMNS} FROM ${CARD_FROM}
      WHERE c.holder_patient_id = $1 AND c.status <> 'cancelled'
      ORDER BY c.status = 'active' DESC, c.created_at DESC`,
    [patientId],
  );
  const today = indiaToday();
  return Promise.all(
    rows.map(async (row) => shapeCard(row, await consultUsedOn(db, row.id, today))),
  );
}

export async function cardDetail(cardIdValue, db = pool) {
  const id = cleanCardId(cardIdValue);
  const { rows } = await db.query(`SELECT ${CARD_COLUMNS} FROM ${CARD_FROM} WHERE c.id = $1`, [id]);
  if (!rows.length) throw httpError(404, "That membership card doesn't exist");
  const { rows: uses } = await db.query(
    `SELECT u.id, u.kind, u.used_on::text AS used_on, u.source, u.note, u.created_at,
            u.reversed_at, u.reverse_reason, u.bill_id, b.bill_no, u.patient_id,
            pt.name AS patient_name, pt.file_no AS patient_file_no,
            u.patient_id = c.holder_patient_id AS by_holder,
            COALESCE(d.short_name, d.name) AS created_by_name
       FROM membership_card_uses u
       JOIN membership_cards c ON c.id = u.card_id
       JOIN patients pt ON pt.id = u.patient_id
       LEFT JOIN bills b ON b.id = u.bill_id
       LEFT JOIN doctors d ON d.id = u.created_by
      WHERE u.card_id = $1
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT 200`,
    [id],
  );
  return {
    ...shapeCard(rows[0], await consultUsedOn(db, id, indiaToday())),
    uses,
  };
}

function cleanText(value, message) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw httpError(400, message);
  if (text.length > TEXT_MAX)
    throw httpError(400, `${message} — keep it under ${TEXT_MAX} letters`);
  return text;
}

export async function useDietitianManually(cardIdValue, input, ctx, db = pool) {
  const id = cleanCardId(cardIdValue);
  const patientId = readNumber(input?.patient_id, "Choose who saw the dietitian");
  if (!Number.isInteger(patientId) || patientId <= 0) {
    throw httpError(400, "Choose who saw the dietitian");
  }
  const note = cleanText(input?.note, "Say which dietitian visit this was");
  return inTransaction(async (client) => {
    const card = await lockCard(client, id);
    if (card.status === "cancelled") {
      throw httpError(409, `Membership card ${card.card_no} was cancelled`);
    }
    if (card.dietitian_left <= 0) {
      throw httpError(409, `Membership card ${card.card_no} has no dietitian visits left`);
    }
    const { rows: patient } = await client.query(`SELECT id FROM patients WHERE id = $1`, [
      patientId,
    ]);
    if (!patient.length) throw httpError(404, "That patient doesn't exist");
    const { rows } = await client.query(
      `INSERT INTO membership_card_uses (card_id, kind, patient_id, used_on, source, note, created_by)
       VALUES ($1, 'dietitian', $2, $3::date, 'manual', $4, $5) RETURNING id`,
      [id, patientId, indiaToday(), note, ctx?.actorId ?? null],
    );
    await writeAudit(client, {
      entity: "membership_card_uses",
      entityId: rows[0].id,
      action: "create",
      after: {
        card_no: card.card_no,
        kind: "dietitian",
        patient_id: patientId,
        source: "manual",
        note,
      },
      ...auditFields(ctx),
    });
    await recount(client, id, ctx);
    return cardDetail(id, client);
  }, db);
}

export async function reverseUse(useIdValue, input, ctx, db = pool) {
  const text = typeof useIdValue === "string" ? useIdValue.trim() : "";
  if (!UUID.test(text)) throw httpError(400, "Choose a valid card use");
  const reason = cleanText(input?.reason, "Say why this use is being reversed");
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, card_id, source, reversed_at FROM membership_card_uses WHERE id = $1 FOR UPDATE`,
      [text],
    );
    if (!rows.length) throw httpError(404, "That card use doesn't exist");
    const use = rows[0];
    if (use.reversed_at) throw httpError(409, "That use was already reversed");
    if (use.source !== "manual") {
      throw httpError(
        409,
        "This use came from a bill — remove the line from the bill (Edit bill) to give it back",
      );
    }
    await lockCard(client, use.card_id);
    await client.query(
      `UPDATE membership_card_uses SET reversed_at = NOW(), reversed_by = $2, reverse_reason = $3
        WHERE id = $1`,
      [use.id, ctx?.actorId ?? null, reason],
    );
    await writeAudit(client, {
      entity: "membership_card_uses",
      entityId: use.id,
      action: "update",
      before: { reversed: false },
      after: { reversed: true, reason },
      ...auditFields(ctx),
    });
    await recount(client, use.card_id, ctx);
    return cardDetail(use.card_id, client);
  }, db);
}
