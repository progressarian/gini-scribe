// The hybrid floor, step 2: what HealthRay says, and which desk is behind
// (docs/gini-flow/39-HYBRID-FLOOR-PLAN.md §5.3).
//
// Step 2 is an OBSERVATION — it must move nobody. So every case below asserts
// two things: the right station is named, and `current_status` did not budge.
//
// Runs on a date of its own inside a transaction that is always rolled back:
// `DATABASE_URL` is production and today belongs to real patients.
//
//   npm run smoke:observation   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";
import {
  recordHealthrayObservation,
  getBehindTheFloor,
  BEHIND_STATIONS,
  BEHIND_STATION_LABEL,
} from "../services/giniflow/observation.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("── The station list ────────────────────────────────────────");
check(
  "the stations HealthRay can be ahead of, in journey order",
  BEHIND_STATIONS.join(",") === "reception,vitals,lab,lab_results,machine",
  BEHIND_STATIONS.join(" → "),
);
check(
  "the Rx desk and pharmacy are not on it",
  !BEHIND_STATIONS.includes("rx") && !BEHIND_STATIONS.includes("pharmacy"),
  "they come after the steps HealthRay knows about",
);
check(
  "every station has a label a person would recognise",
  BEHIND_STATIONS.every((s) => (BEHIND_STATION_LABEL[s] || "").length > 2),
  BEHIND_STATIONS.map((s) => BEHIND_STATION_LABEL[s]).join(" · "),
);

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: d } = await client.query(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 121)::text AS day`,
  );
  const day = d[0].day;

  // A visit on its own day, with the HealthRay status and floor position named.
  const make = async (tag, { hrStatus, floorStatus, doctor = "Dr. Anil Bhansali" }) => {
    const { rows: p } = await client.query(
      `INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`,
      [`Probe ${tag}`, `ZZOB_${tag}_${Date.now()}`],
    );
    await client.query(
      `INSERT INTO appointments (patient_id, appointment_date, status, time_slot, doctor_name)
       VALUES ($1, $2::date, $3, '10:00', $4)`,
      [p[0].id, day, hrStatus, doctor],
    );
    const { rows: v } = await client.query(
      `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
       VALUES ($1, $2::date, $3, 'none') RETURNING id`,
      [p[0].id, day, floorStatus],
    );
    return { patientId: p[0].id, visitId: v[0].id };
  };

  const event = (visitId, status, role) =>
    client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role)
       VALUES ($1, $2, $3)`,
      [visitId, status, role],
    );

  const read = async (visitId) => {
    const { rows } = await client.query(
      `SELECT current_status, healthray_status, behind_station,
              healthray_status_at IS NOT NULL AS stamped
         FROM giniflow_visits WHERE id = $1`,
      [visitId],
    );
    return rows[0];
  };

  console.log("\n── Reception has not arrived them ──────────────────────────");
  // HealthRay has the patient with a doctor; Scribe still has them booked and
  // no person ever wrote the arrival.
  const recept = await make("RECEPT", { hrStatus: "in_visit", floorStatus: "booked" });
  const first = await recordHealthrayObservation(client, day);
  check("the observation ran", first.observed >= 1, JSON.stringify(first));
  const r1 = await read(recept.visitId);
  check("reception is named", r1.behind_station === "reception", r1.behind_station);
  check("HealthRay's own status is recorded", r1.healthray_status === "in_visit");
  check("and stamped, so the panel can age it", r1.stamped === true);
  check("but the patient did not move", r1.current_status === "booked", r1.current_status);

  console.log("\n── Arrived by a person, vitals not recorded ────────────────");
  await event(recept.visitId, "checked_in", "reception");
  await recordHealthrayObservation(client, day);
  const r2 = await read(recept.visitId);
  check("vitals is named next", r2.behind_station === "vitals", r2.behind_station);
  check("still nobody moved", r2.current_status === "booked", r2.current_status);

  console.log("\n── An arrival the SYNC wrote does not count ────────────────");
  const sysOnly = await make("SYSONLY", { hrStatus: "in_visit", floorStatus: "booked" });
  await event(sysOnly.visitId, "checked_in", "system");
  await recordHealthrayObservation(client, day);
  const r3 = await read(sysOnly.visitId);
  check(
    "reception is still named",
    r3.behind_station === "reception",
    "a step the sync wrote is not a step the desk recorded",
  );

  console.log("\n── The lab has not drawn the tube ──────────────────────────");
  const lab = await make("LAB", { hrStatus: "in_visit", floorStatus: "vitals_done" });
  await event(lab.visitId, "checked_in", "reception");
  await event(lab.visitId, "vitals_done", "vitals");
  const { rows: o } = await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, urgency, payment_status, amount_total, sample_status, kind)
     VALUES ($1, 'today', 'paid', 250, 'paid', 'lab') RETURNING id`,
    [lab.visitId],
  );
  await recordHealthrayObservation(client, day);
  check("Lab 1 is named", (await read(lab.visitId)).behind_station === "lab");

  console.log("\n── Drawn, but no result filed ──────────────────────────────");
  await client.query(`UPDATE giniflow_lab_orders SET sample_status = 'processing' WHERE id = $1`, [
    o[0].id,
  ]);
  await recordHealthrayObservation(client, day);
  check(
    "Lab 2 is named, not Lab 1",
    (await read(lab.visitId)).behind_station === "lab_results",
    (await read(lab.visitId)).behind_station,
  );

  console.log("\n── Everything recorded — nobody is behind ──────────────────");
  await client.query(`UPDATE giniflow_lab_orders SET sample_status = 'uploaded' WHERE id = $1`, [
    o[0].id,
  ]);
  await recordHealthrayObservation(client, day);
  check("the station clears", (await read(lab.visitId)).behind_station === null);

  console.log("\n── A machine test nobody has run ───────────────────────────");
  const mach = await make("MACH", { hrStatus: "completed", floorStatus: "vitals_done" });
  await event(mach.visitId, "checked_in", "reception");
  await event(mach.visitId, "vitals_done", "vitals");
  await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, urgency, payment_status, amount_total, sample_status, kind)
     VALUES ($1, 'today', 'paid', 400, 'paid', 'machine')`,
    [mach.visitId],
  );
  await recordHealthrayObservation(client, day);
  check("the machine room is named", (await read(mach.visitId)).behind_station === "machine");

  console.log("\n── HealthRay level with us, or behind us, is not a gap ─────");
  const level = await make("LEVEL", { hrStatus: "checkedin", floorStatus: "vitals_done" });
  await recordHealthrayObservation(client, day);
  const r4 = await read(level.visitId);
  check("nobody is named when the floor is ahead", r4.behind_station === null, r4.behind_station);
  check("the status is still recorded", r4.healthray_status === "checkedin");

  console.log("\n── A patient off the day is nobody's backlog ───────────────");
  const gone = await make("GONE", { hrStatus: "in_visit", floorStatus: "no_show" });
  await recordHealthrayObservation(client, day);
  const r5 = await read(gone.visitId);
  check("a no-show is never behind", r5.behind_station === null, r5.behind_station);
  check("and is left entirely alone", r5.healthray_status === null, "not even observed");

  console.log("\n── Written only when it changes ────────────────────────────");
  const a = await recordHealthrayObservation(client, day);
  const b = await recordHealthrayObservation(client, day);
  check(
    "a second identical run writes nothing",
    b.observed === 0,
    `${a.observed} then ${b.observed} rows`,
  );

  console.log("\n── The worklist half of the panel ─────────────────────────");
  const { getBehindVisits } = await import("../services/giniflow/observation.js");
  const all = await getBehindVisits(day, client);
  check("one row per patient behind", all.length >= 3, `${all.length} rows`);
  check(
    "each carries both readings, so neither is the truth",
    all.every((v) => v.scribeStatus && (v.healthrayStatus || v.healthrayRaw)),
    all.map((v) => `${v.healthrayStatus}/${v.scribeStatus}`).join(" · "),
  );
  check(
    "and the desk to chase, with a name a person recognises",
    all.every((v) => BEHIND_STATIONS.includes(v.station) && v.stationLabel),
  );
  check(
    "worst wait first",
    all.every((v, i) => i === 0 || all[i - 1].minutes >= v.minutes),
    all.map((v) => v.minutes).join(","),
  );
  const receptionOnly = await getBehindVisits(day, client, { station: "reception" });
  check(
    "narrowing to one station returns only its rows",
    receptionOnly.length > 0 && receptionOnly.every((v) => v.station === "reception"),
    `${receptionOnly.length} at reception`,
  );
  const bogus = await getBehindVisits(day, client, { station: "teleporter" });
  check(
    "an unknown station falls back to the whole floor, never an empty lie",
    bogus.length === all.length,
    `${bogus.length} vs ${all.length}`,
  );

  console.log("\n── The panel's read ───────────────────────────────────────");
  const panel = await getBehindTheFloor(day, client);
  check("it groups by the station that owes the step", panel.length >= 1, JSON.stringify(panel));
  check(
    "every row carries a label and an age",
    panel.every((r) => r.label && Number.isFinite(r.avgMinutes)),
    panel.map((r) => `${r.label}:${r.visits}`).join(" · "),
  );
  check(
    "and only names real stations",
    panel.every((r) => BEHIND_STATIONS.includes(r.station)),
    panel.map((r) => r.station).join(", "),
  );
} finally {
  await client.query("ROLLBACK");
  client.release();
  const { rows: left } = await pool.query(
    `SELECT count(*)::int AS c FROM patients WHERE file_no LIKE 'ZZOB_%'`,
  );
  check("the synthetic patients left no trace", left[0].c === 0, `${left[0].c} rows`);
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  await pool.end();
  process.exit(failures ? 1 : 0);
}
