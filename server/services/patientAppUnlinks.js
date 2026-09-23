import pool from "../config/db.js";
import { getGenieDb } from "./genieImport.js";
import { revokePatientRefreshTokens } from "./refreshTokens.js";

const UNDEFINED_TABLE = "42P01";
const UNIQUE_VIOLATION = "23505";
let missingTableLogged = false;

export const phoneLast10 = (phone) =>
  String(phone || "")
    .replace(/\D/g, "")
    .slice(-10);

export function phoneVariants(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  const last10 = digits.slice(-10);
  return Array.from(new Set([phone, digits, `+${digits}`, last10]));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

export async function unlinkedIdsForPhone(phone, db = pool) {
  const empty = { hospital: new Set(), app: new Set() };
  const last10 = phoneLast10(phone);
  if (last10.length !== 10) return empty;
  try {
    const { rows } = await db.query(
      `SELECT patient_id, app_patient_id FROM patient_app_unlinks
        WHERE phone_last10 = $1 AND relinked_at IS NULL`,
      [last10],
    );
    for (const r of rows) {
      if (r.patient_id != null) empty.hospital.add(Number(r.patient_id));
      if (r.app_patient_id != null) empty.app.add(String(r.app_patient_id));
    }
    return empty;
  } catch (e) {
    if (e.code !== UNDEFINED_TABLE) throw e;
    if (!missingTableLogged) {
      missingTableLogged = true;
      console.warn("[patientAppUnlinks] table missing — run the 2026-10-18 migration");
    }
    return empty;
  }
}

export async function hospitalRowsForPhone(phone, db = pool) {
  const { rows } = await db.query(
    `SELECT id, name, dob, sex, file_no, phone FROM patients
       WHERE phone = ANY($1)
          OR regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2
          OR right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $2
       ORDER BY id`,
    [phoneVariants(phone), phoneLast10(phone)],
  );
  return rows;
}

export async function appRowsForPhone(phone) {
  const sb = getGenieDb();
  if (!sb) return [];
  const { data } = await sb
    .from("patients")
    .select("id, name, dob, sex, phone, migrated_to_gini")
    .in("phone", phoneVariants(phone));
  return data || [];
}

export async function getFamilyForPatient(patientId, db = pool) {
  const { rows } = await db.query(`SELECT id, phone FROM patients WHERE id = $1`, [patientId]);
  const patient = rows[0];
  if (!patient) throw httpError(404, "Patient not found");
  const last10 = phoneLast10(patient.phone);
  if (last10.length !== 10) return { phone: patient.phone || null, members: [] };

  const [hospital, app, unlinks] = await Promise.all([
    hospitalRowsForPhone(patient.phone, db),
    appRowsForPhone(patient.phone),
    db.query(
      `SELECT u.*, ud.name AS unlinked_by_name, rd.name AS relinked_by_name
         FROM patient_app_unlinks u
         LEFT JOIN doctors ud ON ud.id = u.unlinked_by
         LEFT JOIN doctors rd ON rd.id = u.relinked_by
        WHERE u.phone_last10 = $1
        ORDER BY u.unlinked_at DESC`,
      [last10],
    ),
  ]);

  const latest = (match) => unlinks.rows.find(match) || null;
  const shape = (u) =>
    u && {
      id: u.id,
      reason: u.reason,
      requestedBy: u.requested_by,
      unlinkedBy: u.unlinked_by_name,
      unlinkedAt: u.unlinked_at,
      relinkedBy: u.relinked_by_name,
      relinkedAt: u.relinked_at,
    };

  const members = [
    ...hospital.map((p) => {
      const u = latest((x) => Number(x.patient_id) === Number(p.id));
      return {
        source: "hospital",
        id: String(p.id),
        name: p.name,
        fileNo: p.file_no,
        sex: p.sex,
        dob: p.dob,
        isViewed: Number(p.id) === Number(patientId),
        unlinked: !!u && !u.relinked_at,
        lastChange: shape(u),
      };
    }),
    ...app
      .filter((a) => !a.migrated_to_gini)
      .map((a) => {
        const u = latest((x) => x.app_patient_id === String(a.id));
        return {
          source: "app",
          id: String(a.id),
          name: a.name,
          fileNo: null,
          sex: a.sex,
          dob: a.dob,
          isViewed: false,
          unlinked: !!u && !u.relinked_at,
          lastChange: shape(u),
        };
      }),
  ];
  return { phone: patient.phone, phoneLast10: last10, members };
}

export async function unlinkFamilyMember(
  { patientId, source, memberId, reason, requestedBy },
  actorId,
  db = pool,
) {
  const family = await getFamilyForPatient(patientId, db);
  const member = family.members.find((m) => m.source === source && m.id === String(memberId));
  if (!member) throw httpError(404, "That profile is not on this phone");

  const client = await pool.connect();
  let unlinkId;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `patient_app_unlinks:${family.phoneLast10}`,
    ]);
    const { rows: active } = await client.query(
      `SELECT patient_id, app_patient_id FROM patient_app_unlinks
        WHERE phone_last10 = $1 AND relinked_at IS NULL`,
      [family.phoneLast10],
    );
    const isActive = (m) =>
      active.some((a) =>
        m.source === "hospital"
          ? Number(a.patient_id) === Number(m.id)
          : String(a.app_patient_id) === m.id,
      );
    if (isActive(member)) throw httpError(409, "Already removed from this app account");
    if (family.members.filter((m) => !isActive(m)).length <= 1) {
      throw httpError(409, "This is the only profile on the phone — it cannot be removed");
    }
    const { rows } = await client.query(
      `INSERT INTO patient_app_unlinks
         (phone_last10, patient_id, app_patient_id, reason, requested_by, unlinked_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        family.phoneLast10,
        source === "hospital" ? Number(member.id) : null,
        source === "app" ? member.id : null,
        reason,
        requestedBy,
        actorId,
      ],
    );
    await client.query("COMMIT");
    unlinkId = rows[0].id;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e.code === UNIQUE_VIOLATION) throw httpError(409, "Already removed from this app account");
    throw e;
  } finally {
    client.release();
  }

  const patientDb = source === "hospital" ? "hospital" : "app";
  await db.query(
    `DELETE FROM auth_sessions WHERE kind = 'patient' AND patient_db = $1 AND patient_ref = $2`,
    [patientDb, member.id],
  );
  await revokePatientRefreshTokens(patientDb, member.id);

  return { id: unlinkId, member: { ...member, unlinked: true } };
}

export async function relinkFamilyMember(unlinkId, actorId, db = pool) {
  const { rows } = await db.query(
    `UPDATE patient_app_unlinks
        SET relinked_by = $2, relinked_at = NOW()
      WHERE id = $1 AND relinked_at IS NULL
      RETURNING id, patient_id, app_patient_id`,
    [unlinkId, actorId],
  );
  if (!rows.length) throw httpError(404, "No active removal with that id");
  return rows[0];
}
