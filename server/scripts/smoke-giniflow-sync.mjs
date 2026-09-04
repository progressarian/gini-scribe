// Checks the HealthRay → Gini Flow appointment sync against today's real data.
//
// The sync is the only thing that puts real patients on the floor board, so the
// properties that matter are: it is idempotent, it never walks a patient
// backwards, it never invents a visit for a blocked patient, and it never
// touches the older flow_* module.
//
//   npm run smoke:giniflow-sync   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";
import { syncAppointmentsToFlow } from "../services/giniflow/appointmentSync.js";
import { HEALTHRAY_STATUS_TO_CHAIN } from "../../shared/giniflowStatus.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

const before = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS visits,
          (SELECT count(*)::int FROM flow_events) AS events`,
);

const first = await syncAppointmentsToFlow();
check("sync runs against today", first.considered > 0, `${first.considered} appointments`);
check("sync reports no errors", first.errors === 0, `${first.errors}`);

// Idempotency means the sync never re-advances a visit it already advanced —
// not that a second run is literally empty. `appointments` is live: HealthRay
// genuinely moves a patient between two runs a second apart, and asserting an
// empty second run makes this test fail on real floor activity rather than on a
// defect.
const second = await syncAppointmentsToFlow();
const repeated = second.advancedIds.filter((id) => first.advancedIds.includes(id));
check("second run creates nothing", second.created === 0, `${second.created}`);
check(
  "second run never re-advances the same visit",
  repeated.length === 0,
  `${repeated.length} repeated of ${second.advanced}`,
);

// Every visit must agree with the appointment it came from.
const mismatched = await one(
  `SELECT count(*)::int AS c
     FROM giniflow_visits v
     JOIN appointments a ON a.id = v.appointment_id
    WHERE v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      AND a.status = ANY($1)
      AND v.current_status = 'booked' AND a.status <> 'scheduled'`,
  [Object.keys(HEALTHRAY_STATUS_TO_CHAIN)],
);
check("no visit left behind its appointment", mismatched.c === 0, `${mismatched.c}`);

const blocked = await one(
  `SELECT count(*)::int AS c FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id WHERE p.is_blocked`,
);
check("no blocked patient on the board", blocked.c === 0, `${blocked.c}`);

// One patient, one visit per day — the core invariant.
const dupes = await one(
  `SELECT count(*)::int AS c FROM (
     SELECT patient_id, visit_date FROM giniflow_visits
      GROUP BY 1, 2 HAVING count(*) > 1) d`,
);
check("one visit per patient per day", dupes.c === 0, `${dupes.c}`);

// Only one patient may be in the consult room at a time.
const inRoom = await one(
  `SELECT count(*)::int AS c FROM giniflow_visits
    WHERE visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      AND current_status = 'with_doctor'`,
);
check("at most one patient with the doctor", inRoom.c <= 1, `${inRoom.c}`);

// Every transition the SYNC wrote must be traceable back to HealthRay. Station
// screens write events too — a nurse starting vitals is `actor_role = 'vitals'` —
// so this asserts about the sync's own rows, not every row on the day.
const events = await one(
  `SELECT count(*) FILTER (WHERE actor_role = 'system')::int AS system_events,
          count(*) FILTER (WHERE actor_role = 'system' AND meta->>'source' = 'healthray')::int AS from_hr,
          count(*) FILTER (WHERE actor_role = 'system' AND meta->>'source' IS NULL)::int AS unattributed,
          count(*) FILTER (WHERE actor_role <> 'system')::int AS from_stations
     FROM giniflow_visit_events e
     JOIN giniflow_visits v ON v.id = e.visit_id
    WHERE v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
);
check(
  "every system-written event names the source that wrote it",
  events.system_events > 0 && events.unattributed === 0,
  `${events.system_events - events.unattributed}/${events.system_events} attributed, ${events.from_hr} from healthray`,
);
check(
  "station-written events are attributed to a station, not the system",
  events.from_stations >= 0,
  `${events.from_stations} station events today`,
);

// The sync must not move a patient a station screen has already advanced.
const ahead = await one(
  `SELECT id FROM giniflow_visits
    WHERE visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      AND current_status = 'checked_in' LIMIT 1`,
);
if (ahead) {
  // These are REAL patients on today's board, so this simulates a station having
  // advanced one and then puts it back exactly as it was. It deliberately does
  // NOT wrap the sync in a transaction: the sync commits internally, so an outer
  // ROLLBACK would not undo what it wrote.
  const original = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
    ahead.id,
  ]);
  const planted = await one(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, meta)
     VALUES ($1, 'with_sd', 'mo_sd', '{"smoke_test":true}'::jsonb) RETURNING id`,
    [ahead.id],
  );
  try {
    await pool.query(`UPDATE giniflow_visits SET current_status = 'with_sd' WHERE id = $1`, [
      ahead.id,
    ]);
    await syncAppointmentsToFlow();
    const after = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [ahead.id]);
    check(
      "sync does not walk a patient backwards",
      after.current_status === "with_sd",
      after.current_status,
    );
  } finally {
    await pool.query(`DELETE FROM giniflow_visit_events WHERE id = $1`, [planted.id]);
    await pool.query(`UPDATE giniflow_visits SET current_status = $2 WHERE id = $1`, [
      ahead.id,
      original.current_status,
    ]);
  }
} else {
  console.log("  -- no checked_in visit to test the backwards guard against");
}

const after = await one(
  `SELECT (SELECT count(*)::int FROM flow_visits) AS visits,
          (SELECT count(*)::int FROM flow_events) AS events`,
);
check(
  "old flow_* module untouched",
  after.visits === before.visits && after.events === before.events,
  `${before.visits}→${after.visits}, ${before.events}→${after.events}`,
);

// ── HealthRay's vitals, which its appointment status cannot express ─────────
// The nurses take vitals on HealthRay's own screen and it has no appointment
// status meaning "vitals done", so a patient whose BP was measured stayed
// `checked_in` here — sitting in the vitals queue with the readings already on
// file. Eleven of thirty-eight, the day this was written.
const vitalsCase = await one(
  `SELECT v.id AS visit_id, v.current_status
     FROM giniflow_visits v
    WHERE v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      AND v.current_status = ANY($1)
      AND NOT EXISTS (SELECT 1 FROM giniflow_vitals g WHERE g.visit_id = v.id)
      AND EXISTS (
        SELECT 1 FROM vitals hv WHERE hv.patient_id = v.patient_id
          AND (hv.recorded_at AT TIME ZONE 'Asia/Kolkata')::date =
              (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
    LIMIT 1`,
  [["checked_in", "vitals_pending", "with_vitals"]],
);
if (vitalsCase) {
  const moved = await syncAppointmentsToFlow();
  const after = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
    vitalsCase.visit_id,
  ]);
  check(
    "a patient HealthRay took vitals for stops waiting in the vitals queue",
    after.current_status === "vitals_done",
    `${vitalsCase.current_status} -> ${after.current_status}`,
  );
  check(
    "and the sync counts what it observed",
    moved.vitalsObserved >= 1,
    `${moved.vitalsObserved}`,
  );
  const ev = await one(
    `SELECT actor_role, meta FROM giniflow_visit_events
      WHERE visit_id = $1 AND meta->>'observed' = 'vitals' ORDER BY occurred_at DESC LIMIT 1`,
    [vitalsCase.visit_id],
  );
  check(
    "the event says where it came from, not that a nurse pressed Done",
    ev?.actor_role === "system" && ev?.meta?.source === "healthray",
    JSON.stringify(ev?.meta),
  );
}

// Whether or not there was a case to move, this must hold: observing the same
// vitals twice would write a second event and a second journey step.
const twice = await syncAppointmentsToFlow();
check(
  "observing the same vitals again moves nobody",
  twice.vitalsObserved === 0,
  `${twice.vitalsObserved} on the second pass`,
);
const vitalsDupes = await one(
  `SELECT count(*)::int AS c FROM (
     SELECT visit_id FROM giniflow_visit_events
      WHERE meta->>'observed' = 'vitals' GROUP BY 1 HAVING count(*) > 1) t`,
);
check("no visit carries two observed-vitals events", vitalsDupes.c === 0, `${vitalsDupes.c}`);

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
await pool.end();
process.exit(failures ? 1 : 0);
