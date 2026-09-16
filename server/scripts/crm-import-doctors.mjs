#!/usr/bin/env node
// Import a doctor list from the command line, through the same module the
// wizard UI uses (server/crm/importDoctors.js) — same mapping, same dedup,
// same preview. The wizard is the normal way in; this exists for the first
// load, when there is no CRM user yet to sign in and click through it.
//
//   railway run -s gini-scribe -e production -- \
//     node server/scripts/crm-import-doctors.mjs <file.csv> --owner-email x@y.z
//
// Dry run by default. --commit is the only thing that writes doctors.
//
//   --owner "Full Name"   the CRM user the import is attributed to
//   --role  head_of_growth
//   --skip  4,17          row numbers to leave out
//   --only-territory Mohali,Chandigarh
//                         import only rows resolving to these territories;
//                         everything else stays staged for a later run
//   --commit              actually write

import "../loadEnv.js";
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

if (!file || !fs.existsSync(file)) {
  console.error("usage: node scripts/crm-import-doctors.mjs <file.csv> [--owner NAME] [--commit]");
  process.exit(1);
}

const OWNER = flag("owner", "Virender Satija");
const ROLE = flag("role", "head_of_growth");
const SKIP = (flag("skip", "") || "").split(",").filter(Boolean).map(Number);
const ONLY = (flag("only-territory", "") || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const COMMIT = has("commit");

const { parseSheet, suggestMapping, createBatch, previewBatch, commitBatch } =
  await import("../crm/importDoctors.js");
const pool = (await import("../config/db.js")).default;

/**
 * The CRM needs a crm.users row to act as, and that row needs an identity
 * anchor — a Scribe login or a Supabase Auth user. Neither exists for a growth
 * hire on day one.
 *
 * The Scribe row is created INACTIVE and with no PIN: it cannot be logged into
 * (routes/auth.js requires is_active), and it stays out of the clinical doctor
 * pickers. It is an identity to hang the CRM role on, nothing more. When the
 * person needs to sign in, set a PIN and flip is_active.
 */
async function ensureCrmUser(name, role) {
  const { rows: existing } = await pool.query(
    `SELECT u.id, u.full_name, u.role FROM crm.users u WHERE lower(u.full_name) = lower($1::text)`,
    [name],
  );
  if (existing[0]) {
    console.log(`CRM user: ${existing[0].full_name} (${existing[0].role}) already exists`);
    return existing[0];
  }

  const { rows: doc } = await pool.query(
    `INSERT INTO public.doctors (name, short_name, role, is_active)
     SELECT $1::text, $1::text, 'Growth', false
     WHERE NOT EXISTS (SELECT 1 FROM public.doctors WHERE lower(name) = lower($1::text))
     RETURNING id`,
    [name],
  );
  const scribeId =
    doc[0]?.id ??
    (await pool.query("SELECT id FROM public.doctors WHERE lower(name)=lower($1::text)", [name]))
      .rows[0].id;

  const { rows: created } = await pool.query(
    `INSERT INTO crm.users (full_name, role, scribe_doctor_id, is_active)
     VALUES ($1, $2, $3, true) RETURNING id, full_name, role`,
    [name, role, scribeId],
  );
  await pool.query(
    `INSERT INTO crm.user_hospitals (user_id, hospital_id)
     SELECT $1, id FROM crm.hospitals WHERE code = 'GACH' ON CONFLICT DO NOTHING`,
    [created[0].id],
  );
  console.log(
    `CRM user: created ${name} as ${role} (Scribe identity #${scribeId}, inactive — cannot log in)`,
  );
  return created[0];
}

const before = (await pool.query("SELECT count(*)::int n FROM crm.doctors")).rows[0].n;
console.log(`\ncrm.doctors before: ${before}`);

const user = await ensureCrmUser(OWNER, ROLE);

const { headers, rows } = parseSheet(fs.readFileSync(file), path.basename(file));
const mapping = suggestMapping(headers);
const unmapped = headers.filter((h) => !mapping[h]);
console.log(`\nfile: ${path.basename(file)} — ${rows.length} rows`);
console.log(
  `mapped: ${Object.entries(mapping)
    .map(([h, f]) => `${h}→${f}`)
    .join(", ")}`,
);
if (unmapped.length) console.log(`UNMAPPED (will be dropped): ${unmapped.join(", ")}`);

const { batchId } = await createBatch(user, {
  fileName: path.basename(file),
  headers,
  rows,
  mapping,
});
const pv = await previewBatch(user, batchId);
console.log(`\npreview: ${JSON.stringify(pv.counts)}`);

const norm = (t) =>
  String(t ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const inScope = ONLY.length
  ? pv.rows.filter((r) => ONLY.some((t) => norm(t) === norm(r.resolved_territory)))
  : pv.rows;
if (ONLY.length) {
  const byTerr = {};
  for (const r of inScope) byTerr[r.resolved_territory] = (byTerr[r.resolved_territory] || 0) + 1;
  console.log(`scope:   ${ONLY.join(", ")}`);
  Object.entries(byTerr)
    .sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(`           ${String(n).padStart(4)}  ${t}`));
  // Mirror commitBatch exactly: it skips errors, hard duplicates and anything
  // explicitly excluded. Counting them as importable would mean the number
  // approved is not the number that lands.
  const willCreate = inScope.filter(
    (r) => r.status !== "error" && r.status !== "duplicate" && !SKIP.includes(r.row_number),
  ).length;
  const dupInScope = inScope.filter((r) => r.status === "duplicate").length;
  const maybeInScope = inScope.filter((r) => r.status === "possible_duplicate");
  const shared = inScope.filter((r) => r.flags.some((f) => /clinic line/.test(f))).length;
  console.log(
    `in scope: ${inScope.length} rows -> ${willCreate} would import` +
      ` (${shared} share a clinic line, ${dupInScope} skipped as duplicates)`,
  );
  for (const r of maybeInScope) {
    console.log(
      `   REVIEW row ${r.row_number}: ${r.values.full_name} (${r.resolved_territory}) — ` +
        (r.matched_doctor
          ? `matches existing "${r.matched_doctor.full_name}"`
          : r.flags.join("; ")),
    );
  }
  console.log(`held:    ${pv.rows.length - inScope.length} rows stay staged`);
}
console.log(`batch:   ${batchId}`);

const staged = (await pool.query("SELECT count(*)::int n FROM crm.doctors")).rows[0].n;
if (staged !== before) {
  console.error(`\nABORT: preview changed crm.doctors (${before} -> ${staged}). This is a bug.`);
  await pool.end();
  process.exit(1);
}
console.log(`crm.doctors after preview: ${staged} (unchanged, as it must be)`);

if (!COMMIT) {
  console.log("\nDry run. Nothing written. Re-run with --commit to import.");
  await pool.end();
  process.exit(0);
}

console.log(`\ncommitting${SKIP.length ? `, skipping rows ${SKIP.join(", ")}` : ""}…`);
const result = await commitBatch(user, batchId, SKIP, { onlyTerritories: ONLY });
const after = (await pool.query("SELECT count(*)::int n FROM crm.doctors")).rows[0].n;

console.log(`\nresult: ${JSON.stringify(result)}`);
console.log(`crm.doctors: ${before} -> ${after}`);
await pool.end();
