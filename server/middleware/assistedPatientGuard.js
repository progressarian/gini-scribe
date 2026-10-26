import pool from "../config/db.js";
import { normalizeRole, ROLES } from "../../shared/permissions.js";
import { assistedDoctorOf, isAssignedPatient } from "../services/assistedDoctor.js";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

const patientOfAppointment = async (id) =>
  (await pool.query(`SELECT patient_id FROM appointments WHERE id = $1`, [id])).rows[0]
    ?.patient_id ?? null;

const patientOfDocument = async (id) =>
  (await pool.query(`SELECT patient_id FROM documents WHERE id = $1`, [id])).rows[0]?.patient_id ??
  null;

const numeric = (value) => (/^\d+$/.test(value || "") ? Number(value) : null);

const RULES = [
  { prefix: "/api/auth", open: true },
  { prefix: "/api/home-stats", open: true },
  { prefix: "/api/doctors", open: true, readOnly: true },
  { prefix: "/api/ai/complete", open: true, exact: true },
  { prefix: "/api/ai/transcribe", open: true, exact: true },
  { prefix: "/api/ai/deepgram-key", open: true, exact: true },
  { prefix: "/api/patient-schemes", open: true, readOnly: true, exact: true },
  { prefix: "/api/patient-block-status", patients: true, exact: true },
  { prefix: "/api/visit/", patient: (seg) => numeric(seg[0]) },
  { prefix: "/api/patients/", patient: (seg) => numeric(seg[0]) },
  { prefix: "/api/documents/", patient: (seg) => numeric(seg[0]) && patientOfDocument(seg[0]) },
  {
    prefix: "/api/appointments/",
    patient: (seg) => numeric(seg[0]) && patientOfAppointment(seg[0]),
  },
  { prefix: "/api/appointments", list: true, exact: true },
];

const deny = (res, assisted) =>
  res.status(403).json({
    error: assisted
      ? "This patient isn't assigned to you. Ask the coordinator to assign them on the triage board."
      : "Your login isn't linked to a consultant yet. Ask an admin to set who you assist.",
    code: "not_assisted_patient",
  });

export async function assistedPatientGuard(req, res, next) {
  if (!req.path.startsWith("/api/") || normalizeRole(req.doctor?.role) !== ROLES.RX_MO)
    return next();
  try {
    const assisted = await assistedDoctorOf(req.doctor.doctor_id);
    if (!assisted && !req.path.startsWith("/api/auth")) return deny(res, null);
    req.assistedDoctor = assisted;
    const moId = req.doctor.doctor_id;
    req.rxMoId = moId;

    const rule = RULES.find((r) =>
      r.exact ? req.path === r.prefix : req.path.startsWith(r.prefix),
    );
    if (!rule) return deny(res, assisted);
    if (rule.open) return rule.readOnly && !READS.has(req.method) ? deny(res, assisted) : next();
    if (rule.patients) {
      const ids = String(req.query.patient_ids || "")
        .split(",")
        .map(numeric)
        .filter(Boolean);
      if (!READS.has(req.method) || !ids.length) return deny(res, assisted);
      const checks = await Promise.all(ids.map((id) => isAssignedPatient(id, moId)));
      return checks.every(Boolean) ? next() : deny(res, assisted);
    }
    if (rule.list) {
      if (!READS.has(req.method)) return deny(res, assisted);
      delete req.query.doctor;
      return next();
    }

    const segments = req.path.slice(rule.prefix.length).split("/");
    const patientId = await rule.patient(segments);
    if (!patientId) return deny(res, assisted);
    const allowed = await isAssignedPatient(patientId, moId, { today: !READS.has(req.method) });
    return allowed ? next() : deny(res, assisted);
  } catch (e) {
    next(e);
  }
}
