import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { DEPOSIT_MAX, DEPOSIT_MODE } from "../../../shared/billingVocab.js";
import { writeAudit } from "./audit.js";
import { nextNumber, seriesFor } from "./billNumber.js";
import { cashOutShift, DRAWER_MODE, openShiftIdFor, PAYMENT_MODES } from "./cashShifts.js";
import { SUPABASE_SERVICE_KEY, SUPABASE_URL, STORAGE_BUCKET } from "../../config/storage.js";
import { auditFields, cleanMoney, INT_MAX, readNumber } from "./common.js";
import { httpError, inTransaction } from "./transaction.js";

export const ENTRIES_SHOWN = 50;
const REFERENCE_MAX = 60;
const NOTE_MAX = 300;
const MODE_LABEL = { cash: "cash", card: "card", upi: "UPI" };
const TEXT_MAX = 300;
const IPD_NUMBER_MAX = 40;
export const CONSENT_DOC_TYPE = "deposit_consent";
export const CONSENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const CONSENT_MAX_BYTES = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanUuid(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, `Choose a valid ${label}`);
  return text.toLowerCase();
}

function cleanText(value, message, max = TEXT_MAX) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw httpError(400, message);
  if (text.length > max) throw httpError(400, `${message} — keep it under ${max} letters`);
  return text;
}

function cleanAmount(value, label) {
  const amount = paise(cleanMoney(value, label));
  if (amount <= 0) throw httpError(400, `${label} must be more than zero`);
  return amount;
}
const rupees = (amount) => (amount / 100).toFixed(2);

function cleanPatientId(value) {
  const id = readNumber(value, "Choose a valid patient");
  if (id === undefined || !Number.isInteger(id) || id <= 0 || id > INT_MAX) {
    throw httpError(400, "Choose a valid patient");
  }
  return id;
}

function cleanReceipt(input) {
  const mode = typeof input?.mode === "string" ? input.mode.trim().toLowerCase() : "";
  if (!PAYMENT_MODES.includes(mode)) {
    throw httpError(400, `A deposit is taken as one of: ${PAYMENT_MODES.join(", ")}`);
  }
  const amount = paise(cleanMoney(input?.amount, "The deposit amount"));
  if (amount <= 0) throw httpError(400, "The deposit must be more than zero");
  if (amount > DEPOSIT_MAX * 100) {
    throw httpError(400, `One deposit can be at most ₹${DEPOSIT_MAX.toLocaleString("en-IN")}`);
  }
  const reference = typeof input?.reference === "string" ? input.reference.trim() : "";
  if (mode !== DRAWER_MODE && !reference) {
    throw httpError(400, `A ${MODE_LABEL[mode]} deposit needs its reference number`);
  }
  if (reference.length > REFERENCE_MAX) {
    throw httpError(400, `The reference is too long — keep it under ${REFERENCE_MAX} letters`);
  }
  const note = typeof input?.note === "string" ? input.note.trim() : "";
  if (note.length > NOTE_MAX) {
    throw httpError(400, `The note is too long — keep it under ${NOTE_MAX} letters`);
  }
  return { mode, amount, reference: reference || null, note: note || null };
}

async function patientExists(client, patientId) {
  const { rows } = await client.query(`SELECT id FROM patients WHERE id = $1`, [patientId]);
  if (!rows.length) throw httpError(404, "That patient no longer exists");
}

export async function lockAccount(client, patientId) {
  await client.query(
    `INSERT INTO deposit_accounts (patient_id) VALUES ($1) ON CONFLICT (patient_id) DO NOTHING`,
    [patientId],
  );
  const { rows } = await client.query(
    `SELECT patient_id, balance FROM deposit_accounts WHERE patient_id = $1 FOR UPDATE`,
    [patientId],
  );
  return { patientId, balance: paise(rows[0].balance) };
}

async function moveBalance(client, patientId, delta) {
  const { rows } = await client.query(
    `UPDATE deposit_accounts SET balance = balance + $2::numeric, updated_at = NOW()
      WHERE patient_id = $1 RETURNING balance`,
    [patientId, rupees(delta)],
  );
  return paise(rows[0].balance);
}

async function heldOn(client, patientId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS held FROM billing_requests
      WHERE kind = 'deposit_refund' AND patient_id = $1 AND status IN ('pending', 'approved')`,
    [patientId],
  );
  return paise(rows[0].held);
}

async function lockAvailable(client, patientId) {
  const account = await lockAccount(client, patientId);
  const held = await heldOn(client, patientId);
  return { ...account, held, available: Math.max(0, account.balance - held) };
}

function refuseShort(account, wanted, doing) {
  if (wanted <= account.available) return;
  const heldText = account.held ? ` (₹${rupees(account.held)} is held for a refund)` : "";
  throw httpError(
    409,
    account.available
      ? `Only ₹${rupees(account.available)} of this patient's deposit is available${heldText}, so ₹${rupees(wanted)} can't be ${doing}`
      : `This patient has no deposit available${heldText}`,
    { deposit_available: account.available },
  );
}

async function nextSlip(client) {
  const { rows } = await client.query(
    `SELECT 'DEP-' || lpad(nextval('deposit_slip_seq')::text, 6, '0') AS slip`,
  );
  return rows[0].slip;
}

async function addEntry(client, entry, ctx) {
  const balanceAfter = await moveBalance(client, entry.patientId, entry.amount);
  const { rows } = await client.query(
    `INSERT INTO deposit_entries (patient_id, kind, amount, balance_after, payment_id, bill_id,
                                  note, created_by, slip_no, counter_entry_id, other_patient_id,
                                  relationship, consent_document_id, ipd_number, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id, created_at`,
    [
      entry.patientId,
      entry.kind,
      rupees(entry.amount),
      rupees(balanceAfter),
      entry.paymentId ?? null,
      entry.billId ?? null,
      entry.note ?? null,
      ctx?.actorId ?? null,
      entry.slipNo ?? null,
      entry.counterEntryId ?? null,
      entry.otherPatientId ?? null,
      entry.relationship ?? null,
      entry.consentDocumentId ?? null,
      entry.ipdNumber ?? null,
      entry.requestId ?? null,
    ],
  );
  await writeAudit(client, {
    entity: "deposit_entries",
    entityId: rows[0].id,
    action: "create",
    after: {
      patient_id: entry.patientId,
      kind: entry.kind,
      amount: entry.amount,
      balance_after: balanceAfter,
      payment_id: entry.paymentId ?? null,
      bill_id: entry.billId ?? null,
      bill_no: entry.billNo ?? null,
      slip_no: entry.slipNo ?? null,
      other_patient_id: entry.otherPatientId ?? null,
      ipd_number: entry.ipdNumber ?? null,
      request_id: entry.requestId ?? null,
    },
    ...auditFields(ctx),
  });
  return { id: rows[0].id, balanceAfter, createdAt: rows[0].created_at };
}

export async function receiveDeposit(patientIdValue, input, ctx, db = pool) {
  const patientId = cleanPatientId(patientIdValue);
  const wanted = cleanReceipt(input);
  if (!ctx?.actorId) throw httpError(401, "Sign in again to take a deposit");
  return inTransaction(async (client) => {
    await patientExists(client, patientId);
    const shiftId = await openShiftIdFor(client, ctx.actorId);
    if (wanted.mode === DRAWER_MODE && !shiftId) {
      throw httpError(
        409,
        "Open your shift first, so this cash is in a drawer that can be counted at the end of it",
      );
    }
    await lockAccount(client, patientId);
    const receipt = await nextNumber(client, seriesFor("receipt"), null, ctx);
    const { rows } = await client.query(
      `INSERT INTO payments (deposit_patient_id, mode, amount, reference, receipt_no, shift_id,
                             received_by, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)
       RETURNING id, receipt_no, received_at`,
      [
        patientId,
        wanted.mode,
        rupees(wanted.amount),
        wanted.reference,
        receipt.number,
        shiftId,
        ctx.actorId,
      ],
    );
    await writeAudit(client, {
      entity: "payments",
      entityId: rows[0].id,
      action: "create",
      after: {
        deposit_patient_id: patientId,
        mode: wanted.mode,
        amount: wanted.amount,
        receipt_no: rows[0].receipt_no,
      },
      ...auditFields(ctx),
    });
    const entry = await addEntry(
      client,
      {
        patientId,
        kind: "received",
        amount: wanted.amount,
        paymentId: rows[0].id,
        note: wanted.note,
      },
      ctx,
    );
    return {
      payment_id: rows[0].id,
      receipt_no: rows[0].receipt_no,
      entry_id: entry.id,
      amount: wanted.amount,
      balance: entry.balanceAfter,
    };
  }, db);
}

export async function holdFor(client, patientId, wanted) {
  if (!wanted) return null;
  const account = await lockAvailable(client, patientId);
  refuseShort(account, wanted, "taken from it");
  return account;
}

export async function recordApplied(client, { bill, payment }, ctx) {
  return addEntry(
    client,
    {
      patientId: bill.patient_id,
      kind: "applied",
      amount: -payment.amount,
      paymentId: payment.id,
      billId: bill.id,
      billNo: bill.bill_no,
    },
    ctx,
  );
}

export async function restoreToDeposit(client, { note, patientId, amount }, ctx) {
  if (!amount) return null;
  await lockAccount(client, patientId);
  const { rows } = await client.query(
    `INSERT INTO payments (bill_id, direction, mode, amount, received_by, created_by, updated_by)
     VALUES ($1, 'out', '${DEPOSIT_MODE}', $2, $3, $3, $3)
     RETURNING id`,
    [note.id, rupees(amount), ctx?.actorId ?? null],
  );
  await client.query(
    `UPDATE bills
        SET paid_amount = (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE bill_id = bills.id),
            version = version + 1, updated_at = NOW(), updated_by = $2
      WHERE id = $1`,
    [note.id, ctx?.actorId ?? null],
  );
  await writeAudit(client, {
    entity: "payments",
    entityId: rows[0].id,
    action: "create",
    after: {
      bill_id: note.id,
      credit_note_no: note.bill_no,
      direction: "out",
      mode: DEPOSIT_MODE,
      amount,
    },
    ...auditFields(ctx),
  });
  return addEntry(
    client,
    {
      patientId,
      kind: "restored",
      amount,
      paymentId: rows[0].id,
      billId: note.id,
      billNo: note.bill_no,
    },
    ctx,
  );
}

const ENTRY_SQL = `
  SELECT e.id, e.kind, e.amount, e.balance_after, e.note, e.created_at, e.payment_id,
         e.bill_id, b.bill_no, b.bill_type, o.bill_no AS original_bill_no,
         p.mode, p.reference, p.receipt_no,
         e.slip_no, e.relationship, e.ipd_number, e.consent_document_id, e.request_id,
         e.other_patient_id, op.name AS other_patient_name, op.file_no AS other_patient_file_no,
         COALESCE(d.short_name, d.name) AS created_by_name
    FROM deposit_entries e
    LEFT JOIN bills b ON b.id = e.bill_id
    LEFT JOIN bills o ON o.id = b.original_bill_id
    LEFT JOIN payments p ON p.id = e.payment_id
    LEFT JOIN patients op ON op.id = e.other_patient_id
    LEFT JOIN doctors d ON d.id = e.created_by
   WHERE e.patient_id = $1
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT $2`;

export const DEPOSIT_TABLES = ["deposit_entries", "deposit_accounts"];

export async function refuseMergeWithDeposit(client, patientId, label = "This patient") {
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM deposit_entries
                     WHERE patient_id = $1 OR other_patient_id = $1) AS has_history,
            (SELECT balance FROM deposit_accounts WHERE patient_id = $1) AS balance`,
    [patientId],
  );
  if (rows[0].has_history) {
    throw new Error(
      `${label} has deposit history (balance ₹${Number(rows[0].balance ?? 0).toFixed(2)}). ` +
        "Move the deposit to the chart being kept with Billing → Deposit → Transfer to another patient, then merge by hand.",
    );
  }
  await client.query(`DELETE FROM deposit_accounts WHERE patient_id = $1`, [patientId]);
}

export async function getDeposit(patientIdValue, db = pool) {
  const patientId = cleanPatientId(patientIdValue);
  const [{ rows: account }, { rows: entries }, { rows: open }, { rows: who }] = await Promise.all([
    db.query(`SELECT balance FROM deposit_accounts WHERE patient_id = $1`, [patientId]),
    db.query(ENTRY_SQL, [patientId, ENTRIES_SHOWN]),
    db.query(
      `SELECT r.id, r.status, r.amount, r.requested_mode, r.approved_mode, r.reason,
              r.requested_at, r.decided_at, COALESCE(d.short_name, d.name) AS requested_by_name
         FROM billing_requests r LEFT JOIN doctors d ON d.id = r.requested_by
        WHERE r.kind = 'deposit_refund' AND r.patient_id = $1
          AND r.status IN ('pending', 'approved')`,
      [patientId],
    ),
    db.query(`SELECT name, COALESCE(file_no, health_id) AS file_no FROM patients WHERE id = $1`, [
      patientId,
    ]),
  ]);
  const balance = account.length ? paise(account[0].balance) : 0;
  const refund = open[0]
    ? {
        id: open[0].id,
        status: open[0].status,
        amount: paise(open[0].amount),
        requested_mode: open[0].requested_mode,
        approved_mode: open[0].approved_mode,
        reason: open[0].reason,
        requested_at: open[0].requested_at,
        requested_by_name: open[0].requested_by_name,
      }
    : null;
  const held = refund?.amount ?? 0;
  return {
    patient_id: patientId,
    patient: who[0] ? { name: who[0].name, file_no: who[0].file_no } : null,
    balance,
    held,
    available: Math.max(0, balance - held),
    open_refund: refund,
    entries: entries.map((row) => ({
      id: row.id,
      kind: row.kind,
      amount: paise(row.amount),
      balance_after: paise(row.balance_after),
      note: row.note,
      created_at: row.created_at,
      created_by_name: row.created_by_name,
      bill_id: row.bill_id,
      bill_no: row.bill_no,
      bill_type: row.bill_type,
      original_bill_no: row.original_bill_no,
      payment_id: row.payment_id,
      mode: row.mode,
      reference: row.reference,
      receipt_no: row.receipt_no,
      slip_no: row.slip_no,
      relationship: row.relationship,
      ipd_number: row.ipd_number,
      consent_document_id: row.consent_document_id,
      other_patient: row.other_patient_id
        ? {
            id: row.other_patient_id,
            name: row.other_patient_name,
            file_no: row.other_patient_file_no,
          }
        : null,
    })),
  };
}

export async function uploadConsent(patientIdValue, input, ctx, db = pool) {
  const patientId = cleanPatientId(patientIdValue);
  const mediaType = typeof input?.mediaType === "string" ? input.mediaType : "";
  if (!CONSENT_TYPES.includes(mediaType)) {
    throw httpError(400, "Upload the signed consent as a photo (JPG, PNG or WebP) or a PDF");
  }
  const buffer = Buffer.from(String(input?.base64 || ""), "base64");
  if (!buffer.length) throw httpError(400, "That file is empty");
  if (buffer.length > CONSENT_MAX_BYTES) {
    throw httpError(413, "The consent file is larger than 5 MB — upload a smaller photo");
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("File storage is not set up, so the consent can't be saved");
  }
  const { rows: patient } = await db.query(`SELECT id FROM patients WHERE id = $1`, [patientId]);
  if (!patient.length) throw httpError(404, "That patient no longer exists");
  const { storeReportObject } = await import("../giniflow/labStation.js");
  const { storagePath, safeName } = await storeReportObject({
    base64: input.base64,
    fileName: input.fileName || "deposit-consent.jpg",
    mediaType,
    patientId,
    folder: "billing/deposit-consents",
  });
  const { rows } = await db.query(
    `INSERT INTO documents (patient_id, doc_type, title, file_name, storage_path, mime_type,
                            doc_date, source, extracted_data)
     VALUES ($1, $2, 'Deposit transfer consent', $3, $4, $5,
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date, 'billing_counter', $6)
     RETURNING id`,
    [
      patientId,
      CONSENT_DOC_TYPE,
      safeName,
      storagePath,
      mediaType,
      JSON.stringify({ uploaded_by: ctx?.actorId ?? null }),
    ],
  );
  return { document_id: rows[0].id, file_name: safeName };
}

export async function readConsent(documentIdValue, db = pool) {
  const id = readNumber(documentIdValue, "Choose a valid consent document");
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Choose a valid consent document");
  const { rows } = await db.query(
    `SELECT storage_path, mime_type, file_name FROM documents WHERE id = $1 AND doc_type = $2`,
    [id, CONSENT_DOC_TYPE],
  );
  if (!rows.length || !rows[0].storage_path) throw httpError(404, "That consent no longer exists");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("File storage is not set up, so the consent can't be opened");
  }
  const resp = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${rows[0].storage_path}`,
    { headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } },
  );
  if (!resp.ok) throw httpError(404, "The stored consent couldn't be read");
  return {
    buffer: Buffer.from(await resp.arrayBuffer()),
    mimeType: rows[0].mime_type,
    fileName: rows[0].file_name,
  };
}

export async function transferToPatient(patientIdValue, input, ctx, db = pool) {
  const fromId = cleanPatientId(patientIdValue);
  const toId = cleanPatientId(input?.to_patient_id);
  if (fromId === toId) throw httpError(400, "Choose another patient to move the deposit to");
  const amount = cleanAmount(input?.amount, "The amount to move");
  const relationship = cleanText(input?.relationship, "Say how the two patients are related", 60);
  const reason = cleanText(input?.reason, "Say why the deposit is being moved");
  const consentId = readNumber(input?.consent_document_id, "Upload the signed consent");
  if (!Number.isInteger(consentId) || consentId <= 0) {
    throw httpError(400, "Upload the depositor's signed consent before moving the deposit");
  }
  if (!ctx?.actorId) throw httpError(401, "Sign in again to move a deposit");
  return inTransaction(async (client) => {
    const { rows: people } = await client.query(
      `SELECT id, name, file_no FROM patients WHERE id = ANY($1::int[])`,
      [[fromId, toId]],
    );
    const from = people.find((row) => row.id === fromId);
    const to = people.find((row) => row.id === toId);
    if (!from || !to) throw httpError(404, "One of the two patients no longer exists");
    const { rows: consent } = await client.query(
      `SELECT id FROM documents WHERE id = $1 AND doc_type = $2 AND patient_id = $3`,
      [consentId, CONSENT_DOC_TYPE, fromId],
    );
    if (!consent.length) {
      throw httpError(
        400,
        `The consent must be ${from.name}'s signed form — upload it again for this patient`,
      );
    }
    const [first, second] = fromId < toId ? [fromId, toId] : [toId, fromId];
    const locked = {
      [first]: await lockAvailable(client, first),
      [second]: await lockAvailable(client, second),
    };
    refuseShort(locked[fromId], amount, "moved");
    const slipNo = await nextSlip(client);
    const out = await addEntry(
      client,
      {
        patientId: fromId,
        kind: "transfer_out",
        amount: -amount,
        slipNo,
        otherPatientId: toId,
        relationship,
        consentDocumentId: consentId,
        note: reason,
      },
      ctx,
    );
    const into = await addEntry(
      client,
      {
        patientId: toId,
        kind: "transfer_in",
        amount,
        slipNo,
        counterEntryId: out.id,
        otherPatientId: fromId,
        relationship,
        note: reason,
      },
      ctx,
    );
    return {
      slip_no: slipNo,
      entry_id: out.id,
      amount,
      from: { id: fromId, name: from.name, balance: out.balanceAfter },
      to: { id: toId, name: to.name, balance: into.balanceAfter },
    };
  }, db);
}

export async function transferToIpd(patientIdValue, input, ctx, db = pool) {
  const patientId = cleanPatientId(patientIdValue);
  const amount = cleanAmount(input?.amount, "The amount to move to IPD");
  const ipdNumber = cleanText(
    input?.ipd_number,
    "Enter the HealthRay IP / admission number",
    IPD_NUMBER_MAX,
  );
  const reason = cleanText(input?.reason, "Say why the deposit is moved to IPD");
  if (!ctx?.actorId) throw httpError(401, "Sign in again to move a deposit");
  return inTransaction(async (client) => {
    await patientExists(client, patientId);
    const account = await lockAvailable(client, patientId);
    refuseShort(account, amount, "moved to IPD");
    const slipNo = await nextSlip(client);
    const entry = await addEntry(
      client,
      { patientId, kind: "to_ipd", amount: -amount, slipNo, ipdNumber, note: reason },
      ctx,
    );
    return { slip_no: slipNo, entry_id: entry.id, amount, balance: entry.balanceAfter };
  }, db);
}

export async function requestRefund(patientIdValue, input, ctx, db = pool) {
  const patientId = cleanPatientId(patientIdValue);
  const amount = cleanAmount(input?.amount, "The amount to pay back");
  const mode = typeof input?.mode === "string" ? input.mode.trim().toLowerCase() : "";
  if (!PAYMENT_MODES.includes(mode)) {
    throw httpError(400, `A deposit is paid back as one of: ${PAYMENT_MODES.join(", ")}`);
  }
  const reason = cleanText(input?.reason, "Say why the deposit is being paid back");
  if (!ctx?.actorId) throw httpError(401, "Sign in again to ask for a refund");
  return inTransaction(async (client) => {
    await patientExists(client, patientId);
    const account = await lockAvailable(client, patientId);
    const { rows: open } = await client.query(
      `SELECT id FROM billing_requests
        WHERE kind = 'deposit_refund' AND patient_id = $1 AND status IN ('pending', 'approved')`,
      [patientId],
    );
    if (open.length) {
      throw httpError(
        409,
        "A refund of this patient's deposit is already waiting — finish that first",
      );
    }
    refuseShort(account, amount, "paid back");
    const { rows } = await client.query(
      `INSERT INTO billing_requests (kind, patient_id, amount, requested_mode, reason, status,
                                     requested_by, created_by, updated_by)
       VALUES ('deposit_refund', $1, $2, $3, $4, 'pending', $5, $5, $5)
       RETURNING id, requested_at`,
      [patientId, rupees(amount), mode, reason, ctx.actorId],
    );
    await writeAudit(client, {
      entity: "billing_requests",
      entityId: rows[0].id,
      action: "create",
      after: {
        kind: "deposit_refund",
        patient_id: patientId,
        amount,
        requested_mode: mode,
        reason,
      },
      ...auditFields(ctx),
    });
    return { request_id: rows[0].id, amount, mode, status: "pending" };
  }, db);
}

export async function payOutRefund(requestIdValue, input, ctx, db = pool) {
  const requestId = cleanUuid(requestIdValue, "deposit refund");
  if (!ctx?.actorId) throw httpError(401, "Sign in again to pay money back");
  const reference = typeof input?.reference === "string" ? input.reference.trim() : "";
  if (reference.length > REFERENCE_MAX) {
    throw httpError(400, `The reference is too long — keep it under ${REFERENCE_MAX} letters`);
  }
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, kind, status, patient_id, amount, approved_mode FROM billing_requests
        WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    const request = rows[0];
    if (!request || request.kind !== "deposit_refund") {
      throw httpError(404, "That deposit refund no longer exists");
    }
    if (request.status === "pending") {
      throw httpError(409, "This deposit refund is still waiting for approval");
    }
    if (request.status !== "approved") {
      throw httpError(409, "This deposit refund was already paid back or rejected");
    }
    const mode = request.approved_mode;
    if (mode !== DRAWER_MODE && !reference) {
      throw httpError(400, `A ${MODE_LABEL[mode]} refund needs the reversal's reference number`);
    }
    const amount = paise(request.amount);
    const account = await lockAccount(client, request.patient_id);
    if (account.balance < amount) {
      throw httpError(409, "The deposit no longer holds this amount, so it can't be paid back");
    }
    let shiftId = await openShiftIdFor(client, ctx.actorId);
    if (mode === DRAWER_MODE) {
      const shift = await cashOutShift(client, ctx.actorId);
      if (!shift) {
        throw httpError(
          409,
          "Open your shift first, so this cash comes out of a drawer that is counted at the end of it",
        );
      }
      if (shift.cash < amount) {
        throw httpError(
          409,
          `Your drawer holds ₹${rupees(shift.cash)}, so ₹${rupees(amount)} can't be paid back in cash`,
        );
      }
      shiftId = shift.id;
    }
    const { rows: paid } = await client.query(
      `INSERT INTO payments (deposit_patient_id, direction, mode, amount, reference, shift_id,
                             received_by, created_by, updated_by)
       VALUES ($1, 'out', $2, $3, $4, $5, $6, $6, $6)
       RETURNING id, received_at`,
      [request.patient_id, mode, rupees(amount), reference || null, shiftId, ctx.actorId],
    );
    const entry = await addEntry(
      client,
      {
        patientId: request.patient_id,
        kind: "refunded",
        amount: -amount,
        paymentId: paid[0].id,
        requestId,
      },
      ctx,
    );
    await client.query(
      `UPDATE billing_requests SET status = 'used', updated_at = NOW(), updated_by = $2
        WHERE id = $1`,
      [requestId, ctx.actorId],
    );
    await writeAudit(client, {
      entity: "payments",
      entityId: paid[0].id,
      action: "create",
      after: {
        deposit_patient_id: request.patient_id,
        direction: "out",
        mode,
        amount,
        request_id: requestId,
      },
      ...auditFields(ctx),
    });
    return {
      request_id: requestId,
      payment_id: paid[0].id,
      entry_id: entry.id,
      amount,
      mode,
      balance: entry.balanceAfter,
    };
  }, db);
}
