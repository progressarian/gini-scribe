#!/usr/bin/env node
// Onboard a growth team member in one command.
//
// Four things have to line up before somebody can work the CRM, and they live
// in three different places. Doing them by hand means a half-onboarded user who
// can log in but sees nothing, or sees everything.
//
//   1. Scribe login      public.doctors — role + PIN, so they can authenticate
//   2. CRM identity      crm.users      — the role RLS reads
//   3. Hospital scope    crm.user_hospitals
//   4. Doctors to work   crm.doctor_assignments, usually a whole territory
//
//   railway run -s gini-scribe -e production -- node server/scripts/crm-onboard-user.mjs \
//     --name "Rajeev Malhotra" --role growth_executive \
//     --manager "Virender Satija" --territory Kharar --pin 4417 --commit
//
// Dry by default: prints exactly what it would do and changes nothing.
//
//   --name       required
//   --role       head_of_growth | growth_manager | growth_executive | clinical_team | operations | ceo_admin
//   --manager    full name of their CRM manager (sets crm.users.manager_id)
//   --territory  assign every doctor in this territory to them (repeatable, comma-separated)
//   --pin        4-6 digits; omit to create the login inactive until they have one
//   --mobile     contact number, normalised on write
//   --commit     actually write

import "../loadEnv.js";
import bcrypt from "bcrypt";

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const has = (n) => args.includes(`--${n}`);

const NAME = flag("name");
const ROLE = flag("role", "growth_executive");
const MANAGER = flag("manager");
const TERRITORIES = (flag("territory", "") || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const PIN = flag("pin");
const MOBILE = flag("mobile");
const COMMIT = has("commit");

// Mirrors crm.user_role's CHECK constraint. Kept as a literal rather than
// imported from crmVocab so a typo here fails before any write, not at INSERT.
const CRM_ROLES = [
  "ceo_admin",
  "head_of_growth",
  "growth_manager",
  "growth_executive",
  "clinical_team",
  "operations",
];
// Only these three get a Scribe login of their own; clinical_team and
// operations are existing hospital staff who already have one.
const SCRIBE_ROLE_FOR = {
  head_of_growth: "head_of_growth",
  growth_manager: "growth_manager",
  growth_executive: "growth_executive",
};

if (!NAME || !CRM_ROLES.includes(ROLE)) {
  console.error(`usage: --name "Full Name" --role <${CRM_ROLES.join("|")}> [--manager NAME]`);
  console.error(`       [--territory Kharar,Mohali] [--pin 4417] [--mobile 98765xxxxx] [--commit]`);
  process.exit(1);
}
if (PIN && !/^\d{4,6}$/.test(PIN)) {
  console.error("PIN must be 4-6 digits");
  process.exit(1);
}

const pool = (await import("../config/db.js")).default;
const plan = [];
const say = (line) => plan.push(line);

const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0] ?? null;

// ---- 1. Scribe login ----------------------------------------------------
const scribeRole = SCRIBE_ROLE_FOR[ROLE] ?? null;
let scribe = await one(
  "SELECT id, role, is_active FROM public.doctors WHERE lower(name)=lower($1::text)",
  [NAME],
);

if (scribe) {
  say(`Scribe login   #${scribe.id} exists (role=${scribe.role}, active=${scribe.is_active})`);
  if (scribeRole && scribe.role !== scribeRole) say(`               role -> ${scribeRole}`);
  if (PIN && !scribe.is_active) say(`               activating with the supplied PIN`);
} else if (scribeRole) {
  say(
    `Scribe login   create, role=${scribeRole}, ${PIN ? "active with PIN" : "INACTIVE until a PIN is set"}`,
  );
} else {
  say(
    `Scribe login   none — ${ROLE} is an existing hospital role; link an existing account instead`,
  );
}

// ---- 2. CRM identity ----------------------------------------------------
const crmUser = await one(
  "SELECT id, role, manager_id FROM crm.users WHERE lower(full_name)=lower($1::text)",
  [NAME],
);
let manager = null;
if (MANAGER) {
  manager = await one(
    "SELECT id, full_name, role FROM crm.users WHERE lower(full_name)=lower($1::text)",
    [MANAGER],
  );
  if (!manager) {
    console.error(`\nManager "${MANAGER}" has no crm.users row. Onboard them first.`);
    await pool.end();
    process.exit(1);
  }
}
say(
  crmUser
    ? `CRM identity   exists (role=${crmUser.role})${crmUser.role !== ROLE ? ` -> ${ROLE}` : ""}`
    : `CRM identity   create as ${ROLE}${manager ? `, reporting to ${manager.full_name}` : ""}`,
);

// ---- 3 & 4. Scope and doctors ------------------------------------------
const hospital = await one("SELECT id, code FROM crm.hospitals WHERE code='GACH'");
say(`Hospital       ${hospital.code}`);

const territoryRows = [];
for (const t of TERRITORIES) {
  const row = await one(
    "SELECT id, name FROM crm.territories WHERE lower(name)=lower($1::text) AND deleted_at IS NULL",
    [t],
  );
  if (!row) {
    console.error(`\nUnknown territory "${t}".`);
    await pool.end();
    process.exit(1);
  }
  const { count, assigned } = await one(
    `SELECT count(*)::int AS count,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM crm.doctor_assignments a
               WHERE a.doctor_id = d.id AND a.effective_to IS NULL))::int AS assigned
       FROM crm.doctors d WHERE d.territory_id = $1 AND d.deleted_at IS NULL`,
    [row.id],
  );
  territoryRows.push({ ...row, count, assigned });
  say(
    `Territory      ${row.name}: ${count} doctors, ${assigned} already owned -> ${count - assigned} to assign`,
  );
}

console.log(`\nOnboarding ${NAME} as ${ROLE}\n`);
plan.forEach((l) => console.log("   " + l));

if (!COMMIT) {
  console.log("\nDry run. Nothing written. Re-run with --commit.\n");
  await pool.end();
  process.exit(0);
}

// ---- writes -------------------------------------------------------------
const client = await pool.connect();
try {
  await client.query("BEGIN");

  if (scribeRole) {
    const pinHash = PIN ? await bcrypt.hash(PIN, 10) : null;
    if (scribe) {
      await client.query(
        `UPDATE public.doctors
            SET role = $2,
                pin = COALESCE($3, pin),
                is_active = CASE WHEN $3 IS NOT NULL THEN true ELSE is_active END
          WHERE id = $1`,
        [scribe.id, scribeRole, pinHash],
      );
    } else {
      scribe = await one(
        `INSERT INTO public.doctors (name, short_name, role, pin, phone, is_active)
         VALUES ($1::text, $1::text, $2, $3, $4, $5) RETURNING id`,
        [NAME, scribeRole, PIN ? await bcrypt.hash(PIN, 10) : null, MOBILE, Boolean(PIN)],
      );
    }
  }

  let userId = crmUser?.id;
  if (userId) {
    await client.query(
      `UPDATE crm.users SET role=$2, manager_id=COALESCE($3, manager_id),
              scribe_doctor_id=COALESCE($4, scribe_doctor_id), mobile=COALESCE($5, mobile),
              is_active=true
        WHERE id=$1`,
      [userId, ROLE, manager?.id ?? null, scribe?.id ?? null, MOBILE],
    );
  } else {
    const { rows } = await client.query(
      `INSERT INTO crm.users (full_name, role, manager_id, scribe_doctor_id, mobile, is_active)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
      [NAME, ROLE, manager?.id ?? null, scribe?.id ?? null, MOBILE],
    );
    userId = rows[0].id;
  }

  await client.query(
    `INSERT INTO crm.user_hospitals (user_id, hospital_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, hospital.id],
  );

  let assignedTotal = 0;
  for (const t of territoryRows) {
    // Only doctors nobody owns. Reassignment is a deliberate act with its own
    // history, not something an onboarding script should do silently.
    const { rowCount } = await client.query(
      `INSERT INTO crm.doctor_assignments (hospital_id, doctor_id, executive_id, manager_id, territory_id, assigned_by, reason)
       SELECT $1, d.id, $2, $3, $4, $2, 'Onboarding: ' || $5
         FROM crm.doctors d
        WHERE d.territory_id = $4 AND d.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM crm.doctor_assignments a
                           WHERE a.doctor_id = d.id AND a.effective_to IS NULL)`,
      [hospital.id, userId, manager?.id ?? null, t.id, NAME],
    );
    assignedTotal += rowCount;
    console.log(`   assigned ${rowCount} doctors in ${t.name}`);
  }

  await client.query("COMMIT");
  console.log(
    `\nDone. ${NAME} can sign in${PIN ? " now" : " once a PIN is set"} and owns ${assignedTotal} doctors.\n`,
  );
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("\nFAILED, nothing written:", e.message, "\n");
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
