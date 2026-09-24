import pool from "../../config/db.js";
import { CAPABILITIES as CAP, hasCapability } from "../../../shared/permissions.js";
import { writeAudit, writeAuditMany } from "./audit.js";
import { auditFields, lockRow, wholeNumber } from "./common.js";
import { IMPORT_SHEETS } from "./importColumns.js";
import { explain, IMPORT_LOCK, markConflicts, recordFailure, writeSheets } from "./importCommit.js";
import { errorFile, errorFileName } from "./importErrorFile.js";
import { parseUpload } from "./importParse.js";
import { markStatus } from "./importPreview.js";
import { checkMasterRows, key, loadReference } from "./importValidate.js";
import { rupees } from "./paymentRules.js";
import { httpError, inTransaction } from "./transaction.js";

export const SESSION_HOURS = 24;
export const ROWS_PAGE_SIZE = 50;
export const SEARCH_MAX = 100;
export const DECIDE_AT_ONCE = 500;
export const ROW_STATUSES = ["ready", "override", "unchanged", "failed"];
export const DECISIONS = ["pending", "override", "keep"];
export const OUTCOMES = ["saved", "kept", "failed", "unchanged"];
export const SHEET_NAMES = IMPORT_SHEETS.map((sheet) => sheet.name);

const ENTITY = "billing_import_sessions";
const FEES = "Consultant fees";
const WRITE_CHUNK = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRIAGE = { new: "ready", update: "override", unchanged: "unchanged" };
const MONEY = new Set(["base_price", "rate", "fee", "max_discount"]);
const IDS = new Set(["doctor", "test_name", "doctors"]);
const SESSION = {
  table: "billing_import_sessions",
  noun: "import session",
  columns:
    "id, file_name, status, uploaded_by, expires_at, expires_at <= NOW() AS expired, import_id",
};
const KEY_COLUMNS = Object.fromEntries(IMPORT_SHEETS.map((sheet) => [sheet.name, sheet.key]));
const DEFINES = {
  Groups: ["group", "group_code"],
  Subgroups: ["subgroup", "subgroup_code"],
  Items: ["item", "item_code"],
  Categories: ["category", "category_code"],
};
const REFERS = {
  Subgroups: [["group", "group_code"]],
  Items: [["subgroup", "subgroup_code"]],
  Categories: [["category", "parent_code"]],
  "Category rules": [["category", "category_code"]],
  "Category rates": [
    ["category", "category_code"],
    ["item", "item_code"],
  ],
  "Payment rules": [
    ["category", "category_code"],
    ["group", "group_code"],
    ["subgroup", "subgroup_code"],
    ["item", "item_code"],
  ],
  [FEES]: [["category", "category_code"]],
  Discounts: [
    ["group", "groups"],
    ["subgroup", "subgroups"],
    ["item", "items"],
    ["category", "categories"],
  ],
};

const rid = (sheet, row) => `${sheet}|${row}`;
const isAdmin = (role) => hasCapability(role, CAP.ADMIN);
const optionsFor = (ctx) => ({ canChangeDailyCap: isAdmin(ctx?.role) });
const describe = (errors) => [...new Set(errors.map((e) => e.message))].join("; ");
const chunks = (list) =>
  Array.from({ length: Math.ceil(list.length / WRITE_CHUNK) }, (_, i) =>
    list.slice(i * WRITE_CHUNK, (i + 1) * WRITE_CHUNK),
  );
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function cleanSessionId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, "Choose a valid import session");
  return text.toLowerCase();
}

function requireActor(ctx) {
  if (!ctx?.actorId) throw httpError(400, "An import must name who imported it");
  return ctx.actorId;
}

function cleanFileName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw httpError(400, "The file needs a name");
  return name;
}

function oneOf(value, allowed, label) {
  if (value === undefined || value === null || value === "") return null;
  if (!allowed.includes(value)) {
    throw httpError(400, `${label} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function cleanSearch(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw httpError(400, "Search must be text");
  const text = value.trim();
  if (text.length > SEARCH_MAX) {
    throw httpError(400, `Search can be at most ${SEARCH_MAX} characters`);
  }
  return text || null;
}

const likePattern = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function refusedFile(problems) {
  return httpError(
    422,
    "This file can't be checked row by row — fix the problems listed and upload it again",
    { problems },
  );
}

function assertOpen(session) {
  if (session.status === "abandoned") {
    throw httpError(409, "This import was abandoned; upload the file again");
  }
  if (session.status === "committed") {
    throw httpError(
      409,
      `This import is already saved (import ${session.import_id}); its rows are kept as that import's report`,
    );
  }
  if (session.expired) {
    throw httpError(
      410,
      `This import expired ${SESSION_HOURS} hours after it was uploaded; upload the file again`,
    );
  }
}

function assertMayAct(session, ctx) {
  if (session.uploaded_by !== ctx.actorId && !isAdmin(ctx.role)) {
    throw httpError(
      403,
      "Only the person who uploaded this file, or an admin, can change this import",
    );
  }
}

function rowKeyOf(sheet, row) {
  return (KEY_COLUMNS[sheet] ?? [])
    .map((column) => String(row.input?.[column] ?? "").trim())
    .filter(Boolean)
    .join(" · ");
}

const labelOf = (row) => row.values?.name ?? row.values?.label ?? null;

function workingSheets(parsed, keep) {
  return parsed.sheets
    .filter((sheet) => !sheet.later)
    .map((sheet) => ({
      ...sheet,
      rows: sheet.rows
        .filter((row) => keep(rid(sheet.name, row.row)))
        .map((row) => structuredClone(row)),
    }));
}

function storedKeys(ref) {
  return new Set([
    ...ref.groups.map((g) => `group:${key(g.code)}`),
    ...ref.subgroups.map((s) => `subgroup:${key(s.code)}`),
    ...ref.items.map((i) => `item:${key(i.code)}`),
    ...(ref.categories ?? []).map((c) => `category:${key(c.code)}`),
  ]);
}

function referencesOf(sheet, row) {
  const refs = [];
  for (const [kind, column] of REFERS[sheet] ?? []) {
    for (const code of [row.values?.[column]].flat()) {
      if (code) refs.push({ kind, code: key(code), column });
    }
  }
  if (sheet === FEES) {
    for (const { item } of row.resolved?.items ?? []) {
      refs.push({ kind: "item", code: key(item.code), column: "doctor" });
    }
  }
  return refs;
}

function failureOf(sheet, row, dependsOn = null) {
  return {
    sheet,
    row: row.row,
    values: row.values,
    errors: row.errors,
    warnings: row.warnings ?? [],
    changes: !row.isNew && row.changes?.length ? row.changes : null,
    dependsOn,
  };
}

function collect(sheets, failures, judge = null) {
  let grew = false;
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      const refusal = judge?.(sheet.name, row);
      if (refusal) row.errors = [refusal];
      if (!row.errors.length) continue;
      failures.set(rid(sheet.name, row.row), failureOf(sheet.name, row));
      grew = true;
    }
  }
  return grew;
}

function lostDefinitions(failures, stored) {
  const lost = new Map();
  for (const failure of failures.values()) {
    const definition = DEFINES[failure.sheet];
    const code = definition && failure.values?.[definition[1]];
    if (!code) continue;
    const id = `${definition[0]}:${key(code)}`;
    if (!stored.has(id) && !lost.has(id)) lost.set(id, failure);
  }
  return lost;
}

function cascade(sheets, failures, stored) {
  let grew = false;
  let spread = true;
  while (spread) {
    spread = false;
    const lost = lostDefinitions(failures, stored);
    for (const sheet of sheets) {
      for (const row of sheet.rows) {
        const id = rid(sheet.name, row.row);
        if (failures.has(id)) continue;
        const hit = referencesOf(sheet.name, row).find((ref) =>
          lost.has(`${ref.kind}:${ref.code}`),
        );
        if (!hit) continue;
        const parent = lost.get(`${hit.kind}:${hit.code}`);
        row.errors = [
          {
            column: hit.column,
            message: `Depends on ${parent.sheet} row ${parent.row}, which failed`,
          },
        ];
        failures.set(id, failureOf(sheet.name, row, { sheet: parent.sheet, row: parent.row }));
        spread = true;
        grew = true;
      }
    }
  }
  return grew;
}

async function probe(client, sheets, ref, ctx, reason, keep) {
  const parsed = { problems: [], sheets };
  await client.query("SAVEPOINT billing_import_probe");
  try {
    const written = await writeSheets(client, sheets, ref, ctx, reason);
    markConflicts(parsed, written.conflicts, written.ruleRows);
    const clean =
      !parsed.problems.length && sheets.every((s) => s.rows.every((r) => !r.errors.length));
    if (keep && clean) {
      await client.query("RELEASE SAVEPOINT billing_import_probe");
      return { written, problems: [] };
    }
    await client.query("ROLLBACK TO SAVEPOINT billing_import_probe");
    await client.query("RELEASE SAVEPOINT billing_import_probe");
    return { written: null, problems: parsed.problems };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT billing_import_probe").catch(() => {});
    await client.query("RELEASE SAVEPOINT billing_import_probe").catch(() => {});
    if (!error.status && !String(error.code ?? "").startsWith("23")) throw explain(error);
    return {
      problems: [error.status ? error.message : `Saving this file would fail: ${error.message}`],
    };
  }
}

async function settle({ parsed, include, ref, ctx, client, reason, keep, judge }) {
  const failures = new Map();
  const stored = storedKeys(ref);
  for (;;) {
    const sheets = workingSheets(parsed, (id) => include(id) && !failures.has(id));
    checkMasterRows(sheets, ref, optionsFor(ctx));
    markStatus(sheets, ref);
    const failed = collect(sheets, failures, judge);
    if (cascade(sheets, failures, stored) || failed) continue;
    const tried = await probe(client, sheets, ref, ctx, reason, keep);
    if (tried.problems.length) return { problems: tried.problems };
    const conflicted = collect(sheets, failures);
    if (cascade(sheets, failures, stored) || conflicted) continue;
    return { sheets, failures, written: tried.written };
  }
}

function flatten(value) {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.flatMap(({ visit_type, ...rest }) =>
        Object.entries(rest).map(([column, v]) => [`${visit_type} ${column}`, v ?? null]),
      ),
    );
  }
  return Object.fromEntries(Object.entries(value ?? {}).map(([column, v]) => [column, v ?? null]));
}

function shown(column, value) {
  const field = column.split(" ").at(-1);
  if (IDS.has(field)) return null;
  if (value === null || (Array.isArray(value) && !value.length)) return "blank";
  if (MONEY.has(field) && Number.isFinite(Number(value))) return rupees(value);
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? `"${value}"` : String(value);
}

function differences(before, now) {
  const a = flatten(before);
  const b = flatten(now);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((column) => JSON.stringify(a[column] ?? null) !== JSON.stringify(b[column] ?? null))
    .map((column) => {
      const value = shown(column, b[column] ?? null);
      return { column, text: value === null ? `${column} has changed` : `${column} ${value}` };
    });
}

function judgeAgainst(stored) {
  return (sheet, row) => {
    const saved = stored.get(rid(sheet, row.row));
    if (sheet === FEES && row.errors.length) return null;
    const column = KEY_COLUMNS[sheet][0];
    if (saved.status === "ready") {
      return row.isNew
        ? null
        : { column, message: "Added in Scribe after you uploaded this file — upload it again" };
    }
    if (row.isNew) {
      return {
        column,
        message: "Deleted from Scribe after you uploaded this file — upload it again",
      };
    }
    const changed = differences(saved.before, row.before);
    if (!changed.length) return null;
    const field = changed[0].column.split(" ").at(-1);
    return {
      column: field,
      message: `Changed since you uploaded (now ${changed.map((c) => c.text).join(", ")}) — upload again`,
    };
  };
}

function triage(parsed, settled) {
  const live = new Map(
    settled.sheets.flatMap((sheet) => sheet.rows.map((row) => [rid(sheet.name, row.row), row])),
  );
  const rows = [];
  for (const sheet of parsed.sheets) {
    if (sheet.later) continue;
    for (const typed of sheet.rows) {
      const id = rid(sheet.name, typed.row);
      const failure = settled.failures.get(id);
      const row = failure ?? live.get(id);
      const status = failure ? "failed" : TRIAGE[row.status];
      rows.push({
        sheet: sheet.name,
        row_no: typed.row,
        row_key: rowKeyOf(sheet.name, typed),
        label: labelOf(row) ?? labelOf(typed),
        status,
        decision: status === "override" ? "pending" : undefined,
        reason: failure ? describe(failure.errors) : undefined,
        errors: failure ? failure.errors : undefined,
        warnings: row.warnings ?? [],
        values: row.values ?? {},
        input: typed.input ?? {},
        before: status === "override" ? row.before : undefined,
        changes: status === "override" ? row.changes : (failure?.changes ?? undefined),
        dep_sheet: failure?.dependsOn?.sheet,
        dep_row: failure?.dependsOn?.row,
      });
    }
  }
  return rows;
}

function tally(rows) {
  const counts = { rows: rows.length, ready: 0, override: 0, unchanged: 0, failed: 0, warnings: 0 };
  const sheets = {};
  for (const row of rows) {
    counts[row.status] += 1;
    if (row.warnings.length) counts.warnings += 1;
    sheets[row.sheet] ??= { ready: 0, override: 0, unchanged: 0, failed: 0 };
    sheets[row.sheet][row.status] += 1;
  }
  return { ...counts, sheets };
}

async function insertRows(client, sessionId, rows) {
  for (const part of chunks(rows)) {
    await client.query(
      `INSERT INTO billing_import_rows
              (session_id, sheet, row_no, row_key, label, status, decision, reason, errors,
               warnings, "values", input, before, changes)
       SELECT $1, x.sheet, x.row_no, x.row_key, x.label, x.status, x.decision, x.reason, x.errors,
              x.warnings, x."values", x.input, x.before, x.changes
         FROM jsonb_to_recordset($2::jsonb)
           AS x(sheet text, row_no int, row_key text, label text, status text, decision text,
                reason text, errors jsonb, warnings jsonb, "values" jsonb, input jsonb,
                before jsonb, changes jsonb)`,
      [sessionId, JSON.stringify(part)],
    );
  }
  await linkDependencies(
    client,
    sessionId,
    rows.filter((r) => r.dep_sheet),
    "r.sheet = x.sheet AND r.row_no = x.row_no",
    "sheet text, row_no int",
  );
}

async function linkDependencies(client, sessionId, rows, match, columns) {
  for (const part of chunks(rows)) {
    await client.query(
      `UPDATE billing_import_rows r
          SET depends_on = p.id
         FROM jsonb_to_recordset($2::jsonb) AS x(${columns}, dep_sheet text, dep_row int)
         JOIN billing_import_rows p
           ON p.session_id = $1 AND p.sheet = x.dep_sheet AND p.row_no = x.dep_row
        WHERE r.session_id = $1 AND ${match}`,
      [sessionId, JSON.stringify(part)],
    );
  }
}

export async function purgeStaleSessions(db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM billing_import_sessions
      WHERE status = 'abandoned' OR (status = 'open' AND expires_at <= NOW())`,
  );
  return rowCount;
}

const liveCounts = (entries) => {
  const counts = {
    status: Object.fromEntries(ROW_STATUSES.map((s) => [s, 0])),
    decision: Object.fromEntries(DECISIONS.map((d) => [d, 0])),
    outcome: Object.fromEntries(OUTCOMES.map((o) => [o, 0])),
  };
  for (const { status, decision, outcome, n } of entries) {
    counts.status[status] += n;
    if (decision) counts.decision[decision] += n;
    if (outcome) counts.outcome[outcome] += n;
  }
  const { status, decision } = counts;
  counts.plan = {
    save: status.ready + decision.override,
    keep: decision.pending + decision.keep,
    undecided: decision.pending,
    failed: status.failed,
    unchanged: status.unchanged,
  };
  return counts;
};

const gone = () =>
  httpError(
    404,
    "That import session no longer exists (it expired or was abandoned); upload the file again",
  );

async function readSession(db, id) {
  const { rows } = await db.query(
    `SELECT s.id, s.file_name, s.status, s.status = 'open' AND s.expires_at <= NOW() AS expired,
            s.uploaded_by, u.name AS uploaded_by_name, s.uploaded_at, s.expires_at,
            s.committed_by, c.name AS committed_by_name, s.committed_at, s.import_id, s.counts
       FROM billing_import_sessions s
       LEFT JOIN doctors u ON u.id = s.uploaded_by
       LEFT JOIN doctors c ON c.id = s.committed_by
      WHERE s.id = $1`,
    [id],
  );
  if (!rows.length) throw gone();
  const { rows: entries } = await db.query(
    `SELECT status, decision, outcome, count(*)::int AS n
       FROM billing_import_rows WHERE session_id = $1
      GROUP BY status, decision, outcome`,
    [id],
  );
  const [session] = rows;
  return {
    ...session,
    import_id: session.import_id === null ? null : Number(session.import_id),
    live: liveCounts(entries),
  };
}

export async function getSession(id, db = pool) {
  return readSession(db, cleanSessionId(id));
}

export async function createSession(buffer, { fileName, ctx } = {}, db = pool) {
  const name = cleanFileName(fileName);
  const actorId = requireActor(ctx);
  const parsed = await parseUpload(buffer);
  if (parsed.problems.length) throw refusedFile(parsed.problems);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [IMPORT_LOCK]);
    const ref = await loadReference(client);
    const settled = await settle({
      parsed,
      include: () => true,
      ref,
      ctx: { actorId, ip: ctx.ip ?? null, importId: null, role: ctx.role },
      client,
      reason: "Preview",
      keep: false,
    });
    if (settled.problems) throw refusedFile(settled.problems);
    const rows = triage(parsed, settled);
    const counts = tally(rows);
    await purgeStaleSessions(client);
    const { rows: created } = await client.query(
      `INSERT INTO billing_import_sessions (file_name, file, uploaded_by, expires_at, counts)
       VALUES ($1, $2, $3, NOW() + make_interval(hours => $4), $5)
       RETURNING id`,
      [name, buffer, actorId, SESSION_HOURS, counts],
    );
    const sessionId = created[0].id;
    await insertRows(client, sessionId, rows);
    await writeAudit(client, {
      entity: ENTITY,
      entityId: sessionId,
      action: "create",
      after: { file_name: name, counts },
      ...auditFields(ctx),
    });
    const session = await readSession(client, sessionId);
    await client.query("COMMIT");
    return session;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw explain(error);
  } finally {
    client.release();
  }
}

function filterSql(filters, params) {
  const where = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (filters.status) add("r.status = ?", filters.status);
  if (filters.outcome) add("r.outcome = ?", filters.outcome);
  if (filters.sheet) add("r.sheet = ?", filters.sheet);
  if (filters.q) {
    add(`(r.row_key || ' ' || coalesce(r.label, '')) ILIKE ? ESCAPE '\\'`, likePattern(filters.q));
  }
  return where.map((w) => ` AND ${w}`).join("");
}

function cleanFilters(input = {}) {
  return {
    status: oneOf(input.status, ROW_STATUSES, "Status"),
    outcome: oneOf(input.outcome, OUTCOMES, "Outcome"),
    sheet: oneOf(input.sheet, SHEET_NAMES, "Sheet"),
    q: cleanSearch(input.q),
  };
}

function facets(entries, filters) {
  const matches = (entry, skip) =>
    ["status", "outcome", "sheet"].every(
      (f) => f === skip || !filters[f] || entry[f] === filters[f],
    );
  const count = (field, values, skip) =>
    Object.fromEntries(
      values.map((v) => [
        v,
        entries.filter((e) => e[field] === v && matches(e, skip)).reduce((sum, e) => sum + e.n, 0),
      ]),
    );
  const all = (skip) => entries.filter((e) => matches(e, skip)).reduce((sum, e) => sum + e.n, 0);
  return {
    status: { all: all("status"), ...count("status", ROW_STATUSES, "status") },
    sheet: { all: all("sheet"), ...count("sheet", SHEET_NAMES, "sheet") },
    outcome: { all: all("outcome"), ...count("outcome", OUTCOMES, "outcome") },
    decision: count("decision", DECISIONS, null),
  };
}

const shapeRow = (r) => ({
  id: Number(r.id),
  sheet: r.sheet,
  row: r.row_no,
  key: r.row_key,
  label: r.label,
  status: r.status,
  decision: r.decision,
  outcome: r.outcome,
  reason: r.reason,
  errors: r.errors ?? [],
  warnings: r.warnings,
  changes: r.changes ?? [],
  before: r.before,
  values: r.values,
  input: r.input,
  depends_on: r.dep_id
    ? { id: Number(r.dep_id), sheet: r.dep_sheet, row: r.dep_row, key: r.dep_key }
    : null,
});

export async function listRows(id, input = {}, db = pool) {
  const sessionId = cleanSessionId(id);
  const filters = cleanFilters(input);
  const page =
    wholeNumber(input.page, "Page", { min: 1, max: Math.ceil(2 ** 31 / ROWS_PAGE_SIZE) }) ?? 1;
  const { rows: found } = await db.query(`SELECT id FROM billing_import_sessions WHERE id = $1`, [
    sessionId,
  ]);
  if (!found.length) throw gone();

  const params = [sessionId, SHEET_NAMES];
  const where = filterSql(filters, params);
  params.push(ROWS_PAGE_SIZE, (page - 1) * ROWS_PAGE_SIZE);
  const { rows } = await db.query(
    `SELECT r.id, r.sheet, r.row_no, r.row_key, r.label, r.status, r.decision, r.outcome,
            r.reason, r.errors, r.warnings, r.changes, r.before, r."values", r.input,
            p.id AS dep_id, p.sheet AS dep_sheet, p.row_no AS dep_row, p.row_key AS dep_key
       FROM billing_import_rows r
       LEFT JOIN billing_import_rows p ON p.id = r.depends_on
      WHERE r.session_id = $1${where}
      ORDER BY array_position($2::text[], r.sheet), r.row_no
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const qParams = [sessionId];
  const qWhere = filters.q ? filterSql({ q: filters.q }, qParams) : "";
  const { rows: entries } = await db.query(
    `SELECT r.sheet, r.status, r.decision, r.outcome, count(*)::int AS n
       FROM billing_import_rows r
      WHERE r.session_id = $1${qWhere}
      GROUP BY r.sheet, r.status, r.decision, r.outcome`,
    qParams,
  );
  const counts = facets(entries, filters);
  const total = matchingTotal(entries, filters);
  return {
    page,
    page_size: ROWS_PAGE_SIZE,
    total,
    pages: Math.ceil(total / ROWS_PAGE_SIZE),
    filters,
    counts,
    rows: rows.map(shapeRow),
  };
}

const matchingTotal = (entries, filters) =>
  entries
    .filter((e) => ["status", "outcome", "sheet"].every((f) => !filters[f] || e[f] === filters[f]))
    .reduce((sum, e) => sum + e.n, 0);

function cleanRowIds(value) {
  if (!Array.isArray(value) || !value.length) {
    throw httpError(400, "Choose the rows to decide");
  }
  if (value.length > DECIDE_AT_ONCE) {
    throw httpError(
      400,
      `At most ${DECIDE_AT_ONCE} rows can be decided at once; use the filter to decide more`,
    );
  }
  return [
    ...new Set(
      value.map((v) => wholeNumber(v, "Each row id", { min: 1, max: Number.MAX_SAFE_INTEGER })),
    ),
  ];
}

export async function decideRows(id, input = {}, ctx = {}, db = pool) {
  const sessionId = cleanSessionId(id);
  requireActor(ctx);
  const decision = oneOf(input.decision, DECISIONS, "Decision");
  if (!decision) throw httpError(400, "Choose override or keep");
  const byIds = input.row_ids !== undefined;
  if (byIds === (input.filter !== undefined)) {
    throw httpError(400, "Send either the rows (row_ids) or a filter, not both");
  }
  const rowIds = byIds ? cleanRowIds(input.row_ids) : null;
  const filter = byIds ? null : cleanFilters(input.filter ?? {});
  if (filter?.status && filter.status !== "override") {
    throw httpError(400, "Only rows that need an override take a decision; filter on those");
  }
  if (filter?.outcome) throw httpError(400, "A decision can't be filtered by outcome");

  return inTransaction(async (client) => {
    const session = await lockRow(client, SESSION, sessionId);
    assertOpen(session);
    assertMayAct(session, ctx);
    let changed;
    let matched;
    if (rowIds) {
      const { rows } = await client.query(
        `SELECT id, sheet, row_no, status FROM billing_import_rows
          WHERE session_id = $1 AND id = ANY($2::bigint[])`,
        [sessionId, rowIds],
      );
      const found = new Set(rows.map((r) => Number(r.id)));
      const missing = rowIds.filter((rowId) => !found.has(rowId));
      if (missing.length) {
        throw httpError(404, `Not rows of this import: ${missing.slice(0, 10).join(", ")}`);
      }
      const wrong = rows.filter((r) => r.status !== "override");
      if (wrong.length) {
        throw httpError(
          409,
          `Only rows that need an override take a decision: ${wrong
            .slice(0, 5)
            .map((r) => `${r.sheet} row ${r.row_no} is ${r.status}`)
            .join("; ")}${wrong.length > 5 ? `; and ${wrong.length - 5} more` : ""}`,
        );
      }
      matched = rows.length;
      const { rowCount } = await client.query(
        `UPDATE billing_import_rows SET decision = $3
          WHERE session_id = $1 AND id = ANY($2::bigint[]) AND decision <> $3`,
        [sessionId, rowIds, decision],
      );
      changed = rowCount;
    } else {
      const params = [sessionId];
      const where = filterSql(filter, params);
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM billing_import_rows r
          WHERE r.session_id = $1 AND r.status = 'override'${where}`,
        params,
      );
      matched = rows[0].n;
      if (!matched) throw httpError(409, "No row matching this filter needs an override");
      params.push(decision);
      const { rowCount } = await client.query(
        `UPDATE billing_import_rows r SET decision = $${params.length}
          WHERE r.session_id = $1 AND r.status = 'override'${where}
            AND r.decision <> $${params.length}`,
        params,
      );
      changed = rowCount;
    }
    await writeAudit(client, {
      entity: ENTITY,
      entityId: sessionId,
      action: "update",
      after: rowIds
        ? { decision, row_ids: rowIds, changed }
        : { decision, filter: { sheet: filter.sheet, q: filter.q }, matched, changed },
      ...auditFields(ctx),
    });
    const { live } = await readSession(client, sessionId);
    return { decision, matched, changed, counts: live };
  }, db);
}

const isSaving = (row) =>
  row.status === "ready" || (row.status === "override" && row.decision === "override");

function outcomeOf(row, settled, present) {
  const id = rid(row.sheet, row.row_no);
  if (row.status === "failed") return { id: row.id, outcome: "failed" };
  if (row.status === "unchanged") return { id: row.id, outcome: "unchanged" };
  if (!isSaving(row)) return { id: row.id, outcome: "kept" };
  const failure = settled.failures.get(id);
  if (failure) {
    return {
      id: row.id,
      outcome: "failed",
      reason: describe(failure.errors),
      errors: failure.errors,
      dep_sheet: failure.dependsOn?.sheet,
      dep_row: failure.dependsOn?.row,
    };
  }
  if (present.has(id)) return { id: row.id, outcome: "saved" };
  const errors = [
    {
      column: KEY_COLUMNS[row.sheet][0],
      message: "This row can't be read from the uploaded file any more; upload the file again",
    },
  ];
  return { id: row.id, outcome: "failed", reason: describe(errors), errors };
}

function importCounts(rows, outcomes) {
  const counts = {};
  rows.forEach((row, i) => {
    const sheet = (counts[row.sheet] ??= { new: 0, update: 0, unchanged: 0, kept: 0, failed: 0 });
    const { outcome } = outcomes[i];
    if (outcome === "saved") sheet[row.status === "ready" ? "new" : "update"] += 1;
    else if (outcome === "unchanged") sheet.unchanged += 1;
    else sheet[outcome] += 1;
  });
  return counts;
}

async function storeOutcomes(client, sessionId, outcomes) {
  for (const part of chunks(outcomes)) {
    await client.query(
      `UPDATE billing_import_rows r
          SET outcome = x.outcome,
              reason = COALESCE(x.reason, r.reason),
              errors = COALESCE(x.errors, r.errors)
         FROM jsonb_to_recordset($2::jsonb) AS x(id bigint, outcome text, reason text, errors jsonb)
        WHERE r.session_id = $1 AND r.id = x.id`,
      [sessionId, JSON.stringify(part)],
    );
  }
  await linkDependencies(
    client,
    sessionId,
    outcomes.filter((o) => o.dep_sheet),
    "r.id = x.id",
    "id bigint",
  );
}

export async function commitSession(id, { ctx } = {}, db = pool) {
  const sessionId = cleanSessionId(id);
  const actorId = requireActor(ctx);
  const client = await db.connect();
  let started = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [IMPORT_LOCK]);
    const session = await lockRow(client, SESSION, sessionId);
    assertOpen(session);
    assertMayAct(session, ctx);
    const { rows } = await client.query(
      `SELECT id, sheet, row_no, status, decision, before
         FROM billing_import_rows WHERE session_id = $1
        ORDER BY array_position($2::text[], sheet), row_no`,
      [sessionId, SHEET_NAMES],
    );
    const saving = new Map(rows.filter(isSaving).map((r) => [rid(r.sheet, r.row_no), r]));
    if (!saving.size) {
      const kept = rows.filter((r) => r.status === "override").length;
      throw httpError(
        409,
        `Nothing to save: no row is ready${kept ? ` and none of the ${plural(kept, "change")} is overridden` : ""}. Override the changes you want, or abandon this import`,
      );
    }
    const { rows: files } = await client.query(
      `SELECT file FROM billing_import_sessions WHERE id = $1`,
      [sessionId],
    );
    const parsed = await parseUpload(files[0].file);
    if (parsed.problems.length) {
      throw httpError(409, "The uploaded file can't be read any more; upload it again");
    }
    const ref = await loadReference(client);
    started = session.file_name;
    const settled = await settle({
      parsed,
      include: (rowId) => saving.has(rowId),
      ref,
      ctx: { actorId, ip: ctx.ip ?? null, importId: null, role: ctx.role },
      client,
      reason: `Bulk import: ${session.file_name}`,
      keep: true,
      judge: judgeAgainst(saving),
    });
    if (settled.problems) {
      throw httpError(409, `Nothing was saved: ${settled.problems.join("; ")}`, {
        problems: settled.problems,
      });
    }
    const present = new Set(
      settled.sheets.flatMap((sheet) => sheet.rows.map((row) => rid(sheet.name, row.row))),
    );
    const outcomes = rows.map((row) => outcomeOf(row, settled, present));
    const summary = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
    for (const { outcome } of outcomes) summary[outcome] += 1;
    const counts = importCounts(rows, outcomes);

    const { rows: imported } = await client.query(
      `INSERT INTO billing_imports (file_name, imported_by, counts, status)
       VALUES ($1, $2, $3, $4) RETURNING id, imported_at`,
      [session.file_name, actorId, counts, summary.saved ? "saved" : "failed"],
    );
    const importId = imported[0].id;
    const importCtx = { actorId, ip: ctx.ip ?? null, importId };
    await writeAudit(client, {
      entity: "billing_imports",
      entityId: importId,
      action: "import",
      after: { file_name: session.file_name, counts, session_id: sessionId },
      ...auditFields(importCtx),
    });
    if (settled.written) {
      await writeAuditMany(client, settled.written.audit, auditFields(importCtx));
    }
    await client.query(
      `UPDATE billing_import_sessions
          SET status = 'committed', import_id = $2, committed_by = $3, committed_at = NOW(),
              counts = counts || jsonb_build_object('outcome', $4::jsonb)
        WHERE id = $1`,
      [sessionId, importId, actorId, summary],
    );
    await storeOutcomes(client, sessionId, outcomes);
    const result = await readSession(client, sessionId);
    await client.query("COMMIT");
    return {
      saved: summary.saved > 0,
      importId: Number(importId),
      importedAt: imported[0].imported_at,
      outcome: summary,
      session: result,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (started && !error.status) await recordFailure(db, started, actorId);
    throw explain(error);
  } finally {
    client.release();
  }
}

export async function failedRowsFile(id, db = pool) {
  const sessionId = cleanSessionId(id);
  const { rows: sessions } = await db.query(
    `SELECT file_name, file, status FROM billing_import_sessions WHERE id = $1`,
    [sessionId],
  );
  if (!sessions.length) throw gone();
  const [session] = sessions;
  if (session.status === "abandoned") {
    throw httpError(409, "This import was abandoned, so its file is gone; upload the file again");
  }
  const { rows } = await db.query(
    `SELECT sheet, row_no, errors FROM billing_import_rows
      WHERE session_id = $1 AND (status = 'failed' OR outcome = 'failed')
      ORDER BY row_no`,
    [sessionId],
  );
  if (!rows.length) {
    throw httpError(422, "No row in this import failed, so there is no file of failed rows");
  }
  const preview = {
    problems: [],
    counts: { error: rows.length },
    sheets: SHEET_NAMES.map((name) => ({
      name,
      rows: rows
        .filter((r) => r.sheet === name)
        .map((r) => ({ row: r.row_no, status: "error", errors: r.errors })),
    })),
  };
  return {
    file: await errorFile(session.file, preview),
    fileName: errorFileName(session.file_name),
  };
}

export async function abandonSession(id, ctx = {}, db = pool) {
  const sessionId = cleanSessionId(id);
  requireActor(ctx);
  return inTransaction(async (client) => {
    const session = await lockRow(client, SESSION, sessionId);
    if (session.status !== "open") assertOpen(session);
    assertMayAct(session, ctx);
    const { rowCount } = await client.query(
      `DELETE FROM billing_import_rows WHERE session_id = $1`,
      [sessionId],
    );
    await client.query(
      `UPDATE billing_import_sessions SET status = 'abandoned', file = NULL WHERE id = $1`,
      [sessionId],
    );
    await writeAudit(client, {
      entity: ENTITY,
      entityId: sessionId,
      action: "cancel",
      before: { file_name: session.file_name, rows: rowCount },
      ...auditFields(ctx),
    });
    return { id: sessionId, status: "abandoned", rows_removed: rowCount };
  }, db);
}
