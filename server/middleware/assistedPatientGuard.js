import pool from "../config/db.js";
import { normalizeRole, ROLES } from "../../shared/permissions.js";
import {
  assistedDoctorOf,
  hasRxMos,
  isAssignedPatient,
  isAssignedVisit,
} from "../services/assistedDoctor.js";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

const patientOfAppointment = async (id) =>
  (await pool.query(`SELECT patient_id FROM appointments WHERE id = $1`, [id])).rows[0]
    ?.patient_id ?? null;

const patientOfDocument = async (id) =>
  (await pool.query(`SELECT patient_id FROM documents WHERE id = $1`, [id])).rows[0]?.patient_id ??
  null;

const numeric = (value) => (/^\d+$/.test(value || "") ? Number(value) : null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (value) => (UUID.test(value || "") ? value : null);

const visitOfRow = (table) => async (seg) =>
  uuid(seg[0]) || numeric(seg[0])
    ? ((await pool.query(`SELECT visit_id FROM ${table} WHERE id::text = $1`, [seg[0]])).rows[0]
        ?.visit_id ?? null)
    : null;

const DOCTOR_STATION = "/api/giniflow/stations/doctor";
const CHIEF_STATION = "/api/giniflow/stations/mo";

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
  { prefix: "/api/giniflow/stations/summary", open: true, readOnly: true, exact: true },
  { prefix: `${DOCTOR_STATION}/queue`, open: true, readOnly: true, exact: true },
  { prefix: `${DOCTOR_STATION}/test-panels`, open: true, readOnly: true, exact: true },
  { prefix: `${DOCTOR_STATION}/medicines/alternatives`, open: true, readOnly: true, exact: true },
  { prefix: `${DOCTOR_STATION}/prescription/items/`, visit: visitOfRow("giniflow_rx_items") },
  { prefix: `${DOCTOR_STATION}/proposals/`, visit: visitOfRow("giniflow_rx_proposals") },
  { prefix: `${DOCTOR_STATION}/suggestions/`, visit: visitOfRow("giniflow_plan_suggestions") },
  { prefix: `${DOCTOR_STATION}/`, visit: (seg) => uuid(seg[0]) },
  { prefix: `${CHIEF_STATION}/queue`, chief: true, open: true, readOnly: true, exact: true },
  { prefix: `${CHIEF_STATION}/test-panels`, chief: true, open: true, readOnly: true, exact: true },
  {
    prefix: `${CHIEF_STATION}/prescription/items/`,
    chief: true,
    visit: visitOfRow("giniflow_rx_items"),
  },
  {
    prefix: `${CHIEF_STATION}/proposals/`,
    chief: true,
    visit: visitOfRow("giniflow_rx_proposals"),
  },
  { prefix: `${CHIEF_STATION}/`, chief: true, visit: (seg) => uuid(seg[0]) },
  { prefix: "/api/giniflow/referrals/visit/", visit: (seg) => uuid(seg[0]) },
  {
    prefix: "/api/giniflow/referrals/",
    visit: async (seg) => seg.length === 1 && (await visitOfRow("giniflow_referrals")(seg)),
    methods: ["DELETE"],
  },
];

const deny = (res) =>
  res.status(403).json({
    error:
      "This patient isn't assigned to you. Ask the coordinator to assign them on the triage board.",
    code: "not_assisted_patient",
  });

export async function assistedPatientGuard(req, res, next) {
  if (normalizeRole(req.doctor?.role) === ROLES.CONSULTANT && req.path.startsWith(DOCTOR_STATION)) {
    try {
      if (await hasRxMos(req.doctor.doctor_id))
        return res.status(403).json({
          error: "Your patients are worked on the Consultant station by your prescription MOs.",
          code: "consultant_station_by_mos",
        });
    } catch (e) {
      return next(e);
    }
    return next();
  }
  if (!req.path.startsWith("/api/") || normalizeRole(req.doctor?.role) !== ROLES.RX_MO)
    return next();
  try {
    const assisted = await assistedDoctorOf(req.doctor.doctor_id);
    req.assistedDoctor = assisted;
    const moId = req.doctor.doctor_id;
    req.rxMoId = moId;

    const rule = RULES.find(
      (r) =>
        (!r.chief || assisted?.chief) &&
        (r.exact ? req.path === r.prefix : req.path.startsWith(r.prefix)),
    );
    if (!rule) return deny(res);
    if (rule.open) return rule.readOnly && !READS.has(req.method) ? deny(res) : next();
    if (rule.patients) {
      const ids = String(req.query.patient_ids || "")
        .split(",")
        .map(numeric)
        .filter(Boolean);
      if (!READS.has(req.method) || !ids.length) return deny(res);
      const checks = await Promise.all(ids.map((id) => isAssignedPatient(id, moId)));
      return checks.every(Boolean) ? next() : deny(res);
    }
    if (rule.list) {
      if (!READS.has(req.method)) return deny(res);
      delete req.query.doctor;
      return next();
    }

    const segments = req.path.slice(rule.prefix.length).split("/");
    if (rule.methods && !rule.methods.includes(req.method)) return deny(res);
    if (rule.visit) {
      const visitId = await rule.visit(segments);
      const allowed =
        !!visitId && (await isAssignedVisit(visitId, moId, { today: !READS.has(req.method) }));
      return allowed ? next() : deny(res);
    }
    const patientId = await rule.patient(segments);
    if (!patientId) return deny(res);
    const allowed = await isAssignedPatient(patientId, moId, { today: !READS.has(req.method) });
    return allowed ? next() : deny(res);
  } catch (e) {
    next(e);
  }
}
