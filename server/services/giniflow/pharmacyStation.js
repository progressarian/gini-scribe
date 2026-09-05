import pool from "../../config/db.js";
import { advanceStatus, budgetColour } from "./statusEngine.js";
import { getSlaConfig, budgetLookup } from "./board.js";
import { buildCard } from "./medicineCard.js";
import { buildCounsellingNote } from "./counsellingNote.js";
import {
  appointmentFor,
  collectionsFor,
  markCollection,
  COLLECTION_STATUSES,
} from "../medication/collection.js";
import { sendMedicineCard } from "../msg91.js";
import {
  BOARD_COLUMNS,
  STATUS_LABEL,
  compareQueue,
  columnForStatus,
  slaKeyForStatus,
} from "../../../shared/giniflowStatus.js";

// The board's column name, not the raw status — `vitals_done` means the patient
// is with the SD, and printing the status made the lab screen claim otherwise.
const COLUMN_NAME = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, c.name]));

// The visit is over: nobody is coming to the counter for these.
const FINISHED = ["dispensed", "exited", "no_show", "cancelled"];

// The pharmacy — the last station on the floor.
//
// Design: docs/gini-flow/16-PHARMACY-STATION-PLAN.md
//
// Almost all of this already existed. `medicine_collections` is the per-medicine
// dispensing record and is in daily use; `buildCard` is the one medicine card;
// MSG91 is the hospital's WhatsApp. This module is the screen over them plus the
// two things only it can do: end the visit, and refuse to record a patient as
// fully dispensed when something was not handed over.

// "To dispense" is both statuses the board's At-pharmacy column holds. A visit
// finalized by the consultant lands on `pharmacy_pending`; `doctor_done` is the
// half-second before that, and a patient the HealthRay sync moved by hand can
// sit there, so the counter must be able to see and serve them.
const QUEUE_STATUSES = ["doctor_done", "rx_pending", "with_rx", "pharmacy_pending"];
const DONE_STATUSES = ["dispensed", "exited"];

const minutesSince = (from, now) =>
  from ? Math.max(0, Math.round((now.getTime() - new Date(from).getTime()) / 60000)) : null;

const iso = (value) => (value ? new Date(value).toISOString() : null);

const QUEUE_SQL = `
  SELECT v.id, v.current_status, v.visit_date::text AS visit_date, v.card_sent_at, v.category,
         v.priority, v.priority_reason, v.queue_position, v.queue_column,
         v.appointment_time::text AS appointment_time,
         p.id AS patient_id, p.name, p.file_no, p.age, p.sex, p.phone,
         COALESCE(doc.short_name, sd.short_name) AS doctor_name,
         fin.occurred_at  AS finalized_at,
         pend.occurred_at AS pharmacy_since,
         last_ev.occurred_at AS status_since,
         done_ev.occurred_at AS dispensed_at,
         med.names, med.gini, med.external, med.low_stock, med.out_of_stock,
         col.given, col.not_given, col.partial
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
    LEFT JOIN doctors sd  ON sd.id  = v.assigned_sd_id
    -- Finalized at, not checked in at: what this station waits on is the doctor
    -- finishing, and that is the only clock the counter can act on.
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND e.status = 'doctor_done'
       ORDER BY occurred_at DESC LIMIT 1
    ) fin ON TRUE
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND e.status = 'pharmacy_pending'
       ORDER BY occurred_at DESC LIMIT 1
    ) pend ON TRUE
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND e.status = ANY('{dispensed,exited}')
       ORDER BY occurred_at LIMIT 1
    ) done_ev ON TRUE
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id ORDER BY occurred_at DESC, id DESC LIMIT 1
    ) last_ev ON TRUE
    -- The medicine names the pharmacist starts pulling stock from, and how many
    -- of them the inventory knows to be low or out. A medicine with no inventory
    -- row counts as neither: absence means unknown, never "in stock" (14 §7).
    LEFT JOIN LATERAL (
      SELECT array_agg(m.name ORDER BY m.time_of_day NULLS LAST, m.name)
               FILTER (WHERE m.external_doctor IS NULL) AS names,
             count(*) FILTER (WHERE m.external_doctor IS NULL)::int AS gini,
             count(*) FILTER (WHERE m.external_doctor IS NOT NULL)::int AS external,
             count(*) FILTER (WHERE m.external_doctor IS NULL
                                AND i.stock_qty IS NOT NULL AND i.stock_qty = 0)::int
               AS out_of_stock,
             count(*) FILTER (WHERE m.external_doctor IS NULL
                                AND i.stock_qty IS NOT NULL AND i.stock_qty > 0
                                AND i.stock_qty <= COALESCE(i.reorder_level, 0))::int
               AS low_stock
        FROM medications m
        LEFT JOIN pharmacy_inventory i
               ON UPPER(i.medicine_name) = UPPER(COALESCE(m.pharmacy_match, m.name))
       WHERE m.patient_id = v.patient_id AND m.is_active = true
    ) med ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE mc.status = 'given')::int     AS given,
             count(*) FILTER (WHERE mc.status = 'not_given')::int AS not_given,
             count(*) FILTER (WHERE mc.status = 'partial')::int   AS partial
        FROM medicine_collections mc
       WHERE mc.patient_id = v.patient_id AND mc.collected_date = v.visit_date
    ) col ON TRUE
   WHERE v.visit_date = $1::date
     AND v.current_status = ANY($2)
     AND NOT COALESCE(p.is_blocked, FALSE)`;

export async function getPharmacyQueue(visitDate, now = new Date(), db = pool) {
  // Resolved per row, not once: the pharmacy budget can be overridden per
  // category, and this queue holds every category at the same moment.
  const budgetFor = budgetLookup(await getSlaConfig(db));

  const [{ rows: waiting }, { rows: finished }] = await Promise.all([
    db.query(QUEUE_SQL, [visitDate, QUEUE_STATUSES]),
    db.query(QUEUE_SQL, [visitDate, DONE_STATUSES]),
  ]);

  const card = (r) => {
    const names = r.names || [];
    const low = r.low_stock ?? 0;
    const out = r.out_of_stock ?? 0;
    return {
      visitId: r.id,
      patientId: r.patient_id,
      name: r.name,
      fileNo: r.file_no,
      age: r.age,
      sex: r.sex,
      status: r.current_status,
      doctor: r.doctor_name,
      priority: r.priority || "normal",
      priorityReason: r.priority_reason,
      appointmentTime: r.appointment_time,
      // A manual position only counts inside the queue it was set for.
      queuePosition:
        r.queue_column && r.queue_column === columnForStatus(r.current_status)
          ? r.queue_position
          : null,
      finalizedAt: iso(r.finalized_at),
      dispensedAt: iso(r.dispensed_at),
      cardSentAt: iso(r.card_sent_at),
      medicines: names,
      counts: {
        gini: r.gini ?? 0,
        external: r.external ?? 0,
        given: r.given ?? 0,
        notGiven: r.not_given ?? 0,
        partial: r.partial ?? 0,
      },
      // Absent entirely while `pharmacy_inventory` is empty — NOT rendered as
      // "all in stock", which is a claim this system cannot currently make
      // (16 §4.2, review CS-06).
      stock: low || out ? { low, out } : null,
      // Did this counter actually hand anything over?
      //
      // `DONE_STATUSES` holds `exited` as well as `dispensed`, so every visit the
      // HealthRay sync closed counted as dispensed — 72 of them today, all
      // written by `system`, on a day this station dispensed nobody. A visit was
      // worked here only if it reached `dispensed`, or if a medicine carries a
      // collection record.
      dispensedHere:
        r.current_status === "dispensed" ||
        (r.given ?? 0) + (r.not_given ?? 0) + (r.partial ?? 0) > 0,
    };
  };

  const toDispense = waiting
    .map((r) => {
      const since = r.pharmacy_since || r.finalized_at || r.status_since;
      const minutes = minutesSince(since, now);
      const budget = budgetFor(slaKeyForStatus("pharmacy_pending"), r.category);
      return {
        ...card(r),
        since: iso(since),
        waitMinutes: minutes,
        waitBudget: budget,
        waitColour: budgetColour(minutes ?? 0, budget),
        statusMinutes: minutes,
      };
    })
    .sort(compareQueue);

  const dispensed = finished
    .map((r) => ({
      ...card(r),
      since: iso(r.dispensed_at || r.status_since),
      counselled: !!r.card_sent_at,
    }))
    .sort((a, b) => (b.dispensedAt || "").localeCompare(a.dispensedAt || ""));

  return {
    counts: {
      toDispense: toDispense.length,
      // Only what this counter did. The rest are visits HealthRay closed, which
      // is a different fact and gets its own number rather than inflating this one.
      closedElsewhere: dispensed.filter((c) => !c.dispensedHere).length,
      // Of those waiting, how many carry a low or out-of-stock medicine. Reads 0
      // until the inventory has rows — §11 q2, and deliberately not hidden: a
      // count of zero is honest, a missing tile looks like a permissions problem.
      stockWarnings: toDispense.filter((c) => c.stock).length,
      dispensed: dispensed.filter((c) => c.dispensedHere).length,
    },
    toDispense,
    dispensed,
    pendingHandover: await getPendingHandover(visitDate, db),
  };
}

// The counter's real backlog, from the table the hospital actually fills.
//
// `toDispense` queues `doctor_done`/`pharmacy_pending`, which no visit in this
// table's history has ever held — the floor finalizes on HealthRay, so the
// station reads zero on a day 46 patients were prescribed medicines. This is the
// same shape of fallback the lab screen uses: `medications` written today with
// nothing recorded against them in `medicine_collections`.
//
// Read-only and deliberately separate from `toDispense`: these patients have no
// Gini Flow prescription to close, so the counter cannot run the dispense flow
// on them — it can only see who is owed medicines.
async function getPendingHandover(visitDate, db = pool) {
  const { rows } = await db.query(
    `SELECT p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
            v.current_status,
            count(*)::int AS medicines,
            array_agg(m.name ORDER BY m.name) AS names,
            min(m.created_at) AS prescribed_at
       FROM medications m
       JOIN giniflow_visits v ON v.patient_id = m.patient_id AND v.visit_date = $1::date
       JOIN patients p ON p.id = m.patient_id
      WHERE (m.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
        AND m.is_active
        AND m.external_doctor IS NULL
        AND NOT COALESCE(p.is_blocked, FALSE)
        AND NOT EXISTS (
          SELECT 1 FROM medicine_collections c
           WHERE c.medication_id = m.id AND c.collected_date = $1::date
        )
      GROUP BY p.id, p.name, p.file_no, p.age, p.sex, v.current_status
      ORDER BY min(m.created_at)`,
    [visitDate],
  );

  return rows.map((r) => ({
    patientId: r.patient_id,
    name: r.name,
    fileNo: r.file_no,
    age: r.age,
    sex: r.sex,
    medicines: r.medicines,
    names: r.names || [],
    // Where they are, by the board's column rather than the raw status — the
    // same rule the lab screen uses, so the two cannot disagree about a patient.
    station: FINISHED.includes(r.current_status)
      ? STATUS_LABEL[r.current_status] || r.current_status
      : COLUMN_NAME[columnForStatus(r.current_status)] ||
        STATUS_LABEL[r.current_status] ||
        r.current_status,
    gone: FINISHED.includes(r.current_status),
    prescribedAt: iso(r.prescribed_at),
  }));
}

// ── One patient at the counter ──────────────────────────────────────────────

async function loadVisit(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT v.id, v.patient_id, v.visit_date::text AS visit_date, v.current_status,
            v.appointment_id, v.card_sent_at,
            p.name, p.file_no, p.age, p.sex, p.phone,
            COALESCE(doc.short_name, sd.short_name) AS doctor_name,
            fin.occurred_at AS finalized_at
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
       LEFT JOIN doctors sd  ON sd.id  = v.assigned_sd_id
       LEFT JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events e
          WHERE e.visit_id = v.id AND e.status = 'doctor_done'
          ORDER BY occurred_at DESC LIMIT 1
       ) fin ON TRUE
      WHERE v.id = $1`,
    [visitId],
  );
  return rows[0] || null;
}

// Medicines stopped at today's consultation. They are `is_active = false`, so
// the card cannot show them — but "stop taking this one" is the single most
// important sentence at this counter, so the counselling note needs them.
export async function stoppedToday(patientId, visitDate, db) {
  const { rows } = await db.query(
    `SELECT id, name, dose, previous_dose, stop_reason
       FROM medications
      WHERE patient_id = $1 AND is_active = false
        AND change_type = 'stopped' AND stopped_date = $2::date
      ORDER BY name`,
    [patientId, visitDate],
  );
  return rows.map((r) => ({
    medicationId: r.id,
    name: r.name,
    dose: r.dose,
    previousDose: r.previous_dose,
    stopReason: r.stop_reason,
    changeType: "stopped",
  }));
}

// Per medicine, only where the inventory actually knows. Inert until stock data
// exists — which is the whole of §5.2 today.
const stockWarningFor = (medicine) => {
  const stock = medicine.stock;
  if (!stock) return null;
  if (stock.out) {
    const alt = (stock.alternatives || [])[0];
    return {
      medicationId: medicine.medicationId,
      name: medicine.name,
      tone: "out",
      message: alt
        ? `out of stock. ${alt} is available as an equivalent — confirm with the patient.`
        : "out of stock. The doctor has been notified.",
    };
  }
  if (stock.low) {
    return {
      medicationId: medicine.medicationId,
      name: medicine.name,
      tone: "low",
      message: `only ${stock.qty} left. Reorder urgently.`,
    };
  }
  return null;
};

export async function getPharmacyPatient(visitId, db = pool) {
  const visit = await loadVisit(visitId, db);
  if (!visit) return null;

  const [card, collections, stopped] = await Promise.all([
    buildCard(visit.patient_id, db),
    collectionsFor(visit.patient_id, visit.visit_date, db),
    stoppedToday(visit.patient_id, visit.visit_date, db),
  ]);

  const all = card.groups.flatMap((g) => g.medicines);

  const withState = (medicine) => {
    const mark = collections.get(medicine.medicationId) || null;
    return {
      ...medicine,
      collection: mark
        ? {
            status: mark.status,
            reason: mark.reason,
            qtyNote: mark.qty_note,
            markedBy: mark.marked_by,
            markedAt: iso(mark.marked_at),
          }
        : null,
      // External medicines get NO control. They are shown, with the prescriber's
      // name, because the patient takes them — but the Gini pharmacy does not
      // hand them over and must not record that it did (16 §5.3).
      dispensable: !medicine.external,
      warning: stockWarningFor(medicine),
    };
  };

  const groups = card.groups.map((g) => ({ ...g, medicines: g.medicines.map(withState) }));
  const medicines = groups.flatMap((g) => g.medicines);
  const gini = medicines.filter((m) => m.dispensable);

  const given = gini.filter((m) => m.collection?.status === "given").length;
  const notGiven = gini.filter((m) => m.collection?.status === "not_given").length;
  const partial = gini.filter((m) => m.collection?.status === "partial").length;
  const pending = gini.length - given - notGiven - partial;

  return {
    visitId: visit.id,
    patientId: visit.patient_id,
    name: visit.name,
    fileNo: visit.file_no,
    age: visit.age,
    sex: visit.sex,
    phone: visit.phone,
    doctor: visit.doctor_name,
    status: visit.current_status,
    visitDate: visit.visit_date,
    finalizedAt: iso(visit.finalized_at),
    cardSentAt: iso(visit.card_sent_at),
    finished: DONE_STATUSES.includes(visit.current_status),
    counselling: buildCounsellingNote([...all, ...stopped]),
    stopped,
    stockWarnings: medicines.map((m) => m.warning).filter(Boolean),
    card: { groups, counts: card.counts },
    totals: {
      gini: gini.length,
      external: medicines.length - gini.length,
      given,
      notGiven,
      partial,
      pending,
    },
    // Rule 1 (16 §6): anything not handed over turns the blanket button into
    // "Dispense the rest". The screen renders that; the service is what makes it
    // true, by never marking a not-given row as given.
    blockedByNotGiven: notGiven > 0,
  };
}

// ── Marking one medicine ────────────────────────────────────────────────────

export async function dispenseItem(
  visitId,
  medicationId,
  { status = "given", reason = null, qtyNote = null, actorId = null, actorName = null },
  db = pool,
) {
  if (!COLLECTION_STATUSES.includes(status)) {
    throw Object.assign(new Error(`Unknown dispense status: ${status}`), { status: 400 });
  }
  if (status === "not_given" && !String(reason || "").trim()) {
    throw Object.assign(
      new Error("Say why the medicine was not given — the not-collected report is built on it"),
      { status: 400 },
    );
  }

  const visit = await loadVisit(visitId, db);
  if (!visit) throw Object.assign(new Error("Visit not found"), { status: 404 });

  // A closed visit takes no more marks.
  //
  // `dispenseAll` has refused this since it was written; this function never
  // did, so the per-medicine buttons stayed live after "✓ Dispensed · visit
  // closed" and every press still wrote to medicine_collections. The visit was
  // already `exited`, the day's stats were already computed, and the WhatsApp
  // card was already sent — so the write changed the record of what the patient
  // was handed AFTER they had left with it.
  if (DONE_STATUSES.includes(visit.current_status)) {
    throw Object.assign(
      new Error("This visit is closed — the medicine card has already gone to the patient"),
      { status: 409 },
    );
  }

  const { rows } = await db.query(
    `SELECT id, name, external_doctor FROM medications
      WHERE id = $1 AND patient_id = $2 AND is_active = true`,
    [medicationId, visit.patient_id],
  );
  if (!rows.length) {
    throw Object.assign(new Error("That medicine is not on this patient's card"), { status: 404 });
  }
  if (rows[0].external_doctor) {
    throw Object.assign(
      new Error(`${rows[0].name} was prescribed outside Gini — the pharmacy does not dispense it`),
      { status: 409 },
    );
  }

  const appointmentId =
    visit.appointment_id || (await appointmentFor(db, visit.patient_id, visit.visit_date));

  const mark = await markCollection(db, {
    medicationId,
    patientId: visit.patient_id,
    appointmentId,
    date: visit.visit_date,
    status,
    reason: reason || null,
    qtyNote,
    markedBy: actorName || null,
  });

  return {
    medicationId,
    name: rows[0].name,
    status: mark.status,
    reason: mark.reason,
    qtyNote: mark.qty_note,
    markedAt: iso(mark.marked_at),
    actorId,
  };
}

// ── The exit ────────────────────────────────────────────────────────────────
//
// One transaction: every pending Gini medicine marked `given`, then
// pharmacy_pending → dispensed → exited. The WhatsApp send happens AFTER the
// commit and never inside it (16 §6, §10).
//
// A row already marked `not_given` is left exactly as it is. That is what makes
// the not-collected report true: a patient who went home without two of their
// medicines must not be recorded as fully dispensed.

export async function dispenseAll(visitId, { actorId = null, actorName = null } = {}, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows: visitRows } = await client.query(
      `SELECT id, patient_id, visit_date::text AS visit_date, current_status, appointment_id
         FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!visitRows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    const visit = visitRows[0];

    if (DONE_STATUSES.includes(visit.current_status)) {
      throw Object.assign(new Error("This patient has already been dispensed"), { status: 409 });
    }
    if (!QUEUE_STATUSES.includes(visit.current_status)) {
      throw Object.assign(
        new Error("The consultation is not finalized yet — nothing to dispense"),
        { status: 409 },
      );
    }

    const { rows: meds } = await client.query(
      `SELECT m.id, m.name, mc.status
         FROM medications m
         LEFT JOIN medicine_collections mc
           ON mc.medication_id = m.id AND mc.collected_date = $2::date
        WHERE m.patient_id = $1 AND m.is_active = true AND m.external_doctor IS NULL`,
      [visit.patient_id, visit.visit_date],
    );

    const appointmentId =
      visit.appointment_id || (await appointmentFor(client, visit.patient_id, visit.visit_date));

    const pending = meds.filter((m) => !m.status);
    for (const med of pending) {
      await markCollection(client, {
        medicationId: med.id,
        patientId: visit.patient_id,
        appointmentId,
        date: visit.visit_date,
        status: "given",
        markedBy: actorName || null,
      });
    }

    // A patient who was moved here by hand can still be at `doctor_done`. Writing
    // their arrival before their exit keeps the pharmacy budget measuring
    // something real rather than jumping the column.
    if (["doctor_done", "rx_pending", "with_rx"].includes(visit.current_status)) {
      await advanceStatus(client, {
        visitId,
        toStatus: "pharmacy_pending",
        actorRole: "pharmacy",
        actorId,
        meta: { source: "pharmacy_dispense_all" },
      });
    }
    await advanceStatus(client, {
      visitId,
      toStatus: "dispensed",
      actorRole: "pharmacy",
      actorId,
      meta: { source: "pharmacy_dispense_all", medicines: meds.length, marked: pending.length },
    });
    // `exited` ends the visit. The board's Done column is the only place this
    // patient appears again.
    await advanceStatus(client, {
      visitId,
      toStatus: "exited",
      actorRole: "pharmacy",
      actorId,
      meta: { source: "pharmacy_dispense_all" },
    });

    await client.query("COMMIT");

    const notGiven = meds.filter((m) => m.status === "not_given");
    return {
      dispensed: true,
      medicines: meds.length,
      marked: pending.length,
      notGiven: notGiven.map((m) => m.name),
      // The counter handed over what it could; the record says so.
      partial: notGiven.length > 0,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── The medicine card on WhatsApp ───────────────────────────────────────────
//
// After the commit, fired and forgotten from the exit path, and re-sendable by
// hand from the pane. Idempotent: `card_sent_at` is the guard, so the automatic
// send cannot fire twice for one visit, while a pharmacist asked to resend
// passes `force`.
//
// PH-01. `card_sent_at` is stamped ONLY when a message actually left the
// building. MSG91 logs instead of sending whenever the WhatsApp template is
// missing or unapproved (16 §11 q1) — and because that same column is the
// idempotency guard, stamping it on a no-op would permanently mark a patient as
// having received a card they never got, and stop the real send from ever
// reaching them once the template goes live. So the dev/no-op case is returned
// as `sent: false, dev: true` and left unrecorded, which the screen says out
// loud rather than showing a green tick.
//
// PH-03. The stamp follows the send and is not in a transaction with it — it
// cannot be. It errs towards sending twice rather than never: a crash between
// the two leaves `card_sent_at` unset, so the next attempt re-sends. A duplicate
// medicine card is a nuisance; a missing one is a patient with no instructions.

export async function sendCardToPatient(visitId, { force = false } = {}, db = pool) {
  const visit = await loadVisit(visitId, db);
  if (!visit) throw Object.assign(new Error("Visit not found"), { status: 404 });
  if (visit.card_sent_at && !force) {
    return { sent: false, alreadySent: true, sentAt: iso(visit.card_sent_at) };
  }
  if (!visit.phone) {
    throw Object.assign(new Error("This patient has no phone number on file"), { status: 409 });
  }

  const [card, stopped] = await Promise.all([
    buildCard(visit.patient_id, db),
    stoppedToday(visit.patient_id, visit.visit_date, db),
  ]);
  const medicines = card.groups.flatMap((g) => g.medicines);
  const note = buildCounsellingNote([...medicines, ...stopped]);

  const result = await sendMedicineCard(visit.phone, {
    patient_name: visit.name,
    medicine_count: String(card.counts.gini),
    changes: note.english,
    doctor_name: visit.doctor_name || "Gini Health",
  });

  if (result?.dev) {
    return {
      sent: false,
      dev: true,
      phone: visit.phone,
      reason: "The WhatsApp medicine-card template is not live yet — the card was logged, not sent",
    };
  }

  await db.query(`UPDATE giniflow_visits SET card_sent_at = NOW() WHERE id = $1`, [visitId]);
  return { sent: true, phone: visit.phone };
}
