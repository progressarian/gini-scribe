import pool from "../../config/db.js";
import {
  STATUS_LABEL,
  chainIndex,
  isChainStatus,
  isExceptionStatus,
} from "../../../shared/giniflowStatus.js";
import { advanceStatus, IST_TODAY } from "./statusEngine.js";
import { searchDayVisits } from "./board.js";
import { blockDetail } from "../patientBlockView.js";
import { createWalkinBooking } from "../walkinBooking.js";

// Reception: the payment desk between the MO ordering tests and the lab
// collecting a sample.
//
// The gate this screen exists to enforce (brief §2.2): the lab may not collect
// a sample until the order is paid or an insurance claim is approved. Reception
// is what moves an order across that line, so every action here is logged to
// giniflow_lab_order_events — a payment dispute a week later is answered from
// that log, not from a status column that only shows the present.

const ORDER_SELECT = `
  SELECT o.id, o.visit_id, o.urgency, o.payment_status, o.sample_status,
         o.amount_total, o.created_at, o.updated_at,
         p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
         d.short_name AS ordered_by,
         paid_ev.occurred_at AS paid_at,
         COALESCE(t.tests, '[]'::json) AS tests
    FROM giniflow_lab_orders o
    JOIN giniflow_visits v ON v.id = o.visit_id
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors d ON d.id = o.ordered_by
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('name', lt.test_name, 'price', lt.price)
                      ORDER BY lt.test_name) AS tests
        FROM giniflow_lab_order_tests lt WHERE lt.lab_order_id = o.id
    ) t ON TRUE
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_lab_order_events e
       WHERE e.lab_order_id = o.id AND e.track = 'payment'
         AND e.status IN ('paid', 'insurance_claim')
       ORDER BY occurred_at DESC LIMIT 1
    ) paid_ev ON TRUE
   WHERE v.visit_date = $1::date
     AND NOT COALESCE(p.is_blocked, FALSE)
     -- Brief §2.3 trigger 2: only tests ordered FOR TODAY reach reception. A test
     -- ordered today for the next visit is not money to collect today, and
     -- showing it would have reception chasing payment for a sample nobody is
     -- taking.
     AND o.urgency = 'today'
     -- A patient who never arrived or has gone home is not at the counter.
     AND v.current_status NOT IN ('no_show', 'cancelled')`;

const shape = (r) => ({
  orderId: r.id,
  visitId: r.visit_id,
  patientId: r.patient_id,
  name: r.name,
  fileNo: r.file_no,
  age: r.age,
  sex: r.sex,
  orderedBy: r.ordered_by,
  urgency: r.urgency,
  paymentStatus: r.payment_status,
  sampleStatus: r.sample_status,
  tests: r.tests || [],
  // The amount the order itself recorded — what the patient was quoted. Falls
  // back to summing the lines for orders created before amount_total was written.
  total: Number(r.amount_total) || (r.tests || []).reduce((s, t) => s + Number(t.price || 0), 0),
  orderedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
});

export async function getPaymentQueue(visitDate, db = pool) {
  const { rows } = await db.query(`${ORDER_SELECT} ORDER BY o.created_at`, [visitDate]);
  const orders = rows.map(shape);

  // A submitted claim still needs someone to chase the approval, so it stays on
  // reception's list rather than disappearing into "cleared".
  const pending = orders.filter((o) => ["pending", "insurance_claim"].includes(o.paymentStatus));
  // Paid, but the lab has not taken the sample yet — reception's own "did my
  // clearing actually reach the lab" check.
  const awaitingSample = orders.filter(
    (o) =>
      o.paymentStatus !== "pending" &&
      ["ordered", "payment_pending", "paid"].includes(o.sampleStatus),
  );
  const cleared = orders.filter(
    (o) => o.paymentStatus !== "pending" && !awaitingSample.includes(o),
  );

  // Whether reception is looking at real prices or the mockup's. Drives the
  // warning on the screen, which then disappears on its own.
  const { rows: placeholder } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM giniflow_test_catalog
        WHERE is_active AND source = 'prototype_placeholder'
     ) AS placeholder`,
  );

  return {
    pending,
    awaitingSample,
    cleared,
    pricesArePlaceholders: placeholder[0].placeholder,
  };
}

// Clearing an order is what lets the lab collect. One transaction: the status,
// and the event that records who cleared it and how.
// `insurance_claim` records that a claim was SUBMITTED — it does not open the
// lab gate. `claim_approved` does. Brief §2.2: "Lab cannot collect a sample until
// paid (or claim approved)."
export const SETTLED_METHODS = ["paid", "insurance_claim", "claim_approved"];

// What counts as cleared for the lab.
export const opensLabGate = (paymentStatus) => ["paid", "claim_approved"].includes(paymentStatus);

export async function clearPayment(orderId, { method = "paid", actorId = null }, db = pool) {
  if (!SETTLED_METHODS.includes(method)) {
    throw Object.assign(
      new Error("Payment must be settled as paid, insurance_claim or claim_approved"),
      { status: 400 },
    );
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT payment_status, sample_status FROM giniflow_lab_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });

    // A double-tap at a busy counter must not read later as paying twice. But a
    // submitted claim CAN legitimately move on to approved, so that one is not a
    // repeat.
    const current = rows[0].payment_status;
    const isApprovingAClaim = current === "insurance_claim" && method === "claim_approved";
    if (current !== "pending" && !isApprovingAClaim) {
      await client.query("COMMIT");
      return { orderId, paymentStatus: current, alreadySettled: true };
    }

    await client.query(
      `UPDATE giniflow_lab_orders
          SET payment_status = $2,
              -- Only an approved settlement opens the sample task.
              sample_status = CASE
                WHEN $2 IN ('paid', 'claim_approved')
                 AND sample_status IN ('ordered', 'payment_pending') THEN 'paid'
                ELSE sample_status END,
              updated_at = NOW()
        WHERE id = $1`,
      [orderId, method],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
       VALUES ($1, 'payment', $2, 'reception', $3)`,
      [orderId, method, actorId],
    );
    // The lab's queue reads sample_status, so the sample task appearing there is
    // the same write — trigger 3 in the brief, not a second job that can fail.
    // A submitted-but-unapproved claim writes no sample event: there is nothing
    // for the lab to do yet.
    if (opensLabGate(method)) {
      await client.query(
        `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
         VALUES ($1, 'sample', 'paid', 'reception', $2)`,
        [orderId, actorId],
      );
    }

    await client.query("COMMIT");
    return { orderId, paymentStatus: method, alreadySettled: false };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function getTestCatalog(db = pool) {
  const { rows } = await db.query(
    `SELECT test_name, price, source FROM giniflow_test_catalog
      WHERE is_active ORDER BY test_name`,
  );
  return rows.map((r) => ({ name: r.test_name, price: Number(r.price), source: r.source }));
}

// ── Arrivals — the front door ────────────────────────────────────────────────
// The other half of brief §4.2. HealthRay reports `checkedin` and the sync
// carries it, so this is not the main way a patient reaches the floor — it is
// the way they reach it when HealthRay cannot say so: a walk-in with no slot, a
// sync that is lagging or whose auth has died, a no-show nobody can clear.
//
// Every write here goes through `advanceStatus`, so a manual arrival is one
// append-only event with `actor_role = 'reception'` and is indistinguishable in
// the log from any other step. Nothing writes `current_status` directly.
//
// The sync cannot undo this: `appointmentSync` skips any visit already at or
// past the status HealthRay reports, so a patient checked in here whom HealthRay
// still calls `scheduled` is left alone.

const EXPECTED_STATUSES = ["booked", "confirmed"];
const NOT_COMING_STATUSES = ["no_show", "cancelled"];

// Marking someone absent is only truthful while the desk is the last thing that
// happened to them. Once a station has seen the patient, the building itself has
// contradicted the claim — so the exception is refused there rather than
// recorded as a fact the timeline knows to be false.
const ABSENTABLE_STATUSES = [...EXPECTED_STATUSES, "checked_in"];

const ARRIVAL_SELECT = `
  SELECT v.id, v.patient_id, v.current_status, v.appointment_time::text AS appointment_time,
         v.priority, v.blocked_reason,
         (v.visit_date + COALESCE(v.appointment_time, '00:00'::time))
           AT TIME ZONE 'Asia/Kolkata' AS slot_at,
         p.name, p.file_no, p.age, p.sex, p.phone,
         checkin_ev.occurred_at AS checked_in_at,
         last_ev.occurred_at    AS status_since
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND e.status = 'checked_in'
       ORDER BY occurred_at LIMIT 1
    ) checkin_ev ON TRUE
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id ORDER BY occurred_at DESC, id DESC LIMIT 1
    ) last_ev ON TRUE
   WHERE v.visit_date = $1::date
     AND NOT COALESCE(p.is_blocked, FALSE)
   ORDER BY v.appointment_time NULLS LAST, p.name`;

const minutesBetween = (from, now) =>
  from ? Math.round((now.getTime() - new Date(from).getTime()) / 60000) : null;

const shapeArrival = (r, now) => ({
  visitId: r.id,
  patientId: r.patient_id,
  name: r.name,
  fileNo: r.file_no,
  age: r.age,
  sex: r.sex,
  phone: r.phone,
  priority: r.priority || "normal",
  status: r.current_status,
  statusLabel: STATUS_LABEL[r.current_status] || r.current_status,
  slot: (r.appointment_time || "").slice(0, 5) || null,
  // Positive means past their slot. The desk phones the patient 40 minutes late,
  // not the one whose appointment is an hour away, so the sign matters.
  minutesLate: r.appointment_time ? minutesBetween(r.slot_at, now) : null,
  checkedInAt: r.checked_in_at ? new Date(r.checked_in_at).toISOString() : null,
  statusSince: r.status_since ? new Date(r.status_since).toISOString() : null,
  sinceMinutes: minutesBetween(r.status_since, now),
  blockedReason: r.blocked_reason || null,
});

export async function getArrivals(visitDate, q = "", now = new Date(), db = pool) {
  const { rows } = await db.query(ARRIVAL_SELECT, [visitDate]);

  // Server-side, and the board's own search rather than a second implementation:
  // it already normalises phone numbers the way the rest of the repo does, and a
  // receptionist works from the person in front of them, not by scanning 80 rows.
  let visible = rows;
  const query = String(q || "").trim();
  if (query.length >= 2) {
    const hits = new Set((await searchDayVisits(visitDate, query, db)).map((r) => r.visitId));
    visible = rows.filter((r) => hits.has(r.id));
  }

  const arrivals = visible.map((r) => shapeArrival(r, now));

  return {
    expected: arrivals.filter((a) => EXPECTED_STATUSES.includes(a.status)),
    onFloor: arrivals.filter(
      (a) => !EXPECTED_STATUSES.includes(a.status) && !NOT_COMING_STATUSES.includes(a.status),
    ),
    notComing: arrivals.filter((a) => NOT_COMING_STATUSES.includes(a.status)),
    // The unfiltered day, so a search does not make the tab's own count move.
    counts: rows.reduce(
      (acc, r) => {
        const key = EXPECTED_STATUSES.includes(r.current_status)
          ? "expected"
          : NOT_COMING_STATUSES.includes(r.current_status)
            ? "notComing"
            : "onFloor";
        acc[key]++;
        return acc;
      },
      { expected: 0, onFloor: 0, notComing: 0 },
    ),
    query,
  };
}

// One transaction, one event. Every one of these returns `{ visitId, status,
// unchanged }` so a double-tap at a busy counter reads the same as a first tap.
async function transition(visitId, toStatus, { actorId, meta = {}, guard }, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT current_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });

    const from = rows[0].current_status;
    const refusal = guard?.(from);
    if (refusal) throw Object.assign(new Error(refusal), { status: 409 });
    if (from === toStatus) {
      await client.query("COMMIT");
      return { visitId, status: from, unchanged: true };
    }

    await advanceStatus(client, {
      visitId,
      toStatus,
      actorRole: "reception",
      actorId,
      meta,
    });
    await client.query("COMMIT");
    return { visitId, status: toStatus, unchanged: false };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export function markArrived(visitId, actorId = null, db = pool) {
  return transition(
    visitId,
    "checked_in",
    {
      actorId,
      guard: (from) =>
        isChainStatus(from) && chainIndex(from) > chainIndex("checked_in")
          ? `${STATUS_LABEL[from] || from} — this patient is already past reception`
          : null,
    },
    db,
  );
}

export function markNoShow(visitId, actorId = null, db = pool) {
  return transition(
    visitId,
    "no_show",
    {
      actorId,
      guard: (from) =>
        ABSENTABLE_STATUSES.includes(from)
          ? null
          : `${STATUS_LABEL[from] || from} — this patient is already on the floor`,
    },
    db,
  );
}

export async function markCancelled(visitId, reason, actorId = null, db = pool) {
  // An action another station will see has to say why — the same rule blocking a
  // visit has (GF-18) and stopping a medicine has.
  const note = String(reason || "").trim();
  if (!note) throw Object.assign(new Error("Cancelling needs a reason"), { status: 400 });
  return transition(
    visitId,
    "cancelled",
    {
      actorId,
      meta: { reason: note },
      guard: (from) =>
        ABSENTABLE_STATUSES.includes(from)
          ? null
          : `${STATUS_LABEL[from] || from} — this patient is already on the floor`,
    },
    db,
  );
}

// Undo is a normal forward transition, not an edit: `booked` is where the day
// started, and pressing Arrived from there is the ordinary path. A no-show who
// turns up is re-checked-in, not un-no-showed.
export function undoArrival(visitId, actorId = null, db = pool) {
  return transition(
    visitId,
    "booked",
    {
      actorId,
      guard: (from) =>
        isExceptionStatus(from) ? null : `${STATUS_LABEL[from] || from} — there is nothing to undo`,
    },
    db,
  );
}

// Who the desk can put on the floor. Scoped to a search, capped, and it reports
// a blocked patient rather than hiding them: reception needs to know the person
// in front of them is blocked, and §5.4 says show that instead of an Arrived
// button. The block reason itself is redacted for the role by blockDetail.
export async function searchWalkInPatients(visitDate, q, role, db = pool) {
  const raw = String(q || "").trim();
  if (raw.length < 2) return [];

  const digits = raw.replace(/\D/g, "");
  const { rows } = await db.query(
    `SELECT p.id, p.is_blocked, p.blocked_reason_code, p.name, p.file_no, p.age, p.sex, p.phone,
            v.id AS visit_id, v.current_status,
            a.id AS appointment_id
       FROM patients p
       LEFT JOIN giniflow_visits v ON v.patient_id = p.id AND v.visit_date = $1::date
       LEFT JOIN LATERAL (
         SELECT id FROM appointments
          WHERE patient_id = p.id AND appointment_date = $1::date
          ORDER BY id DESC LIMIT 1
       ) a ON TRUE
      WHERE p.name ILIKE $2
         OR p.file_no ILIKE $2
         OR ($3::text IS NOT NULL AND regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g') LIKE $3)
         OR (
           $3::text IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM unnest(COALESCE(p.alt_phone, ARRAY[]::text[])) AS alt
              WHERE regexp_replace(alt, '\\D', '', 'g') LIKE $3
           )
         )
      ORDER BY p.name
      LIMIT 20`,
    [visitDate, `%${raw}%`, digits ? `%${digits}%` : null],
  );

  return rows.map((r) => ({
    patientId: r.id,
    name: r.name,
    fileNo: r.file_no,
    age: r.age,
    sex: r.sex,
    phone: r.phone,
    appointmentId: r.appointment_id,
    visitId: r.visit_id,
    status: r.current_status,
    statusLabel: r.current_status ? STATUS_LABEL[r.current_status] || r.current_status : null,
    isBlocked: !!r.is_blocked,
    block: r.is_blocked ? blockDetail(r, role) : null,
  }));
}

// A walk-in in one action: the booking record the hospital already keeps, the
// visit, and the arrival.
//
// It goes through createWalkinBooking rather than inserting a visit directly, so
// the blocklist decides first. A giniflow_visits row must never exist for a
// patient the blocklist refuses — that is the whole point of the list.
export async function checkInWalkIn(
  { patientId, appointmentId = null, visitDate = null, force = false, role = null, actor = null },
  actorId = null,
  db = pool,
) {
  const { rows: patientRows } = await db.query(
    `SELECT p.id, p.name, p.file_no, p.phone,
            (SELECT MAX(visit_date)::text FROM consultations c WHERE c.patient_id = p.id) AS last_visit
       FROM patients p WHERE p.id = $1`,
    [patientId],
  );
  const patient = patientRows[0];
  if (!patient) throw Object.assign(new Error("Patient not found"), { status: 404 });

  // `visitDate` exists so the smoke suite can put a walk-in on a day of its own.
  // Today belongs to real patients; a test that checks one in there collides
  // with them and leaves a person on the live board.
  const day = visitDate || (await db.query(`SELECT ${IST_TODAY}::text AS d`)).rows[0].d;
  const slot = new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });

  const { blocked, booking } = await createWalkinBooking(
    {
      patient_id: patient.id,
      walkin_date: day,
      time_slot: slot,
      file_no: patient.file_no,
      patient_name: patient.name,
      contact_number: patient.phone,
      visit_type: patient.last_visit ? "Follow-up" : "New",
      agent_name: actor?.name || null,
      reason_for_booking: "Walk-in checked in at reception",
      last_visit_date: patient.last_visit,
    },
    { force, role, actor },
    db,
  );
  if (blocked) throw Object.assign(new Error("Patient is blocked"), { status: 409, blocked });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // One visit per patient per day is a database constraint, so this upserts
    // rather than inserts: a patient HealthRay already placed on the day keeps
    // their existing visit and simply gets checked in.
    const { rows } = await client.query(
      `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, current_status)
       VALUES ($1, $2::date, $3, 'booked')
       ON CONFLICT (patient_id, visit_date) DO UPDATE
         SET appointment_id = COALESCE(giniflow_visits.appointment_id, EXCLUDED.appointment_id),
             updated_at = NOW()
       RETURNING id, current_status`,
      [patient.id, day, appointmentId],
    );
    const { id: visitId, current_status: from } = rows[0];

    const alreadyThere =
      from === "checked_in" || (isChainStatus(from) && chainIndex(from) > chainIndex("checked_in"));
    if (!alreadyThere) {
      await advanceStatus(client, {
        visitId,
        toStatus: "checked_in",
        actorRole: "reception",
        actorId,
        meta: { walkIn: true, walkinBookingId: booking?.id ?? null },
      });
    }
    await client.query("COMMIT");
    return {
      visitId,
      patientId: patient.id,
      name: patient.name,
      status: alreadyThere ? from : "checked_in",
      unchanged: alreadyThere,
      walkinBookingId: booking?.id ?? null,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
