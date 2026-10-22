import pool from "../../config/db.js";
import { IST_TODAY } from "./statusEngine.js";
import { SEEDED_SLOTS } from "./prescription.js";
import { checkVisit } from "./interactions.js";
import { pendingProposalCount, writeMedicines } from "./finalize.js";
import { markMedicationVisitStatus } from "../medication/visitStatus.js";
import { savePrescriptionForVisit, buildVisitPayloadFromDb } from "../prescriptionAutoSave.js";
import { referralsForVisit, generateLetter } from "./referralsStation.js";

const FINALIZED = [
  "doctor_done",
  "rx_pending",
  "with_rx",
  "pharmacy_pending",
  "dispensed",
  "exited",
];
const REMOVED_REASON = "Removed when the visit was edited";
const fail = (status, message) => Object.assign(new Error(message), { status });
const keyOf = (name, match) => String(match || name || "").toUpperCase();

async function lockVisit(client, visitId) {
  const { rows } = await client.query(
    `SELECT v.id, v.patient_id, v.visit_date::text AS visit_date, v.current_status,
            v.appointment_id, v.assigned_doctor_id, v.assigned_sd_id,
            v.editing_by, v.visit_date = ${IST_TODAY} AS is_today,
            (SELECT e.actor_id FROM giniflow_visit_events e
              WHERE e.visit_id = v.id AND e.meta->>'source' = 'consult_finalize'
              ORDER BY e.occurred_at DESC LIMIT 1) AS finalized_by,
            (SELECT (e.meta->>'consultation_id')::int FROM giniflow_visit_events e
              WHERE e.visit_id = v.id AND e.meta ? 'consultation_id'
              ORDER BY e.occurred_at DESC LIMIT 1) AS consultation_id
       FROM giniflow_visits v WHERE v.id = $1 FOR UPDATE OF v`,
    [visitId],
  );
  if (!rows.length) throw fail(404, "Visit not found");
  return rows[0];
}

export function mayEdit(visit, actorId, isAdmin) {
  if (isAdmin) return true;
  if (!actorId) return false;
  return [visit.assigned_doctor_id, visit.assigned_sd_id, visit.finalized_by].some(
    (id) => id != null && Number(id) === Number(actorId),
  );
}

function assertEditable(visit, actorId, isAdmin) {
  if (!FINALIZED.includes(visit.current_status)) {
    throw fail(409, "This consultation is not finalized yet — finish it the normal way");
  }
  if (!visit.is_today) {
    throw fail(409, "Only today's consultations can be edited — correct older ones on the chart");
  }
  if (!visit.consultation_id) {
    throw fail(409, "This visit has no finalized prescription to edit");
  }
  if (!mayEdit(visit, actorId, isAdmin)) {
    throw fail(403, "Only the consultant or Chief who saw this patient can edit it");
  }
}

async function inTransaction(db, work) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function openEdit(visitId, { actorId = null, isAdmin = false } = {}, db = pool) {
  return inTransaction(db, async (client) => {
    const visit = await lockVisit(client, visitId);
    assertEditable(visit, actorId, isAdmin);
    if (visit.editing_by != null) {
      if (Number(visit.editing_by) === Number(actorId) || isAdmin) return { editing: true };
      throw fail(409, "Someone else is already editing this consultation");
    }
    await client.query(`DELETE FROM giniflow_rx_items WHERE visit_id = $1`, [visitId]);
    const { rows } = await client.query(
      `INSERT INTO giniflow_rx_items
           (visit_id, source_medication_id, medicine_name, pharmacy_match, composition, dose,
            previous_dose, frequency, timing, timing_category, timing_categories, time_of_day,
            route, form, drug_class, reason, patient_instruction, change_type, stop_reason,
            sort_order)
         SELECT $1, m.id, m.name, m.pharmacy_match, m.composition, m.dose,
                m.previous_dose, m.frequency, m.timing, m.timing_category, ${SEEDED_SLOTS},
                m.time_of_day, m.route, m.form, m.drug_class, m.clinical_note, m.instructions,
                CASE WHEN NOT m.is_active THEN 'stopped'
                     WHEN m.change_type IN ('new', 'changed', 'continued', 'paused')
                       THEN m.change_type
                     ELSE 'continued' END,
                CASE WHEN NOT m.is_active THEN m.stop_reason END,
                row_number() OVER (ORDER BY m.is_active DESC, m.med_group NULLS LAST, m.name)
           FROM medications m
          WHERE m.patient_id = $2 AND m.consultation_id = $3
            AND (m.is_active OR (m.change_type = 'stopped' AND m.stop_reason IS DISTINCT FROM $4))
         RETURNING id`,
      [visitId, visit.patient_id, visit.consultation_id, REMOVED_REASON],
    );
    await client.query(
      `UPDATE giniflow_visits SET editing_by = $2, editing_since = NOW() WHERE id = $1`,
      [visitId, actorId],
    );
    return { editing: true, medicines: rows.length };
  });
}

export async function cancelEdit(visitId, { actorId = null, isAdmin = false } = {}, db = pool) {
  return inTransaction(db, async (client) => {
    const visit = await lockVisit(client, visitId);
    if (visit.editing_by == null) return { editing: false };
    if (!isAdmin && !mayEdit(visit, actorId, isAdmin)) {
      throw fail(403, "Only the consultant or Chief who saw this patient can cancel this edit");
    }
    await client.query(`DELETE FROM giniflow_rx_items WHERE visit_id = $1`, [visitId]);
    await client.query(
      `UPDATE giniflow_visits SET editing_by = NULL, editing_since = NULL WHERE id = $1`,
      [visitId],
    );
    return { editing: false };
  });
}

const describe = (m) => [m.dose, m.frequency, m.timing].filter(Boolean).join(" · ");

async function medicinesOf(client, patientId, consultationId) {
  const { rows } = await client.query(
    `SELECT id, name, pharmacy_match, dose, frequency, timing, is_active, change_type
       FROM medications WHERE patient_id = $1 AND consultation_id = $2`,
    [patientId, consultationId],
  );
  return rows;
}

function summarise(before, after) {
  const onList = (rows) =>
    new Map(
      rows
        .filter((m) => m.is_active && m.change_type !== "paused")
        .map((m) => [keyOf(m.name, m.pharmacy_match), m]),
    );
  const was = onList(before);
  const now = onList(after);
  const added = [...now.keys()].filter((k) => !was.has(k)).map((k) => now.get(k).name);
  const removed = [...was.keys()].filter((k) => !now.has(k)).map((k) => was.get(k).name);
  const changed = [...now.keys()]
    .filter((k) => was.has(k) && describe(was.get(k)) !== describe(now.get(k)))
    .map((k) => now.get(k).name);
  return { added, removed, changed };
}

export async function saveEdit(
  visitId,
  { actorId = null, isAdmin = false, reason = "", requireNextVisit = false } = {},
  db = pool,
) {
  const note = String(reason || "").trim();
  let visit;
  let summary;
  await inTransaction(db, async (client) => {
    visit = await lockVisit(client, visitId);
    if (visit.editing_by == null) {
      throw fail(409, "This consultation is not open for editing — press Edit prescription first");
    }
    assertEditable(visit, actorId, isAdmin);

    if (requireNextVisit) {
      const { rows: plan } = await client.query(
        `SELECT next_visit_date FROM giniflow_care_plans WHERE visit_id = $1`,
        [visitId],
      );
      if (!plan[0]?.next_visit_date) {
        throw fail(409, "Set the next visit in the Care plan before saving the changes");
      }
    }

    const pending = await pendingProposalCount(visitId, client);
    if (pending) {
      throw Object.assign(
        fail(
          409,
          `${pending} proposal${pending === 1 ? "" : "s"} still to review — decide each one first`,
        ),
        { pendingProposals: pending },
      );
    }
    const interactions = await checkVisit(visitId, client);
    if (interactions.blocking.length) {
      const first = interactions.blocking[0];
      throw Object.assign(
        fail(
          409,
          `${first.medicines.join(" + ")} — ${first.note} Say why this is intended, or change the prescription.`,
        ),
        { blockingInteractions: interactions.blocking },
      );
    }

    const before = await medicinesOf(client, visit.patient_id, visit.consultation_id);
    const { rows: items } = await client.query(
      `SELECT * FROM giniflow_rx_items WHERE visit_id = $1 ORDER BY sort_order, created_at`,
      [visitId],
    );
    await writeMedicines(client, {
      patientId: visit.patient_id,
      consultationId: visit.consultation_id,
      visitDate: visit.visit_date,
      items,
    });

    const kept = items
      .filter((i) => i.change_type !== "stopped")
      .map((i) => keyOf(i.medicine_name, i.pharmacy_match));
    const dropped = before
      .filter((m) => m.is_active && !kept.includes(keyOf(m.name, m.pharmacy_match)))
      .map((m) => m.id);
    if (dropped.length) {
      await client.query(
        `DELETE FROM medications old
          USING medications cur
          WHERE cur.id = ANY($2::int[]) AND old.patient_id = $1 AND old.is_active = false
            AND UPPER(COALESCE(old.pharmacy_match, old.name))
                = UPPER(COALESCE(cur.pharmacy_match, cur.name))`,
        [visit.patient_id, dropped],
      );
      await client.query(
        `UPDATE medications
            SET is_active = false, stopped_date = $2::date, stop_reason = $3,
                change_type = 'stopped', updated_at = NOW()
          WHERE id = ANY($1::int[]) AND is_active = true`,
        [dropped, visit.visit_date, REMOVED_REASON],
      );
    }

    const after = await medicinesOf(client, visit.patient_id, visit.consultation_id);
    summary = summarise(before, after);
    const entry = { at: new Date().toISOString(), by: actorId, reason: note || null, ...summary };
    await client.query(`DELETE FROM giniflow_rx_items WHERE visit_id = $1`, [visitId]);
    await client.query(
      `UPDATE giniflow_visits
          SET editing_by = NULL, editing_since = NULL,
              amended_at = NOW(), amended_by = $2,
              amendments = amendments || $3::jsonb
        WHERE id = $1`,
      [visitId, actorId, JSON.stringify([entry])],
    );
  });

  markMedicationVisitStatus(visit.patient_id).catch(() => {});
  referralsForVisit(visitId)
    .then((referrals) =>
      Promise.all(
        referrals
          .filter((r) => !r.letterUrl)
          .map((r) =>
            generateLetter(r.id).catch((e) =>
              console.warn("[giniflow consult edit] referral letter failed:", r.id, e?.message),
            ),
          ),
      ),
    )
    .catch((e) => console.warn("[giniflow consult edit] referral letters failed:", e?.message));
  buildVisitPayloadFromDb(visit.patient_id, { appointmentId: visit.appointment_id })
    .then((payload) =>
      payload
        ? savePrescriptionForVisit(visit.patient_id, payload, {
            appointmentId: visit.appointment_id,
            consultationId: visit.consultation_id,
            source: "visit",
            overwrite: true,
          })
        : null,
    )
    .catch((e) => console.warn("[giniflow consult edit] Rx re-issue failed:", e?.message));

  return { saved: true, consultationId: visit.consultation_id, ...summary };
}

export async function editingVisitOf(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT (to_jsonb(v)->>'editing_by')::int AS editing_by FROM giniflow_visits v WHERE v.id = $1`,
    [visitId],
  );
  return rows[0]?.editing_by ?? null;
}

export async function editingRowOf(itemId, db = pool) {
  const { rows } = await db.query(
    `SELECT (to_jsonb(v)->>'editing_by')::int AS editing_by
       FROM giniflow_rx_items r JOIN giniflow_visits v ON v.id = r.visit_id
      WHERE r.id = $1`,
    [itemId],
  );
  return rows.length ? (rows[0].editing_by ?? null) : undefined;
}

export async function editState(visitId, { actorId = null, isAdmin = false } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT v.current_status, v.assigned_doctor_id, v.assigned_sd_id,
            v.visit_date = ${IST_TODAY} AS is_today,
            (to_jsonb(v)->>'editing_by')::int AS editing_by,
            to_jsonb(v)->>'editing_since' AS editing_since,
            to_jsonb(v)->>'amended_at' AS amended_at,
            (SELECT COALESCE(d.short_name, d.name) FROM doctors d
              WHERE d.id = (to_jsonb(v)->>'editing_by')::int) AS editing_name,
            (SELECT e.actor_id FROM giniflow_visit_events e
              WHERE e.visit_id = v.id AND e.meta->>'source' = 'consult_finalize'
              ORDER BY e.occurred_at DESC LIMIT 1) AS finalized_by
       FROM giniflow_visits v WHERE v.id = $1`,
    [visitId],
  );
  const v = rows[0];
  if (!v) return null;
  const editing = v.editing_by
    ? { by: v.editing_by, name: v.editing_name, since: v.editing_since }
    : null;
  return {
    finalized: FINALIZED.includes(v.current_status),
    isToday: !!v.is_today,
    editing,
    editingMine: !!editing && (isAdmin || Number(editing.by) === Number(actorId)),
    canEdit:
      FINALIZED.includes(v.current_status) &&
      !!v.is_today &&
      !editing &&
      mayEdit(v, actorId, isAdmin),
    amendedAt: v.amended_at || null,
  };
}
