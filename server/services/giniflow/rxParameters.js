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

const CHIEF_STATUS = "with_sd";
const NOT_WITH_CHIEF =
  "The patient is no longer with the Chief Endocrinologist — the consultant edits this now";

async function visitContext(db, visitId, station = "doctor") {
  const { rows } = await db.query(
    `SELECT id, patient_id, visit_date::text AS visit_date, current_status, appointment_id
       FROM giniflow_visits WHERE id = $1`,
    [visitId],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  const finalized = LOCKED_STATUSES.includes(rows[0].current_status);
  const notWithChief = station === "mo" && rows[0].current_status !== CHIEF_STATUS;
  return { ...rows[0], finalized, notWithChief, locked: finalized || notWithChief };
}

const refuseIfNotWithChief = (visit) => {
  if (visit.notWithChief && !visit.finalized) {
    throw Object.assign(new Error(NOT_WITH_CHIEF), { status: 409 });
  }
};

export async function getStationRxParameters(visitId, db = pool, { station = "doctor" } = {}) {
  const visit = await visitContext(db, visitId, station);
  const [table, defaults] = await Promise.all([
    buildRxParameterTable(db, { patientId: visit.patient_id, visitDate: visit.visit_date }),
    getRxParameterDefaults(db),
  ]);
  return {
    ...table,
    locked: visit.locked,
    lockedReason: visit.finalized ? "finalized" : visit.notWithChief ? "not_with_chief" : null,
    catalog: defaults.map(({ key, label, unit }) => ({ key, label, unit })),
  };
}

export async function saveStationRxParameters(
  visitId,
  rows,
  actor,
  db = pool,
  { station = "doctor" } = {},
) {
  const visit = await visitContext(db, visitId, station);
  refuseIfNotWithChief(visit);
  if (visit.finalized) {
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
  return getStationRxParameters(visitId, db, { station });
}

const summaryText = (raw) => {
  if (!raw) return null;
  if (typeof raw === "object") return raw.body || null;
  return String(raw);
};

export async function getStationVisitSummary(visitId, db = pool, { station = "doctor" } = {}) {
  const visit = await visitContext(db, visitId, station);
  if (!visit.appointment_id) return { text: null, canGenerate: false };
  const { rows } = await db.query(`SELECT post_visit_summary FROM appointments WHERE id = $1`, [
    visit.appointment_id,
  ]);
  return { text: summaryText(rows[0]?.post_visit_summary), canGenerate: !visit.notWithChief };
}

export async function generateStationVisitSummary(visitId, db = pool, { station = "doctor" } = {}) {
  const visit = await visitContext(db, visitId, station);
  refuseIfNotWithChief(visit);
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
  return { text: body, canGenerate: !visit.notWithChief };
}
