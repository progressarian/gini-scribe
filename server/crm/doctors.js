import { withCrmContext } from "./db.js";
import { ASSIGNABLE_ROLES, ASSIGNING_ROLES } from "./assignees.js";
import { applyAssignments } from "./assignments.js";
import { isValidMobile, toEntryDigits } from "../../shared/phone.js";
import { DOCTOR_REQUIRED_MESSAGES, doctorFieldError } from "../../shared/crmDoctorRules.js";
import {
  DOCTOR_PRIORITY_VALUES,
  DOCTOR_SPECIALTY_VALUES,
  specialtyFromList,
} from "../../shared/crmVocab.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isLead = (crmUser) => ASSIGNING_ROLES.includes(crmUser?.role);

export class DoctorError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export const EDITABLE_FIELDS = [
  "full_name",
  "specialty",
  "qualifications",
  "mobile",
  "whatsapp",
  "clinic_phone",
  "email",
  "clinic_name",
  "address_line",
  "area",
  "city",
  "pin_code",
  "territory_id",
  "priority",
  "notes",
];

const KEEP_ONCE_SET = ["full_name", "mobile", "area", "specialty"];

function tidyPart(part, upperInput) {
  if (!/[a-z]/i.test(part)) return part;
  const hasVowel = /[aeiouy]/i.test(part);
  if (part.length === 1) return part.toUpperCase();
  if (part.length === 2 && (upperInput || !hasVowel)) return part.toUpperCase();
  if (!hasVowel && part.length <= 3) return part.toUpperCase();
  return part[0].toUpperCase() + part.slice(1).toLowerCase();
}

export function tidyName(raw) {
  let text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  while (/^dr\b\.?\s*/i.test(text)) text = text.replace(/^dr\b\.?\s*/i, "");
  if (!text) return "";
  const upperInput = text === text.toUpperCase();
  const shouting = upperInput || text === text.toLowerCase();
  const body = shouting
    ? text
        .split(" ")
        .map((word) =>
          word
            .split(/([.\-'])/)
            .map((p) => tidyPart(p, upperInput))
            .join(""),
        )
        .join(" ")
    : text;
  return `Dr ${body}`;
}

const clean = (v) => {
  if (v === undefined) return undefined;
  const t = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t === "" ? null : t;
};

function normaliseSpecialty(v) {
  const t = clean(v);
  if (!t) return t;
  return specialtyFromList(t) ?? t;
}

export function validateDoctor(input, { creating, current = {} }) {
  const out = {};
  const errors = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  for (const key of EDITABLE_FIELDS) {
    if (!creating && !has(key)) continue;
    let value = clean(input[key]);
    if (value === undefined) value = null;

    if (key === "full_name" && value) value = tidyName(value);
    if (key === "specialty" && value) value = normaliseSpecialty(value);
    if (["mobile", "whatsapp"].includes(key) && value) value = toEntryDigits(value);
    if (key === "clinic_phone" && value) value = value.replace(/[\s-]/g, "");
    if (key === "email" && value) value = value.toLowerCase();
    if (key === "pin_code" && value) value = value.replace(/\s/g, "");
    if (key === "priority" && !value) value = "unclassified";

    const required = creating
      ? ["full_name", "mobile", "area", "specialty"].includes(key)
      : KEEP_ONCE_SET.includes(key) && clean(current[key]);
    if (required && !value) {
      errors[key] = DOCTOR_REQUIRED_MESSAGES[key];
      continue;
    }

    if (value) {
      const raw = clean(input[key]);
      const problem =
        key === "specialty" && specialtyFromList(raw)
          ? null
          : doctorFieldError(key, ["mobile", "whatsapp"].includes(key) ? value : raw);
      if (problem) {
        errors[key] = problem;
      } else if (key === "territory_id" && !UUID.test(value)) {
        errors[key] = "Choose a territory from the list.";
      } else if (key === "priority" && !DOCTOR_PRIORITY_VALUES.includes(value)) {
        errors[key] = "Choose priority A, B, C or Not set.";
      }
    }
    out[key] = value;
  }

  if (Object.keys(errors).length) {
    throw new DoctorError(Object.values(errors)[0], 400, { fields: errors });
  }
  return out;
}

async function hospitalId(sql) {
  const { rows } = await sql("SELECT id FROM crm.hospitals WHERE code = 'GACH'");
  return rows[0]?.id;
}

async function assertTerritory(sql, territoryId) {
  if (!territoryId) return;
  const { rows } = await sql(
    "SELECT 1 FROM crm.territories WHERE id = $1 AND deleted_at IS NULL AND is_active",
    [territoryId],
  );
  if (!rows[0]) {
    throw new DoctorError("Choose a territory from the list.", 400, {
      fields: { territory_id: "Choose a territory from the list." },
    });
  }
}

async function mobileClash(sql, mobile, exceptId = null) {
  if (!mobile) return null;
  const { rows } = await sql("SELECT * FROM crm.mobile_owner($1, $2)", [mobile, exceptId]);
  const hit = rows[0];
  if (!hit) return null;
  if (hit.visible) {
    return {
      message: `This mobile already belongs to ${hit.full_name}.`,
      doctor_id: hit.doctor_id,
      doctor_name: hit.full_name,
    };
  }
  return {
    message: hit.owner_name
      ? `This mobile is already in the CRM under another team member (${hit.owner_name}). Ask your admin to move the doctor to you.`
      : "This mobile is already in the CRM. Ask your admin to assign that doctor to you.",
  };
}

async function failOnClash(sql, mobile, exceptId) {
  const clash = await mobileClash(sql, mobile, exceptId);
  if (clash) {
    throw new DoctorError(clash.message, 409, {
      code: "mobile_taken",
      fields: { mobile: clash.message },
      doctor_id: clash.doctor_id ?? null,
      doctor_name: clash.doctor_name ?? null,
    });
  }
}

async function similarDoctors(sql, fullName, area, exceptId = null) {
  if (!fullName || !area) return [];
  const { rows } = await sql(
    `SELECT id, full_name, area, mobile FROM crm.doctors
      WHERE deleted_at IS NULL
        AND regexp_replace(lower(btrim(full_name)), '^(dr\\.?\\s*)+', '')
          = regexp_replace(lower(btrim($1)), '^(dr\\.?\\s*)+', '')
        AND lower(btrim(coalesce(area, ''))) = lower($2)
        AND ($3::uuid IS NULL OR id <> $3)
      LIMIT 5`,
    [fullName, area, exceptId],
  );
  return rows;
}

async function staffOptions(sql) {
  const { rows } = await sql(
    `SELECT id, full_name FROM crm.users
      WHERE is_active AND deleted_at IS NULL AND role = ANY($1::text[]) ORDER BY full_name`,
    [ASSIGNABLE_ROLES],
  );
  return rows;
}

async function assertOwner(sql, ownerId) {
  if (!ownerId) return null;
  if (!UUID.test(ownerId)) throw new DoctorError("Choose a team member from the list.");
  const staff = await staffOptions(sql);
  if (!staff.some((s) => s.id === ownerId)) {
    throw new DoctorError("Choose a team member from the list.", 400, {
      fields: { owner_id: "Choose a team member from the list." },
    });
  }
  return ownerId;
}

const uniqueClash = (e) => e?.code === "23505" && /mobile/.test(e?.constraint || e?.detail || "");

export async function checkMobile(crmUser, { mobile, except }) {
  const digits = toEntryDigits(mobile);
  if (!isValidMobile(digits)) return { valid: false, taken: false };
  return withCrmContext(crmUser, async (sql) => {
    const clash = await mobileClash(sql, digits, UUID.test(except || "") ? except : null);
    return clash
      ? {
          valid: true,
          taken: true,
          message: clash.message,
          doctor_id: clash.doctor_id ?? null,
          doctor_name: clash.doctor_name ?? null,
        }
      : { valid: true, taken: false };
  });
}

export async function doctorFormOptions(crmUser) {
  return withCrmContext(crmUser, async (sql) => {
    const { rows: territories } = await sql(
      `SELECT id, name FROM crm.territories
        WHERE deleted_at IS NULL AND is_active ORDER BY name`,
    );
    return {
      territories,
      specialties: DOCTOR_SPECIALTY_VALUES,
      can_assign: isLead(crmUser),
      staff: isLead(crmUser) ? await staffOptions(sql) : [],
    };
  });
}

export async function addDoctor(crmUser, body = {}) {
  const fields = validateDoctor(body, { creating: true });
  const lead = isLead(crmUser);
  return withCrmContext(crmUser, async (sql) => {
    await assertTerritory(sql, fields.territory_id);
    const ownerId = lead ? await assertOwner(sql, clean(body.owner_id)) : crmUser.id;
    await failOnClash(sql, fields.mobile);
    if (!body.confirm_similar) {
      const similar = await similarDoctors(sql, fields.full_name, fields.area);
      if (similar.length) {
        throw new DoctorError(
          `${fields.full_name} in ${fields.area} is already in the CRM. Check it is not the same doctor.`,
          409,
          { code: "similar", similar },
        );
      }
    }

    const id = crypto.randomUUID();
    const hospital = await hospitalId(sql);
    const columns = Object.keys(fields);
    try {
      await sql(
        `INSERT INTO crm.doctors (id, hospital_id, ${columns.join(", ")}, created_by, updated_by)
         VALUES ($1, $2, ${columns.map((_, i) => `$${i + 3}`).join(", ")}, $${columns.length + 3}, $${columns.length + 3})`,
        [id, hospital, ...columns.map((c) => fields[c]), crmUser.id],
      );
    } catch (e) {
      if (uniqueClash(e)) await failOnClash(sql, fields.mobile);
      throw e;
    }

    if (!lead) {
      await sql("SELECT crm.assign_new_doctor($1)", [id]);
    } else if (ownerId) {
      await applyAssignments(sql, {
        hospitalId: hospital,
        assignedBy: crmUser.id,
        items: [{ doctor_id: id, executive_id: ownerId, reason: "Added by admin" }],
      });
    }
    return { id, full_name: fields.full_name, owner_id: ownerId };
  });
}

const EDIT_COLUMNS = `d.id, d.full_name, d.specialty, d.qualifications, d.mobile, d.whatsapp,
  d.clinic_phone, d.email, d.clinic_name, d.address_line, d.area, d.city, d.pin_code,
  d.territory_id, d.priority, d.notes, d.updated_at, d.deleted_at,
  a.executive_id AS owner_id, o.full_name AS owner_name`;

async function loadDoctor(sql, doctorId, { lock = false } = {}) {
  if (!UUID.test(doctorId || "")) throw new DoctorError("Doctor not found.", 404);
  const { rows } = await sql(
    `SELECT ${EDIT_COLUMNS}
       FROM crm.doctors d
       LEFT JOIN crm.doctor_assignments a ON a.doctor_id = d.id AND a.effective_to IS NULL
       LEFT JOIN crm.users o ON o.id = a.executive_id
      WHERE d.id = $1 ${lock ? "FOR UPDATE OF d" : ""}`,
    [doctorId],
  );
  if (!rows[0] || rows[0].deleted_at) {
    throw new DoctorError(
      "This doctor is not on your list. They may have been moved or removed.",
      404,
    );
  }
  return rows[0];
}

export async function doctorForEdit(crmUser, doctorId) {
  return withCrmContext(crmUser, async (sql) => {
    const doctor = await loadDoctor(sql, doctorId);
    return { doctor };
  });
}

export async function updateDoctor(crmUser, doctorId, body = {}) {
  const lead = isLead(crmUser);
  return withCrmContext(crmUser, async (sql) => {
    const current = await loadDoctor(sql, doctorId, { lock: true });
    if (
      body.updated_at &&
      new Date(body.updated_at).getTime() !== new Date(current.updated_at).getTime()
    ) {
      const { rows } = await sql("SELECT * FROM crm.doctor_history($1, 1)", [doctorId]);
      const last = rows[0];
      throw new DoctorError(
        last?.actor_name
          ? `This doctor was changed by ${last.actor_name} while you were editing. Reload to see the latest details.`
          : "This doctor was changed while you were editing. Reload to see the latest details.",
        409,
        { code: "stale" },
      );
    }

    const patch = {};
    for (const key of EDITABLE_FIELDS) if (key in body) patch[key] = body[key];
    const fields = validateDoctor(patch, { creating: false, current });
    const changed = Object.fromEntries(
      Object.entries(fields).filter(([k, v]) => (current[k] ?? null) !== (v ?? null)),
    );
    const ownerChange =
      lead && "owner_id" in body && (clean(body.owner_id) ?? null) !== (current.owner_id ?? null);
    if (
      !lead &&
      "owner_id" in body &&
      (clean(body.owner_id) ?? null) !== (current.owner_id ?? null)
    ) {
      throw new DoctorError("Only your admin can change who a doctor is assigned to.", 403);
    }
    if (!Object.keys(changed).length && !ownerChange) {
      return { id: doctorId, changed: [], updated_at: current.updated_at };
    }

    if ("territory_id" in changed) await assertTerritory(sql, changed.territory_id);
    if ("mobile" in changed) await failOnClash(sql, changed.mobile, doctorId);

    let updatedAt = current.updated_at;
    const columns = Object.keys(changed);
    if (columns.length) {
      try {
        const { rows } = await sql(
          `UPDATE crm.doctors SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(", ")},
                  updated_by = $${columns.length + 2}
            WHERE id = $1 RETURNING updated_at`,
          [doctorId, ...columns.map((c) => changed[c]), crmUser.id],
        );
        updatedAt = rows[0].updated_at;
      } catch (e) {
        if (uniqueClash(e)) await failOnClash(sql, changed.mobile, doctorId);
        throw e;
      }
    }

    if (ownerChange) {
      const ownerId = await assertOwner(sql, clean(body.owner_id));
      if (ownerId) {
        await applyAssignments(sql, {
          hospitalId: await hospitalId(sql),
          assignedBy: crmUser.id,
          items: [
            { doctor_id: doctorId, executive_id: ownerId, reason: "Changed on the doctor form" },
          ],
        });
      } else {
        await sql(
          `UPDATE crm.doctor_assignments SET effective_to = now(), updated_at = now()
            WHERE doctor_id = $1 AND effective_to IS NULL`,
          [doctorId],
        );
      }
    }
    return {
      id: doctorId,
      changed: [...columns, ...(ownerChange ? ["owner_id"] : [])],
      updated_at: updatedAt,
    };
  });
}

const HISTORY_LABELS = {
  full_name: "Name",
  specialty: "Specialty",
  qualifications: "Qualifications",
  mobile: "Mobile",
  whatsapp: "WhatsApp",
  clinic_phone: "Clinic phone",
  email: "Email",
  clinic_name: "Clinic name",
  address_line: "Address",
  area: "Area",
  city: "City",
  pin_code: "PIN",
  territory_id: "Territory",
  priority: "Priority",
  notes: "Notes",
  relationship_stage: "Stage",
  deleted_at: "Removed",
};

export async function doctorHistory(crmUser, doctorId) {
  if (!UUID.test(doctorId || "")) throw new DoctorError("Doctor not found.", 404);
  return withCrmContext(crmUser, async (sql) => {
    const { rows } = await sql("SELECT * FROM crm.doctor_history($1, 40)", [doctorId]);
    const { rows: territories } = await sql("SELECT id, name FROM crm.territories");
    const territoryName = (id) => territories.find((t) => t.id === id)?.name ?? null;
    const show = (key, v) => {
      if (v == null || v === "") return null;
      if (key === "territory_id") return territoryName(v);
      if (key === "priority") return v === "unclassified" ? "Not set" : v;
      if (key === "deleted_at") return "Yes";
      return String(v);
    };
    const entries = rows
      .map((r) => {
        if (r.operation === "INSERT") {
          return { at: r.changed_at, by: r.actor_name, kind: "added", changes: [] };
        }
        const changes = (r.changed_fields || [])
          .filter((k) => HISTORY_LABELS[k])
          .map((k) => ({
            field: HISTORY_LABELS[k],
            from: show(k, r.old_data?.[k]),
            to: show(k, r.new_data?.[k]),
          }));
        if (!changes.length) return null;
        const removed = (r.changed_fields || []).includes("deleted_at");
        return {
          at: r.changed_at,
          by: r.actor_name,
          kind: removed ? (r.new_data?.deleted_at ? "removed" : "restored") : "edited",
          changes: removed ? [] : changes,
        };
      })
      .filter(Boolean)
      .slice(0, 20);
    return { entries };
  });
}
