import { getMachines } from "./machineCatalog.js";
import { machineForTest } from "../../../shared/machineStages.js";
import { labStepsAreManual } from "../../../shared/manualFloor.js";
import { LIVE_LAB_CASE_SQL } from "./testsHold.js";

export const LAB_STATION = "lab_collection";

const STATION_LABEL = {
  [LAB_STATION]: "Lab 1",
  machine_room: "the Machine Room",
  xray: "X-Ray",
  echo: "Echo",
};

export const stationLabel = (station) => STATION_LABEL[station] || station;

const BUSY_SQL = `
  SELECT o.visit_id, o.kind, COALESCE(array_agg(t.test_name ORDER BY t.test_name), '{}') AS tests
    FROM giniflow_lab_orders o
    LEFT JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
   WHERE o.visit_id = ANY($1::uuid[])
     AND o.urgency = 'today'
     AND ((o.kind = 'machine' AND o.sample_status = 'in_progress')
       OR (o.kind = 'lab' AND o.sample_status = 'drawing'))
   GROUP BY o.id
  UNION ALL
  SELECT v.id AS visit_id, 'lab' AS kind, '{}'::text[] AS tests
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    JOIN lab_cases lc
      ON lc.case_date = v.visit_date
     AND (lc.patient_id = v.patient_id
          OR (lc.patient_id IS NULL
              AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
   WHERE v.id = ANY($1::uuid[])
     AND EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                  WHERE a.case_no = lc.case_no AND a.action = 'drawing_started')
     AND NOT EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                      WHERE a.case_no = lc.case_no AND a.action = 'sample_taken')
     AND ${LIVE_LAB_CASE_SQL("lc")}
     AND ($2::boolean
          OR (lc.raw_list_json->>'phlebotomy_status' IS DISTINCT FROM 'Completed'
              AND COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'collected_on' IS NULL))`;

export async function busyStations(db, visitIds) {
  const ids = [...new Set((visitIds || []).filter(Boolean))];
  const busy = new Map();
  if (!ids.length) return busy;
  const { rows } = await db.query(BUSY_SQL, [ids, labStepsAreManual()]);
  if (!rows.length) return busy;
  const machines = rows.some((r) => r.kind === "machine") ? await getMachines(db) : [];
  for (const r of rows) {
    const station =
      r.kind === "lab"
        ? LAB_STATION
        : (r.tests.map((n) => machineForTest(machines, n)).find(Boolean)?.station ??
          "machine_room");
    const list = busy.get(r.visit_id) || [];
    const same = list.find((b) => b.station === station);
    if (same) same.tests.push(...r.tests);
    else list.push({ station, label: stationLabel(station), tests: [...r.tests] });
    busy.set(r.visit_id, list);
  }
  return busy;
}

export const busyElsewhere = (busy, visitId, station) =>
  (busy.get(visitId) || []).find((b) => b.station !== station) || null;

export const busyReason = (other) =>
  `At ${other.label}${other.tests.length ? ` (${other.tests.join(", ")})` : ""} — wait until ${other.label} marks it done`;

export async function assertStationFree(client, visitId, station, what) {
  if (!visitId) return;
  const { rows } = await client.query(
    `SELECT p.name FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1
        FOR UPDATE OF v`,
    [visitId],
  );
  if (!rows.length) return;
  const other = busyElsewhere(await busyStations(client, [visitId]), visitId, station);
  if (other) {
    throw Object.assign(
      new Error(
        `${rows[0].name} is at ${other.label} right now — ${what} once ${other.label} marks it done`,
      ),
      { status: 409, busyAt: other.station },
    );
  }
}

export async function withVisitLock(db, fn) {
  if (typeof db.release === "function") return fn(db);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function revertStart(
  client,
  orderId,
  startStatus,
  { actorId = null, actorRole, reason = null, syncTests = false },
) {
  const { rows } = await client.query(
    `SELECT status FROM giniflow_lab_order_events
      WHERE lab_order_id = $1 AND track = 'sample' AND status <> $2
      ORDER BY occurred_at DESC LIMIT 1`,
    [orderId, startStatus],
  );
  const back = rows[0]?.status || "paid";
  await client.query(
    `DELETE FROM giniflow_lab_order_events
      WHERE lab_order_id = $1 AND track = 'sample' AND status = $2`,
    [orderId, startStatus],
  );
  await client.query(
    `UPDATE giniflow_lab_orders SET sample_status = $2, updated_at = NOW() WHERE id = $1`,
    [orderId, back],
  );
  if (syncTests) {
    await client.query(`UPDATE giniflow_lab_order_tests SET status = $2 WHERE lab_order_id = $1`, [
      orderId,
      back,
    ]);
  }
  await client.query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id, meta)
     VALUES ($1, 'station', 'start_cancelled', $2, $3, $4)`,
    [orderId, actorRole, actorId, { from: startStatus, back, reason }],
  );
  return back;
}
