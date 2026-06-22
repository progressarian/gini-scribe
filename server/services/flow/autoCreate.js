// Auto-start a Flow journey from a HealthRay-synced appointment.
//
// Background: a flow_visit is otherwise only created by a manual /flow/checkin
// or "Start Flow" click. If nobody does that, the patient moves through
// HealthRay untracked and the visit only materialises later — all steps closed
// in one write, so the board shows "Elapsed 0m". Creating the visit early (when
// HealthRay reports checkedin / in_visit) lets the existing state machine
// advance the steps over real time, so timing is honest.
//
// SAFETY: additive only — INSERTs into flow_visits / flow_visit_steps / flow_events,
// strictly scoped to ONE appointment/visit, idempotent (never duplicates, never
// overwrites a manual check-in), transactional, and gated by FLOW_AUTO_CREATE.
// See docs/FLOW_AUTO_CREATE_PLAN.md §7.

import pool from "../../config/db.js";
import { genVisitToken, WAITING_ROLE } from "./journey.js";
import { fetchPatientTransactions } from "../healthray/client.js";
import { transactionsToBilling } from "../healthray/billingExtractor.js";
import { createLogger } from "../logger.js";

const { log, error } = createLogger("Flow AutoCreate");

// Tag on auto-created visits so they're identifiable / reversible (plan §7.9).
export const AUTO_ACTOR = "auto:healthray";

export function autoCreateEnabled() {
  return process.env.FLOW_AUTO_CREATE === "1";
}

// — small helpers, mirrored from routes/flow.js so this stays self-contained —
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

async function logEvent(client, visitId, type, stepOrder, details, by) {
  await client.query(
    `INSERT INTO flow_events (visit_id, event_type, step_order, details, triggered_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [visitId, type, stepOrder ?? null, details ? JSON.stringify(details) : null, by || null],
  );
}

// Find the live (non-cancelled) flow visit for this appointment, if any.
// Also guards against a twin when a manual check-in linked by patient + date.
async function findLiveVisit(client, appt) {
  return (
    await client.query(
      `SELECT id, visit_token FROM flow_visits
        WHERE status <> 'cancelled'
          AND (appointment_id=$1 OR (patient_db_id IS NOT NULL AND patient_db_id=$2 AND visit_date=CURRENT_DATE))
        ORDER BY checkin_time DESC LIMIT 1`,
      [appt.id, appt.patient_id || null],
    )
  ).rows[0];
}

// Pull the billed lab/imaging/machine tests for this appointment and shape them
// into journey steps (best-effort: returns [] on any failure, never throws).
// Each step is stamped data.from_billing=true so the floor UI can ✕-remove it.
async function buildBillingSteps(client, appt) {
  if (!appt.healthray_patient_id) return [];
  let rows;
  try {
    rows = await fetchPatientTransactions(appt.healthray_patient_id);
  } catch (e) {
    error("billing fetch", `${appt.id}: ${e.message}`);
    return [];
  }
  const out = transactionsToBilling(rows, { appointmentId: appt.healthray_id });
  const suggestions = out?.steps || [];
  if (!suggestions.length) return [];

  const ids = [...new Set(suggestions.map((s) => s.step_catalog_id).filter(Boolean))];
  const byId = {};
  if (ids.length) {
    const cat = (
      await client.query(
        `SELECT id, default_duration_min, station, assigned_role
           FROM flow_step_catalog WHERE id = ANY($1)`,
        [ids],
      )
    ).rows;
    for (const c of cat) byId[c.id] = c;
  }
  return suggestions.map((sg) => {
    const c = sg.step_catalog_id ? byId[sg.step_catalog_id] : null;
    return {
      step_catalog_id: sg.step_catalog_id || null,
      step_name: sg.step_name + (sg.tests?.length ? ` (${sg.tests.length})` : ""),
      planned_duration_min: c?.default_duration_min ?? 10,
      station: c?.station || "Lab",
      assigned_role: c?.assigned_role || "lab_tech",
      from_billing: true,
      tests: sg.tests || [],
    };
  });
}

// Splice billing steps into the template list just before the Billing step
// (or before Pharmacy, else appended), deduped against existing names/ids.
function mergeJourney(templateSteps, billingSteps) {
  if (!billingSteps.length) return templateSteps.map((s) => ({ ...s }));
  const have = new Set(templateSteps.map((s) => s.step_catalog_id || s.step_name));
  const fresh = billingSteps.filter((s) => !have.has(s.step_catalog_id || s.step_name));
  if (!fresh.length) return templateSteps.map((s) => ({ ...s }));
  let at = templateSteps.findIndex((s) => s.step_catalog_id === "billing");
  if (at < 0) at = templateSteps.findIndex((s) => s.step_catalog_id === "pharmacy");
  if (at < 0) at = templateSteps.length;
  return [...templateSteps.slice(0, at), ...fresh, ...templateSteps.slice(at)].map((s) => ({
    ...s,
  }));
}

// Create the flow visit + journey for an appointment. Idempotent: returns the
// existing visit untouched if one is already live. Returns
// { visit_id, visit_token, created }.
export async function createFlowVisitFromAppointment(appt, opts = {}) {
  const { includeBilling = true, actor = AUTO_ACTOR } = opts;
  const client = await pool.connect();
  try {
    const existing = await findLiveVisit(client, appt);
    if (existing) {
      return { visit_id: existing.id, visit_token: existing.visit_token, created: false };
    }

    const visitTypeId = appt.is_walkin ? "FU_WALK" : "FU_APPT";
    const vt = (
      await client.query("SELECT max_time_min FROM flow_visit_types WHERE id=$1", [visitTypeId])
    ).rows[0];
    const tpl = (
      await client.query(
        `SELECT c.id AS step_catalog_id, c.name AS step_name,
                COALESCE(t.override_duration_min, c.default_duration_min)::int AS planned_duration_min,
                c.station, c.assigned_role
           FROM flow_step_templates t JOIN flow_step_catalog c ON c.id=t.step_catalog_id
          WHERE t.visit_type_id=$1 ORDER BY t.step_order`,
        [visitTypeId],
      )
    ).rows;
    if (!tpl.length) {
      error("create", `no template for ${visitTypeId} (appt ${appt.id})`);
      return { visit_id: null, visit_token: null, created: false };
    }

    const billingSteps = includeBilling ? await buildBillingSteps(client, appt) : [];
    const journey = mergeJourney(tpl, billingSteps);
    const total = journey.reduce((a, s) => a + (Number(s.planned_duration_min) || 0), 0);

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
          appt.id,
          appt.patient_name || "Patient",
          appt.phone || null,
          visitTypeId,
          appt.time_slot || null,
          vt?.max_time_min || 90,
          total,
          token,
          actor,
          sdId,
          sdName,
        ],
      )
    ).rows[0];

    for (let i = 0; i < journey.length; i++) {
      const s = journey[i];
      const data = s.from_billing ? { from_billing: true, tests: s.tests || [] } : {};
      await client.query(
        `INSERT INTO flow_visit_steps
           (visit_id, step_catalog_id, step_order, step_name, planned_duration_min, station, assigned_role,
            assigned_staff_id, assigned_staff_name, status, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)`,
        [
          visit.id,
          s.step_catalog_id || null,
          i + 1,
          s.step_name,
          Number(s.planned_duration_min) || 0,
          s.station || "",
          s.assigned_role || "",
          s.step_catalog_id === "sd_consult" && sdId ? String(sdId) : null,
          s.step_catalog_id === "sd_consult" && sdName ? sdName : null,
          JSON.stringify(data),
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
      { auto: "healthray", from_appointment: appt.id, billing_steps: billingSteps.length },
      actor,
    );
    await client.query("COMMIT");
    log("create", `visit ${visit.id} for appt ${appt.id} (${billingSteps.length} billing steps)`);
    return { visit_id: visit.id, visit_token: token, created: true };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    error("create", `appt ${appt.id}: ${e.message}`);
    return { visit_id: null, visit_token: null, created: false };
  } finally {
    client.release();
  }
}

// Cron entrypoint: ensure a Flow visit exists for an appointment id. Loads the
// FULL appointments row itself (the cron's findAppointment() returns only a
// subset), then creates the visit (with billing) if missing, or — for an
// existing visit whose bill landed after check-in and isn't paid yet and has no
// billing step yet — reconciles late tests. No-op when FLOW_AUTO_CREATE is off.
// Returns { created, visit_id }.
export async function ensureAutoFlowVisit(apptId, { newStatus } = {}) {
  if (!autoCreateEnabled()) return { created: false, visit_id: null };
  const appt = (await pool.query("SELECT * FROM appointments WHERE id=$1", [apptId])).rows[0];
  if (!appt) return { created: false, visit_id: null };

  const r = await createFlowVisitFromAppointment(appt, { includeBilling: true, actor: AUTO_ACTOR });
  if (!r.created && r.visit_id && appt.bill_created === true && appt.bill_paid !== "Paid") {
    // Throttle: only poll billing while no from_billing step exists yet, so once
    // tests are injected we never call HealthRay for this patient again.
    const hasBillingStep =
      (
        await pool.query(
          "SELECT 1 FROM flow_visit_steps WHERE visit_id=$1 AND (data->>'from_billing')='true' LIMIT 1",
          [r.visit_id],
        )
      ).rowCount > 0;
    if (!hasBillingStep) await reconcileBillingSteps(appt, r.visit_id);
  }
  return r;
}

// For an EXISTING auto-created visit whose bill appeared after check-in: inject
// any billed lab/imaging steps not yet in the journey. Idempotent + deduped;
// inserts before the Billing step (shifting later steps down). Best-effort.
export async function reconcileBillingSteps(appt, visitId) {
  const client = await pool.connect();
  try {
    const billingSteps = await buildBillingSteps(client, appt);
    if (!billingSteps.length) return 0;

    const cur = (
      await client.query(
        "SELECT step_catalog_id, step_name, step_order, status FROM flow_visit_steps WHERE visit_id=$1 ORDER BY step_order",
        [visitId],
      )
    ).rows;
    const have = new Set(cur.map((s) => s.step_catalog_id || s.step_name));
    const fresh = billingSteps.filter((s) => !have.has(s.step_catalog_id || s.step_name));
    if (!fresh.length) return 0;

    // Insert before the Billing step if it isn't done yet, else before Pharmacy,
    // else append at the end.
    const billing = cur.find((s) => s.step_catalog_id === "billing" && s.status === "pending");
    const pharmacy = cur.find((s) => s.step_catalog_id === "pharmacy" && s.status === "pending");
    const anchor = billing || pharmacy;
    const maxOrder = cur.reduce((m, s) => Math.max(m, s.step_order), 0);

    await client.query("BEGIN");
    let added = 0;
    for (const s of fresh) {
      const target = anchor ? anchor.step_order + added : maxOrder + 1 + added;
      // Shift later steps down to free the slot (highest first via >=).
      await client.query(
        "UPDATE flow_visit_steps SET step_order = step_order + 1 WHERE visit_id=$1 AND step_order >= $2",
        [visitId, target],
      );
      await client.query(
        `INSERT INTO flow_visit_steps
           (visit_id, step_catalog_id, step_order, step_name, planned_duration_min, station, assigned_role, status, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
        [
          visitId,
          s.step_catalog_id || null,
          target,
          s.step_name,
          Number(s.planned_duration_min) || 0,
          s.station || "",
          s.assigned_role || "",
          JSON.stringify({ from_billing: true, tests: s.tests || [] }),
        ],
      );
      added++;
    }
    // Recompute the visit's suggested wait + ETA from the live steps (mirrors
    // recalcEstimate in routes/flow.js) so the time bar reflects the new steps.
    await client.query(
      `UPDATE flow_visits fv
          SET suggested_wait_min = t.total,
              estimated_completion = fv.checkin_time + make_interval(mins => t.total),
              updated_at = NOW()
         FROM (SELECT COALESCE(SUM(planned_duration_min),0)::int AS total
                 FROM flow_visit_steps WHERE visit_id=$1 AND status <> 'skipped') t
        WHERE fv.id=$1`,
      [visitId],
    );
    await logEvent(
      client,
      visitId,
      "step_added",
      null,
      { auto: "healthray_billing", added },
      AUTO_ACTOR,
    );
    await client.query("COMMIT");
    log("reconcile", `visit ${visitId}: +${added} billing step(s)`);
    return added;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    error("reconcile", `visit ${visitId}: ${e.message}`);
    return 0;
  } finally {
    client.release();
  }
}
