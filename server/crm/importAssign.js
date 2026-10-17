import crypto from "node:crypto";
import { withCrmContext } from "./db.js";
import { previewBatch, resolveTerritoryName } from "./importDoctors.js";
import { ASSIGNABLE_ROLES, ASSIGNING_ROLES } from "./assignees.js";
import { applyAssignments } from "./assignments.js";

const CHUNK = 100;
const PAGE_SIZE = 50;
const WRITABLE = ["create", "possible_duplicate", "assign"];

export class ImportAssignError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function assertCanAssign(crmUser) {
  if (!ASSIGNING_ROLES.includes(crmUser?.role)) {
    throw new ImportAssignError("Only an admin or the head of growth can assign doctors", 403);
  }
}

const FILTERS = {
  all: "TRUE",
  assign:
    "r.outcome = 'assign' OR (r.outcome IN ('create','possible_duplicate') AND r.assignee_id IS NOT NULL)",
  new: "r.outcome IN ('create','possible_duplicate')",
  unchanged: "r.outcome IN ('unchanged','duplicate')",
  failed: "r.outcome IN ('failed','error') OR r.assign_status = 'failed'",
};

export async function listAssignees(crmUser) {
  return withCrmContext(crmUser, async (sql) => {
    const { rows } = await sql(
      `SELECT id, full_name, role FROM crm.users
        WHERE is_active AND deleted_at IS NULL AND role = ANY($1::text[])
        ORDER BY full_name`,
      [ASSIGNABLE_ROLES],
    );
    return rows;
  });
}

export async function resolveBatch(crmUser, batchId) {
  const preview = await previewBatch(crmUser, batchId);
  const records = preview.rows.map((r) => ({
    row_number: r.row_number,
    normalized: r.values,
    outcome: r.status,
    flags: r.flags,
    matched_doctor_id: r.matched_doctor?.id ?? null,
    doctor_match: r.doctor_match,
    assignee_typed: r.assignee_typed,
    assignee_id: r.assignee?.id ?? null,
    assignee_note: r.assignee_note,
    assign_status: !r.assignee_typed
      ? null
      : r.status === "failed"
        ? "failed"
        : r.status === "unchanged"
          ? "unchanged"
          : "pending",
    fail_reason:
      r.status === "failed" ? r.fail_reason : r.status === "error" ? r.errors.join("; ") : null,
    suggested_assignee_id: r.suggestion?.id ?? null,
  }));

  for (let start = 0; start < records.length; start += CHUNK) {
    await withCrmContext(crmUser, (sql) =>
      sql(
        `UPDATE crm.import_rows r
            SET normalized = x.normalized, outcome = x.outcome, flags = x.flags,
                matched_doctor_id = x.matched_doctor_id, doctor_match = x.doctor_match,
                assignee_typed = x.assignee_typed, assignee_id = x.assignee_id,
                assignee_note = x.assignee_note, assign_status = x.assign_status,
                fail_reason = x.fail_reason, suggested_assignee_id = x.suggested_assignee_id
           FROM jsonb_to_recordset($2::jsonb) AS x(
                  row_number int, normalized jsonb, outcome text, flags jsonb,
                  matched_doctor_id uuid, doctor_match text, assignee_typed text,
                  assignee_id uuid, assignee_note text, assign_status text,
                  fail_reason text, suggested_assignee_id uuid)
          WHERE r.batch_id = $1 AND r.row_number = x.row_number AND r.status = 'pending'`,
        [batchId, JSON.stringify(records.slice(start, start + CHUNK))],
      ),
    );
  }
  return batchSummary(crmUser, batchId);
}

export async function batchSummary(crmUser, batchId) {
  return withCrmContext(crmUser, async (sql) => {
    const { rows: batches } = await sql(
      `SELECT id, file_name, total_rows, status, created_count, updated_count, skipped_count, error_count
         FROM crm.import_batches WHERE id = $1`,
      [batchId],
    );
    if (!batches[0]) throw new ImportAssignError("Import not found", 404);
    const { rows: counts } = await sql(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ${FILTERS.assign})::int AS assign,
              count(*) FILTER (WHERE ${FILTERS.new})::int AS new,
              count(*) FILTER (WHERE ${FILTERS.unchanged})::int AS unchanged,
              count(*) FILTER (WHERE ${FILTERS.failed})::int AS failed,
              count(*) FILTER (WHERE r.status = 'pending' AND r.outcome = ANY($2::text[]))::int AS pending,
              count(*) FILTER (WHERE r.status = 'created')::int AS created,
              count(*) FILTER (WHERE r.assign_status = 'assigned')::int AS assigned,
              count(*) FILTER (WHERE r.outcome IS NULL)::int AS unresolved
         FROM crm.import_rows r WHERE r.batch_id = $1`,
      [batchId, WRITABLE],
    );
    const { rows: byAssignee } = await sql(
      `SELECT u.id, u.full_name, count(*)::int AS rows,
              count(*) FILTER (WHERE r.assign_status = 'assigned')::int AS assigned
         FROM crm.import_rows r JOIN crm.users u ON u.id = r.assignee_id
        WHERE r.batch_id = $1 AND r.outcome IN ('assign','create','possible_duplicate')
          AND COALESCE(r.assign_status, '') <> 'failed'
        GROUP BY u.id, u.full_name ORDER BY u.full_name`,
      [batchId],
    );
    return { batch: batches[0], counts: counts[0], by_assignee: byAssignee };
  });
}

export async function pagedPreview(crmUser, batchId, { status = "all", q = "", page = 1 } = {}) {
  const filter = FILTERS[status] ?? FILTERS.all;
  const term = String(q || "").trim();
  const pageNo = Math.max(1, Number(page) || 1);
  return withCrmContext(crmUser, async (sql) => {
    const params = [batchId];
    let search = "";
    if (term) {
      params.push(`%${term}%`);
      search = `AND (r.normalized->>'full_name' ILIKE $2 OR r.normalized->>'mobile' ILIKE $2
                     OR r.assignee_typed ILIKE $2 OR r.raw::text ILIKE $2)`;
    }
    const { rows: total } = await sql(
      `SELECT count(*)::int AS n FROM crm.import_rows r
        WHERE r.batch_id = $1 AND (${filter}) ${search}`,
      params,
    );
    const { rows } = await sql(
      `SELECT r.row_number, r.normalized AS values, r.outcome, r.flags, r.status AS row_status,
              r.doctor_match, r.assignee_typed, r.assignee_note, r.assign_status, r.fail_reason,
              r.matched_doctor_id,
              CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id', a.id, 'full_name', a.full_name) END AS assignee,
              CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('id', s.id, 'full_name', s.full_name) END AS suggestion,
              CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object('id', o.id, 'full_name', o.full_name) END AS current_owner,
              d.full_name AS matched_name
         FROM crm.import_rows r
         LEFT JOIN crm.users a ON a.id = r.assignee_id
         LEFT JOIN crm.users s ON s.id = r.suggested_assignee_id
         LEFT JOIN crm.doctors d ON d.id = r.matched_doctor_id
         LEFT JOIN crm.doctor_assignments da ON da.doctor_id = r.matched_doctor_id AND da.effective_to IS NULL
         LEFT JOIN crm.users o ON o.id = da.executive_id
        WHERE r.batch_id = $1 AND (${filter}) ${search}
        ORDER BY r.row_number
        LIMIT ${PAGE_SIZE} OFFSET ${(pageNo - 1) * PAGE_SIZE}`,
      params,
    );
    return {
      rows,
      page: pageNo,
      page_size: PAGE_SIZE,
      total: total[0].n,
      pages: Math.max(1, Math.ceil(total[0].n / PAGE_SIZE)),
    };
  });
}

async function settleNonWritable(sql, batchId, skipRows) {
  if (skipRows.length) {
    await sql(
      `UPDATE crm.import_rows
          SET status = 'skipped_duplicate',
              assign_status = CASE WHEN assign_status = 'pending' THEN 'skipped' ELSE assign_status END
        WHERE batch_id = $1 AND status = 'pending' AND row_number = ANY($2::int[])
          AND outcome = ANY($3::text[])`,
      [batchId, skipRows, WRITABLE],
    );
  }
  await sql(
    `UPDATE crm.import_rows
        SET status = CASE WHEN outcome IN ('failed','error') THEN 'error' ELSE 'skipped_duplicate' END
      WHERE batch_id = $1 AND status = 'pending' AND outcome IS NOT NULL
        AND NOT (outcome = ANY($2::text[]))`,
    [batchId, WRITABLE],
  );
}

async function writeChunk(sql, crmUser, batch, rows) {
  const { rows: hos } = await sql("SELECT id FROM crm.hospitals WHERE code = 'GACH'");
  const hospitalId = hos[0]?.id;
  const { rows: terr } = await sql("SELECT id, name FROM crm.territories WHERE deleted_at IS NULL");
  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const territoryId = (name) => terr.find((t) => norm(t.name) === norm(name))?.id ?? null;

  const creates = rows
    .filter((r) => r.outcome !== "assign")
    .map((r) => {
      const v = r.normalized;
      return {
        id: crypto.randomUUID(),
        row_number: r.row_number,
        full_name: v.full_name,
        specialty: v.specialty,
        sub_specialty: v.sub_specialty,
        qualifications: v.qualifications,
        clinic_name: v.clinic_name,
        mobile: v.mobile,
        clinic_phone: v.clinic_phone,
        whatsapp: v.whatsapp,
        email: v.email,
        area: v.area,
        address_line: v.address_line,
        city: v.city,
        district: v.district,
        state: v.state,
        pin_code: v.pin_code,
        territory_id: territoryId(resolveTerritoryName(v.territory || v.area)),
        priority: v.priority,
        notes: v.notes,
        needs_verification: !!v.needs_verification,
        verification_note: v.verification_note,
      };
    });

  if (creates.length) {
    await sql(
      `INSERT INTO crm.doctors
         (id, hospital_id, full_name, specialty, sub_specialty, qualifications, clinic_name,
          mobile, clinic_phone, whatsapp, email, area, address_line, city, district, state, pin_code,
          territory_id, priority, notes, needs_verification, verification_note,
          import_batch_id, created_by)
       SELECT x.id, $2, x.full_name, x.specialty, x.sub_specialty, x.qualifications, x.clinic_name,
              x.mobile, x.clinic_phone, x.whatsapp, x.email, x.area, x.address_line, x.city,
              x.district, x.state, x.pin_code, x.territory_id, x.priority, x.notes,
              x.needs_verification, x.verification_note, $3, $4
         FROM jsonb_to_recordset($1::jsonb) AS x(
                id uuid, full_name text, specialty text, sub_specialty text, qualifications text,
                clinic_name text, mobile text, clinic_phone text, whatsapp text, email text,
                area text, address_line text, city text, district text, state text, pin_code text,
                territory_id uuid, priority text, notes text, needs_verification boolean,
                verification_note text)`,
      [JSON.stringify(creates), hospitalId, batch.id, crmUser.id],
    );
    await sql(
      `UPDATE crm.import_rows r SET status = 'created', matched_doctor_id = x.id
         FROM jsonb_to_recordset($2::jsonb) AS x(row_number int, id uuid)
        WHERE r.batch_id = $1 AND r.row_number = x.row_number`,
      [batch.id, JSON.stringify(creates.map(({ row_number, id }) => ({ row_number, id })))],
    );
  }

  const createdId = new Map(creates.map((c) => [c.row_number, c.id]));
  const wanted = rows
    .filter((r) => r.assignee_id)
    .map((r) => ({
      row_number: r.row_number,
      doctor_id: createdId.get(r.row_number) ?? r.matched_doctor_id,
      executive_id: r.assignee_id,
    }));

  if (wanted.length) {
    const fresh = await applyAssignments(sql, {
      hospitalId,
      assignedBy: crmUser.id,
      items: wanted.map((w) => ({
        doctor_id: w.doctor_id,
        executive_id: w.executive_id,
        reason: `Import ${batch.file_name || "sheet"}, row ${w.row_number}`,
      })),
    });
    await sql(
      `UPDATE crm.import_rows r
          SET assign_status = CASE WHEN x.fresh THEN 'assigned' ELSE 'unchanged' END,
              status = CASE WHEN r.status = 'pending' THEN 'updated' ELSE r.status END
         FROM jsonb_to_recordset($2::jsonb) AS x(row_number int, fresh boolean)
        WHERE r.batch_id = $1 AND r.row_number = x.row_number`,
      [
        batch.id,
        JSON.stringify(
          wanted.map((w) => ({ row_number: w.row_number, fresh: fresh.has(w.doctor_id) })),
        ),
      ],
    );
  }
}

async function finishBatch(sql, batchId) {
  await sql(
    `UPDATE crm.import_batches b
        SET created_count = s.created, updated_count = s.updated,
            skipped_count = s.skipped, error_count = s.errored,
            status = CASE WHEN s.pending = 0 THEN 'completed' ELSE 'importing' END,
            started_at = COALESCE(b.started_at, now()),
            completed_at = CASE WHEN s.pending = 0 THEN now() ELSE NULL END,
            updated_at = now()
       FROM (SELECT count(*) FILTER (WHERE status = 'created')::int AS created,
                    count(*) FILTER (WHERE status = 'updated')::int AS updated,
                    count(*) FILTER (WHERE status = 'skipped_duplicate')::int AS skipped,
                    count(*) FILTER (WHERE status = 'error')::int AS errored,
                    count(*) FILTER (WHERE status = 'pending')::int AS pending
               FROM crm.import_rows WHERE batch_id = $1) s
      WHERE b.id = $1`,
    [batchId],
  );
}

export async function commitChunk(crmUser, batchId, { skipRows = [], onlyRows = null } = {}) {
  await withCrmContext(crmUser, async (sql) => {
    const { rows: batches } = await sql(
      "SELECT id, file_name FROM crm.import_batches WHERE id = $1",
      [batchId],
    );
    if (!batches[0]) throw new ImportAssignError("Import not found", 404);
    const { rows: unresolved } = await sql(
      "SELECT 1 FROM crm.import_rows WHERE batch_id = $1 AND outcome IS NULL AND status = 'pending' LIMIT 1",
      [batchId],
    );
    if (unresolved.length) throw new ImportAssignError("Build the preview before importing");

    if (!onlyRows) await settleNonWritable(sql, batchId, skipRows.map(Number));
    const { rows } = await sql(
      `SELECT row_number, normalized, outcome, matched_doctor_id, assignee_id
         FROM crm.import_rows
        WHERE batch_id = $1 AND status = 'pending' AND outcome = ANY($2::text[])
          AND ($3::int[] IS NULL OR row_number = ANY($3::int[]))
        ORDER BY row_number
        LIMIT ${CHUNK}
        FOR UPDATE`,
      [batchId, WRITABLE, onlyRows],
    );
    if (rows.length) await writeChunk(sql, crmUser, batches[0], rows);
    await finishBatch(sql, batchId);
  });
  return batchSummary(crmUser, batchId);
}

export async function pickAssignee(crmUser, batchId, { row_number, assignee_id }) {
  const rowNumber = Number(row_number);
  if (!rowNumber || !assignee_id) throw new ImportAssignError("Choose a staff member");
  await withCrmContext(crmUser, async (sql) => {
    const { rows: staff } = await sql(
      `SELECT id FROM crm.users WHERE id = $1 AND is_active AND deleted_at IS NULL
          AND role = ANY($2::text[])`,
      [assignee_id, ASSIGNABLE_ROLES],
    );
    if (!staff.length) {
      throw new ImportAssignError("That staff member cannot be assigned doctors");
    }
    const { rowCount } = await sql(
      `UPDATE crm.import_rows r
          SET assignee_id = $3,
              assignee_note = 'Chosen in preview',
              fail_reason = NULL,
              suggested_assignee_id = NULL,
              flags = (SELECT COALESCE(jsonb_agg(f), '[]'::jsonb)
                         FROM jsonb_array_elements_text(r.flags) f
                        WHERE f NOT LIKE 'Check spelling%'
                          AND f NOT LIKE 'Matched by first name%'
                          AND f NOT LIKE 'Matched by surname%'),
              outcome = CASE
                WHEN r.doctor_match = 'new' THEN 'create'
                WHEN EXISTS (SELECT 1 FROM crm.doctor_assignments a
                              WHERE a.doctor_id = r.matched_doctor_id AND a.effective_to IS NULL
                                AND a.executive_id = $3) THEN 'unchanged'
                ELSE 'assign' END,
              assign_status = CASE
                WHEN r.doctor_match <> 'new' AND EXISTS (
                  SELECT 1 FROM crm.doctor_assignments a
                   WHERE a.doctor_id = r.matched_doctor_id AND a.effective_to IS NULL
                     AND a.executive_id = $3) THEN 'unchanged'
                ELSE 'pending' END
        WHERE r.batch_id = $1 AND r.row_number = $2
          AND r.status = 'pending' AND r.doctor_match IS NOT NULL`,
      [batchId, rowNumber, assignee_id],
    );
    if (!rowCount) {
      throw new ImportAssignError("That row can no longer be changed — refresh the preview");
    }
  });
  return batchSummary(crmUser, batchId);
}

export async function retryRows(crmUser, batchId, picks) {
  const chosen = (picks || [])
    .map((p) => ({ row_number: Number(p.row_number), assignee_id: p.assignee_id }))
    .filter((p) => p.row_number && p.assignee_id)
    .slice(0, CHUNK);
  if (!chosen.length) throw new ImportAssignError("Choose a staff member for at least one row");

  const reopened = await withCrmContext(crmUser, async (sql) => {
    const { rows: staff } = await sql(
      `SELECT id FROM crm.users WHERE id = ANY($1::uuid[]) AND is_active AND deleted_at IS NULL
          AND role = ANY($2::text[])`,
      [chosen.map((c) => c.assignee_id), ASSIGNABLE_ROLES],
    );
    const allowed = new Set(staff.map((s) => s.id));
    const valid = chosen.filter((c) => allowed.has(c.assignee_id));
    if (valid.length !== chosen.length) {
      throw new ImportAssignError("One of the chosen staff members cannot be assigned doctors");
    }
    const { rows } = await sql(
      `UPDATE crm.import_rows r
          SET assignee_id = x.assignee_id,
              assignee_note = 'Chosen after import',
              fail_reason = NULL,
              suggested_assignee_id = NULL,
              assign_status = 'pending',
              status = 'pending',
              outcome = CASE
                WHEN r.doctor_match = 'new' THEN 'create'
                WHEN EXISTS (SELECT 1 FROM crm.doctor_assignments a
                              WHERE a.doctor_id = r.matched_doctor_id AND a.effective_to IS NULL
                                AND a.executive_id = x.assignee_id) THEN 'unchanged'
                ELSE 'assign' END
         FROM jsonb_to_recordset($2::jsonb) AS x(row_number int, assignee_id uuid)
        WHERE r.batch_id = $1 AND r.row_number = x.row_number
          AND r.assign_status = 'failed' AND r.doctor_match IS NOT NULL
          AND r.status IN ('pending','error')
        RETURNING r.row_number, r.outcome`,
      [batchId, JSON.stringify(valid)],
    );
    await sql(
      `UPDATE crm.import_rows SET status = 'skipped_duplicate', assign_status = 'unchanged'
        WHERE batch_id = $1 AND status = 'pending' AND outcome = 'unchanged'
          AND row_number = ANY($2::int[])`,
      [batchId, rows.map((r) => r.row_number)],
    );
    return rows.map((r) => r.row_number);
  });

  if (!reopened.length) {
    throw new ImportAssignError("Those rows can no longer be retried — refresh the list");
  }
  return commitChunk(crmUser, batchId, { onlyRows: reopened });
}

export async function failedRows(crmUser, batchId) {
  return withCrmContext(crmUser, async (sql) => {
    const { rows: batches } = await sql(
      "SELECT file_name, headers FROM crm.import_batches WHERE id = $1",
      [batchId],
    );
    if (!batches[0]) throw new ImportAssignError("Import not found", 404);
    const { rows } = await sql(
      `SELECT r.row_number, r.raw, r.fail_reason, s.full_name AS suggested
         FROM crm.import_rows r
         LEFT JOIN crm.users s ON s.id = r.suggested_assignee_id
        WHERE r.batch_id = $1 AND (${FILTERS.failed})
        ORDER BY r.row_number`,
      [batchId],
    );
    const headers = Array.isArray(batches[0].headers)
      ? batches[0].headers
      : [...new Set(rows.flatMap((r) => Object.keys(r.raw || {})))];
    return { fileName: batches[0].file_name, headers, rows };
  });
}
