import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { inTransaction } from "../billing/transaction.js";
import { PATIENT_DUE_SQL } from "./billDue.js";
import { WALKIN_REGISTRATION_SOURCE } from "../../../shared/pharmacyVocab.js";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const PHONE10 = `right(regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g'), 10)`;

const PATIENT_COLUMNS = `p.id, p.name, p.file_no, p.phone, p.age, p.sex, p.health_id,
  p.registration_source, ${PATIENT_DUE_SQL("p.id")} AS pharmacy_due,
  (SELECT v.id FROM giniflow_visits v
    WHERE v.patient_id = p.id AND v.visit_date = $1::date AND v.merged_into_visit_id IS NULL
    ORDER BY v.created_at DESC LIMIT 1) AS today_visit_id`;

export async function searchBillPatients({ q, limit = 20, offset = 0 }, db = pool) {
  const text = q.trim();
  const digits = text.replace(/\D/g, "");
  const params = [today(), `%${text.toLowerCase()}%`, limit, offset];
  let phone = "FALSE";
  if (digits.length >= 4) {
    params.push(`%${digits}%`);
    phone = `${PHONE10} LIKE $5`;
  }
  const { rows } = await db.query(
    `SELECT ${PATIENT_COLUMNS}
       FROM patients p
      WHERE lower(p.name) LIKE $2 OR lower(COALESCE(p.file_no, '')) LIKE $2 OR ${phone}
      ORDER BY (lower(p.name) = lower(btrim($2, '%'))) DESC, p.id DESC
      LIMIT $3 OFFSET $4`,
    params,
  );
  return rows;
}

export async function getBillPatient(id, db = pool) {
  const { rows } = await db.query(`SELECT ${PATIENT_COLUMNS} FROM patients p WHERE p.id = $2`, [
    today(),
    id,
  ]);
  return rows[0] ?? null;
}

async function nextGniFileNo(client) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('patients_gni_file_no'))`);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(file_no FROM 'GNI-([0-9]+)') AS INTEGER)), 0) + 1 AS next
       FROM patients WHERE file_no ~ '^GNI-[0-9]+$'`,
  );
  return `GNI-${String(rows[0].next).padStart(5, "0")}`;
}

export async function createWalkinPatient(input, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const phone10 = input.phone.slice(-10);
    const { rows: same } = await client.query(
      `SELECT p.id FROM patients p
        WHERE ${PHONE10} = $1 AND lower(btrim(p.name)) = lower(btrim($2))
        ORDER BY p.id LIMIT 1`,
      [phone10, input.name],
    );
    if (same.length) {
      return { patient: await getBillPatient(same[0].id, client), existing: true };
    }
    let rows = null;
    for (let attempt = 1; !rows; attempt += 1) {
      const fileNo = await nextGniFileNo(client);
      await client.query("SAVEPOINT walkin_file_no");
      try {
        ({ rows } = await client.query(
          `INSERT INTO patients (name, phone, age, sex, address, file_no, registration_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [
            input.name,
            input.phone,
            input.age ?? null,
            input.sex ?? null,
            input.address ?? null,
            fileNo,
            WALKIN_REGISTRATION_SOURCE,
          ],
        ));
        await client.query("RELEASE SAVEPOINT walkin_file_no");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT walkin_file_no");
        if (error.code !== "23505" || attempt >= 3) throw error;
      }
    }
    const patient = await getBillPatient(rows[0].id, client);
    await writeAudit(client, {
      entity: "patients",
      entityId: String(patient.id),
      action: "create",
      after: { file_no: patient.file_no, registration_source: WALKIN_REGISTRATION_SOURCE },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return { patient, existing: false };
  }, db);
}
