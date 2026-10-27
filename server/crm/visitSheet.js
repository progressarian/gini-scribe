import crypto from "node:crypto";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import { withCrmContext } from "./db.js";
import { VISIT_DUE_CTE } from "./visitDue.js";
import { syncVisitTasks, visitsUndone } from "./tasks.js";
import { lockRepVisits } from "./visits.js";
import { ASSIGNABLE_ROLES, ASSIGNING_ROLES } from "./assignees.js";
import {
  VISIT_TYPES,
  VISIT_OUTCOMES,
  VISIT_SHEET_STATUSES,
  VISIT_ROW_STATE_VALUES,
} from "../../shared/crmVocab.js";
import {
  IST_MONTH_START,
  IST_TODAY,
  ddmmyyyy,
  addDays,
  istDate,
  istDayOf,
  periodCounts,
  uploadWindow,
} from "./istPeriods.js";

const CHUNK = 100;
const STAGE_CHUNK = 200;
const PAGE_SIZE = 50;
const MAX_ROWS = 2000;
const MAX_NOTES = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class VisitSheetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const FIELDS = {
  doctor_id: ["doctorid", "id"],
  doctor: ["doctor", "doctorname", "name", "fullname", "drname"],
  mobile: ["mobile", "phone", "mobileno", "mobilenumber", "contact"],
  area: ["area", "locality", "location"],
  visit_date: ["visitdate", "date", "visitedon", "dateofvisit"],
  status: ["status", "visitstatus"],
  visit_type: ["visittype", "type"],
  outcome: ["outcome", "result"],
  next_visit: ["nextvisitdate", "nextvisit", "followupdate", "nextdate", "followupby"],
  notes: ["notes", "note", "remarks", "remark", "comments", "discussion"],
};

const SHEET_COLUMNS = [
  { header: "Doctor ID", key: "doctor_id", width: 38, hidden: true },
  { header: "Doctor", key: "full_name", width: 30, given: true },
  { header: "Specialty", key: "specialty", width: 20, given: true },
  { header: "Area", key: "area", width: 18, given: true },
  { header: "Mobile", key: "mobile", width: 14, given: true },
  { header: "Last visit", key: "last_visit", width: 12, given: true },
  { header: "Today", key: "visits_today", width: 8, given: true },
  { header: "This week", key: "visits_week", width: 10, given: true },
  { header: "This month", key: "visits_month", width: 11, given: true },
  { header: "Visit date", key: "visit_date", width: 13 },
  { header: "Status", key: "status", width: 20 },
  { header: "Visit type", key: "visit_type", width: 14 },
  { header: "Outcome", key: "outcome", width: 20 },
  { header: "Next visit date", key: "next_visit", width: 15 },
  { header: "Notes", key: "notes", width: 40 },
];

const STATE_FILTERS = {
  all: "TRUE",
  ready: "r.visit_state = 'ready'",
  imported: "r.visit_state = 'imported'",
  already_logged: "r.visit_state = 'already_logged'",
  failed: "r.visit_state = 'failed'",
  not_visited: "r.visit_state IN ('not_visited', 'not_filled')",
  undone: "r.visit_state = 'undone'",
};

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const text = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};
const nameKey = (s) => norm(String(s ?? "").replace(/^\s*dr\b\.?\s*/i, ""));
const phoneKey = (s) => {
  const digits = String(s ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
};

const byLabel = (list) => {
  const map = new Map();
  for (const item of list) {
    map.set(norm(item.value), item.value);
    map.set(norm(item.label), item.value);
  }
  return map;
};
const STATUS_WORDS = byLabel(VISIT_SHEET_STATUSES);
for (const [word, value] of [
  ["done", "completed"],
  ["visited", "completed"],
  ["complete", "completed"],
  ["unavailable", "doctor_unavailable"],
  ["drunavailable", "doctor_unavailable"],
  ["doctornotavailable", "doctor_unavailable"],
  ["notavailable", "doctor_unavailable"],
  ["notdone", "not_visited"],
  ["pending", "not_visited"],
]) {
  STATUS_WORDS.set(word, value);
}
const TYPE_WORDS = byLabel(VISIT_TYPES);
const OUTCOME_WORDS = byLabel(VISIT_OUTCOMES);

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function validDay(y, m, d) {
  if (y < 100) y += 2000;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const back = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(back.getTime()) && back.toISOString().slice(0, 10) === iso ? iso : null;
}

export function parseVisitDate(value) {
  if (value == null || value === "") return { day: null };
  if (value instanceof Date) return { day: istDate(value) };
  if (typeof value === "number") {
    if (value < 20000 || value > 80000) return { day: null, bad: true };
    const ms = Math.round((value - 25569) * 86400000);
    return { day: new Date(ms).toISOString().slice(0, 10) };
  }
  const t = String(value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return { day: validDay(+m[1], +m[2], +m[3]), bad: !validDay(+m[1], +m[2], +m[3]) };
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t);
  if (m) {
    const day = validDay(+m[3], +m[2], +m[1]);
    return { day, bad: !day };
  }
  m = /^(\d{1,2})[-\s/]([a-z]{3})[a-z]*[-\s/,]+(\d{2}|\d{4})$/i.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const day = validDay(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    return { day, bad: !day };
  }
  return { day: null, bad: true };
}

export function parseVisitSheet(buffer) {
  let book;
  try {
    book = XLSX.read(buffer, { type: "buffer", raw: true, cellDates: false });
  } catch {
    throw new VisitSheetError("Unable to read that file. Upload the Excel sheet you downloaded.");
  }
  const name = book.SheetNames.find((n) => norm(n) === "visits") ?? book.SheetNames[0];
  const sheet = name && book.Sheets[name];
  if (!sheet) throw new VisitSheetError("That file has no readable sheet.");
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
  const headers = Object.keys(rows[0] || {});
  const mapping = {};
  for (const header of headers) {
    const h = norm(header);
    const field = Object.keys(FIELDS).find((f) => !mapping[f] && FIELDS[f].includes(h));
    if (field) mapping[field] = header;
  }
  if (!rows.length) throw new VisitSheetError("That sheet has no rows.");
  if (!mapping.visit_date || !mapping.status) {
    throw new VisitSheetError(
      "This sheet needs a “Visit date” and a “Status” column. Download your sheet from CRM home and fill it in.",
    );
  }
  if (!mapping.doctor_id && !mapping.doctor && !mapping.mobile) {
    throw new VisitSheetError(
      "This sheet needs a “Doctor” or “Doctor ID” column to know which doctor each visit was to.",
    );
  }
  if (rows.length > MAX_ROWS) {
    throw new VisitSheetError(
      `A sheet can have at most ${MAX_ROWS} rows. Split it and upload each part.`,
    );
  }
  return { headers, mapping, rows };
}

function typedRow(raw, mapping) {
  const get = (f) => (mapping[f] ? raw[mapping[f]] : "");
  const date = get("visit_date");
  const next = get("next_visit");
  return {
    doctor_id: text(get("doctor_id")),
    doctor: text(get("doctor")),
    mobile: text(get("mobile")),
    area: text(get("area")),
    visit_date: typeof date === "number" ? date : text(date),
    status: text(get("status")),
    visit_type: text(get("visit_type")),
    outcome: text(get("outcome")),
    next_visit: typeof next === "number" ? next : text(next),
    notes: text(get("notes")),
  };
}

function matchDoctor(row, doctors) {
  if (row.doctor_id) {
    const hit = UUID.test(row.doctor_id) && doctors.byId.get(row.doctor_id.toLowerCase());
    if (hit) return { doctor: hit, by: "id" };
    return { fail: "This doctor is not assigned to you, or was removed from the CRM." };
  }
  const phone = phoneKey(row.mobile);
  if (phone) {
    const hits = doctors.list.filter((d) => phoneKey(d.mobile) === phone);
    if (hits.length === 1) return { doctor: hits[0], by: "mobile" };
  }
  const key = nameKey(row.doctor);
  if (!key) return { fail: "Enter the doctor's name or Doctor ID." };
  let hits = doctors.list.filter((d) => nameKey(d.full_name) === key);
  if (hits.length > 1 && row.area) {
    const narrowed = hits.filter((d) => norm(d.area) === norm(row.area));
    if (narrowed.length) hits = narrowed;
  }
  if (hits.length === 1) return { doctor: hits[0], by: "name" };
  if (hits.length > 1) {
    return { fail: `More than one of your doctors is called ${row.doctor}. Pick the doctor.` };
  }
  return { fail: `No doctor of yours is called ${row.doctor}. Pick the doctor.` };
}

export function assessRow(row, ctx) {
  const flags = [];
  const status = row.status ? STATUS_WORDS.get(norm(row.status)) : null;
  const date = parseVisitDate(row.visit_date);
  const base = {
    visit_status: status ?? null,
    visit_date: date.day ?? null,
    visit_type: null,
    visit_outcome: null,
    visit_notes: row.notes ?? null,
    follow_up_required: false,
    next_visit_date: null,
    matched_doctor_id: null,
    doctor_match: null,
    fail_reason: null,
    flags,
  };
  if (!row.status && !row.visit_date) return { ...base, visit_state: "not_filled" };
  if (status === "not_visited") return { ...base, visit_state: "not_visited" };

  const picked = row.picked_doctor_id && ctx.doctors.byId.get(row.picked_doctor_id);
  const match = picked ? { doctor: picked, by: "id" } : matchDoctor(row, ctx.doctors);
  if (match.doctor) {
    base.matched_doctor_id = match.doctor.id;
    base.doctor_match = match.by;
  }

  const reasons = [];
  if (!row.status) reasons.push("Choose a Status: Completed, Doctor unavailable or Not visited.");
  else if (!status) reasons.push("Status must be Completed, Doctor unavailable or Not visited.");
  if (match.fail) reasons.push(match.fail);
  if (!row.visit_date) reasons.push("Enter the visit date.");
  else if (!date.day) reasons.push("Visit date must be a date like 21-10-2026.");
  else if (date.day > ctx.window.to) reasons.push("Visit date is in the future.");
  else if (date.day < ctx.window.from) {
    reasons.push(
      `Only visits from ${ddmmyyyy(ctx.window.from)} to today can be uploaded (this month and this week).`,
    );
  }

  const type = row.visit_type ? TYPE_WORDS.get(norm(row.visit_type)) : "in_person";
  if (!type) reasons.push("Choose a visit type from the list.");
  base.visit_type = type ?? null;

  let outcome = row.outcome ? OUTCOME_WORDS.get(norm(row.outcome)) : null;
  if (row.outcome && !outcome) reasons.push("Choose an outcome from the list.");
  if (status === "doctor_unavailable") {
    if (outcome && outcome !== "doctor_unavailable") {
      flags.push("Status is Doctor unavailable, so the outcome was set to Doctor unavailable");
    }
    outcome = "doctor_unavailable";
  }
  base.visit_outcome = outcome ?? null;

  if (row.notes && row.notes.length > MAX_NOTES) {
    reasons.push(`Notes are too long (max ${MAX_NOTES.toLocaleString("en-IN")} characters).`);
  }

  if (row.next_visit) {
    const next = parseVisitDate(row.next_visit);
    if (!next.day) reasons.push("Next visit date must be a date like 21-10-2026.");
    else if (date.day && next.day <= date.day) {
      reasons.push("Next visit date must be after the visit date.");
    } else if (date.day && next.day > addDays(date.day, 365)) {
      reasons.push("Next visit date must be within a year of the visit.");
    } else {
      base.next_visit_date = next.day;
      base.follow_up_required = true;
    }
  }

  if (reasons.length) return { ...base, visit_state: "failed", fail_reason: reasons.join(" ") };

  const key = `${match.doctor.id}|${date.day}`;
  if (ctx.taken.has(key)) {
    return {
      ...base,
      visit_state: "already_logged",
      fail_reason: `Already logged: a visit to ${match.doctor.full_name} on ${ddmmyyyy(date.day)}.`,
    };
  }
  ctx.taken.add(key);
  return { ...base, visit_state: "ready" };
}

async function hospitalId(sql) {
  const { rows } = await sql("SELECT id FROM crm.hospitals WHERE code = 'GACH'");
  return rows[0]?.id;
}

async function myDoctors(sql, crmUser) {
  const { rows } = await sql(
    `SELECT d.id, d.full_name, d.specialty, d.area, d.mobile
       FROM crm.doctors d
       JOIN crm.doctor_assignments a ON a.doctor_id = d.id AND a.effective_to IS NULL
      WHERE a.executive_id = $1 AND d.deleted_at IS NULL AND d.is_active
      ORDER BY d.full_name, d.id`,
    [crmUser.id],
  );
  return { list: rows, byId: new Map(rows.map((d) => [d.id, d])) };
}

async function takenDays(sql, crmUser, window, alsoTaken = []) {
  const { rows } = await sql(
    `SELECT doctor_id, ${istDayOf("occurred_at")}::text AS day
       FROM crm.visits
      WHERE deleted_at IS NULL AND executive_id = $1
        AND ${istDayOf("occurred_at")} BETWEEN $2::date AND $3::date`,
    [crmUser.id, window.from, window.to],
  );
  const taken = new Set(rows.map((r) => `${r.doctor_id}|${r.day}`));
  for (const r of alsoTaken) taken.add(`${r.matched_doctor_id}|${r.visit_date}`);
  return taken;
}

const UNUSABLE = ["pending", "failed"];

async function usableBatch(sql, crmUser, batchId) {
  const batch = await ownBatch(sql, crmUser, batchId);
  if (UNUSABLE.includes(batch.status)) {
    throw new VisitSheetError("This upload did not finish reading. Upload the sheet again.", 409);
  }
  if (batch.status === "cancelled") {
    throw new VisitSheetError("This upload was undone. Upload the sheet again.", 409);
  }
  return batch;
}

async function ownBatch(sql, crmUser, batchId) {
  if (!UUID.test(String(batchId || ""))) throw new VisitSheetError("Upload not found", 404);
  const { rows } = await sql(
    `SELECT id, file_name, headers, status, total_rows, created_at,
            ${istDayOf("created_at")}::text AS upload_day
       FROM crm.import_batches
      WHERE id = $1 AND kind = 'visits' AND uploaded_by = $2`,
    [batchId, crmUser.id],
  );
  if (!rows[0]) throw new VisitSheetError("Upload not found", 404);
  return rows[0];
}

export async function assertDoctorBatch(crmUser, batchId) {
  if (!UUID.test(String(batchId || ""))) throw new VisitSheetError("Import not found", 404);
  await withCrmContext(crmUser, async (sql) => {
    const { rows } = await sql(
      "SELECT 1 FROM crm.import_batches WHERE id = $1 AND kind = 'doctors'",
      [batchId],
    );
    if (!rows.length) throw new VisitSheetError("Import not found", 404);
  });
}

export async function createVisitBatch(crmUser, { fileName, buffer }) {
  const { headers, mapping, rows } = parseVisitSheet(buffer);
  const window = uploadWindow();
  const batch = await withCrmContext(crmUser, async (sql) => {
    const doctors = await myDoctors(sql, crmUser);
    const ctx = { doctors, window, taken: await takenDays(sql, crmUser, window) };
    const staged = rows.map((raw, i) => {
      const typed = typedRow(raw, mapping);
      const rowNumber = Number.isInteger(raw.__rowNum__) ? raw.__rowNum__ + 1 : i + 2;
      return { row_number: rowNumber, raw, normalized: typed, ...assessRow(typed, ctx) };
    });
    const { rows: created } = await sql(
      `INSERT INTO crm.import_batches
         (hospital_id, uploaded_by, file_name, column_mapping, headers, total_rows, kind, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'visits', 'pending')
       RETURNING id`,
      [
        await hospitalId(sql),
        crmUser.id,
        String(fileName || "visits.xlsx").slice(0, 200),
        JSON.stringify(mapping),
        JSON.stringify(headers),
        rows.length,
      ],
    );
    return { id: created[0].id, staged };
  });

  try {
    for (let start = 0; start < batch.staged.length; start += STAGE_CHUNK) {
      await stageRows(crmUser, batch.id, batch.staged.slice(start, start + STAGE_CHUNK));
    }
  } catch (e) {
    await withCrmContext(crmUser, (sql) =>
      sql("UPDATE crm.import_batches SET status = 'failed', updated_at = now() WHERE id = $1", [
        batch.id,
      ]),
    ).catch(() => {});
    throw e;
  }
  await withCrmContext(crmUser, (sql) =>
    sql("UPDATE crm.import_batches SET status = 'previewing', updated_at = now() WHERE id = $1", [
      batch.id,
    ]),
  );
  return visitBatchSummary(crmUser, batch.id);
}

function stageRows(crmUser, batchId, chunk) {
  return withCrmContext(crmUser, (sql) =>
    sql(
      `INSERT INTO crm.import_rows
           (batch_id, row_number, raw, normalized, flags, matched_doctor_id, doctor_match,
            visit_date, visit_status, visit_type, visit_outcome, visit_notes, visit_state, fail_reason)
         SELECT $1, x.row_number, x.raw,
                x.normalized || jsonb_build_object('follow_up_required', x.follow_up_required,
                                                   'next_visit_date', x.next_visit_date),
                COALESCE(x.flags, '[]'::jsonb),
                x.matched_doctor_id, x.doctor_match, x.visit_date, x.visit_status, x.visit_type,
                x.visit_outcome, x.visit_notes, x.visit_state, x.fail_reason
           FROM jsonb_to_recordset($2::jsonb) AS x(
                  row_number int, raw jsonb, normalized jsonb, flags jsonb,
                  matched_doctor_id uuid, doctor_match text, visit_date date, visit_status text,
                  visit_type text, visit_outcome text, visit_notes text, visit_state text,
                  fail_reason text, follow_up_required boolean, next_visit_date date)`,
      [batchId, JSON.stringify(chunk)],
    ),
  );
}

const COUNTS_SQL = `
  SELECT count(*)::int AS total,
         ${VISIT_ROW_STATE_VALUES.map(
           (s) => `count(*) FILTER (WHERE visit_state = '${s}')::int AS ${s}`,
         ).join(",\n         ")}
    FROM crm.import_rows WHERE batch_id = $1`;

async function summaryIn(sql, crmUser, batchId) {
  const batch = await ownBatch(sql, crmUser, batchId);
  const { rows } = await sql(COUNTS_SQL, [batchId]);
  const { rows: today } = await sql(`SELECT ${IST_TODAY}::text AS d`);
  const counts = rows[0];
  return {
    batch: {
      id: batch.id,
      file_name: batch.file_name,
      status: batch.status,
      created_at: batch.created_at,
      total_rows: batch.total_rows,
    },
    counts,
    window: uploadWindow(),
    can_undo:
      batch.status !== "cancelled" && counts.imported > 0 && batch.upload_day === today[0].d,
    uploader: crmUser.full_name,
  };
}

export async function visitBatchSummary(crmUser, batchId) {
  return withCrmContext(crmUser, (sql) => summaryIn(sql, crmUser, batchId));
}

export async function visitBatchRows(crmUser, batchId, { state = "all", q = "", page = 1 } = {}) {
  const filter = STATE_FILTERS[state] ?? STATE_FILTERS.all;
  const term = String(q ?? "")
    .trim()
    .slice(0, 100);
  return withCrmContext(crmUser, async (sql) => {
    await ownBatch(sql, crmUser, batchId);
    const params = [batchId];
    let search = "";
    if (term) {
      params.push(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      search = `AND (r.normalized->>'doctor' ILIKE $2 OR d.full_name ILIKE $2
                     OR r.normalized->>'mobile' ILIKE $2 OR r.fail_reason ILIKE $2)`;
    }
    const { rows: total } = await sql(
      `SELECT count(*)::int AS n FROM crm.import_rows r
         LEFT JOIN crm.doctors d ON d.id = r.matched_doctor_id
        WHERE r.batch_id = $1 AND (${filter}) ${search}`,
      params,
    );
    const pages = Math.max(1, Math.ceil(total[0].n / PAGE_SIZE));
    const pageNo = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), pages);
    const { rows } = await sql(
      `SELECT r.row_number, r.visit_state, r.visit_status, r.visit_date::text AS visit_date,
              r.visit_type, r.visit_outcome, r.visit_notes, r.fail_reason, r.flags,
              (r.normalized->>'follow_up_required')::boolean AS follow_up_required,
              r.normalized->>'next_visit_date' AS next_visit_date,
              r.doctor_match, r.matched_doctor_id, d.full_name AS doctor_name, d.area AS doctor_area,
              r.normalized->>'doctor' AS typed_doctor, r.normalized->>'visit_date' AS typed_date,
              r.normalized->>'status' AS typed_status
         FROM crm.import_rows r
         LEFT JOIN crm.doctors d ON d.id = r.matched_doctor_id
        WHERE r.batch_id = $1 AND (${filter}) ${search}
        ORDER BY r.row_number
        LIMIT ${PAGE_SIZE} OFFSET ${(pageNo - 1) * PAGE_SIZE}`,
      params,
    );
    return { rows, page: pageNo, pages, page_size: PAGE_SIZE, total: total[0].n };
  });
}

async function finishBatch(sql, batchId) {
  await sql(
    `UPDATE crm.import_batches b
        SET created_count = s.imported,
            skipped_count = s.skipped,
            error_count = s.failed,
            status = CASE WHEN b.status = 'cancelled' THEN b.status
                          WHEN s.ready = 0 THEN 'completed' ELSE 'importing' END,
            started_at = COALESCE(b.started_at, now()),
            completed_at = CASE WHEN s.ready = 0 THEN COALESCE(b.completed_at, now()) ELSE NULL END,
            updated_at = now()
       FROM (SELECT count(*) FILTER (WHERE visit_state = 'imported')::int AS imported,
                    count(*) FILTER (WHERE visit_state IN ('already_logged','not_visited','not_filled'))::int AS skipped,
                    count(*) FILTER (WHERE visit_state = 'failed')::int AS failed,
                    count(*) FILTER (WHERE visit_state = 'ready')::int AS ready
               FROM crm.import_rows WHERE batch_id = $1) s
      WHERE b.id = $1`,
    [batchId],
  );
}

export async function commitVisitChunk(crmUser, batchId, { onlyRows = null } = {}) {
  return withCrmContext(crmUser, async (sql) => {
    await usableBatch(sql, crmUser, batchId);
    await lockRepVisits(sql, crmUser.id);
    const { rows } = await sql(
      `SELECT row_number, matched_doctor_id, visit_date::text AS visit_date, visit_type,
              visit_outcome, visit_notes,
              COALESCE((normalized->>'follow_up_required')::boolean, false) AS follow_up_required,
              normalized->>'next_visit_date' AS next_visit_date
         FROM crm.import_rows
        WHERE batch_id = $1 AND visit_state = 'ready'
          AND ($2::int[] IS NULL OR row_number = ANY($2::int[]))
        ORDER BY row_number
        LIMIT ${CHUNK}
        FOR UPDATE`,
      [batchId, onlyRows],
    );
    if (rows.length) {
      const window = uploadWindow();
      const doctors = await myDoctors(sql, crmUser);
      const taken = await takenDays(sql, crmUser, window);
      const write = [];
      const settle = [];
      for (const r of rows) {
        const key = `${r.matched_doctor_id}|${r.visit_date}`;
        const doctor = doctors.byId.get(r.matched_doctor_id);
        if (!doctor) {
          settle.push({
            row_number: r.row_number,
            state: "failed",
            reason: "This doctor is no longer assigned to you.",
          });
        } else if (r.visit_date > window.to || r.visit_date < window.from) {
          settle.push({
            row_number: r.row_number,
            state: "failed",
            reason: `Only visits from ${ddmmyyyy(window.from)} to today can be uploaded (this month and this week).`,
          });
        } else if (taken.has(key)) {
          settle.push({
            row_number: r.row_number,
            state: "already_logged",
            reason: `Already logged: a visit to ${doctor.full_name} on ${ddmmyyyy(r.visit_date)}.`,
          });
        } else {
          taken.add(key);
          write.push({ ...r, id: crypto.randomUUID() });
        }
      }
      if (write.length) {
        await sql(
          `INSERT INTO crm.visits
             (id, hospital_id, doctor_id, executive_id, visit_type, outcome, discussion_notes,
              follow_up_required, next_visit_date, occurred_at, source, import_batch_id, created_by)
           SELECT x.id, $2, x.matched_doctor_id, $3, x.visit_type, x.visit_outcome, x.visit_notes,
                  x.follow_up_required, x.next_visit_date,
                  LEAST((x.visit_date + time '12:00') AT TIME ZONE 'Asia/Kolkata', now()),
                  'sheet', $1, $3
             FROM jsonb_to_recordset($4::jsonb) AS x(
                    id uuid, matched_doctor_id uuid, visit_type text, visit_outcome text,
                    visit_notes text, visit_date date, follow_up_required boolean,
                    next_visit_date date)`,
          [batchId, await hospitalId(sql), crmUser.id, JSON.stringify(write)],
        );
        await sql(
          `UPDATE crm.import_rows r SET visit_state = 'imported', visit_id = x.id, status = 'created'
             FROM jsonb_to_recordset($2::jsonb) AS x(row_number int, id uuid)
            WHERE r.batch_id = $1 AND r.row_number = x.row_number`,
          [batchId, JSON.stringify(write.map(({ row_number, id }) => ({ row_number, id })))],
        );
        await syncVisitTasks(
          sql,
          write.map((w) => w.id),
        );
      }
      if (settle.length) {
        await sql(
          `UPDATE crm.import_rows r SET visit_state = x.state, fail_reason = x.reason
             FROM jsonb_to_recordset($2::jsonb) AS x(row_number int, state text, reason text)
            WHERE r.batch_id = $1 AND r.row_number = x.row_number`,
          [batchId, JSON.stringify(settle)],
        );
      }
    }
    await finishBatch(sql, batchId);
    return summaryIn(sql, crmUser, batchId);
  });
}

export async function retryVisitRows(crmUser, batchId, fixes) {
  const wanted = (Array.isArray(fixes) ? fixes : [])
    .map((f) => ({
      row_number: Math.trunc(Number(f?.row_number)),
      doctor_id: f?.doctor_id == null || f.doctor_id === "" ? null : String(f.doctor_id),
      visit_date: f?.visit_date == null || f.visit_date === "" ? null : String(f.visit_date),
      status: f?.status == null || f.status === "" ? null : String(f.status),
      next_visit:
        f?.next_visit === undefined ? undefined : f.next_visit ? String(f.next_visit) : null,
    }))
    .filter((f) => f.row_number > 0)
    .slice(0, CHUNK);
  if (!wanted.length) throw new VisitSheetError("Choose at least one row to retry.");
  for (const f of wanted) {
    if (f.doctor_id && !UUID.test(f.doctor_id))
      throw new VisitSheetError("Pick a doctor from your list.");
    if (f.visit_date && !/^\d{4}-\d{2}-\d{2}$/.test(f.visit_date)) {
      throw new VisitSheetError("Visit date must be a date like 21-10-2026.");
    }
    if (f.status && !STATUS_WORDS.has(norm(f.status))) {
      throw new VisitSheetError("Status must be Completed, Doctor unavailable or Not visited.");
    }
    if (f.next_visit && !/^\d{4}-\d{2}-\d{2}$/.test(f.next_visit)) {
      throw new VisitSheetError("Next visit date must be a date like 21-10-2026.");
    }
  }

  const reopened = await withCrmContext(crmUser, async (sql) => {
    await usableBatch(sql, crmUser, batchId);
    const { rows } = await sql(
      `SELECT row_number, normalized FROM crm.import_rows
        WHERE batch_id = $1 AND visit_state IN ('failed','already_logged')
          AND row_number = ANY($2::int[])
        FOR UPDATE`,
      [batchId, wanted.map((f) => f.row_number)],
    );
    if (!rows.length) return [];
    const { rows: queued } = await sql(
      `SELECT matched_doctor_id, visit_date::text AS visit_date FROM crm.import_rows
        WHERE batch_id = $1 AND visit_state = 'ready'`,
      [batchId],
    );
    const window = uploadWindow();
    const ctx = {
      doctors: await myDoctors(sql, crmUser),
      window,
      taken: await takenDays(sql, crmUser, window, queued),
    };
    const updates = rows.map((r) => {
      const fix = wanted.find((f) => f.row_number === r.row_number);
      const typed = {
        ...r.normalized,
        ...(fix.visit_date ? { visit_date: fix.visit_date } : {}),
        ...(fix.status ? { status: fix.status } : {}),
        ...(fix.next_visit !== undefined ? { next_visit: fix.next_visit } : {}),
        picked_doctor_id: fix.doctor_id ?? r.normalized?.picked_doctor_id ?? null,
      };
      if (fix.doctor_id && !ctx.doctors.byId.has(fix.doctor_id)) {
        throw new VisitSheetError("That doctor is not assigned to you.");
      }
      return { row_number: r.row_number, normalized: typed, ...assessRow(typed, ctx) };
    });
    await sql(
      `UPDATE crm.import_rows r
          SET normalized = x.normalized || jsonb_build_object(
                'follow_up_required', x.follow_up_required, 'next_visit_date', x.next_visit_date),
              flags = COALESCE(x.flags, '[]'::jsonb),
              matched_doctor_id = x.matched_doctor_id, doctor_match = x.doctor_match,
              visit_date = x.visit_date, visit_status = x.visit_status, visit_type = x.visit_type,
              visit_outcome = x.visit_outcome, visit_notes = x.visit_notes,
              visit_state = x.visit_state, fail_reason = x.fail_reason
         FROM jsonb_to_recordset($2::jsonb) AS x(
                row_number int, normalized jsonb, flags jsonb, matched_doctor_id uuid,
                doctor_match text, visit_date date, visit_status text, visit_type text,
                visit_outcome text, visit_notes text, visit_state text, fail_reason text,
                follow_up_required boolean, next_visit_date date)
        WHERE r.batch_id = $1 AND r.row_number = x.row_number`,
      [batchId, JSON.stringify(updates)],
    );
    return updates;
  });

  if (!reopened.length) {
    throw new VisitSheetError("Those rows can no longer be retried. Refresh the list.", 409);
  }
  const ready = reopened.filter((r) => r.visit_state === "ready").map((r) => r.row_number);
  const summary = ready.length
    ? await commitVisitChunk(crmUser, batchId, { onlyRows: ready })
    : await withCrmContext(crmUser, async (sql) => {
        await finishBatch(sql, batchId);
        return summaryIn(sql, crmUser, batchId);
      });
  return {
    ...summary,
    retried: reopened.map((r) => ({
      row_number: r.row_number,
      visit_state: r.visit_state,
      fail_reason: r.fail_reason,
    })),
  };
}

export async function undoVisitBatch(crmUser, batchId) {
  return withCrmContext(crmUser, async (sql) => {
    const batch = await ownBatch(sql, crmUser, batchId);
    const { rows: today } = await sql(`SELECT ${IST_TODAY}::text AS d`);
    if (batch.status === "cancelled")
      throw new VisitSheetError("This upload was already undone.", 409);
    if (batch.upload_day !== today[0].d) {
      throw new VisitSheetError("An upload can only be undone on the day it was made.", 409);
    }
    await lockRepVisits(sql, crmUser.id);
    const { rows: undone } = await sql(
      `UPDATE crm.visits SET deleted_at = now(), updated_at = now()
        WHERE import_batch_id = $1 AND source = 'sheet' AND executive_id = $2 AND deleted_at IS NULL
        RETURNING id`,
      [batchId, crmUser.id],
    );
    const rowCount = undone.length;
    await visitsUndone(
      sql,
      undone.map((v) => v.id),
    );
    await sql(
      `UPDATE crm.import_rows SET visit_state = 'undone'
        WHERE batch_id = $1 AND visit_state IN ('imported', 'ready')`,
      [batchId],
    );
    await sql(
      `UPDATE crm.import_batches SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [batchId],
    );
    return { undone: rowCount, summary: await summaryIn(sql, crmUser, batchId) };
  });
}

export async function myVisitBatches(crmUser) {
  return withCrmContext(crmUser, async (sql) => {
    const { rows } = await sql(
      `SELECT b.id, b.file_name, b.status, b.created_at, b.total_rows,
              b.created_count AS imported, b.skipped_count AS skipped, b.error_count AS failed,
              (b.status <> 'cancelled' AND b.created_count > 0
                AND ${istDayOf("b.created_at")} = ${IST_TODAY}) AS can_undo
         FROM crm.import_batches b
        WHERE b.kind = 'visits' AND b.uploaded_by = $1
          AND b.created_count > 0
        ORDER BY b.created_at DESC
        LIMIT 10`,
      [crmUser.id],
    );
    return rows;
  });
}

export async function pickableDoctors(crmUser, q = "") {
  const term = nameKey(String(q ?? "").slice(0, 100));
  return withCrmContext(crmUser, async (sql) => {
    const doctors = await myDoctors(sql, crmUser);
    return doctors.list
      .filter(
        (d) =>
          !term ||
          nameKey(d.full_name).includes(term) ||
          norm(d.area).includes(term) ||
          String(d.mobile ?? "").includes(term),
      )
      .slice(0, 20);
  });
}

const greyHeader = (sheet, columns) => {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.eachCell((cell, n) => {
    const given = columns[n - 1]?.given || columns[n - 1]?.hidden;
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: given ? "FFE2E8F0" : "FFDBEAFE" },
    };
  });
  sheet.views = [{ state: "frozen", ySplit: 1, xSplit: 2 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
};

async function repStats(sql, ids) {
  const { rows } = await sql(
    `SELECT u.id, u.full_name,
            (SELECT count(*)::int FROM crm.doctor_assignments a
               JOIN crm.doctors d ON d.id = a.doctor_id AND d.deleted_at IS NULL AND d.is_active
              WHERE a.executive_id = u.id AND a.effective_to IS NULL) AS assigned,
            (SELECT count(*)::int FROM crm.doctor_assignments a
               JOIN crm.doctors d ON d.id = a.doctor_id AND d.deleted_at IS NULL AND d.is_active
              WHERE a.executive_id = u.id AND a.effective_to IS NULL
                AND NOT EXISTS (SELECT 1 FROM crm.visits v
                                 WHERE v.doctor_id = a.doctor_id AND v.executive_id = u.id
                                   AND v.deleted_at IS NULL AND v.occurred_at >= ${IST_MONTH_START})
            ) AS not_visited_month,
            s.visits_today, s.visits_week, s.visits_month, s.unique_doctors_month
       FROM crm.users u
       CROSS JOIN LATERAL (
         SELECT ${periodCounts()},
                count(DISTINCT doctor_id) FILTER (WHERE occurred_at >= ${IST_MONTH_START})::int
                  AS unique_doctors_month
           FROM crm.visits WHERE deleted_at IS NULL AND executive_id = u.id
       ) s
      WHERE u.id = ANY($1::uuid[])
      ORDER BY u.full_name`,
    [ids],
  );
  return rows;
}

export async function visitSheetWorkbook(crmUser) {
  const data = await withCrmContext(crmUser, async (sql) => {
    const { rows: doctors } = await sql(
      `WITH ${VISIT_DUE_CTE}
       SELECT d.id AS doctor_id, d.full_name, d.specialty, d.area, d.mobile,
              ${istDayOf("vd.last_visit_at")}::text AS last_visit,
              COALESCE(s.visits_today, 0) AS visits_today,
              COALESCE(s.visits_week, 0) AS visits_week,
              COALESCE(s.visits_month, 0) AS visits_month
         FROM crm.doctors d
         JOIN crm.doctor_assignments a ON a.doctor_id = d.id AND a.effective_to IS NULL
         LEFT JOIN vd_all vd ON vd.doctor_id = d.id
         LEFT JOIN LATERAL (
           SELECT ${periodCounts()}
             FROM crm.visits v
            WHERE v.doctor_id = d.id AND v.executive_id = $1 AND v.deleted_at IS NULL
         ) s ON TRUE
        WHERE a.executive_id = $1 AND d.deleted_at IS NULL AND d.is_active
        ORDER BY d.area NULLS LAST, d.full_name, d.id`,
      [crmUser.id],
    );
    let team = [crmUser.id];
    if (ASSIGNING_ROLES.includes(crmUser.role)) {
      const { rows } = await sql(
        `SELECT id FROM crm.users
          WHERE is_active AND deleted_at IS NULL AND role = ANY($1::text[])`,
        [ASSIGNABLE_ROLES],
      );
      team = [...new Set([crmUser.id, ...rows.map((r) => r.id)])];
    }
    return { doctors, stats: await repStats(sql, team) };
  });

  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Visits");
  sheet.columns = SHEET_COLUMNS.map(({ header, key, width, hidden }) => ({
    header,
    key,
    width,
    hidden,
  }));
  data.doctors.forEach((d) => sheet.addRow({ ...d, last_visit: ddmmyyyy(d.last_visit) }));
  if (!data.doctors.length) {
    sheet.addRow({ full_name: "No doctors are assigned to you yet. Ask the head of growth." });
  }
  greyHeader(sheet, SHEET_COLUMNS);

  const lists = book.addWorksheet("Lists", { state: "hidden" });
  const options = [
    VISIT_SHEET_STATUSES.map((s) => s.label),
    VISIT_TYPES.map((s) => s.label),
    VISIT_OUTCOMES.map((s) => s.label),
  ];
  options.forEach((values, c) => values.forEach((v, r) => (lists.getCell(r + 1, c + 1).value = v)));
  const col = (key) => SHEET_COLUMNS.findIndex((c) => c.key === key) + 1;
  const listRule = (letter, n, title) => ({
    type: "list",
    allowBlank: true,
    formulae: [`Lists!$${letter}$1:$${letter}$${n}`],
    showErrorMessage: true,
    errorStyle: "stop",
    errorTitle: title,
    error: "Pick a value from the list.",
  });
  const lastRow = Math.max(data.doctors.length + 1, 2) + 300;
  const window = uploadWindow();
  for (let r = 2; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    const date = row.getCell(col("visit_date"));
    date.numFmt = "dd-mm-yyyy";
    const ref = `${date.address}`;
    date.dataValidation = {
      type: "custom",
      allowBlank: true,
      formulae: [`AND(ISNUMBER(${ref}),${ref}<=TODAY())`],
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle: "Visit date",
      error: "Enter a date like 21-10-2026, not in the future.",
    };
    row.getCell(col("status")).dataValidation = listRule("A", options[0].length, "Status");
    row.getCell(col("visit_type")).dataValidation = listRule("B", options[1].length, "Visit type");
    row.getCell(col("outcome")).dataValidation = listRule("C", options[2].length, "Outcome");
    const next = row.getCell(col("next_visit"));
    next.numFmt = "dd-mm-yyyy";
    next.dataValidation = {
      type: "custom",
      allowBlank: true,
      formulae: [`AND(ISNUMBER(${next.address}),${next.address}>${ref})`],
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle: "Next visit date",
      error:
        "Enter a date after the visit date, like 21-11-2026. Leave blank if no follow-up is needed.",
    };
  }

  const summary = book.addWorksheet("Summary");
  summary.columns = [
    { header: "Rep", key: "full_name", width: 24 },
    { header: "Visits today", key: "visits_today", width: 13 },
    { header: "Visits this week", key: "visits_week", width: 16 },
    { header: "Visits this month", key: "visits_month", width: 17 },
    { header: "Unique doctors this month", key: "unique_doctors_month", width: 24 },
    { header: "Assigned doctors", key: "assigned", width: 17 },
    { header: "Not visited this month", key: "not_visited_month", width: 22 },
  ];
  data.stats.forEach((s) => summary.addRow(s));
  if (data.stats.length > 1) {
    const total = { full_name: "Team total" };
    for (const k of [
      "visits_today",
      "visits_week",
      "visits_month",
      "unique_doctors_month",
      "assigned",
      "not_visited_month",
    ]) {
      total[k] = data.stats.reduce((n, s) => n + (s[k] || 0), 0);
    }
    summary.addRow(total).font = { bold: true };
  }
  summary.getRow(1).font = { bold: true };
  summary.addRow([]);
  summary.addRow([
    `Week starts Monday. Times are India time. Uploads accepted from ${ddmmyyyy(window.from)} to ${ddmmyyyy(window.to)}.`,
  ]);

  const first = String(crmUser.full_name || "me")
    .split(/\s+/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return {
    buffer: await book.xlsx.writeBuffer(),
    fileName: `my-visits-${first || "me"}-${window.to}.xlsx`,
    count: data.doctors.length,
  };
}

export async function failedVisitWorkbook(crmUser, batchId) {
  const data = await withCrmContext(crmUser, async (sql) => {
    const batch = await ownBatch(sql, crmUser, batchId);
    const { rows } = await sql(
      `SELECT r.row_number, r.raw, r.fail_reason, r.visit_state
         FROM crm.import_rows r
        WHERE r.batch_id = $1 AND r.visit_state IN ('failed', 'already_logged')
        ORDER BY r.row_number`,
      [batchId],
    );
    return { batch, rows };
  });
  const headers = Array.isArray(data.batch.headers)
    ? data.batch.headers
    : [...new Set(data.rows.flatMap((r) => Object.keys(r.raw || {})))];
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Visits");
  const columns = [
    { header: "Row", key: "row_number", width: 6 },
    ...headers.map((h) => ({ header: h, key: `col:${h}`, width: Math.min(40, h.length + 12) })),
    { header: "Reason", key: "reason", width: 60 },
  ];
  sheet.columns = columns;
  data.rows.forEach((r) => {
    const cells = Object.fromEntries(
      headers.map((h) => {
        const v = r.raw?.[h] ?? "";
        const isDate =
          [...FIELDS.visit_date, ...FIELDS.next_visit].includes(norm(h)) && typeof v === "number";
        return [`col:${h}`, isDate ? ddmmyyyy(parseVisitDate(v).day) : v];
      }),
    );
    sheet.addRow({ row_number: r.row_number, ...cells, reason: r.fail_reason || "" });
  });
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const base = String(data.batch.file_name || "visits").replace(/\.[^.]+$/, "");
  return { buffer: await book.xlsx.writeBuffer(), fileName: `${base}-failed-rows.xlsx` };
}
