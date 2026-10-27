import { withCrmContext } from "./db.js";
import { ASSIGNABLE_ROLES } from "./assignees.js";
import { DoctorError, isLead } from "./doctors.js";
import { IST_TODAY, addDays, istDate, istDayOf } from "./istPeriods.js";
import { TASK_PRIORITY_VALUES } from "../../shared/crmVocab.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_SIZE = 50;
const LIST_LIMIT = 100;
const BUCKETS = ["due", "upcoming", "done"];
const OPEN = "('open', 'in_progress')";
const REOPEN_MINUTES = 10;

const textOf = (v) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();

const OPEN_FOLLOW_UP = `t.kind = 'follow_up_visit' AND t.status IN ${OPEN} AND t.deleted_at IS NULL`;

async function closeFollowUpsByVisits(sql, visitIds) {
  await sql(
    `UPDATE crm.tasks t
        SET status = 'done', completed_at = now(), completed_by = v.executive_id,
            closed_by_visit_id = v.id, updated_at = now()
       FROM crm.visits v
      WHERE v.id = ANY($1::uuid[]) AND v.deleted_at IS NULL
        AND v.outcome IS DISTINCT FROM 'doctor_unavailable'
        AND ${OPEN_FOLLOW_UP}
        AND t.owner_id = v.executive_id AND t.doctor_id = v.doctor_id
        AND t.visit_id IS DISTINCT FROM v.id
        AND ${istDayOf("v.occurred_at")} >= ${istDayOf("t.created_at")}`,
    [visitIds],
  );
}

const LATEST_WITH_NEXT = `
  latest AS (
    SELECT DISTINCT ON (v.executive_id, v.doctor_id)
           v.id, v.hospital_id, v.executive_id, v.doctor_id, v.occurred_at, v.next_visit_date
      FROM crm.visits v
     WHERE v.id = ANY($1::uuid[]) AND v.deleted_at IS NULL AND v.next_visit_date IS NOT NULL
     ORDER BY v.executive_id, v.doctor_id, v.occurred_at DESC
  )`;

async function planFollowUps(sql, visitIds) {
  await sql(
    `WITH ${LATEST_WITH_NEXT}
     UPDATE crm.tasks t
        SET status = 'cancelled', cancel_reason = 'Replaced by a newer next visit date',
            updated_at = now()
       FROM latest l
      WHERE ${OPEN_FOLLOW_UP}
        AND t.owner_id = l.executive_id AND t.doctor_id = l.doctor_id
        AND t.visit_id IS DISTINCT FROM l.id
        AND NOT EXISTS (SELECT 1 FROM crm.visits src
                         WHERE src.id = t.visit_id AND src.occurred_at > l.occurred_at)`,
    [visitIds],
  );
  await sql(
    `WITH ${LATEST_WITH_NEXT}
     INSERT INTO crm.tasks
       (hospital_id, title, owner_id, doctor_id, visit_id, due_date, kind, created_by)
     SELECT l.hospital_id, 'Visit ' || d.full_name, l.executive_id, l.doctor_id, l.id,
            l.next_visit_date, 'follow_up_visit', l.executive_id
       FROM latest l
       JOIN crm.doctors d ON d.id = l.doctor_id AND d.deleted_at IS NULL
      WHERE NOT EXISTS (SELECT 1 FROM crm.tasks t
                         WHERE ${OPEN_FOLLOW_UP}
                           AND t.owner_id = l.executive_id AND t.doctor_id = l.doctor_id)`,
    [visitIds],
  );
}

async function addPromises(sql, visitIds) {
  await sql(
    `INSERT INTO crm.tasks
       (hospital_id, title, description, owner_id, doctor_id, visit_id, due_date, kind, created_by)
     SELECT v.hospital_id, left(btrim(v.commitments), 200),
            'Promised to ' || d.full_name, v.executive_id, v.doctor_id, v.id,
            COALESCE(v.next_visit_date, ${istDayOf("v.occurred_at")} + 3), 'promise', v.executive_id
       FROM crm.visits v
       JOIN crm.doctors d ON d.id = v.doctor_id
      WHERE v.id = ANY($1::uuid[]) AND v.deleted_at IS NULL
        AND nullif(btrim(coalesce(v.commitments, '')), '') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM crm.tasks t WHERE t.visit_id = v.id AND t.kind = 'promise')`,
    [visitIds],
  );
}

export async function syncVisitTasks(sql, visitIds) {
  if (!visitIds?.length) return;
  await closeFollowUpsByVisits(sql, visitIds);
  await planFollowUps(sql, visitIds);
  await addPromises(sql, visitIds);
}

export async function visitNextDateChanged(sql, visitId) {
  await sql(
    `UPDATE crm.tasks t
        SET status = 'cancelled', cancel_reason = 'Next visit date changed', updated_at = now()
      WHERE t.visit_id = $1 AND ${OPEN_FOLLOW_UP}`,
    [visitId],
  );
  await planFollowUps(sql, [visitId]);
}

export async function visitsUndone(sql, visitIds) {
  if (!visitIds?.length) return;
  await sql(
    `UPDATE crm.tasks t
        SET status = 'cancelled', cancel_reason = 'Visit undone', updated_at = now()
      WHERE t.visit_id = ANY($1::uuid[]) AND t.status IN ${OPEN} AND t.deleted_at IS NULL`,
    [visitIds],
  );
  await sql(
    `UPDATE crm.tasks t
        SET status = 'open', completed_at = NULL, completed_by = NULL,
            closed_by_visit_id = NULL, updated_at = now()
      WHERE t.id IN (
              SELECT DISTINCT ON (x.owner_id, x.doctor_id) x.id
                FROM crm.tasks x
               WHERE x.closed_by_visit_id = ANY($1::uuid[]) AND x.status = 'done'
               ORDER BY x.owner_id, x.doctor_id, x.created_at DESC)
        AND NOT EXISTS (SELECT 1 FROM crm.tasks o
                         WHERE o.kind = 'follow_up_visit' AND o.status IN ${OPEN}
                           AND o.deleted_at IS NULL
                           AND o.owner_id = t.owner_id AND o.doctor_id = t.doctor_id)`,
    [visitIds],
  );
}

async function staffOptions(sql) {
  const { rows } = await sql(
    `SELECT id, full_name FROM crm.users
      WHERE is_active AND deleted_at IS NULL AND role = ANY($1::text[]) ORDER BY full_name`,
    [ASSIGNABLE_ROLES],
  );
  return rows;
}

function ownerScope(crmUser, owner) {
  if (!isLead(crmUser)) return crmUser.id;
  if (!owner || owner === "all") return null;
  if (!UUID.test(owner)) throw new DoctorError("Choose a team member from the list.");
  return owner;
}

const TASK_COLUMNS = `t.id, t.title, t.description, t.kind, t.status, t.priority, t.due_date::text AS due_date,
  t.doctor_id, t.visit_id, t.owner_id, t.created_by, t.completed_at, t.cancel_reason, t.updated_at,
  (t.due_date < ${IST_TODAY}) AS overdue, (${IST_TODAY} - t.due_date) AS days_overdue,
  d.full_name AS doctor_name, d.area AS doctor_area, d.mobile AS doctor_mobile,
  crm.staff_name(t.owner_id) AS owner_name, crm.staff_name(t.created_by) AS created_by_name,
  (t.status IN ('done', 'cancelled') AND t.updated_at > now() - interval '${REOPEN_MINUTES} minutes') AS can_reopen`;

const TASK_FROM = `FROM crm.tasks t
  LEFT JOIN crm.doctors d ON d.id = t.doctor_id`;

const BUCKET_SQL = {
  due: `t.status IN ${OPEN} AND t.due_date <= ${IST_TODAY}`,
  upcoming: `t.status IN ${OPEN} AND (t.due_date > ${IST_TODAY} OR t.due_date IS NULL)`,
  done: `t.status IN ('done', 'cancelled') AND t.updated_at > now() - interval '30 days'`,
};

export async function listTasks(crmUser, filters = {}) {
  const bucket = BUCKETS.includes(filters.bucket) ? filters.bucket : "due";
  const owner = ownerScope(crmUser, filters.owner);
  const requested = Math.min(10_000, Math.max(1, Math.floor(Number(filters.page)) || 1));
  return withCrmContext(crmUser, async (sql) => {
    const scope = "t.deleted_at IS NULL AND ($1::uuid IS NULL OR t.owner_id = $1)";
    const { rows: counts } = await sql(
      `SELECT count(*) FILTER (WHERE ${BUCKET_SQL.due})::int AS due,
              count(*) FILTER (WHERE ${BUCKET_SQL.due} AND t.due_date < ${IST_TODAY})::int AS overdue,
              count(*) FILTER (WHERE ${BUCKET_SQL.upcoming})::int AS upcoming,
              count(*) FILTER (WHERE ${BUCKET_SQL.done})::int AS done
         FROM crm.tasks t WHERE ${scope}`,
      [owner],
    );
    const total = counts[0][bucket];
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(requested, pages);
    const order =
      bucket === "done"
        ? "t.updated_at DESC"
        : "t.due_date NULLS LAST, CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at";
    const { rows } = await sql(
      `SELECT ${TASK_COLUMNS} ${TASK_FROM}
        WHERE ${scope} AND ${BUCKET_SQL[bucket]}
        ORDER BY ${order}, t.id
        LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      [owner],
    );
    return {
      bucket,
      counts: counts[0],
      rows,
      page,
      pages,
      total,
      can_assign: isLead(crmUser),
      staff: isLead(crmUser) ? await staffOptions(sql) : [],
    };
  });
}

export async function createTask(crmUser, body = {}) {
  const title = textOf(body.title);
  const note = textOf(body.note);
  const errors = {};
  if (title.length < 3) errors.title = "Write what needs doing, like Send the CME invite.";
  else if (title.length > 200) errors.title = "Keep the task under 200 characters.";
  const today = istDate();
  if (!DAY.test(String(body.due_date || ""))) errors.due_date = "Choose a due date.";
  else if (body.due_date < today) errors.due_date = "The due date cannot be in the past.";
  else if (body.due_date > addDays(today, 365)) errors.due_date = "Choose a date within a year.";
  const priority = body.priority || "normal";
  if (!TASK_PRIORITY_VALUES.includes(priority))
    errors.priority = "Choose a priority from the list.";
  if (note.length > 1000) errors.note = "Keep the note under 1,000 characters.";
  if (body.doctor_id && !UUID.test(body.doctor_id))
    errors.doctor_id = "Choose a doctor from the list.";
  if (Object.keys(errors).length) {
    throw new DoctorError(Object.values(errors)[0], 400, { fields: errors });
  }

  return withCrmContext(crmUser, async (sql) => {
    let ownerId = crmUser.id;
    if (isLead(crmUser) && body.owner_id) {
      const staff = await staffOptions(sql);
      if (!staff.some((s) => s.id === body.owner_id)) {
        throw new DoctorError("Choose a team member from the list.", 400, {
          fields: { owner_id: "Choose a team member from the list." },
        });
      }
      ownerId = body.owner_id;
    }
    if (body.doctor_id) {
      const { rows } = await sql(
        "SELECT id FROM crm.doctors WHERE id = $1 AND deleted_at IS NULL",
        [body.doctor_id],
      );
      if (!rows[0]) {
        throw new DoctorError("Choose a doctor from your list.", 400, {
          fields: { doctor_id: "Choose a doctor from your list." },
        });
      }
    }
    const { rows: hos } = await sql("SELECT id FROM crm.hospitals WHERE code = 'GACH'");
    const { rows } = await sql(
      `INSERT INTO crm.tasks
         (hospital_id, title, description, owner_id, doctor_id, due_date, priority, kind, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8) RETURNING id`,
      [
        hos[0].id,
        title,
        note || null,
        ownerId,
        body.doctor_id || null,
        body.due_date,
        priority,
        crmUser.id,
      ],
    );
    return { id: rows[0].id, owner_id: ownerId };
  });
}

async function ownTask(sql, crmUser, taskId) {
  if (!UUID.test(taskId || "")) throw new DoctorError("Task not found.", 404);
  const { rows } = await sql(
    `SELECT t.*, (t.updated_at > now() - interval '${REOPEN_MINUTES} minutes') AS recent
       FROM crm.tasks t WHERE t.id = $1 AND t.deleted_at IS NULL FOR UPDATE`,
    [taskId],
  );
  const task = rows[0];
  if (!task) throw new DoctorError("Task not found.", 404);
  if (task.owner_id !== crmUser.id && task.created_by !== crmUser.id && !isLead(crmUser)) {
    throw new DoctorError("You can only change your own tasks.", 403);
  }
  return task;
}

export async function completeTask(crmUser, taskId) {
  return withCrmContext(crmUser, async (sql) => {
    const task = await ownTask(sql, crmUser, taskId);
    if (!["open", "in_progress"].includes(task.status)) {
      throw new DoctorError("This task is already closed.", 409);
    }
    await sql(
      `UPDATE crm.tasks SET status = 'done', completed_at = now(), completed_by = $2, updated_at = now()
        WHERE id = $1`,
      [taskId, crmUser.id],
    );
    return { id: taskId, status: "done" };
  });
}

export async function cancelTask(crmUser, taskId, { reason } = {}) {
  const why = textOf(reason);
  if (!why) {
    throw new DoctorError("Write why the task is no longer needed.", 400, {
      fields: { reason: "Write why the task is no longer needed." },
    });
  }
  if (why.length > 200) throw new DoctorError("Keep the reason under 200 characters.");
  return withCrmContext(crmUser, async (sql) => {
    const task = await ownTask(sql, crmUser, taskId);
    if (!["open", "in_progress"].includes(task.status)) {
      throw new DoctorError("This task is already closed.", 409);
    }
    await sql(
      `UPDATE crm.tasks SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1`,
      [taskId, why],
    );
    return { id: taskId, status: "cancelled" };
  });
}

export async function reopenTask(crmUser, taskId) {
  return withCrmContext(crmUser, async (sql) => {
    const task = await ownTask(sql, crmUser, taskId);
    if (!["done", "cancelled"].includes(task.status)) {
      throw new DoctorError("This task is still open.", 409);
    }
    if (!task.recent) {
      throw new DoctorError(`A task can be reopened only within ${REOPEN_MINUTES} minutes.`, 409);
    }
    if (task.kind === "follow_up_visit") {
      const { rows } = await sql(
        `SELECT 1 FROM crm.tasks t WHERE ${OPEN_FOLLOW_UP}
            AND t.owner_id = $1 AND t.doctor_id = $2 AND t.id <> $3`,
        [task.owner_id, task.doctor_id, taskId],
      );
      if (rows[0]) throw new DoctorError("A newer follow-up for this doctor is already open.", 409);
    }
    await sql(
      `UPDATE crm.tasks
          SET status = 'open', completed_at = NULL, completed_by = NULL, cancel_reason = NULL,
              closed_by_visit_id = NULL, updated_at = now()
        WHERE id = $1`,
      [taskId],
    );
    return { id: taskId, status: "open" };
  });
}

export async function todayView(crmUser, { rep } = {}) {
  const lead = isLead(crmUser);
  const owner = lead ? ownerScope(crmUser, rep) : crmUser.id;
  return withCrmContext(crmUser, async (sql) => {
    const scope = "t.deleted_at IS NULL AND ($1::uuid IS NULL OR t.owner_id = $1)";
    const { rows: due } = await sql(
      `SELECT ${TASK_COLUMNS} ${TASK_FROM}
        WHERE ${scope} AND t.kind = 'follow_up_visit' AND ${BUCKET_SQL.due}
          AND d.deleted_at IS NULL
        ORDER BY t.due_date, d.full_name, t.id LIMIT ${LIST_LIMIT}`,
      [owner],
    );
    const { rows: other } = await sql(
      `SELECT ${TASK_COLUMNS} ${TASK_FROM}
        WHERE ${scope} AND t.kind <> 'follow_up_visit' AND ${BUCKET_SQL.due}
        ORDER BY t.due_date, CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.id LIMIT ${LIST_LIMIT}`,
      [owner],
    );
    const { rows: done } = await sql(
      `SELECT v.id, v.doctor_id, d.full_name, d.area, v.visit_type, v.outcome, v.occurred_at,
              v.source, v.executive_id, u.full_name AS rep_name,
              (${istDayOf("v.created_at")} = ${IST_TODAY}) AS logged_today
         FROM crm.visits v
         JOIN crm.doctors d ON d.id = v.doctor_id
         JOIN crm.users u ON u.id = v.executive_id
        WHERE v.deleted_at IS NULL AND ${istDayOf("v.occurred_at")} = ${IST_TODAY}
          AND ($1::uuid IS NULL OR v.executive_id = $1)
        ORDER BY v.occurred_at DESC LIMIT ${LIST_LIMIT}`,
      [owner],
    );
    let team = null;
    if (lead) {
      const { rows } = await sql(
        `SELECT u.id, u.full_name,
                (SELECT count(*)::int FROM crm.visits v
                  WHERE v.executive_id = u.id AND v.deleted_at IS NULL
                    AND ${istDayOf("v.occurred_at")} = ${IST_TODAY}) AS visits_today,
                (SELECT count(DISTINCT v.doctor_id)::int FROM crm.visits v
                  WHERE v.executive_id = u.id AND v.deleted_at IS NULL
                    AND ${istDayOf("v.occurred_at")} = ${IST_TODAY}) AS doctors_today,
                (SELECT count(*)::int FROM crm.tasks t
                  WHERE t.owner_id = u.id AND ${OPEN_FOLLOW_UP} AND t.due_date = ${IST_TODAY}) AS due_today,
                (SELECT count(*)::int FROM crm.tasks t
                  WHERE t.owner_id = u.id AND ${OPEN_FOLLOW_UP} AND t.due_date < ${IST_TODAY}) AS follow_ups_overdue,
                (SELECT count(*)::int FROM crm.tasks t
                  WHERE t.owner_id = u.id AND t.kind <> 'follow_up_visit' AND t.deleted_at IS NULL
                    AND t.status IN ${OPEN} AND t.due_date < ${IST_TODAY}) AS tasks_overdue
           FROM crm.users u
          WHERE u.is_active AND u.deleted_at IS NULL AND u.role = ANY($1::text[])
          ORDER BY u.full_name`,
        [ASSIGNABLE_ROLES],
      );
      team = rows;
    }
    return {
      rep: owner,
      is_lead: lead,
      viewer_id: crmUser.id,
      due,
      other,
      done: done.map((v) => ({
        ...v,
        can_change: lead || (v.executive_id === crmUser.id && v.logged_today),
      })),
      team,
    };
  });
}
