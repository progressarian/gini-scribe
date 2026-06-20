// Patient Flow Management — ordered patient journeys, step timing, and
// role queues. Express + pg (mirrors station-tracking.js / medicineCollection.js).
// All writes run in a transaction and append a flow_events audit row.
// See docs/FLOW_MANAGEMENT_PLAN.md (rev 3).

import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { requireCapability } from "../middleware/auth.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import { sendFlowCheckin } from "../services/msg91.js";
import { seedFlowDemo, cleanFlowDemo } from "../services/flow/demo.js";
import {
  genVisitToken,
  classifyVisit,
  classifyStep,
  compareVisitsForDashboard,
  bottleneckFor,
  deriveStage,
  WAITING_ROLE,
} from "../services/flow/journey.js";

const router = Router();

const ACTOR = (req) =>
  req.doctor?.short_name || req.doctor?.name || (req.doctor?.id ? String(req.doctor.id) : null);

async function logEvent(client, visitId, type, stepOrder, details, by) {
  await client.query(
    `INSERT INTO flow_events (visit_id, event_type, step_order, details, triggered_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [visitId, type, stepOrder ?? null, details ? JSON.stringify(details) : null, by || null],
  );
}

// Mirror flow progress onto the linked OPD appointment's status so the existing
// OPD/GHM pages reflect it (checkedin → in_visit → completed). FORWARD-ONLY and
// never clobbers a cancelled/no_show/seen appointment. Best-effort: runs OUTSIDE
// the flow transaction (own try/catch) so a sync failure never breaks the flow.
// Safe: appointments has no UPDATE trigger (only AFTER INSERT), so this won't
// kick off the OPD backfill pipeline.
const APPT_RANK = { scheduled: 0, checkedin: 1, in_visit: 2, seen: 3, completed: 4 };
async function syncAppointmentStatus(appointmentId, newStatus) {
  if (!appointmentId) return;
  try {
    const cur = (await pool.query("SELECT status FROM appointments WHERE id=$1", [appointmentId]))
      .rows[0];
    if (!cur) return;
    const c = (cur.status || "").toLowerCase();
    if (c === "cancelled" || c === "no_show") return; // never override these
    const newRank = APPT_RANK[newStatus] ?? -1;
    const curRank = APPT_RANK[c] ?? -1;
    if (newRank >= 0 && curRank >= 0 && newRank <= curRank) return; // forward-only
    await pool.query("UPDATE appointments SET status=$2 WHERE id=$1", [appointmentId, newStatus]);
  } catch (e) {
    console.error("Flow appointment status sync failed:", e.message);
  }
}

// Bridge B — make a flow visit visible in OPD/GHM. If it isn't already linked to
// an appointment: find today's appointment for the patient and link it; else
// (default-on, FLOW_CREATE_APPOINTMENTS) create one (booking_source='flow',
// status='checkedin') so walk-ins/new patients appear in OPD/GHM. Best-effort:
// never breaks check-in. Behaves like an existing GHM walk-in insert.
const FLOW_CREATE_APPOINTMENTS = process.env.FLOW_CREATE_APPOINTMENTS !== "false";
async function ensureFlowAppointment(v) {
  if (v.appointment_id) {
    await syncAppointmentStatus(v.appointment_id, "checkedin");
    return v.appointment_id;
  }
  try {
    // Already booked today? Link that one instead of creating a duplicate.
    const params = [];
    const conds = [];
    if (v.patient_db_id) {
      params.push(v.patient_db_id);
      conds.push(`patient_id=$${params.length}`);
    }
    if (v.patient_id) {
      params.push(v.patient_id);
      conds.push(`file_no=$${params.length}`);
    }
    let appt = conds.length
      ? (
          await pool.query(
            `SELECT id FROM appointments WHERE appointment_date::date=CURRENT_DATE AND (${conds.join(" OR ")})
             ORDER BY id DESC LIMIT 1`,
            params,
          )
        ).rows[0]
      : null;

    if (!appt && FLOW_CREATE_APPOINTMENTS) {
      const isWalkin = ["FU_WALK", "NEW_WALK"].includes(v.visit_type_id);
      appt = (
        await pool.query(
          `INSERT INTO appointments
             (patient_id, patient_name, file_no, phone, doctor_name, doctor_id,
              appointment_date, visit_type, status, is_walkin, booking_source)
           VALUES ($1,$2,$3,$4,$5,$6, CURRENT_DATE, 'OPD', 'checkedin', $7, 'flow')
           RETURNING id`,
          [
            v.patient_db_id || null,
            v.patient_name,
            v.patient_id,
            v.patient_phone || null,
            v.assigned_sd_name || null,
            v.assigned_sd || null,
            isWalkin,
          ],
        )
      ).rows[0];
    }

    if (appt) {
      await pool.query("UPDATE flow_visits SET appointment_id=$2 WHERE id=$1", [v.id, appt.id]);
      await syncAppointmentStatus(appt.id, "checkedin");
      return appt.id;
    }
  } catch (e) {
    console.error("Flow ensure appointment failed:", e.message);
  }
  return null;
}

// Reverse sync (OPD/GHM → Flow): if a linked appointment was finished by the
// clinical workflow (doctor marked it `seen`/`completed`), complete the flow
// visit so it stops running as "ongoing/breached"; a deliberate `cancelled`
// cancels it. NOTE: `no_show` is intentionally NOT a cancel trigger — the
// Sheets sync defaults appointments to `no_show` until the patient is marked
// present, so treating it as a cancel would auto-cancel real check-ins.
// Persists the change AND mutates the in-memory rows/steps so the feed reflects
// it immediately. Best-effort; never throws to the caller.
async function reconcileFromAppointments(visits, stepMap) {
  const linked = visits.filter((v) => v.appointment_id && v.status === "in_progress");
  if (!linked.length) return;
  let statusById = {};
  try {
    const ids = [...new Set(linked.map((v) => v.appointment_id))];
    const rows = (
      await pool.query("SELECT id, status FROM appointments WHERE id = ANY($1::int[])", [ids])
    ).rows;
    statusById = Object.fromEntries(rows.map((a) => [a.id, (a.status || "").toLowerCase()]));
  } catch (e) {
    console.error("Flow reverse-sync read failed:", e.message);
    return;
  }
  for (const v of linked) {
    const st = statusById[v.appointment_id];
    try {
      if (st === "completed" || st === "seen") {
        await pool.query(
          `UPDATE flow_visits SET status='completed',
             actual_completion=COALESCE(actual_completion, NOW()), current_step_id=NULL, updated_at=NOW()
           WHERE id=$1 AND status='in_progress'`,
          [v.id],
        );
        // The step they were actually at → completed WITH its measured duration
        // (now − started_at) so the per-step breakdown isn't lost.
        await pool.query(
          `UPDATE flow_visit_steps
             SET status='completed', completed_at=COALESCE(completed_at, NOW()),
                 actual_duration_min = COALESCE(actual_duration_min,
                   CASE WHEN started_at IS NOT NULL
                        THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60))::int
                        END)
           WHERE visit_id=$1 AND status='in_progress'`,
          [v.id],
        );
        // Steps never reached in the flow (patient finished via OPD) → mark
        // COMPLETED (the visit IS done, so the journey should read as done) but
        // leave actual_duration_min NULL and flag them auto_completed. Reports
        // average only steps WITH a real duration, so these don't skew timings;
        // they just stop showing the misleading "skipped" on a finished patient.
        await pool.query(
          `UPDATE flow_visit_steps
             SET status='completed', completed_at=COALESCE(completed_at, NOW()),
                 data = COALESCE(data,'{}'::jsonb) || '{"auto_completed":"opd"}'::jsonb
           WHERE visit_id=$1 AND status IN ('ready','pending')`,
          [v.id],
        );
        await logEvent(pool, v.id, "visit_completed", null, { from_opd: st }, "opd-sync");
        v.status = "completed";
        v.actual_completion = new Date().toISOString();
        (stepMap.get(v.id) || []).forEach((s) => {
          if (s.status === "in_progress") {
            if (s.started_at && s.actual_duration_min == null)
              s.actual_duration_min = Math.max(
                0,
                Math.round((Date.now() - new Date(s.started_at).getTime()) / 60000),
              );
          }
          if (["in_progress", "ready", "pending"].includes(s.status)) s.status = "completed";
        });
      } else if (st === "cancelled") {
        // Only a DELIBERATE cancellation cancels the flow visit. NOT `no_show`:
        // the Sheets sync defaults every appointment to `no_show` until the
        // patient is marked "show", so a flow check-in (which is itself proof
        // the patient is physically present) would get wrongly auto-cancelled.
        await pool.query(
          "UPDATE flow_visits SET status='cancelled', updated_at=NOW() WHERE id=$1 AND status='in_progress'",
          [v.id],
        );
        await logEvent(pool, v.id, "visit_cancelled", null, { from_opd: st }, "opd-sync");
        v.status = "cancelled";
      } else if (st === "in_visit") {
        // OPD has them with the doctor, but the flow stations weren't clicked
        // through — pull the flow forward to the doctor's consult step so the
        // stage matches OPD. Only when the flow is still pre-doctor (behind OPD);
        // never drag a flow that's already past the doctor backwards.
        const steps = (stepMap.get(v.id) || []).slice().sort((a, b) => a.step_order - b.step_order);
        const doc = steps.find(
          (s) =>
            (s.assigned_role === "sd" || s.assigned_role === "chief") &&
            !["completed", "skipped"].includes(s.status),
        );
        const pastDoctor =
          doc &&
          steps.some(
            (s) => s.step_order > doc.step_order && ["in_progress", "completed"].includes(s.status),
          );
        if (doc && doc.status !== "in_progress" && !pastDoctor) {
          // The pre-doctor step they were actually at → completed with measured duration.
          await pool.query(
            `UPDATE flow_visit_steps
               SET status='completed', completed_at=COALESCE(completed_at, NOW()),
                   actual_duration_min = COALESCE(actual_duration_min,
                     CASE WHEN started_at IS NOT NULL
                          THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60))::int
                          END)
               WHERE visit_id=$1 AND step_order < $2 AND status='in_progress'`,
            [v.id, doc.step_order],
          );
          // Earlier steps the patient bypassed in the flow → completed (they're
          // behind the patient now that they're with the doctor), with NULL
          // duration + auto_completed flag so timings stay clean.
          await pool.query(
            `UPDATE flow_visit_steps
               SET status='completed', completed_at=COALESCE(completed_at, NOW()),
                   data = COALESCE(data,'{}'::jsonb) || '{"auto_completed":"opd"}'::jsonb
               WHERE visit_id=$1 AND step_order < $2 AND status IN ('ready','pending')`,
            [v.id, doc.step_order],
          );
          await pool.query(
            `UPDATE flow_visit_steps SET status='in_progress', started_at=COALESCE(started_at, NOW())
               WHERE id=$1`,
            [doc.id],
          );
          await pool.query(
            "UPDATE flow_visits SET current_step_id=$2, current_step_order=$3, updated_at=NOW() WHERE id=$1",
            [v.id, doc.id, doc.step_order],
          );
          await logEvent(
            pool,
            v.id,
            "step_started",
            doc.step_order,
            { from_opd: "in_visit" },
            "opd-sync",
          );
          steps.forEach((s) => {
            if (s.step_order < doc.step_order) {
              if (s.status === "in_progress" && s.started_at && s.actual_duration_min == null)
                s.actual_duration_min = Math.max(
                  0,
                  Math.round((Date.now() - new Date(s.started_at).getTime()) / 60000),
                );
              if (["in_progress", "ready", "pending"].includes(s.status)) s.status = "completed";
            }
          });
          doc.status = "in_progress";
          doc.started_at = new Date().toISOString();
        }
      }
    } catch (e) {
      console.error("Flow reverse-sync update failed:", e.message);
    }
  }
}

// Is the station for (role, staff) already occupied by an in-progress step?
// Waiting-area steps never block. Used to decide auto-start vs. queued (ready).
async function stationBusy(client, role, staffId) {
  if (!role || role === WAITING_ROLE) return false;
  const params = [role];
  let sql = `SELECT 1 FROM flow_visit_steps s
             JOIN flow_visits v ON v.id = s.visit_id
             WHERE s.status='in_progress' AND s.assigned_role=$1
               AND v.status='in_progress' AND v.visit_date=CURRENT_DATE`;
  if (staffId) {
    params.push(staffId);
    sql += ` AND s.assigned_staff_id=$${params.length}`;
  }
  return (await client.query(sql + " LIMIT 1", params)).rowCount > 0;
}

// Recompute suggested wait + estimated completion from the live (non-skipped) steps.
async function recalcEstimate(client, visitId) {
  const r = await client.query(
    `SELECT COALESCE(SUM(planned_duration_min),0)::int AS total
       FROM flow_visit_steps WHERE visit_id=$1 AND status <> 'skipped'`,
    [visitId],
  );
  const total = r.rows[0].total;
  await client.query(
    `UPDATE flow_visits
        SET suggested_wait_min=$2,
            estimated_completion = checkin_time + make_interval(mins => $2),
            updated_at=NOW()
      WHERE id=$1`,
    [visitId, total],
  );
  return total;
}

// ─────────────────────────────────────────────────────────────────────────
// Reference data (journey builder)
// ─────────────────────────────────────────────────────────────────────────
router.get("/flow/visit-types", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM flow_visit_types ORDER BY max_time_min ASC");
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Flow visit types");
  }
});

router.get("/flow/step-catalog", async (req, res) => {
  try {
    // ?all=1 returns inactive steps too (for the admin settings page).
    const where = req.query.all ? "" : "WHERE is_active=true";
    const r = await pool.query(
      `SELECT * FROM flow_step_catalog ${where} ORDER BY display_order ASC`,
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Flow step catalog");
  }
});

// ── Demo data (ADMIN only) — seed/clear sample patients for testing ──
router.post("/flow/demo/seed", requireCapability(CAP.ADMIN), async (req, res) => {
  try {
    const count = await seedFlowDemo();
    res.json({ seeded: true, count });
  } catch (e) {
    handleError(res, e, "Flow demo seed");
  }
});
router.post("/flow/demo/clean", requireCapability(CAP.ADMIN), async (req, res) => {
  try {
    const removed = await cleanFlowDemo();
    res.json({ removed });
  } catch (e) {
    handleError(res, e, "Flow demo clean");
  }
});

// ── Admin settings: edit benchmarks + catalog (ADMIN only) ──
router.patch("/flow/visit-types/:id", requireCapability(CAP.ADMIN), async (req, res) => {
  try {
    const { max_time_min, label, is_flexible } = req.body || {};
    const r = await pool.query(
      `UPDATE flow_visit_types
          SET max_time_min = COALESCE($2, max_time_min),
              label        = COALESCE($3, label),
              is_flexible  = COALESCE($4, is_flexible),
              updated_at   = NOW()
        WHERE id=$1 RETURNING *`,
      [
        req.params.id,
        Number.isInteger(max_time_min) ? max_time_min : null,
        label ?? null,
        typeof is_flexible === "boolean" ? is_flexible : null,
      ],
    );
    if (!r.rows.length) return res.status(404).json({ error: "Visit type not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Flow edit visit type");
  }
});

// ── Step catalog CRUD (ADMIN only) — manage the master list of journey steps ──
// Update any field of a catalog step.
router.patch("/flow/step-catalog/:id", requireCapability(CAP.ADMIN), async (req, res) => {
  try {
    const { default_duration_min, name, station, assigned_role, display_order, is_active } =
      req.body || {};
    const r = await pool.query(
      `UPDATE flow_step_catalog
          SET default_duration_min = COALESCE($2, default_duration_min),
              name                 = COALESCE($3, name),
              station              = COALESCE($4, station),
              assigned_role        = COALESCE($5, assigned_role),
              display_order        = COALESCE($6, display_order),
              is_active            = COALESCE($7, is_active)
        WHERE id=$1 RETURNING *`,
      [
        req.params.id,
        Number.isInteger(default_duration_min) ? default_duration_min : null,
        name ?? null,
        station ?? null,
        assigned_role ?? null,
        Number.isInteger(display_order) ? display_order : null,
        typeof is_active === "boolean" ? is_active : null,
      ],
    );
    if (!r.rows.length) return res.status(404).json({ error: "Catalog step not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Flow edit catalog");
  }
});

// Create a new catalog step. The TEXT primary key is derived from the name
// (slug → lowercased), with a numeric suffix on collision. ADMIN only.
router.post("/flow/step-catalog", requireCapability(CAP.ADMIN), async (req, res) => {
  try {
    const {
      name,
      default_duration_min,
      station = "",
      assigned_role = "flow_coordinator",
      display_order,
    } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
    if (!Number.isInteger(default_duration_min) || default_duration_min < 0)
      return res.status(400).json({ error: "default_duration_min must be a non-negative integer" });

    const base =
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "step";
    // Pick a free id (base, base_2, base_3, …).
    let id = base;
    for (let n = 2; ; n++) {
      const exists = await pool.query("SELECT 1 FROM flow_step_catalog WHERE id=$1", [id]);
      if (!exists.rows.length) break;
      id = `${base}_${n}`;
    }
    // Default display order to the end of the list when not supplied.
    let order = display_order;
    if (!Number.isInteger(order)) {
      const max = await pool.query(
        "SELECT COALESCE(MAX(display_order), 0) + 1 AS next FROM flow_step_catalog",
      );
      order = max.rows[0].next;
    }
    const r = await pool.query(
      `INSERT INTO flow_step_catalog
        (id, name, default_duration_min, station, assigned_role, display_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *`,
      [id, name.trim(), default_duration_min, station, assigned_role, order],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Flow create catalog step");
  }
});

// Delete a catalog step. Blocked if it's used by any default journey (template)
// or any visit's step — deactivate it instead in those cases. ADMIN only.
router.delete("/flow/step-catalog/:id", requireCapability(CAP.ADMIN), async (req, res) => {
  try {
    const id = req.params.id;
    const inTemplate = await pool.query(
      "SELECT 1 FROM flow_step_templates WHERE step_catalog_id=$1 LIMIT 1",
      [id],
    );
    const inVisit = await pool.query(
      "SELECT 1 FROM flow_visit_steps WHERE step_catalog_id=$1 LIMIT 1",
      [id],
    );
    if (inTemplate.rows.length || inVisit.rows.length)
      return res.status(409).json({
        error: "Step is in use by a journey or visit. Uncheck 'Active' to hide it instead.",
      });
    const del = await pool.query("DELETE FROM flow_step_catalog WHERE id=$1 RETURNING id", [id]);
    if (!del.rows.length) return res.status(404).json({ error: "Catalog step not found" });
    res.json({ deleted: id });
  } catch (e) {
    handleError(res, e, "Flow delete catalog step");
  }
});

router.get("/flow/staff", async (req, res) => {
  try {
    const { role } = req.query;
    const params = [];
    let where = "WHERE is_active=true";
    if (role) {
      params.push(role);
      where += ` AND role=$1`;
    }
    const r = await pool.query(
      `SELECT id, name, role FROM flow_staff ${where} ORDER BY name ASC`,
      params,
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Flow staff");
  }
});

// Default journey (template) for a visit type, joined with catalog details.
router.get("/flow/templates/:visitType", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.step_order, t.is_default, t.is_optional, t.condition_key,
              COALESCE(t.override_duration_min, c.default_duration_min) AS planned_duration_min,
              c.id AS step_catalog_id, c.name AS step_name, c.station, c.assigned_role
         FROM flow_step_templates t
         JOIN flow_step_catalog c ON c.id = t.step_catalog_id
        WHERE t.visit_type_id = $1
        ORDER BY t.step_order ASC`,
      [req.params.visitType],
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Flow template");
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Check-in — create visit + steps from the posted journey
// ─────────────────────────────────────────────────────────────────────────
router.post("/flow/checkin", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      patient_id,
      patient_db_id = null,
      appointment_id = null,
      patient_name,
      patient_phone = null,
      patient_age_sex = null,
      visit_type_id,
      appointment_time = null,
      has_tests_available = false,
      patient_status = null,
      is_vip = false,
      notes = null,
      assigned_sd = null,
      assigned_sd_name = null,
      assigned_chief = null,
      assigned_chief_name = null,
      journey_steps = [],
      send_whatsapp = false,
    } = req.body || {};

    if (!patient_id || !patient_name || !visit_type_id) {
      return res.status(400).json({ error: "patient_id, patient_name, visit_type_id required" });
    }
    if (!Array.isArray(journey_steps) || journey_steps.length === 0) {
      return res.status(400).json({ error: "journey_steps must be a non-empty array" });
    }

    const vt = await client.query("SELECT * FROM flow_visit_types WHERE id=$1", [visit_type_id]);
    if (!vt.rows.length) return res.status(400).json({ error: "Unknown visit_type_id" });
    const maxTime = vt.rows[0].max_time_min;

    // Guard against duplicate check-ins: if this patient already has an active
    // (in_progress) flow visit today — by file number, patient record, or the
    // same appointment — block it and point back to the existing visit.
    const dupOr = [];
    const dupParams = [];
    dupParams.push(patient_id);
    dupOr.push(`patient_id = $${dupParams.length}`);
    if (patient_db_id) {
      dupParams.push(patient_db_id);
      dupOr.push(`patient_db_id = $${dupParams.length}`);
    }
    if (appointment_id) {
      dupParams.push(appointment_id);
      dupOr.push(`appointment_id = $${dupParams.length}`);
    }
    const dup = await client.query(
      `SELECT id, patient_name, checkin_time FROM flow_visits
        WHERE status = 'in_progress' AND visit_date::date = CURRENT_DATE
          AND (${dupOr.join(" OR ")})
        ORDER BY checkin_time DESC LIMIT 1`,
      dupParams,
    );
    if (dup.rows.length) {
      const d = dup.rows[0];
      const at = new Date(d.checkin_time).toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      });
      return res.status(409).json({
        error: `${d.patient_name} is already checked in today (at ${at}). Open the existing visit instead of adding a duplicate.`,
        code: "DUPLICATE_CHECKIN",
        visit_id: d.id,
      });
    }

    const totalPlanned = journey_steps.reduce(
      (a, s) => a + (parseInt(s.planned_duration_min) || 0),
      0,
    );

    await client.query("BEGIN");

    // Unique token (retry on the rare collision).
    let token = genVisitToken();
    for (let i = 0; i < 5; i++) {
      const hit = await client.query("SELECT 1 FROM flow_visits WHERE visit_token=$1", [token]);
      if (!hit.rowCount) break;
      token = genVisitToken();
    }

    const visitRes = await client.query(
      `INSERT INTO flow_visits
        (patient_id, patient_db_id, appointment_id, patient_name, patient_phone, patient_age_sex,
         visit_type_id, appointment_time, has_tests_available, patient_status, max_time_min,
         suggested_wait_min, estimated_completion, is_vip, notes, visit_token, checked_in_by,
         assigned_sd, assigned_sd_name, assigned_chief, assigned_chief_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW() + make_interval(mins => $12), $13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        patient_id,
        patient_db_id,
        appointment_id,
        patient_name,
        patient_phone,
        patient_age_sex,
        visit_type_id,
        appointment_time,
        has_tests_available,
        patient_status,
        maxTime,
        totalPlanned,
        is_vip,
        notes,
        token,
        ACTOR(req),
        assigned_sd,
        assigned_sd_name,
        assigned_chief,
        assigned_chief_name,
      ],
    );
    const visit = visitRes.rows[0];

    // Insert steps in order.
    for (let i = 0; i < journey_steps.length; i++) {
      const s = journey_steps[i];
      await client.query(
        `INSERT INTO flow_visit_steps
          (visit_id, step_catalog_id, step_order, step_name, planned_duration_min,
           station, assigned_role, assigned_staff_id, assigned_staff_name, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
        [
          visit.id,
          s.step_catalog_id || null,
          i + 1,
          s.step_name,
          parseInt(s.planned_duration_min) || 0,
          s.station || "",
          s.assigned_role || "",
          s.assigned_staff_id ? String(s.assigned_staff_id) : null,
          s.assigned_staff_name || null,
        ],
      );
    }

    // Auto-start the first step (in_progress if its station is free, else ready).
    const first = (
      await client.query(
        "SELECT * FROM flow_visit_steps WHERE visit_id=$1 ORDER BY step_order ASC LIMIT 1",
        [visit.id],
      )
    ).rows[0];
    const busy = await stationBusy(client, first.assigned_role, first.assigned_staff_id);
    const firstStatus = busy ? "ready" : "in_progress";
    await client.query(
      `UPDATE flow_visit_steps
         SET status=$2, started_at = CASE WHEN $2='in_progress' THEN NOW() ELSE NULL END
       WHERE id=$1`,
      [first.id, firstStatus],
    );
    await client.query(
      "UPDATE flow_visits SET current_step_id=$2, current_step_order=$3 WHERE id=$1",
      [visit.id, first.id, first.step_order],
    );

    await logEvent(
      client,
      visit.id,
      "checkin",
      first.step_order,
      { visit_type_id, totalPlanned },
      ACTOR(req),
    );

    await client.query("COMMIT");

    // Mirror to OPD/GHM: link or create an appointment so the visit appears there.
    await ensureFlowAppointment({
      id: visit.id,
      appointment_id,
      patient_db_id,
      patient_id,
      patient_name,
      patient_phone,
      visit_type_id,
      assigned_sd,
      assigned_sd_name,
    });

    // Best-effort WhatsApp confirmation — never blocks/fails the check-in.
    let whatsappSent = false;
    if (send_whatsapp && patient_phone) {
      try {
        const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
        const host = req.get("host");
        const doneBy = new Date(Date.now() + totalPlanned * 60000).toLocaleTimeString("en-IN", {
          hour: "numeric",
          minute: "2-digit",
        });
        const result = await sendFlowCheckin(patient_phone, {
          patient_name: (patient_name || "").split(" ")[0],
          file_number: patient_id,
          doctor_name: assigned_sd_name
            ? assigned_chief_name
              ? `${assigned_sd_name} → ${assigned_chief_name}`
              : assigned_sd_name
            : assigned_chief_name || "your care team",
          estimate_min: totalPlanned,
          est_completion_time: doneBy,
          visit_link: `${proto}://${host}/visit/${token}`,
        });
        whatsappSent = !!result?.ok;
        await pool.query("UPDATE flow_visits SET whatsapp_sent=true WHERE id=$1", [visit.id]);
        await logEvent(pool, visit.id, "whatsapp_sent", null, { dev: !!result?.dev }, ACTOR(req));
      } catch (waErr) {
        console.error("Flow check-in WhatsApp failed:", waErr.message);
      }
    }

    res.status(201).json({
      visit_id: visit.id,
      visit_token: token,
      suggested_wait_min: totalPlanned,
      whatsapp_sent: whatsappSent,
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow check-in");
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Advance — complete the current step, move to the next
// ─────────────────────────────────────────────────────────────────────────
router.post("/flow/visits/:id/advance", async (req, res) => {
  const client = await pool.connect();
  try {
    const visitId = req.params.id;
    const { step_data = null, step_id = null, skip = false, reason = null } = req.body || {};
    await client.query("BEGIN");

    const visit = (
      await client.query("SELECT * FROM flow_visits WHERE id=$1 FOR UPDATE", [visitId])
    ).rows[0];
    if (!visit) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Visit not found" });
    }

    // Current step = explicit step_id, else the in-progress one, else the lowest open.
    let current = (
      await client.query(
        `SELECT * FROM flow_visit_steps
          WHERE visit_id=$1 AND ($2::uuid IS NULL OR id=$2)
            AND status IN ('in_progress','ready','pending')
          ORDER BY (status='in_progress') DESC, step_order ASC LIMIT 1`,
        [visitId, step_id],
      )
    ).rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "No open step to advance" });
    }

    const actualDur = current.started_at
      ? Math.max(0, Math.round((Date.now() - new Date(current.started_at).getTime()) / 60000))
      : null;
    // skip=true marks the current step 'skipped' (e.g. vitals already taken
    // elsewhere / not needed) instead of 'completed', stamping who/why onto
    // data.skip; the patient still advances to the next step exactly the same.
    const newStatus = skip ? "skipped" : "completed";
    const mergedData = { ...(step_data || {}) };
    if (skip) {
      mergedData.skip = {
        reason: (reason || "").toString().trim().slice(0, 200) || null,
        by: ACTOR(req),
        at: new Date().toISOString(),
      };
    }
    await client.query(
      `UPDATE flow_visit_steps
         SET status=$4, completed_at=NOW(), actual_duration_min=$2,
             data = COALESCE(data,'{}'::jsonb) || $3::jsonb
       WHERE id=$1`,
      [current.id, actualDur, JSON.stringify(mergedData), newStatus],
    );
    await logEvent(
      client,
      visitId,
      skip ? "step_skipped" : "step_completed",
      current.step_order,
      { actual_duration_min: actualDur, reason: skip ? mergedData.skip.reason : undefined },
      ACTOR(req),
    );

    // Next open step in order.
    const next = (
      await client.query(
        `SELECT * FROM flow_visit_steps
          WHERE visit_id=$1 AND step_order > $2 AND status IN ('pending','ready')
          ORDER BY step_order ASC LIMIT 1`,
        [visitId, current.step_order],
      )
    ).rows[0];

    if (next) {
      const busy = await stationBusy(client, next.assigned_role, next.assigned_staff_id);
      const nextStatus = busy ? "ready" : "in_progress";
      await client.query(
        `UPDATE flow_visit_steps
           SET status=$2, started_at = CASE WHEN $2='in_progress' AND started_at IS NULL THEN NOW() ELSE started_at END
         WHERE id=$1`,
        [next.id, nextStatus],
      );
      await client.query(
        "UPDATE flow_visits SET current_step_id=$2, current_step_order=$3, updated_at=NOW() WHERE id=$1",
        [visitId, next.id, next.step_order],
      );
      if (nextStatus === "in_progress")
        await logEvent(client, visitId, "step_started", next.step_order, null, ACTOR(req));
      await client.query("COMMIT");
      // Mirror to OPD: patient with the doctor → in_visit.
      if (["sd", "chief"].includes(next.assigned_role))
        await syncAppointmentStatus(visit.appointment_id, "in_visit");
      return res.json({ status: "advanced", next_step_id: next.id, next_status: nextStatus });
    }

    // No more steps → visit complete.
    await client.query(
      "UPDATE flow_visits SET status='completed', actual_completion=NOW(), current_step_id=NULL, updated_at=NOW() WHERE id=$1",
      [visitId],
    );
    await logEvent(client, visitId, "visit_completed", current.step_order, null, ACTOR(req));
    await client.query("COMMIT");
    // Mirror to OPD: visit finished (pharmacy exit) → completed.
    await syncAppointmentStatus(visit.appointment_id, "completed");
    res.json({ status: "completed" });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow advance");
  } finally {
    client.release();
  }
});

// Cancel a check-in (e.g. started by mistake for a patient not present). Marks
// the visit cancelled. If the linked appointment was created BY the flow
// (booking_source='flow'), cancel that too so it doesn't linger in OPD/GHM; a
// real OPD/GHM appointment is left untouched (the booking still stands).
router.post("/flow/visits/:id/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const visitId = req.params.id;
    const { reason = null } = req.body || {};
    await client.query("BEGIN");
    const v = (await client.query("SELECT * FROM flow_visits WHERE id=$1 FOR UPDATE", [visitId]))
      .rows[0];
    if (!v) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Visit not found" });
    }
    if (v.status === "completed") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Cannot cancel a completed visit" });
    }
    await client.query("UPDATE flow_visits SET status='cancelled', updated_at=NOW() WHERE id=$1", [
      visitId,
    ]);
    await logEvent(client, visitId, "visit_cancelled", null, { reason }, ACTOR(req));
    await client.query("COMMIT");

    // Only roll back appointments the flow itself created.
    if (v.appointment_id) {
      try {
        const appt = (
          await pool.query("SELECT booking_source FROM appointments WHERE id=$1", [
            v.appointment_id,
          ])
        ).rows[0];
        if (appt && appt.booking_source === "flow") {
          await pool.query("UPDATE appointments SET status='cancelled' WHERE id=$1", [
            v.appointment_id,
          ]);
        }
      } catch (e) {
        console.error("Flow cancel appointment cleanup failed:", e.message);
      }
    }
    res.json({ status: "cancelled" });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow cancel");
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Start / Call-in — set a ready/pending step in_progress (one active per station)
// Auto-completes a preceding wait_* step (plan §4.1).
// ─────────────────────────────────────────────────────────────────────────
router.post("/flow/steps/:stepId/start", async (req, res) => {
  const client = await pool.connect();
  try {
    const stepId = req.params.stepId;
    await client.query("BEGIN");
    const step = (
      await client.query("SELECT * FROM flow_visit_steps WHERE id=$1 FOR UPDATE", [stepId])
    ).rows[0];
    if (!step) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Step not found" });
    }
    if (step.status === "in_progress") {
      await client.query("ROLLBACK");
      return res.json({ status: "already_in_progress" });
    }
    if (!["ready", "pending"].includes(step.status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Cannot start a ${step.status} step` });
    }
    if (await stationBusy(client, step.assigned_role, step.assigned_staff_id)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Station busy — complete the current patient first" });
    }

    await client.query(
      "UPDATE flow_visit_steps SET status='in_progress', started_at=NOW() WHERE id=$1",
      [stepId],
    );

    // Auto-complete an immediately-preceding wait_* step still open.
    const prev = (
      await client.query(
        `SELECT * FROM flow_visit_steps
          WHERE visit_id=$1 AND step_order < $2 AND status IN ('in_progress','ready','pending')
          ORDER BY step_order DESC LIMIT 1`,
        [step.visit_id, step.step_order],
      )
    ).rows[0];
    if (prev && prev.assigned_role === WAITING_ROLE) {
      const waited = prev.started_at
        ? Math.max(0, Math.round((Date.now() - new Date(prev.started_at).getTime()) / 60000))
        : 0;
      await client.query(
        "UPDATE flow_visit_steps SET status='completed', completed_at=NOW(), actual_duration_min=$2 WHERE id=$1",
        [prev.id, waited],
      );
      await logEvent(
        client,
        step.visit_id,
        "step_completed",
        prev.step_order,
        { wait_min: waited, auto: true },
        ACTOR(req),
      );
    }

    await client.query(
      "UPDATE flow_visits SET current_step_id=$2, current_step_order=$3, updated_at=NOW() WHERE id=$1",
      [step.visit_id, step.id, step.step_order],
    );
    await logEvent(client, step.visit_id, "step_started", step.step_order, null, ACTOR(req));
    await client.query("COMMIT");
    // Mirror to OPD: doctor called the patient in → in_visit.
    if (["sd", "chief"].includes(step.assigned_role)) {
      const v = (
        await pool.query("SELECT appointment_id FROM flow_visits WHERE id=$1", [step.visit_id])
      ).rows[0];
      await syncAppointmentStatus(v?.appointment_id, "in_visit");
    }
    res.json({ status: "started" });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow start step");
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Coordinator: edit duration / reassign / add / remove
// ─────────────────────────────────────────────────────────────────────────
router.patch("/flow/steps/:stepId/duration", async (req, res) => {
  const client = await pool.connect();
  try {
    const { new_duration_min } = req.body || {};
    const dur = parseInt(new_duration_min);
    if (!Number.isInteger(dur) || dur < 0)
      return res.status(400).json({ error: "new_duration_min must be a non-negative integer" });
    await client.query("BEGIN");
    const step = (
      await client.query(
        "UPDATE flow_visit_steps SET planned_duration_min=$2 WHERE id=$1 RETURNING *",
        [req.params.stepId, dur],
      )
    ).rows[0];
    if (!step) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Step not found" });
    }
    await recalcEstimate(client, step.visit_id);
    await logEvent(
      client,
      step.visit_id,
      "duration_edited",
      step.step_order,
      { new_duration_min: dur },
      ACTOR(req),
    );
    await client.query("COMMIT");
    res.json({ status: "updated" });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow edit duration");
  } finally {
    client.release();
  }
});

router.patch("/flow/steps/:stepId/reassign", async (req, res) => {
  const client = await pool.connect();
  try {
    const { new_staff_id = null, new_staff_name = null, new_role = null } = req.body || {};
    await client.query("BEGIN");
    const step = (
      await client.query(
        `UPDATE flow_visit_steps
            SET assigned_staff_id = COALESCE($2, assigned_staff_id),
                assigned_staff_name = COALESCE($3, assigned_staff_name),
                assigned_role = COALESCE($4, assigned_role)
          WHERE id=$1 RETURNING *`,
        [req.params.stepId, new_staff_id ? String(new_staff_id) : null, new_staff_name, new_role],
      )
    ).rows[0];
    if (!step) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Step not found" });
    }
    await logEvent(
      client,
      step.visit_id,
      "reassigned",
      step.step_order,
      { new_staff_name, new_role },
      ACTOR(req),
    );
    await client.query("COMMIT");
    res.json({ status: "reassigned" });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow reassign");
  } finally {
    client.release();
  }
});

// Add a step after a given order; shift subsequent steps down by one.
router.post("/flow/visits/:id/steps", async (req, res) => {
  const client = await pool.connect();
  try {
    const visitId = req.params.id;
    const {
      step_catalog_id = null,
      step_name,
      planned_duration_min,
      station = "",
      assigned_role = "",
      assigned_staff_id = null,
      assigned_staff_name = null,
      insert_after_order = 0,
    } = req.body || {};
    if (!step_name || planned_duration_min == null)
      return res.status(400).json({ error: "step_name and planned_duration_min required" });

    await client.query("BEGIN");
    const newOrder = parseInt(insert_after_order) + 1;
    // Shift down (highest first to respect the UNIQUE(visit_id, step_order)).
    await client.query(
      `UPDATE flow_visit_steps SET step_order = step_order + 1
        WHERE visit_id=$1 AND step_order >= $2`,
      [visitId, newOrder],
    );
    const ins = await client.query(
      `INSERT INTO flow_visit_steps
        (visit_id, step_catalog_id, step_order, step_name, planned_duration_min,
         station, assigned_role, assigned_staff_id, assigned_staff_name, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING *`,
      [
        visitId,
        step_catalog_id,
        newOrder,
        step_name,
        parseInt(planned_duration_min) || 0,
        station,
        assigned_role,
        assigned_staff_id ? String(assigned_staff_id) : null,
        assigned_staff_name,
      ],
    );
    await recalcEstimate(client, visitId);
    await logEvent(client, visitId, "step_added", newOrder, { step_name }, ACTOR(req));
    await client.query("COMMIT");
    res.status(201).json(ins.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow add step");
  } finally {
    client.release();
  }
});

// Remove a step: skip if already started/active, else hard-delete; reorder.
router.delete("/flow/steps/:stepId", async (req, res) => {
  const client = await pool.connect();
  try {
    const reason = (req.body?.reason || "").toString().trim().slice(0, 200) || null;
    const by = ACTOR(req);
    await client.query("BEGIN");
    const step = (
      await client.query("SELECT * FROM flow_visit_steps WHERE id=$1 FOR UPDATE", [
        req.params.stepId,
      ])
    ).rows[0];
    if (!step) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Step not found" });
    }
    if (step.status === "completed") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Cannot remove a completed step" });
    }
    let mode;
    if (step.status === "in_progress" || step.started_at) {
      // Already-started step → keep it visible as 'skipped' and stamp WHY/WHO/WHEN
      // onto data.skip so the journey can show the reason next to the badge.
      await client.query(
        `UPDATE flow_visit_steps
           SET status='skipped', completed_at=NOW(),
               data = COALESCE(data,'{}'::jsonb)
                      || jsonb_build_object('skip',
                           jsonb_build_object('reason', $2::text, 'by', $3::text, 'at', NOW()))
         WHERE id=$1`,
        [step.id, reason, by],
      );
      mode = "skipped";
    } else {
      await client.query("DELETE FROM flow_visit_steps WHERE id=$1", [step.id]);
      await client.query(
        "UPDATE flow_visit_steps SET step_order = step_order - 1 WHERE visit_id=$1 AND step_order > $2",
        [step.visit_id, step.step_order],
      );
      mode = "removed";
    }
    await recalcEstimate(client, step.visit_id);
    await logEvent(
      client,
      step.visit_id,
      mode === "skipped" ? "step_skipped" : "step_removed",
      step.step_order,
      { step_name: step.step_name, reason },
      by,
    );
    await client.query("COMMIT");
    res.json({ status: mode, reason });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow remove step");
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────
async function stepsByVisit(visitIds) {
  if (!visitIds.length) return new Map();
  const r = await pool.query(
    "SELECT * FROM flow_visit_steps WHERE visit_id = ANY($1::uuid[]) ORDER BY step_order ASC",
    [visitIds],
  );
  const map = new Map();
  for (const s of r.rows) {
    if (!map.has(s.visit_id)) map.set(s.visit_id, []);
    map.get(s.visit_id).push(s);
  }
  return map;
}

// Coordinator dashboard feed.
router.get("/flow/visits", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const params = [date];
    let where = "WHERE visit_date=$1";
    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND status=$${params.length}`;
    }
    const visits = (await pool.query(`SELECT * FROM flow_visits ${where}`, params)).rows;
    const stepMap = await stepsByVisit(visits.map((v) => v.id));
    // Reflect clinical-side completion (OPD/GHM "seen"/"completed") before timing.
    await reconcileFromAppointments(visits, stepMap);
    const now = Date.now();
    for (const v of visits) {
      v.steps = stepMap.get(v.id) || [];
      v._timing = classifyVisit(v, now);
      v.bottleneck = bottleneckFor(v.steps, now);
      v.stage = deriveStage(v, v.steps);
    }
    visits.sort(compareVisitsForDashboard);
    res.json(visits);
  } catch (e) {
    handleError(res, e, "Flow visits");
  }
});

router.get("/flow/visits/:id", async (req, res) => {
  try {
    const v = (await pool.query("SELECT * FROM flow_visits WHERE id=$1", [req.params.id])).rows[0];
    if (!v) return res.status(404).json({ error: "Visit not found" });
    v.steps = (
      await pool.query("SELECT * FROM flow_visit_steps WHERE visit_id=$1 ORDER BY step_order ASC", [
        v.id,
      ])
    ).rows;
    const now = Date.now();
    v._timing = classifyVisit(v, now);
    v.bottleneck = bottleneckFor(v.steps, now);
    v.stage = deriveStage(v, v.steps);
    res.json(v);
  } catch (e) {
    handleError(res, e, "Flow visit");
  }
});

// Active (in-progress) flow visit for a patient today — used by the clinical
// FlowPanel embedded in SD/Chief/Pharmacy views. Match by DB id or file number.
// Returns null (200) when the patient has no live flow visit.
router.get("/flow/active-visit", async (req, res) => {
  try {
    const { patient_db_id, file_no } = req.query;
    if (!patient_db_id && !file_no) return res.json(null);
    const params = [];
    const conds = [];
    if (patient_db_id) {
      params.push(patient_db_id);
      conds.push(`patient_db_id=$${params.length}`);
    }
    if (file_no) {
      params.push(file_no);
      conds.push(`patient_id=$${params.length}`);
    }
    const v = (
      await pool.query(
        `SELECT * FROM flow_visits
          WHERE status='in_progress' AND visit_date=CURRENT_DATE AND (${conds.join(" OR ")})
          ORDER BY checkin_time DESC LIMIT 1`,
        params,
      )
    ).rows[0];
    if (!v) return res.json(null);
    v.steps = (
      await pool.query("SELECT * FROM flow_visit_steps WHERE visit_id=$1 ORDER BY step_order ASC", [
        v.id,
      ])
    ).rows;
    const now = Date.now();
    v._timing = classifyVisit(v, now);
    v.bottleneck = bottleneckFor(v.steps, now);
    v.stage = deriveStage(v, v.steps);
    res.json(v);
  } catch (e) {
    handleError(res, e, "Flow active visit");
  }
});

// Today's OPD/GHM appointment for a patient — read-only, used to pre-fill the
// flow check-in (time, visit type, doctor) and to link flow_visits.appointment_id.
// Never writes to appointments (their INSERT trigger drives OPD backfill).
router.get("/flow/patient-appointment", async (req, res) => {
  try {
    const { patient_db_id, file_no } = req.query;
    const date = req.query.date || new Date().toISOString().split("T")[0];
    if (!patient_db_id && !file_no) return res.json(null);
    const params = [date];
    const conds = [];
    if (patient_db_id) {
      params.push(patient_db_id);
      conds.push(`patient_id=$${params.length}`);
    }
    if (file_no) {
      params.push(file_no);
      conds.push(`file_no=$${params.length}`);
    }
    const r = await pool.query(
      `SELECT id, time_slot, visit_type, doctor_name, status
         FROM appointments
        WHERE appointment_date::date = $1 AND (${conds.join(" OR ")})
        ORDER BY id DESC LIMIT 1`,
      params,
    );
    res.json(r.rows[0] || null);
  } catch (e) {
    handleError(res, e, "Flow patient appointment");
  }
});

// Bridge A — Start flow from an existing OPD/GHM appointment. Creates a flow
// visit (+ default journey) linked to the appointment. Idempotent: returns the
// existing flow visit if one is already linked. Doctor prefilled from the appt.
router.post("/flow/from-appointment/:appointmentId", async (req, res) => {
  const client = await pool.connect();
  try {
    const apptId = req.params.appointmentId;
    const appt = (await client.query("SELECT * FROM appointments WHERE id=$1", [apptId])).rows[0];
    if (!appt) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    // Idempotent — one flow visit per appointment.
    const existing = (
      await client.query(
        "SELECT id, visit_token FROM flow_visits WHERE appointment_id=$1 AND status<>'cancelled' ORDER BY checkin_time DESC LIMIT 1",
        [apptId],
      )
    ).rows[0];
    if (existing) {
      return res.json({ visit_id: existing.id, visit_token: existing.visit_token, existed: true });
    }

    const visitTypeId = appt.is_walkin ? "FU_WALK" : "FU_APPT"; // sensible default; editable on the floor
    const vt = (
      await client.query("SELECT max_time_min FROM flow_visit_types WHERE id=$1", [visitTypeId])
    ).rows[0];
    const tpl = (
      await client.query(
        `SELECT c.id AS step_catalog_id, c.name AS step_name,
                COALESCE(t.override_duration_min, c.default_duration_min)::int AS dur,
                c.station, c.assigned_role
           FROM flow_step_templates t JOIN flow_step_catalog c ON c.id=t.step_catalog_id
          WHERE t.visit_type_id=$1 ORDER BY t.step_order`,
        [visitTypeId],
      )
    ).rows;
    const total = tpl.reduce((a, s) => a + Number(s.dur), 0);

    // Resolve patient db id + file_no.
    const patientDbId = appt.patient_id || null;
    const fileNo = appt.file_no || (patientDbId ? `P_${patientDbId}` : "UNKNOWN");
    const sdId = appt.doctor_id || null;
    const sdName = appt.doctor_name || null;

    await client.query("BEGIN");
    let token = genVisitToken();
    for (let i = 0; i < 5; i++) {
      if (!(await client.query("SELECT 1 FROM flow_visits WHERE visit_token=$1", [token])).rowCount)
        break;
      token = genVisitToken();
    }
    const visit = (
      await client.query(
        `INSERT INTO flow_visits
           (patient_id, patient_db_id, appointment_id, patient_name, patient_phone, visit_type_id,
            appointment_time, max_time_min, suggested_wait_min, estimated_completion,
            visit_token, checked_in_by, assigned_sd, assigned_sd_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW() + make_interval(mins => $9), $10,$11,$12,$13)
         RETURNING *`,
        [
          fileNo,
          patientDbId,
          apptId,
          appt.patient_name || "Patient",
          appt.phone || null,
          visitTypeId,
          appt.time_slot || null,
          vt?.max_time_min || 90,
          total,
          token,
          ACTOR(req),
          sdId,
          sdName,
        ],
      )
    ).rows[0];

    for (let i = 0; i < tpl.length; i++) {
      const s = tpl[i];
      await client.query(
        `INSERT INTO flow_visit_steps
           (visit_id, step_catalog_id, step_order, step_name, planned_duration_min, station, assigned_role,
            assigned_staff_id, assigned_staff_name, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
        [
          visit.id,
          s.step_catalog_id,
          i + 1,
          s.step_name,
          Number(s.dur),
          s.station,
          s.assigned_role,
          s.step_catalog_id === "sd_consult" && sdId ? String(sdId) : null,
          s.step_catalog_id === "sd_consult" && sdName ? sdName : null,
        ],
      );
    }
    const first = (
      await client.query(
        "SELECT * FROM flow_visit_steps WHERE visit_id=$1 ORDER BY step_order ASC LIMIT 1",
        [visit.id],
      )
    ).rows[0];
    const busy = await stationBusy(client, first.assigned_role, first.assigned_staff_id);
    await client.query(
      "UPDATE flow_visit_steps SET status=$2, started_at=CASE WHEN $2='in_progress' THEN NOW() ELSE NULL END WHERE id=$1",
      [first.id, busy ? "ready" : "in_progress"],
    );
    await client.query(
      "UPDATE flow_visits SET current_step_id=$2, current_step_order=$3 WHERE id=$1",
      [visit.id, first.id, first.step_order],
    );
    await logEvent(
      client,
      visit.id,
      "checkin",
      first.step_order,
      { from_appointment: apptId },
      ACTOR(req),
    );
    await client.query("COMMIT");

    await syncAppointmentStatus(apptId, "checkedin");
    res.status(201).json({ visit_id: visit.id, visit_token: token });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow from appointment");
  } finally {
    client.release();
  }
});

// Bridge D — flow progress keyed by appointment_id, for OPD/GHM row chips.
router.get("/flow/by-appointments", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const visits = (
      await pool.query(
        "SELECT * FROM flow_visits WHERE visit_date=$1 AND appointment_id IS NOT NULL",
        [date],
      )
    ).rows;
    const stepMap = await stepsByVisit(visits.map((v) => v.id));
    const now = Date.now();
    const out = {};
    for (const v of visits) {
      const steps = stepMap.get(v.id) || [];
      const t = classifyVisit(v, now);
      const cur = steps.find((s) => s.status === "in_progress");
      out[v.appointment_id] = {
        visit_id: v.id,
        visit_token: v.visit_token,
        status: v.status,
        current_step: cur ? cur.step_name : v.status === "completed" ? "Done" : null,
        pct_elapsed: t.pct_elapsed,
        remaining_min: t.remaining_min,
        urgency: t.urgency,
      };
    }
    res.json(out);
  } catch (e) {
    handleError(res, e, "Flow by appointments");
  }
});

// Station queue for a role: active (in_progress), ready (callable), pending.
router.get("/flow/queue/:role", async (req, res) => {
  try {
    const role = req.params.role;
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const r = await pool.query(
      `SELECT s.*, v.patient_name, v.patient_age_sex, v.patient_id AS file_no, v.is_vip,
              v.visit_type_id, v.max_time_min, v.checkin_time, v.actual_completion, v.status AS visit_status,
              v.patient_db_id,
              (SELECT COUNT(*)::int FROM flow_visit_steps x WHERE x.visit_id=v.id) AS total_steps
         FROM flow_visit_steps s
         JOIN flow_visits v ON v.id = s.visit_id
        WHERE s.assigned_role=$1 AND v.visit_date=$2 AND v.status='in_progress'
          AND s.status IN ('in_progress','ready','pending')
        ORDER BY (s.status='in_progress') DESC, v.is_vip DESC, v.checkin_time ASC`,
      [role, date],
    );
    const now = Date.now();
    const items = r.rows.map((s) => {
      const t = classifyVisit(
        {
          checkin_time: s.checkin_time,
          max_time_min: s.max_time_min,
          actual_completion: s.actual_completion,
          status: s.visit_status,
        },
        now,
      );
      const sc = classifyStep(s, now);
      return {
        ...s,
        visit_remaining_min: t.remaining_min,
        visit_urgency: t.urgency,
        step_timing: sc,
      };
    });
    const doneToday = (
      await pool.query(
        `SELECT COUNT(*)::int n FROM flow_visit_steps s JOIN flow_visits v ON v.id=s.visit_id
          WHERE s.assigned_role=$1 AND v.visit_date=$2 AND s.status='completed'`,
        [role, date],
      )
    ).rows[0].n;
    res.json({
      role,
      active: items.filter((i) => i.status === "in_progress"),
      ready: items.filter((i) => i.status === "ready"),
      pending: items.filter((i) => i.status === "pending"),
      done_today: doneToday,
    });
  } catch (e) {
    handleError(res, e, "Flow queue");
  }
});

// Public patient tracking page (no auth — sanitized, by token only).
router.get("/flow/track/:token", async (req, res) => {
  try {
    const v = (
      await pool.query(
        "SELECT id, patient_name, status, checkin_time, max_time_min, actual_completion FROM flow_visits WHERE visit_token=$1",
        [req.params.token],
      )
    ).rows[0];
    if (!v) return res.status(404).json({ error: "Not found" });
    const steps = (
      await pool.query(
        "SELECT step_order, step_name, status FROM flow_visit_steps WHERE visit_id=$1 ORDER BY step_order ASC",
        [v.id],
      )
    ).rows;
    const t = classifyVisit(v, Date.now());
    const current = steps.find((s) => s.status === "in_progress") || null;
    res.json({
      first_name: (v.patient_name || "").split(" ")[0],
      status: v.status,
      current_step: current ? current.step_name : null,
      step_index: current
        ? current.step_order
        : steps.filter((s) => s.status === "completed").length,
      total_steps: steps.length,
      remaining_min: v.status === "completed" ? 0 : Math.max(0, t.remaining_min),
      timeline: steps.map((s) => ({ name: s.step_name, status: s.status })),
    });
  } catch (e) {
    handleError(res, e, "Flow track");
  }
});

// Public file-number gate: confirms the entered file number matches the visit
// behind this token. Used to unlock the pre-consultation content on the
// patient page. No auth (token + file number are the credentials).
router.post("/flow/track/:token/verify", async (req, res) => {
  try {
    const { file_no } = req.body || {};
    const v = (
      await pool.query("SELECT patient_id FROM flow_visits WHERE visit_token=$1", [
        req.params.token,
      ])
    ).rows[0];
    const ok =
      !!v &&
      !!file_no &&
      String(v.patient_id).trim().toLowerCase() === String(file_no).trim().toLowerCase();
    res.json({ ok });
  } catch (e) {
    handleError(res, e, "Flow verify");
  }
});

// Public: store a patient's functional-aging mini-assessment (file-gated).
// Saved as a flow_event — no new table, no PII beyond the visit link.
router.post("/flow/track/:token/assessment", async (req, res) => {
  try {
    const { file_no, responses } = req.body || {};
    const v = (
      await pool.query("SELECT id, patient_id FROM flow_visits WHERE visit_token=$1", [
        req.params.token,
      ])
    ).rows[0];
    if (
      !v ||
      !file_no ||
      String(v.patient_id).trim().toLowerCase() !== String(file_no).trim().toLowerCase()
    ) {
      return res.status(403).json({ error: "File number does not match this visit" });
    }
    await logEvent(
      pool,
      v.id,
      "patient_assessment",
      null,
      { responses: responses || {} },
      "patient",
    );
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "Flow assessment");
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Reports — benchmark compliance + step bottlenecks (spec §6.4)
// ─────────────────────────────────────────────────────────────────────────
router.get("/flow/reports", async (req, res) => {
  try {
    const start = req.query.start || new Date().toISOString().split("T")[0];
    const end = req.query.end || start;

    const compliance = (
      await pool.query(
        `SELECT v.visit_type_id, t.label, t.max_time_min,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (
                  WHERE v.actual_completion IS NOT NULL
                    AND EXTRACT(EPOCH FROM (v.actual_completion - v.checkin_time))/60 <= v.max_time_min
                )::int AS within_target
           FROM flow_visits v
           JOIN flow_visit_types t ON t.id = v.visit_type_id
          WHERE v.visit_date BETWEEN $1 AND $2 AND v.status='completed'
          GROUP BY v.visit_type_id, t.label, t.max_time_min
          ORDER BY t.max_time_min ASC`,
        [start, end],
      )
    ).rows;

    const bottlenecks = (
      await pool.query(
        `SELECT s.step_name,
                ROUND(AVG(s.planned_duration_min)::numeric,1) AS avg_budget,
                ROUND(AVG(s.actual_duration_min)::numeric,1) AS avg_actual,
                COUNT(*) FILTER (WHERE s.actual_duration_min > s.planned_duration_min)::int AS exceeded_count,
                COUNT(*)::int AS total_count
           FROM flow_visit_steps s
           JOIN flow_visits v ON v.id = s.visit_id
          WHERE v.visit_date BETWEEN $1 AND $2 AND s.status='completed' AND s.actual_duration_min IS NOT NULL
          GROUP BY s.step_name
          ORDER BY (AVG(s.actual_duration_min) - AVG(s.planned_duration_min)) DESC NULLS LAST`,
        [start, end],
      )
    ).rows;

    const summary = (
      await pool.query(
        `SELECT COUNT(*)::int AS total_visits,
                COUNT(*) FILTER (WHERE status='completed')::int AS completed,
                ROUND(AVG(EXTRACT(EPOCH FROM (actual_completion - checkin_time))/60)
                      FILTER (WHERE status='completed')::numeric,0) AS avg_visit_min,
                COUNT(*) FILTER (
                  WHERE status='completed'
                    AND EXTRACT(EPOCH FROM (actual_completion - checkin_time))/60 > max_time_min
                )::int AS breached
           FROM flow_visits
          WHERE visit_date BETWEEN $1 AND $2`,
        [start, end],
      )
    ).rows[0];

    // Per-day breakdown (patients, avg visit, compliance, breaches).
    const daily = (
      await pool.query(
        `SELECT visit_date::text AS day,
                COUNT(*)::int AS patients,
                ROUND(AVG(EXTRACT(EPOCH FROM (actual_completion - checkin_time))/60)
                      FILTER (WHERE status='completed')::numeric,0) AS avg_visit_min,
                COUNT(*) FILTER (WHERE status='completed')::int AS completed,
                COUNT(*) FILTER (
                  WHERE status='completed'
                    AND EXTRACT(EPOCH FROM (actual_completion - checkin_time))/60 <= max_time_min
                )::int AS within_target,
                COUNT(*) FILTER (
                  WHERE status='completed'
                    AND EXTRACT(EPOCH FROM (actual_completion - checkin_time))/60 > max_time_min
                )::int AS breaches
           FROM flow_visits
          WHERE visit_date BETWEEN $1 AND $2
          GROUP BY visit_date ORDER BY visit_date`,
        [start, end],
      )
    ).rows;

    // Worst breach per day (patient + minutes over) to annotate the table.
    const worst = (
      await pool.query(
        `SELECT DISTINCT ON (visit_date) visit_date::text AS day, patient_name,
                ROUND(EXTRACT(EPOCH FROM (actual_completion - checkin_time))/60)::int AS mins,
                max_time_min
           FROM flow_visits
          WHERE visit_date BETWEEN $1 AND $2 AND status='completed'
            AND EXTRACT(EPOCH FROM (actual_completion - checkin_time))/60 > max_time_min
          ORDER BY visit_date,
                   (EXTRACT(EPOCH FROM (actual_completion - checkin_time))/60 - max_time_min) DESC`,
        [start, end],
      )
    ).rows;
    const worstByDay = Object.fromEntries(worst.map((w) => [w.day, w]));
    daily.forEach((d) => {
      d.worst_breach = worstByDay[d.day] || null;
    });

    res.json({ start, end, summary, compliance, bottlenecks, daily });
  } catch (e) {
    handleError(res, e, "Flow reports");
  }
});

export default router;
