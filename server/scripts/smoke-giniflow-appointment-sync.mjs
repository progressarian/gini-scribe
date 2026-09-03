import "../loadEnv.js";
import { syncAppointmentsToFlow } from "../services/giniflow/appointmentSync.js";

// Stub client: answers the sync's fixed query sequence, records everything else.
function makeDb(appts) {
  const seen = [];
  const client = {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      seen.push(s.slice(0, 60));
      if (s.startsWith("SELECT (now()")) return { rows: [{ d: "2026-09-03" }] };
      if (s.startsWith("UPDATE giniflow_visits v SET assigned_doctor_id")) return { rowCount: 0 };
      if (s.includes("FROM giniflow_visits v JOIN LATERAL")) return { rows: [] }; // vitals observation
      if (s.startsWith("SELECT DISTINCT ON (a.patient_id)")) return { rows: appts };
      if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") return { rows: [] };
      if (s.startsWith("SELECT 1 FROM giniflow_visits")) return { rows: [] }; // consult room free
      if (s.startsWith("SELECT current_status, resume_status FROM giniflow_visits"))
        return { rows: [{ current_status: appts[0].current_status, resume_status: null }] };
      if (s.startsWith("INSERT INTO giniflow_visit_events")) return { rows: [{ id: "e1" }] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { db: { connect: async () => client }, seen };
}

const cases = [
  [
    "cancelled visit, HealthRay says scheduled",
    { status: "scheduled", current_status: "cancelled" },
    false,
  ],
  [
    "no_show visit, HealthRay says scheduled",
    { status: "scheduled", current_status: "no_show" },
    false,
  ],
  [
    "blocked_reports, HealthRay says scheduled",
    { status: "scheduled", current_status: "blocked_reports" },
    false,
  ],
  [
    "no_show visit, HealthRay says checkedin",
    { status: "checkedin", current_status: "no_show" },
    true,
  ],
  [
    "cancelled visit, HealthRay says completed",
    { status: "completed", current_status: "cancelled" },
    true,
  ],
  [
    "booked visit, HealthRay says checkedin",
    { status: "checkedin", current_status: "booked" },
    true,
  ],
  [
    "booked visit, HealthRay says scheduled",
    { status: "scheduled", current_status: "booked" },
    false,
  ],
  [
    "checked_in visit, HealthRay says scheduled",
    { status: "scheduled", current_status: "checked_in" },
    false,
  ],
];

let fail = 0;
for (const [name, appt, shouldAdvance] of cases) {
  const { db, seen } = makeDb([
    {
      id: 1,
      patient_id: 99,
      time_slot: "10:00",
      visit_id: "v1",
      assigned_doctor_id: null,
      booked_doctor_id: null,
      ...appt,
    },
  ]);
  const r = await syncAppointmentsToFlow({ date: "2026-09-03", db });
  const advanced = r.advanced === 1;
  const opened = seen.includes("BEGIN");
  const ok = advanced === shouldAdvance;
  if (!ok) fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name.padEnd(44)} advanced=${advanced} (want ${shouldAdvance}) txn=${opened} unchanged=${r.unchanged}`,
  );
}
console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
