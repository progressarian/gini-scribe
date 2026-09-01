import pool from "../../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { advanceStatus } from "./statusEngine.js";
import { opensLabGate } from "./receptionStation.js";

// The lab station. Five buckets along one track:
//
//   sample pending → collecting → processing → ready to upload → uploaded
//
// Two rules the screen cannot be trusted to enforce, so the service does:
//
//   1. No sample may be collected until reception has cleared payment or an
//      insurance claim (brief §2.2). A lab technician looking at a card has no
//      way to know that; the button is hidden, but hiding is not enforcing.
//   2. `uploaded` sets results_status = 'ready' on the visit, which is what turns
//      the patient green on the MO and doctor queues (trigger 1). It happens in
//      the same transaction as the upload, so the two can never disagree.

export const SAMPLE_FLOW = [
  "ordered",
  "payment_pending",
  "paid",
  "sample_collected",
  "processing",
  "results_ready",
  "uploaded",
];

// What the technician does next, per bucket.
const NEXT_ACTION = {
  paid: { to: "sample_collected", label: "✓ Mark sample collected" },
  sample_collected: { to: "processing", label: "⚙️ Start processing" },
  processing: { to: "results_ready", label: "✓ Results done — ready to upload" },
  results_ready: { to: "uploaded", label: "📤 Upload report" },
};

const BUCKET = {
  ordered: "pending",
  payment_pending: "pending",
  paid: "pending",
  sample_collected: "collecting",
  processing: "processing",
  results_ready: "ready",
  uploaded: "uploaded",
};

const stepsFor = (sampleStatus, paid) => {
  const at = (name, done, now) => ({ name, state: done ? "done" : now ? "now" : "next" });
  const idx = SAMPLE_FLOW.indexOf(sampleStatus);
  return [
    at("Payment ✓", paid, !paid),
    at("Collect sample", idx >= SAMPLE_FLOW.indexOf("sample_collected"), sampleStatus === "paid"),
    at("Process", idx >= SAMPLE_FLOW.indexOf("processing"), sampleStatus === "sample_collected"),
    at("Upload", sampleStatus === "uploaded", sampleStatus === "results_ready"),
  ];
};

export async function getLabQueue(visitDate, db = pool) {
  const { rows } = await db.query(
    `SELECT o.id, o.visit_id, o.sample_status, o.payment_status, o.urgency,
            o.created_at, o.updated_at, o.uploaded_at, o.report_file_url,
            p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
            d.short_name AS ordered_by,
            COALESCE(t.tests, '[]'::json) AS tests,
            last_ev.occurred_at AS since
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN doctors d ON d.id = o.ordered_by
       LEFT JOIN LATERAL (
         SELECT json_agg(
                  json_build_object('name', lt.test_name, 'price', lt.price, 'status', lt.status)
                  ORDER BY lt.test_name) AS tests
           FROM giniflow_lab_order_tests lt WHERE lt.lab_order_id = o.id
       ) t ON TRUE
       LEFT JOIN LATERAL (
         SELECT occurred_at FROM giniflow_lab_order_events e
          WHERE e.lab_order_id = o.id AND e.track = 'sample'
          ORDER BY occurred_at DESC LIMIT 1
       ) last_ev ON TRUE
      WHERE v.visit_date = $1::date
        AND NOT COALESCE(p.is_blocked, FALSE)
        -- Only today's tests are today's work (brief §2.3 trigger 2). A test
        -- ordered for the next visit would otherwise sit here as a sample that
        -- never arrives.
        AND o.urgency = 'today'
        -- No sample to take from a patient who never arrived or has gone home.
        AND v.current_status NOT IN ('no_show', 'cancelled')
      ORDER BY o.created_at`,
    [visitDate],
  );

  const orders = rows.map((r) => {
    const paid = opensLabGate(r.payment_status);
    return {
      orderId: r.id,
      visitId: r.visit_id,
      patientId: r.patient_id,
      name: r.name,
      fileNo: r.file_no,
      age: r.age,
      sex: r.sex,
      orderedBy: r.ordered_by,
      urgency: r.urgency,
      tests: r.tests || [],
      paymentStatus: r.payment_status,
      sampleStatus: r.sample_status,
      paid,
      bucket: BUCKET[r.sample_status] || "pending",
      steps: stepsFor(r.sample_status, paid),
      // Only offered once payment is cleared — and refused by the service too.
      nextAction: paid ? NEXT_ACTION[r.sample_status] || null : null,
      blockedReason: paid
        ? null
        : r.payment_status === "insurance_claim"
          ? "Insurance claim submitted — waiting for approval"
          : "Waiting for reception to clear payment",
      orderedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      since:
        r.since || r.updated_at || r.created_at
          ? new Date(r.since || r.updated_at || r.created_at).toISOString()
          : null,
      uploadedAt: r.uploaded_at ? new Date(r.uploaded_at).toISOString() : null,
      reportUrl: r.report_file_url || null,
    };
  });

  const by = (b) => orders.filter((o) => o.bucket === b);
  return {
    pending: by("pending"),
    collecting: by("collecting"),
    processing: by("processing"),
    ready: by("ready"),
    uploaded: by("uploaded"),
  };
}

export async function advanceSample(orderId, { to, actorId = null, reportUrl = null }, db = pool) {
  if (!SAMPLE_FLOW.includes(to)) {
    throw Object.assign(new Error(`Unknown sample status: ${to}`), { status: 400 });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT o.sample_status, o.payment_status, o.visit_id
         FROM giniflow_lab_orders o WHERE o.id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });
    const { sample_status: from, payment_status: payment, visit_id: visitId } = rows[0];

    // The payment gate. Enforced here, not in the UI: a hidden button is not a
    // rule, and this one decides whether a patient is charged for a test.
    // Brief §2.2 — "paid (or claim approved)": a submitted claim is not enough.
    if (!opensLabGate(payment)) {
      throw Object.assign(
        new Error(
          payment === "insurance_claim"
            ? "Insurance claim is not approved yet — the sample cannot be collected"
            : "Payment is not cleared — reception must take payment before the sample",
        ),
        { status: 409 },
      );
    }

    const fromIdx = SAMPLE_FLOW.indexOf(from);
    const toIdx = SAMPLE_FLOW.indexOf(to);
    if (toIdx <= fromIdx) {
      // Two technicians tapping the same card is a no-op, not an error and not a
      // second event.
      await client.query("COMMIT");
      return { orderId, sampleStatus: from, unchanged: true };
    }

    await client.query(
      `UPDATE giniflow_lab_orders
          SET sample_status = $2,
              report_file_url = COALESCE($3, report_file_url),
              uploaded_at = CASE WHEN $2 = 'uploaded' THEN NOW() ELSE uploaded_at END,
              updated_at = NOW()
        WHERE id = $1`,
      [orderId, to, reportUrl],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
       VALUES ($1, 'sample', $2, 'lab', $3)`,
      [orderId, to, actorId],
    );
    // Every test moves with its order. Per-test divergence (one result back
    // before another) is a later refinement; this at least makes the pane's
    // badges truthful rather than decorative.
    await client.query(`UPDATE giniflow_lab_order_tests SET status = $2 WHERE lab_order_id = $1`, [
      orderId,
      to,
    ]);

    // Trigger 1: uploading is what turns the patient green for the MO and the
    // doctor. Same transaction, so the queue can never show a result the visit
    // does not know about.
    if (to === "uploaded") {
      await client.query(
        `UPDATE giniflow_visits SET results_status = 'ready', updated_at = NOW() WHERE id = $1`,
        [visitId],
      );
      await advanceStatus(client, {
        visitId,
        toStatus: "results_received",
        actorRole: "lab",
        actorId,
        allowSkip: true,
        meta: { source: "lab_upload", lab_order_id: orderId },
      }).catch(() => {
        // The visit may already be past this point — the report is what matters,
        // and results_status is set either way.
      });
    }

    await client.query("COMMIT");
    return { orderId, sampleStatus: to, unchanged: false };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Uploading the report is the lab's real work — everything before it is bookkeeping.
//
// The file goes to the same storage bucket the rest of the app uses, under a
// giniflow/ prefix, and the resulting URL is recorded on the order. It is
// deliberately NOT written into the shared `documents` table: that is the
// patient's clinical record, and while Gini Flow runs alongside the old module a
// second writer there would duplicate reports in the doctor's Labs tab. Promoting
// a Gini Flow report into `documents` belongs with the same decision as vitals —
// see 06-PHASE-2-PLAN.md question 12.
export async function uploadReport(
  orderId,
  { base64, fileName, mediaType = "application/pdf", actorId = null },
  db = pool,
) {
  if (!base64) throw Object.assign(new Error("No file was sent"), { status: 400 });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw Object.assign(new Error("Storage is not configured"), { status: 503 });
  }

  const { rows } = await db.query(
    `SELECT o.payment_status, o.sample_status, v.patient_id
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (!opensLabGate(rows[0].payment_status)) {
    throw Object.assign(new Error("Payment is not cleared for this order"), { status: 409 });
  }

  const buffer = Buffer.from(base64, "base64");
  // The screen tells the technician 10 MB, so 10 MB is the limit. A service that
  // quietly allows more than the interface promises is a service nobody can
  // predict.
  const MAX_BYTES = 10 * 1024 * 1024;
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error("Report is larger than 10 MB"), { status: 413 });
  }

  const safeName = String(fileName || "report.pdf").replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `giniflow/lab/${rows[0].patient_id}/${Date.now()}_${safeName}`;

  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": mediaType,
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!resp.ok) {
    throw Object.assign(new Error(`Upload failed: ${await resp.text()}`), { status: 502 });
  }

  const url = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;

  // The file is stored, so now mark it uploaded — which is what notifies the MO.
  // Done through advanceSample so trigger 1 and the event log are the same code
  // path whether or not a file was attached.
  await advanceSample(orderId, { to: "uploaded", actorId, reportUrl: url }, db);
  return { orderId, reportUrl: url, fileName: safeName, bytes: buffer.length };
}
