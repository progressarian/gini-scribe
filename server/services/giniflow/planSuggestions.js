import pool from "../../config/db.js";
import { skipSunday } from "../../../shared/followUp.js";

export const SUGGESTION_FIELDS = ["advice", "treatment", "lifestyle", "goals", "next_visit"];
const TEXT_FIELDS = ["advice", "treatment", "lifestyle"];
const DECISIONS = ["accepted", "edited", "dismissed"];
const TEXT_MAX = 4000;
const NOTE_MAX = 300;
const CHIEF_DESK = "with_sd";

const fail = (status, message) => Object.assign(new Error(message), { status });

const lineKey = (line) =>
  String(line || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const goalKey = (goal) => lineKey(`${goal?.test ?? ""} ${goal?.target ?? ""} ${goal?.unit ?? ""}`);

function cleanValue(field, value) {
  if (!SUGGESTION_FIELDS.includes(field)) throw fail(400, "Unknown suggestion");
  if (TEXT_FIELDS.includes(field)) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length > TEXT_MAX) throw fail(400, `Keep it under ${TEXT_MAX} characters`);
    return text || null;
  }
  if (field === "goals") {
    const goals = (Array.isArray(value) ? value : [])
      .map((g) => ({
        test: String(g?.test ?? "").trim(),
        target: String(g?.target ?? "").trim(),
        unit: String(g?.unit ?? "").trim(),
      }))
      .filter((g) => g.test);
    return goals.length ? goals : null;
  }
  const date = typeof value?.date === "string" ? value.date.trim() : "";
  const interval = typeof value?.interval === "string" ? value.interval.trim() : "";
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, "Choose a valid next-visit date");
  return date || interval ? { date: skipSunday(date) || null, interval: interval || null } : null;
}

const shape = (row) => ({
  id: row.id,
  field: row.field,
  value: row.value,
  editedValue: row.decided_value ?? null,
  status: row.status,
  proposedBy: row.proposed_by_name ?? null,
  proposedAt: row.created_at,
  decidedBy: row.decided_by_name ?? null,
  decidedAt: row.decided_at,
  note: row.decision_note ?? null,
});

const LIST_SQL = `
  SELECT DISTINCT ON (s.field) s.*, COALESCE(pd.short_name, pd.name) AS proposed_by_name,
         COALESCE(dd.short_name, dd.name) AS decided_by_name
    FROM giniflow_plan_suggestions s
    LEFT JOIN doctors pd ON pd.id = s.proposed_by
    LEFT JOIN doctors dd ON dd.id = s.decided_by
   WHERE s.visit_id = $1 AND s.status <> 'withdrawn'
   ORDER BY s.field, s.updated_at DESC`;

export async function listSuggestions(visitId, db = pool) {
  const { rows } = await db.query(LIST_SQL, [visitId]);
  return rows
    .map(shape)
    .sort((a, b) => SUGGESTION_FIELDS.indexOf(a.field) - SUGGESTION_FIELDS.indexOf(b.field));
}

export async function pendingSuggestionCount(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM giniflow_plan_suggestions
      WHERE visit_id = $1 AND status = 'proposed'`,
    [visitId],
  );
  return rows[0].n;
}

async function inTransaction(db, work) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function saveSuggestion(
  visitId,
  field,
  value,
  actorId = null,
  db = pool,
  { anyChief = false } = {},
) {
  const clean = cleanValue(field, value);
  return inTransaction(db, async (client) => {
    const { rows: visits } = await client.query(
      `SELECT current_status, assigned_sd_id FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!visits.length) throw fail(404, "Visit not found");
    if (visits[0].current_status !== CHIEF_DESK) {
      throw fail(409, "The patient is no longer at the Chief Endocrinologist's desk");
    }
    if (!anyChief && visits[0].assigned_sd_id && visits[0].assigned_sd_id !== actorId) {
      throw fail(403, "Another Chief Endocrinologist has this patient");
    }
    const { rows: decided } = await client.query(
      `SELECT status FROM giniflow_plan_suggestions
        WHERE visit_id = $1 AND field = $2 AND status IN ('accepted', 'edited', 'dismissed')
        LIMIT 1`,
      [visitId, field],
    );
    if (decided.length) throw fail(409, "The doctor has already decided this suggestion");
    if (clean === null) {
      await client.query(
        `UPDATE giniflow_plan_suggestions SET status = 'withdrawn', updated_at = NOW()
          WHERE visit_id = $1 AND field = $2 AND status = 'proposed'`,
        [visitId, field],
      );
      return null;
    }
    const { rows: updated } = await client.query(
      `UPDATE giniflow_plan_suggestions
          SET value = $3::jsonb, proposed_by = COALESCE($4, proposed_by), updated_at = NOW()
        WHERE visit_id = $1 AND field = $2 AND status = 'proposed'
        RETURNING *`,
      [visitId, field, JSON.stringify(clean), actorId],
    );
    if (updated.length) return shape(updated[0]);
    const { rows } = await client.query(
      `INSERT INTO giniflow_plan_suggestions (visit_id, field, value, proposed_by)
       VALUES ($1, $2, $3::jsonb, $4) RETURNING *`,
      [visitId, field, JSON.stringify(clean), actorId],
    );
    return shape(rows[0]);
  });
}

const appendLines = (existing, added) => {
  const have = String(existing || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const seen = new Set(have.map(lineKey));
  const fresh = String(added || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !seen.has(lineKey(line)));
  return [...have, ...fresh].join("\n") || null;
};

async function applyToCarePlan(client, visitId, field, value, actorId) {
  await client.query(
    `INSERT INTO giniflow_care_plans (visit_id, authored_by) VALUES ($1, $2)
     ON CONFLICT (visit_id) DO NOTHING`,
    [visitId, actorId],
  );
  const { rows } = await client.query(
    `SELECT advice, treatment, lifestyle, goals FROM giniflow_care_plans
      WHERE visit_id = $1 FOR UPDATE`,
    [visitId],
  );
  const plan = rows[0];
  if (TEXT_FIELDS.includes(field)) {
    await client.query(
      `UPDATE giniflow_care_plans SET ${field} = $2, updated_at = NOW() WHERE visit_id = $1`,
      [visitId, appendLines(plan[field], value)],
    );
  } else if (field === "goals") {
    const have = Array.isArray(plan.goals) ? plan.goals.filter((g) => g?.test) : [];
    const keys = new Set(have.map(goalKey));
    const merged = [...have, ...value.filter((g) => !keys.has(goalKey(g)))];
    await client.query(
      `UPDATE giniflow_care_plans SET goals = $2::jsonb, updated_at = NOW() WHERE visit_id = $1`,
      [visitId, JSON.stringify(merged)],
    );
  } else {
    await client.query(
      `UPDATE giniflow_care_plans
          SET next_visit_date = $2, next_visit_interval = $3, updated_at = NOW()
        WHERE visit_id = $1`,
      [visitId, skipSunday(value.date) || null, value.interval],
    );
  }
}

export async function decideSuggestion(suggestionId, decision, actorId = null, db = pool) {
  const status = decision?.status;
  if (!DECISIONS.includes(status)) throw fail(400, "Accept, edit or dismiss the suggestion");
  const note = typeof decision?.note === "string" ? decision.note.trim() : "";
  if (note.length > NOTE_MAX) throw fail(400, `Keep the note under ${NOTE_MAX} characters`);
  return inTransaction(db, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM giniflow_plan_suggestions WHERE id = $1 FOR UPDATE`,
      [suggestionId],
    );
    if (!rows.length) throw fail(404, "That suggestion no longer exists");
    const row = rows[0];
    if (row.status !== "proposed") throw fail(409, "That suggestion was already decided");
    const value = status === "edited" ? cleanValue(row.field, decision.value) : row.value;
    if (status === "edited" && value === null) throw fail(400, "The edited suggestion is empty");
    if (status !== "dismissed") {
      await applyToCarePlan(client, row.visit_id, row.field, value, actorId);
    }
    const { rows: saved } = await client.query(
      `UPDATE giniflow_plan_suggestions
          SET status = $2, decided_value = $3::jsonb, decided_by = $4, decided_at = NOW(),
              decision_note = $5, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [row.id, status, status === "edited" ? JSON.stringify(value) : null, actorId, note || null],
    );
    return shape(saved[0]);
  });
}

export async function applyChiefNextVisit(client, visitId, actorId = null) {
  const { rows } = await client.query(
    `UPDATE giniflow_plan_suggestions
        SET status = 'accepted', decided_by = $2, decided_at = NOW(), updated_at = NOW()
      WHERE visit_id = $1 AND field = 'next_visit' AND status = 'proposed'
      RETURNING value`,
    [visitId, actorId],
  );
  if (rows[0]?.value?.date) {
    await applyToCarePlan(client, visitId, "next_visit", rows[0].value, actorId);
  }
  const { rows: plan } = await client.query(
    `SELECT next_visit_date FROM giniflow_care_plans WHERE visit_id = $1`,
    [visitId],
  );
  if (!plan[0]?.next_visit_date) {
    throw fail(409, "Set the next visit before closing this patient");
  }
}
