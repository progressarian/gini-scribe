import pool from "../../config/db.js";
import {
  buildRxParameterTable,
  getRxParameterDefaults,
  saveRxParameterOverrides,
} from "../rxParameterTable.js";
import { buildVisitPayloadFromDb } from "../prescriptionAutoSave.js";
import { generatePatientSummary } from "../patientSummaryAI.js";

const LOCKED_STATUSES = [
  "doctor_done",
  "rx_pending",
  "with_rx",
  "pharmacy_pending",
  "dispensed",
  "exited",
];

async function visitContext(db, visitId) {
  const { rows } = await db.query(
    `SELECT id, patient_id, visit_date::text AS visit_date, current_status, appointment_id
       FROM giniflow_visits WHERE id = $1`,
    [visitId],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  return { ...rows[0], locked: LOCKED_STATUSES.includes(rows[0].current_status) };
}

export async function getStationRxParameters(visitId, db = pool) {
  const visit = await visitContext(db, visitId);
  const [table, defaults] = await Promise.all([
    buildRxParameterTable(db, { patientId: visit.patient_id, visitDate: visit.visit_date }),
    getRxParameterDefaults(db),
  ]);
  return {
    ...table,
    locked: visit.locked,
    catalog: defaults.map(({ key, label, unit }) => ({ key, label, unit })),
  };
}

export async function saveStationRxParameters(visitId, rows, actor, db = pool) {
  const visit = await visitContext(db, visitId);
  if (visit.locked) {
    throw Object.assign(
      new Error("This prescription is finalized — use Re-issue to change the parameter table"),
      { status: 409 },
    );
  }
  const defaults = await getRxParameterDefaults(db);
  const known = new Set(defaults.map((p) => p.key));
  const unknown = rows.find((r) => !known.has(r.key) && !r.custom);
  if (unknown) {
    throw Object.assign(new Error(`Unknown parameter "${unknown.key}"`), { status: 400 });
  }
  const nameless = rows.find((r) => r.custom && !r.removed && !String(r.label || "").trim());
  if (nameless) {
    throw Object.assign(new Error("A new parameter needs a name"), { status: 400 });
  }
  await saveRxParameterOverrides(db, {
    patientId: visit.patient_id,
    visitDate: visit.visit_date,
    rows,
    actor,
  });
  return getStationRxParameters(visitId, db);
}

const summaryText = (raw) => {
  if (!raw) return null;
  if (typeof raw === "object") return raw.body || null;
  return String(raw);
};

export async function getStationVisitSummary(visitId, db = pool) {
  const visit = await visitContext(db, visitId);
  if (!visit.appointment_id) return { text: null, canGenerate: false };
  const { rows } = await db.query(`SELECT post_visit_summary FROM appointments WHERE id = $1`, [
    visit.appointment_id,
  ]);
  return { text: summaryText(rows[0]?.post_visit_summary), canGenerate: true };
}

export async function generateStationVisitSummary(visitId, db = pool) {
  const visit = await visitContext(db, visitId);
  if (!visit.appointment_id) {
    throw Object.assign(new Error("This visit has no appointment to summarise"), { status: 409 });
  }
  const payload = await buildVisitPayloadFromDb(visit.patient_id, {
    appointmentId: visit.appointment_id,
  });
  const { body } = await generatePatientSummary(payload);
  await db.query(`UPDATE appointments SET post_visit_summary = $1 WHERE id = $2`, [
    JSON.stringify(body),
    visit.appointment_id,
  ]);
  return { text: body, canGenerate: true };
}
