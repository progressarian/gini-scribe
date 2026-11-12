import pool from "../../config/db.js";
import { FLAT } from "../giniflow/labCatalog.js";
import { rangeProblems } from "../../../shared/labCatalogRules.js";
import { formulaInputs, formulaSyntaxError } from "../../../shared/labFormula.js";

const EDITABLE_TYPES = ["numeric", "text", "group", "select"];

const fail = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

async function inTransaction(db, work) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const audit = (client, actorId, entity, entityId, action, before, after) =>
  client.query(
    `INSERT INTO lab_catalog_audit (entity, entity_id, action, before, after, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entity, String(entityId), action, before ?? null, after ?? null, actorId ?? null],
  );

async function lastChangedBy(client, entity, entityId) {
  const { rows } = await client.query(
    `SELECT d.name, a.at FROM lab_catalog_audit a LEFT JOIN doctors d ON d.id = a.actor_id
      WHERE a.entity = $1 AND a.entity_id = $2 ORDER BY a.at DESC, a.id DESC LIMIT 1`,
    [entity, String(entityId)],
  );
  return rows[0] || null;
}

async function refuseIfStale(client, row, expected, entity) {
  if (!expected) throw fail(400, "Reload the page and try again");
  if (new Date(row.updated_at).getTime() === new Date(expected).getTime()) return;
  const who = await lastChangedBy(client, entity, row.id);
  const when = who?.at
    ? new Date(who.at).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;
  throw fail(
    409,
    `Changed by ${who?.name || "someone else"}${when ? ` at ${when}` : ""} — reload to see it`,
    { code: "stale" },
  );
}

async function lockCatalogTest(client, catalogId) {
  const { rows } = await client.query(
    `SELECT c.id, c.test_name, c.lab_report_id, c.results_as_file, c.updated_at, r.name AS report_name
       FROM giniflow_test_catalog c
       LEFT JOIN lab_report_catalog r ON r.id = c.lab_report_id
      WHERE c.id = $1 FOR UPDATE OF c`,
    [catalogId],
  );
  if (!rows[0]) throw fail(404, "Test not found");
  return rows[0];
}

async function activeReport(client, reportId) {
  const { rows } = await client.query(
    `SELECT id, name FROM lab_report_catalog WHERE id = $1 AND COALESCE(is_active, TRUE)`,
    [reportId],
  );
  if (!rows[0]) throw fail(404, "That result report is not available");
  return rows[0];
}

async function setLink(client, test, report, actorId) {
  await client.query(
    `UPDATE giniflow_test_catalog
        SET lab_report_id = $2, results_as_file = FALSE, updated_at = NOW()
      WHERE id = $1`,
    [test.id, report?.id ?? null],
  );
  await audit(
    client,
    actorId,
    "link",
    test.id,
    report ? "link" : "unlink",
    { lab_report_id: test.lab_report_id, report: test.report_name },
    { lab_report_id: report?.id ?? null, report: report?.name ?? null },
  );
}

export function linkReport(catalogId, { reportId, expectedUpdatedAt }, actorId, db = pool) {
  return inTransaction(db, async (client) => {
    const test = await lockCatalogTest(client, catalogId);
    await refuseIfStale(client, test, expectedUpdatedAt, "link");
    const report = await activeReport(client, reportId);
    await setLink(client, test, report, actorId);
    return { linked: report.name };
  });
}

export function unlinkReport(catalogId, { expectedUpdatedAt }, actorId, db = pool) {
  return inTransaction(db, async (client) => {
    const test = await lockCatalogTest(client, catalogId);
    await refuseIfStale(client, test, expectedUpdatedAt, "link");
    if (!test.lab_report_id) throw fail(409, "This test has no linked report");
    await setLink(client, test, null, actorId);
    return { linked: null };
  });
}

export function createAndLinkReport(catalogId, { name, expectedUpdatedAt }, actorId, db = pool) {
  return inTransaction(db, async (client) => {
    const test = await lockCatalogTest(client, catalogId);
    await refuseIfStale(client, test, expectedUpdatedAt, "link");
    if (test.lab_report_id) throw fail(409, "Unlink the current report first");
    const reportName = String(name || test.test_name).trim();
    const { rows: clash } = await client.query(
      `SELECT name FROM lab_report_catalog
        WHERE ${FLAT("name")} = ${FLAT("$1")}
           OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE ${FLAT("a")} = ${FLAT("$1")})
        LIMIT 1`,
      [reportName],
    );
    if (clash[0]) {
      throw fail(409, `A report called "${clash[0].name}" already exists — link it instead`);
    }
    const { rows } = await client.query(
      `INSERT INTO lab_report_catalog (name, source, edited_at) VALUES ($1, 'manual', NOW())
       RETURNING id, name`,
      [reportName],
    );
    await audit(client, actorId, "report", rows[0].id, "create", null, { name: rows[0].name });
    await setLink(client, test, rows[0], actorId);
    return { linked: rows[0].name, reportId: String(rows[0].id) };
  });
}

export function setResultsAsFile(catalogId, { value, expectedUpdatedAt }, actorId, db = pool) {
  return inTransaction(db, async (client) => {
    const test = await lockCatalogTest(client, catalogId);
    await refuseIfStale(client, test, expectedUpdatedAt, "link");
    if (value && test.lab_report_id) {
      throw fail(409, "Unlink the result report first — a file-only test has no fields");
    }
    await client.query(
      `UPDATE giniflow_test_catalog SET results_as_file = $2, updated_at = NOW() WHERE id = $1`,
      [test.id, !!value],
    );
    await audit(
      client,
      actorId,
      "link",
      test.id,
      value ? "file_only" : "fields",
      { results_as_file: test.results_as_file },
      { results_as_file: !!value },
    );
    return { resultsAsFile: !!value };
  });
}

export async function searchReports(q, db = pool) {
  const term = String(q || "").trim();
  const { rows } = await db.query(
    `SELECT r.id, r.name, r.aliases,
            (SELECT count(*)::int FROM lab_report_tests rt
               JOIN lab_test_catalog f ON f.id = rt.test_id AND COALESCE(f.is_active, TRUE)
              WHERE rt.report_id = r.id) AS fields,
            (SELECT array_agg(c.test_name ORDER BY c.test_name) FROM giniflow_test_catalog c
              WHERE c.lab_report_id = r.id) AS linked_tests
       FROM lab_report_catalog r
      WHERE COALESCE(r.is_active, TRUE)
        AND ($1 = '' OR r.name ILIKE '%' || $1 || '%'
             OR EXISTS (SELECT 1 FROM unnest(r.aliases) a WHERE a ILIKE '%' || $1 || '%'))
      ORDER BY r.name
      LIMIT 20`,
    [term],
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    aliases: r.aliases || [],
    fields: r.fields,
    linkedTests: r.linked_tests || [],
  }));
}

const fieldState = (row) => ({
  name: row.name,
  unit: row.unit,
  no_unit: row.no_unit,
  input_type: row.input_type,
  decimals: row.decimals,
  is_active: row.is_active,
  formula: row.formula ?? null,
  options: row.options?.length ? row.options : null,
});

const cleanOptions = (options) =>
  Array.isArray(options) ? options.map((o) => String(o).trim()).filter(Boolean) : null;

const REPORT_FIELDS_SQL = `
  WITH RECURSIVE tree AS (
    SELECT t.id, 0 AS depth FROM lab_report_tests rt JOIN lab_test_catalog t ON t.id = rt.test_id
     WHERE rt.report_id = $1
    UNION ALL
    SELECT c.id, tree.depth + 1 FROM tree JOIN lab_test_catalog c ON c.parent_test_id = tree.id
     WHERE tree.depth < 4
  )
  SELECT f.id, f.name, f.input_type, f.is_active
    FROM lab_test_catalog f WHERE f.id IN (SELECT id FROM tree)`;

async function loopFrom(client, fieldId, formula) {
  const { rows } = await client.query(
    `SELECT id, name, formula FROM lab_test_catalog
      WHERE formula IS NOT NULL AND COALESCE(is_active, TRUE)`,
  );
  const names = new Map(rows.map((r) => [String(r.id), r.name]));
  const edges = new Map(rows.map((r) => [String(r.id), formulaInputs(r.formula).map(String)]));
  edges.set(String(fieldId), formulaInputs(formula).map(String));
  const start = String(fieldId);
  const walk = (id, path) => {
    for (const next of edges.get(id) || []) {
      if (next === start) return [...path, next];
      if (path.includes(next)) continue;
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  const loop = walk(start, [start]);
  if (!loop) return null;
  const nameOf = (id) => names.get(id) || "this field";
  return loop.map(nameOf).join(" → ");
}

async function checkFormula(client, { reportId, fieldId = null, formula, previous = null }) {
  const syntax = formulaSyntaxError(formula);
  if (syntax) throw fail(400, `Formula: ${syntax}`);
  if (!reportId) throw fail(400, "Reload the page and try again");
  const inputs = [...new Set(formulaInputs(formula).map(String))];
  if (fieldId && inputs.includes(String(fieldId))) {
    throw fail(400, "Formula: a field cannot use itself");
  }
  const kept = new Set(formulaInputs(previous).map(String));
  const { rows } = await client.query(REPORT_FIELDS_SQL, [reportId]);
  const inReport = new Map(rows.map((r) => [String(r.id), r]));
  const { rows: known } = await client.query(
    `SELECT id, name, input_type, formula, is_active FROM lab_test_catalog WHERE id = ANY($1::bigint[])`,
    [inputs],
  );
  const byId = new Map(known.map((r) => [String(r.id), r]));
  for (const id of inputs) {
    const input = byId.get(id);
    if (!input) throw fail(400, "Formula: it uses a field that no longer exists");
    if (!inReport.has(id) && !kept.has(id)) {
      throw fail(400, `Formula: ${input.name} is not in this report`);
    }
    if (input.is_active === false) throw fail(400, `Formula: ${input.name} is turned off`);
    if (input.input_type !== "numeric") {
      throw fail(400, `Formula: ${input.name} is not a number field`);
    }
  }
  if (fieldId) {
    const loop = await loopFrom(client, fieldId, formula);
    if (loop) throw fail(400, `Formula: it would go round in a loop (${loop})`);
  }
}

const notRequiredAnywhere = (client, fieldId) =>
  client.query(`UPDATE lab_report_tests SET is_required = FALSE WHERE test_id = $1`, [fieldId]);

function checkField(next) {
  if (!next.name || next.name.length > 120)
    throw fail(400, "Give the field a name (up to 120 characters)");
  if (!EDITABLE_TYPES.includes(next.input_type) && !next.formula) {
    throw fail(400, "Choose Number, Text, Pick list or Heading");
  }
  if (next.input_type === "select") {
    const options = next.options || [];
    if (options.length < 2) throw fail(400, "A pick list needs at least 2 choices");
    if (options.length > 20) throw fail(400, "Keep a pick list to 20 choices or fewer");
    if (options.some((o) => o.length > 40)) throw fail(400, "Keep each choice under 40 characters");
    const seen = new Set(options.map((o) => o.toLowerCase()));
    if (seen.size !== options.length) throw fail(400, "Each choice must be different");
  }
  if (
    next.decimals != null &&
    !(Number.isInteger(next.decimals) && next.decimals >= 0 && next.decimals <= 4)
  ) {
    throw fail(400, "Decimals must be between 0 and 4");
  }
  const numeric = next.input_type === "numeric" || !!next.formula;
  if (next.is_active && numeric && !next.unit && !next.no_unit) {
    throw fail(400, "Enter a unit, or tick “No unit” for a plain number such as a ratio");
  }
}

async function refuseDuplicateName(client, reportId, name, exceptId = null) {
  const { rows } = await client.query(
    `SELECT f.name FROM lab_report_tests rt JOIN lab_test_catalog f ON f.id = rt.test_id
      WHERE rt.report_id = $1 AND ${FLAT("f.name")} = ${FLAT("$2")}
        AND ($3::bigint IS NULL OR f.id <> $3::bigint)
      LIMIT 1`,
    [reportId, name, exceptId],
  );
  if (rows[0]) throw fail(409, `This report already has a field called "${rows[0].name}"`);
}

async function lockReport(client, reportId) {
  const { rows } = await client.query(
    `SELECT id, name FROM lab_report_catalog WHERE id = $1 FOR UPDATE`,
    [reportId],
  );
  if (!rows[0]) throw fail(404, "Result report not found");
  return rows[0];
}

export function addField(reportId, input, actorId, db = pool) {
  return inTransaction(db, async (client) => {
    await lockReport(client, reportId);
    const next = {
      name: String(input.name || "").trim(),
      unit: input.unit?.trim() || null,
      no_unit: !!input.noUnit,
      input_type: input.type || "numeric",
      decimals: input.decimals ?? null,
      is_active: true,
      formula: input.formula?.trim() || null,
      options: cleanOptions(input.options),
    };
    if (next.input_type !== "select") next.options = null;
    if (next.formula) {
      next.input_type = "numeric";
      await checkFormula(client, { reportId, formula: next.formula });
    }
    if (next.input_type !== "numeric") next.no_unit = false;
    checkField(next);
    await refuseDuplicateName(client, reportId, next.name);
    const { rows } = await client.query(
      `INSERT INTO lab_test_catalog
         (name, unit, no_unit, input_type, decimals, formula, options, source, edited_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', NOW())
       RETURNING id`,
      [
        next.name,
        next.unit,
        next.no_unit,
        next.input_type,
        next.decimals,
        next.formula,
        next.options,
      ],
    );
    const fieldId = rows[0].id;
    await client.query(
      `INSERT INTO lab_report_tests (report_id, test_id, sequence, is_required)
       SELECT $1, $2, COALESCE(max(sequence), 0) + 1, $3 FROM lab_report_tests WHERE report_id = $1`,
      [reportId, fieldId, next.input_type !== "group" && !next.formula],
    );
    await audit(client, actorId, "field", fieldId, "create", null, {
      ...next,
      report_id: reportId,
    });
    return { id: String(fieldId) };
  });
}

async function formulasUsing(client, fieldId) {
  const { rows } = await client.query(
    `SELECT name FROM lab_test_catalog
      WHERE COALESCE(is_active, TRUE) AND formula ~ ('#' || $1::text || '([^0-9]|$)')
      ORDER BY name`,
    [String(fieldId)],
  );
  return rows.map((r) => r.name);
}

export function updateField(fieldId, input, actorId, db = pool) {
  return inTransaction(db, async (client) => {
    const { rows } = await client.query(
      `SELECT id, name, unit, no_unit, input_type, decimals, formula, options, is_active, updated_at
         FROM lab_test_catalog WHERE id = $1 FOR UPDATE`,
      [fieldId],
    );
    const row = rows[0];
    if (!row) throw fail(404, "Field not found");
    await refuseIfStale(client, row, input.expectedUpdatedAt, "field");

    const next = { ...fieldState(row) };
    if (input.options !== undefined) next.options = cleanOptions(input.options);
    if (input.name !== undefined) next.name = String(input.name).trim();
    if (input.unit !== undefined) next.unit = input.unit?.trim() || null;
    if (input.noUnit !== undefined) next.no_unit = !!input.noUnit;
    if (input.decimals !== undefined) next.decimals = input.decimals;
    if (input.active !== undefined) next.is_active = !!input.active;
    if (input.formula !== undefined) {
      next.formula = input.formula?.trim() || null;
      if (next.formula) next.input_type = "numeric";
    }
    if (input.type !== undefined && input.type !== next.input_type) {
      if (next.formula) {
        throw fail(409, "A calculated field keeps its type — edit its formula instead");
      }
      next.input_type = input.type;
    }
    if (next.formula && next.formula !== row.formula) {
      await checkFormula(client, {
        reportId: input.reportId,
        fieldId: row.id,
        formula: next.formula,
        previous: row.formula,
      });
    }
    if (next.input_type !== "numeric" && !next.formula) next.no_unit = false;
    if (next.no_unit) next.unit = null;
    if (next.input_type !== "select") next.options = null;
    if (next.input_type === "select") next.unit = null;
    checkField(next);

    if (input.reportId && next.name !== row.name) {
      await refuseDuplicateName(client, input.reportId, next.name, row.id);
    }
    const leavesNumbers = row.input_type === "numeric" && next.input_type !== "numeric";
    if ((row.is_active && !next.is_active) || leavesNumbers) {
      const users = await formulasUsing(client, row.id);
      if (users.length) {
        throw fail(409, `Used in the formula of ${users.join(", ")} — change that formula first`);
      }
    }

    const before = fieldState(row);
    const after = fieldState(next);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (changed) {
      await client.query(
        `UPDATE lab_test_catalog
            SET name = $2, unit = $3, no_unit = $4, input_type = $5, decimals = $6, is_active = $7,
                formula = $8, options = $9, edited_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [
          row.id,
          next.name,
          next.unit,
          next.no_unit,
          next.input_type,
          next.decimals,
          next.is_active,
          next.formula,
          next.options,
        ],
      );
      await audit(client, actorId, "field", row.id, "update", before, after);
    }
    if (next.formula && !row.formula) await notRequiredAnywhere(client, row.id);

    if (input.reportId && input.required !== undefined) {
      const { rows: link } = await client.query(
        `SELECT is_required FROM lab_report_tests WHERE report_id = $1 AND test_id = $2 FOR UPDATE`,
        [input.reportId, row.id],
      );
      if (!link[0]) throw fail(404, "That field is not in this report");
      if (next.formula && input.required)
        throw fail(400, "A calculated field is never typed in, so it cannot be required");
      if (link[0].is_required !== !!input.required) {
        await client.query(
          `UPDATE lab_report_tests SET is_required = $3 WHERE report_id = $1 AND test_id = $2`,
          [input.reportId, row.id, !!input.required],
        );
        await audit(
          client,
          actorId,
          "field",
          row.id,
          "required",
          { is_required: link[0].is_required, report_id: input.reportId },
          { is_required: !!input.required, report_id: input.reportId },
        );
      }
    }
    return { id: String(row.id) };
  });
}

export function moveField(reportId, { fieldId, direction }, actorId, db = pool) {
  return inTransaction(db, async (client) => {
    await lockReport(client, reportId);
    const { rows } = await client.query(
      `SELECT test_id, sequence FROM lab_report_tests WHERE report_id = $1 ORDER BY sequence, test_id`,
      [reportId],
    );
    const order = rows.map((r) => String(r.test_id));
    const at = order.indexOf(String(fieldId));
    if (at === -1) throw fail(404, "That field is not in this report");
    const to = direction === "up" ? at - 1 : at + 1;
    if (to < 0 || to >= order.length) return { order };
    const before = [...order];
    [order[at], order[to]] = [order[to], order[at]];
    await client.query(
      `UPDATE lab_report_tests rt SET sequence = x.ord
         FROM unnest($2::bigint[]) WITH ORDINALITY AS x(test_id, ord)
        WHERE rt.report_id = $1 AND rt.test_id = x.test_id`,
      [reportId, order],
    );
    await audit(client, actorId, "order", reportId, "move", { order: before }, { order });
    return { order };
  });
}

const RANGE_COLUMNS = `id, gender, min_age_days, max_age_days, min_value, max_value, min_critical,
  max_critical, text_range, is_pregnant`;

const numOrNull = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

const rangeState = (r) => ({
  gender: r.gender,
  min_age_days: Number(r.min_age_days),
  max_age_days: Number(r.max_age_days),
  min_value: numOrNull(r.min_value),
  max_value: numOrNull(r.max_value),
  min_critical: numOrNull(r.min_critical),
  max_critical: numOrNull(r.max_critical),
  text_range: r.text_range || null,
});

export function replaceRanges(fieldId, { expectedUpdatedAt, ranges }, actorId, db = pool) {
  return inTransaction(db, async (client) => {
    const { rows } = await client.query(
      `SELECT id, input_type, formula, updated_at FROM lab_test_catalog WHERE id = $1 FOR UPDATE`,
      [fieldId],
    );
    const field = rows[0];
    if (!field) throw fail(404, "Field not found");
    await refuseIfStale(client, field, expectedUpdatedAt, "field");
    if (field.input_type === "group") throw fail(400, "A heading has no reference ranges");

    const problems = rangeProblems(ranges);
    if (problems.length) {
      const first = problems[0];
      throw fail(
        400,
        first.index === null ? first.message : `Range ${first.index + 1}: ${first.message}`,
        { problems },
      );
    }

    const { rows: existing } = await client.query(
      `SELECT ${RANGE_COLUMNS} FROM lab_test_ranges WHERE test_id = $1 ORDER BY id`,
      [field.id],
    );
    const editable = new Map(existing.filter((r) => !r.is_pregnant).map((r) => [String(r.id), r]));
    for (const r of ranges) {
      if (r.id && !editable.has(String(r.id)))
        throw fail(409, "A range changed — reload and try again");
    }

    const next = ranges.map((r) => ({
      id: r.id ? String(r.id) : null,
      gender: r.gender,
      min_age_days: Number(r.minAgeDays),
      max_age_days: Number(r.maxAgeDays),
      min_value: numOrNull(r.min),
      max_value: numOrNull(r.max),
      min_critical: numOrNull(r.minCritical),
      max_critical: numOrNull(r.maxCritical),
      text_range: String(r.text ?? "").trim() || null,
    }));
    const keep = new Set(next.filter((r) => r.id).map((r) => r.id));
    const removed = [...editable.keys()].filter((id) => !keep.has(id));

    if (removed.length) {
      await client.query(`DELETE FROM lab_test_ranges WHERE id = ANY($1::bigint[])`, [removed]);
    }
    for (const r of next) {
      const values = [
        r.gender,
        r.min_age_days,
        r.max_age_days,
        r.min_value,
        r.max_value,
        r.min_critical,
        r.max_critical,
        r.text_range,
      ];
      if (r.id) {
        await client.query(
          `UPDATE lab_test_ranges
              SET gender = $2, min_age_days = $3, max_age_days = $4, min_value = $5, max_value = $6,
                  min_critical = $7, max_critical = $8, text_range = $9, updated_at = NOW()
            WHERE id = $1`,
          [r.id, ...values],
        );
      } else {
        await client.query(
          `INSERT INTO lab_test_ranges
             (test_id, gender, min_age_days, max_age_days, min_value, max_value, min_critical,
              max_critical, text_range, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual')`,
          [field.id, ...values],
        );
      }
    }
    await client.query(
      `UPDATE lab_test_catalog SET edited_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [field.id],
    );
    await audit(
      client,
      actorId,
      "ranges",
      field.id,
      "replace",
      { ranges: [...editable.values()].map(rangeState) },
      { ranges: next.map(rangeState) },
    );
    return { id: String(field.id), ranges: next.length };
  });
}
