import ExcelJS from "exceljs";
import { withCrmContext } from "./db.js";
import { ASSIGNABLE_ROLES } from "./assignees.js";

const PAGE_SIZE = 50;
const MAX_PER_CHANGE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const textOf = (v) => (typeof v === "string" ? v.trim().slice(0, 100) : "");

export class AssignmentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function applyAssignments(sql, { hospitalId, assignedBy, items }) {
  if (!items.length) return new Set();
  const payload = JSON.stringify(items);
  await sql(
    `UPDATE crm.doctor_assignments a
        SET effective_to = now(), updated_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS x(doctor_id uuid, executive_id uuid, reason text)
      WHERE a.doctor_id = x.doctor_id AND a.effective_to IS NULL
        AND a.executive_id IS DISTINCT FROM x.executive_id`,
    [payload],
  );
  const { rows } = await sql(
    `INSERT INTO crm.doctor_assignments
       (hospital_id, doctor_id, executive_id, manager_id, territory_id, assigned_by, reason)
     SELECT $2, x.doctor_id, x.executive_id, u.manager_id, d.territory_id, $3, x.reason
       FROM jsonb_to_recordset($1::jsonb) AS x(doctor_id uuid, executive_id uuid, reason text)
       JOIN crm.users u ON u.id = x.executive_id
       JOIN crm.doctors d ON d.id = x.doctor_id
      WHERE x.executive_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM crm.doctor_assignments a
                         WHERE a.doctor_id = x.doctor_id AND a.effective_to IS NULL)
     RETURNING doctor_id`,
    [payload, hospitalId, assignedBy],
  );
  return new Set(rows.map((r) => r.doctor_id));
}

function filterSql({ owner = "all", territory = "", q = "" }) {
  const params = [];
  const where = ["d.deleted_at IS NULL", "d.is_active"];
  if (owner === "unassigned") where.push("a.executive_id IS NULL");
  else if (owner && owner !== "all") {
    if (!UUID.test(owner)) throw new AssignmentError("Choose an owner from the list");
    params.push(owner);
    where.push(`a.executive_id = $${params.length}::uuid`);
  }
  if (textOf(territory)) {
    params.push(textOf(territory));
    where.push(`t.name = $${params.length}`);
  }
  const term = textOf(q);
  if (term) {
    params.push(`%${term.replace(/[\\%_]/g, "\\$&")}%`);
    const p = `$${params.length}`;
    where.push(
      `(d.full_name ILIKE ${p} OR d.mobile ILIKE ${p} OR d.area ILIKE ${p} OR d.specialty ILIKE ${p})`,
    );
  }
  return { params, where: where.join(" AND ") };
}

const FROM = `
  FROM crm.doctors d
  LEFT JOIN crm.territories t ON t.id = d.territory_id
  LEFT JOIN crm.doctor_assignments a ON a.doctor_id = d.id AND a.effective_to IS NULL
  LEFT JOIN crm.users o ON o.id = a.executive_id
  LEFT JOIN crm.users b ON b.id = a.assigned_by`;

const COLUMNS = `d.id AS doctor_id, d.full_name, d.specialty, d.mobile, d.area,
       t.name AS territory, o.id AS owner_id, o.full_name AS owner,
       a.effective_from AS assigned_at, b.full_name AS assigned_by`;

export async function listAssignments(crmUser, filters = {}) {
  const requested = Math.min(10_000, Math.max(1, Math.floor(Number(filters.page)) || 1));
  const { params, where } = filterSql(filters);
  return withCrmContext(crmUser, async (sql) => {
    const { rows: total } = await sql(`SELECT count(*)::int AS n ${FROM} WHERE ${where}`, params);
    const page = Math.min(requested, Math.max(1, Math.ceil(total[0].n / PAGE_SIZE)));
    const { rows } = await sql(
      `SELECT ${COLUMNS} ${FROM} WHERE ${where}
        ORDER BY (a.executive_id IS NOT NULL), t.name NULLS LAST, d.full_name, d.id
        LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params,
    );
    const { rows: byOwner } = await sql(
      `SELECT o.id, o.full_name, count(*)::int AS n
         FROM crm.doctors d
         JOIN crm.doctor_assignments a ON a.doctor_id = d.id AND a.effective_to IS NULL
         JOIN crm.users o ON o.id = a.executive_id
        WHERE d.deleted_at IS NULL AND d.is_active
        GROUP BY o.id, o.full_name ORDER BY o.full_name`,
    );
    const { rows: overall } = await sql(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE a.executive_id IS NULL)::int AS unassigned
         FROM crm.doctors d
         LEFT JOIN crm.doctor_assignments a ON a.doctor_id = d.id AND a.effective_to IS NULL
        WHERE d.deleted_at IS NULL AND d.is_active`,
    );
    const { rows: territories } = await sql(
      `SELECT DISTINCT t.name FROM crm.doctors d JOIN crm.territories t ON t.id = d.territory_id
        WHERE d.deleted_at IS NULL AND d.is_active ORDER BY t.name`,
    );
    const { rows: staff } = await sql(
      `SELECT id, full_name FROM crm.users
        WHERE is_active AND deleted_at IS NULL AND role = ANY($1::text[]) ORDER BY full_name`,
      [ASSIGNABLE_ROLES],
    );
    return {
      counts: { ...overall[0], by_owner: byOwner },
      territories: territories.map((t) => t.name),
      staff,
      rows,
      page,
      page_size: PAGE_SIZE,
      total: total[0].n,
      pages: Math.max(1, Math.ceil(total[0].n / PAGE_SIZE)),
    };
  });
}

export async function assignDoctors(crmUser, { doctorIds, executiveId }) {
  if (!Array.isArray(doctorIds)) throw new AssignmentError("Select at least one doctor");
  const ids = [...new Set(doctorIds.filter(Boolean))];
  if (!ids.length) throw new AssignmentError("Select at least one doctor");
  if (!ids.every((id) => typeof id === "string" && UUID.test(id))) {
    throw new AssignmentError("Some of those doctors no longer exist — refresh the list");
  }
  if (executiveId && !(typeof executiveId === "string" && UUID.test(executiveId))) {
    throw new AssignmentError("That staff member cannot be assigned doctors");
  }
  if (ids.length > MAX_PER_CHANGE) {
    throw new AssignmentError(`Change at most ${MAX_PER_CHANGE} doctors at a time`);
  }
  return withCrmContext(crmUser, async (sql) => {
    let staffName = null;
    if (executiveId) {
      const { rows } = await sql(
        `SELECT full_name FROM crm.users
          WHERE id = $1 AND is_active AND deleted_at IS NULL AND role = ANY($2::text[])`,
        [executiveId, ASSIGNABLE_ROLES],
      );
      if (!rows.length) throw new AssignmentError("That staff member cannot be assigned doctors");
      staffName = rows[0].full_name;
    }
    const { rows: found } = await sql(
      `SELECT id, hospital_id FROM crm.doctors
        WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [ids],
    );
    if (found.length !== ids.length) {
      throw new AssignmentError("Some of those doctors no longer exist — refresh the list");
    }
    const { rows: before } = await sql(
      `SELECT doctor_id FROM crm.doctor_assignments
        WHERE doctor_id = ANY($1::uuid[]) AND effective_to IS NULL
          AND executive_id IS NOT DISTINCT FROM $2::uuid`,
      [ids, executiveId || null],
    );
    const already = new Set(before.map((r) => r.doctor_id));
    const reason = executiveId ? "Assigned on CRM home" : "Owner removed on CRM home";
    await applyAssignments(sql, {
      hospitalId: found[0].hospital_id,
      assignedBy: crmUser.id,
      items: ids.map((doctor_id) => ({
        doctor_id,
        executive_id: executiveId || null,
        reason,
      })),
    });
    return {
      changed: ids.length - already.size,
      unchanged: already.size,
      owner: staffName,
    };
  });
}

export async function assignmentsWorkbook(crmUser, filters = {}) {
  const { params, where } = filterSql(filters);
  const rows = await withCrmContext(crmUser, async (sql) => {
    const { rows: list } = await sql(
      `SELECT ${COLUMNS} ${FROM} WHERE ${where}
        ORDER BY (a.executive_id IS NOT NULL), t.name NULLS LAST, d.full_name`,
      params,
    );
    return list;
  });
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Assignments");
  sheet.columns = [
    { header: "Doctor ID", key: "doctor_id", width: 38, hidden: true },
    { header: "Full name", key: "full_name", width: 30 },
    { header: "Specialty", key: "specialty", width: 22 },
    { header: "Mobile", key: "mobile", width: 14 },
    { header: "Area", key: "area", width: 18 },
    { header: "Territory", key: "territory", width: 16 },
    { header: "Assigned to", key: "owner", width: 22 },
    { header: "Assigned on", key: "assigned_at", width: 18, style: { numFmt: "dd-mmm-yyyy" } },
    { header: "Assigned by", key: "assigned_by", width: 22 },
  ];
  rows.forEach((r) => sheet.addRow(r));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 9 } };
  return { buffer: await book.xlsx.writeBuffer(), count: rows.length };
}
