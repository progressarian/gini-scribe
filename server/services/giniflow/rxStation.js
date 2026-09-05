import pool from "../../config/db.js";
import { advanceStatus, budgetColour } from "./statusEngine.js";
import { getSlaConfig, budgetLookup } from "./board.js";
import { buildCard } from "./medicineCard.js";
import { buildCounsellingNote } from "./counsellingNote.js";
import { stoppedToday } from "./pharmacyStation.js";
import { STATUS_LABEL, slaKeyForStatus } from "../../../shared/giniflowStatus.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";

const QUEUE_STATUSES = ["doctor_done", "rx_pending", "with_rx"];
const DONE_STATUSES = ["pharmacy_pending", "dispensed", "exited"];

const QUEUE_SQL = `
  SELECT v.id AS visit_id, v.patient_id, v.current_status, v.category, v.visit_date::text AS visit_date,
         p.name, p.file_no, p.age, p.sex,
         doc.short_name AS doctor_name,
         last_ev.occurred_at AS since,
         cons.id AS consultation_id,
         (rx.id IS NOT NULL AND (rxchg.last_change IS NULL OR rxchg.last_change <= rx.created_at))
           AS has_printable_rx,
         (rx.id IS NOT NULL AND rxchg.last_change > rx.created_at) AS rx_stale,
         meds.n AS medicine_count
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id ORDER BY occurred_at DESC, id DESC LIMIT 1
    ) last_ev ON TRUE
    LEFT JOIN LATERAL (
      SELECT id FROM consultations c
       WHERE c.patient_id = v.patient_id AND c.visit_date = v.visit_date
       ORDER BY id DESC LIMIT 1
    ) cons ON TRUE
    LEFT JOIN LATERAL (
      SELECT d.id, d.created_at FROM documents d
       WHERE d.patient_id = v.patient_id
         AND d.doc_type = 'prescription'
         AND (d.file_url IS NOT NULL OR d.storage_path IS NOT NULL)
         AND d.consultation_id IS NOT DISTINCT FROM cons.id
       ORDER BY d.id DESC LIMIT 1
    ) rx ON TRUE
    LEFT JOIN LATERAL (
      SELECT max(m2.updated_at) AS last_change FROM medications m2
       WHERE m2.consultation_id = cons.id
    ) rxchg ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n FROM medications m
       WHERE m.patient_id = v.patient_id
         AND (m.created_at AT TIME ZONE 'Asia/Kolkata')::date = v.visit_date
         AND m.is_active
    ) meds ON TRUE
   WHERE v.visit_date = $1::date
     AND v.current_status = ANY($2)
     AND NOT COALESCE(p.is_blocked, FALSE)
     AND NOT ${labOnlyPredicate("v", "$3")}
     AND (
       $4::text IS NULL
       OR p.name ILIKE '%' || $4 || '%'
       OR p.file_no ILIKE '%' || $4 || '%'
       OR doc.short_name ILIKE '%' || $4 || '%'
       OR EXISTS (
         SELECT 1 FROM medications ms
          WHERE ms.patient_id = v.patient_id
            AND (ms.created_at AT TIME ZONE 'Asia/Kolkata')::date = v.visit_date
            AND ms.is_active
            AND ms.name ILIKE '%' || $4 || '%'
       )
     )
   ORDER BY last_ev.occurred_at NULLS LAST`;

const minutesSince = (from, now) =>
  from ? Math.max(0, Math.round((now - new Date(from)) / 60000)) : null;

const toRow = (r, budgetFor, now) => {
  const budget = budgetFor(slaKeyForStatus(r.current_status), r.category);
  const minutes = minutesSince(r.since, now);
  return {
    visitId: r.visit_id,
    patientId: r.patient_id,
    name: r.name || "Patient not matched yet",
    fileNo: r.file_no,
    age: r.age,
    sex: r.sex,
    category: r.category,
    status: r.current_status,
    statusLabel: STATUS_LABEL[r.current_status] || r.current_status,
    doctorName: r.doctor_name,
    consultationId: r.consultation_id,
    medicineCount: r.medicine_count ?? 0,
    canPrint: !!r.has_printable_rx,
    rxStale: !!r.rx_stale,
    since: r.since ? new Date(r.since).toISOString() : null,
    minutes,
    budget,
    colour: budgetColour(minutes ?? 0, budget),
  };
};

export async function getRxQueue(visitDate, q = null, now = new Date(), db = pool) {
  const budgetFor = budgetLookup(await getSlaConfig(db));
  const search = q && String(q).trim().length >= 2 ? String(q).trim() : null;

  const [{ rows: open }, { rows: done }] = await Promise.all([
    db.query(QUEUE_SQL, [visitDate, QUEUE_STATUSES, LAB_ONLY_DOCTOR, search]),
    db.query(QUEUE_SQL, [visitDate, DONE_STATUSES, LAB_ONLY_DOCTOR, search]),
  ]);

  const rows = open.map((r) => toRow(r, budgetFor, now));
  return {
    atDesk: rows.filter((r) => r.status === "with_rx"),
    waiting: rows
      .filter((r) => r.status !== "with_rx")
      .sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0)),
    explained: done.map((r) => toRow(r, budgetFor, now)),
  };
}

export async function getRxPatient(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT v.id AS visit_id, v.patient_id, v.current_status, v.visit_date::text AS visit_date,
            p.name, p.file_no, p.age, p.sex,
            doc.short_name AS doctor_name,
            cons.id AS consultation_id,
            rx.id AS document_id,
            (rx.id IS NOT NULL AND rxchg.last_change > rx.created_at) AS rx_stale,
            ${labOnlyPredicate("v", "$2")} AS lab_only
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
       LEFT JOIN LATERAL (
         SELECT id FROM consultations c
          WHERE c.patient_id = v.patient_id AND c.visit_date = v.visit_date
          ORDER BY id DESC LIMIT 1
       ) cons ON TRUE
       LEFT JOIN LATERAL (
         SELECT d.id, d.created_at FROM documents d
          WHERE d.patient_id = v.patient_id
            AND d.doc_type = 'prescription'
            AND (d.file_url IS NOT NULL OR d.storage_path IS NOT NULL)
            AND d.consultation_id IS NOT DISTINCT FROM cons.id
          ORDER BY d.id DESC LIMIT 1
       ) rx ON TRUE
       LEFT JOIN LATERAL (
         SELECT max(m2.updated_at) AS last_change FROM medications m2
          WHERE m2.consultation_id = cons.id
       ) rxchg ON TRUE
      WHERE v.id = $1`,
    [visitId, LAB_ONLY_DOCTOR],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  const v = rows[0];

  // A samples-only registration never reaches a consultant, so there is no
  // prescription to explain. The queue already excludes them; this closes the
  // hand-typed URL.
  if (v.lab_only) {
    throw Object.assign(new Error("This patient came for samples only — no prescription"), {
      status: 409,
      reason: "lab_only",
    });
  }

  const card = await buildCard(v.patient_id, db);
  const active = card.groups.flatMap((g) => g.medicines);
  const stopped = await stoppedToday(v.patient_id, v.visit_date, db);

  return {
    visitId: v.visit_id,
    patientId: v.patient_id,
    name: v.name,
    fileNo: v.file_no,
    age: v.age,
    sex: v.sex,
    status: v.current_status,
    statusLabel: STATUS_LABEL[v.current_status] || v.current_status,
    doctorName: v.doctor_name,
    consultationId: v.consultation_id,
    canPrint: !!v.document_id && !v.rx_stale,
    rxStale: !!v.rx_stale,
    card,
    stopped,
    counselling: buildCounsellingNote([...active, ...stopped]),
  };
}

export async function startRxExplain(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await advanceStatus(client, {
      visitId,
      toStatus: "with_rx",
      actorRole: "nurse",
      actorId,
      allowSkip: true,
      meta: { source: "rx_station" },
    });
    await client.query("COMMIT");
    return { ok: true, status: "with_rx" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function markRxExplained(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await advanceStatus(client, {
      visitId,
      toStatus: "pharmacy_pending",
      actorRole: "nurse",
      actorId,
      allowSkip: true,
      meta: { source: "rx_station", explained: true },
    });
    await client.query("COMMIT");
    return { ok: true, status: "pharmacy_pending" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
