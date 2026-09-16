// Scribe as the system of record (docs/gini-flow/38-MANUAL-FLOOR-PLAN.md).
//
// The flag is one switch across several files, and the thing it must guarantee is
// negative: that nothing moves a patient except a person. A negative is easy to
// believe and hard to notice breaking, so it is asserted here.
//
// Nothing writes. The sync paths are exercised against a synthetic visit inside a
// transaction that is always rolled back.
//
//   npm run smoke:manual-floor   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";
import { manualFloor } from "../../shared/manualFloor.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const withFlag = async (on, fn) => {
  const before = process.env.SCRIBE_MANUAL_FLOOR;
  process.env.SCRIBE_MANUAL_FLOOR = on ? "1" : "0";
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.SCRIBE_MANUAL_FLOOR;
    else process.env.SCRIBE_MANUAL_FLOOR = before;
  }
};

console.log("── The switch itself ───────────────────────────────────────");
const was = process.env.SCRIBE_MANUAL_FLOOR;
delete process.env.SCRIBE_MANUAL_FLOOR;
check("on with no variable set at all", manualFloor(), "a deploy needs no env change");
await withFlag(true, async () => check("on when set to 1", manualFloor()));
await withFlag(false, async () => check("and only '0' hands the floor back", !manualFloor()));
process.env.SCRIBE_MANUAL_FLOOR = "no";
check(
  "a typo leaves the floor manual",
  manualFloor(),
  "the safe direction — a mistyped .env cannot restart the sync",
);
if (was === undefined) delete process.env.SCRIBE_MANUAL_FLOOR;
else process.env.SCRIBE_MANUAL_FLOOR = was;

console.log("\n── What it stops ───────────────────────────────────────────");
// Read the sources rather than run the cron: starting the loops would poke
// HealthRay, and what matters is that each start is behind the flag.
import { readFile } from "fs/promises";
const cron = await readFile(new URL("../services/cron/index.js", import.meta.url), "utf8");
for (const [what, marker] of [
  ["the lab sync", "Lab HealthRay sync OFF"],
  ["pending-case recovery", "Lab pending-case recovery OFF"],
  ["the PDF retry", "Lab PDF retry OFF"],
  ["the blank-PDF sweep", "Blank lab PDF sweep OFF"],
  ["status mirroring", "HealthRay status mirroring OFF"],
  ["partial-results recovery", "Partial-results recovery OFF"],
]) {
  check(`${what} is behind the flag`, cron.includes(marker));
}

const sync = await readFile(
  new URL("../services/giniflow/appointmentSync.js", import.meta.url),
  "utf8",
);
// Superseded by the per-status allowlist (39-HYBRID-FLOOR-PLAN.md §4): the
// blanket "write nothing" became "write only the consultation", so the guard is
// now on the TARGET rather than on the flag. What has to stay true is that a
// visit which already exists is not walked forward by a poll — asserted here on
// the shape, and end to end in smoke:hybrid-floor.
check(
  "an existing visit is only touched for a step the sync may write",
  /appt\.visit_id &&\s*\(?!mayWrite\(target\)/.test(sync),
  "the 30s poll must not walk a patient forward",
);
check(
  "HealthRay vitals are not observed",
  /manualFloor\(\) \? 0 : await observeHealthrayVitals/.test(sync),
);
// The grace timer closed 24 visits on the day the flag went in. An exit is the
// counter's to record, and a timer recording it is a step nobody took.
check(
  "the pharmacy grace timer does not end visits",
  /manualFloor\(\)\s*\?\s*0\s*:\s*await sweepPharmacyLeg/.test(sync),
);
// The back door: a brand-new visit is created at `booked`, then the same tick
// advances it to whatever HealthRay says. Guarding only EXISTING visits leaves
// that path open, so the check has to appear twice.
check(
  "a newly created visit is not advanced either",
  (sync.match(/!mayWrite\(target\)/g) || []).length >= 2,
  `${(sync.match(/!mayWrite\(target\)/g) || []).length} guards`,
);
check(
  "and a visit is only ever created at 'booked'",
  /VALUES \(\$1, \$2::date, \$3, \$4::time, 'booked', \$5\)/.test(sync),
);

console.log("\n── What it keeps ───────────────────────────────────────────");
check(
  "the day's list still creates visits",
  !/manualFloor/.test(
    sync.slice(
      sync.indexOf("INSERT INTO giniflow_visits") - 400,
      sync.indexOf("INSERT INTO giniflow_visits"),
    ),
  ),
  "reception must still have somebody to check in",
);
check(
  "the booked consultant is still attached",
  /Assignment stays even on a manual floor/.test(sync),
);

console.log("\n── Against a real visit ────────────────────────────────────");
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: p } = await client.query(
    `INSERT INTO patients (name, file_no) VALUES ('Probe Manual', $1) RETURNING id`,
    [`ZZMF_${Date.now()}`],
  );
  const { rows: v } = await client.query(
    `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
     VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, 'no_show', 'none') RETURNING id`,
    [p[0].id],
  );
  const { rows: after } = await client.query(
    `SELECT current_status FROM giniflow_visits WHERE id = $1`,
    [v[0].id],
  );
  check(
    "a visit reception marked no-show keeps that status",
    after[0].current_status === "no_show",
    after[0].current_status,
  );
} finally {
  await client.query("ROLLBACK");
  client.release();
}

console.log("\n── The counter can end a visit ─────────────────────────────");
// ~90% of visits never reach a dispense. HealthRay's checkout closed those; the
// counter has to now, or the board fills with patients who never leave it.
const { CAPABILITIES: C, hasCapability } = await import("../../shared/permissions.js");
const { endVisit } = await import("../services/giniflow/pharmacyStation.js");

check(
  "pharmacy and the prescription explainer can end a visit",
  ["pharmacy", "rx"].every((r) => hasCapability(r, C.GINIFLOW_END_VISIT)),
);
check(
  "and nobody who cannot see the patient leave",
  ["mo", "consultant", "nurse", "lab", "lab_admin", "machine_tech", "tech"].every(
    (r) => !hasCapability(r, C.GINIFLOW_END_VISIT),
  ),
);

const client2 = await pool.connect();
try {
  await client2.query("BEGIN");
  const { rows: p2 } = await client2.query(
    `INSERT INTO patients (name, file_no) VALUES ('Probe End', $1) RETURNING id`,
    [`ZZEV_${Date.now()}`],
  );
  const { rows: v2 } = await client2.query(
    `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
     VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, 'with_doctor', 'none') RETURNING id`,
    [p2[0].id],
  );
  // The stops ahead of them, so the close has a plan to write on. A counter exit
  // must not tick these: nobody explained a prescription or dispensed anything.
  await client2.query(
    `INSERT INTO giniflow_visit_steps
       (visit_id, step_order, step_name, chain_status, status, planned_duration_min, source)
     VALUES ($1, 1, 'Prescription Explain', 'with_rx', 'pending', 5, 'template'),
            ($1, 2, 'Pharmacy / Exit', 'dispensed', 'pending', 10, 'template')`,
    [v2[0].id],
  );
  const nested2 = {
    query: (t, params) => {
      const sql = String(t).trim().toUpperCase();
      if (sql === "BEGIN") return client2.query("SAVEPOINT ev");
      if (sql === "COMMIT") return client2.query("RELEASE SAVEPOINT ev");
      if (sql === "ROLLBACK") return client2.query("ROLLBACK TO SAVEPOINT ev");
      return client2.query(t, params);
    },
    release: () => {},
  };
  const db2 = { connect: async () => nested2 };

  const closed = await endVisit(v2[0].id, { actorRole: "pharmacy" }, db2);
  check(
    "a patient with no medicines can be closed",
    closed.currentStatus === "exited",
    closed.from,
  );

  const { rows: after2 } = await client2.query(
    `SELECT current_status FROM giniflow_visits WHERE id = $1`,
    [v2[0].id],
  );
  check("and the visit really ends", after2[0].current_status === "exited");

  const { rows: ev } = await client2.query(
    `SELECT status, meta->>'source' AS src FROM giniflow_visit_events
      WHERE visit_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
    [v2[0].id],
  );
  check("attributed to the counter, not to a sync", ev[0]?.src === "counter_end_visit", ev[0]?.src);
  check(
    "and never claims a dispense that did not happen",
    ev[0]?.status === "exited",
    "dispensed is what the medicine reports count",
  );

  const { rows: steps2 } = await client2.query(
    `SELECT step_name, status FROM giniflow_visit_steps WHERE visit_id = $1 ORDER BY step_order`,
    [v2[0].id],
  );
  check(
    "and the journey does not tick the stops they never reached",
    steps2.every((st) => st.status === "skipped"),
    steps2.map((st) => `${st.step_name}: ${st.status}`).join(" · "),
  );

  // The same close, on a patient the Rx desk has not cleared: allowed, but no
  // longer silent. This is the whole reason the button stays enabled.
  // Their own patient: one visit per patient per day is a constraint, not a hint.
  const { rows: p3 } = await client2.query(
    `INSERT INTO patients (name, file_no) VALUES ('Probe End Unexplained', $1) RETURNING id`,
    [`ZZEV_${Date.now()}_2`],
  );
  const { rows: v3 } = await client2.query(
    `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
     VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, 'rx_pending', 'none') RETURNING id`,
    [p3[0].id],
  );
  let refused = null;
  try {
    await endVisit(v3[0].id, { actorRole: "pharmacy" }, db2);
  } catch (e) {
    refused = e;
  }
  check(
    "THE COUNTER CANNOT CLOSE A PATIENT THE RX DESK HAS NOT PASSED ON",
    refused?.status === 409 && refused?.awaitingRx === true,
    refused?.message,
  );
  const { rows: stillHere } = await client2.query(
    `SELECT current_status FROM giniflow_visits WHERE id = $1`,
    [v3[0].id],
  );
  check(
    "so they stay in the Rx queue rather than leaving the floor",
    stillHere[0]?.current_status === "rx_pending",
    stillHere[0]?.current_status,
  );

  // And the desk they are waiting for can see them — a rule that stranded them
  // on a screen nobody opens would be worse than the gap it closes.
  const { rows: inQueue } = await client2.query(
    `SELECT count(*)::int n FROM giniflow_visits
      WHERE id = $1 AND current_status = ANY($2::text[])`,
    [v3[0].id, ["doctor_done", "rx_pending", "with_rx"]],
  );
  check("and the Rx desk's own queue is where they are", inQueue[0]?.n === 1);

  const byDesk = await endVisit(v3[0].id, { actorRole: "rx", explained: true }, db2);
  check("the Rx desk closes the same patient", byDesk.currentStatus === "exited", byDesk.from);

  // The Rx desk's own close. Its button says "Explained — patient leaving", so it
  // needs no reason and the stop it names comes out done, not skipped.
  const { rows: p4 } = await client2.query(
    `INSERT INTO patients (name, file_no) VALUES ('Probe End Explained', $1) RETURNING id`,
    [`ZZEV_${Date.now()}_3`],
  );
  const { rows: v4 } = await client2.query(
    `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
     VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, 'rx_pending', 'none') RETURNING id`,
    [p4[0].id],
  );
  await client2.query(
    `INSERT INTO giniflow_visit_steps
       (visit_id, step_order, step_name, chain_status, status, planned_duration_min, source)
     VALUES ($1, 1, 'Prescription Explain', 'with_rx', 'pending', 5, 'template'),
            ($1, 2, 'Pharmacy / Exit', 'dispensed', 'pending', 10, 'template')`,
    [v4[0].id],
  );
  const byRx = await endVisit(v4[0].id, { actorRole: "rx", explained: true }, db2);
  check("and its close is the explanation, not a skip", byRx.currentStatus === "exited", byRx.from);
  const { rows: rxSteps } = await client2.query(
    `SELECT step_name, status FROM giniflow_visit_steps WHERE visit_id = $1 ORDER BY step_order`,
    [v4[0].id],
  );
  check(
    "and the stop it just did is ticked, while the pharmacy's is not",
    rxSteps[0]?.status === "done" && rxSteps[1]?.status === "skipped",
    rxSteps.map((st) => `${st.step_name}: ${st.status}`).join(" · "),
  );

  const twice = await endVisit(v2[0].id, { actorRole: "rx" }, db2);
  check("closing twice is one statement, not an error", twice.unchanged === true);
} finally {
  await client2.query("ROLLBACK");
  client2.release();
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");

await pool.end();
process.exit(failures ? 1 : 0);
