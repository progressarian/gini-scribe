#!/usr/bin/env node
// Fails the build if any CRM file reaches the database without the crm_app
// role switch.
//
// withCrmContext() in server/crm/db.js is the only sanctioned path: it opens a
// transaction, drops to crm_app, declares the acting user, and asserts the role
// actually took effect. A handler that imports the pool directly would query as
// Supabase's `postgres` role, which holds BYPASSRLS — every policy silently
// stops applying and a growth executive could read the whole universe.
//
// Run: node server/crm/checkNoDirectPool.mjs

import { readdir, readFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CRM_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(CRM_DIR, "..", "..");

// db.js is the chokepoint itself, and resolveCrmUser's identity lookup is the
// one legitimate direct read (crm.users is not FORCE'd precisely so that
// lookup cannot recurse into the policies that depend on its answer).
const ALLOWED = new Set(["db.js", "checkNoDirectPool.mjs", "assertCrmIsolation.js"]);

const OFFENCES = [
  { pattern: /from\s+["'][^"']*config\/db\.js["']/, why: "imports the pg pool directly" },
  { pattern: /\bpool\s*\.\s*(query|connect)\s*\(/, why: "calls pool.query/pool.connect directly" },
  { pattern: /\bnew\s+(pg\.)?Pool\s*\(/, why: "opens its own connection pool" },
  { pattern: /\bnew\s+(pg\.)?Client\s*\(/, why: "opens its own client connection" },
];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const findings = [];
for (const file of await walk(CRM_DIR)) {
  const name = relative(CRM_DIR, file);
  if (ALLOWED.has(name)) continue;

  const lines = (await readFile(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
    for (const { pattern, why } of OFFENCES) {
      if (pattern.test(line)) {
        findings.push({ file: relative(REPO_ROOT, file), line: i + 1, why, text: line.trim() });
      }
    }
  });
}

if (findings.length > 0) {
  console.error("CRM ROLE-SWITCH GUARD FAILED\n");
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} — ${f.why}`);
    console.error(`    ${f.text}\n`);
  }
  console.error(
    "Every CRM query must go through withCrmContext() in server/crm/db.js, which\n" +
      "drops to the crm_app role. Querying as the pool role bypasses RLS entirely:\n" +
      "Supabase grants BYPASSRLS to `postgres`, so the 52 policies stop applying and\n" +
      "clinical data becomes reachable from the growth CRM.\n",
  );
  process.exit(1);
}

console.log("CRM role-switch guard: no direct database access under server/crm/");
