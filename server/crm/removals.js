import { withCrmContext } from "./db.js";
import { DoctorError, isLead } from "./doctors.js";
import { DOCTOR_REMOVAL_REASON_VALUES, removalReasonLabel } from "../../shared/crmVocab.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 25;
const FILTERS = ["pending", "approved", "rejected", "cancelled", "removed"];

const noteOf = (v) => {
  const t = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t || null;
};

function assertId(id, what = "Doctor") {
  if (!UUID.test(id || "")) throw new DoctorError(`${what} not found.`, 404);
}

function assertLead(crmUser) {
  if (!isLead(crmUser)) throw new DoctorError("Only your admin can do this.", 403);
}

function readReason({ reason, note }) {
  if (!DOCTOR_REMOVAL_REASON_VALUES.includes(reason)) {
    throw new DoctorError("Choose why this doctor should be removed.", 400, {
      fields: { reason: "Choose why this doctor should be removed." },
    });
  }
  const text = noteOf(note);
  if (reason === "other" && !text) {
    throw new DoctorError("Write a short note explaining the reason.", 400, {
      fields: { note: "Write a short note explaining the reason." },
    });
  }
  if (text && text.length > 500) {
    throw new DoctorError("The note is too long (max 500 letters).", 400, {
      fields: { note: "The note is too long (max 500 letters)." },
    });
  }
  return { reason, note: text };
}

const whenText = (at) =>
  new Date(at).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

async function liveDoctor(sql, doctorId) {
  const { rows } = await sql(
    `SELECT id, hospital_id, full_name, area, mobile, deleted_at
       FROM crm.doctors WHERE id = $1 FOR UPDATE`,
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

async function removeDoctor(sql, crmUser, doctor, { reason, note }) {
  await sql(
    `UPDATE crm.doctors
        SET deleted_at = now(), removed_reason = $2, removed_note = $3, removed_by = $4,
            updated_by = $4
      WHERE id = $1`,
    [doctor.id, reason, note, crmUser.id],
  );
  await sql(
    `UPDATE crm.doctor_assignments SET effective_to = now(), updated_at = now()
      WHERE doctor_id = $1 AND effective_to IS NULL`,
    [doctor.id],
  );
  const { rowCount } = await sql(
    `UPDATE crm.tasks SET status = 'cancelled', updated_at = now()
      WHERE doctor_id = $1 AND deleted_at IS NULL AND status IN ('open', 'in_progress')`,
    [doctor.id],
  );
  return { tasks_cancelled: rowCount };
}

export async function removalImpact(crmUser, doctorId) {
  assertId(doctorId);
  return withCrmContext(crmUser, async (sql) => {
    const { rows } = await sql(
      `SELECT
         (SELECT count(*)::int FROM crm.visits WHERE doctor_id = $1 AND deleted_at IS NULL) AS visits,
         (SELECT count(*)::int FROM crm.doctor_referrals
           WHERE referring_doctor_id = $1 AND deleted_at IS NULL
             AND status NOT IN ('closed', 'lost')) AS open_referrals,
         (SELECT count(*)::int FROM crm.tasks
           WHERE doctor_id = $1 AND deleted_at IS NULL
             AND status IN ('open', 'in_progress')) AS open_tasks`,
      [doctorId],
    );
    return rows[0];
  });
}

export async function requestRemoval(crmUser, doctorId, body = {}) {
  assertId(doctorId);
  const why = readReason(body);
  return withCrmContext(crmUser, async (sql) => {
    const doctor = await liveDoctor(sql, doctorId);
    const { rows: open } = await sql(
      `SELECT r.id, u.full_name AS requested_by_name, r.created_at
         FROM crm.doctor_removal_requests r
         JOIN crm.users u ON u.id = r.requested_by
        WHERE r.doctor_id = $1 AND r.status = 'pending'
        FOR UPDATE OF r`,
      [doctorId],
    );

    if (isLead(crmUser)) {
      const effect = await removeDoctor(sql, crmUser, doctor, why);
      await sql(
        `UPDATE crm.doctor_removal_requests
            SET status = 'approved', decided_by = $2, decided_at = now(),
                decision_note = 'Removed by admin from the doctor page'
          WHERE doctor_id = $1 AND status = 'pending'`,
        [doctorId, crmUser.id],
      );
      return { status: "removed", ...effect };
    }

    if (open[0]) {
      throw new DoctorError(
        `${open[0].requested_by_name} already asked to remove this doctor on ${whenText(open[0].created_at)}.`,
        409,
      );
    }
    const { rows } = await sql(
      `INSERT INTO crm.doctor_removal_requests (hospital_id, doctor_id, requested_by, reason, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, status, created_at`,
      [doctor.hospital_id, doctorId, crmUser.id, why.reason, why.note],
    );
    return { status: "pending", request: rows[0] };
  });
}

export async function cancelRemoval(crmUser, requestId) {
  assertId(requestId, "Request");
  return withCrmContext(crmUser, async (sql) => {
    const { rows } = await sql(
      `SELECT id, status, requested_by FROM crm.doctor_removal_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    const req = rows[0];
    if (!req) throw new DoctorError("Request not found.", 404);
    if (req.requested_by !== crmUser.id && !isLead(crmUser)) {
      throw new DoctorError("Only the person who asked can cancel this request.", 403);
    }
    if (req.status !== "pending") {
      throw new DoctorError("This request has already been decided.", 409);
    }
    await sql(
      `UPDATE crm.doctor_removal_requests
          SET status = 'cancelled', decided_by = $2, decided_at = now()
        WHERE id = $1`,
      [requestId, crmUser.id],
    );
    return { status: "cancelled" };
  });
}

export async function decideRemoval(crmUser, requestId, { approve, note } = {}) {
  assertLead(crmUser);
  assertId(requestId, "Request");
  const text = noteOf(note);
  if (!approve && !text) {
    throw new DoctorError("Write a short note so the team member knows why.", 400, {
      fields: { note: "Write a short note so the team member knows why." },
    });
  }
  if (text && text.length > 500) {
    throw new DoctorError("The note is too long (max 500 letters).", 400);
  }
  return withCrmContext(crmUser, async (sql) => {
    const { rows } = await sql(
      `SELECT r.*, u.full_name AS decided_by_name
         FROM crm.doctor_removal_requests r
         LEFT JOIN crm.users u ON u.id = r.decided_by
        WHERE r.id = $1 FOR UPDATE OF r`,
      [requestId],
    );
    const req = rows[0];
    if (!req) throw new DoctorError("Request not found.", 404);
    if (req.status !== "pending") {
      const verb = { approved: "approved", rejected: "rejected", cancelled: "cancelled" }[
        req.status
      ];
      throw new DoctorError(
        `Already ${verb}${req.decided_by_name ? ` by ${req.decided_by_name}` : ""}${
          req.decided_at ? ` at ${whenText(req.decided_at)}` : ""
        }.`,
        409,
      );
    }
    let effect = {};
    if (approve) {
      const doctor = await liveDoctor(sql, req.doctor_id);
      effect = await removeDoctor(sql, crmUser, doctor, { reason: req.reason, note: req.note });
    }
    await sql(
      `UPDATE crm.doctor_removal_requests
          SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
        WHERE id = $1`,
      [requestId, approve ? "approved" : "rejected", crmUser.id, text],
    );
    return { status: approve ? "approved" : "rejected", ...effect };
  });
}

export async function restoreDoctor(crmUser, doctorId) {
  assertLead(crmUser);
  assertId(doctorId);
  return withCrmContext(crmUser, async (sql) => {
    const { rows } = await sql(
      "SELECT id, full_name, mobile, deleted_at, is_active FROM crm.doctors WHERE id = $1 FOR UPDATE",
      [doctorId],
    );
    const doctor = rows[0];
    if (!doctor) throw new DoctorError("Doctor not found.", 404);
    if (!doctor.deleted_at) throw new DoctorError("This doctor is not removed.", 409);
    if (!doctor.is_active) {
      throw new DoctorError("This doctor was cleared from the CRM and cannot be restored.", 409);
    }
    if (doctor.mobile) {
      const { rows: clash } = await sql(
        `SELECT full_name FROM crm.doctors
          WHERE deleted_at IS NULL AND id <> $1
            AND mobile_e164 = crm.normalize_phone($2) LIMIT 1`,
        [doctorId, doctor.mobile],
      );
      if (clash[0]) {
        throw new DoctorError(
          `Cannot restore: the mobile ${doctor.mobile} is now used by ${clash[0].full_name}.`,
          409,
        );
      }
    }
    const { rows: last } = await sql(
      `SELECT a.executive_id, u.full_name
         FROM crm.doctor_assignments a
         JOIN crm.users u ON u.id = a.executive_id AND u.is_active AND u.deleted_at IS NULL
        WHERE a.doctor_id = $1 AND a.effective_to IS NOT NULL
        ORDER BY a.effective_to DESC LIMIT 1`,
      [doctorId],
    );
    await sql(
      `UPDATE crm.doctors
          SET deleted_at = NULL, removed_reason = NULL, removed_note = NULL, removed_by = NULL,
              updated_by = $2
        WHERE id = $1`,
      [doctorId, crmUser.id],
    );
    if (last[0]) {
      await sql(
        `INSERT INTO crm.doctor_assignments
           (hospital_id, doctor_id, executive_id, manager_id, territory_id, assigned_by, reason)
         SELECT d.hospital_id, d.id, u.id, u.manager_id, d.territory_id, $3, 'Restored'
           FROM crm.doctors d, crm.users u WHERE d.id = $1 AND u.id = $2`,
        [doctorId, last[0].executive_id, crmUser.id],
      );
    }
    return { status: "restored", owner_name: last[0]?.full_name ?? null };
  });
}

export async function listRemovals(crmUser, { status = "pending", page = 1, mine } = {}) {
  const filter = FILTERS.includes(status) ? status : "pending";
  const requested = Math.min(10_000, Math.max(1, Math.floor(Number(page)) || 1));
  const onlyMine = !isLead(crmUser) || mine === "1";
  if (filter === "removed") assertLead(crmUser);
  return withCrmContext(crmUser, async (sql) => {
    const { rows: counts } = await sql(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending
         FROM crm.doctor_removal_requests WHERE ($1::uuid IS NULL OR requested_by = $1)`,
      [onlyMine ? crmUser.id : null],
    );

    if (filter === "removed") {
      const { rows: total } = await sql(
        "SELECT count(*)::int AS n FROM crm.doctors WHERE deleted_at IS NOT NULL AND is_active",
      );
      const pageNo = Math.min(requested, Math.max(1, Math.ceil(total[0].n / PAGE_SIZE)));
      const { rows } = await sql(
        `SELECT d.id AS doctor_id, d.full_name, d.area, d.mobile, d.specialty, d.deleted_at,
                d.removed_reason, d.removed_note, u.full_name AS removed_by_name
           FROM crm.doctors d
           LEFT JOIN crm.users u ON u.id = d.removed_by
          WHERE d.deleted_at IS NOT NULL AND d.is_active
          ORDER BY d.deleted_at DESC, d.id
          LIMIT ${PAGE_SIZE} OFFSET ${(pageNo - 1) * PAGE_SIZE}`,
      );
      return {
        status: filter,
        counts: counts[0],
        rows: rows.map((r) => ({ ...r, reason_label: removalReasonLabel(r.removed_reason) })),
        page: pageNo,
        pages: Math.max(1, Math.ceil(total[0].n / PAGE_SIZE)),
        total: total[0].n,
      };
    }

    const params = [filter, onlyMine ? crmUser.id : null];
    const where = "r.status = $1 AND ($2::uuid IS NULL OR r.requested_by = $2)";
    const { rows: total } = await sql(
      `SELECT count(*)::int AS n FROM crm.doctor_removal_requests r WHERE ${where}`,
      params,
    );
    const pageNo = Math.min(requested, Math.max(1, Math.ceil(total[0].n / PAGE_SIZE)));
    const { rows } = await sql(
      `SELECT r.id, r.doctor_id, r.reason, r.note, r.status, r.created_at, r.decided_at,
              r.decision_note,
              d.full_name, d.area, d.mobile, d.specialty, d.deleted_at,
              req.full_name AS requested_by_name, dec.full_name AS decided_by_name,
              own.full_name AS owner_name,
              (SELECT count(*)::int FROM crm.visits v
                WHERE v.doctor_id = r.doctor_id AND v.deleted_at IS NULL) AS visits,
              (SELECT count(*)::int FROM crm.visits v
                WHERE v.doctor_id = r.doctor_id AND v.deleted_at IS NULL
                  AND v.created_at > r.created_at) AS visits_since,
              (SELECT count(*)::int FROM crm.doctor_referrals x
                WHERE x.referring_doctor_id = r.doctor_id AND x.deleted_at IS NULL
                  AND x.status NOT IN ('closed', 'lost')) AS open_referrals,
              (SELECT count(*)::int FROM crm.tasks t
                WHERE t.doctor_id = r.doctor_id AND t.deleted_at IS NULL
                  AND t.status IN ('open', 'in_progress')) AS open_tasks
         FROM crm.doctor_removal_requests r
         JOIN crm.doctors d ON d.id = r.doctor_id
         JOIN crm.users req ON req.id = r.requested_by
         LEFT JOIN crm.users dec ON dec.id = r.decided_by
         LEFT JOIN crm.doctor_assignments a ON a.doctor_id = d.id AND a.effective_to IS NULL
         LEFT JOIN crm.users own ON own.id = a.executive_id
        WHERE ${where}
        ORDER BY ${filter === "pending" ? "r.created_at ASC" : "coalesce(r.decided_at, r.created_at) DESC"}, r.id
        LIMIT ${PAGE_SIZE} OFFSET ${(pageNo - 1) * PAGE_SIZE}`,
      params,
    );
    return {
      status: filter,
      counts: counts[0],
      rows: rows.map((r) => ({ ...r, reason_label: removalReasonLabel(r.reason) })),
      page: pageNo,
      pages: Math.max(1, Math.ceil(total[0].n / PAGE_SIZE)),
      total: total[0].n,
    };
  });
}

export async function doctorRemovalState(sql, crmUser, doctorId) {
  const { rows } = await sql(
    `SELECT r.id, r.status, r.reason, r.note, r.created_at, r.decided_at, r.decision_note,
            r.requested_by, req.full_name AS requested_by_name, dec.full_name AS decided_by_name
       FROM crm.doctor_removal_requests r
       JOIN crm.users req ON req.id = r.requested_by
       LEFT JOIN crm.users dec ON dec.id = r.decided_by
      WHERE r.doctor_id = $1 AND r.status IN ('pending', 'rejected')
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 1`,
    [doctorId],
  );
  const r = rows[0];
  if (!r) return null;
  if (r.status === "rejected" && Date.now() - new Date(r.decided_at).getTime() > 30 * 86400000) {
    return null;
  }
  return {
    ...r,
    reason_label: removalReasonLabel(r.reason),
    mine: r.requested_by === crmUser.id,
  };
}
