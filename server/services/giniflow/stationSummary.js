import pool from "../../config/db.js";
import { getSlaConfig, getDayBoard, getBottleneck } from "./board.js";
import { getTriageSummary } from "./triage.js";

// The counts on the launcher tiles. One query set for the whole floor, so the
// landing screen costs the same whether a coordinator holds one station or all
// of them.
//
// Counts are computed for every station, then the route filters to the ones the
// signed-in role may actually open — a number is not sensitive, but a tile that
// appears and then 403s is worse than no tile.
export async function getStationSummary(visitDate, db = pool) {
  const sla = await getSlaConfig(db);
  const board = await getDayBoard(visitDate, sla, new Date(), db);
  const bottleneck = getBottleneck(board.columns);

  const col = (key) => board.columns.find((c) => c.key === key)?.count ?? 0;
  const atRisk = board.onFloor.filter((c) => !c.finished && c.statusColour === "red").length;

  const { rows: lab } = await db.query(
    `SELECT
       count(*) FILTER (WHERE o.payment_status = 'pending')::int AS payment_pending,
       count(*) FILTER (WHERE o.payment_status <> 'pending'
                          AND o.sample_status IN ('ordered','payment_pending','paid'))::int AS to_collect,
       count(*) FILTER (WHERE o.sample_status = 'results_ready')::int AS to_upload
     FROM giniflow_lab_orders o
     JOIN giniflow_visits v ON v.id = o.visit_id
    WHERE v.visit_date = $1::date`,
    [visitDate],
  );

  // The floor is still worked on HealthRay, so three of these stations have
  // giniflow_* tables nobody writes to and would read a permanent zero. A zero
  // that is structural rather than true is the worst thing a launcher tile can
  // say, so each of them falls back to the table the hospital actually fills:
  // `lab_cases` for the lab, the day's unarrived appointments for the desk, and
  // `medications` against `medicine_collections` for the counter.
  const { rows: live } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM giniflow_visits
         WHERE visit_date = $1::date AND current_status = 'booked') AS to_check_in,
       (SELECT count(*)::int FROM lab_cases WHERE case_date = $1::date) AS lab_today,
       -- Outstanding is pending AND partial, the same rule labStation.js and
       -- the OPD chips use: results_synced flips on the first panel, so a
       -- synced case with no reported_on is still being worked on.
       (SELECT count(*) FILTER (
                 WHERE NOT results_synced
                    OR raw_detail_json->>'reported_on' IS NULL)::int
          FROM lab_cases WHERE case_date = $1::date) AS lab_awaiting,
       (SELECT count(DISTINCT m.patient_id)::int
          FROM medications m
          JOIN giniflow_visits v ON v.patient_id = m.patient_id AND v.visit_date = $1::date
         WHERE (m.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
           AND m.is_active
           AND NOT EXISTS (
             SELECT 1 FROM medicine_collections c
              WHERE c.medication_id = m.id AND c.collected_date = $1::date
           )) AS to_hand_over`,
    [visitDate],
  );

  // Referrals are parallel to the chain, so they are not a board column and the
  // count cannot come from `col()`. "Open" is every referral raised today whose
  // loop is not closed — a referral has no SLA, so this is a workload, not a
  // warning (19 §2).
  const { rows: referrals } = await db.query(
    `SELECT count(*)::int AS today,
            count(*) FILTER (WHERE r.status <> 'completed')::int AS open
       FROM giniflow_referrals r
       JOIN giniflow_visits v ON v.id = r.visit_id
      WHERE v.visit_date = $1::date`,
    [visitDate],
  );

  // Triage works TOMORROW, not the day the rest of these count, so it gets its
  // own read rather than a slice of the board above.
  const triage = await getTriageSummary(db);

  const orders = lab[0];
  const floor = live[0];
  const toDispense = col("pharmacy");

  return {
    // Today first — the tile sits beside eight stations all counting today — with
    // tomorrow's unsorted backlog appended, since that is what the screen opens on.
    triage: {
      count: triage.today_uncategorised,
      label: triage.today_total
        ? `${triage.today_uncategorised} of ${triage.today_total} today` +
          (triage.uncategorised ? ` · ${triage.uncategorised} tomorrow` : "")
        : triage.uncategorised
          ? `${triage.uncategorised} of ${triage.total} tomorrow`
          : "nothing to sort",
      tone: triage.today_uncategorised || triage.uncategorised ? "red" : "teal",
    },
    manager: {
      count: atRisk,
      label: atRisk === 1 ? "1 at risk" : `${atRisk} at risk`,
      tone: "red",
    },
    vitals: {
      count: col("checked_in") + col("vitals"),
      label: `${col("checked_in") + col("vitals")} in queue`,
      tone: "blue",
    },
    // Payment is the desk's blocking job and stays the headline whenever there
    // is one; with nothing to collect the tile falls back to the arrivals the
    // desk has not checked in yet, which is the same screen's other half.
    reception: {
      count: orders.payment_pending || floor.to_check_in,
      label: orders.payment_pending
        ? `${orders.payment_pending} payment pending`
        : floor.to_check_in
          ? `${floor.to_check_in} to check in`
          : "desk clear",
      tone: orders.payment_pending ? "red" : floor.to_check_in ? "blue" : "teal",
    },
    // The fallback counts `lab_cases` — the hospital's own lab, synced from the
    // lab API. The station screen lists those read-only below its own queue, so
    // the label names the system rather than implying work to do: nothing there
    // is a sample this technician collects or a report they upload.
    lab: {
      count: orders.to_collect + orders.to_upload || floor.lab_today,
      label:
        orders.to_collect + orders.to_upload
          ? `${orders.to_collect} to collect · ${orders.to_upload} to upload`
          : floor.lab_today
            ? `${floor.lab_today} at hospital lab · ${floor.lab_awaiting} still out`
            : "no samples today",
      tone: orders.to_collect + orders.to_upload ? "blue" : "teal",
    },
    mo_sd: { count: col("sd"), label: `${col("sd")} in workup`, tone: "blue" },
    doctor: { count: col("wait_doctor"), label: `${col("wait_doctor")} waiting`, tone: "red" },
    // `to_hand_over` counts patients prescribed today with nothing recorded as
    // collected — the counter's real backlog even on a day the station screen
    // itself was never opened.
    pharmacy: {
      count: toDispense || floor.to_hand_over,
      label: toDispense
        ? `${toDispense} to dispense`
        : floor.to_hand_over
          ? `${floor.to_hand_over} to hand over`
          : "nothing to dispense",
      tone: toDispense ? "blue" : "teal",
    },
    referrals: {
      count: referrals[0].open,
      label: referrals[0].today ? `${referrals[0].today} today` : "none today",
      tone: referrals[0].open ? "blue" : "teal",
    },
    bottleneck: bottleneck ? { station: bottleneck.station, label: bottleneck.label } : null,
  };
}
