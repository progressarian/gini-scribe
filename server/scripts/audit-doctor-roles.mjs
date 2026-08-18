// READ-ONLY pre-flight for flipping GRANT_ALL_CAPABILITIES to false.
//
// normalizeRole() fails closed: any stored doctors.role that isn't a canonical
// ROLES value (or a ROLE_ALIASES entry) becomes `guest`, which holds ZERO
// capabilities. While the master switch is on that is invisible — everyone
// passes every check regardless. The moment it is off, those accounts can log
// in and then see nothing.
//
// Run this BEFORE flipping, and fix any stored role it flags:
//   node server/scripts/audit-doctor-roles.mjs
//
// Issues no writes.

import "../loadEnv.js"; // must precede config/db.js — it doesn't load .env itself
import pool from "../config/db.js";
import { ROLES, ROLE_CAPABILITIES, normalizeRole } from "../../shared/permissions.js";

const { rows } = await pool.query(
  `SELECT COALESCE(role, '<NULL>') AS role,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_active)::int AS active
     FROM doctors
    GROUP BY 1
    ORDER BY 3 DESC, 2 DESC`,
);

console.log(`${"stored role".padEnd(20)}${"total".padEnd(8)}${"active".padEnd(8)}normalizes to`);
console.log("-".repeat(72));

// Two different situations both end at `guest`, and only one is a bug:
//   - stored role IS "guest"      → deliberate no-access account, fine
//   - stored role is unrecognized → silent fallback, an accidental lockout
let strandedAccounts = 0;
const strandedRoles = [];
let deliberateGuests = 0;
for (const r of rows) {
  const stored = r.role === "<NULL>" ? null : r.role;
  const norm = normalizeRole(stored);
  const caps = ROLE_CAPABILITIES[norm];
  const fellBack = norm === ROLES.GUEST && stored !== ROLES.GUEST;
  if (fellBack) {
    strandedAccounts += r.active;
    strandedRoles.push(`${r.role} (${r.active} active)`);
  } else if (norm === ROLES.GUEST) {
    deliberateGuests += r.active;
  }
  console.log(
    `${String(r.role).padEnd(20)}${String(r.total).padEnd(8)}${String(r.active).padEnd(8)}` +
      `${norm} ${caps === "*" ? "(ALL)" : `(${caps.length} caps)`}` +
      `${fellBack ? "   <-- UNRECOGNIZED: silently becomes guest, 0 capabilities" : ""}`,
  );
}

console.log("-".repeat(72));
if (strandedAccounts === 0) {
  console.log("OK: every stored role is canonical — no account falls back to guest.");
  if (deliberateGuests > 0) {
    console.log(
      `Note: ${deliberateGuests} active account(s) are explicitly role='guest' and so see ` +
        `nothing under enforcement. That is what guest means — intended, not a fault.`,
    );
  }
} else {
  console.log(`WARNING: ${strandedAccounts} ACTIVE account(s) are locked out.`);
  console.log(`Unrecognized stored roles: ${strandedRoles.join(", ")}`);
  console.log("Fix doctors.role for these accounts, or add a ROLE_ALIASES entry.");
}

await pool.end();
process.exit(strandedAccounts === 0 ? 0 : 1);
