import pool from "../../config/db.js";
import { promoteLabReport, promoteQuietly } from "./promote.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { advanceStatus } from "./statusEngine.js";
import { opensLabGate, outstandingOf } from "../../../shared/labPayment.js";
import {
  BOARD_COLUMNS,
  STATUS_LABEL,
  WAIT_STATUSES,
  columnForStatus,
} from "../../../shared/giniflowStatus.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import {
  LAB_RUNGS,
  LAB_STAGES,
  LAB_RAIL,
  LAB_SAMPLE_FLOW,
  NEXT_SAMPLE_ACTION,
  SAMPLE_STATUS_TO_STAGE,
  stageIndexOf,
  visibleRungs,
  roomOwns,
  CASE_ACTION_VERBS,
  nextOfferedFor,
  ACTION_NOUN,
  SAMPLE_STATUS_TO_BUCKET,
  BUCKET_TO_STAGE,
  FILTER_TO_TARGETS,
  FLOOR_ACTION_STAGE,
  markableRungs,
  railForStage,
} from "../../../shared/labStages.js";

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

export { LAB_SAMPLE_FLOW as SAMPLE_FLOW };

// An action is only offered by the room that owns the rung it lands on. Both
// rooms can SEE the handoff rungs — that is what makes the inbox work — so
// without this each would offer the other's next step and the service would
// refuse it on tap.
const roomAction = (sampleStatus, room) => {
  const rung = nextOfferedFor(SAMPLE_STATUS_TO_STAGE[sampleStatus], room);
  return rung ? { to: rung.advanceTo, label: rung.advanceLabel } : null;
};

const stepsFor = (sampleStatus, paid) => {
  const reached = paid ? railForStage[stageIndexOf(SAMPLE_STATUS_TO_STAGE[sampleStatus])] : 0;
  return [
    { name: "Payment ✓", state: paid ? "done" : "now" },
    ...LAB_RAIL.slice(1).map((name, i) => {
      const step = i + 1;
      return { name, state: step < reached ? "done" : step === reached ? "now" : "next" };
    }),
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

const unifiedFromOrder = (o) => ({
  key: `giniflow:${o.orderId}`,
  source: "giniflow",
  driven: true,
  stage: BUCKET_TO_STAGE[o.bucket] || "pending",
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
  key: `healthray:${r.rowKey}`,
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

// The page's filter groups → the Gini bucket and the HealthRay stage that make
// up each one. The two vocabularies differ, so the mapping lives here rather
// than being reconstructed on the client.
export const LAB_GROUPS = FILTER_TO_TARGETS;

export async function getLabQueue(
  visitDate,
  q = null,
  db = pool,
  { group = "all", room = null } = {},
) {
  const search = q && String(q).trim().length >= 2 ? String(q).trim() : null;
  const healthray = await getHealthrayCases(visitDate, search, db, room);
  const { rows } = await db.query(
    `SELECT o.id, o.visit_id, o.sample_status, o.payment_status, o.urgency,
            o.amount_total, o.amount_paid, o.amount_claimed, o.claim_state,
            o.created_at, o.updated_at, o.uploaded_at, o.report_file_url,
            p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
            v.current_status,
            d.short_name AS ordered_by,
            -- The chart row the report landed on, so the pane can open it in the
            -- viewer the rest of the app uses instead of throwing the file at a
            -- new browser tab.
            (SELECT doc.id FROM documents doc WHERE doc.giniflow_lab_order_id = o.id)
              AS report_doc_id,
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
      bucket: SAMPLE_STATUS_TO_BUCKET[r.sample_status] || "pending",
      steps: stepsFor(r.sample_status, paid),
      // Only offered once payment is cleared — and refused by the service too.
      // Room-scoped as well: the collection room sees a sample it has sent, and
      // its next step belongs to the analyzer bench. Offering a button that
      // answers 403 is worse than offering none.
      nextAction: paid ? roomAction(r.sample_status, room) : null,
      blockedReason: paid
        ? null
        : r.payment_status === "insurance_claim"
          ? `Insurance claim submitted — waiting for approval (₹${outstandingOf(r)} outstanding)`
          : `Waiting for reception to clear payment — ₹${outstandingOf(r)} outstanding`,
      orderedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      since:
        r.since || r.updated_at || r.created_at
          ? new Date(r.since || r.updated_at || r.created_at).toISOString()
          : null,
      uploadedAt: r.uploaded_at ? new Date(r.uploaded_at).toISOString() : null,
      reportUrl: r.report_file_url || null,
      reportDocId: r.report_doc_id || null,
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

  // Whole-day totals, computed before any filtering. The stats strip and the
  // filter chips both read these: derived from the returned array lengths they
  // would collapse to one non-zero group the moment a filter was applied.
  const rungs = visibleRungs(room);
  const inRoom = (stageKey) => rungs.some((r) => r.key === stageKey);
  const roomHealthray = room ? healthray.filter((r) => inRoom(r.stage.key)) : healthray;

  const bucketCounts = Object.fromEntries(rungs.map((r) => [r.bucket, by(r.bucket).length]));
  const groupCounts = Object.fromEntries(
    rungs.map((r) => [
      r.filter,
      by(r.bucket).length + roomHealthray.filter((h) => h.stage.key === r.key).length,
    ]),
  );

  const wanted = rungs.some((r) => r.filter === group) ? group : "all";
  const keep = (bucket) =>
    wanted === "all" || FILTER_TO_TARGETS[wanted].bucket === bucket ? by(bucket) : [];
  const keptHealthray =
    wanted === "all"
      ? roomHealthray
      : roomHealthray.filter((r) => r.stage.key === FILTER_TO_TARGETS[wanted].stage);

  return {
    group: wanted,
    room,
    counts: groupCounts,
    bucketCounts,
    ...Object.fromEntries(rungs.map((r) => [r.bucket, keep(r.bucket)])),
    healthray: keptHealthray,
    unified: room ? unified.filter((u) => inRoom(u.stage)) : unified,
    unifiedCounts,
    stages: rungs.map((r) => ({ key: r.key, label: r.stageLabel })),
    // The five counters at the top of the screen. They read 0 all day because
    // they only ever counted `giniflow_lab_orders`; the hospital's own cases
    // move through the same five stages and are simply added in, so the strip
    // describes the lab rather than one unused table.
    stageCounts: roomHealthray.reduce(
      (acc, r) => {
        r.caseList.forEach((c) => {
          if (c.stage.key in acc) acc[c.stage.key] += 1;
        });
        return acc;
      },
      Object.fromEntries(rungs.map((r) => [r.key, 0])),
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
const CASE_STAGE = LAB_RUNGS.map((r) => ({
  key: r.key,
  label: r.stageLabel,
  pill: r.pill,
  at: r.healthrayAt,
  since: r.sinceLabel,
}));

export { LAB_STAGES };

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
// ...and any stage BEYOND collection is proof too. HealthRay leaves
// phlebotomy_status at "In progress" on cases whose tube is demonstrably in the
// lab — case 19609 was received at 08:07 with the field never updated — so a
// case sitting in Processing was still being offered "✓ Mark sample collected".
// A tube cannot be run before it is drawn, and offering an action that cannot
// apply is how a technician is sent to draw blood twice.
const pastCollection = (c) => !!c.receivedOn || !!c.resultSavedOn || !!c.reportedOn;

// HealthRay's own evidence, and the only evidence this screen used to have.
const healthrayStage = (c) => {
  if (c.reportedOn) return stageIndexOf("reported");
  if (c.resultSavedOn) return stageIndexOf("results");
  if (c.receivedOn) return stageIndexOf("received");
  if (c.phlebotomy === "Completed" || !!c.collectedOn || pastCollection(c))
    return stageIndexOf("collected");
  return 0;
};

// What the floor recorded here. HealthRay learns a sample was drawn only when
// the RESULTS come back — `collected_on` rides in on `raw_detail_json`, hours
// later — and `phlebotomy_status`, the one live field, is left at "Pending" by
// the hospital's phlebotomists on most days. So a technician who has drawn every
// tube on the floor has no way to say so, and the queue keeps sending them back.
//
// These are the same three steps the Gini-ordered queue has in `SAMPLE_FLOW`.
// They are the floor's own account of the sample, never HealthRay's.

const floorStage = (c) =>
  (c.actions || []).reduce((max, a) => Math.max(max, FLOOR_ACTION_STAGE[a.action] ?? 0), 0);

// HealthRay wins wherever it is further along: it is authoritative about its own
// lab, and a case it has already received cannot be un-received by this screen.
// It simply has nothing to say for the first few hours, and that silence is what
// the floor's own record fills.
const STAGE_FOR_ACTION = Object.fromEntries(
  LAB_RUNGS.filter((r) => r.action).map((r) => [r.action, r.key]),
);

// R2 (35-LAB-TWO-ROOM-SPLIT-PLAN §3.3). The collection bench and the analyzer
// bench each own their own rungs, and hiding a button is not a rule — a screen
// left open in the wrong room, or a stale tab after a role change, must be
// refused here rather than silently recording one room's work against the other.
const assertRoomOwns = (room, stageKey) => {
  if (!room || !stageKey) return;
  if (!roomOwns(room, stageKey)) {
    throw Object.assign(
      new Error(`The ${room} room does not own this step — it belongs to the other lab room`),
      { status: 403 },
    );
  }
};

// Something to show for the case: a report file, or values typed against it.
// The lab may finish either way — a scan of a printout, or numbers the doctor
// can trend — and one of the two is what "done" is allowed to mean.
const hasEvidence = (c) => !!c.hasReport || !!c.hasValues;

const stageIndex = (c) => Math.max(healthrayStage(c), floorStage(c));

export const isCollected = (c) => stageIndex(c) >= stageIndexOf("collected");

// Whether a result exists yet — which gates BOTH the report drop zone and the
// typed-values form, because they are the same claim: the numbers are out.
//
// The bar is `results`, not the analyzer. A sample on the machine has no values
// yet, so offering either control at `processing` asks a technician to produce a
// result that does not exist — which is what the floor said when the form opened
// on a tube that had only just gone on. Somebody has to say the values are out,
// and that is what the `results` rung is for.
//
// HealthRay clears the bar on its own account: `result_saved_on` and
// `reported_on` both land past this rung, so a synced case opens the form
// without anybody on the floor tapping anything.
const canHaveReport = (c) => stageIndex(c) >= stageIndexOf("results");

// What the technician does next on a case Gini Flow does not own — the same
// question `NEXT_SAMPLE_ACTION` answers for a Gini order, so the two halves of this
// screen stop describing one physical act in two different vocabularies.
// Upload is deliberately absent: it is a file, handled by its own drop zone.
const CASE_NEXT_ACTION = markableRungs().map((r) => ({ action: r.action, label: r.actionLabel }));

// The rail and the pill are the SAME fact and must be computed from the same
// thing. Driving the rail off `results_synced` while the pill read HealthRay's
// timestamps let one card say "Sample at lab" beside a pill saying "Processing"
// — two names for one state, disagreeing on the same row. Both now come from
// the stage, so the rail simply marks how far along `CASE_STAGE` the case is.

// `CASE_STAGE` has five entries and the rail four, so the map is explicit: the
// index here is the rail step currently in progress. A case AT the analyzer has
// "Processing" as its live step, not as a finished one — and "Results done" and
// "Reported" collapse into one rail step, the first being the lab not having
// signed the case out yet.

const labSteps = (stage) => {
  const reached = railForStage[stage];
  return LAB_RAIL.map((name, i) => ({
    name,
    state: i < reached ? "done" : i === reached ? "now" : "next",
  }));
};

async function getHealthrayCases(visitDate, q = null, db = pool, room = null) {
  const { rows } = await db.query(
    `WITH cases AS (
       SELECT lc.*,
              COALESCE(lc.raw_detail_json, lc.raw_list_json) AS payload,
              -- A case the lab is still running has no patient_id: that column is
              -- stamped only once the detail fetch has written the values. The
              -- UHID is in the raw payload from the first list sync, so matching
              -- on it is what keeps outstanding work visible at all.
              COALESCE(lc.patient_id, uid.id) AS pid,
              -- What counts as "one patient" for grouping. pid alone cannot:
              -- every case the hospital registered for somebody with no chart
              -- here has pid NULL, and grouping on that collapses all of them
              -- into a single card carrying one arbitrary name. Unmatched cases
              -- fall back to HealthRay's own UHID, and to the case number when
              -- even that is absent, so a stranger is at worst their own row.
              COALESCE(
                (COALESCE(lc.patient_id, uid.id))::text,
                'hr:' || (lc.raw_list_json->'patient'->>'healthray_uid'),
                'case:' || lc.case_no
              ) AS grp
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
     SELECT c.grp,
            c.pid AS patient_id,
            COALESCE(p.name, max(c.raw_list_json->'patient'->>'patient_name')) AS name,
            COALESCE(p.file_no, max(c.raw_list_json->'patient'->>'healthray_uid')) AS file_no,
            p.age, p.sex,
            v.current_status, v.results_status, v.id IS NOT NULL AS on_floor,
            -- Constant across the group (it depends only on the patient and the
            -- day), so bool_or reads it without widening the GROUP BY.
            bool_or(${labOnlyPredicate("v", "$3")}) AS lab_only,
            count(*)::int AS cases,
            count(*) FILTER (WHERE NOT c.results_synced)::int AS pending,
            count(*) FILTER (WHERE c.results_synced
                               AND c.raw_detail_json->>'reported_on' IS NULL)::int AS partial,
            count(*) FILTER (WHERE c.results_synced
                               AND c.raw_detail_json->>'reported_on' IS NOT NULL)::int AS reported,
            (SELECT array_agg(DISTINCT t)
               FROM cases c2, unnest(c2.test_names) AS t
              WHERE c2.grp = c.grp) AS tests,
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
                -- The chart row the file landed on, so the pane can open it in
                -- the viewer every other screen already uses rather than
                -- inventing a second way to look at a PDF.
                'reportDocId', (
                  SELECT d.id FROM documents d
                   WHERE d.storage_path = c.pdf_storage_path
                   ORDER BY d.id DESC LIMIT 1
                ),
                -- Either kind of evidence closes a case: a file on the chart or
                -- values typed against it. "Done" must never be offered on a
                -- case carrying neither, or the doctor is told results are ready
                -- with nothing behind them.
                'hasValues', EXISTS (
                  SELECT 1 FROM lab_results lr WHERE lr.lab_case_no = c.case_no
                ),
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
      GROUP BY c.grp, c.pid, p.id, p.name, p.file_no, p.age, p.sex, v.current_status,
               v.results_status, v.id
      ORDER BY (count(*) FILTER (WHERE NOT c.results_synced)) DESC, min(c.fetched_at)`,
    [visitDate, q, LAB_ONLY_DOCTOR],
  );

  return rows.map((r) => {
    const counts = { pending: r.pending, partial: r.partial, reported: r.reported };
    // The LEAST advanced case is the patient's stage: with three samples out, the
    // one nobody has collected is what the floor is waiting on, not the one that
    // has already reported.
    const cases = (r.case_list || []).map((c) => {
      const idx = stageIndex(c);
      // Whose account this is. The lab must never read a tube the floor says it
      // drew as one HealthRay has confirmed, so the label carries its source —
      // but the case still leaves the "collect now" bucket, because it has been
      // drawn and sending somebody to draw it again is the actual harm.
      const onFloor = idx > healthrayStage(c);
      const at = (c.actions || []).find((a) => FLOOR_ACTION_STAGE[a.action] === idx);
      return {
        ...c,
        stage: onFloor
          ? { ...CASE_STAGE[idx], label: `${CASE_STAGE[idx].label} · floor` }
          : CASE_STAGE[idx],
        stageAt: (onFloor ? at?.at : c[CASE_STAGE[idx].at]) || null,
        // The screen's collect button keys off this, so it has to be the same
        // rule the stage uses: an absent `collected_on` is not evidence the sample
        // is still in the patient.
        collected: isCollected(c),
        // Only the floor's own steps are offerable, and only the next one. A case
        // HealthRay has already carried past this point needs nothing recorded.
        nextAction: (() => {
          const rung = nextOfferedFor(CASE_STAGE[idx].key, room, "actionLabel");
          if (!rung) return null;
          if (rung.action === "report_uploaded" && !hasEvidence(c)) return null;
          return { action: rung.action, label: rung.actionLabel };
        })(),
        canMarkDone: hasEvidence(c),
        canHaveReport: canHaveReport(c),
        state: !c.synced
          ? { key: "awaiting", label: "Awaiting results" }
          : !c.reported
            ? { key: "partial", label: "Partial — panels still coming in" }
            : { key: "reported", label: "Reported" },
      };
    });
    const lowest = cases.reduce(
      (worst, c) => (stageIndex(c) < stageIndex(worst) ? c : worst),
      cases[0],
    );
    return {
      rowKey: r.grp,
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
      // Samples-only patients carry a pre-consultation status but are not in
      // that queue — the manager board takes them out of it. Naming their
      // column here anyway is what had this screen calling a patient
      // "With SD / MO" while the board showed that column empty.
      labOnly: !!r.lab_only,
      station: r.on_floor
        ? FINISHED.includes(r.current_status)
          ? STATUS_LABEL[r.current_status] || r.current_status
          : r.lab_only
            ? null
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
      // The floor is stopped on this sample. `moStation`'s `awaitingResults` and
      // `doctorStation`'s `waitingOnLab` already say so — same rule, same two
      // facts — and this screen was the only one that did not, so one patient
      // read "awaiting results" on the MO board and "Waiting for Chief
      // Endocrinologist" here. The board column is where they are queued; it is
      // not what they are queued ON. Same-day bloods are what the MO cannot
      // proceed without, so the sample IS the wait.
      awaitingResults:
        r.on_floor &&
        !FINISHED.includes(r.current_status) &&
        !r.lab_only &&
        r.results_status !== "ready" &&
        r.pending + r.partial > 0,
      orderedBy: r.ordered_by || null,
      registeredAt: r.registered_at || null,
      reportedOn: r.reported_on || null,
      firstSeen: r.first_seen ? new Date(r.first_seen).toISOString() : null,
      lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
    };
  });
}

// The patient cannot be in two places at once, and the read side already says
// so: `collectable` is false while another station has them. That hid the
// button and stopped there, so a sample could still be recorded as drawn from a
// patient sitting in the MO's room — by a direct call, a stale tab, or a second
// technician on an older render. The payment gate below states the principle
// this now follows: a hidden button is not a rule.
async function assertPatientIsFree(db, visitId, what) {
  if (!visitId) return;
  const { rows } = await db.query(
    `SELECT v.current_status, p.name FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) return;
  const { current_status: status, name } = rows[0];
  if (IN_A_ROOM.includes(status)) {
    throw Object.assign(
      new Error(
        `${name} is with another station right now (${STATUS_LABEL[status] || status}) — ${what} once they are free`,
      ),
      { status: 409 },
    );
  }
  if (FINISHED.includes(status)) {
    throw Object.assign(new Error(`${name} has left the floor — ${what} is no longer possible`), {
      status: 409,
    });
  }
}

export async function advanceSample(
  orderId,
  { to, actorId = null, reportUrl = null, room = null },
  db = pool,
) {
  if (!LAB_SAMPLE_FLOW.includes(to)) {
    throw Object.assign(new Error(`Unknown sample status: ${to}`), { status: 400 });
  }
  assertRoomOwns(room, SAMPLE_STATUS_TO_STAGE[to]);

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

    const fromIdx = LAB_SAMPLE_FLOW.indexOf(from);
    const toIdx = LAB_SAMPLE_FLOW.indexOf(to);
    if (toIdx <= fromIdx) {
      // Two technicians tapping the same card is a no-op, not an error and not a
      // second event.
      await client.query("COMMIT");
      return { orderId, sampleStatus: from, unchanged: true };
    }

    // After the no-op check, so re-tapping a sample already collected stays a
    // no-op rather than becoming an error about where the patient is now.
    if (to === "sample_collected") {
      await assertPatientIsFree(client, visitId, "collect the sample");
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
      // "Reports arrived" is a fact about the patient, not a place they moved
      // to. This used to go through advanceStatus, which sets current_status —
      // and `results_received` is in no chain, so every call threw into a bare
      // catch and the log gained nothing. Written directly, the event exists
      // and the patient stays exactly where they are.
      await client.query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
         VALUES ($1, 'results_received', 'lab', $2, $3)`,
        [visitId, actorId, { source: "lab_upload", lab_order_id: orderId }],
      );
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
export const CASE_ACTIONS = CASE_ACTION_VERBS;

export async function markLabCaseAction(
  caseNo,
  { action, actorId = null, actorRole = "lab", note = null, undo = false, room = null },
  db = pool,
) {
  if (!CASE_ACTIONS.includes(action)) throw new Error(`Unknown lab case action: ${action}`);
  assertRoomOwns(room, STAGE_FOR_ACTION[action]);

  const { rows: known } = await db.query(`SELECT 1 FROM lab_cases WHERE case_no = $1 LIMIT 1`, [
    caseNo,
  ]);
  if (!known.length) throw Object.assign(new Error(`No such lab case: ${caseNo}`), { status: 404 });

  if (!undo) {
    // Where HealthRay and the floor each think this case is. A screen open since
    // before the lab received the tube would otherwise write "collected by"
    // against a sample somebody else drew, and that name is the only record of
    // who drew it.
    const { rows: state } = await db.query(
      `SELECT lc.raw_list_json->>'phlebotomy_status' AS phlebotomy,
              lc.raw_list_json->>'collected_on'      AS "collectedOn",
              lc.raw_list_json->>'received_on'       AS "receivedOn",
              lc.raw_list_json->>'result_saved_on'   AS "resultSavedOn",
              lc.raw_list_json->>'reported_on'       AS "reportedOn",
              COALESCE(
                (SELECT json_agg(json_build_object('action', a.action))
                   FROM giniflow_lab_case_actions a WHERE a.case_no = lc.case_no),
                '[]'::json
              ) AS actions
         FROM lab_cases lc WHERE lc.case_no = $1`,
      [caseNo],
    );
    const c = state[0] || {};
    // The rung this action lands on, asked of the ladder rather than inferred
    // from a position in CASE_ACTIONS — the two agree today only because both
    // are built from the same rungs, and an ordering bug here would let a case
    // claim a stage the lab never reached.
    const want = stageIndexOf(STAGE_FOR_ACTION[action]);

    // HealthRay has already carried the case past this point, so recording it
    // here would only add a name to work somebody else did.
    if (healthrayStage(c) >= want) {
      throw Object.assign(
        new Error(`The lab has already taken this case past ${ACTION_NOUN[action]}`),
        { status: 409 },
      );
    }
    // The steps are a sequence, not a set: a tube cannot be run before it is
    // drawn. Without this a mis-tap on the last button silently skips the ones
    // before it and the case reports a stage the lab never reached.
    //
    // One exception, at the handoff. `sample_received` is the analyzer room's
    // FIRST act and the collection room's paperwork is not its to fix: if Lab 1
    // drew the tube and walked it over without tapping "sent", Lab 2 is holding
    // it and must still be able to say so. Receipt is its own proof of sending.
    // Every other step still needs the one before it.
    const floor = action === "sample_received" ? stageIndexOf("collected") : want - 1;
    if (stageIndex(c) < floor) {
      throw Object.assign(
        new Error(`Record ${ACTION_NOUN[LAB_RUNGS[floor].action] || "the previous step"} first`),
        { status: 409 },
      );
    }
  }

  // "Done" is a claim that a result exists, so it is checked against the record
  // rather than against which button the screen happened to show. Without this a
  // stale tab, or a direct call, could close a case with no file and no values —
  // and closing it tells the MO and the consultant that results are ready.
  if (action === "report_uploaded" && !undo) {
    const { rows: proof } = await db.query(
      `SELECT lc.pdf_storage_path IS NOT NULL AS has_report,
              EXISTS (SELECT 1 FROM lab_results lr WHERE lr.lab_case_no = lc.case_no) AS has_values
         FROM lab_cases lc WHERE lc.case_no = $1`,
      [caseNo],
    );
    if (!proof[0]?.has_report && !proof[0]?.has_values) {
      throw Object.assign(
        new Error(
          "Nothing to mark done — type the values in, or attach the report, before closing this case",
        ),
        { status: 409 },
      );
    }
  }

  if (action === "sample_taken" && !undo) {
    // Only lc.patient_id. The fallback matched patients.file_no against
    // HealthRay's UHID, and HealthRay REASSIGNS a UHID to a different person
    // over time — so on a case whose patient was never linked, this could find
    // somebody else's visit and refuse a legitimate collection while naming the
    // wrong patient. A guard that cannot identify the patient does not guess at
    // one: it steps aside, and the desk's own eyes are the check.
    const { rows: visit } = await db.query(
      `SELECT v.id FROM lab_cases lc
         JOIN giniflow_visits v
           ON v.visit_date = lc.case_date AND v.patient_id = lc.patient_id
        WHERE lc.case_no = $1 AND lc.patient_id IS NOT NULL
        LIMIT 1`,
      [caseNo],
    );
    await assertPatientIsFree(db, visit[0]?.id, "collect the sample");
  }

  if (undo) {
    // Taking back a step takes back what was built on it. Deleting `sample_taken`
    // alone would leave a case recorded as processing a tube nobody drew, which
    // is a worse statement than either the technician made.
    await db.query(
      `DELETE FROM giniflow_lab_case_actions
        WHERE case_no = $1 AND action = ANY($2::text[])`,
      [caseNo, CASE_ACTIONS.slice(CASE_ACTIONS.indexOf(action))],
    );
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

  // Closing the case is what tells the floor. Recording "done" and leaving the
  // visit alone would clear the lab's own board while the MO and the consultant
  // went on waiting — the same two-screens-one-case disagreement that closing
  // exists to end. Guarded inside `markCaseResultsReady`, so a patient with a
  // second sample still out stays amber.
  let markedResultsReady = false;
  if (action === "report_uploaded" && !undo) {
    const { rows: ctx } = await db.query(
      `SELECT lc.patient_id, lc.case_date,
              lc.raw_list_json->'patient'->>'healthray_uid' AS uhid
         FROM lab_cases lc WHERE lc.case_no = $1`,
      [caseNo],
    );
    if (ctx[0]?.patient_id) {
      const ready = await markCaseResultsReady(db, {
        patientId: ctx[0].patient_id,
        caseDate: ctx[0].case_date,
        caseNo,
        uhid: ctx[0].uhid,
      });
      markedResultsReady = ready.rowCount > 0;
    }
  }

  return { caseNo, ...rows[0], markedResultsReady };
}

// Taking a wrongly-attached report back off a case.
//
// Only while the case is still open: once it is marked done the report is what
// the MO and the consultant were told about, and pulling it out from under them
// silently is not this screen's to do. The file, the chart row and the case's
// pointer to it go together — leaving any one behind is how a case ends up
// claiming a report nobody can open.
export async function deleteLabCaseReport(caseNo, db = pool) {
  const { rows } = await db.query(
    `SELECT lc.pdf_storage_path,
            EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                     WHERE a.case_no = lc.case_no AND a.action = 'report_uploaded') AS is_done
       FROM lab_cases lc WHERE lc.case_no = $1`,
    [caseNo],
  );
  if (!rows.length) throw Object.assign(new Error(`No such lab case: ${caseNo}`), { status: 404 });
  const { pdf_storage_path: storagePath, is_done: isDone } = rows[0];
  if (!storagePath) {
    throw Object.assign(new Error("There is no report on this case to remove"), { status: 409 });
  }
  if (isDone) {
    throw Object.assign(
      new Error("This case is marked done — undo that first if the report needs replacing"),
      { status: 409 },
    );
  }

  await db.query(`DELETE FROM documents WHERE storage_path = $1`, [storagePath]);
  await db.query(`UPDATE lab_cases SET pdf_storage_path = NULL WHERE case_no = $1`, [caseNo]);
  await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  }).catch(() => {});

  return { caseNo, removed: storagePath };
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
// Brief §2.3: a result landing sets `results_status = 'ready'`, which is what
// turns the patient green on the MO and consultant queues. The Gini queue does
// this through `advanceSample`; a hospital case has no order to advance, so it is
// written here — the same flag, for the same reason.
//
// Guarded, because "ready" is a claim about the WHOLE visit and one case is one
// panel. It is set only when nothing else for that patient that day is still
// outstanding, or the MO is told the results are in while a second panel is still
// running — the exact failure the partial state exists to prevent.
//
// A case counts as finished when HealthRay has reported it, when a file is
// stored, when the lab typed its values, or when the floor marked it results-done.
// The first two were the whole test until typed values existed for hospital cases,
// which left a patient whose numbers were all typed waiting on themselves.
export async function markCaseResultsReady(db, { patientId, caseDate, caseNo, uhid }) {
  const { rowCount } = await db.query(
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
             AND NOT EXISTS (
               SELECT 1 FROM lab_results lr WHERE lr.lab_case_no = o.case_no
             )
             AND NOT EXISTS (
               SELECT 1 FROM giniflow_lab_case_actions a
                WHERE a.case_no = o.case_no AND a.action = 'results_ready'
             )
        )
        AND NOT EXISTS (
          SELECT 1 FROM giniflow_lab_orders g
           WHERE g.visit_id = v.id AND g.sample_status <> 'uploaded'
        )
      RETURNING v.id`,
    [patientId, caseDate, caseNo, uhid],
  );
  return { rowCount };
}

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

  // Deliberately NOT `report_uploaded`. That action is what CLOSES the case, and
  // storing a file is not the same statement as being finished with it: the lab
  // needs a window to open the report, see it is the right one, and replace or
  // remove it before saying done. The file itself is the evidence that unlocks
  // the "Mark done" button; the tap is what ends the case.

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
  const ready = await markCaseResultsReady(db, {
    patientId: c.patient_id,
    caseDate: c.case_date,
    caseNo,
    uhid: c.uhid,
  });

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
