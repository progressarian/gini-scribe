import * as XLSX from "xlsx";
import { withCrmContext } from "./db.js";
import { DOCTOR_PRIORITY_VALUES } from "../../shared/crmVocab.js";

// The doctor import wizard (brief §10). Deliberately not a script for one CSV:
// Virender's transcribed list is the first file through it, and every later
// list — a conference delegate sheet, a competitor's referral panel — goes
// through the same four steps.
//
//   upload  -> rows land in crm.import_rows exactly as given
//   map     -> the operator says which column means what
//   preview -> every row resolved, deduped and flagged, nothing written
//   commit  -> only then does crm.doctors change
//
// The raw row is kept forever alongside the interpreted one, so a bad mapping
// is re-runnable without going back to the file.

// What a column can mean. `aliases` are matched case- and space-insensitively
// against the header so the common shapes need no mapping at all.
export const IMPORT_FIELDS = [
  {
    key: "full_name",
    label: "Doctor name",
    required: true,
    aliases: ["name", "doctor", "doctorname", "drname", "fullname"],
  },
  { key: "specialty", label: "Specialty", aliases: ["speciality", "dept", "department", "field"] },
  { key: "sub_specialty", label: "Sub-specialty", aliases: ["subspeciality", "subspecialty"] },
  {
    key: "qualifications",
    label: "Qualifications",
    aliases: ["qualification", "degree", "degrees"],
  },
  {
    key: "clinic_name",
    label: "Clinic / hospital",
    aliases: ["clinic", "hospital", "practice", "clinichospital"],
  },
  { key: "mobile", label: "Mobile", aliases: ["phone", "mobileno", "contact", "cell", "number"] },
  { key: "whatsapp", label: "WhatsApp", aliases: ["whatsappno", "wa"] },
  { key: "email", label: "Email", aliases: ["mail", "emailid"] },
  { key: "area", label: "Area", aliases: ["locality", "location", "sector"] },
  { key: "city", label: "City", aliases: ["town"] },
  { key: "district", label: "District" },
  { key: "state", label: "State" },
  { key: "pin_code", label: "PIN", aliases: ["pin", "pincode", "postalcode", "zip"] },
  { key: "territory", label: "Territory", aliases: ["zone", "patch"] },
  { key: "priority", label: "Priority (A/B/C)", aliases: ["abc", "grade", "band", "category"] },
  {
    key: "notes",
    label: "Notes",
    aliases: ["note", "remark", "remarks", "comment", "comments", "intelligence"],
  },
  {
    key: "transcription_confidence",
    label: "Transcription confidence",
    aliases: ["confidence", "certainty", "transcriptionconfidence", "accuracy"],
  },
];

const FIELD_KEYS = new Set(IMPORT_FIELDS.map((f) => f.key));
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const clean = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

/** Best-guess mapping from header text, so a well-formed file needs no work. */
export function suggestMapping(headers) {
  const mapping = {};
  const taken = new Set();
  for (const header of headers) {
    const h = norm(header);
    if (!h) continue;
    const hit = IMPORT_FIELDS.find(
      (f) =>
        !taken.has(f.key) &&
        (norm(f.key) === h || norm(f.label) === h || (f.aliases || []).includes(h)),
    );
    if (hit) {
      mapping[header] = hit.key;
      taken.add(hit.key);
    }
  }
  return mapping;
}

/** Parse an uploaded CSV or Excel buffer into headers + raw row objects. */
export function parseSheet(buffer, fileName = "") {
  const wb = XLSX.read(buffer, { type: "buffer", raw: false, cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("That file has no readable sheet");
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  const headers = Object.keys(rows[0] || {});
  if (headers.length === 0) throw new Error("That file has no header row");
  return { headers, rows, fileName };
}

// "check spelling", "Check - area unclear", "CHECK" — the transcriber's way of
// saying the doctor is real but a detail might not be. Anything else (high,
// medium, confident) is taken at face value.
export function needsVerification(confidence) {
  return /^\s*check\b/i.test(String(confidence ?? ""));
}

function normalisePriority(v) {
  const t = clean(v);
  if (!t) return "unclassified";
  const first = t.trim()[0].toUpperCase();
  if (["A", "B", "C"].includes(first)) return first;
  return DOCTOR_PRIORITY_VALUES.includes(t) ? t : "unclassified";
}

/** Apply a mapping to one raw row, returning the shape crm.doctors wants. */
export function interpretRow(raw, mapping) {
  const out = {};
  for (const [header, field] of Object.entries(mapping || {})) {
    if (!FIELD_KEYS.has(field)) continue;
    out[field] = clean(raw[header]);
  }
  out.priority = normalisePriority(out.priority);
  out.needs_verification = needsVerification(out.transcription_confidence);
  out.verification_note = out.needs_verification ? out.transcription_confidence : null;
  return out;
}

export function rowErrors(interpreted) {
  const errs = [];
  if (!interpreted.full_name) errs.push("Doctor name is required");
  if (interpreted.mobile && !/\d/.test(interpreted.mobile)) errs.push("Mobile has no digits");
  if (interpreted.pin_code && !/^\d{6}$/.test(interpreted.pin_code))
    errs.push("PIN should be 6 digits");
  return errs;
}

export async function createBatch(crmUser, { fileName, headers, rows, mapping }) {
  return withCrmContext(crmUser, async (sql) => {
    const { rows: hos } = await sql("SELECT id FROM crm.hospitals WHERE code = 'GACH'");
    const hospitalId = hos[0]?.id;

    const { rows: created } = await sql(
      `INSERT INTO crm.import_batches
         (hospital_id, uploaded_by, file_name, column_mapping, status, total_rows)
       VALUES ($1, $2, $3, $4, 'previewing', $5)
       RETURNING id`,
      [hospitalId, crmUser.id, fileName, JSON.stringify(mapping), rows.length],
    );
    const batchId = created[0].id;

    for (let i = 0; i < rows.length; i++) {
      const interpreted = interpretRow(rows[i], mapping);
      await sql(
        `INSERT INTO crm.import_rows
           (batch_id, row_number, raw, normalized, mobile_e164, status, error_message)
         VALUES ($1, $2, $3, $4, crm.normalize_phone($5), 'pending', $6)`,
        [
          batchId,
          i + 2, // +2: spreadsheet rows are 1-based and row 1 is the header
          JSON.stringify(rows[i]),
          JSON.stringify(interpreted),
          interpreted.mobile,
          rowErrors(interpreted).join("; ") || null,
        ],
      );
    }
    return { batchId, headers, totalRows: rows.length };
  });
}

/**
 * Resolve every row against the existing universe and against its own file.
 * Writes nothing.
 *
 * Two dedup rules, and they are not equally strong. A matching normalised
 * mobile is the same doctor — the brief's canonical identity — so those rows
 * are marked `duplicate` and skipped by default. A matching name in the same
 * territory is only a *suspicion*: "Dr Sharma, Mohali" is not rare. Those are
 * marked `possible_duplicate` for a human to judge, and import unless
 * explicitly skipped.
 */
export async function previewBatch(crmUser, batchId) {
  return withCrmContext(crmUser, async (sql) => {
    const { rows: batches } = await sql(
      `SELECT id, file_name, column_mapping, total_rows, status
         FROM crm.import_batches WHERE id = $1`,
      [batchId],
    );
    if (!batches[0]) throw new Error("Import not found");

    const { rows } = await sql(
      `SELECT row_number, raw, normalized, mobile_e164, error_message
         FROM crm.import_rows WHERE batch_id = $1 ORDER BY row_number`,
      [batchId],
    );

    const { rows: existing } = await sql(
      `SELECT d.id, d.full_name, d.mobile_e164, d.area, t.name AS territory
         FROM crm.doctors d
         LEFT JOIN crm.territories t ON t.id = d.territory_id
        WHERE d.deleted_at IS NULL`,
    );

    const byMobile = new Map();
    const byNameTerritory = new Map();
    const nameKey = (name, territory) => `${norm(name)}::${norm(territory)}`;
    for (const d of existing) {
      if (d.mobile_e164) byMobile.set(d.mobile_e164, d);
      byNameTerritory.set(nameKey(d.full_name, d.territory || d.area), d);
    }

    const seenMobile = new Map();
    const seenName = new Map();
    const out = [];

    for (const r of rows) {
      const v = r.normalized || {};
      const errors = r.error_message ? r.error_message.split("; ") : [];
      const flags = [];
      let status = "create";
      let matched = null;

      if (errors.length) {
        status = "error";
      } else if (r.mobile_e164 && byMobile.has(r.mobile_e164)) {
        status = "duplicate";
        matched = byMobile.get(r.mobile_e164);
        flags.push("Same mobile as an existing doctor");
      } else if (r.mobile_e164 && seenMobile.has(r.mobile_e164)) {
        status = "duplicate";
        flags.push(`Same mobile as row ${seenMobile.get(r.mobile_e164)} in this file`);
      } else {
        const key = nameKey(v.full_name, v.territory || v.area);
        if (byNameTerritory.has(key)) {
          status = "possible_duplicate";
          matched = byNameTerritory.get(key);
          flags.push("Same name and territory as an existing doctor");
        } else if (seenName.has(key)) {
          status = "possible_duplicate";
          flags.push(`Same name and territory as row ${seenName.get(key)} in this file`);
        }
        seenName.set(key, r.row_number);
      }

      if (r.mobile_e164 && !seenMobile.has(r.mobile_e164)) {
        seenMobile.set(r.mobile_e164, r.row_number);
      }
      if (!r.mobile_e164 && status !== "error")
        flags.push("No mobile — imports as a skeleton record");
      if (v.needs_verification) flags.push(`Transcription uncertain: ${v.verification_note}`);

      out.push({
        row_number: r.row_number,
        raw: r.raw,
        values: v,
        status,
        flags,
        errors,
        matched_doctor: matched ? { id: matched.id, full_name: matched.full_name } : null,
      });
    }

    const counts = out.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
    return { batch: batches[0], rows: out, counts };
  });
}

/**
 * Write the approved rows. `skipRows` is the set of row numbers the operator
 * chose to leave out; hard duplicates and errored rows are never written.
 */
export async function commitBatch(crmUser, batchId, skipRows = []) {
  const preview = await previewBatch(crmUser, batchId);
  const skip = new Set(skipRows.map(Number));

  return withCrmContext(crmUser, async (sql) => {
    const { rows: hos } = await sql("SELECT id FROM crm.hospitals WHERE code = 'GACH'");
    const hospitalId = hos[0]?.id;
    const { rows: terr } = await sql(
      "SELECT id, name FROM crm.territories WHERE deleted_at IS NULL",
    );
    const territoryId = (name) => terr.find((t) => norm(t.name) === norm(name))?.id ?? null;

    let created = 0;
    let skipped = 0;
    let errored = 0;

    for (const row of preview.rows) {
      if (row.status === "error") {
        errored++;
        await sql("UPDATE crm.import_rows SET status='error' WHERE batch_id=$1 AND row_number=$2", [
          batchId,
          row.row_number,
        ]);
        continue;
      }
      if (row.status === "duplicate" || skip.has(row.row_number)) {
        skipped++;
        await sql(
          `UPDATE crm.import_rows SET status='skipped_duplicate', matched_doctor_id=$3
             WHERE batch_id=$1 AND row_number=$2`,
          [batchId, row.row_number, row.matched_doctor?.id ?? null],
        );
        continue;
      }

      const v = row.values;
      const { rows: ins } = await sql(
        `INSERT INTO crm.doctors
           (hospital_id, full_name, specialty, sub_specialty, qualifications, clinic_name,
            mobile, whatsapp, email, area, city, district, state, pin_code, territory_id,
            priority, notes, needs_verification, verification_note, import_batch_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING id`,
        [
          hospitalId,
          v.full_name,
          v.specialty,
          v.sub_specialty,
          v.qualifications,
          v.clinic_name,
          v.mobile,
          v.whatsapp,
          v.email,
          v.area,
          v.city,
          v.district,
          v.state,
          v.pin_code,
          territoryId(v.territory || v.area),
          v.priority,
          v.notes,
          v.needs_verification,
          v.verification_note,
          batchId,
          crmUser.id,
        ],
      );
      created++;
      await sql(
        `UPDATE crm.import_rows SET status='created', matched_doctor_id=$3
           WHERE batch_id=$1 AND row_number=$2`,
        [batchId, row.row_number, ins[0].id],
      );
    }

    await sql(
      `UPDATE crm.import_batches
          SET status='completed', created_count=$2, skipped_count=$3, error_count=$4,
              completed_at=now()
        WHERE id=$1`,
      [batchId, created, skipped, errored],
    );
    return { created, skipped, errored };
  });
}
