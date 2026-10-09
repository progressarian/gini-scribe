import pool from "../../config/db.js";
import { billingVisitType } from "../../../shared/billingVisitType.js";
import { paise } from "../../../shared/labPayment.js";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions.js";
import { writeAudit } from "./audit.js";
import { addLineIn, holdConsultation, openDraftIn, removeLine } from "./bills.js";
import { creditNoteIn } from "./creditNotes.js";
import { requestRefund } from "./deposits.js";
import { applyDepositIn, moneyOn, restoreDepositLegs } from "./payments.js";
import { PAYMENT_MODES } from "./cashShifts.js";
import { priceBill } from "./priceBill.js";
import { auditFields } from "./common.js";
import { httpError, inTransaction } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX = 300;
export const LEFTOVER = ["deposit", "refund"];

const rupees = (amount) => (amount / 100).toFixed(2);
const money = (amount) => `₹${(amount / 100).toLocaleString("en-IN")}`;

function cleanUuid(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, `Choose a valid ${label}`);
  return text.toLowerCase();
}

function cleanNote(value, message, required) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (required) throw httpError(400, message);
    return null;
  }
  if (text.length > NOTE_MAX)
    throw httpError(400, `${message} — keep it under ${NOTE_MAX} letters`);
  return text;
}

const CHANGE_COLUMNS = `c.id, c.visit_id, c.patient_id, c.from_doctor_id, c.to_doctor_id, c.status,
  c.reassigned_by, c.reassigned_at, c.decided_by, c.decided_at, c.note, c.credit_note_id,
  c.new_bill_id, c.charged, c.new_fee, c.kept_in_deposit, c.refund_request_id`;

async function visitFacts(db, visitId) {
  const { rows } = await db.query(
    `SELECT v.id, v.patient_id, v.appointment_id, v.visit_date::text AS visit_date,
            a.visit_type,
            CASE WHEN vt.id IS NULL THEN NULL
                 WHEN vt.for_followup THEN 'Follow Up' ELSE 'New' END AS journey_visit_type
       FROM giniflow_visits v
       LEFT JOIN appointments a ON a.id = v.appointment_id
       LEFT JOIN flow_visit_types vt ON vt.id = v.visit_type_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) throw httpError(404, "That visit no longer exists");
  return rows[0];
}

async function doctorOf(db, doctorId) {
  if (!doctorId) return null;
  const { rows } = await db.query(
    `SELECT id, name, COALESCE(short_name, name) AS short_name FROM doctors WHERE id = $1`,
    [doctorId],
  );
  return rows[0] ?? null;
}

const CONSULT_LINES_SQL = `
  SELECT l.id, l.bill_id, b.status AS bill_status, b.bill_no, b.scheme_code,
         COALESCE(l.doctor_id, i.doctor_id) AS doctor_id,
         l.patient_payable, i.visit_type,
         COALESCE((SELECT SUM(x.patient_payable) FROM bill_lines x WHERE x.credited_line_id = l.id), 0)
           AS credited
    FROM bill_lines l
    JOIN bills b ON b.id = l.bill_id
    JOIN service_items i ON i.id = l.service_item_id
   WHERE l.visit_id = $1 AND l.is_live AND i.kind = 'consultation'
     AND b.bill_type = 'invoice' AND b.status <> 'cancelled'
     AND COALESCE(l.doctor_id, i.doctor_id, 0) <> $2
   ORDER BY b.created_at, l.line_no`;

async function consultLines(db, visitId, toDoctorId) {
  const { rows } = await db.query(CONSULT_LINES_SQL, [visitId, toDoctorId]);
  return rows.map((row) => ({
    ...row,
    left: paise(row.patient_payable) - paise(row.credited),
  }));
}

const visitTypeOf = (visit, lines) =>
  (visit.appointment_id ? billingVisitType(visit.visit_type) : visit.journey_visit_type) ??
  lines.find((line) => line.visit_type)?.visit_type ??
  null;

async function consultItemFor(db, doctorId, visitType) {
  if (!visitType) return null;
  const { rows } = await db.query(
    `SELECT id, name, doctor_id FROM service_items
      WHERE kind = 'consultation' AND is_active AND visit_type = $1
        AND (doctor_id = $2 OR doctor_id IS NULL)
      ORDER BY doctor_id IS NULL, id
      LIMIT 1`,
    [visitType, doctorId],
  );
  return rows[0] ?? null;
}

async function priceFor(db, visit, item, doctorId, scheme, role) {
  try {
    const priced = await priceBill(
      {
        patientId: visit.patient_id,
        ...(visit.appointment_id ? { appointmentId: visit.appointment_id } : {}),
        ...(scheme ? { category: scheme } : {}),
        date: visit.visit_date,
        role,
        lines: [{ item: item.id, quantity: 1, doctorId }],
      },
      db,
    );
    const line = priced.lines[0];
    return line.price_missing ? null : line.patient_payable;
  } catch (error) {
    if (!error.status) throw error;
    return null;
  }
}

export async function consultFeeDifference(visitId, toDoctorId, ctx, db = pool) {
  const visit = await visitFacts(db, cleanUuid(visitId, "visit"));
  const to = await doctorOf(db, toDoctorId);
  if (!to) throw httpError(404, "That consultant no longer exists");
  const lines = await consultLines(db, visit.id, to.id);
  const finals = lines.filter((line) => line.bill_status === "final");
  const drafts = lines.filter((line) => line.bill_status === "draft");
  const visitType = visitTypeOf(visit, lines);
  const item = await consultItemFor(db, to.id, visitType);
  const scheme = lines[0]?.scheme_code ?? null;
  const newFee = item ? await priceFor(db, visit, item, to.id, scheme, ctx?.role) : null;
  const charged = lines.reduce((sum, line) => sum + line.left, 0);
  const from = await doctorOf(db, lines[0]?.doctor_id);
  return {
    visit_id: visit.id,
    from: from && { id: from.id, name: from.short_name },
    to: { id: to.id, name: to.short_name },
    bill_state: finals.length ? "final" : drafts.length ? "draft" : "none",
    charged,
    new_fee: newFee,
    difference: newFee === null ? null : newFee - charged,
    fee_missing: Boolean(visitType) && newFee === null,
    item: item && { id: item.id, name: item.name },
  };
}

async function swapDraftLines(client, visit, lines, to, ctx) {
  const item = await consultItemFor(client, to.id, visitTypeOf(visit, lines));
  const reason = `Consultant changed to ${to.short_name}`;
  for (const line of lines) {
    await removeLine(line.bill_id, line.id, { reason }, ctx, client);
  }
  if (!item) return { swapped: lines.length, added: null };
  const bill = await openDraftIn(client, visit.id, ctx);
  await addLineIn(client, bill, { item_id: item.id, source: "visit", doctor_id: to.id }, ctx);
  return { swapped: lines.length, added: item.name };
}

async function pendingChange(client, visitId) {
  const { rows } = await client.query(
    `SELECT ${CHANGE_COLUMNS} FROM consultant_changes c
      WHERE c.visit_id = $1 AND c.status = 'pending' FOR UPDATE`,
    [visitId],
  );
  return rows[0] ?? null;
}

async function auditChange(client, id, action, before, after, ctx) {
  await writeAudit(client, {
    entity: "consultant_changes",
    entityId: id,
    action,
    before,
    after,
    ...auditFields(ctx),
  });
}

async function raiseChange(client, visit, fromDoctorId, to, ctx) {
  const open = await pendingChange(client, visit.id);
  if (open && open.from_doctor_id === to.id) {
    const { rows } = await client.query(
      `UPDATE consultant_changes
          SET status = 'void', decided_by = $2, decided_at = NOW(), note = $3
        WHERE id = $1 RETURNING ${CHANGE_COLUMNS.replaceAll("c.", "")}`,
      [open.id, ctx?.actorId ?? null, `Changed back to ${to.short_name}`],
    );
    await auditChange(client, open.id, "cancel", open, rows[0], ctx);
    return null;
  }
  if (open) {
    const { rows } = await client.query(
      `UPDATE consultant_changes
          SET to_doctor_id = $2, reassigned_by = $3, reassigned_at = NOW()
        WHERE id = $1 RETURNING ${CHANGE_COLUMNS.replaceAll("c.", "")}`,
      [open.id, to.id, ctx?.actorId ?? null],
    );
    await auditChange(client, open.id, "update", open, rows[0], ctx);
    return rows[0];
  }
  const { rows } = await client.query(
    `INSERT INTO consultant_changes (visit_id, patient_id, from_doctor_id, to_doctor_id, reassigned_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${CHANGE_COLUMNS.replaceAll("c.", "")}`,
    [visit.id, visit.patient_id, fromDoctorId, to.id, ctx?.actorId ?? null],
  );
  await auditChange(client, rows[0].id, "create", null, rows[0], ctx);
  return rows[0];
}

export async function consultantChangedIn(client, visitId, toDoctorId, ctx) {
  await holdConsultation(client, visitId);
  await client.query(`SELECT id FROM bills WHERE visit_id = $1 ORDER BY id FOR UPDATE`, [visitId]);
  const visit = await visitFacts(client, visitId);
  const to = await doctorOf(client, toDoctorId);
  const lines = await consultLines(client, visitId, to.id);
  const drafts = lines.filter((line) => line.bill_status === "draft");
  const finals = lines.filter((line) => line.bill_status === "final");
  const swap = drafts.length ? await swapDraftLines(client, visit, drafts, to, ctx) : null;
  let change = null;
  if (finals.length) {
    const { difference } = await consultFeeDifference(visitId, to.id, ctx, client);
    if (difference !== 0) change = await raiseChange(client, visit, finals[0].doctor_id, to, ctx);
  } else {
    const open = await pendingChange(client, visitId);
    if (open) await raiseChange(client, visit, open.from_doctor_id, to, ctx);
  }
  return { draft: swap, change_id: change?.id ?? null };
}

const shapeChange = (row, preview = null) =>
  row && {
    id: row.id,
    visit_id: row.visit_id,
    patient_id: row.patient_id,
    status: row.status,
    from: { id: row.from_doctor_id, name: row.from_name ?? null },
    to: { id: row.to_doctor_id, name: row.to_name ?? null },
    reassigned_by: row.reassigned_by
      ? { id: row.reassigned_by, name: row.reassigned_by_name }
      : null,
    reassigned_at: row.reassigned_at,
    decided_by: row.decided_by ? { id: row.decided_by, name: row.decided_by_name } : null,
    decided_at: row.decided_at,
    note: row.note,
    credit_note_id: row.credit_note_id,
    new_bill_id: row.new_bill_id,
    charged: row.charged === null ? null : paise(row.charged),
    new_fee: row.new_fee === null ? null : paise(row.new_fee),
    kept_in_deposit: row.kept_in_deposit === null ? null : paise(row.kept_in_deposit),
    refund_request_id: row.refund_request_id,
    preview,
  };

const READ_SQL = `
  SELECT ${CHANGE_COLUMNS},
         COALESCE(f.short_name, f.name) AS from_name, COALESCE(t.short_name, t.name) AS to_name,
         COALESCE(rb.short_name, rb.name) AS reassigned_by_name,
         COALESCE(db.short_name, db.name) AS decided_by_name
    FROM consultant_changes c
    JOIN doctors f ON f.id = c.from_doctor_id
    JOIN doctors t ON t.id = c.to_doctor_id
    LEFT JOIN doctors rb ON rb.id = c.reassigned_by
    LEFT JOIN doctors db ON db.id = c.decided_by`;

async function preview(db, change, ctx) {
  const visit = await visitFacts(db, change.visit_id);
  const diff = await consultFeeDifference(change.visit_id, change.to_doctor_id, ctx, db);
  const finals = (await consultLines(db, change.visit_id, change.to_doctor_id)).filter(
    (line) => line.bill_status === "final",
  );
  let refundable = 0;
  for (const billId of new Set(finals.map((line) => line.bill_id))) {
    const held = await moneyOn(db, billId);
    const credit = finals
      .filter((line) => line.bill_id === billId)
      .reduce((sum, line) => sum + line.left, 0);
    const owedAfter = Math.max(0, held.payable - held.credited - credit);
    refundable += Math.min(credit, Math.max(0, held.held - owedAfter));
  }
  const toDeposit = refundable;
  const applied = diff.new_fee === null ? 0 : Math.min(toDeposit, diff.new_fee);
  return {
    ...diff,
    visit_date: visit.visit_date,
    bills: [...new Set(finals.map((line) => line.bill_no))],
    to_deposit: toDeposit,
    applied_from_deposit: applied,
    to_collect: diff.new_fee === null ? null : diff.new_fee - applied,
    left_in_deposit: toDeposit - applied,
  };
}

export async function consultantChangeForVisit(visitId, ctx, db = pool) {
  const { rows } = await db.query(`${READ_SQL} WHERE c.visit_id = $1 AND c.status = 'pending'`, [
    cleanUuid(visitId, "visit"),
  ]);
  if (!rows.length) return null;
  return shapeChange(rows[0], await preview(db, rows[0], ctx));
}

export async function pendingConsultantChanges(ctx, db = pool) {
  const { rows } = await db.query(
    `SELECT c.*, p.name AS patient_name, p.file_no AS patient_file_no
       FROM (${READ_SQL} WHERE c.status = 'pending') c
       JOIN patients p ON p.id = c.patient_id
      ORDER BY c.reassigned_at DESC
      LIMIT 50`,
  );
  const changes = [];
  for (const row of rows) {
    const shown = await preview(db, row, ctx).catch((error) => {
      if (!error.status) throw error;
      return null;
    });
    changes.push({
      ...shapeChange(row, shown),
      patient: { id: row.patient_id, name: row.patient_name, file_no: row.patient_file_no },
    });
  }
  return { changes };
}

async function lockChange(client, changeId) {
  const { rows } = await client.query(
    `SELECT ${CHANGE_COLUMNS} FROM consultant_changes c WHERE c.id = $1 FOR UPDATE`,
    [cleanUuid(changeId, "consultant change")],
  );
  if (!rows.length) throw httpError(404, "That consultant change no longer exists");
  if (rows[0].status !== "pending") {
    throw httpError(409, "That consultant change has already been settled — open the bill again");
  }
  return rows[0];
}

function cleanLeftover(input) {
  const leftover = input?.leftover ?? "deposit";
  if (!LEFTOVER.includes(leftover)) {
    throw httpError(400, "Choose whether the money left over stays in the deposit or is refunded");
  }
  if (leftover === "deposit") return { leftover, mode: null };
  const mode = typeof input?.refund_mode === "string" ? input.refund_mode.trim().toLowerCase() : "";
  if (!PAYMENT_MODES.includes(mode)) {
    throw httpError(400, "Choose how the money goes back: cash, card or UPI");
  }
  return { leftover, mode };
}

async function readChange(db, id) {
  const { rows } = await db.query(`${READ_SQL} WHERE c.id = $1`, [id]);
  return shapeChange(rows[0]);
}

export async function confirmConsultantChange(changeId, input, ctx, db = pool) {
  if (!ctx?.actorId) throw httpError(401, "Sign in again to confirm the consultant change");
  const { leftover, mode } = cleanLeftover(input);
  const note = cleanNote(input?.note, "The note", false);
  const done = await inTransaction(async (client) => {
    const change = await lockChange(client, changeId);
    if (change.reassigned_by === ctx.actorId && !hasCapability(ctx.role, CAPABILITIES.ADMIN)) {
      throw httpError(
        409,
        "Someone other than the person who changed the consultant must confirm the fee change",
      );
    }
    await holdConsultation(client, change.visit_id);
    await client.query(`SELECT id FROM bills WHERE visit_id = $1 ORDER BY id FOR UPDATE`, [
      change.visit_id,
    ]);
    const visit = await visitFacts(client, change.visit_id);
    const to = await doctorOf(client, change.to_doctor_id);
    const lines = await consultLines(client, change.visit_id, to.id);
    const item = await consultItemFor(client, to.id, visitTypeOf(visit, lines));
    if (!item) {
      throw httpError(
        409,
        `${to.short_name} has no consultation fee for this visit type — add it in Settings → Consultant Fees first`,
      );
    }
    const finals = lines.filter((line) => line.bill_status === "final");
    const charged = finals.reduce((sum, line) => sum + line.left, 0);
    let creditNoteId = null;
    let toDeposit = 0;
    for (const billId of new Set(finals.map((line) => line.bill_id))) {
      const made = await creditNoteIn(
        client,
        {
          billId,
          lines: finals
            .filter((line) => line.bill_id === billId)
            .map((line) => ({ line_id: line.id, quantity: null })),
          adminReason: `Consultant changed to ${to.short_name}`,
        },
        ctx,
      );
      await client.query(`UPDATE bills SET credit_kind = 'consultant_change' WHERE id = $1`, [
        made.credit_note_id,
      ]);
      creditNoteId ??= made.credit_note_id;
      toDeposit += await restoreDepositLegs(client, made.credit_note_id, ctx);
    }
    const draft = await openDraftIn(client, change.visit_id, ctx);
    const added = await addLineIn(
      client,
      draft,
      { item_id: item.id, source: "visit", doctor_id: to.id },
      ctx,
    );
    const { rows: newLine } = await client.query(
      `SELECT patient_payable FROM bill_lines WHERE id = $1`,
      [added.line_id],
    );
    const newFee = paise(newLine[0].patient_payable);
    let applied = Math.min(toDeposit, newFee);
    if (applied) {
      try {
        await applyDepositIn(client, draft.id, applied, ctx);
      } catch (error) {
        if (!error.status || error.status >= 500) throw error;
        applied = 0;
      }
    }
    const left = toDeposit - applied;
    let refundRequestId = null;
    if (left > 0 && leftover === "refund") {
      const asked = await requestRefund(
        visit.patient_id,
        {
          amount: rupees(left),
          mode,
          reason: `Consultant changed to ${to.short_name} — ${money(left)} left over`,
        },
        ctx,
        client,
      );
      refundRequestId = asked.request_id;
    }
    const { rows } = await client.query(
      `UPDATE consultant_changes
          SET status = 'done', decided_by = $2, decided_at = NOW(), note = $3,
              credit_note_id = $4, new_bill_id = $5, charged = $6, new_fee = $7,
              kept_in_deposit = $8, refund_request_id = $9
        WHERE id = $1 RETURNING ${CHANGE_COLUMNS.replaceAll("c.", "")}`,
      [
        change.id,
        ctx.actorId,
        note,
        creditNoteId,
        draft.id,
        rupees(charged),
        rupees(newFee),
        rupees(refundRequestId ? 0 : left),
        refundRequestId,
      ],
    );
    await auditChange(client, change.id, "approve", change, rows[0], ctx);
    return {
      change_id: change.id,
      bill_id: draft.id,
      charged,
      new_fee: newFee,
      to_deposit: toDeposit,
      applied_from_deposit: applied,
      left_in_deposit: refundRequestId ? 0 : left,
      refund_requested: refundRequestId ? left : 0,
      refund_request_id: refundRequestId,
    };
  }, db);
  return { ...done, change: await readChange(db, done.change_id) };
}

export async function dismissConsultantChange(changeId, input, ctx, db = pool) {
  if (!ctx?.actorId) throw httpError(401, "Sign in again to dismiss the consultant change");
  const note = cleanNote(input?.note, "Say why the bill stays as it is", true);
  return inTransaction(async (client) => {
    const change = await lockChange(client, changeId);
    const { rows } = await client.query(
      `UPDATE consultant_changes
          SET status = 'dismissed', decided_by = $2, decided_at = NOW(), note = $3
        WHERE id = $1 RETURNING ${CHANGE_COLUMNS.replaceAll("c.", "")}`,
      [change.id, ctx.actorId, note],
    );
    await auditChange(client, change.id, "reject", change, rows[0], ctx);
    return readChange(client, change.id);
  }, db);
}
