import pool from "../../config/db.js";
import { toLocal10 } from "../../../shared/phone.js";
import {
  BOARD_COLUMNS,
  OFF_BOARD_STATUSES,
  compareQueue,
  columnForStatus,
  STATUS_LABEL,
  slaKeyForStatus,
  TERMINAL_STATUSES,
} from "../../../shared/giniflowStatus.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import { IST_TODAY, budgetColour } from "./statusEngine.js";

export async function getSlaConfig(db = pool) {
  const { rows } = await db.query(
    `SELECT station, label, description, budget_minutes, category_overrides, display_order
       FROM giniflow_sla_config ORDER BY display_order`,
  );
  return rows.map((r) => ({
    station: r.station,
    label: r.label,
    description: r.description,
    budgetMinutes: r.budget_minutes,
    categoryOverrides: r.category_overrides,
    displayOrder: r.display_order,
  }));
}

export const budgetMap = (slaConfig) =>
  Object.fromEntries(slaConfig.map((s) => [s.station, s.budgetMinutes]));

// Per-category budgets (brief §3 `sla_config.category_overrides`, Phase 4).
//
// A station's budget is not one number for every patient. A red-category
// patient — worse and out of range — is meant to take the doctor longer than an
// in-control follow-up, and judging both against 20 minutes makes the board lie
// twice: the careful consultation shows red, and the rushed one shows green.
//
// `budgetMap` stays for the callers with no patient in hand — the timeline's
// lab_total, the day's per-station averages, which are across all categories by
// definition. Anything looking at ONE visit resolves through this instead.
//
// The override is a plain `{category: minutes}` object on the row; anything
// missing, null, or non-positive falls back to the station budget, so a
// half-filled override cannot blank a budget out.
export const budgetLookup = (slaConfig) => {
  const byStation = new Map(slaConfig.map((s) => [s.station, s]));
  return (station, category = null) => {
    const row = byStation.get(station);
    if (!row) return null;
    const override = category ? row.categoryOverrides?.[category] : null;
    return Number.isFinite(override) && override > 0 ? override : (row.budgetMinutes ?? null);
  };
};

// One round trip for the whole day. The lateral joins keep it to a single query
// no matter how many visits the day has — the board polls every 10s and a
// per-visit follow-up query would multiply that by the floor's population.
const BOARD_SQL = `
  SELECT v.id,
         v.patient_id,
         v.visit_date::text                        AS visit_date,
         v.current_status,
         v.results_status,
         v.category,
         v.blocked_reason,
         v.resume_status,
         v.priority,
         v.priority_reason,
         v.queue_position,
         v.queue_column,
         v.appointment_time::text                  AS appointment_time,
         p.name                                    AS patient_name,
         p.file_no,
         p.age,
         p.sex,
         v.assigned_doctor_id,
         sd.short_name                             AS sd_name,
         doc.short_name                            AS doctor_name,
         doc.name                                  AS doctor_full_name,
         seq.visit_number,
         ${labOnlyPredicate("v", "$2")}            AS lab_only,
         tests.names                               AS lab_test_names,
         tests.cases                               AS lab_all_cases,
         tests.reported                            AS lab_all_reported,
         first_ev.occurred_at                      AS journey_started_at,
         last_ev.occurred_at                       AS status_since,
         lab.sample_status                         AS lab_sample_status,
         lab.payment_status                        AS lab_payment_status,
         lab.test_count                            AS lab_test_count,
         lab.since                                 AS lab_since,
         hrlab.cases                               AS hr_lab_cases,
         hrlab.tests                               AS hr_lab_tests,
         hrlab.since                               AS hr_lab_since,
         hrlab.collected                           AS hr_lab_collected,
         hrlab.at_lab                              AS hr_lab_at_lab
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors sd  ON sd.id  = v.assigned_sd_id
    LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
    LEFT JOIN LATERAL (
      -- The patient's real visit sequence. giniflow_visits alone would always
      -- say 1 — it has no history before today (GF-05).
      SELECT COUNT(*)::int + 1 AS visit_number
        FROM appointments pa
       WHERE pa.patient_id = v.patient_id
         AND pa.appointment_date < v.visit_date
         AND pa.status = 'completed'
    ) seq ON TRUE
    LEFT JOIN LATERAL (
      SELECT e.occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND e.status = 'checked_in'
       ORDER BY e.occurred_at LIMIT 1
    ) first_ev ON TRUE
    LEFT JOIN LATERAL (
      SELECT e.occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
    ) last_ev ON TRUE
    LEFT JOIN LATERAL (
      SELECT o.sample_status, o.payment_status, o.updated_at AS since,
             (SELECT COUNT(*)::int FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS test_count
        FROM giniflow_lab_orders o
       WHERE o.visit_id = v.id AND o.sample_status <> 'uploaded'
         -- Today's tests only, the same rule the lab station and the reception
         -- desk already apply. Without it a test ordered for the patient's NEXT
         -- visit joined today's lab track: payment pending at a desk collecting
         -- nothing, a sample nobody was waiting for, and — because a Gini order
         -- is the only lab card carrying a budget — a red Lab column driven
         -- entirely by work that is not due.
         --
         -- It also settles the LIMIT 1 below. A next-visit order is written at
         -- the end of a consultation, so it is newer than a same-day one and
         -- would otherwise hide the today sample the floor is actually waiting on.
         AND o.urgency = 'today'
       ORDER BY o.created_at DESC LIMIT 1
    ) lab ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS cases,
             sum(coalesce(array_length(lc.test_names, 1), 0))::int AS tests,
             min(COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'registered_at') AS since,
             bool_or(
               lc.raw_list_json->>'phlebotomy_status' = 'Completed'
               OR (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'collected_on') IS NOT NULL
             ) AS collected,
             bool_or(
               (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'received_on') IS NOT NULL
             ) AS at_lab
        FROM lab_cases lc
       WHERE lc.case_date = v.visit_date
         AND (lc.patient_id = v.patient_id
              OR (lc.patient_id IS NULL
                  AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
         AND lc.raw_detail_json->>'reported_on' IS NULL
         AND lc.pdf_storage_path IS NULL
      HAVING count(*) > 0
    ) hrlab ON TRUE
    LEFT JOIN LATERAL (
      -- Every lab case of the day, reported ones included — which is what
      -- separates it from the hrlab lateral above. hrlab answers "what is the lab still
      -- working on"; this answers "what did this patient come to give", and a
      -- samples-only patient whose reports are already back still has to appear
      -- somewhere.
      SELECT count(DISTINCT lc.id)::int                                       AS cases,
             count(DISTINCT lc.id) FILTER (
               WHERE COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' IS NOT NULL
             )::int                                                            AS reported,
             array_remove(array_agg(DISTINCT t), NULL)                         AS names
        FROM lab_cases lc
        LEFT JOIN LATERAL unnest(COALESCE(lc.test_names, ARRAY[]::text[])) t ON TRUE
       WHERE lc.case_date = v.visit_date
         AND (lc.patient_id = v.patient_id
              OR (lc.patient_id IS NULL
                  AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
      HAVING count(*) > 0
    ) tests ON TRUE
   WHERE v.visit_date = $1::date
   ORDER BY last_ev.occurred_at NULLS LAST`;

const minutesSince = (from, now) =>
  from ? Math.max(0, Math.round((now - new Date(from)) / 60000)) : null;

const istClock = (ts) =>
  ts
    ? new Date(ts).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      })
    : null;

const subtitleFor = (row) => {
  if (row.blocked_reason) return row.blocked_reason;
  // A queueing patient's most useful fact is when they arrived (GF-06).
  if (["checked_in", "vitals_pending"].includes(row.current_status)) {
    const at = istClock(row.journey_started_at);
    return at ? `${at} check-in` : "Checked in";
  }
  if (row.current_status === "with_sd" && row.sd_name) return `${row.sd_name} · workup`;
  if (row.current_status === "with_doctor" && row.doctor_name)
    return `${row.doctor_name} · consult`;
  if (row.current_status === "ready_for_doctor")
    return row.results_status === "ready" ? "Results ✓ · SD plan ready" : "SD plan ready";
  if (row.current_status === "with_vitals") return "BP + weight in progress";
  if (row.current_status === "pharmacy_pending") return "Dispensing";
  if (["dispensed", "exited"].includes(row.current_status)) return "Exited";
  return STATUS_LABEL[row.current_status] || row.current_status;
};

// The one-line note under a card explaining what it is waiting on. Blocked
// reasons take precedence and are rendered in the red variant by the board.
const hintFor = (row) => {
  if (row.blocked_reason) return null;
  if (row.current_status === "checked_in" || row.current_status === "vitals_pending")
    return "Waiting for vitals station";
  if (row.current_status === "ready_for_doctor" && row.category === "in_control")
    return "Green category — SD could close";
  if (row.current_status === "sd_pending") return "Waiting for SD / MO";
  return null;
};

const hintIconFor = (row) =>
  row.current_status === "ready_for_doctor" && row.category === "in_control" ? "💡" : "→";

// What the lab card is waiting on, distinct from the main journey's hints (GF-19).
const LAB_HINT = {
  payment_pending: "Waiting: reception payment",
  results_ready: "Upload pending",
  processing: null,
  sample_collected: null,
  paid: "Waiting: sample collection",
  ordered: "Waiting: payment request",
};

// A samples-only patient still on the board once the lab has finished with
// them. `hrlab` has dropped them — nothing is pending — so the lab track builds
// its own line rather than showing an empty card.
const labOnlySummary = (row) => {
  const cases = row.lab_all_cases ?? 0;
  const reported = row.lab_all_reported ?? 0;
  if (!cases) return { subtitle: "Registered · no case yet", hint: "Waiting: sample collection" };
  if (reported >= cases) return { subtitle: "✅ Reports ready", hint: null };
  return { subtitle: `${reported} of ${cases} reported`, hint: null };
};

const LAB_SUBTITLE = {
  ordered: "Ordered",
  payment_pending: "💰 Payment pending at reception",
  paid: "Paid · awaiting collection",
  sample_collected: "Sample collected",
  processing: "⚙️ Processing in analyzer",
  results_ready: "📤 Results ready — awaiting upload",
};

export async function getDayBoard(visitDate, slaConfig, now = new Date(), db = pool) {
  const budgets = budgetMap(slaConfig);
  const budgetFor = budgetLookup(slaConfig);
  const { rows } = await db.query(BOARD_SQL, [visitDate, LAB_ONLY_DOCTOR]);

  const cards = rows.map((row) => {
    // A finished visit's clock stopped when it exited; only a patient still in
    // the building is timed against the present moment.
    const finished = TERMINAL_STATUSES.includes(row.current_status);
    const clock = finished && row.status_since ? new Date(row.status_since) : now;
    const statusMinutes = finished ? null : minutesSince(row.status_since, now);
    const totalMinutes = minutesSince(row.journey_started_at, clock);
    const budget = budgetFor(slaKeyForStatus(row.current_status), row.category);
    // Settled entirely in SQL by labOnlyPredicate, so this board and the lab
    // station cannot drift apart on who counts as samples-only.
    const labOnly = !!row.lab_only;
    const labOnlyLine = labOnly ? labOnlySummary(row) : null;
    return {
      id: row.id,
      patientId: row.patient_id,
      name: row.patient_name,
      fileNo: row.file_no,
      age: row.age,
      sex: row.sex,
      visitNumber: row.visit_number,
      status: row.current_status,
      statusLabel: STATUS_LABEL[row.current_status] || row.current_status,
      category: row.category,
      resultsStatus: row.results_status,
      blockedReason: row.blocked_reason,
      // Carried to the card so the client can tell, before a drag starts, which
      // columns this patient may legally be dropped on.
      resumeStatus: row.resume_status,
      priority: row.priority,
      priorityReason: row.priority_reason,
      // A manual position belongs to the queue it was set in. advanceStatus
      // clears it on every move, but a status written by any other path — the
      // demo seeder, a backfill, a manual UPDATE — would otherwise leave a
      // position behind that pins the patient to the top of a column they have
      // already left (BQ-06). Trusting the stored column rather than the
      // clearing makes that impossible by construction.
      queuePosition:
        row.queue_column && row.queue_column === columnForStatus(row.current_status)
          ? row.queue_position
          : null,
      labOnly,
      // Nothing left for the lab to do. Used to retire a finished patient from
      // the lab track: a sample that was never collected is still worth showing
      // after they leave, a report that is already back is not.
      labSettled:
        labOnly && (row.lab_all_cases ?? 0) > 0 && (row.lab_all_reported ?? 0) >= row.lab_all_cases,
      labTests: row.lab_test_names || [],
      assignedDoctorId: labOnly ? null : row.assigned_doctor_id,
      assignedDoctorName: labOnly ? null : row.doctor_name || row.doctor_full_name || null,
      subtitle: subtitleFor(row),
      hint: hintFor(row),
      hintIcon: hintIconFor(row),
      finished,
      statusSince: row.status_since ? new Date(row.status_since).toISOString() : null,
      journeyStartedAt: row.journey_started_at
        ? new Date(row.journey_started_at).toISOString()
        : null,
      statusMinutes,
      statusBudget: budget,
      statusColour: finished ? "green" : budgetColour(statusMinutes ?? 0, budget),
      totalMinutes,
      totalBudget: budgets.total_journey ?? null,
      totalOver: totalMinutes !== null && totalMinutes > (budgets.total_journey ?? Infinity),
      lab: row.lab_sample_status
        ? {
            since: row.lab_since ? new Date(row.lab_since).toISOString() : null,
            sampleStatus: row.lab_sample_status,
            paymentStatus: row.lab_payment_status,
            testCount: row.lab_test_count,
            subtitle: LAB_SUBTITLE[row.lab_sample_status] || row.lab_sample_status,
            minutes: minutesSince(row.lab_since, now),
            budget: budgets.lab_total ?? null,
            colour: budgetColour(minutesSince(row.lab_since, now) ?? 0, budgets.lab_total ?? null),
            hint: LAB_HINT[row.lab_sample_status] || null,
            hintIcon: row.lab_sample_status === "payment_pending" ? "💰" : "📤",
            blocking: row.lab_sample_status === "payment_pending",
            source: "giniflow",
            atLab: ["sample_collected", "processing", "results_ready"].includes(
              row.lab_sample_status,
            ),
          }
        : row.hr_lab_cases
          ? {
              since: row.hr_lab_since ? new Date(row.hr_lab_since).toISOString() : null,
              sampleStatus: row.hr_lab_at_lab
                ? "processing"
                : row.hr_lab_collected
                  ? "sample_collected"
                  : "paid",
              paymentStatus: null,
              testCount: row.hr_lab_tests ?? 0,
              subtitle: row.hr_lab_at_lab
                ? LAB_SUBTITLE.processing
                : row.hr_lab_collected
                  ? LAB_SUBTITLE.sample_collected
                  : "Awaiting collection",
              minutes: minutesSince(row.hr_lab_since, now),
              budget: null,
              colour: "grey",
              hint: row.hr_lab_at_lab || row.hr_lab_collected ? null : LAB_HINT.paid,
              hintIcon: "🧪",
              blocking: false,
              source: "healthray",
              caseCount: row.hr_lab_cases,
              atLab: !!row.hr_lab_at_lab,
            }
          : labOnlyLine
            ? {
                since: row.journey_started_at
                  ? new Date(row.journey_started_at).toISOString()
                  : null,
                // Derived, never assumed. Hardcoding results_ready/atLab:false
                // told the card the patient had left without giving a sample
                // while the row beside it read "Reports ready" — a report
                // cannot exist without a sample.
                sampleStatus: !row.lab_all_cases
                  ? "paid"
                  : (row.lab_all_reported ?? 0) >= row.lab_all_cases
                    ? "results_ready"
                    : "processing",
                paymentStatus: null,
                testCount: (row.lab_test_names || []).length,
                subtitle: labOnlyLine.subtitle,
                minutes: minutesSince(row.journey_started_at, clock),
                budget: null,
                colour: "grey",
                hint: labOnlyLine.hint,
                hintIcon: "🧪",
                blocking: false,
                source: "healthray",
                caseCount: row.lab_all_cases ?? 0,
                // A case that exists is a sample that was given.
                atLab: (row.lab_all_cases ?? 0) > 0,
              }
            : null,
    };
  });

  const onFloor = cards.filter((c) => !OFF_BOARD_STATUSES.includes(c.status));

  const columns = BOARD_COLUMNS.map((col) => {
    // Samples-only patients are kept out of the consultation columns entirely.
    // They never reach a doctor, so leaving them in Checked-in and With SD / MO
    // filled both with a queue nobody was working — on 5 Sep three of the seven
    // patients on the floor were sitting in SD / MO for exactly that reason.
    // The lab track keeps them reachable, which is what the coordinator needs to
    // assign one to a consultant.
    const items =
      col.key === "lab"
        ? // A finished patient stays in the lab track only while the lab still
          // holds something of theirs. Once the reports are back and they have
          // gone home there is nothing to work, and leaving them here is what
          // kept an exited patient sitting in the column all day.
          onFloor.filter((c) => c.lab && !(c.finished && c.labSettled))
        : // "Done today" is a record of who finished, and a samples-only patient
          // who exited did finish — it is only the consultation queues they do
          // not belong in. Without this they had nowhere to go but the lab track.
          onFloor.filter(
            (c) => (!c.labOnly || col.key === "done") && col.statuses.includes(c.status),
          );
    const budget = budgets[col.slaKey] ?? null;
    // Blocked patients are excluded from the average: they are stuck on missing
    // reports, not on this station's throughput, and letting them skew it points
    // the bottleneck banner at the wrong station.
    const timedCards = items.filter((c) => !c.blockedReason);
    const timed =
      col.key === "lab"
        ? timedCards.filter((c) => c.lab.budget).map((c) => c.lab.minutes ?? 0)
        : timedCards.map((c) => c.statusMinutes ?? 0);
    const avg = timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : 0;
    return {
      ...col,
      budgetMinutes: budget,
      count: items.length,
      avgMinutes: avg,
      hot: col.key !== "done" && !!budget && timed.length > 0 && avg > budget,
      // Sorted here rather than only in the component so every consumer of the
      // board — the day report, a future station screen — sees the same queue
      // the floor manager arranged.
      // The lab track is timed on its own clock against the lab_total budget, so
      // compareQueue's last tiebreak — statusMinutes — would order it by how long
      // the patient has been waiting somewhere else entirely (BQ-04). It keeps
      // the SQL's ordering, as Done does.
      cards: col.key === "done" || col.key === "lab" ? items : [...items].sort(compareQueue),
    };
  });

  return { cards, onFloor, columns };
}

// Server-side patient search across one day's board. Server-side because the
// floor can hold 100+ patients and the answer must not depend on which cards a
// column happened to have rendered — and because matching a phone number means
// normalising it the same way the rest of the repo does.
//
// Returns visit ids; the board filters itself to them. Scoped to the day, so it
// can never become a back-door patient directory.
export async function searchDayVisits(visitDate, query, db = pool) {
  const raw = String(query || "").trim();
  if (raw.length < 2) return [];

  const digits = toLocal10(raw);
  // A short numeric string is a partial phone or a file number, not a 10-digit
  // mobile — match it as a suffix so "1547" finds P_181547 and ...81547.
  const numeric = raw.replace(/\D/g, "");

  // LIKE patterns are built here rather than concatenated in SQL. Two untyped
  // operands make Postgres resolve `||` to ARRAY concatenation, which fails with
  // "malformed array literal" — and a complete parameter is clearer anyway.
  const like = `%${raw}%`;
  const phoneSuffix = digits.length === 10 ? `%${digits}` : null;
  const numericLike = numeric ? `%${numeric}%` : null;

  const { rows } = await db.query(
    `SELECT v.id, v.current_status, p.name, p.file_no, p.age, p.sex
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.visit_date = $1::date
        AND NOT COALESCE(p.is_blocked, FALSE)
        AND (
          p.name ILIKE $2
          OR p.file_no ILIKE $2
          OR ($3::text IS NOT NULL AND regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g') LIKE $3)
          OR ($4::text IS NOT NULL AND regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g') LIKE $4)
          -- alt_phone is text[], not text: a patient may carry several numbers.
          -- Match any element, digits-only, the same way the primary phone is matched.
          OR (
            $4::text IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM unnest(COALESCE(p.alt_phone, ARRAY[]::text[])) AS alt
               WHERE regexp_replace(alt, '\\D', '', 'g') LIKE $4
            )
          )
        )
      ORDER BY p.name
      LIMIT 50`,
    [visitDate, like, phoneSuffix, numericLike],
  );

  return rows.map((r) => ({
    visitId: r.id,
    name: r.name,
    fileNo: r.file_no,
    age: r.age,
    sex: r.sex,
    status: r.current_status,
  }));
}

export function getBottleneck(columns) {
  const candidates = columns
    .filter(
      (c) => c.key !== "done" && c.budgetMinutes && c.count > 0 && c.avgMinutes > c.budgetMinutes,
    )
    .map((c) => ({ column: c, overBy: c.avgMinutes - c.budgetMinutes }))
    .sort((a, b) => b.overBy - a.overBy);

  if (!candidates.length) return null;

  const { column } = candidates[0];
  const longest = [...column.cards.filter((c) => !c.blockedReason)].sort(
    (a, b) => (b.statusMinutes ?? 0) - (a.statusMinutes ?? 0),
  )[0];

  const greenWaiting =
    column.key === "wait_doctor" &&
    column.cards.filter((c) => c.category === "in_control").length > 0;

  return {
    station: column.key,
    label: column.name,
    count: column.count,
    avgMinutes: column.avgMinutes,
    budgetMinutes: column.budgetMinutes,
    longest: longest
      ? { id: longest.id, name: longest.name, minutes: longest.statusMinutes }
      : null,
    suggestion: greenWaiting
      ? "SD closes green-category patients directly."
      : `Add capacity at ${column.name.toLowerCase()} or hold new check-ins.`,
  };
}

export async function getDayStats(visitDate, board, slaConfig, db = pool) {
  const budgets = budgetMap(slaConfig);
  // "of N booked" is the day's expected patients: scheduled appointments that
  // were not cancelled and did not no-show, excluding blocked patients the way
  // every other list in this repo does (GF-10).
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE a.status NOT IN ('cancelled', 'no_show'))::int AS booked,
            COUNT(*) FILTER (WHERE a.status = 'no_show')::int   AS no_show,
            COUNT(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled
       FROM appointments a
      WHERE a.appointment_date = $1::date
        AND NOT EXISTS (
              SELECT 1 FROM patients bp WHERE bp.id = a.patient_id AND bp.is_blocked
            )`,
    [visitDate],
  );
  const appts = rows[0] || { booked: 0, no_show: 0, cancelled: 0 };

  const inBuilding = board.onFloor.filter((c) => !["dispensed", "exited"].includes(c.status));
  const done = board.cards.filter((c) => ["dispensed", "exited"].includes(c.status));
  // Lab-only visits are excluded here for the same reason they are excluded from
  // every station average: a give-a-sample-and-go visit is not a consultation
  // journey, and averaging the two answers neither question.
  const journeys = done
    .filter((c) => !c.labOnly)
    .map((c) => c.totalMinutes)
    .filter((m) => m !== null);
  const avgJourney = journeys.length
    ? Math.round(journeys.reduce((a, b) => a + b, 0) / journeys.length)
    : null;

  // Samples-only patients are excluded: they hold a pre-consultation status
  // judged against the wait-for-SD budget, but they are not in that queue and
  // nobody is going to call them. Counting them made the tile read "7 need
  // attention" while With SD / MO showed 0, three of the seven waiting on
  // nothing. Their lab clock is the one that matters and it is timed separately.
  const overBudget = inBuilding.filter((c) => !c.labOnly && c.statusColour === "red").length;
  const blocked = board.onFloor.filter(
    (c) => c.status === "blocked_reports" || c.blockedReason,
  ).length;
  // GF-21: this counted live cards, not transitions. Measure what the label says
  // — completed station-to-station hops today that finished inside their budget.
  const { rows: hops } = await db.query(
    `SELECT e.status,
            EXTRACT(EPOCH FROM (nxt.occurred_at - e.occurred_at)) / 60 AS minutes
       FROM giniflow_visit_events e
       JOIN giniflow_visits v ON v.id = e.visit_id AND v.visit_date = $1::date
       JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events n
          WHERE n.visit_id = e.visit_id AND n.occurred_at > e.occurred_at
          ORDER BY n.occurred_at LIMIT 1
       ) nxt ON TRUE
      WHERE NOT ${labOnlyPredicate("v", "$2")}`,
    [visitDate, LAB_ONLY_DOCTOR],
  );
  const budgeted = hops
    .map((h) => ({ minutes: Number(h.minutes), budget: budgets[slaKeyForStatus(h.status)] }))
    .filter((h) => h.budget);
  const withinSla = budgeted.length
    ? Math.round((budgeted.filter((h) => h.minutes <= h.budget).length / budgeted.length) * 100)
    : null;

  return {
    inBuilding: inBuilding.length,
    booked: appts.booked,
    noShow: appts.no_show,
    cancelled: appts.cancelled,
    completed: done.length,
    avgCompletedMinutes: avgJourney,
    overBudget,
    blocked,
    journeyTargetMinutes: budgets.total_journey ?? null,
    withinSlaPct: withinSla,
    slaTransitions: budgeted.length,
  };
}

// Today's average per station, for the footer strip. Reads closed transitions
// from the log rather than the live cards, so it reflects the whole day.
export async function getStationAverages(visitDate, slaConfig, db = pool) {
  const budgets = budgetMap(slaConfig);
  const { rows } = await db.query(
    `SELECT e.status,
            AVG(EXTRACT(EPOCH FROM (nxt.occurred_at - e.occurred_at)) / 60)::numeric(10,1) AS avg_minutes,
            COUNT(*)::int AS samples
       FROM giniflow_visit_events e
       JOIN giniflow_visits v ON v.id = e.visit_id AND v.visit_date = $1::date
       JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events n
          WHERE n.visit_id = e.visit_id AND n.occurred_at > e.occurred_at
          ORDER BY n.occurred_at LIMIT 1
       ) nxt ON TRUE
      -- Lab-only visits never walk these stations, so their hops must not
      -- define how the stations are performing. On 5 Sep three of the five
      -- closed check-in hops were lab-only, at 0m, 3m and 5m — the gap between
      -- check-in and the sync noticing a HealthRay vitals row, not a queue.
      -- They pulled the check-in average from 105m down to 44m and painted a
      -- badly lagging station green.
      WHERE NOT ${labOnlyPredicate("v", "$2")}
      GROUP BY e.status`,
    [visitDate, LAB_ONLY_DOCTOR],
  );

  const byStation = {};
  for (const row of rows) {
    const key = slaKeyForStatus(row.status);
    if (!key) continue;
    byStation[key] = byStation[key] || { minutes: 0, samples: 0 };
    byStation[key].minutes += Number(row.avg_minutes) * row.samples;
    byStation[key].samples += row.samples;
  }

  // Two budgets are not measured by a status dwell time and so never appear in
  // the query above: the lab track lives in its own table, and the journey total
  // spans the whole chain (GF-07).
  const [{ lab_minutes: labMinutes, lab_samples: labSamples }] = (
    await db.query(
      `SELECT AVG(mins)::numeric(10, 1) AS lab_minutes, COUNT(*)::int AS lab_samples
         FROM (
           SELECT EXTRACT(EPOCH FROM (o.uploaded_at - o.created_at)) / 60 AS mins
             FROM giniflow_lab_orders o
             JOIN giniflow_visits v ON v.id = o.visit_id AND v.visit_date = $1::date
            WHERE o.uploaded_at IS NOT NULL
           UNION ALL
           SELECT EXTRACT(
                    EPOCH FROM (
                      (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on')::timestamptz
                      - (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'registered_at')::timestamptz
                    )
                  ) / 60 AS mins
             FROM lab_cases lc
            WHERE lc.case_date = $1::date
              AND lc.raw_detail_json->>'reported_on' IS NOT NULL
              AND COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'registered_at' IS NOT NULL
         ) t
        WHERE mins >= 0`,
      [visitDate],
    )
  ).rows;

  const [{ journey_minutes: journeyMinutes, journey_samples: journeySamples }] = (
    await db.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (fin.occurred_at - start.occurred_at)) / 60)::numeric(10,1) AS journey_minutes,
              COUNT(*)::int AS journey_samples
         FROM giniflow_visits v
         JOIN LATERAL (
           SELECT occurred_at FROM giniflow_visit_events e
            WHERE e.visit_id = v.id AND e.status = 'checked_in' ORDER BY occurred_at LIMIT 1
         ) start ON TRUE
         JOIN LATERAL (
           SELECT occurred_at FROM giniflow_visit_events e
            WHERE e.visit_id = v.id AND e.status IN ('exited', 'dispensed')
            ORDER BY occurred_at DESC LIMIT 1
         ) fin ON TRUE
        WHERE v.visit_date = $1::date
          AND NOT ${labOnlyPredicate("v", "$2")}`,
      [visitDate, LAB_ONLY_DOCTOR],
    )
  ).rows;

  if (labSamples)
    byStation.lab_total = { minutes: Number(labMinutes) * labSamples, samples: labSamples };
  if (journeySamples)
    byStation.total_journey = {
      minutes: Number(journeyMinutes) * journeySamples,
      samples: journeySamples,
    };

  return slaConfig.map((s) => {
    const agg = byStation[s.station];
    const actual = agg && agg.samples ? Math.round(agg.minutes / agg.samples) : null;
    return {
      station: s.station,
      label: s.label,
      budgetMinutes: s.budgetMinutes,
      actualMinutes: actual,
      samples: agg?.samples ?? 0,
      colour: actual === null ? "neutral" : budgetColour(actual, s.budgetMinutes),
      fillPct: actual === null ? 0 : Math.min(100, Math.round((actual / s.budgetMinutes) * 100)),
    };
  });
}
