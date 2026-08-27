// Patient Flow Management — ordered patient journeys, step timing, and
// role queues. Express + pg (mirrors station-tracking.js / medicineCollection.js).
// All writes run in a transaction and append a flow_events audit row.
// See docs/FLOW_MANAGEMENT_PLAN.md (rev 3).

import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { fetchBlockRow, resolvePatientId } from "../services/patientBlockGuard.js";
import { redactBlock } from "../services/patientBlockView.js";
import { requireCapability } from "../middleware/auth.js";
import {
  CAPABILITIES as CAP,
  hasAnyCapability,
  canWorkStationRole,
  ownsStationRole,
  hasOwnConsultQueue,
} from "../../shared/permissions.js";
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
import { fetchPatientTransactions } from "../services/healthray/client.js";
import { transactionsToBilling } from "../services/healthray/billingExtractor.js";

// Blocked patients are hidden from working lists — nobody should be calling,
// booking or preparing for them. They stay findable in /find and on the admin
// Blocked tab. See docs/PATIENT_BLOCKLIST_PLAN.md §4.3
const NOT_BLOCKED = (a = "a") =>
  ` AND NOT EXISTS (SELECT 1 FROM patients bp WHERE bp.id = ${a}.patient_id AND bp.is_blocked)`;

const router = Router();

// The JWT carries doctor_name / doctor_id (see auth.js login), not name / id —
// without those fallbacks every doctor with no short_name logged as null.
const ACTOR = (req) =>
  req.doctor?.short_name ||
  req.doctor?.doctor_name ||
  req.doctor?.name ||
  (req.doctor?.doctor_id ? String(req.doctor.doctor_id) : null);

async function logEvent(client, visitId, type, stepOrder, details, by) {
  await client.query(
    `INSERT INTO flow_events (visit_id, event_type, step_order, details, triggered_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [visitId, type, stepOrder ?? null, details ? JSON.stringify(details) : null, by || null],
  );
}

// Collapse the day's rows to one visit per patient. A patient can end up with
// several flow_visits rows in a day (re-check-in after completion, a manual
// check-in plus an appointment-linked row, etc.) and the raw table has no
// per-patient/day uniqueness — so counting rows over-reports "Completed".
// Keep the most-complete row, tie-broken by the latest check-in. Patients are
// keyed by patient_db_id when present, else by patient_id (file number).
const VISIT_STATUS_RANK = { completed: 3, in_progress: 2, waiting: 1, paused: 1, cancelled: 0 };
function dedupeVisitsByPatient(visits) {
  const best = new Map();
  for (const v of visits) {
    const key = v.patient_db_id != null ? `db:${v.patient_db_id}` : `file:${v.patient_id}`;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, v);
      continue;
    }
    const rv = VISIT_STATUS_RANK[v.status] ?? 0;
    const rc = VISIT_STATUS_RANK[cur.status] ?? 0;
    const better =
      rv !== rc
        ? rv > rc
        : new Date(v.checkin_time).getTime() > new Date(cur.checkin_time).getTime();
    if (better) best.set(key, v);
  }
  return [...best.values()];
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
          //
          // NOT background steps: lab processing that is genuinely still running
          // must not be closed just because the patient reached the doctor —
          // that would report results as available when they are not.
          await pool.query(
            `UPDATE flow_visit_steps
               SET status='completed', completed_at=COALESCE(completed_at, NOW()),
                   data = COALESCE(data,'{}'::jsonb) || '{"auto_completed":"opd"}'::jsonb
               WHERE visit_id=$1 AND step_order < $2 AND status IN ('ready','pending')
                 AND NOT is_background`,
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
// Is the station occupied, from the point of view of whoever is asking?
//
//   • named steps (SD, Chief) — that doctor sees one patient at a time
//   • unnamed steps + an actor — the desk is shared, so only THIS person's own
//     in-progress patient blocks them. Two lab techs can collect at once; one
//     tech still cannot start a second patient. Ownership comes from the claim,
//     since these steps carry no assigned_staff_id (0 of 2,848 MO steps do).
//   • unnamed steps, no actor — automation (auto-advance, HealthRay). Kept
//     role-wide and conservative: nobody is at the desk deciding, so it must not
//     park several patients in_progress at once.
//
// is_background never counts: lab reporting runs unattended.
const LAB_ROLE = "lab_tech";
const REPORT_ROLE = "report_desk";
const PAYMENT_STATES = ["paid", "due", "unbilled"];

// Money and destination, confirmed before the needle goes in. Neither blocks the
// call-in: an unpaid patient is warned about and recorded, never turned away, because
// HealthRay often generates the bill after the visit. The route only enforces that a
// non-paid state carries a reason and an outside test names its lab.
function labCallInChecks(req) {
  const { payment, outside } = req.body || {};
  if (!payment && !outside) return null;
  const out = {};
  if (payment) {
    const status = String(payment.status || "").toLowerCase();
    if (!PAYMENT_STATES.includes(status)) {
      throw new Error("Unknown payment status");
    }
    const note = String(payment.note || "").trim();
    if (status !== "paid" && !note) {
      throw new Error("Give a reason for collecting before payment");
    }
    out.payment = {
      status,
      due_amount: Number(payment.due_amount) || 0,
      note: note || null,
      source: payment.source === "manual" ? "manual" : "healthray",
      by: ACTOR(req),
      at: new Date().toISOString(),
    };
  }
  if (outside) {
    const sent = outside.sent === true || outside.sent === "true";
    const labName = String(outside.lab_name || "").trim();
    if (sent && !labName) throw new Error("Name the outside lab");
    out.outside = {
      sent,
      lab_name: sent ? labName : null,
      expected_on: sent && outside.expected_on ? String(outside.expected_on).slice(0, 10) : null,
      by: ACTOR(req),
      at: new Date().toISOString(),
    };
  }
  return out;
}

// A test the patient has gone elsewhere for. Our lab never touches the sample, so
// the courier and machine stages are fiction — drop them, but only once no test on
// the visit is still ours. A patient with bloods outside and an X-Ray here still
// needs the lab to deliver and process the X-Ray.
async function applyOutsideTest(client, visitId, outside) {
  await client.query(
    `UPDATE flow_visit_steps
        SET assigned_role=$2, station=$3,
            data = COALESCE(data,'{}'::jsonb) || $4::jsonb
      WHERE visit_id=$1 AND step_catalog_id='lab_reports'
        AND status NOT IN ('completed','skipped')`,
    [
      visitId,
      REPORT_ROLE,
      "Assistant Station",
      JSON.stringify({
        awaiting_outside: { lab_name: outside.lab_name, expected_on: outside.expected_on },
      }),
    ],
  );
  if (outside.mode !== "patient_goes") return;
  const ours = await client.query(
    `SELECT 1 FROM flow_visit_steps
      WHERE visit_id=$1 AND assigned_role=$2 AND NOT is_background
        AND (status IN ('in_progress','ready','pending')
             OR (status='completed' AND COALESCE(data->'outside'->>'mode','') <> 'patient_goes'))
      LIMIT 1`,
    [visitId, LAB_ROLE],
  );
  if (ours.rowCount) return;
  await client.query(
    `UPDATE flow_visit_steps
        SET status='skipped', completed_at=NOW(),
            data = COALESCE(data,'{}'::jsonb) || $2::jsonb
      WHERE visit_id=$1 AND step_catalog_id IN ('lab_delivered','lab_processing')
        AND status NOT IN ('completed','skipped')`,
    [
      visitId,
      JSON.stringify({
        outside_dropped: true,
        skip: {
          reason: `Test done at ${outside.lab_name} — our lab never handles the sample`,
          by: "system",
          at: new Date().toISOString(),
        },
      }),
    ],
  );
}

async function stationBusy(client, role, staffId, actorId = null, exceptVisitId = null) {
  if (!role || role === WAITING_ROLE) return false;
  const params = [role];
  let sql = `SELECT 1 FROM flow_visit_steps s
             JOIN flow_visits v ON v.id = s.visit_id
             WHERE s.status='in_progress' AND s.assigned_role=$1 AND NOT s.is_background
               AND v.status='in_progress' AND v.visit_date=CURRENT_DATE`;
  if (staffId) {
    params.push(staffId);
    sql += ` AND s.assigned_staff_id=$${params.length}`;
  } else if (actorId != null) {
    params.push(String(actorId));
    sql += ` AND s.data->'claim'->>'by_id' = $${params.length}`;
  }
  if (exceptVisitId) {
    params.push(exceptVisitId);
    sql += ` AND s.visit_id <> $${params.length}`;
  }
  return (await client.query(sql + " LIMIT 1", params)).rowCount > 0;
}

// Attach the background stages that belong to any test step on this visit.
//
// Templates cover the routine blood draw, but ABI and X-Ray are never in a
// template — they are added by hand at check-in or from "+ Add step" — so the
// stages have to follow their parent on insert rather than on template. Runs
// after the steps are written and renumbers 1..N, which also keeps the
// UNIQUE (visit_id, step_order) constraint satisfied without a deferred check.
async function attachBackgroundStages(client, visitId) {
  const steps = (
    await client.query(
      `SELECT id, step_catalog_id, step_order FROM flow_visit_steps
        WHERE visit_id=$1 ORDER BY step_order ASC`,
      [visitId],
    )
  ).rows;
  const parents = steps.map((s) => s.step_catalog_id).filter(Boolean);
  if (!parents.length) return 0;
  const present = new Set(parents);
  const kids = (
    await client.query(
      `SELECT id, name, default_duration_min, station, assigned_role,
              parent_step_catalog_id, attach_when_any
         FROM flow_step_catalog
        WHERE is_background AND is_active
          AND (parent_step_catalog_id = ANY($1::text[]) OR attach_when_any && $1::text[])
        ORDER BY display_order ASC`,
      [parents],
    )
  ).rows.filter((k) => !present.has(k.id));
  if (!kids.length) return 0;

  // Park existing rows out of the way, then lay the whole journey back down in
  // order with each parent immediately followed by its stages.
  await client.query(
    `UPDATE flow_visit_steps SET step_order = step_order + 10000 WHERE visit_id=$1`,
    [visitId],
  );
  let order = 0;
  for (const s of steps) {
    order += 1;
    await client.query("UPDATE flow_visit_steps SET step_order=$2 WHERE id=$1", [s.id, order]);
    const mine = kids.filter((k) =>
      k.attach_when_any?.length
        ? // attaches once, after the last test it applies to
          k.attach_when_any.includes(s.step_catalog_id) &&
          !steps.some(
            (o) => o.step_order > s.step_order && k.attach_when_any.includes(o.step_catalog_id),
          )
        : k.parent_step_catalog_id === s.step_catalog_id,
    );
    for (const k of mine) {
      order += 1;
      await client.query(
        `INSERT INTO flow_visit_steps
           (visit_id, step_catalog_id, step_order, step_name, planned_duration_min,
            station, assigned_role, status, is_background)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',TRUE)`,
        [visitId, k.id, order, k.name, k.default_duration_min, k.station, k.assigned_role],
      );
    }
  }
  return kids.length;
}

// Keep exactly one lab stage running once a test has actually been taken.
//
// Stages used to sit `pending` until someone completed them, so started_at was
// never set and every actual_duration_min came out NULL — the stages recorded
// no time at all, which defeats the point of having them. Completing one starts
// the next, so each is measured from when the previous finished.
async function runNextLabStage(client, visitId) {
  const taken = await client.query(
    `SELECT 1 FROM flow_visit_steps a
       JOIN flow_visit_steps b
         ON b.visit_id = a.visit_id AND b.is_background AND b.assigned_role = a.assigned_role
      WHERE a.visit_id = $1 AND NOT a.is_background AND a.status = 'completed'
      LIMIT 1`,
    [visitId],
  );
  if (!taken.rowCount) return;
  const running = await client.query(
    `SELECT 1 FROM flow_visit_steps
      WHERE visit_id=$1 AND is_background AND status='in_progress' LIMIT 1`,
    [visitId],
  );
  if (running.rowCount) return;
  await client.query(
    `UPDATE flow_visit_steps
        SET status='in_progress', started_at = COALESCE(started_at, NOW())
      WHERE id = (SELECT id FROM flow_visit_steps
                   WHERE visit_id=$1 AND is_background AND status IN ('pending','ready')
                   ORDER BY step_order ASC LIMIT 1)`,
    [visitId],
  );
}

// Recompute suggested wait + estimated completion from the live (non-skipped) steps.
async function recalcEstimate(client, visitId) {
  const r = await client.query(
    `SELECT COALESCE(SUM(planned_duration_min),0)::int AS total
       FROM flow_visit_steps
      WHERE visit_id=$1 AND status <> 'skipped' AND NOT is_background`,
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
    //
    // Background stages are never offered on their own: they belong to a test
    // and are attached by attachBackgroundStages() when that test is added.
    // Listing them here let a stage be picked for a visit with no parent test
    // at all, which is how "Blood — reports available" once landed on a
    // follow-up that had no blood draw.
    const where = req.query.all
      ? "WHERE NOT is_background"
      : "WHERE is_active=true AND NOT is_background";
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
    // ?set=lab  — the lab hand-walk set, parked at step 1, no HealthRay data
    // ?set=rx   — the prescription set, parked either side of "Prescription — ready"
    const KNOWN_SETS = ["lab", "rx"];
    const set = KNOWN_SETS.includes(req.query.set) ? req.query.set : "dashboard";
    const count = await seedFlowDemo(undefined, set);
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

// Create a new visit-type benchmark. The TEXT primary key (code) is derived
// from the label (slug → UPPERCASE) unless one is supplied, with a numeric
// suffix on collision. New types have no journey template yet — build one in
// the journey builder before check-ins can use them. ADMIN only.
router.post("/flow/visit-types", requireCapability(CAP.ADMIN), async (req, res) => {
  try {
    const { id: rawId, label, max_time_min, is_flexible = false, color = "sk" } = req.body || {};
    if (!label || !label.trim()) return res.status(400).json({ error: "label is required" });
    if (!Number.isInteger(max_time_min) || max_time_min < 1)
      return res.status(400).json({ error: "max_time_min must be a positive integer" });

    const slug = (s) =>
      String(s)
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);
    const base = slug(rawId || label) || "TYPE";
    // Pick a free id (BASE, BASE_2, BASE_3, …).
    let id = base;
    for (let n = 2; ; n++) {
      const exists = await pool.query("SELECT 1 FROM flow_visit_types WHERE id=$1", [id]);
      if (!exists.rows.length) break;
      id = `${base}_${n}`;
    }
    const r = await pool.query(
      `INSERT INTO flow_visit_types (id, label, max_time_min, color, is_flexible)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, label.trim(), max_time_min, color || "sk", is_flexible === true],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Flow create visit type");
  }
});

// Delete a visit-type benchmark. Blocked if it's referenced by any journey
// template or any (live/historical) visit — those FKs are NOT NULL, so the
// five built-in types can never be deleted; only unused custom types can.
router.delete("/flow/visit-types/:id", requireCapability(CAP.ADMIN), async (req, res) => {
  try {
    const id = req.params.id;
    const inTemplate = await pool.query(
      "SELECT 1 FROM flow_step_templates WHERE visit_type_id=$1 LIMIT 1",
      [id],
    );
    const inVisit = await pool.query("SELECT 1 FROM flow_visits WHERE visit_type_id=$1 LIMIT 1", [
      id,
    ]);
    if (inTemplate.rows.length || inVisit.rows.length)
      return res.status(409).json({
        error: "Visit type is in use by a journey or patient visit and cannot be deleted.",
      });
    const del = await pool.query("DELETE FROM flow_visit_types WHERE id=$1 RETURNING id", [id]);
    if (!del.rows.length) return res.status(404).json({ error: "Visit type not found" });
    res.json({ deleted: id });
  } catch (e) {
    handleError(res, e, "Flow delete visit type");
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
      token_number = null,
      assigned_sd = null,
      assigned_sd_name = null,
      assigned_chief = null,
      assigned_chief_name = null,
      journey_steps = [],
      send_whatsapp = false,
      start_mode = "now",
    } = req.body || {};

    // Deferred start: park the visit in 'waiting' with the clock stopped (no
    // timer, no auto-started step) until reception presses ▶ Start. Used when a
    // patient is registered but still waiting for the doctor / a slot change.
    const deferred = start_mode === "later";

    // Free text typed by reception off the physical token slip — trim and cap
    // it rather than validating a format; every counter numbers differently.
    const tokenNumber =
      String(token_number ?? "")
        .trim()
        .slice(0, 32) || null;

    if (!patient_id || !patient_name || !visit_type_id) {
      return res.status(400).json({ error: "patient_id, patient_name, visit_type_id required" });
    }
    if (!Array.isArray(journey_steps) || journey_steps.length === 0) {
      return res.status(400).json({ error: "journey_steps must be a non-empty array" });
    }

    // Blocklist — a WARNING here, not a refusal. The person is standing at the
    // desk; reception needs to be told, not stonewalled. The hard stop lives on
    // the booking paths. Their WhatsApp confirmation is suppressed below.
    // NB: flow's `patient_id` is the file number; `patient_db_id` is patients.id.
    const blockPatientId =
      patient_db_id || (await resolvePatientId({ fileNo: patient_id, phone: patient_phone }));
    const blockRow = await fetchBlockRow(blockPatientId);
    const patientBlocked = !!blockRow?.is_blocked;

    const vt = await client.query("SELECT * FROM flow_visit_types WHERE id=$1", [visit_type_id]);
    if (!vt.rows.length) return res.status(400).json({ error: "Unknown visit_type_id" });
    const maxTime = vt.rows[0].max_time_min;

    // Guard against duplicate check-ins: if this patient already has a visit
    // today — active OR already completed — by file number, patient record, or
    // the same appointment, block it and point back to the existing visit.
    // 'completed' is included so a re-check-in of a patient already seen today
    // can't spawn a second row that inflates the "Completed" count. Only a
    // deliberately 'cancelled' visit leaves the patient free to check in afresh.
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
      `SELECT id, patient_name, checkin_time, status FROM flow_visits
        WHERE status IN ('in_progress','waiting','paused','completed') AND visit_date::date = CURRENT_DATE
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
      const verb = d.status === "completed" ? "was already seen" : "is already checked in";
      return res.status(409).json({
        error: `${d.patient_name} ${verb} today (at ${at}). Open the existing visit instead of adding a duplicate.`,
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

    // $21 = startNow: when false (deferred), the clock and ETA stay NULL until
    // the timer is started later.
    const startNow = !deferred;
    const visitRes = await client.query(
      `INSERT INTO flow_visits
        (patient_id, patient_db_id, appointment_id, patient_name, patient_phone, patient_age_sex,
         visit_type_id, appointment_time, has_tests_available, patient_status, max_time_min,
         suggested_wait_min, estimated_completion, is_vip, notes, visit_token, checked_in_by,
         assigned_sd, assigned_sd_name, assigned_chief, assigned_chief_name, token_number,
         status, timer_started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
         CASE WHEN $21 THEN NOW() + make_interval(mins => $12) ELSE NULL END,
         $13,$14,$15,$16,$17,$18,$19,$20,$22,
         CASE WHEN $21 THEN 'in_progress' ELSE 'waiting' END,
         CASE WHEN $21 THEN NOW() ELSE NULL END)
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
        startNow,
        tokenNumber,
      ],
    );
    const visit = visitRes.rows[0];

    // Insert steps in order.
    for (let i = 0; i < journey_steps.length; i++) {
      const s = journey_steps[i];
      await client.query(
        `INSERT INTO flow_visit_steps
          (visit_id, step_catalog_id, step_order, step_name, planned_duration_min,
           station, assigned_role, assigned_staff_id, assigned_staff_name, status, is_background)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',
                 COALESCE((SELECT is_background FROM flow_step_catalog WHERE id=$2), FALSE))`,
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

    // A hand-added ABI or X-Ray brings its own stages; the blood ones already
    // arrive from the template. Must run before the first step is picked, or the
    // renumber below it would move the step we just started.
    await attachBackgroundStages(client, visit.id);

    // Auto-start the first step (in_progress if its station is free, else ready).
    // Deferred check-ins leave every step 'pending' — the journey only begins
    // when the timer is started (POST /flow/visits/:id/start-timer).
    const first = (
      await client.query(
        "SELECT * FROM flow_visit_steps WHERE visit_id=$1 ORDER BY step_order ASC LIMIT 1",
        [visit.id],
      )
    ).rows[0];
    if (!deferred) {
      const busy = await stationBusy(client, first.assigned_role, first.assigned_staff_id);
      const firstStatus = busy ? "ready" : "in_progress";
      await client.query(
        `UPDATE flow_visit_steps
           SET status=$2, started_at = CASE WHEN $2='in_progress' THEN NOW() ELSE NULL END
         WHERE id=$1`,
        [first.id, firstStatus],
      );
    }
    await client.query(
      "UPDATE flow_visits SET current_step_id=$2, current_step_order=$3 WHERE id=$1",
      [visit.id, first.id, first.step_order],
    );

    await logEvent(
      client,
      visit.id,
      deferred ? "checkin_deferred" : "checkin",
      first.step_order,
      { visit_type_id, totalPlanned, start_mode, token_number: tokenNumber },
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
    if (send_whatsapp && patient_phone && !patientBlocked) {
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
      token_number: tokenNumber,
      suggested_wait_min: totalPlanned,
      whatsapp_sent: whatsappSent,
      blocked: redactBlock(blockRow, req.doctor?.role),
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // A concurrent check-in that lost the race against the one-per-patient/day
    // unique index (idx_flow_visits_one_per_patient_day) surfaces as 23505.
    // Treat it as a duplicate — point back to the surviving row — not a 500.
    if (e.code === "23505") {
      const { patient_id: pid, patient_db_id: pdb = null, patient_name: pname } = req.body || {};
      const survivor = (
        await pool
          .query(
            `SELECT id FROM flow_visits
              WHERE status <> 'cancelled' AND visit_date::date = CURRENT_DATE
                AND ((${pdb ? "patient_db_id = $2 OR " : ""}patient_id = $1))
              ORDER BY checkin_time DESC LIMIT 1`,
            pdb ? [pid, pdb] : [pid],
          )
          .catch(() => ({ rows: [] }))
      ).rows[0];
      return res.status(409).json({
        error: `${pname} already has a visit today. Open the existing visit instead of adding a duplicate.`,
        code: "DUPLICATE_CHECKIN",
        visit_id: survivor?.id,
      });
    }
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
    if (
      !hasAnyCapability(req.doctor?.role, CAP.FLOW_COORDINATOR) &&
      !canWorkStationRole(req.doctor?.role, current.assigned_role)
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "This step belongs to another station" });
    }
    const currentHeldBy = claimBlocks(current, req);
    if (currentHeldBy) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `${currentHeldBy.by} is already working this patient — ask them to release first`,
        claimed_by: currentHeldBy.by,
      });
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
    if (mergedData.outside?.sent) {
      if (!String(mergedData.outside.lab_name || "").trim()) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Name the outside lab" });
      }
      mergedData.outside = {
        sent: true,
        mode: mergedData.outside.mode === "patient_goes" ? "patient_goes" : "courier",
        lab_name: String(mergedData.outside.lab_name).trim(),
        expected_on: mergedData.outside.expected_on
          ? String(mergedData.outside.expected_on).slice(0, 10)
          : null,
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

    // Drop the stages our lab will never work before picking what runs next,
    // so the next stage is chosen from what is actually left.
    if (mergedData.outside?.sent) await applyOutsideTest(client, visitId, mergedData.outside);

    // Next open step in order.
    await runNextLabStage(client, visitId);

    // The patient's next step — never a background one. Lab processing is not
    // somewhere the patient walks to, and auto-starting it here would both park
    // them on it and stall the journey behind work nobody is waiting at a desk
    // to do.
    const next = (
      await client.query(
        `SELECT * FROM flow_visit_steps
          WHERE visit_id=$1 AND step_order > $2 AND status IN ('pending','ready')
            AND NOT is_background
          ORDER BY step_order ASC LIMIT 1`,
        [visitId, current.step_order],
      )
    ).rows[0];

    if (next) {
      // A consultation cannot open while the patient's reports are outstanding;
      // the step waits at `ready` instead of pulling them in.
      const labWait = IS_CONSULT_ROLE(next.assigned_role)
        ? await labStagesPending(client, visitId, next.step_order)
        : next.step_catalog_id === "rx_explain"
          ? await rxExplainBlocked(client, visitId)
          : null;
      const busy =
        labWait || (await stationBusy(client, next.assigned_role, next.assigned_staff_id));
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

// Edit the reception-typed token number on an existing visit. Tokens get
// re-issued at the counter and mistyped; without this the only fix would be a
// cancel + fresh check-in, which loses the visit's timing history.
// requireCapability here because the prefix matcher can't reach past
// /api/flow/visits (ids are dynamic), so the route table would leave this on the
// base any-of row and let a station role renumber the queue.
router.patch(
  "/flow/visits/:id/token",
  requireCapability([CAP.FLOW_RECEPTION, CAP.FLOW_COORDINATOR]),
  async (req, res) => {
    try {
      const tokenNumber =
        String(req.body?.token_number ?? "")
          .trim()
          .slice(0, 32) || null;
      const r = await pool.query(
        "UPDATE flow_visits SET token_number=$2, updated_at=NOW() WHERE id=$1 RETURNING id, token_number",
        [req.params.id, tokenNumber],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Visit not found" });
      await logEvent(
        pool,
        req.params.id,
        "token_number_set",
        null,
        { token_number: tokenNumber },
        ACTOR(req),
      );
      res.json(r.rows[0]);
    } catch (e) {
      handleError(res, e, "Flow set token number");
    }
  },
);

// Cancel a check-in (e.g. started by mistake for a patient not present). Marks
// the visit cancelled. If the linked appointment was created BY the flow
// (booking_source='flow'), cancel that too so it doesn't linger in OPD/GHM; a
// real OPD/GHM appointment is left untouched (the booking still stands).
router.post(
  "/flow/visits/:id/cancel",
  requireCapability(CAP.FLOW_COORDINATOR),
  async (req, res) => {
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
      await client.query(
        "UPDATE flow_visits SET status='cancelled', updated_at=NOW() WHERE id=$1",
        [visitId],
      );
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
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Start / Resume timer — for a parked ('waiting') visit: start the clock fresh
// from now, set the ETA, and auto-start the first journey step (the deferred
// half of check-in). For a paused visit: RESUME — shift the clock, ETA, and the
// active step's started_at forward by the paused duration so elapsed continues
// seamlessly from where it froze.
// ─────────────────────────────────────────────────────────────────────────
router.post(
  "/flow/visits/:id/start-timer",
  requireCapability(CAP.FLOW_COORDINATOR),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const visitId = req.params.id;
      await client.query("BEGIN");
      const v = (await client.query("SELECT * FROM flow_visits WHERE id=$1 FOR UPDATE", [visitId]))
        .rows[0];
      if (!v) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Visit not found" });
      }
      if (v.status !== "waiting" && v.status !== "paused") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            v.status === "in_progress"
              ? "Timer is already running for this visit"
              : `Cannot start a ${v.status} visit`,
        });
      }

      // ── Resume a paused visit ── shift every live timestamp forward by the
      // time spent paused, so elapsed picks up exactly where it left off.
      if (v.status === "paused") {
        await client.query(
          `UPDATE flow_visit_steps
           SET started_at = started_at + (NOW() - $2::timestamptz)
         WHERE visit_id=$1 AND status='in_progress' AND started_at IS NOT NULL`,
          [visitId, v.paused_at],
        );
        await client.query(
          `UPDATE flow_visits
           SET status='in_progress',
               timer_started_at = timer_started_at + (NOW() - $2::timestamptz),
               estimated_completion = estimated_completion + (NOW() - $2::timestamptz),
               paused_at = NULL, updated_at = NOW()
         WHERE id=$1`,
          [visitId, v.paused_at],
        );
        await logEvent(client, visitId, "timer_resumed", null, {}, ACTOR(req));
        await client.query("COMMIT");
        return res.json({ status: "in_progress" });
      }

      // ── Fresh start of a parked (waiting) visit ──
      // Clock starts now; ETA = now + the planned journey length.
      await client.query(
        `UPDATE flow_visits
         SET status='in_progress', timer_started_at=NOW(),
             estimated_completion = NOW() + make_interval(mins => COALESCE(suggested_wait_min, 0)),
             updated_at=NOW()
       WHERE id=$1`,
        [visitId],
      );

      // Auto-start the first step (in_progress if its station is free, else ready) —
      // mirrors the non-deferred check-in path.
      const first = (
        await client.query(
          "SELECT * FROM flow_visit_steps WHERE visit_id=$1 ORDER BY step_order ASC LIMIT 1",
          [visitId],
        )
      ).rows[0];
      if (first) {
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
          [visitId, first.id, first.step_order],
        );
      }

      await logEvent(client, visitId, "timer_started", first?.step_order ?? null, {}, ACTOR(req));
      await client.query("COMMIT");
      res.json({ status: "in_progress" });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      handleError(res, e, "Flow start timer");
    } finally {
      client.release();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Stop timer — conditional:
//   • Journey not begun (no step started/completed) → reset to 'waiting' at 0
//     (clock cleared, steps re-parked as pending).
//   • Journey begun (a step is in_progress or completed) → PAUSE: freeze the
//     clock at now (preserving elapsed) so reception can ▶ Resume later.
// ─────────────────────────────────────────────────────────────────────────
router.post(
  "/flow/visits/:id/stop-timer",
  requireCapability(CAP.FLOW_COORDINATOR),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const visitId = req.params.id;
      await client.query("BEGIN");
      const v = (await client.query("SELECT * FROM flow_visits WHERE id=$1 FOR UPDATE", [visitId]))
        .rows[0];
      if (!v) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Visit not found" });
      }
      if (v.status !== "in_progress") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Timer is not running for this visit" });
      }

      // Has the journey actually begun? Any step started (in_progress) or completed.
      const progressed =
        (
          await client.query(
            `SELECT COUNT(*)::int AS n FROM flow_visit_steps
            WHERE visit_id=$1 AND status IN ('in_progress','completed')`,
            [visitId],
          )
        ).rows[0].n > 0;

      if (progressed) {
        // Pause: freeze the clock; leave steps/ETA intact so Resume continues.
        await client.query(
          "UPDATE flow_visits SET status='paused', paused_at=NOW(), updated_at=NOW() WHERE id=$1",
          [visitId],
        );
        await logEvent(client, visitId, "timer_paused", null, {}, ACTOR(req));
        await client.query("COMMIT");
        return res.json({ status: "paused" });
      }

      // Not begun yet: park it again — clock cleared, ETA cleared, steps pending.
      await client.query(
        `UPDATE flow_visits
         SET status='waiting', timer_started_at=NULL, estimated_completion=NULL,
             current_step_id=NULL, current_step_order=0, updated_at=NOW()
       WHERE id=$1`,
        [visitId],
      );
      await client.query(
        `UPDATE flow_visit_steps
         SET status='pending', started_at=NULL, actual_duration_min=NULL
       WHERE visit_id=$1 AND status IN ('in_progress','ready')`,
        [visitId],
      );

      await logEvent(client, visitId, "timer_stopped", null, {}, ACTOR(req));
      await client.query("COMMIT");
      res.json({ status: "waiting" });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      handleError(res, e, "Flow stop timer");
    } finally {
      client.release();
    }
  },
);

// ── Step claims ─────────────────────────────────────────────────────────────
// Who is currently working a step, held in data.claim (same pattern as
// data.skip). Deliberately NOT assigned_staff_id: that column feeds
// stationBusy(), and writing it would quietly turn the station's one-at-a-time
// rule into a per-person one. A claim is display + collision guard only.
//
// Claims go stale so a desk can never deadlock because someone walked away
// mid-patient without releasing.
const CLAIM_STALE_MIN = 15;
const claimOf = (step) => {
  const c = step.data?.claim;
  if (!c || !c.at) return null;
  const ageMin = (Date.now() - new Date(c.at).getTime()) / 60000;
  return ageMin > CLAIM_STALE_MIN ? null : c;
};
const claimBlocks = (step, req) => {
  const c = claimOf(step);
  return c && String(c.by_id) !== String(req.doctor?.doctor_id) ? c : null;
};
const withClaim = (step, req) => ({
  ...(step.data || {}),
  claim: {
    by: ACTOR(req),
    by_id: req.doctor?.doctor_id ?? null,
    at: new Date().toISOString(),
  },
});

// Take a step for yourself — the guard against two people at the same desk
// working the same patient. 409 names who already has it.
router.post("/flow/steps/:stepId/claim", async (req, res) => {
  const client = await pool.connect();
  try {
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
    if (
      !hasAnyCapability(req.doctor?.role, CAP.FLOW_COORDINATOR) &&
      !canWorkStationRole(req.doctor?.role, step.assigned_role)
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "This step belongs to another station" });
    }
    if (["completed", "skipped"].includes(step.status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `This step is already ${step.status}` });
    }
    const held = claimBlocks(step, req);
    if (held) {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ error: `${held.by} is already working this patient`, claimed_by: held.by });
    }
    await client.query("UPDATE flow_visit_steps SET data=$2 WHERE id=$1", [
      step.id,
      JSON.stringify(withClaim(step, req)),
    ]);
    await logEvent(client, step.visit_id, "claimed", step.step_order, {}, ACTOR(req));
    await client.query("COMMIT");
    res.json({ ok: true, claimed_by: ACTOR(req) });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow claim step");
  } finally {
    client.release();
  }
});

// Hand a step back. Yours to release, or a floor manager clearing a stuck one.
// Undo a call-in. Release only drops the claim and leaves the clock running —
// this is for "I opened the wrong patient": the step goes back to ready with its
// timer cleared, so the patient returns to the queue as if never called.
//
// If the OPD sync still shows the appointment in_visit it will re-open the step
// on the next pass, but with started_at NULL it restarts the clock rather than
// resuming the old one — which is the point.
router.post("/flow/steps/:stepId/cancel-start", async (req, res) => {
  const client = await pool.connect();
  try {
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
    if (step.status !== "in_progress") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Cannot cancel a ${step.status} step` });
    }
    const held = claimBlocks(step, req);
    if (held && !hasAnyCapability(req.doctor?.role, CAP.FLOW_COORDINATOR)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Held by ${held.by} — only they can cancel it` });
    }
    // Never rewind a patient who has already moved past this step.
    const moved = await client.query(
      `SELECT 1 FROM flow_visit_steps
        WHERE visit_id=$1 AND step_order > $2 AND status IN ('in_progress','completed')
          AND NOT is_background LIMIT 1`,
      [step.visit_id, step.step_order],
    );
    if (moved.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This patient has already moved on" });
    }
    // The minutes since the call-in are real: the patient sat there. They are
    // not consultation time, so they go back into the wait that preceded this
    // step rather than being thrown away.
    const spent = step.started_at
      ? Math.max(0, Math.round((Date.now() - new Date(step.started_at).getTime()) / 60000))
      : 0;
    const next = { ...(step.data || {}) };
    delete next.claim;
    next.cancelled = { by: ACTOR(req), at: new Date().toISOString(), returned_wait_min: spent };
    await client.query(
      `UPDATE flow_visit_steps
          SET status='ready', started_at=NULL, actual_duration_min=NULL, data=$2
        WHERE id=$1`,
      [step.id, JSON.stringify(next)],
    );

    // Re-open the waiting step this call-in closed, back-dated by what it had
    // already accrued plus the cancelled minutes — so it keeps counting until
    // the patient is genuinely seen, and /start records the full wait.
    const wait = (
      await client.query(
        `SELECT * FROM flow_visit_steps
          WHERE visit_id=$1 AND step_order < $2 AND assigned_role=$3
          ORDER BY step_order DESC LIMIT 1`,
        [step.visit_id, step.step_order, WAITING_ROLE],
      )
    ).rows[0];
    let returnedTo = null;
    if (wait) {
      const prior = wait.actual_duration_min || 0;
      await client.query(
        `UPDATE flow_visit_steps
            SET status='in_progress', completed_at=NULL, actual_duration_min=NULL,
                started_at = NOW() - make_interval(mins => $2)
          WHERE id=$1`,
        [wait.id, prior + spent],
      );
      returnedTo = wait.step_name;
      await client.query(
        `UPDATE flow_visits SET current_step_id=$2, current_step_order=$3, updated_at=NOW()
          WHERE id=$1`,
        [step.visit_id, wait.id, wait.step_order],
      );
    } else {
      await client.query(
        `UPDATE flow_visits SET current_step_id=NULL, updated_at=NOW()
          WHERE id=$1 AND current_step_id=$2`,
        [step.visit_id, step.id],
      );
    }
    await logEvent(
      client,
      step.visit_id,
      "call_in_cancelled",
      step.step_order,
      { returned_wait_min: spent, returned_to: returnedTo },
      ACTOR(req),
    );
    await client.query("COMMIT");
    res.json({ ok: true, status: "ready", returned_wait_min: spent, returned_to: returnedTo });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow cancel call-in");
  } finally {
    client.release();
  }
});

router.post("/flow/steps/:stepId/release", async (req, res) => {
  const client = await pool.connect();
  try {
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
    const held = claimBlocks(step, req);
    if (held && !hasAnyCapability(req.doctor?.role, CAP.FLOW_COORDINATOR)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Held by ${held.by} — only they can release it` });
    }
    const next = { ...(step.data || {}) };
    delete next.claim;
    await client.query("UPDATE flow_visit_steps SET data=$2 WHERE id=$1", [
      step.id,
      JSON.stringify(next),
    ]);
    await logEvent(client, step.visit_id, "released", step.step_order, {}, ACTOR(req));
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow release step");
  } finally {
    client.release();
  }
});

// Patients still in the building. reconcileFromAppointments() can flip a visit
// to 'completed' mid-request, so the list is filtered again after it runs.
const PRESENT_VISIT_STATUSES = ["waiting", "paused", "in_progress"];

// Which hat this doctor wears on a visit, or null if neither. SD wins when they
// happen to be both.
//
// Chief only counts when the journey actually carries a Chief step:
// assigned_chief is filled in on almost every visit (2,895) while only 749 ever
// get a chief_consult step — follow-up visit types never do. Matching on the
// column alone would bury the Chief in patients they will never see.
function roleOnVisit(v, me, myName, myShort) {
  const names = [myName, myShort].filter(Boolean).map((n) => n.toLowerCase());
  const isMe = (id, name) =>
    (id != null && String(id) === String(me)) ||
    (id == null && name && names.includes(name.toLowerCase()));
  if (isMe(v.assigned_sd, v.assigned_sd_name)) return "sd";
  const hasChiefStep = (v.steps || []).some((s) => s.assigned_role === "chief");
  if (hasChiefStep && isMe(v.assigned_chief, v.assigned_chief_name)) return "chief";
  return null;
}

// A consultant's own worklist: patients assigned to them today, plus any
// hand-over offers waiting on their decision. Matched on assigned_sd (the id)
// with a name fallback, because pre-flow rows and imported visits carry only
// the name.
router.get("/flow/my-patients", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const me = req.doctor?.doctor_id ?? null;
    const myName = req.doctor?.doctor_name || "";
    const myShort = req.doctor?.short_name || "";
    if (!me) return res.status(403).json({ error: "Doctor account required" });

    const visits = (
      await pool.query(
        `SELECT * FROM flow_visits
          WHERE visit_date=$1 AND status = ANY($2::text[])`,
        [date, PRESENT_VISIT_STATUSES],
      )
    ).rows;
    const stepMap = await stepsByVisit(visits.map((v) => v.id));
    // Same reconciliation the Flow Floor does on every read: HealthRay may have
    // marked the appointment seen/completed since the last cron pass, and a
    // consultant should not be shown a patient who has already left.
    await reconcileFromAppointments(visits, stepMap);
    await syncLabReportsFromResults(visits, stepMap);
    await syncPrescriptionReady(visits, stepMap);
    await attachLabPanel(visits);
    await attachPrescriptions(visits);
    const now = Date.now();
    const mine = [];
    const offers = [];
    for (const v of visits.filter((v) => PRESENT_VISIT_STATUSES.includes(v.status))) {
      v.steps = stepMap.get(v.id) || [];
      v._timing = classifyVisit(v, now);
      v.stage = deriveStage(v, v.steps);
      const sd = v.steps.find((s) => s.assigned_role === "sd");
      v.sd_step = sd
        ? { id: sd.id, status: sd.status, step_order: sd.step_order, step_name: sd.step_name }
        : null;
      const offer = offerOf(sd);
      if (offer && String(offer.to_id) === String(me)) {
        offers.push({ ...v, offer });
        continue;
      }
      const myRole = roleOnVisit(v, me, myName, myShort);
      if (myRole) mine.push({ ...v, my_role: myRole, offer: offer || null });
    }
    const byWait = (a, b) =>
      Number(a.my_role === "chief") - Number(b.my_role === "chief") ||
      Number(!!b.is_vip) - Number(!!a.is_vip) ||
      new Date(a.checkin_time) - new Date(b.checkin_time);
    mine.sort(byWait);
    offers.sort(byWait);
    res.json({ date, mine, offers });
  } catch (e) {
    handleError(res, e, "Flow my patients");
  }
});

// ── Consultant hand-over (offer → accept) ───────────────────────────────────
// Admin offers an overloaded consultant's patient to a freer one; the receiving
// consultant accepts before it lands in their list. The pending offer lives in
// the SD step's data.offer (same pattern as data.claim / data.skip), so nothing
// about the visit changes until acceptance.
//
// Offers expire so a patient is never left in limbo because the offered doctor
// never looked at their screen — there is no doctor-facing notification.
const OFFER_STALE_MIN = 5;
const offerOf = (step) => {
  const o = step?.data?.offer;
  if (!o || !o.at) return null;
  return (Date.now() - new Date(o.at).getTime()) / 60000 > OFFER_STALE_MIN ? null : o;
};

// The step a consultant hand-over is about. Chief stays with its own doctor.
async function sdStepFor(client, visitId) {
  return (
    await client.query(
      `SELECT * FROM flow_visit_steps
        WHERE visit_id=$1 AND assigned_role='sd'
        ORDER BY step_order ASC LIMIT 1
        FOR UPDATE`,
      [visitId],
    )
  ).rows[0];
}

// Close a visit that is finished in reality but not on paper — the patient has
// no medicines to collect, or is settling the bill later. Everything still open
// is skipped with a reason rather than silently dropped, so the journey reads as
// ended-early, not as work that vanished.
router.post("/flow/visits/:id/end", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const visitId = req.params.id;
    const visit = (
      await client.query("SELECT * FROM flow_visits WHERE id=$1 FOR UPDATE", [visitId])
    ).rows[0];
    if (!visit) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Visit not found" });
    }
    if (visit.status !== "in_progress" && visit.status !== "paused") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `This visit is already ${visit.status}` });
    }
    const reason = String(req.body?.reason || "")
      .trim()
      .slice(0, 200);
    if (!reason) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Give a reason for ending the visit early" });
    }
    // Anyone holding the patient at a desk can end them, as can a floor manager.
    const open = (
      await client.query(
        `SELECT * FROM flow_visit_steps
          WHERE visit_id=$1 AND status IN ('in_progress','ready','pending')
          ORDER BY step_order ASC`,
        [visitId],
      )
    ).rows;
    // Where the patient is NOW, not anywhere their journey happens to pass. The
    // pharmacist owns a step on every visit; that must not let them close one
    // still sitting at Vitals.
    const here = open.find((s) => s.status === "in_progress") || open[0];
    const atDesk = !!here && canWorkStationRole(req.doctor?.role, here.assigned_role);
    if (!hasAnyCapability(req.doctor?.role, CAP.FLOW_COORDINATOR) && !atDesk) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "This patient is not at your station" });
    }
    // "Prescription explained and end visit" has to mean explained: the step the
    // person just did is completed with their notes, and only what genuinely did
    // not happen is skipped.
    const completeCurrent = req.body?.complete_current === true && !!here;
    if (completeCurrent) {
      await client.query(
        `UPDATE flow_visit_steps
            SET status='completed', completed_at=NOW(),
                actual_duration_min = COALESCE(actual_duration_min,
                  CASE WHEN started_at IS NOT NULL
                       THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60))::int
                       END),
                data = COALESCE(data,'{}'::jsonb) || $2::jsonb
          WHERE id=$1`,
        [here.id, JSON.stringify(req.body?.step_data || {})],
      );
    }
    const skip = {
      skip: {
        reason: `Visit ended early — ${reason}`,
        by: ACTOR(req),
        at: new Date().toISOString(),
      },
    };
    await client.query(
      `UPDATE flow_visit_steps
          SET status='skipped', completed_at=NOW(),
              actual_duration_min = COALESCE(actual_duration_min,
                CASE WHEN started_at IS NOT NULL
                     THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60))::int
                     END),
              data = COALESCE(data,'{}'::jsonb) || $2::jsonb
        WHERE visit_id=$1 AND status IN ('in_progress','ready','pending')`,
      [visitId, JSON.stringify(skip)],
    );
    await client.query(
      `UPDATE flow_visits
          SET status='completed', actual_completion=NOW(), current_step_id=NULL, updated_at=NOW()
        WHERE id=$1`,
      [visitId],
    );
    await logEvent(
      client,
      visitId,
      "visit_completed",
      null,
      {
        ended_early: true,
        reason,
        completed_step: completeCurrent ? here.step_name : null,
        skipped_steps: completeCurrent ? open.length - 1 : open.length,
      },
      ACTOR(req),
    );
    await client.query("COMMIT");
    await syncAppointmentStatus(visit.appointment_id, "completed");
    res.json({
      status: "completed",
      completed_step: completeCurrent ? here.step_name : null,
      skipped_steps: completeCurrent ? open.length - 1 : open.length,
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow end visit");
  } finally {
    client.release();
  }
});

router.post("/flow/visits/:id/offer", requireCapability(CAP.FLOW_COORDINATOR), async (req, res) => {
  const client = await pool.connect();
  try {
    const toId = parseInt(req.body?.to_doctor_id, 10);
    const toName = (req.body?.to_doctor_name || "").toString().trim();
    if (!Number.isInteger(toId) || !toName)
      return res.status(400).json({ error: "to_doctor_id and to_doctor_name are required" });

    await client.query("BEGIN");
    const visit = (
      await client.query("SELECT * FROM flow_visits WHERE id=$1 FOR UPDATE", [req.params.id])
    ).rows[0];
    if (!visit) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Visit not found" });
    }
    if (visit.assigned_sd === toId) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `${toName} is already this patient's consultant` });
    }
    const step = await sdStepFor(client, visit.id);
    if (!step) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This visit has no SD consultation step" });
    }
    if (["completed", "skipped"].includes(step.status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `The consultation is already ${step.status}` });
    }
    // Mid-consultation hand-over would pull the patient away from a doctor who
    // is with them right now.
    if (step.status === "in_progress") {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ error: "This consultation has already started — it cannot be handed over" });
    }
    const pending = offerOf(step);
    if (pending) {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ error: `Already offered to ${pending.to_name}`, offered_to: pending.to_name });
    }

    const offer = {
      to_id: toId,
      to_name: toName,
      from_id: visit.assigned_sd ?? null,
      from_name: visit.assigned_sd_name || null,
      reason: (req.body?.reason || "").toString().trim().slice(0, 200) || null,
      by: ACTOR(req),
      at: new Date().toISOString(),
    };
    await client.query("UPDATE flow_visit_steps SET data=$2 WHERE id=$1", [
      step.id,
      JSON.stringify({ ...(step.data || {}), offer }),
    ]);
    await logEvent(client, visit.id, "offered", step.step_order, offer, ACTOR(req));
    await client.query("COMMIT");
    res.json({ ok: true, offer });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow offer visit");
  } finally {
    client.release();
  }
});

router.post("/flow/visits/:id/offer/accept", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const visit = (
      await client.query("SELECT * FROM flow_visits WHERE id=$1 FOR UPDATE", [req.params.id])
    ).rows[0];
    if (!visit) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Visit not found" });
    }
    const step = await sdStepFor(client, visit.id);
    const offer = offerOf(step);
    if (!offer) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "That offer has expired or was withdrawn" });
    }
    const me = req.doctor?.doctor_id;
    if (String(offer.to_id) !== String(me)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: `This patient was offered to ${offer.to_name}` });
    }

    // All three records move together. appointments is the one that decides
    // whose patient list this shows up in (see services/patientScope.js) — the
    // other two only drive the flow board.
    const name = ACTOR(req) || offer.to_name;
    const nextData = { ...(step.data || {}) };
    delete nextData.offer;
    await client.query(
      `UPDATE flow_visit_steps
          SET assigned_staff_id=$2, assigned_staff_name=$3, data=$4
        WHERE id=$1`,
      [step.id, String(me), name, JSON.stringify(nextData)],
    );
    await client.query(
      "UPDATE flow_visits SET assigned_sd=$2, assigned_sd_name=$3, updated_at=NOW() WHERE id=$1",
      [visit.id, me, name],
    );
    if (visit.appointment_id) {
      await client.query("UPDATE appointments SET doctor_id=$2, doctor_name=$3 WHERE id=$1", [
        visit.appointment_id,
        me,
        name,
      ]);
      await client
        .query(
          `INSERT INTO appointment_reassignments
             (appointment_id, patient_id, file_no, appointment_date,
              from_doctor_id, from_doctor_name, to_doctor_id, to_doctor_name,
              trigger, reason, reassigned_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'flow_handover',$9,$10)`,
          [
            visit.appointment_id,
            visit.patient_db_id,
            visit.patient_id,
            visit.visit_date,
            offer.from_id,
            offer.from_name,
            me,
            name,
            offer.reason,
            offer.by,
          ],
        )
        .catch((err) => console.error("Handover audit row failed:", err.message));
    }
    await logEvent(
      client,
      visit.id,
      "reassigned",
      step.step_order,
      { from: offer.from_name, to: name, via: "handover_accept", reason: offer.reason },
      name,
    );
    await client.query("COMMIT");
    res.json({ ok: true, assigned_sd_name: name, no_appointment: !visit.appointment_id });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow accept offer");
  } finally {
    client.release();
  }
});

// Decline — the offered consultant, or an admin withdrawing it.
router.post("/flow/visits/:id/offer/decline", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const step = await sdStepFor(client, req.params.id);
    const offer = offerOf(step);
    if (!offer) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "That offer has expired or was withdrawn" });
    }
    const me = req.doctor?.doctor_id;
    if (
      String(offer.to_id) !== String(me) &&
      !hasAnyCapability(req.doctor?.role, CAP.FLOW_COORDINATOR)
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: `This patient was offered to ${offer.to_name}` });
    }
    const nextData = { ...(step.data || {}) };
    delete nextData.offer;
    await client.query("UPDATE flow_visit_steps SET data=$2 WHERE id=$1", [
      step.id,
      JSON.stringify(nextData),
    ]);
    await logEvent(
      client,
      step.visit_id,
      "offer_declined",
      step.step_order,
      { reason: (req.body?.reason || "").toString().trim().slice(0, 200) || null },
      ACTOR(req),
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow decline offer");
  } finally {
    client.release();
  }
});

// Every test gates the consultation: the patient waits for their reports. The
// escape hatch is deliberately the existing skip — a floor manager skips the
// stuck stage, which records who/why in data.skip. 333 of 5,327 lab cases
// (6.3%) never sync at all, so without a human override those patients would
// be held indefinitely.
// Bounded by position: a stage that comes AFTER the step being started was never
// meant to gate it. Without the bound, adding any background stage after a
// consultation deadlocks it — the consult waits on the stage, and the stage
// waits on what the consult produces.
// The nurse needs BOTH: the MO's stage closed, and a prescription document on
// file. Shared by /start and the auto-advance — putting the rule in only one of
// them let the other pull the patient straight through.
async function rxExplainBlocked(client, visitId) {
  const stage = (
    await client.query(
      `SELECT step_name, status FROM flow_visit_steps
        WHERE visit_id=$1 AND step_catalog_id='rx_ready' LIMIT 1`,
      [visitId],
    )
  ).rows[0];
  if (stage && !["completed", "skipped"].includes(stage.status)) {
    return { step_name: stage.step_name };
  }
  const doc = await client.query(
    `SELECT 1 FROM documents d
       JOIN flow_visits v ON v.id=$1
      WHERE d.patient_id = v.patient_db_id AND d.doc_type='prescription'
        AND d.created_at::date = v.visit_date
      LIMIT 1`,
    [visitId],
  );
  return doc.rowCount ? null : { step_name: "the prescription" };
}

async function labStagesPending(client, visitId, beforeOrder = null) {
  return (
    await client.query(
      `SELECT step_name FROM flow_visit_steps
        WHERE visit_id=$1 AND is_background AND status NOT IN ('completed','skipped')
          AND ($2::int IS NULL OR step_order < $2)
        ORDER BY step_order ASC LIMIT 1`,
      [visitId, beforeOrder],
    )
  ).rows[0];
}
const IS_CONSULT_ROLE = (role) => role === "sd" || role === "chief";

// Mark a background lab step done by hand. 333 of 5,327 lab cases (6.3%) never
// sync, and a report can also arrive on paper — so the lab needs a way to say
// "results are in" without waiting for HealthRay. Completes the stage only; it
// does not advance the patient, who may still be at another station.
router.post("/flow/steps/:stepId/results-in", async (req, res) => {
  const client = await pool.connect();
  try {
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
    if (!step.is_background) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "That is not a lab stage" });
    }
    // The prescription stage belongs to the MO, but the consultant who just saw
    // the patient is often the one who writes it — so they may close their own
    // patient's stage. Anyone else's patient, or any other stage, is refused.
    const ownConsult =
      ["rx_ready", "mo_review"].includes(step.step_catalog_id) &&
      hasOwnConsultQueue(req.doctor?.role) &&
      (
        await client.query(
          `SELECT 1 FROM flow_visits
            WHERE id=$1 AND (assigned_sd=$2 OR assigned_chief=$2) LIMIT 1`,
          [step.visit_id, req.doctor?.doctor_id],
        )
      ).rowCount > 0;
    if (
      !ownConsult &&
      !hasAnyCapability(req.doctor?.role, CAP.FLOW_COORDINATOR) &&
      !canWorkStationRole(req.doctor?.role, step.assigned_role)
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "This stage belongs to another station" });
    }
    if (["completed", "skipped"].includes(step.status)) {
      await client.query("ROLLBACK");
      return res.json({ status: step.status });
    }
    await client.query(
      `UPDATE flow_visit_steps
          SET status='completed', completed_at=NOW(),
              actual_duration_min = COALESCE(actual_duration_min,
                CASE WHEN started_at IS NOT NULL
                     THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60))::int
                     END),
              data = COALESCE(data,'{}'::jsonb) || $2::jsonb
        WHERE id=$1`,
      [
        step.id,
        JSON.stringify({
          results_in: { by: ACTOR(req), at: new Date().toISOString(), manual: true },
        }),
      ],
    );
    await runNextLabStage(client, step.visit_id);
    await logEvent(
      client,
      step.visit_id,
      "results_in",
      step.step_order,
      { manual: true },
      ACTOR(req),
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    handleError(res, e, "Flow results in");
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
  // Declared up here because the nurse's paper-prescription override is decided
  // in the gates near the top and written to data much further down.
  let paperRx = null;
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
    if (
      !hasAnyCapability(req.doctor?.role, CAP.FLOW_COORDINATOR) &&
      !canWorkStationRole(req.doctor?.role, step.assigned_role)
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "This step belongs to another station" });
    }
    if (step.status === "in_progress") {
      await client.query("ROLLBACK");
      return res.json({ status: "already_in_progress" });
    }
    if (!["ready", "pending"].includes(step.status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Cannot start a ${step.status} step` });
    }
    const heldBy = claimBlocks(step, req);
    if (heldBy) {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ error: `${heldBy.by} is already working this patient`, claimed_by: heldBy.by });
    }
    // Background lab work is neither at a desk nor with the patient, so neither
    // the station nor the one-place rule applies to starting it.
    if (
      !step.is_background &&
      (await stationBusy(
        client,
        step.assigned_role,
        step.assigned_staff_id,
        req.doctor?.doctor_id,
        step.visit_id,
      ))
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Station busy — complete the current patient first" });
    }
    // A patient can only be in one place at a time. stationBusy guards the desk;
    // this guards the patient, so a second station cannot pull someone who is
    // already mid-step somewhere else.
    if (IS_CONSULT_ROLE(step.assigned_role)) {
      const waiting = await labStagesPending(client, step.visit_id, step.step_order);
      if (waiting) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Reports not ready — waiting on ${waiting.step_name}`,
          waiting_on: waiting.step_name,
        });
      }
    }
    // A patient cannot be pulled to a later desk before finishing the earlier
    // ones. The one-place guard below only catches a step that is in_progress,
    // so a patient sitting between steps could be jumped straight to Pharmacy.
    // Floor managers keep their override — they skip the intervening steps
    // deliberately, which leaves a reason on each.
    if (!hasAnyCapability(req.doctor?.role, CAP.FLOW_COORDINATOR)) {
      const earlier = (
        await client.query(
          // A waiting step is not somewhere the patient still has to go — it is
          // them queuing for this very step, and /start auto-completes it a few
          // lines below. Counting it here blocked every consultation behind its
          // own waiting room.
          `SELECT step_name FROM flow_visit_steps
            WHERE visit_id=$1 AND NOT is_background AND step_order < $2
              AND assigned_role <> $3
              AND status NOT IN ('completed','skipped')
            ORDER BY step_order ASC LIMIT 1`,
          [step.visit_id, step.step_order, WAITING_ROLE],
        )
      ).rows[0];
      if (earlier) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Not their turn yet — still at ${earlier.step_name}`,
          waiting_on: earlier.step_name,
        });
      }
    }

    // Nothing to explain until the prescription exists. Overridable: the stage
    // itself takes "results-in" from an MO or a floor manager for a paper Rx.
    if (step.step_catalog_id === "rx_explain") {
      let blocked = (await rxExplainBlocked(client, step.visit_id))?.step_name || null;
      // A paper prescription is still a prescription. When the only thing
      // missing is the document — the MO's stage is closed — the nurse may
      // proceed by saying she has the hard copy, and that is recorded on the
      // step. A stage the MO has not finished is a different matter and stays
      // blocked; it has its own ✕ Skip.
      const paper = String(req.body?.paper_rx || "").trim();
      if (blocked === "the prescription" && paper) {
        paperRx = { note: paper.slice(0, 200), by: ACTOR(req), at: new Date().toISOString() };
        blocked = null;
      }
      if (blocked) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "No prescription yet — the doctor has not submitted it",
          waiting_on: blocked,
        });
      }
    }
    const busyAt = (
      await client.query(
        `SELECT step_name, assigned_role FROM flow_visit_steps
          WHERE visit_id=$1 AND id <> $2 AND status='in_progress' AND NOT is_background
            AND assigned_role <> $3 AND assigned_role <> $4
          LIMIT 1`,
        [step.visit_id, stepId, WAITING_ROLE, step.assigned_role],
      )
    ).rows[0];
    if (busyAt && !step.is_background) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `This patient is at ${busyAt.step_name} right now — finish there first`,
        busy_at: busyAt.step_name,
      });
    }

    let checks = null;
    if (!step.is_background && step.assigned_role === LAB_ROLE) {
      try {
        checks = labCallInChecks(req);
      } catch (err) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: err.message });
      }
    }

    // Calling a patient in also takes them, so the row shows who has them.
    await client.query(
      "UPDATE flow_visit_steps SET status='in_progress', started_at=NOW(), data=$2 WHERE id=$1",
      [
        stepId,
        JSON.stringify({
          ...withClaim(step, req),
          ...(checks || {}),
          ...(paperRx ? { paper_rx: paperRx } : {}),
        }),
      ],
    );
    // An outside test never produces lab_results, so the stage that waits for
    // them would hang forever at a desk that cannot see the paper report. Hand
    // it to the reports desk, who physically receive it.
    if (checks?.outside?.sent) {
      await client.query(
        `UPDATE flow_visit_steps SET assigned_role=$2, station=$3
          WHERE visit_id=$1 AND step_catalog_id='lab_reports'
            AND status NOT IN ('completed','skipped')`,
        [step.visit_id, REPORT_ROLE, "Assistant Station"],
      );
    }
    if (checks) {
      await logEvent(
        client,
        step.visit_id,
        "lab_call_in_checks",
        step.step_order,
        { step_name: step.step_name, payment: checks.payment, outside: checks.outside },
        ACTOR(req),
      );
    }

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
    await logEvent(
      client,
      step.visit_id,
      "step_started",
      step.step_order,
      paperRx ? { paper_rx: paperRx.note } : null,
      ACTOR(req),
    );
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
router.patch(
  "/flow/steps/:stepId/duration",
  requireCapability(CAP.FLOW_COORDINATOR),
  async (req, res) => {
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
  },
);

router.patch(
  "/flow/steps/:stepId/reassign",
  requireCapability(CAP.FLOW_COORDINATOR),
  async (req, res) => {
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
  },
);

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
    // Floor managers add anything; station staff only a step for their own desk.
    if (
      !hasAnyCapability(req.doctor?.role, CAP.FLOW_COORDINATOR) &&
      !ownsStationRole(req.doctor?.role, assigned_role)
    ) {
      return res.status(403).json({ error: "You can only add a step for your own station" });
    }

    await client.query("BEGIN");
    // A step the patient already has open is not a new piece of work. Without
    // this, repeated clicks stack identical rows onto one journey.
    if (step_catalog_id) {
      const dup = await client.query(
        `SELECT step_name FROM flow_visit_steps
          WHERE visit_id=$1 AND step_catalog_id=$2
            AND status NOT IN ('completed','skipped') LIMIT 1`,
        [req.params.id, step_catalog_id],
      );
      if (dup.rowCount) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ error: `${dup.rows[0].step_name} is already in this patient's journey` });
      }
    }
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
         station, assigned_role, assigned_staff_id, assigned_staff_name, status, is_background)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',
               COALESCE((SELECT is_background FROM flow_step_catalog WHERE id=$2), FALSE))
       RETURNING *`,
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
    await attachBackgroundStages(client, visitId);
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

// Reorder a visit's steps. Body: { order: [stepId, …] } — the full set of the
// visit's step ids in their new order. Rewrites step_order 1..N. Safe because
// the UNIQUE(visit_id, step_order) constraint is DEFERRABLE INITIALLY DEFERRED,
// so transient collisions inside the txn are fine (checked only at COMMIT).
router.post(
  "/flow/visits/:id/reorder",
  requireCapability(CAP.FLOW_COORDINATOR),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const visitId = req.params.id;
      const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : [];
      if (!order.length) return res.status(400).json({ error: "order[] required" });

      const cur = (
        await client.query("SELECT id FROM flow_visit_steps WHERE visit_id=$1", [visitId])
      ).rows.map((r) => String(r.id));
      const curSet = new Set(cur);
      // Must list EXACTLY the visit's current steps (no adds/drops here).
      if (order.length !== cur.length || !order.every((id) => curSet.has(id))) {
        return res.status(400).json({ error: "order must list exactly the visit's current steps" });
      }

      await client.query("BEGIN");
      for (let i = 0; i < order.length; i++) {
        await client.query(
          "UPDATE flow_visit_steps SET step_order=$2 WHERE id=$1 AND visit_id=$3",
          [order[i], i + 1, visitId],
        );
      }
      // Keep the visit's cached current_step_order in sync with the moved step.
      await client.query(
        `UPDATE flow_visits
          SET current_step_order = (SELECT step_order FROM flow_visit_steps WHERE id=current_step_id),
              updated_at=NOW()
        WHERE id=$1`,
        [visitId],
      );
      await logEvent(client, visitId, "reordered", null, { order }, ACTOR(req));
      await client.query("COMMIT");
      res.json({ ok: true });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      handleError(res, e, "Flow reorder steps");
    } finally {
      client.release();
    }
  },
);

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
    if (
      !hasAnyCapability(req.doctor?.role, CAP.FLOW_COORDINATOR) &&
      !ownsStationRole(req.doctor?.role, step.assigned_role)
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "You can only remove a step at your own station" });
    }
    // Someone is mid-patient on this step — don't pull it out from under them.
    // A floor manager still can, since they can also force a release.
    const removeHeldBy = claimBlocks(step, req);
    if (removeHeldBy && !hasAnyCapability(req.doctor?.role, CAP.FLOW_COORDINATOR)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `${removeHeldBy.by} is working this patient — ask them to release first`,
        claimed_by: removeHeldBy.by,
      });
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

// "Reports available" is the one lab stage nobody can reliably click: results
// land from HealthRay minutes or hours after the sample leaves. Derive it from
// lab_results arriving for that patient on the visit date — lab_cases cannot be
// used, its appointment_id is set on 1 of 5,327 rows.
//
// Results arriving prove the earlier stages happened, so any still-open delivery
// or processing stage closes with them. Durations are stamped only where the
// stage was actually started, keeping Flow Reports averages honest.
// The prescription makes itself: whoever ends the visit, and the HealthRay sync
// when it sees the appointment marked seen, both render the PDF and write a
// documents row. This stage just notices. Only rx_ready — never the lab or the
// assistant's stages, which are other people's work.
async function syncPrescriptionReady(visits, stepMap) {
  const pending = [];
  for (const v of visits) {
    if (!v.patient_db_id) continue;
    const open = (stepMap.get(v.id) || []).filter(
      (s) => s.step_catalog_id === "rx_ready" && !["completed", "skipped"].includes(s.status),
    );
    if (open.length) pending.push({ visit: v, open });
  }
  if (!pending.length) return;
  try {
    const ids = [...new Set(pending.map((p) => p.visit.patient_db_id))];
    const have = new Set(
      (
        await pool.query(
          `SELECT DISTINCT patient_id FROM documents
            WHERE patient_id = ANY($1::int[]) AND created_at::date = $2
              AND doc_type = 'prescription'`,
          [ids, pending[0].visit.visit_date],
        )
      ).rows.map((r) => r.patient_id),
    );
    for (const p of pending) {
      if (!have.has(p.visit.patient_db_id)) continue;
      await pool.query(
        `UPDATE flow_visit_steps
            SET status='completed', completed_at=COALESCE(completed_at, NOW()),
                actual_duration_min = COALESCE(actual_duration_min,
                  CASE WHEN started_at IS NOT NULL
                       THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60))::int
                       END),
                data = COALESCE(data,'{}'::jsonb) || '{"auto_completed":"prescription"}'::jsonb
          WHERE id = ANY($1::uuid[])`,
        [p.open.map((s) => s.id)],
      );
      p.open.forEach((s) => {
        s.status = "completed";
      });
    }
  } catch (e) {
    console.error("Prescription stage sync failed:", e.message);
  }
}

async function syncLabReportsFromResults(visits, stepMap) {
  const pending = [];
  for (const v of visits) {
    if (!v.patient_db_id) continue;
    // Only the lab's own stages. Printing a report and walking it to the doctor
    // are physical acts by a person — HealthRay cannot observe them, and closing
    // them on a results sync claims a handover that never happened.
    const open = (stepMap.get(v.id) || []).filter(
      (s) =>
        s.is_background &&
        s.assigned_role !== REPORT_ROLE &&
        !["completed", "skipped"].includes(s.status),
    );
    if (open.length) pending.push({ visit: v, open });
  }
  if (!pending.length) return;
  try {
    const ids = [...new Set(pending.map((p) => p.visit.patient_db_id))];
    const have = new Set(
      (
        await pool.query(
          `SELECT DISTINCT patient_id FROM lab_results
            WHERE patient_id = ANY($1::int[]) AND test_date = $2`,
          [ids, pending[0].visit.visit_date],
        )
      ).rows.map((r) => r.patient_id),
    );
    for (const p of pending) {
      if (!have.has(p.visit.patient_db_id)) continue;
      await pool.query(
        `UPDATE flow_visit_steps
            SET status='completed', completed_at=COALESCE(completed_at, NOW()),
                actual_duration_min = COALESCE(actual_duration_min,
                  CASE WHEN started_at IS NOT NULL
                       THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60))::int
                       END),
                data = COALESCE(data,'{}'::jsonb) || '{"auto_completed":"lab_results"}'::jsonb
          WHERE id = ANY($1::uuid[])`,
        [p.open.map((s) => s.id)],
      );
      p.open.forEach((s) => {
        s.status = "completed";
      });
    }
  } catch (e) {
    console.error("Lab report stage sync failed:", e.message);
  }
}

// Everything HealthRay knows about a patient's tests today, per visit.
//
// Two sources, because HealthRay keeps them apart:
//   • pathology  → lab_cases.test_names, with results_synced / lab_results
//   • everything else (ABI, VPT, X-Ray, eye…) → documents, keyed on doc_type
//
// lab_cases.appointment_id is set on 1 of 5,327 rows, so both are matched on
// patient + visit date rather than on the appointment.
const IMAGING_DOC_TYPES = ["abi", "vpt", "xray", "x_ray", "eye", "kidney", "ecg", "tmt"];

// Whether today's prescription actually exists yet. The nurse who explains it
// had no way to know: her form is a notes box, and a prescription arrives as a
// document, not a step. 115 land on a normal day.
async function attachPrescriptions(visits) {
  const ids = [...new Set(visits.map((v) => v.patient_db_id).filter(Boolean))];
  if (!ids.length) return;
  try {
    const rows = (
      await pool.query(
        `SELECT patient_id,
                MAX(created_at) AS at,
                (ARRAY_AGG(id ORDER BY created_at DESC)
                   FILTER (WHERE file_url IS NOT NULL OR storage_path IS NOT NULL))[1] AS doc_id
           FROM documents
          WHERE patient_id = ANY($1::int[]) AND created_at::date = $2
            AND doc_type = 'prescription'
          GROUP BY patient_id`,
        [ids, visits[0].visit_date],
      )
    ).rows;
    const byPatient = new Map(rows.map((r) => [r.patient_id, r]));
    for (const v of visits) {
      const r = byPatient.get(v.patient_db_id);
      v.rx = r ? { ready: true, doc_id: r.doc_id || null, at: r.at } : { ready: false };
    }
  } catch (e) {
    console.error("Prescription attach failed:", e.message);
  }
}

async function attachLabPanel(visits) {
  const ids = [...new Set(visits.map((v) => v.patient_db_id).filter(Boolean))];
  if (!ids.length) return;
  try {
    const date = visits[0].visit_date;
    const [cases, docs, results] = await Promise.all([
      pool.query(
        `SELECT patient_id, case_no, test_names, results_synced, case_date
           FROM lab_cases WHERE patient_id = ANY($1::int[]) AND case_date::date = $2
           ORDER BY case_date ASC`,
        [ids, date],
      ),
      pool.query(
        // ids so the panel can link straight at /api/documents/:id/stream
        // Only offer a viewer for a document that actually has a file — 1 in
        // ~2,000 imaging rows has none, and HealthRay leaves 1,635 lab PDFs
        // permanently unavailable.
        `SELECT patient_id, doc_type, COUNT(*)::int n,
                (ARRAY_AGG(id ORDER BY created_at DESC)
                   FILTER (WHERE file_url IS NOT NULL OR storage_path IS NOT NULL))[1] AS doc_id
           FROM documents
          WHERE patient_id = ANY($1::int[]) AND created_at::date = $2
            AND doc_type = ANY($3::text[])
          GROUP BY patient_id, doc_type`,
        [ids, date, IMAGING_DOC_TYPES],
      ),
      // The values themselves. Pathology PDFs are not stored — 0 of 367 recent
      // lab_cases carry a pdf_storage_path — but the results are, and a number
      // with its flag is more use to a clinician than a scan of the same thing.
      pool.query(
        `SELECT patient_id, test_name, result, result_text, unit, flag, is_critical
           FROM lab_results
          WHERE patient_id = ANY($1::int[]) AND test_date = $2
          ORDER BY is_critical DESC NULLS LAST, test_name ASC`,
        [ids, date],
      ),
    ]);
    const byPatient = new Map();
    const bucket = (id) => {
      if (!byPatient.has(id)) byPatient.set(id, { tests: [], awaiting: 0, ready: 0 });
      return byPatient.get(id);
    };
    for (const c of cases.rows) {
      const b = bucket(c.patient_id);
      // test_names is a text[] on some rows and a comma-joined string on others.
      const names = Array.isArray(c.test_names)
        ? c.test_names
        : String(c.test_names || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
      b.tests.push({
        kind: "pathology",
        case_no: c.case_no,
        names,
        ready: !!c.results_synced,
      });
      c.results_synced ? (b.ready += 1) : (b.awaiting += 1);
    }
    for (const d of docs.rows) {
      const b = bucket(d.patient_id);
      b.tests.push({
        kind: "imaging",
        doc_type: d.doc_type,
        count: d.n,
        doc_id: d.doc_id,
        ready: true,
      });
      b.ready += 1;
    }
    const valuesFor = new Map();
    for (const r of results.rows) {
      if (!valuesFor.has(r.patient_id)) valuesFor.set(r.patient_id, []);
      valuesFor.get(r.patient_id).push({
        test_name: r.test_name,
        result: r.result ?? r.result_text,
        unit: r.unit,
        flag: r.flag,
        is_critical: r.is_critical,
      });
    }
    for (const v of visits) {
      const b = byPatient.get(v.patient_db_id);
      const values = valuesFor.get(v.patient_db_id) || [];
      v.lab = b
        ? { ...b, values, result_rows: values.length }
        : { tests: [], awaiting: 0, ready: 0, values: [], result_rows: 0 };
    }
  } catch (e) {
    console.error("Lab panel build failed:", e.message);
  }
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
    // Server-side search across the day's floor: name, file number, phone or
    // token. Matched in SQL, not on a preloaded array, so a station desk can
    // find any patient without the whole day's feed being shipped to it first.
    const q = (req.query.q || "").toString().trim();
    if (q) {
      params.push(`%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`);
      const i = params.length;
      where +=
        ` AND (patient_name ILIKE $${i} OR patient_id ILIKE $${i}` +
        ` OR patient_phone ILIKE $${i} OR token_number ILIKE $${i})`;
    }
    const visits = (await pool.query(`SELECT * FROM flow_visits ${where}`, params)).rows;
    const stepMap = await stepsByVisit(visits.map((v) => v.id));
    // Reflect clinical-side completion (OPD/GHM "seen"/"completed") before timing.
    await reconcileFromAppointments(visits, stepMap);
    await syncLabReportsFromResults(visits, stepMap);
    await syncPrescriptionReady(visits, stepMap);
    await attachLabPanel(visits);
    await attachPrescriptions(visits);
    const now = Date.now();
    for (const v of visits) {
      v.steps = stepMap.get(v.id) || [];
      // Paused visits freeze at paused_at so step timers stop growing too.
      const vnow = v.status === "paused" && v.paused_at ? new Date(v.paused_at).getTime() : now;
      v._timing = classifyVisit(v, now);
      v.bottleneck = bottleneckFor(v.steps, vnow);
      v.stage = deriveStage(v, v.steps);
    }
    // One row per patient (see dedupeVisitsByPatient) so the board's counts,
    // occupancy, and doctor-load reflect distinct patients, not duplicate rows.
    const deduped = dedupeVisitsByPatient(visits);
    deduped.sort(compareVisitsForDashboard);
    res.json(deduped);
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
    const vnow = v.status === "paused" && v.paused_at ? new Date(v.paused_at).getTime() : now;
    v._timing = classifyVisit(v, now);
    v.bottleneck = bottleneckFor(v.steps, vnow);
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
    const vnow = v.status === "paused" && v.paused_at ? new Date(v.paused_at).getTime() : now;
    v._timing = classifyVisit(v, now);
    v.bottleneck = bottleneckFor(v.steps, vnow);
    v.stage = deriveStage(v, v.steps);
    res.json(v);
  } catch (e) {
    handleError(res, e, "Flow active visit");
  }
});

// Today's OPD/GHM appointment for a patient — read-only, used to pre-fill the
// flow check-in (time, visit type, doctor) and to link flow_visits.appointment_id.
// Never writes to appointments (their INSERT trigger drives OPD backfill).
// Today's booked patients (the GHM list) for the reception check-in screen,
// annotated with whatever flow visit already exists for each one.
//
// Why not just call /api/ghm-appointments from the page: that endpoint is gated
// on [RECEPTION_OPS, OBT_OPS] while /flow/checkin is FLOW_RECEPTION — the two
// only overlap by accident of today's role matrix — and it returns ~45 columns
// plus correlated follow-up-date subqueries. This one is the ten columns the
// picker draws, cheap enough to poll all day.
router.get("/flow/appointments", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const params = [date];

    // Same day-membership rule as the GHM list: booked on the date, OR asked to
    // come on the date (preferred_date) while booked for another one.
    let where = "WHERE (a.appointment_date = $1 OR a.preferred_date = $1)" + NOT_BLOCKED("a");
    if (req.query.doctor) {
      params.push(`%${req.query.doctor}%`);
      where += ` AND (a.doctor_name ILIKE $${params.length} OR a.preferred_doctor ILIKE $${params.length})`;
    }
    // Tokenised AND search — the same robust matching ghm-appointments uses,
    // because real names carry double spaces and arrive in either word order.
    const q = (req.query.q || "").trim();
    if (q.length >= 2) {
      for (const t of q.split(/\s+/).filter(Boolean).slice(0, 6)) {
        params.push(`%${t}%`);
        where += ` AND (a.patient_name ILIKE $${params.length} OR a.file_no ILIKE $${params.length} OR a.phone ILIKE $${params.length})`;
      }
    }

    // The LATERAL join excludes only 'cancelled': a 'completed' visit still has
    // to badge the row, because idx_flow_visits_one_per_patient_day blocks a
    // re-check-in and a 409 toast is poor feedback for an already-seen patient.
    // Matching on appointment_id OR file number catches visits checked in
    // manually before the booking was linked.
    const r = await pool.query(
      `SELECT a.id, a.patient_name, a.file_no, a.phone, a.time_slot,
              a.reporting_time_slot, a.visit_type, a.appointment_type,
              a.doctor_name, a.status, a.is_walkin, a.condition, a.chief_complaint,
              COALESCE(a.age, p.age) AS age,
              COALESCE(a.sex, p.sex) AS sex,
              p.id AS patient_db_id,
              (a.preferred_date = $1 AND a.appointment_date <> $1) AS via_preferred,
              fv.id AS flow_visit_id,
              fv.status AS flow_status,
              fv.token_number AS flow_token_number
         FROM appointments a
         LEFT JOIN patients p ON p.file_no = a.file_no
         LEFT JOIN LATERAL (
           SELECT id, status, token_number
             FROM flow_visits
            WHERE visit_date = $1
              AND status <> 'cancelled'
              AND (appointment_id = a.id
                   OR (a.file_no IS NOT NULL AND patient_id = a.file_no)
                   OR (p.id IS NOT NULL AND patient_db_id = p.id))
            ORDER BY checkin_time DESC
            LIMIT 1
         ) fv ON TRUE
        ${where}
        ORDER BY a.time_slot ASC NULLS LAST, a.id ASC`,
      params,
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Flow appointments");
  }
});

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
      `SELECT id, time_slot, visit_type, doctor_name, status, bill_paid, bill_created
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

// Billing for a patient's today appointment, extracted from HealthRay's
// get_transactions (structured JSON — no PDF/AI). Returns { billing, steps }
// where steps are removable journey suggestions (Blood Sample for lab items,
// imaging steps for radiology). Best-effort: never blocks check-in — returns
// { billing: null, steps: [] } when there's no bill or HealthRay is unreachable.
router.get("/flow/patient-billing", async (req, res) => {
  try {
    const { patient_db_id, file_no } = req.query;
    const date = req.query.date || new Date().toISOString().split("T")[0];
    if (!patient_db_id && !file_no) return res.json({ billing: null, steps: [] });
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
    const appt = (
      await pool.query(
        `SELECT healthray_id, healthray_patient_id
           FROM appointments
          WHERE appointment_date::date = $1 AND (${conds.join(" OR ")})
          ORDER BY id DESC LIMIT 1`,
        params,
      )
    ).rows[0];
    if (!appt?.healthray_patient_id) return res.json({ billing: null, steps: [] });

    const rows = await fetchPatientTransactions(appt.healthray_patient_id);
    const out = transactionsToBilling(rows, { appointmentId: appt.healthray_id, date });
    res.json(out || { billing: null, steps: [] });
  } catch (e) {
    // Don't fail check-in over billing — log and return empty.
    console.error("Flow patient billing:", e.message);
    res.json({ billing: null, steps: [] });
  }
});

// Bridge A — Start flow from an existing OPD/GHM appointment. Creates a flow
// visit (+ default journey) linked to the appointment. Idempotent: returns the
// existing flow visit if one is already linked. Doctor prefilled from the appt.
router.post("/flow/from-appointment/:appointmentId", async (req, res) => {
  const client = await pool.connect();
  // Hoisted so the 23505 handler in catch can identify the patient.
  let patientDbId = null;
  let fileNo = null;
  try {
    const apptId = req.params.appointmentId;
    // Optional — this bridge is also called from screens with no token field.
    const tokenNumber =
      String(req.body?.token_number ?? "")
        .trim()
        .slice(0, 32) || null;
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
    patientDbId = appt.patient_id || null;
    fileNo = appt.file_no || (patientDbId ? `P_${patientDbId}` : "UNKNOWN");
    const sdId = appt.doctor_id || null;
    const sdName = appt.doctor_name || null;

    // Idempotent per patient too, not just per appointment: the same person may
    // already have a manual check-in row today under a different (or no)
    // appointment_id. Reuse it — and back-link this appointment — instead of
    // inserting a second row that would double-count the patient.
    const byPatient = (
      await client.query(
        `SELECT id, visit_token, appointment_id FROM flow_visits
          WHERE status <> 'cancelled' AND visit_date::date = CURRENT_DATE
            AND (($1::int IS NOT NULL AND patient_db_id = $1) OR patient_id = $2)
          ORDER BY checkin_time DESC LIMIT 1`,
        [patientDbId, fileNo],
      )
    ).rows[0];
    if (byPatient) {
      if (!byPatient.appointment_id) {
        await client.query("UPDATE flow_visits SET appointment_id=$2 WHERE id=$1", [
          byPatient.id,
          apptId,
        ]);
      }
      return res.json({
        visit_id: byPatient.id,
        visit_token: byPatient.visit_token,
        existed: true,
      });
    }

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
            visit_token, checked_in_by, assigned_sd, assigned_sd_name, token_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW() + make_interval(mins => $9), $10,$11,$12,$13,$14)
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
          tokenNumber,
        ],
      )
    ).rows[0];

    for (let i = 0; i < tpl.length; i++) {
      const s = tpl[i];
      await client.query(
        `INSERT INTO flow_visit_steps
           (visit_id, step_catalog_id, step_order, step_name, planned_duration_min, station, assigned_role,
            assigned_staff_id, assigned_staff_name, status, is_background)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',
                 COALESCE((SELECT is_background FROM flow_step_catalog WHERE id=$2), FALSE))`,
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
    // Lost the race against the one-per-patient/day unique index — the patient
    // already has a row today. Return it as existed:true instead of a 500.
    if (e.code === "23505") {
      const survivor = (
        await pool
          .query(
            `SELECT id, visit_token FROM flow_visits
              WHERE status <> 'cancelled' AND visit_date::date = CURRENT_DATE
                AND ((${patientDbId ? "patient_db_id = $2 OR " : ""}patient_id = $1))
              ORDER BY checkin_time DESC LIMIT 1`,
            patientDbId ? [fileNo, patientDbId] : [fileNo],
          )
          .catch(() => ({ rows: [] }))
      ).rows[0];
      if (survivor) {
        return res.json({
          visit_id: survivor.id,
          visit_token: survivor.visit_token,
          existed: true,
        });
      }
    }
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
    if (!canWorkStationRole(req.doctor?.role, role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const r = await pool.query(
      `SELECT s.*, v.patient_name, v.patient_age_sex, v.patient_id AS file_no, v.is_vip,
              v.token_number,
              v.visit_type_id, v.max_time_min, v.checkin_time, v.actual_completion, v.status AS visit_status,
              v.patient_db_id,
              (SELECT COUNT(*)::int FROM flow_visit_steps x
                WHERE x.visit_id=v.id AND NOT x.is_background) AS total_steps,
              -- step_order counts background stages too, so a patient with three
              -- lab stages read "Step 11 of 8". This is the position a person
              -- would count to, on the same scale as total_steps.
              (SELECT COUNT(*)::int FROM flow_visit_steps x
                WHERE x.visit_id=v.id AND NOT x.is_background
                  AND x.step_order <= s.step_order) AS step_position
         FROM flow_visit_steps s
         JOIN flow_visits v ON v.id = s.visit_id
        WHERE s.assigned_role=$1 AND v.visit_date=$2 AND v.status='in_progress'
          AND s.status IN ('in_progress','ready','pending')
          -- Background stages are not called in; they complete from HealthRay or
          -- from "Results received" in the active box. Listing them as queue rows
          -- made the lab desk look like it had work it cannot do.
          AND NOT s.is_background
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
        // Expired claims are dropped here too, so the row never shows a name
        // the API would no longer enforce.
        claim: claimOf(s),
      };
    });
    const doneToday = (
      await pool.query(
        `SELECT COUNT(*)::int n FROM flow_visit_steps s JOIN flow_visits v ON v.id=s.visit_id
          WHERE s.assigned_role=$1 AND v.visit_date=$2 AND s.status='completed'`,
        [role, date],
      )
    ).rows[0].n;
    // Desks whose work is background (the reports desk) have no queue rows at
    // all, so the header count has to come from the stages waiting on them —
    // this role's earliest open stage, on visits where nothing before it is open.
    const awaiting = (
      await pool.query(
        `SELECT COUNT(*)::int n FROM flow_visits v
          WHERE v.visit_date=$2 AND v.status='in_progress'
            AND EXISTS (
              SELECT 1 FROM flow_visit_steps s
               WHERE s.visit_id=v.id AND s.is_background AND s.assigned_role=$1
                 AND s.status NOT IN ('completed','skipped')
                 AND NOT EXISTS (
                   SELECT 1 FROM flow_visit_steps e
                    WHERE e.visit_id=v.id AND e.is_background
                      AND e.step_order < s.step_order
                      AND e.status NOT IN ('completed','skipped')))`,
        [role, date],
      )
    ).rows[0].n;
    res.json({
      role,
      active: items.filter((i) => i.status === "in_progress"),
      ready: items.filter((i) => i.status === "ready"),
      pending: items.filter((i) => i.status === "pending"),
      awaiting,
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
        "SELECT id, patient_name, status, checkin_time, max_time_min, actual_completion, token_number FROM flow_visits WHERE visit_token=$1",
        [req.params.token],
      )
    ).rows[0];
    if (!v) return res.status(404).json({ error: "Not found" });
    const steps = (
      await pool.query(
        `SELECT step_order, step_name, status FROM flow_visit_steps
          WHERE visit_id=$1 AND NOT is_background ORDER BY step_order ASC`,
        [v.id],
      )
    ).rows;
    const t = classifyVisit(v, Date.now());
    const current = steps.find((s) => s.status === "in_progress") || null;
    res.json({
      first_name: (v.patient_name || "").split(" ")[0],
      // The counter token from the patient's physical slip — lets them confirm
      // this page is really about them. Not sensitive on its own, and the
      // payload is already token-scoped and sanitized.
      token_number: v.token_number || null,
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
                -- Median alongside the mean: a handful of steps left open for
                -- hours drags AVG far above what a typical patient experiences,
                -- which makes an outlier problem look like a systemic one.
                ROUND(
                  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.actual_duration_min)::numeric, 1
                ) AS median_actual,
                COUNT(*) FILTER (WHERE s.actual_duration_min > s.planned_duration_min)::int AS exceeded_count,
                COUNT(*)::int AS total_count
           FROM flow_visit_steps s
           JOIN flow_visits v ON v.id = s.visit_id
          WHERE v.visit_date BETWEEN $1 AND $2 AND s.status='completed' AND s.actual_duration_min IS NOT NULL
          GROUP BY s.step_name
          -- Rank by the TYPICAL case (median − budget), not the mean. A step
          -- left open a few times sends AVG through the roof and pushes a
          -- step whose median is comfortably inside budget to the top of the
          -- bottleneck list. Aggregates are repeated rather than referenced by
          -- alias — Postgres resolves names inside ORDER BY expressions
          -- against input columns, not output aliases.
          ORDER BY (
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.actual_duration_min)
            - AVG(s.planned_duration_min)
          ) DESC NULLS LAST`,
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
