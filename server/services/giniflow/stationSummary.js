import pool from "../../config/db.js";
import { getSlaConfig, getDayBoard, getBottleneck, boardClock } from "./board.js";
import { getTriageSummary } from "./triage.js";
import { getMachines } from "./machineCatalog.js";
import { machinesForStation } from "../../../shared/machineStages.js";
import { getPaymentQueue, getArrivals } from "./receptionStation.js";
import { getLabQueue } from "./labStation.js";
import { getPharmacyQueue } from "./pharmacyStation.js";
import { getVitalsQueue } from "./vitalsStation.js";
import { getMachineQueue } from "./machineStation.js";

// The counts on the launcher tiles. One query set for the whole floor, so the
// landing screen costs the same whether a coordinator holds one station or all
// of them.
//
// Counts are computed for every station, then the route filters to the ones the
// signed-in role may actually open — a number is not sensitive, but a tile that
// appears and then 403s is worse than no tile.
export async function getStationSummary(visitDate, db = pool) {
  const sla = await getSlaConfig(db);
  const board = await getDayBoard(visitDate, sla, boardClock(visitDate), db);
  const bottleneck = getBottleneck(board.columns);

  const col = (key) => board.columns.find((c) => c.key === key)?.count ?? 0;
  const atRisk = board.onFloor.filter((c) => !c.finished && c.statusColour === "red").length;

  const now = new Date();
  const [payments, arrivals, collection, processing, pharmacyQueue, vitalsQueue] =
    await Promise.all([
      getPaymentQueue(visitDate, db),
      getArrivals(visitDate, "", now, db),
      getLabQueue(visitDate, null, db, { room: "collection" }),
      getLabQueue(visitDate, null, db, { room: "processing" }),
      getPharmacyQueue(visitDate, now, db),
      getVitalsQueue(visitDate, now, db),
    ]);

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

  const pay = payments.counts;
  const paymentPending = pay.pending + (pay.charges || 0) + (pay.healthrayLab || 0);
  const toCheckIn = arrivals.counts.expected;
  const toCollect = collection.counts.pending + collection.counts.drawing;
  const toSend = collection.counts.collecting;
  const toReceive = processing.counts.sent;
  const inLab = processing.counts.received + processing.counts.processing;
  const toUpload = processing.counts.ready;
  const toDispense = pharmacyQueue.counts.toDispense;
  const inVitalsQueue = vitalsQueue.counts.atStation + vitalsQueue.counts.waiting;
  const onBreak = vitalsQueue.counts.onBreak;

  const catalogue = await getMachines(db);
  const sideStationIds = [
    ...new Set(catalogue.map((m) => m.station).filter((st) => st && st !== "machine_room")),
  ];
  const machineCounts = Object.fromEntries(
    await Promise.all(
      ["machine_room", ...sideStationIds].map(async (station) => {
        const { counts } = await getMachineQueue(visitDate, null, db, { station });
        return [
          station,
          { waiting: counts.ordered, running: counts.in_progress, unreported: counts.done },
        ];
      }),
    ),
  );
  const machineTile = (station, idle) => {
    const c = machineCounts[station];
    return {
      count: c.waiting + c.running + c.unreported,
      label: c.running
        ? `${c.running} in progress · ${c.waiting} waiting`
        : c.waiting
          ? `${c.waiting} waiting`
          : c.unreported
            ? `${c.unreported} awaiting a report`
            : idle,
      tone: c.waiting ? "blue" : "teal",
    };
  };
  const sideTile = (id) =>
    machineTile(id, `no ${(machinesForStation(catalogue, id)[0]?.name || id).toLowerCase()} today`);

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
      count: inVitalsQueue,
      label: `${inVitalsQueue} in queue` + (onBreak ? ` · ${onBreak} on break` : ""),
      tone: "blue",
    },
    reception: {
      count: paymentPending || toCheckIn,
      label: paymentPending
        ? `${paymentPending} payment pending`
        : toCheckIn
          ? `${toCheckIn} to check in`
          : "desk clear",
      tone: paymentPending ? "red" : toCheckIn ? "blue" : "teal",
    },
    lab: {
      count: toCollect + toSend + toReceive + inLab + toUpload,
      label:
        toCollect + toSend + toReceive + inLab + toUpload
          ? `${toCollect} to collect · ${toUpload} to upload`
          : "no samples waiting",
      tone: toCollect + toUpload ? "blue" : "teal",
    },
    lab_collect: {
      count: toCollect + toSend,
      label:
        toCollect + toSend ? `${toCollect} to collect · ${toSend} to send` : "nothing to collect",
      tone: toCollect ? "blue" : "teal",
    },
    lab_process: {
      count: toReceive + inLab + toUpload,
      label:
        toReceive + inLab + toUpload
          ? `${toReceive} to receive · ${inLab} in the lab · ${toUpload} to upload`
          : "bench clear",
      tone: toUpload ? "red" : toReceive ? "blue" : "teal",
    },
    machine: machineTile("machine_room", "no machine tests today"),
    ...Object.fromEntries(sideStationIds.map((id) => [id, sideTile(id)])),
    mo_sd: { count: col("sd"), label: `${col("sd")} in workup`, tone: "blue" },
    doctor: { count: col("wait_doctor"), label: `${col("wait_doctor")} waiting`, tone: "red" },
    rx: {
      count: col("rx"),
      label: col("rx") ? `${col("rx")} to explain` : "nobody waiting",
      tone: col("rx") ? "blue" : "teal",
    },
    pharmacy: {
      count: toDispense,
      label: toDispense ? `${toDispense} to dispense` : "nothing to dispense",
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
