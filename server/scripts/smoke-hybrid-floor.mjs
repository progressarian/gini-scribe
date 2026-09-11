// The hybrid floor, step 1: the allowlist and where a finished consultation lands
// (docs/gini-flow/39-HYBRID-FLOOR-PLAN.md §4).
//
// The guarantee is negative — the sync must write the consultation and NOTHING
// else — so it is asserted rather than assumed. The DB half runs against a
// synthetic patient on a date of its own, inside a transaction that is always
// rolled back: `DATABASE_URL` is production and today belongs to real patients.
//
//   npm run smoke:hybrid-floor   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";
import { HEALTHRAY_STATUS_TO_CHAIN, CHAIN } from "../../shared/giniflowStatus.js";
import { targetStatus } from "../services/giniflow/staleVisits.js";
import { syncAppointmentsToFlow } from "../services/giniflow/appointmentSync.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// The flag is read at call time, so each case sets it and puts it back.
const withFlag = async (on, fn) => {
  const before = process.env.SCRIBE_MANUAL_FLOOR;
  process.env.SCRIBE_MANUAL_FLOOR = on ? "1" : "0";
  try {
    const { healthrayMayWrite, healthrayTarget, HEALTHRAY_MAY_WRITE } =
      await import("../../shared/manualFloor.js");
    return await fn({ healthrayMayWrite, healthrayTarget, HEALTHRAY_MAY_WRITE });
  } finally {
    if (before === undefined) delete process.env.SCRIBE_MANUAL_FLOOR;
    else process.env.SCRIBE_MANUAL_FLOOR = before;
  }
};

console.log("── What the sync may write ─────────────────────────────────");
await withFlag(true, async ({ healthrayMayWrite, HEALTHRAY_MAY_WRITE }) => {
  check(
    "the consultation, and the two absences",
    HEALTHRAY_MAY_WRITE.join(",") === "ready_for_doctor,with_doctor,rx_pending,no_show,cancelled",
    HEALTHRAY_MAY_WRITE.join(" "),
  );
  // Every other step on the chain belongs to a station. Asserted over the whole
  // chain rather than a sample, so a status added later is refused by default.
  const leaked = CHAIN.filter((s) => healthrayMayWrite(s) && !HEALTHRAY_MAY_WRITE.includes(s));
  check("no other chain step is writable", leaked.length === 0, leaked.join(", ") || "none");
  check("reception's arrival is refused", !healthrayMayWrite("checked_in"));
  check("the vitals station's step is refused", !healthrayMayWrite("vitals_done"));
  check("the Chief/MO column is refused — it stays manual", !healthrayMayWrite("with_sd"));
  check("the Rx desk's own step is refused", !healthrayMayWrite("with_rx"));
  check("the pharmacy's steps are refused", !healthrayMayWrite("dispensed"));
  check("and the exit is refused", !healthrayMayWrite("exited"));
});

console.log("\n── A finished consultation stops at the Rx desk's door ─────");
await withFlag(true, async ({ healthrayTarget }) => {
  for (const hr of ["completed", "seen"]) {
    check(
      `HealthRay '${hr}' lands at rx_pending, not exited`,
      healthrayTarget(hr, HEALTHRAY_STATUS_TO_CHAIN) === "rx_pending",
      healthrayTarget(hr, HEALTHRAY_STATUS_TO_CHAIN),
    );
  }
  check(
    "'in_visit' still parks in the consultant's queue",
    healthrayTarget("in_visit", HEALTHRAY_STATUS_TO_CHAIN) === "ready_for_doctor",
  );
  check(
    "'scheduled' still creates the visit at booked",
    healthrayTarget("scheduled", HEALTHRAY_STATUS_TO_CHAIN) === "booked",
  );
});

console.log("\n── Turning the flag off restores the old behaviour ─────────");
await withFlag(false, async ({ healthrayMayWrite, healthrayTarget }) => {
  check(
    "'completed' closes the visit again",
    healthrayTarget("completed", HEALTHRAY_STATUS_TO_CHAIN) === "exited",
  );
  check(
    "and every step is writable again",
    CHAIN.every((s) => healthrayMayWrite(s)),
  );
});

console.log("\n── The overnight sweep does not call a finished visit a walk-out ──");
check(
  "HealthRay completed → exited",
  targetStatus({ hr_status: "completed", current_status: "rx_pending", moved: true }) === "exited",
);
check(
  "even if the floor never moved them off booked",
  targetStatus({ hr_status: "completed", current_status: "booked", moved: false }) === "exited",
);
check(
  "a no-show is still a no-show",
  targetStatus({ hr_status: "no_show", current_status: "booked", moved: false }) === "no_show",
);
check(
  "and a patient left at a station is still abandoned",
  targetStatus({ hr_status: "checkedin", current_status: "with_vitals", moved: true }) ===
    "abandoned",
);

console.log("\n── Against a real sync run ─────────────────────────────────");
const client = await pool.connect();
let depth = 0;
const nested = {
  query: (text, params) => {
    const sql = String(text).trim().toUpperCase();
    if (sql === "BEGIN") return client.query(`SAVEPOINT sp${++depth}`);
    if (sql === "COMMIT") return client.query(`RELEASE SAVEPOINT sp${depth--}`);
    if (sql === "ROLLBACK") return client.query(`ROLLBACK TO SAVEPOINT sp${depth--}`);
    return client.query(text, params);
  },
  release: () => {},
};
const db = { connect: async () => nested, query: (t, p) => client.query(t, p) };

try {
  await client.query("BEGIN");
  // A day of its own — today belongs to real patients, and a synthetic visit on
  // it would appear on the live board for as long as this runs.
  const { rows: d } = await client.query(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 120)::text AS day`,
  );
  const day = d[0].day;

  // `upstream` records the arrival and the vitals, by a person. The hold added
  // in step 4 refuses any auto advance while a station still owes a step
  // (39 §5.2), and this suite is about the ALLOWLIST and where a finished
  // consultation lands — the hold has its own suite in smoke:floor-journey.
  const make = async (tag, hrStatus, { upstream = false } = {}) => {
    const { rows: p } = await client.query(
      `INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`,
      [`Probe ${tag}`, `ZZHF_${tag}_${Date.now()}`],
    );
    const { rows: a } = await client.query(
      `INSERT INTO appointments (patient_id, appointment_date, status, time_slot, visit_type)
       VALUES ($1, $2::date, $3, '10:00', 'Follow-Up') RETURNING id`,
      [p[0].id, day, hrStatus],
    );
    if (upstream) {
      const { rows: v } = await client.query(
        `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
         VALUES ($1, $2::date, 'vitals_done', 'none')
         ON CONFLICT (patient_id, visit_date) DO UPDATE SET current_status = 'vitals_done'
         RETURNING id`,
        [p[0].id, day],
      );
      for (const status of ["checked_in", "vitals_done"]) {
        await client.query(
          `INSERT INTO giniflow_visit_events (visit_id, status, actor_role)
           VALUES ($1, $2, $3)`,
          [v[0].id, status, status === "checked_in" ? "reception" : "vitals"],
        );
      }
    }
    return { patientId: p[0].id, apptId: a[0].id };
  };

  const checkedIn = await make("CHECKEDIN", "checkedin");
  const completed = await make("COMPLETED", "completed", { upstream: true });
  const inVisit = await make("INVISIT", "in_visit", { upstream: true });

  const statusOf = async (patientId) => {
    const { rows } = await client.query(
      `SELECT current_status FROM giniflow_visits WHERE patient_id = $1 AND visit_date = $2::date`,
      [patientId, day],
    );
    return rows[0]?.current_status ?? null;
  };

  // First run creates the visits at `booked`.
  const first = await syncAppointmentsToFlow({ date: day, db });
  check("the day's list still creates visits", first.created >= 1, JSON.stringify(first));
  check(
    "a patient HealthRay calls checked in waits at booked for reception",
    (await statusOf(checkedIn.patientId)) === "booked",
    await statusOf(checkedIn.patientId),
  );

  // Second run: the visits now exist, so this is the advance path.
  await syncAppointmentsToFlow({ date: day, db });
  check(
    "and still waits at booked on the next poll",
    (await statusOf(checkedIn.patientId)) === "booked",
    await statusOf(checkedIn.patientId),
  );
  check(
    "a finished consultation reaches the Rx desk's queue",
    (await statusOf(completed.patientId)) === "rx_pending",
    await statusOf(completed.patientId),
  );
  check(
    "and never the exit",
    (await statusOf(completed.patientId)) !== "exited",
    "the counter closes the visit now",
  );
  // The back door found on live data: advancing into the consultant's queue used
  // to imply the arrival, writing reception's step for them.
  const { rows: implied } = await client.query(
    `SELECT count(*)::int AS c FROM giniflow_visit_events e
       JOIN giniflow_visits v ON v.id = e.visit_id
      WHERE v.visit_date = $1::date AND e.status = 'checked_in'
        AND e.actor_role = 'system'`,
    [day],
  );
  check(
    "and the arrival is never implied on reception's behalf",
    implied[0].c === 0,
    `${implied[0].c} written by the sync`,
  );

  const inVisitStatus = await statusOf(inVisit.patientId);
  check(
    "a patient in the consultation stage reaches the consultant",
    ["ready_for_doctor", "with_doctor"].includes(inVisitStatus),
    inVisitStatus,
  );

  // The refusals are counted, so a log line can say how much the sync declined.
  const third = await syncAppointmentsToFlow({ date: day, db });
  check("refusals are counted, not silent", third.refused >= 1, JSON.stringify(third));
} finally {
  await client.query("ROLLBACK");
  client.release();
  const { rows: left } = await pool.query(
    `SELECT count(*)::int AS c FROM patients WHERE file_no LIKE 'ZZHF_%'`,
  );
  check("the synthetic patients left no trace", left[0].c === 0, `${left[0].c} rows`);
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  await pool.end();
  process.exit(failures ? 1 : 0);
}
