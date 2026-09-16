#!/usr/bin/env node
// Convert plaintext login PINs to bcrypt hashes.
//
// routes/auth.js has always supported both — "Support both bcrypt hash and
// legacy plain-text pin" — so accounts created before hashing was added still
// hold their PIN in the clear, readable by anyone with database access. The
// login path is unchanged by this: hashing the SAME value keeps every existing
// PIN working, because auth compares with bcrypt when the stored value starts
// with $2 and falls back to string equality when it does not.
//
//   railway run -s gini-scribe -e production -- \
//     node server/scripts/hash-plaintext-pins.mjs [--commit]
//
// Dry by default. Never prints a PIN.
//
// The safety here is that every hash is verified against its own plaintext
// BEFORE the transaction commits. A PIN that does not round-trip aborts the
// whole run rather than locking somebody out of the hospital's system.

import "../loadEnv.js";
import bcrypt from "bcrypt";

const COMMIT = process.argv.includes("--commit");
const pool = (await import("../config/db.js")).default;

const { rows: all } = await pool.query(
  `SELECT id, name, role, is_active, pin
     FROM public.doctors
    WHERE pin IS NOT NULL AND btrim(pin) <> ''
    ORDER BY id`,
);

const hashed = all.filter((r) => r.pin.startsWith("$2"));
const plain = all.filter((r) => !r.pin.startsWith("$2"));

console.log(`\naccounts with a PIN: ${all.length}`);
console.log(`   already bcrypt:   ${hashed.length}`);
console.log(`   plaintext:        ${plain.length}`);

if (plain.length === 0) {
  console.log("\nNothing to do.\n");
  await pool.end();
  process.exit(0);
}

console.log("\nplaintext accounts (PIN never shown):");
for (const r of plain) {
  console.log(
    `   #${String(r.id).padStart(3)}  ${(r.name || "").slice(0, 24).padEnd(24)}` +
      ` role=${(r.role || "—").padEnd(18)} active=${r.is_active}  length=${r.pin.length}`,
  );
}

if (!COMMIT) {
  console.log("\nDry run. Nothing written. Re-run with --commit.\n");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
let converted = 0;
try {
  await client.query("BEGIN");

  for (const r of plain) {
    const hash = await bcrypt.hash(r.pin, 10);

    // Verify before trusting it. A hash that does not match its own source
    // would lock this person out permanently, since the plaintext is gone the
    // moment we commit.
    if (!(await bcrypt.compare(r.pin, hash))) {
      throw new Error(`hash did not round-trip for doctor #${r.id} — aborting every change`);
    }

    // WHERE pin = the exact plaintext, so a concurrent change during this run
    // is skipped rather than overwritten.
    const { rowCount } = await client.query(
      `UPDATE public.doctors SET pin = $2 WHERE id = $1 AND pin = $3`,
      [r.id, hash, r.pin],
    );
    if (rowCount !== 1) {
      throw new Error(`doctor #${r.id} changed underneath this run — aborting every change`);
    }
    converted++;
  }

  // Read back inside the transaction and prove every PIN still authenticates
  // exactly as it did before. Only then commit.
  for (const r of plain) {
    const { rows } = await client.query("SELECT pin FROM public.doctors WHERE id = $1", [r.id]);
    const stored = rows[0]?.pin ?? "";
    if (!stored.startsWith("$2") || !(await bcrypt.compare(r.pin, stored))) {
      throw new Error(`verification failed for doctor #${r.id} — aborting every change`);
    }
  }

  await client.query("COMMIT");
  console.log(`\n${converted} PINs hashed and verified. Every one still logs in unchanged.\n`);
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`\nFAILED — nothing changed: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
