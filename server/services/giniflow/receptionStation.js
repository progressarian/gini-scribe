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
import {
  CLAIM_STATE,
  collectiblePaise,
  derivePaymentStatus,
  opensLabGate,
  outstandingPaise,
  paise,
  rupeesFromPaise,
} from "../../../shared/labPayment.js";

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
         o.amount_total, o.amount_paid, o.amount_claimed, o.created_at, o.updated_at,
         o.insurer, o.policy_no, o.claim_no, o.claim_state, o.claim_note, o.version,
         p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
         d.short_name AS ordered_by,
         claim_ev.actor_id AS claim_submitted_by,
         COALESCE(cs.short_name, cs.name) AS claim_submitted_by_name,
         COALESCE(ca.short_name, ca.name) AS claim_approved_by_name,
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
         AND e.status IN ('paid', 'part_paid', 'insurance_claim', 'claim_approved')
       ORDER BY occurred_at DESC LIMIT 1
    ) paid_ev ON TRUE
    LEFT JOIN LATERAL (
      SELECT actor_id FROM giniflow_lab_order_events e
       WHERE e.lab_order_id = o.id AND e.track = 'payment' AND e.status = 'insurance_claim'
       ORDER BY occurred_at DESC LIMIT 1
    ) claim_ev ON TRUE
    LEFT JOIN doctors cs ON cs.id = claim_ev.actor_id
    LEFT JOIN doctors ca ON ca.id = o.claim_approved_by
   WHERE v.visit_date = $1::date
     AND NOT COALESCE(p.is_blocked, FALSE)
     -- Brief §2.3 trigger 2: only tests ordered FOR TODAY reach reception. A test
     -- ordered today for the next visit is not money to collect today, and
     -- showing it would have reception chasing payment for a sample nobody is
     -- taking.
     AND o.urgency = 'today'
     -- A patient who never arrived or has gone home is not at the counter.
     AND v.current_status NOT IN ('no_show', 'cancelled')`;

// An order written before amount_total existed carries the price only on its
// test lines. The card falls back to their sum, so the money maths has to use
// the same figure — reading the raw column there would call such an order
// settled while the card still shows what it is worth.
const totalOf = (r) =>
  Number(r.amount_total) || (r.tests || []).reduce((s, t) => s + Number(t.price || 0), 0);

const moneyOf = (r) => ({
  amountTotal: totalOf(r),
  amountPaid: r.amount_paid,
  amountClaimed: r.amount_claimed,
  claimState: r.claim_state,
});

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
  insurer: r.insurer,
  policyNo: r.policy_no,
  claimNo: r.claim_no,
  claimState: r.claim_state,
  claimNote: r.claim_note,
  version: r.version,
  claimSubmittedBy: r.claim_submitted_by,
  claimSubmittedByName: r.claim_submitted_by_name,
  claimApprovedByName: r.claim_approved_by_name,
  tests: r.tests || [],
  // The amount the order itself recorded — what the patient was quoted. Falls
  // back to summing the lines for orders created before amount_total was written.
  total: totalOf(r),
  paid: Number(r.amount_paid),
  claimed: Number(r.amount_claimed),
  // Two different numbers the desk needs: what the order still owes, and what
  // of it can be taken in cash rather than being with an insurer.
  outstanding: rupeesFromPaise(outstandingPaise(moneyOf(r))),
  collectible: rupeesFromPaise(collectiblePaise(moneyOf(r))),
  orderedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
});

export async function getPaymentQueue(visitDate, db = pool) {
  const { rows } = await db.query(`${ORDER_SELECT} ORDER BY o.created_at`, [visitDate]);
  const orders = rows.map(shape);

  // Anything not settled is still reception's work: an untouched order, one
  // part paid, and a submitted claim somebody has to chase the approval for.
  const pending = orders.filter((o) => !opensLabGate(o.paymentStatus));
  // Paid, but the lab has not taken the sample yet — reception's own "did my
  // clearing actually reach the lab" check.
  const awaitingSample = orders.filter(
    (o) =>
      opensLabGate(o.paymentStatus) &&
      ["ordered", "payment_pending", "paid"].includes(o.sampleStatus),
  );
  const cleared = orders.filter(
    (o) => opensLabGate(o.paymentStatus) && !awaitingSample.includes(o),
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

// Clearing an order is what lets the lab collect. One transaction: the money,
// the derived status, and the event that records who did it and how.
//
// An order can be settled two ways at once — a policy that covers ₹900 of a
// ₹1,250 order leaves ₹350 for the patient. So these are the actions on the
// money, not the states of it: the state is derived in shared/labPayment.js from
// what has actually been collected and what the insurer has actually approved.
//
// `insurance_claim` records that a claim was SUBMITTED — a promise settles
// nothing and does not open the lab gate. `claim_approved` does.
// Brief §2.2: "Lab cannot collect a sample until paid (or claim approved)."
export const PAYMENT_METHODS = [
  "paid",
  "insurance_claim",
  "split",
  "claim_approved",
  "claim_rejected",
];

export { opensLabGate };

const trimmed = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// An amount the desk typed. Absent means "whatever is still outstanding", which
// is what makes the one-tap full payment a single button with no form.
const amountPaise = (value, fallbackPaise, label) => {
  if (value === null || value === undefined || value === "") return fallbackPaise;
  const n = Number(value);
  if (!Number.isFinite(n)) throw bad(`${label} must be an amount`);
  const p = paise(n);
  if (p <= 0) throw bad(`${label} must be more than zero`);
  return p;
};

export async function clearPayment(
  orderId,
  {
    method = "paid",
    actorId = null,
    actorRole = "reception",
    amountPaid = null,
    amountClaimed = null,
    insurer = null,
    policyNo = null,
    claimNo = null,
    note = null,
    version = null,
  },
  db = pool,
) {
  if (!PAYMENT_METHODS.includes(method)) {
    throw bad(`Payment must be settled as one of: ${PAYMENT_METHODS.join(", ")}`);
  }
  // A claim nobody can chase is not a claim. The insurer is the minimum: it is
  // who the desk has to ring when the approval does not come.
  const claiming = method === "insurance_claim" || method === "split";
  if (claiming && !trimmed(insurer)) {
    throw bad("An insurance claim needs the insurer or TPA name");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT o.payment_status, o.sample_status, o.amount_total, o.amount_paid,
              o.amount_claimed, o.claim_state, o.version,
              COALESCE((SELECT SUM(price) FROM giniflow_lab_order_tests t
                         WHERE t.lab_order_id = o.id), 0) AS lines_total
         FROM giniflow_lab_orders o WHERE o.id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!rows.length) throw bad("Order not found", 404);
    const row = rows[0];

    // An order written before amount_total existed carries its price only on the
    // test lines, and the CHECK constraint measures against the column — so the
    // column is repaired first, once, rather than every reader guessing.
    if (paise(row.amount_total) === 0 && paise(row.lines_total) > 0) {
      row.amount_total = row.lines_total;
      await client.query(`UPDATE giniflow_lab_orders SET amount_total = $2 WHERE id = $1`, [
        orderId,
        row.lines_total,
      ]);
    }
    const before = moneyOf(row);

    // Optimistic lock. A status check cannot catch a double-tap once amounts are
    // involved: two taps of "collect ₹350" on a ₹1,250 order are both legal and
    // the patient pays ₹700. The desk sends the version it read; anything else
    // means the order moved under them.
    if (version !== null && version !== undefined && Number(version) !== row.version) {
      throw Object.assign(
        bad("This order changed while the screen was open — check it and try again", 409),
        { stale: true, version: row.version },
      );
    }

    const outstanding = outstandingPaise(before);
    // What is still owed and what can still be taken in cash are not the same
    // number. A standing claim has ₹900 spoken for: it has settled nothing, but
    // the desk cannot collect it in cash either, or the order is paid twice over.
    const collectible = collectiblePaise(before);
    const claimState = row.claim_state;

    // A repeat of a settling action on a settled order is a no-op, not a second
    // charge — the busy-counter double-tap this desk has always had.
    const settlingAgain =
      (["paid", "insurance_claim", "split"].includes(method) && outstanding === 0) ||
      (method === "claim_approved" && claimState === CLAIM_STATE.APPROVED) ||
      (method === "claim_rejected" && claimState === CLAIM_STATE.REJECTED);
    if (settlingAgain) {
      // Nothing left to settle. If the column already agrees with the money this
      // is the busy-counter double-tap and the answer is "nothing changed" — but
      // if it disagrees (an order written by an older build, or by hand) the
      // desk would otherwise be stuck pressing a button that can never work.
      // Correct the column to what the money says instead of dead-ending.
      const derived = derivePaymentStatus(before);
      const drifted = derived !== row.payment_status;
      if (drifted) {
        await client.query(
          `UPDATE giniflow_lab_orders
              SET payment_status = $2,
                  sample_status = CASE
                    WHEN $3 AND sample_status IN ('ordered', 'payment_pending') THEN 'paid'
                    ELSE sample_status END,
                  version = version + 1,
                  updated_at = NOW()
            WHERE id = $1`,
          [orderId, derived, opensLabGate(derived)],
        );
        // The sample task the lab sees has to have an origin in the ledger, the
        // same as when the desk clears a payment by hand.
        if (opensLabGate(derived) && !opensLabGate(row.payment_status)) {
          await client.query(
            `INSERT INTO giniflow_lab_order_events
               (lab_order_id, track, status, actor_role, actor_id)
             VALUES ($1, 'sample', 'paid', $3, $2)`,
            [orderId, actorId, actorRole],
          );
        }
      }
      await client.query("COMMIT");
      return {
        orderId,
        paymentStatus: derived,
        claimState,
        outstanding: rupeesFromPaise(outstanding),
        version: row.version + (drifted ? 1 : 0),
        alreadySettled: true,
        reconciled: drifted,
      };
    }

    let cash = 0;
    let claim = paise(row.amount_claimed);
    let nextClaimState = claimState;
    let approvedBy = null;
    let rejection = null;

    if (method === "paid" || method === "split") {
      if (collectible === 0 && claimState === CLAIM_STATE.SUBMITTED) {
        throw bad(
          `₹${rupeesFromPaise(outstanding)} is with the insurer — approve or reject that claim before taking cash`,
          409,
        );
      }
      cash = amountPaise(
        amountPaid,
        method === "paid" ? collectible : null,
        "The amount collected",
      );
      if (cash === null) throw bad("A split needs the amount collected in cash");
    }
    if (claiming) {
      // A second claim cannot be raised while one is standing — approve or
      // reject the first, or the two would both count against the same money.
      if (claimState === CLAIM_STATE.SUBMITTED) {
        throw bad("A claim is already submitted on this order — approve or reject it first", 409);
      }
      if (claimState === CLAIM_STATE.APPROVED) {
        throw bad("This order's claim is already approved", 409);
      }
      claim = amountPaise(
        amountClaimed,
        method === "insurance_claim" ? collectible - cash : null,
        "The amount claimed",
      );
      if (claim === null) throw bad("A split needs the amount being claimed");
      nextClaimState = CLAIM_STATE.SUBMITTED;
    }
    if (cash + (claiming ? claim : 0) > collectible) {
      throw bad(
        `That is more than the ₹${rupeesFromPaise(collectible)} still to be collected on this order`,
      );
    }

    if (method === "claim_approved" || method === "claim_rejected") {
      // An insurer can refuse a claim it had approved — rarely, but it happens
      // after the fact, and that is exactly when the lab gate has to close
      // again. Approval, though, only ever follows a submission.
      const rejectable = [CLAIM_STATE.SUBMITTED, CLAIM_STATE.APPROVED];
      const allowed = method === "claim_rejected" ? rejectable : [CLAIM_STATE.SUBMITTED];
      if (!allowed.includes(claimState)) {
        throw bad("There is no claim waiting on this order", 409);
      }
      if (method === "claim_approved") {
        // Maker-checker: approving a claim asserts that the insurer said yes,
        // and it opens the lab gate. The person who submitted it cannot be the
        // one who confirms it — a second pair of eyes, from the log, not from a
        // policy nobody can audit.
        const { rows: submitter } = await client.query(
          `SELECT actor_id FROM giniflow_lab_order_events
            WHERE lab_order_id = $1 AND track = 'payment' AND status = 'insurance_claim'
            ORDER BY occurred_at DESC LIMIT 1`,
          [orderId],
        );
        if (actorId && submitter[0]?.actor_id === actorId) {
          throw bad(
            "The claim was submitted by you — someone else has to confirm the approval",
            409,
          );
        }
        nextClaimState = CLAIM_STATE.APPROVED;
        approvedBy = actorId;
      } else {
        nextClaimState = CLAIM_STATE.REJECTED;
        rejection = trimmed(note);
      }
    }

    const after = {
      amountTotal: row.amount_total,
      amountPaid: rupeesFromPaise(paise(row.amount_paid) + cash),
      amountClaimed: rupeesFromPaise(claim),
      claimState: nextClaimState,
    };
    const paymentStatus = derivePaymentStatus(after);
    const stillOutstanding = outstandingPaise(after);

    await client.query(
      `UPDATE giniflow_lab_orders
          SET payment_status = $2,
              amount_paid    = $3,
              amount_claimed = $4,
              claim_state    = $5,
              -- The sample task follows the money in both directions: settled
              -- opens it, and a claim the insurer refuses closes it again — but
              -- only while the sample is still uncollected. Once the lab has
              -- taken it the work is done and what is left is a bill, not a task.
              sample_status = CASE
                WHEN $6 AND sample_status IN ('ordered', 'payment_pending') THEN 'paid'
                WHEN NOT $6 AND sample_status = 'paid' THEN 'ordered'
                ELSE sample_status END,
              insurer   = COALESCE($7, insurer),
              policy_no = COALESCE($8, policy_no),
              claim_no  = COALESCE($9, claim_no),
              -- A new claim starts clean: the note explains the CURRENT claim's
              -- rejection, and carrying the last one over would caption the new
              -- claim with an insurer's answer about a different one.
              claim_note = CASE
                WHEN $5 = 'rejected' THEN $10
                WHEN $5 = 'submitted' THEN NULL
                ELSE claim_note END,
              claim_approved_by = COALESCE($11, claim_approved_by),
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [
        orderId,
        paymentStatus,
        after.amountPaid,
        after.amountClaimed,
        nextClaimState,
        opensLabGate(paymentStatus),
        trimmed(insurer),
        trimmed(policyNo),
        trimmed(claimNo),
        rejection,
        approvedBy,
      ],
    );

    // The ledger: one event per action taken, so a dispute a week later reads as
    // a sequence rather than as whatever the status column says today.
    const events = [];
    if (cash > 0) events.push(stillOutstanding === 0 ? "paid" : "part_paid");
    if (claiming) events.push("insurance_claim");
    if (method === "claim_approved") events.push("claim_approved");
    if (method === "claim_rejected") events.push("claim_rejected");
    for (const status of events) {
      await client.query(
        `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
         VALUES ($1, 'payment', $2, $4, $3)`,
        [orderId, status, actorId, actorRole],
      );
    }

    // The lab's queue reads sample_status, so the sample task appearing there is
    // the same write — trigger 3 in the brief, not a second job that can fail.
    // A submitted-but-unapproved claim writes no sample event: there is nothing
    // for the lab to do yet.
    if (opensLabGate(paymentStatus) && !opensLabGate(row.payment_status)) {
      await client.query(
        `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
         VALUES ($1, 'sample', 'paid', $3, $2)`,
        [orderId, actorId, actorRole],
      );
    }

    await client.query("COMMIT");
    return {
      orderId,
      paymentStatus,
      claimState: nextClaimState,
      amountPaid: after.amountPaid,
      amountClaimed: after.amountClaimed,
      outstanding: rupeesFromPaise(stillOutstanding),
      version: row.version + 1,
      alreadySettled: false,
    };
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
     AND v.merged_into_visit_id IS NULL
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
