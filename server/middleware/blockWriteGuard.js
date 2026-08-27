// Hard guard: no write against a blocked patient succeeds.
//
// Mounted as a router.param handler so one implementation covers every
// patient-scoped POST / PUT / PATCH / DELETE, current and future, without
// touching individual handlers.
//
// An admin may still force a write through (`force: true` in the body, or
// ?force=1) — the same escape hatch bookingGuard.js:33 uses, so an emergency
// can never be fully locked out. Every override is recorded in
// patient_block_log, so a forced clinical write is auditable.
//
// Design: docs/PATIENT_BLOCKLIST_PLAN.md §3.9
import pool from "../config/db.js";
import {
  fetchBlockRow,
  logBlockAction,
  blockActor,
  resolvePatientId,
} from "../services/patientBlockGuard.js";
import { blockDetail } from "../services/patientBlockView.js";
import { hasCapability, CAPABILITIES } from "../../shared/permissions.js";
import { BLOCK_ACTIONS } from "../../shared/patientBlockReasons.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// `:id` means different things in different routers — a patient on
// /patients/:id/labs, a document on /documents/:id, an appointment on
// /appointments/:id — so the value alone is not enough to know what we have.
//
// This deliberately reads the URL rather than `req.route.path`. Express invokes
// each param callback ONCE per request and caches the result; a
// `router.use("/visit/:patientId", ...)` layer registered before the routes
// (visit.js:82) consumes the param first, and on a middleware layer `req.route`
// is undefined. Keying off req.route therefore silently skipped the guard and
// it was never re-invoked for the real route. The URL is available on every
// layer, so it is the reliable signal.
const PATIENT_URL = /\/(?:visit|patients)\/(\d+)(?:[/?#]|$)/;
const APPOINTMENT_URL = /\/appointments\/(\d+)(?:[/?#]|$)/;

// Appointment routes that stay open even for a blocked patient. Cancelling,
// reassigning or marking a no-show must remain possible — those are how a
// blocked patient's existing booking gets tidied up. Everything else under
// /appointments/:id (vitals, biomarkers, compliance, prep) is a clinical write.
const APPOINTMENT_OPEN = /\/appointments\/\d+(?:\/status)?(?:[?#]|$)/;

// Resolve the patient this write lands on, or null when it is not a patient
// write at all. `value` is the param Express matched, so we also confirm the
// URL segment we found is the one being handed to us.
async function resolvePatientForWrite(req, value) {
  const url = String(req.originalUrl || "");

  const direct = url.match(PATIENT_URL);
  if (direct && direct[1] === String(value)) return parseInt(direct[1], 10);

  const appt = url.match(APPOINTMENT_URL);
  if (appt && appt[1] === String(value) && !APPOINTMENT_OPEN.test(url)) {
    const { rows } = await pool.query("SELECT patient_id FROM appointments WHERE id = $1", [
      parseInt(appt[1], 10),
    ]);
    return rows[0]?.patient_id || null;
  }

  return null;
}

const isForced = (req) =>
  req.body?.force === true ||
  req.body?.force === "true" ||
  ["1", "true", "yes"].includes(String(req.query?.force || "").toLowerCase());

// The shared decision. Returns true when the request has been answered.
async function refuseIfBlocked(req, res, patientId) {
  if (!Number.isInteger(patientId) || patientId <= 0) return false;

  let row;
  try {
    row = await fetchBlockRow(patientId);
  } catch (e) {
    // Fail closed would take the whole chart down on a transient DB blip, so a
    // lookup failure lets the write through and is logged rather than swallowed.
    console.error("blockWriteGuard lookup failed:", e?.message);
    return false;
  }
  if (!row?.is_blocked) return false;

  if (isForced(req) && hasCapability(req.doctor?.role, CAPABILITIES.ADMIN)) {
    const actor = blockActor(req);
    logBlockAction({
      patientId,
      action: BLOCK_ACTIONS.OVERRIDE_WRITE,
      note: `${req.method} ${req.originalUrl}`,
      actorName: actor.name,
      actorId: actor.id,
    }).catch(() => {});
    return false;
  }

  res.status(409).json({
    error: "Patient is blocked",
    reason: "patient_blocked",
    detail: blockDetail(row, req.doctor?.role),
  });
  return true;
}

// ── Entry point 2: the patient is named in the BODY, not the URL ────────────
// The OBT/ops routes (cc-calling, obt-status, station-tracking, patient-alerts,
// lab-requests) POST a patient_id / file_no / appointment_id rather than
// carrying it in the path, so router.param never fires. Mount with router.use.
export async function blockWriteBodyGuard(req, res, next) {
  if (!WRITE_METHODS.has(req.method)) return next();
  try {
    const b = req.body || {};
    let patientId = Number.isInteger(+b.patient_id) && +b.patient_id > 0 ? +b.patient_id : null;

    if (!patientId && b.file_no) {
      patientId = await resolvePatientId({ fileNo: String(b.file_no) });
    }
    if (!patientId && b.appointment_id) {
      const { rows } = await pool.query("SELECT patient_id FROM appointments WHERE id = $1", [
        b.appointment_id,
      ]);
      patientId = rows[0]?.patient_id || null;
    }
    if (patientId && (await refuseIfBlocked(req, res, patientId))) return;
  } catch (e) {
    console.error("blockWriteBodyGuard failed:", e?.message);
  }
  next();
}

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

export const blockWriteGuardVia =
  (table, column = "patient_id") =>
  async (req, res, next, value) => {
    if (!WRITE_METHODS.has(req.method)) return next();
    if (!SAFE_IDENT.test(table) || !SAFE_IDENT.test(column)) {
      console.error(`blockWriteGuardVia: unsafe identifier ${table}.${column}`);
      return next();
    }

    const id = String(value || "").trim();
    if (!id) return next();
    try {
      const { rows } = await pool.query(`SELECT ${column} AS ref FROM ${table} WHERE id = $1`, [
        id,
      ]);
      const ref = rows[0]?.ref;
      if (!ref) return next();
      const patientId =
        column === "patient_id" ? Number(ref) : await resolvePatientId({ fileNo: String(ref) });
      if (patientId && (await refuseIfBlocked(req, res, Number(patientId)))) return;
    } catch (e) {
      console.error(`blockWriteGuardVia(${table}) failed:`, e?.message);
    }
    next();
  };

export async function blockWriteGuard(req, res, next, value) {
  if (!WRITE_METHODS.has(req.method)) return next();
  try {
    const patientId = await resolvePatientForWrite(req, value);
    if (patientId && (await refuseIfBlocked(req, res, patientId))) return;
  } catch (e) {
    console.error("blockWriteGuard failed:", e?.message);
  }
  next();
}
