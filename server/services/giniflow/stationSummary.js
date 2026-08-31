import pool from "../../config/db.js";
import { getSlaConfig, getDayBoard, getBottleneck } from "./board.js";

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

  return {
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
    reception: {
      count: lab[0].payment_pending,
      label: `${lab[0].payment_pending} payment pending`,
      tone: "red",
    },
    lab: {
      count: lab[0].to_collect + lab[0].to_upload,
      label: `${lab[0].to_collect} to collect · ${lab[0].to_upload} to upload`,
      tone: "teal",
    },
    doctor: { count: col("wait_doctor"), label: `${col("wait_doctor")} waiting`, tone: "red" },
    pharmacy: { count: col("pharmacy"), label: `${col("pharmacy")} ready`, tone: "teal" },
    bottleneck: bottleneck ? { station: bottleneck.station, label: bottleneck.label } : null,
  };
}
