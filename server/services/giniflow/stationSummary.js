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

const PIECES_BY_STATION = {
  triage: ["triage"],
  vitals: ["vitals"],
  reception: ["payments", "arrivals"],
  lab: ["collection", "processing"],
  lab_collect: ["collection"],
  lab_process: ["processing"],
  machine: ["machines"],
  echo: ["machines"],
  xray: ["machines"],
  pharmacy: ["pharmacy"],
  referrals: ["referrals"],
};

const EMPTY_QUEUE = { counts: {} };

async function loadMachineCounts(visitDate, db) {
  const catalogue = await getMachines(db);
  const sideStationIds = [
    ...new Set(catalogue.map((m) => m.station).filter((st) => st && st !== "machine_room")),
  ];
  const counts = Object.fromEntries(
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
  return { catalogue, sideStationIds, counts };
}

async function loadBoard(visitDate, db) {
  const sla = await getSlaConfig(db);
  return getDayBoard(visitDate, sla, boardClock(visitDate), db);
}

async function loadReferrals(visitDate, db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS today,
            count(*) FILTER (WHERE r.status <> 'completed')::int AS open
       FROM giniflow_referrals r
       JOIN giniflow_visits v ON v.id = r.visit_id
      WHERE v.visit_date = $1::date`,
    [visitDate],
  );
  return rows[0];
}

const PIECE_LOADERS = {
  board: (date, db) => loadBoard(date, db),
  payments: (date, db) => getPaymentQueue(date, db),
  arrivals: (date, db) => getArrivals(date, "", new Date(), db),
  collection: (date, db) => getLabQueue(date, null, db, { room: "collection" }),
  processing: (date, db) => getLabQueue(date, null, db, { room: "processing" }),
  pharmacy: (date, db) => getPharmacyQueue(date, new Date(), db),
  vitals: (date, db) => getVitalsQueue(date, new Date(), db),
  referrals: (date, db) => loadReferrals(date, db),
  triage: (_date, db) => getTriageSummary(db),
  machines: (date, db) => loadMachineCounts(date, db),
};

export async function getStationSummary(visitDate, db = pool, { stations } = {}) {
  const wanted = stations || Object.keys(PIECES_BY_STATION);
  const needed = new Set(["board", ...wanted.flatMap((k) => PIECES_BY_STATION[k] || [])]);
  const loaded = Object.fromEntries(
    await Promise.all(
      [...needed].map(async (piece) => [piece, await PIECE_LOADERS[piece](visitDate, db)]),
    ),
  );

  const board = loaded.board;
  const bottleneck = getBottleneck(board.columns);
  const col = (key) => board.columns.find((c) => c.key === key)?.count ?? 0;
  const atRisk = board.onFloor.filter((c) => !c.finished && c.statusColour === "red").length;

  const payments = loaded.payments || EMPTY_QUEUE;
  const arrivals = loaded.arrivals || EMPTY_QUEUE;
  const collection = loaded.collection || EMPTY_QUEUE;
  const processing = loaded.processing || EMPTY_QUEUE;
  const pharmacyQueue = loaded.pharmacy || EMPTY_QUEUE;
  const vitalsQueue = loaded.vitals || EMPTY_QUEUE;
  const referral = loaded.referrals || { today: 0, open: 0 };
  const triage = loaded.triage || {
    today_total: 0,
    today_uncategorised: 0,
    total: 0,
    uncategorised: 0,
  };
  const {
    catalogue,
    sideStationIds,
    counts: machineCounts,
  } = loaded.machines || {
    catalogue: [],
    sideStationIds: [],
    counts: {},
  };

  const n = (v) => v || 0;
  const pay = payments.counts;
  const paymentPending = n(pay.pending) + n(pay.charges) + n(pay.healthrayLab);
  const toCheckIn = n(arrivals.counts.expected);
  const toCollect = n(collection.counts.pending) + n(collection.counts.drawing);
  const toSend = n(collection.counts.collecting);
  const toReceive = n(processing.counts.sent);
  const inLab = n(processing.counts.received) + n(processing.counts.processing);
  const toUpload = n(processing.counts.ready);
  const toDispense = n(pharmacyQueue.counts.toDispense);
  const inVitalsQueue = n(vitalsQueue.counts.atStation) + n(vitalsQueue.counts.waiting);
  const onBreak = n(vitalsQueue.counts.onBreak);

  const machineTile = (station, idle) => {
    const c = machineCounts[station] || { waiting: 0, running: 0, unreported: 0 };
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
      count: referral.open,
      label: referral.today ? `${referral.today} today` : "none today",
      tone: referral.open ? "blue" : "teal",
    },
    bottleneck: bottleneck ? { station: bottleneck.station, label: bottleneck.label } : null,
  };
}
