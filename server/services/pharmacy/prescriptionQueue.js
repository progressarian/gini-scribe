import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { raiseNotification } from "../notifications.js";
import { handoverBlockFor } from "../giniflow/pharmacyStation.js";
import { DUE_SQL } from "./billDue.js";
import { getBillPatient } from "./billPatients.js";
import { medicineKeysOf, stockByKey } from "./billPrescription.js";
import { getPharmacySettings } from "./settings.js";
import { mainLocationId } from "./stockLedger.js";
import { batchesAt } from "./stockView.js";
import { requestMedicine } from "./stockNeeded.js";
import { ROLES } from "../../../shared/permissions.js";
import { STATUS_LABEL } from "../../../shared/giniflowStatus.js";
import { RX_REQUESTED_REASON } from "../../../shared/pharmacyVocab.js";

const ENTITY = "pharmacy_bills";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const FINISHED = ["dispensed", "exited", "no_show", "cancelled"];

const CATEGORY_SQL = `CASE
    WHEN r.current_status = 'pharmacy_pending' THEN 'ready'
    WHEN r.current_status = ANY('{${FINISHED.join(",")}}'::text[])
      OR (r.pending = 0 AND r.given + r.partial = r.total) THEN 'done'
    ELSE 'coming'
  END`;

const CATEGORY_ORDER = `CASE category WHEN 'ready' THEN 0 WHEN 'coming' THEN 1 ELSE 2 END`;

const BILLS_TODAY = `b.patient_id = r.patient_id AND b.bill_type = 'invoice'
  AND ((b.status = 'final' AND b.bill_date = $1::date)
    OR (b.status = 'draft' AND (b.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date))`;

export async function listPrescriptionQueue(
  { date = today(), q, category = "ready", limit = 25, offset = 0 } = {},
  db = pool,
) {
  const params = [date];
  const search = [];
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    search.push(
      `(lower(p.name) LIKE $2 OR lower(COALESCE(p.file_no, '')) LIKE $2
        OR COALESCE(p.phone, '') LIKE $2)`,
    );
  }
  const base = `WITH prescribed AS (
       SELECT m.patient_id,
              COUNT(*)::int AS total,
              COUNT(mc.*) FILTER (WHERE mc.status = 'given')::int AS given,
              COUNT(mc.*) FILTER (WHERE mc.status = 'partial')::int AS partial,
              COUNT(mc.*) FILTER (WHERE mc.status = 'not_given')::int AS not_given,
              COUNT(*) FILTER (WHERE mc.id IS NULL)::int AS pending
         FROM medications m
         LEFT JOIN medicine_collections mc
           ON mc.medication_id = m.id AND mc.collected_date = $1::date
        WHERE m.is_active AND m.visit_status = 'current' AND m.last_prescribed_date = $1::date
        GROUP BY m.patient_id
     ),
     r AS (
       SELECT x.*, p.name, p.file_no, p.phone, v.id AS visit_id, v.current_status,
              a.doctor_name
         FROM prescribed x
         JOIN patients p ON p.id = x.patient_id
         LEFT JOIN LATERAL (
           SELECT v2.id, v2.current_status FROM giniflow_visits v2
            WHERE v2.patient_id = x.patient_id AND v2.visit_date = $1::date
              AND v2.merged_into_visit_id IS NULL
            ORDER BY v2.created_at DESC LIMIT 1
         ) v ON TRUE
         LEFT JOIN LATERAL (
           SELECT a2.doctor_name FROM appointments a2
            WHERE a2.patient_id = x.patient_id AND a2.appointment_date = $1::date
            ORDER BY (LOWER(COALESCE(a2.status, '')) = 'cancelled'), a2.created_at DESC
            LIMIT 1
         ) a ON TRUE
        ${search.length ? `WHERE ${search.join(" AND ")}` : ""}
     ),
     tagged AS (
       SELECT r.*, ${CATEGORY_SQL} AS category FROM r
     )`;
  const wanted = ["ready", "coming", "done"].includes(category) ? category : null;
  const listParams = [...params, limit, offset];
  const [{ rows }, { rows: tally }] = await Promise.all([
    db.query(
      `${base}
       SELECT t.*, COUNT(*) OVER ()::int AS total_rows,
              (SELECT MAX(c.collected_date)::text FROM medicine_collections c
                WHERE c.patient_id = t.patient_id AND c.collected_date < $1::date
                  AND c.status IN ('given', 'partial')) AS last_collected,
              EXISTS (SELECT 1 FROM pharmacy_bills b
                       WHERE ${BILLS_TODAY.replaceAll("r.patient_id", "t.patient_id")}
                         AND b.status = 'draft') AS has_draft,
              EXISTS (SELECT 1 FROM pharmacy_bills b
                       WHERE ${BILLS_TODAY.replaceAll("r.patient_id", "t.patient_id")}
                         AND b.status = 'final') AS has_final,
              (SELECT COALESCE(SUM(${DUE_SQL}), 0)::numeric(12, 2) FROM pharmacy_bills b
                WHERE ${BILLS_TODAY.replaceAll("r.patient_id", "t.patient_id")}) AS due
         FROM tagged t
        ${wanted ? `WHERE t.category = '${wanted}'` : ""}
        ORDER BY ${CATEGORY_ORDER}, t.name, t.patient_id
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    ),
    db.query(`${base} SELECT category, COUNT(*)::int AS n FROM tagged GROUP BY category`, params),
  ]);
  const counts = { ready: 0, coming: 0, done: 0 };
  for (const t of tally) counts[t.category] = t.n;
  return {
    date,
    total: rows[0]?.total_rows ?? 0,
    categories: { ...counts, all: counts.ready + counts.coming + counts.done },
    rows: rows.map(({ total_rows, ...row }) => ({
      ...row,
      status_label: row.current_status
        ? (STATUS_LABEL[row.current_status] ?? row.current_status)
        : "Not on Gini Flow today",
    })),
  };
}

async function loadMedications(db, patientId, date) {
  const { rows } = await db.query(
    `SELECT m.id AS medication_id, m.name, m.pharmacy_match, m.composition, m.dose, m.frequency,
            m.timing, m.when_to_take, m.med_group,
            mc.status AS today_status, mc.reason AS today_reason, mc.qty_note AS today_note,
            last.collected_date AS last_given_on, last.qty_note AS last_given_note
       FROM medications m
       LEFT JOIN medicine_collections mc
         ON mc.medication_id = m.id AND mc.collected_date = $2::date
       LEFT JOIN LATERAL (
         SELECT c.collected_date::text AS collected_date, c.qty_note
           FROM medicine_collections c
          WHERE c.medication_id = m.id AND c.collected_date < $2::date
            AND c.status IN ('given', 'partial')
          ORDER BY c.collected_date DESC LIMIT 1
       ) last ON TRUE
      WHERE m.patient_id = $1 AND m.is_active AND m.visit_status = 'current'
      ORDER BY m.med_group NULLS LAST, m.sort_order, m.name`,
    [patientId, date],
  );
  return rows;
}

async function draftFor(db, patientId, date) {
  const { rows } = await db.query(
    `SELECT b.id FROM pharmacy_bills b
      WHERE b.patient_id = $1 AND b.bill_type = 'invoice' AND b.status = 'draft'
        AND (b.created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
      ORDER BY b.created_at LIMIT 1`,
    [patientId, date],
  );
  return rows[0]?.id ?? null;
}

export async function prescriptionPatient(patientId, { date = today() } = {}, db = pool) {
  const patient = await getBillPatient(patientId, db);
  if (!patient) throw httpError(404, "Patient not found");
  const location = await mainLocationId(db);
  const [medications, draftId, visit, bills, settings, block, doctor] = await Promise.all([
    loadMedications(db, patientId, date),
    draftFor(db, patientId, date),
    db
      .query(
        `SELECT v.id, v.current_status FROM giniflow_visits v
          WHERE v.patient_id = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL
          ORDER BY v.created_at DESC LIMIT 1`,
        [patientId, date],
      )
      .then((r) => r.rows[0] ?? null),
    db
      .query(
        `SELECT b.id, b.bill_no, b.status, b.net_amount, ${DUE_SQL} AS due
           FROM pharmacy_bills b
          WHERE b.patient_id = $1 AND b.bill_type = 'invoice' AND b.status = 'final'
            AND b.bill_date = $2::date
          ORDER BY b.created_at`,
        [patientId, date],
      )
      .then((r) => r.rows),
    getPharmacySettings(db),
    handoverBlockFor(db, patientId, date),
    db
      .query(
        `SELECT a.doctor_name FROM appointments a
          WHERE a.patient_id = $1 AND a.appointment_date = $2::date
          ORDER BY (LOWER(COALESCE(a.status, '')) = 'cancelled'), a.created_at DESC LIMIT 1`,
        [patientId, date],
      )
      .then((r) => r.rows[0]?.doctor_name ?? null),
  ]);
  const byKey = await stockByKey(
    [...new Set(medications.flatMap((m) => medicineKeysOf(m.pharmacy_match, m.name)))],
    location,
    db,
  );
  const matched = medications.map((m) => ({
    m,
    medicine:
      medicineKeysOf(m.pharmacy_match, m.name)
        .map((k) => byKey.get(k))
        .find(Boolean) ?? null,
  }));
  const ids = [...new Set(matched.filter((x) => x.medicine).map((x) => x.medicine.id))];
  const [batches, onBill, outcomes, lastVisit] = await Promise.all([
    ids.length ? batchesAt(db, location, ids) : [],
    draftId
      ? db
          .query(`SELECT DISTINCT medicine_id FROM pharmacy_bill_lines WHERE bill_id = $1`, [
            draftId,
          ])
          .then((r) => new Set(r.rows.map((x) => x.medicine_id)))
      : new Set(),
    draftId
      ? db
          .query(
            `SELECT o.medication_id, o.outcome, o.reason, o.note, o.medicine_id
               FROM pharmacy_bill_med_outcomes o WHERE o.bill_id = $1`,
            [draftId],
          )
          .then((r) => r.rows)
      : [],
    db
      .query(
        `SELECT c.collected_date::text AS date,
                COUNT(*) FILTER (WHERE c.status IN ('given', 'partial'))::int AS given,
                COUNT(*)::int AS marked
           FROM medicine_collections c
          WHERE c.patient_id = $1
            AND c.collected_date = (SELECT MAX(c2.collected_date) FROM medicine_collections c2
                                     WHERE c2.patient_id = $1 AND c2.collected_date < $2::date
                                       AND c2.status IN ('given', 'partial'))
          GROUP BY c.collected_date`,
        [patientId, date],
      )
      .then((r) => r.rows[0] ?? null),
  ]);
  return {
    date,
    today: today(),
    patient,
    visit: visit && {
      ...visit,
      status_label: STATUS_LABEL[visit.current_status] ?? visit.current_status,
    },
    doctor_name: doctor,
    marking_blocked: block,
    near_expiry_warn_days: settings.near_expiry_warn_days,
    draft_bill_id: draftId,
    bills,
    last_collection: lastVisit,
    outcomes,
    items: matched.map(({ m, medicine }) => ({
      medication_id: m.medication_id,
      medicine_name: m.name,
      composition: m.composition,
      dose: m.dose,
      frequency: m.frequency,
      timing: m.timing,
      today_status: m.today_status,
      today_note: m.today_note,
      last_given_on: m.last_given_on,
      last_given_note: m.last_given_note,
      medicine: medicine && {
        id: medicine.id,
        code: medicine.code,
        name: medicine.name,
        pack_size: medicine.pack_size,
        pack_label: medicine.pack_label,
        unit_label: medicine.unit_label,
        allow_loose_sale: medicine.allow_loose_sale,
        sellable_units: medicine.sellable_units,
      },
      suggested_units: null,
      on_bill: Boolean(medicine && onBill.has(medicine.id)),
      batches: medicine ? batches.filter((b) => b.medicine_id === medicine.id) : [],
    })),
  };
}

export async function saveOutcomes(patientId, { bill_id: billId, outcomes }, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const { rows: bills } = await client.query(
      `SELECT id FROM pharmacy_bills
        WHERE id = $1 AND patient_id = $2 AND status = 'draft' AND bill_type = 'invoice'
        FOR UPDATE`,
      [billId, patientId],
    );
    if (!bills.length) throw httpError(409, "This bill is no longer a draft. Reload the page");
    const ids = [...new Set(outcomes.map((o) => o.medication_id))];
    const { rows: known } = await client.query(
      `SELECT id FROM medications WHERE patient_id = $1 AND is_active AND id = ANY($2::int[])`,
      [patientId, ids],
    );
    if (known.length !== ids.length) {
      throw httpError(400, "A medicine on this list is not on the patient's prescription");
    }
    for (const o of outcomes) {
      if (o.outcome === "pending") {
        await client.query(
          `DELETE FROM pharmacy_bill_med_outcomes WHERE bill_id = $1 AND medication_id = $2`,
          [billId, o.medication_id],
        );
        continue;
      }
      await client.query(
        `INSERT INTO pharmacy_bill_med_outcomes
           (bill_id, medication_id, outcome, medicine_id, reason, note, decided_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (bill_id, medication_id) DO UPDATE
           SET outcome = EXCLUDED.outcome, medicine_id = EXCLUDED.medicine_id,
               reason = EXCLUDED.reason, note = EXCLUDED.note,
               decided_by = EXCLUDED.decided_by, decided_at = NOW()`,
        [
          billId,
          o.medication_id,
          o.outcome,
          o.medicine_id ?? null,
          o.outcome === "requested" ? (o.reason ?? RX_REQUESTED_REASON) : (o.reason ?? null),
          o.outcome === "not_given" ? (o.note ?? null) : null,
          ctx.actorId ?? null,
        ],
      );
    }
    await writeAudit(client, {
      entity: ENTITY,
      entityId: billId,
      action: "update",
      after: {
        source: "prescription",
        outcomes: outcomes.map((o) => ({ medication_id: o.medication_id, outcome: o.outcome })),
      },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    const { rows } = await client.query(
      `SELECT medication_id, outcome, reason, note, medicine_id FROM pharmacy_bill_med_outcomes
        WHERE bill_id = $1`,
      [billId],
    );
    return { bill_id: billId, outcomes: rows };
  }, db);
}

export async function requestFromPrescription(patientId, { medication_id }, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT m.name AS medicine_name, p.name AS patient_name,
              (SELECT v.id FROM giniflow_visits v
                WHERE v.patient_id = p.id AND v.visit_date = $3::date
                  AND v.merged_into_visit_id IS NULL
                ORDER BY v.created_at DESC LIMIT 1) AS visit_id
         FROM medications m JOIN patients p ON p.id = m.patient_id
        WHERE m.id = $1 AND m.patient_id = $2`,
      [medication_id, patientId, today()],
    );
    if (!rows.length) throw httpError(404, "That medicine is not on the patient's prescription");
    const { medicine_name: name, patient_name: patientName, visit_id: visitId } = rows[0];
    const request = await requestMedicine(
      { medicineName: name, visitId },
      ctx.actorId ?? null,
      client,
    );
    const { rows: waiting } = await client.query(
      `SELECT count(DISTINCT COALESCE(r.patient_id::text, r.id::text))::int AS n
         FROM pharmacy_medicine_requests r
        WHERE r.medicine_key = $1 AND r.requested_at > NOW() - INTERVAL '30 days'`,
      [request.medicineKey],
    );
    const count = Math.max(waiting[0].n, 1);
    await raiseNotification(client, {
      kind: "medicine_request",
      severity: "warning",
      role: ROLES.PHARMACY_ADMIN,
      title: `Medicine requested: ${request.medicineName}`,
      body:
        count > 1
          ? `${count} patients are waiting for it, latest ${patientName}.`
          : `${patientName} will collect it when it is in stock.`,
      link: "/pharmacy/needed",
      entityType: "pharmacy_medicine_requests",
      entityId: request.medicineKey,
      dedupeKey: `pharmacy:needed:${request.medicineKey}`,
    });
    await writeAudit(client, {
      entity: "pharmacy_medicine_requests",
      entityId: request.medicineKey,
      action: "create",
      after: { patient_id: patientId, medicine_name: request.medicineName },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return { ...request, waiting: count };
  }, db);
}
