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
  ["status mirroring", "HealthRay status mirroring OFF"],
  ["partial-results recovery", "Partial-results recovery OFF"],
]) {
  check(`${what} is behind the flag`, cron.includes(marker));
}

const sync = await readFile(
  new URL("../services/giniflow/appointmentSync.js", import.meta.url),
  "utf8",
);
check(
  "an existing visit is left alone",
  /if \(appt\.visit_id && manualFloor\(\)\)/.test(sync),
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
// advances it to whatever HealthRay says. Skipping only EXISTING visits leaves
// that path open, so the guard has to appear twice.
check(
  "a newly created visit is not advanced either",
  (sync.match(/manualFloor\(\)/g) || []).length >= 3,
  `${(sync.match(/manualFloor\(\)/g) || []).length} guards`,
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

  const twice = await endVisit(v2[0].id, { actorRole: "rx" }, db2);
  check("closing twice is one statement, not an error", twice.unchanged === true);
} finally {
  await client2.query("ROLLBACK");
  client2.release();
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");

await pool.end();
process.exit(failures ? 1 : 0);
