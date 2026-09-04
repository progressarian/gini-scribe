import pool from "../../config/db.js";
import { promoteLabReport, promoteQuietly } from "./promote.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { advanceStatus } from "./statusEngine.js";
import { opensLabGate } from "./receptionStation.js";
import {
  BOARD_COLUMNS,
  STATUS_LABEL,
  WAIT_STATUSES,
  columnForStatus,
} from "../../../shared/giniflowStatus.js";

// The COLUMN, not the raw status. `vitals_done` is the last event the sync
// observed, but the board files it under "With SD / MO" — HealthRay has no
// status for the workup, so a patient sitting with the MO still reads
// `vitals_done` in the table. Printing the status made the card claim eight
// patients were at vitals when they were with the SD.
const COLUMN_NAME = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, c.name]));

// The visit is over — the lab is holding a result nobody on the floor is waiting
// for any more, which is a different problem from a slow sample.
const FINISHED = ["dispensed", "exited", "no_show", "cancelled"];

// A patient cannot be in two places. These three statuses mean somebody else has
// them in a room right now, so the lab cannot draw a sample however overdue it
// is — the card must not offer it. Every other on-floor status is a QUEUE: the
// patient is sitting waiting and can be called.
//
// `vitals_done` is the one that matters most here. The board files it under
// "With SD / MO" because that is the column it belongs to, but the status itself
// means vitals are finished and the MO has not started — the patient is idle,
// and collectable.
const IN_A_ROOM = ["with_vitals", "with_sd", "with_doctor"];

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
    at(
      "Process",
      idx > SAMPLE_FLOW.indexOf("processing"),
      sampleStatus === "sample_collected" || sampleStatus === "processing",
    ),
    at("Upload", sampleStatus === "uploaded", sampleStatus === "results_ready"),
  ];
};

// Lab work the floor is waiting on that Gini Flow did not order.
//
// The MO and consultant boards counted `giniflow_lab_orders` alone, so a patient
// whose bloods were ordered on HealthRay — which is all of them — never showed as
// awaiting results. On a day with 46 lab cases and 5 outstanding, both boards
// read zero, and an MO could close a patient without knowing today's results
// were still out.
//
// Outstanding means the lab has neither signed the case out nor produced a file.
// Matched by UHID as well as `patient_id`, because a case the lab is still
// running is exactly the one with no `patient_id` yet.
//
// A correlated fragment rather than a helper: both boards select it inside one
// large query each, and two copies of this rule would drift.
export const OPEN_LAB_CASES_SQL = `
  (SELECT count(*)::int FROM lab_cases lc
    WHERE lc.case_date = v.visit_date
      AND (lc.patient_id = v.patient_id
           OR (lc.patient_id IS NULL
               AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
      AND lc.raw_detail_json->>'reported_on' IS NULL
      AND lc.pdf_storage_path IS NULL)`;

const GINI_BUCKET_TO_STAGE = {
  pending: "pending",
  collecting: "collected",
  processing: "processing",
  ready: "results",
  uploaded: "reported",
};

const unifiedFromOrder = (o) => ({
  key: `giniflow:${o.orderId}`,
  source: "giniflow",
  driven: true,
  stage: GINI_BUCKET_TO_STAGE[o.bucket] || "pending",
  steps: o.steps,
  patientId: o.patientId,
  name: o.name,
  fileNo: o.fileNo,
  age: o.age,
  sex: o.sex,
  tests: o.tests.map((t) => t.name),
  caseCount: 1,
  since: o.since,
  orderedBy: o.orderedBy,
  nextAction: o.nextAction,
  blockedReason: o.blockedReason,
  reportUrl: o.reportUrl,
  orderId: o.orderId,
  visitId: o.visitId,
});

const unifiedFromCase = (r) => ({
  key: `healthray:${r.patientId}`,
  source: "healthray",
  driven: false,
  stage: r.stage?.key || "pending",
  steps: r.steps,
  patientId: r.patientId,
  name: r.name,
  fileNo: r.fileNo,
  age: r.age,
  sex: r.sex,
  tests: r.tests || [],
  caseCount: r.cases,
  since: r.stageAt || r.registeredAt || null,
  orderedBy: r.orderedBy || null,
  nextAction: null,
  blockedReason: null,
  reportUrl: null,
  station: r.station || null,
  outstanding: r.outstanding,
});

export async function getLabQueue(visitDate, q = null, db = pool) {
  const search = q && String(q).trim().length >= 2 ? String(q).trim() : null;
  const healthray = await getHealthrayCases(visitDate, search, db);
  const { rows } = await db.query(
    `SELECT o.id, o.visit_id, o.sample_status, o.payment_status, o.urgency,
            o.created_at, o.updated_at, o.uploaded_at, o.report_file_url,
            p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
            v.current_status,
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
        AND (
          $2::text IS NULL
          OR p.name ILIKE '%' || $2 || '%'
          OR p.file_no ILIKE '%' || $2 || '%'
          OR d.short_name ILIKE '%' || $2 || '%'
          OR EXISTS (
            SELECT 1 FROM giniflow_lab_order_tests lt2
             WHERE lt2.lab_order_id = o.id AND lt2.test_name ILIKE '%' || $2 || '%'
          )
        )
      ORDER BY o.created_at`,
    [visitDate, search],
  );

  const orders = rows.map((r) => {
    const paid = opensLabGate(r.payment_status);
    return {
      orderId: r.id,
      visitId: r.visit_id,
      patientId: r.patient_id,
      name: r.name || "Patient not matched yet",
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
      finished: FINISHED.includes(r.current_status),
      station: FINISHED.includes(r.current_status)
        ? STATUS_LABEL[r.current_status] || r.current_status
        : COLUMN_NAME[columnForStatus(r.current_status)] ||
          STATUS_LABEL[r.current_status] ||
          r.current_status,
      collectable: !IN_A_ROOM.includes(r.current_status) && !FINISHED.includes(r.current_status),
    };
  });

  const by = (b) => orders.filter((o) => o.bucket === b);

  const unified = [...orders.map(unifiedFromOrder), ...healthray.map(unifiedFromCase)];
  const unifiedCounts = LAB_STAGES.reduce(
    (acc, s) => ({ ...acc, [s.key]: unified.filter((u) => u.stage === s.key).length }),
    {},
  );

  return {
    pending: by("pending"),
    collecting: by("collecting"),
    processing: by("processing"),
    ready: by("ready"),
    uploaded: by("uploaded"),
    healthray,
    unified,
    unifiedCounts,
    stages: LAB_STAGES,
    // The five counters at the top of the screen. They read 0 all day because
    // they only ever counted `giniflow_lab_orders`; the hospital's own cases
    // move through the same five stages and are simply added in, so the strip
    // describes the lab rather than one unused table.
    stageCounts: healthray.reduce(
      (acc, r) => {
        r.caseList.forEach((c) => {
          acc[c.stage.key] += 1;
        });
        return acc;
      },
      { pending: 0, collected: 0, processing: 0, results: 0, reported: 0 },
    ),
  };
}

// The hospital's own lab, read-only.
//
// The five buckets above queue `giniflow_lab_orders`, which only an MO ordering
// on this floor writes — one row in the table's whole history. Meanwhile the lab
// itself runs 40-odd cases a day, ordered on HealthRay and landing here through
// the lab-API sync. The station was therefore empty on a busy day, which reads
// as a broken screen rather than as two systems that never meet.
//
// Grouped by PATIENT, not by case: a patient with four samples is one person the
// floor is waiting on, and the technician's question is "whose bloods are we
// still holding up", not "how many tubes exist". So each row carries where that
// patient is standing right now, which is the only thing that makes an unowned
// queue actionable — a result that is late matters when the doctor is waiting
// for it and does not when the patient has gone home.

// `results_synced` is the trap: it flips TRUE the moment ONE numeric panel
// lands, not when the case is done. A synced case with no `reported_on` is the
// "Gini Lab Partial" bucket — lab staff are still entering the rest of it. The
// definition is copied in meaning from `routes/opd.js`, so this screen and the
// OPD chips can never disagree.
// HealthRay stamps a clock at each stage, so the hospital lab has the same five
// buckets the Gini queue does — they were simply never read. `result_saved_on`
// before `reported_on` is the "results done, not signed out" window, which is
// what the queue calls Ready to upload.
const CASE_STAGE = [
  {
    key: "pending",
    label: "Collect now",
    pill: "sp-sample",
    at: "registeredAt",
    since: "since order",
  },
  {
    key: "collected",
    label: "Collected",
    pill: "sp-sample",
    at: "collectedOn",
    since: "since collection",
  },
  {
    key: "processing",
    label: "Processing",
    pill: "sp-process",
    at: "receivedOn",
    since: "in analyzer",
  },
  {
    key: "results",
    label: "Results done",
    pill: "sp-ready",
    at: "resultSavedOn",
    since: "results waiting",
  },
  { key: "reported", label: "Reported", pill: "sp-done", at: "reportedOn", since: "reported" },
];

export const LAB_STAGES = CASE_STAGE.map((s) => ({ key: s.key, label: s.label }));

// `phlebotomy_status` before `collected_on`, deliberately.
//
// `collected_on` only arrives with the DETAIL fetch, which is the same call that
// carries the results — so while that call is failing (and it retries roughly
// once every 10 minutes for up to 14 days) a sample drawn hours ago still looks
// uncollected. One case today sat on "Collect now" for three and a half hours
// after the phlebotomist had finished with it, which is the screen sending a
// technician to draw blood twice.
//
// The LIST payload carries `phlebotomy_status` on every pass and needs no detail
// call. Across the last week it takes exactly two values and never contradicts
// `collected_on` where both are present, so it is the earlier, safer signal.
const isCollected = (c) => c.phlebotomy === "Completed" || !!c.collectedOn;

const stageIndex = (c) => {
  if (c.reportedOn) return 4;
  if (c.resultSavedOn) return 3;
  if (c.receivedOn) return 2;
  if (isCollected(c)) return 1;
  return 0;
};

// The rail and the pill are the SAME fact and must be computed from the same
// thing. Driving the rail off `results_synced` while the pill read HealthRay's
// timestamps let one card say "Sample at lab" beside a pill saying "Processing"
// — two names for one state, disagreeing on the same row. Both now come from
// the stage, so the rail simply marks how far along `CASE_STAGE` the case is.
const RAIL = ["Ordered", "Collect sample", "Process", "Upload"];

// `CASE_STAGE` has five entries and the rail four, so the map is explicit: the
// index here is the rail step currently in progress. A case AT the analyzer has
// "Processing" as its live step, not as a finished one — and "Results done" and
// "Reported" collapse into one rail step, the first being the lab not having
// signed the case out yet.
const RAIL_FOR_STAGE = [1, 2, 2, 3, 4];

const labSteps = (stage) => {
  const reached = RAIL_FOR_STAGE[stage];
  return RAIL.map((name, i) => ({
    name,
    state: i < reached ? "done" : i === reached ? "now" : "next",
  }));
};

async function getHealthrayCases(visitDate, q = null, db = pool) {
  const { rows } = await db.query(
    `WITH cases AS (
       SELECT lc.*,
              COALESCE(lc.raw_detail_json, lc.raw_list_json) AS payload,
              -- A case the lab is still running has no patient_id: that column is
              -- stamped only once the detail fetch has written the values. The
              -- UHID is in the raw payload from the first list sync, so matching
              -- on it is what keeps outstanding work visible at all.
              COALESCE(lc.patient_id, uid.id) AS pid
         FROM lab_cases lc
         LEFT JOIN patients uid
                ON uid.file_no = lc.raw_list_json->'patient'->>'healthray_uid'
        WHERE lc.case_date = $1::date
          AND (
            $2::text IS NULL
            OR lc.raw_list_json->'patient'->>'patient_name' ILIKE '%' || $2 || '%'
            OR lc.raw_list_json->'patient'->>'healthray_uid' ILIKE '%' || $2 || '%'
            OR array_to_string(lc.test_names, ' ') ILIKE '%' || $2 || '%'
            OR (COALESCE(lc.raw_detail_json, lc.raw_list_json) -> 'referral_doctor')::text
                 ILIKE '%' || $2 || '%'
            OR EXISTS (
              SELECT 1 FROM patients px
               WHERE px.id = COALESCE(lc.patient_id, uid.id)
                 AND (px.name ILIKE '%' || $2 || '%' OR px.file_no ILIKE '%' || $2 || '%')
            )
          )
     )
     SELECT c.pid AS patient_id,
            COALESCE(p.name, max(c.raw_list_json->'patient'->>'patient_name')) AS name,
            COALESCE(p.file_no, max(c.raw_list_json->'patient'->>'healthray_uid')) AS file_no,
            p.age, p.sex,
            v.current_status, v.id IS NOT NULL AS on_floor,
            count(*)::int AS cases,
            count(*) FILTER (WHERE NOT c.results_synced)::int AS pending,
            count(*) FILTER (WHERE c.results_synced
                               AND c.raw_detail_json->>'reported_on' IS NULL)::int AS partial,
            count(*) FILTER (WHERE c.results_synced
                               AND c.raw_detail_json->>'reported_on' IS NOT NULL)::int AS reported,
            (SELECT array_agg(DISTINCT t)
               FROM cases c2, unnest(c2.test_names) AS t
              WHERE c2.pid IS NOT DISTINCT FROM c.pid) AS tests,
            -- A patient with a sample today and no visit today is not a missing
            -- check-in: they were consulted on an earlier day and have come back
            -- for the sample alone. Saying WHEN they were seen answers the
            -- question the card otherwise provokes.
            (SELECT max(pv.visit_date)::text FROM giniflow_visits pv
              WHERE pv.patient_id = c.pid AND pv.visit_date < $1::date) AS prev_visit,
            (SELECT max(a.appointment_date)::text FROM appointments a
              WHERE a.patient_id = c.pid AND a.appointment_date < $1::date) AS prev_appt,
            min(c.payload->>'registered_at') AS registered_at,
            max(c.payload->>'reported_on') AS reported_on,
            (array_agg(btrim(
               COALESCE(c.payload->'referral_doctor'->>'title', '') || ' ' ||
               COALESCE(c.payload->'referral_doctor'->>'first_name', '') || ' ' ||
               COALESCE(c.payload->'referral_doctor'->>'last_name', ''))
             ORDER BY c.payload->>'registered_at'))[1] AS ordered_by,
            min(c.fetched_at) AS first_seen,
            max(c.fetched_at) AS last_seen,
            json_agg(
              json_build_object(
                'caseNo', c.case_no,
                'tests', COALESCE(c.test_names, ARRAY[]::text[]),
                'synced', c.results_synced,
                'reported', c.raw_detail_json->>'reported_on' IS NOT NULL,
                'hasReport', c.pdf_storage_path IS NOT NULL,
                -- HealthRay's own clocks, which are the real ones. fetched_at
                -- is when our poller first saw the case, hours after the sample
                -- was drawn, and putting it on a card dated the work wrongly.
                'registeredAt', c.payload->>'registered_at',
                'collectedOn', c.payload->>'collected_on',
                'receivedOn', c.payload->>'received_on',
                'reportedOn', c.payload->>'reported_on',
                'resultSavedOn', c.payload->>'result_saved_on',
                'phlebotomy', c.raw_list_json->>'phlebotomy_status',
                'orderedBy', btrim(
                  COALESCE(c.payload->'referral_doctor'->>'title', '') || ' ' ||
                  COALESCE(c.payload->'referral_doctor'->>'first_name', '') || ' ' ||
                  COALESCE(c.payload->'referral_doctor'->>'last_name', '')
                ),
                'fetchedAt', c.fetched_at,
                'actions', COALESCE(act.list, '[]'::json)
              ) ORDER BY c.fetched_at DESC
            ) AS case_list
       FROM cases c
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'action', a.action,
                  'at', a.created_at,
                  'by', COALESCE(d.short_name, d.name, a.actor_role)
                ) ORDER BY a.created_at) AS list
           FROM giniflow_lab_case_actions a
           LEFT JOIN doctors d ON d.id = a.actor_id
          WHERE a.case_no = c.case_no
       ) act ON TRUE
       LEFT JOIN patients p ON p.id = c.pid
       LEFT JOIN giniflow_visits v ON v.patient_id = c.pid AND v.visit_date = $1::date
      WHERE NOT COALESCE(p.is_blocked, FALSE)
      GROUP BY c.pid, p.id, p.name, p.file_no, p.age, p.sex, v.current_status, v.id
      ORDER BY (count(*) FILTER (WHERE NOT c.results_synced)) DESC, min(c.fetched_at)`,
    [visitDate, q],
  );

  return rows.map((r) => {
    const counts = { pending: r.pending, partial: r.partial, reported: r.reported };
    // The LEAST advanced case is the patient's stage: with three samples out, the
    // one nobody has collected is what the floor is waiting on, not the one that
    // has already reported.
    const cases = (r.case_list || []).map((c) => ({
      ...c,
      stage: CASE_STAGE[stageIndex(c)],
      stageAt: c[CASE_STAGE[stageIndex(c)].at] || null,
      // The screen's collect button keys off this, so it has to be the same
      // rule the stage uses: an absent `collected_on` is not evidence the sample
      // is still in the patient.
      collected: isCollected(c),
      state: !c.synced
        ? { key: "awaiting", label: "Awaiting results" }
        : !c.reported
          ? { key: "partial", label: "Partial — panels still coming in" }
          : { key: "reported", label: "Reported" },
    }));
    const lowest = cases.reduce(
      (worst, c) => (stageIndex(c) < stageIndex(worst) ? c : worst),
      cases[0],
    );
    return {
      patientId: r.patient_id,
      name: r.name || "Unnamed patient",
      fileNo: r.file_no,
      age: r.age,
      sex: r.sex,
      tests: r.tests || [],
      cases: r.cases,
      caseList: cases,
      stage: lowest?.stage || CASE_STAGE[0],
      stageAt: lowest?.stageAt || null,
      ...counts,
      outstanding: r.pending + r.partial,
      steps: labSteps(lowest ? stageIndex(lowest) : 0),
      // Where the patient is standing while the lab holds their sample. A visit
      // row is the only evidence they are in the building at all, so its absence
      // is stated rather than guessed at.
      station: r.on_floor
        ? FINISHED.includes(r.current_status)
          ? STATUS_LABEL[r.current_status] || r.current_status
          : COLUMN_NAME[columnForStatus(r.current_status)] ||
            STATUS_LABEL[r.current_status] ||
            r.current_status
        : null,
      // The underlying status, for the pane: the column says where they are, this
      // says what was last actually observed about them.
      statusLabel: r.on_floor ? STATUS_LABEL[r.current_status] || r.current_status : null,
      lastSeenOn: r.on_floor ? null : r.prev_visit || r.prev_appt || null,
      // "In a queue" is the useful sense of waiting here, not the board's SLA
      // sense: a patient at `vitals_done` has nobody with them either.
      waiting: r.on_floor
        ? WAIT_STATUSES.includes(r.current_status) ||
          (!IN_A_ROOM.includes(r.current_status) && !FINISHED.includes(r.current_status))
        : false,
      inARoom: r.on_floor ? IN_A_ROOM.includes(r.current_status) : false,
      finished: r.on_floor ? FINISHED.includes(r.current_status) : false,
      // Can the lab physically get to this patient now? Not while another
      // station has them, and not once they have gone home.
      collectable: r.on_floor
        ? !IN_A_ROOM.includes(r.current_status) && !FINISHED.includes(r.current_status)
        : true,
      orderedBy: r.ordered_by || null,
      registeredAt: r.registered_at || null,
      reportedOn: r.reported_on || null,
      firstSeen: r.first_seen ? new Date(r.first_seen).toISOString() : null,
      lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
    };
  });
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
const EXT_BY_TYPE = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
};

// The stored report's BYTES, fetched with the service key.
//
// Not a redirect to the stored URL: `patient-files` is private, so the object is
// only reachable with a key the browser must never hold. The auth middleware has
// already checked the caller by the time this runs — the same shape as
// `GET /documents/:id/stream` and the referral letter.
export async function fetchStoredReport(orderId, db = pool) {
  const { rows } = await db.query(
    `SELECT o.report_file_url, o.visit_id, v.patient_id, p.name, p.file_no
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
       JOIN patients p        ON p.id = v.patient_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });

  const url = rows[0].report_file_url;
  if (!url) throw Object.assign(new Error("No report has been uploaded yet"), { status: 404 });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw Object.assign(new Error("Storage is not configured"), { status: 503 });
  }

  // Accepts either shape, because rows written before this fix hold the public
  // form: .../object/public/<bucket>/<path> and .../object/<bucket>/<path>.
  const marker = "/storage/v1/object/";
  const at = url.indexOf(marker);
  if (at < 0) throw Object.assign(new Error("That report cannot be read"), { status: 409 });
  const objectPath = url.slice(at + marker.length).replace(/^public\//, "");

  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${objectPath}`, {
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  // A missing object is a 404 the technician can act on — re-upload — and not a
  // 502 that reads as the server being broken.
  if (!resp.ok) {
    throw Object.assign(new Error("The stored report could not be read — re-upload it"), {
      status: resp.status === 404 ? 404 : 502,
    });
  }

  // The technician uploads whatever the machine printed — the form accepts an
  // image as readily as a PDF, and the one report on file is a PNG. Serving it
  // as application/pdf would hand the browser a picture inside a PDF viewer and
  // fail. The stored object's own type is the truth.
  const contentType = resp.headers.get("content-type") || "application/octet-stream";
  const ext = (EXT_BY_TYPE[contentType.split(";")[0].trim()] || "bin").toLowerCase();
  const who = String(rows[0].name || "patient").replace(/[^a-zA-Z0-9._-]/g, "_");

  return {
    bytes: Buffer.from(await resp.arrayBuffer()),
    contentType,
    fileName: `Lab_${who}_${rows[0].file_no}.${ext}`,
  };
}

export async function uploadReport(
  orderId,
  { base64, fileName, mediaType = "application/pdf", actorId = null, confirmAdditional = false },
  db = pool,
) {
  if (!base64) throw Object.assign(new Error("No file was sent"), { status: 400 });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw Object.assign(new Error("Storage is not configured"), { status: 503 });
  }

  const { rows } = await db.query(
    `SELECT o.payment_status, o.sample_status, o.report_file_url, o.uploaded_at, v.patient_id
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!rows.length) throw Object.assign(new Error("Order not found"), { status: 404 });
  if (!opensLabGate(rows[0].payment_status)) {
    throw Object.assign(new Error("Payment is not cleared for this order"), { status: 409 });
  }
  if (rows[0].report_file_url && !confirmAdditional) {
    throw Object.assign(new Error("A report is already on this order"), {
      status: 409,
      needsConfirmation: "additional_report",
      existingUploadedAt: rows[0].uploaded_at,
    });
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

  // The OBJECT path, not a public URL.
  //
  // This used to store `/object/public/<bucket>/<path>`, which is the form
  // Supabase composes for a public bucket. `patient-files` is PRIVATE — it holds
  // every patient's prescriptions and lab reports — so that URL resolves to
  // "Bucket not found" and every "View uploaded report" button 404'd. The bucket
  // cannot be made public to fix it.
  //
  // So the row stores the authenticated form and the route proxies the bytes,
  // exactly as the referral letter does. Rows written before this fix hold the
  // public form; `fetchStoredReport` accepts both.
  const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`;

  // The file is stored, so now mark it uploaded — which is what notifies the MO.
  // Done through advanceSample so trigger 1 and the event log are the same code
  // path whether or not a file was attached.
  await advanceSample(orderId, { to: "uploaded", actorId, reportUrl: url }, db);

  // Onto the patient's record. `documents` is what the doctor's Labs tab reads
  // and what the patient app reads — a report that stays on the lab order is a
  // report only the lab station can see.
  promoteQuietly(promoteLabReport, orderId);

  return { orderId, reportUrl: url, fileName: safeName, bytes: buffer.length };
}

// Confirm-and-attribute (06-PHASE-2-PLAN §0.4). Records that a technician acted
// on a case Gini Flow does not own — who chased the lab, who took the sample. It
// changes nothing at HealthRay and deliberately does not pretend to: the sample's
// real state still arrives through `labSync`.
// One action. "chased" was dropped: it is not in the reference design, and the
// screen should not invent vocabulary the rest of the floor does not use.
export const CASE_ACTIONS = ["sample_taken"];

export async function markLabCaseAction(
  caseNo,
  { action, actorId = null, actorRole = "lab", note = null, undo = false },
  db = pool,
) {
  if (!CASE_ACTIONS.includes(action)) throw new Error(`Unknown lab case action: ${action}`);

  const { rows: known } = await db.query(`SELECT 1 FROM lab_cases WHERE case_no = $1 LIMIT 1`, [
    caseNo,
  ]);
  if (!known.length) throw new Error(`No such lab case: ${caseNo}`);

  if (undo) {
    await db.query(`DELETE FROM giniflow_lab_case_actions WHERE case_no = $1 AND action = $2`, [
      caseNo,
      action,
    ]);
    return { caseNo, action, undone: true };
  }

  // One row per case per action: tapping twice is the same statement, not two.
  const { rows } = await db.query(
    `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role, actor_id, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (case_no, action) DO UPDATE
       SET actor_role = EXCLUDED.actor_role,
           actor_id   = EXCLUDED.actor_id,
           note       = COALESCE(EXCLUDED.note, giniflow_lab_case_actions.note)
     RETURNING action, created_at`,
    [caseNo, action, actorRole, actorId, note],
  );
  return { caseNo, ...rows[0] };
}

// Uploading a report against a HealthRay-run case.
//
// The sync normally fetches the PDF itself (`downloadAndStoreLabPdf`), but it
// only can once HealthRay has produced one — today 41 of 46 reported cases have
// no file. This is the manual path for the rest, authorised deliberately: an
// admin may attach the report they were handed on paper.
//
// It writes exactly what the automatic path writes — the same
// `patients/<id>/lab/<name>` storage path, the same `documents` row keyed on
// `lab_case:<caseNo>`, the same `pdf_storage_path` — so the two can never
// produce two copies of one report, and a later automatic fetch upserts over it
// rather than duplicating.
//
// It does NOT touch `reported_on` or `results_synced`. Attaching a file is not
// the lab signing a case out, and claiming otherwise would put a case into
// "Reported" that the lab has not reported.
export async function uploadLabCaseReport(
  caseNo,
  { base64, fileName, mediaType = "application/pdf", actorId = null, confirmAdditional = false },
  db = pool,
) {
  if (!base64) throw Object.assign(new Error("No file was sent"), { status: 400 });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw Object.assign(new Error("Storage is not configured"), { status: 503 });
  }

  const { rows } = await db.query(
    `SELECT lc.case_no, lc.case_date::text AS case_date, lc.pdf_storage_path,
            COALESCE(lc.patient_id, uid.id) AS patient_id,
            COALESCE(p.file_no, lc.raw_list_json->'patient'->>'healthray_uid') AS uhid,
            array_to_string(lc.test_names, ', ') AS tests
       FROM lab_cases lc
       LEFT JOIN patients uid ON uid.file_no = lc.raw_list_json->'patient'->>'healthray_uid'
       LEFT JOIN patients p ON p.id = lc.patient_id
      WHERE lc.case_no = $1`,
    [caseNo],
  );
  if (!rows.length) throw Object.assign(new Error("Lab case not found"), { status: 404 });
  const c = rows[0];
  // Without a patient the file has no chart to land on, and `documents` is keyed
  // on one. Refuse rather than store an orphan nobody will ever see.
  if (!c.patient_id) {
    throw Object.assign(new Error("This case is not linked to a patient yet"), { status: 409 });
  }
  if (c.pdf_storage_path && !confirmAdditional) {
    throw Object.assign(new Error("A report is already on this case"), {
      status: 409,
      needsConfirmation: "additional_report",
      existingSource: "hospital lab",
    });
  }

  const buffer = Buffer.from(base64, "base64");
  const MAX_BYTES = 10 * 1024 * 1024;
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error("Report is larger than 10 MB"), { status: 413 });
  }

  const ext = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/png" ? "png" : "pdf";
  const safeName = String(fileName || `lab_case_${caseNo}.${ext}`).replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `patients/${c.patient_id}/lab/${safeName}`;

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

  await db.query(
    `INSERT INTO documents
       (patient_id, doc_type, title, file_name, storage_path, mime_type, doc_date, source, notes)
     VALUES ($1, 'lab_report', $2, $3, $4, $5, $6::date, 'lab_healthray', $7)
     ON CONFLICT DO NOTHING`,
    [
      c.patient_id,
      c.tests ? `Lab Report - ${caseNo} — ${c.tests}` : `Lab Report - ${caseNo}`,
      safeName,
      storagePath,
      mediaType,
      c.case_date,
      `lab_case:${caseNo}`,
    ],
  );

  // pdf_unavailable cleared for the same reason the sync clears it: a file now
  // exists, so any earlier "no report found" verdict is stale.
  await db.query(
    `UPDATE lab_cases
        SET pdf_storage_path = $2, pdf_unavailable = FALSE, pdf_next_attempt_at = NULL
      WHERE case_no = $1`,
    [caseNo, storagePath],
  );

  await db.query(
    `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role, actor_id, note)
     VALUES ($1, 'report_uploaded', 'admin', $2, $3)
     ON CONFLICT (case_no, action) DO UPDATE
       SET actor_id = EXCLUDED.actor_id, note = EXCLUDED.note, created_at = NOW()`,
    [caseNo, actorId, safeName],
  );

  // Brief §2.3: uploading a report sets `results_status = 'ready'`, which is what
  // turns the patient green on the MO and consultant queues. The Gini queue does
  // this through `advanceSample`; a hospital case has no order to advance, so it
  // is written here — the same flag, for the same reason.
  //
  // Guarded, because "ready" is a claim about the WHOLE visit and this upload is
  // one case. It is only set when nothing else for that patient is still
  // outstanding:
  //
  //   · no other lab_case that day without a `reported_on` and without a file,
  //   · no Gini lab order that day still short of `uploaded`.
  //
  // Otherwise the MO would be told the results are in while a second panel is
  // still running — the exact failure the partial state exists to prevent.
  const ready = await db.query(
    `UPDATE giniflow_visits v
        SET results_status = 'ready', updated_at = NOW()
      WHERE v.patient_id = $1
        AND v.visit_date = $2::date
        AND v.results_status <> 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM lab_cases o
           WHERE o.case_date = v.visit_date
             AND o.case_no <> $3
             -- Match the patient properly. COALESCE(o.patient_id, $1) = $1 was
             -- here and is a trap: an unlinked case has a NULL patient_id, so it
             -- matched EVERY patient and blocked every upload. An unlinked case
             -- belongs to this patient only if its UHID says so.
             AND (o.patient_id = $1
                  OR (o.patient_id IS NULL
                      AND o.raw_list_json->'patient'->>'healthray_uid' = $4))
             AND o.raw_detail_json->>'reported_on' IS NULL
             AND o.pdf_storage_path IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM giniflow_lab_orders g
           WHERE g.visit_id = v.id AND g.sample_status <> 'uploaded'
        )
      RETURNING v.id`,
    [c.patient_id, c.case_date, caseNo, c.uhid],
  );

  return {
    caseNo,
    storagePath,
    fileName: safeName,
    bytes: buffer.length,
    // The screen says which happened: a report filed, or a report filed AND the
    // next station told. Reporting "results ready" when the guard declined would
    // be the toast lying about the board.
    markedResultsReady: ready.rowCount > 0,
  };
}
