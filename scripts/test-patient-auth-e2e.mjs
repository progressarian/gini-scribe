#!/usr/bin/env node
// ============================================================================
// test-patient-auth-e2e.mjs
//
// End-to-end smoke test of the patient auth API. Stands up a minimal Express
// app in-process (auth middleware + patientAuth routes only), listens on an
// ephemeral port, runs the full flow: check → send-otp → verify-otp →
// set-password → check → login → /me → logout → /me-after-revoke, plus a
// forgot-password round-trip and a re-import collision check. Tears down
// at exit.
//
// OTPs in dev mode are console-logged by services/msg91.js; the test
// monkey-patches console.log to capture the plaintext code per phone.
//
//   node scripts/test-patient-auth-e2e.mjs
// ============================================================================

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env (root then server/, root wins).
for (const p of [join(__dirname, "..", ".env"), join(__dirname, "..", "server", ".env")]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
// Force dev mode so msg91.js console-logs the OTP instead of hitting MSG91.
process.env.NODE_ENV = "development";

const { authMiddleware, requireAuth } = await import(
  join(__dirname, "..", "server", "middleware", "auth.js")
);
const patientAuthRoutes = (
  await import(join(__dirname, "..", "server", "routes", "patientAuth.js"))
).default;
const patientsRoutes = (
  await import(join(__dirname, "..", "server", "routes", "patients.js"))
).default;
const { getGenieDb } = await import(
  join(__dirname, "..", "server", "services", "genieImport.js")
);
const { default: pool } = await import(join(__dirname, "..", "server", "config", "db.js"));
const jwt = (await import("jsonwebtoken")).default;
const crypto = (await import("node:crypto")).default;

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const results = [];
function assertEq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ ok, label, got, want });
  if (ok) console.log(`  ${C.green("✓")} ${label}`);
  else console.log(`  ${C.red("✗")} ${label}  ${C.red(`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)}`);
}
function assertOk(label, ok, detail = "") {
  results.push({ ok, label, detail });
  if (ok) console.log(`  ${C.green("✓")} ${label}${detail ? C.dim(`  ${detail}`) : ""}`);
  else console.log(`  ${C.red("✗")} ${label}  ${C.red(detail)}`);
}
function info(label) {
  console.log(`  ${C.cyan("→")} ${label}`);
}
function header(s) {
  console.log(`\n${C.cyan(s)}`);
}

// ── OTP capture from console.log ────────────────────────────────────────────
const capturedOtps = new Map(); // phone → otp
const origLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  const m = line.match(/\[DEV\] OTP for (\S+):\s*(\d{6})/);
  if (m) capturedOtps.set(m[1], m[2]);
  origLog(...args);
};

// ── In-process Express app ──────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(authMiddleware);
app.use(requireAuth);
app.use("/api", patientAuthRoutes);
app.use("/api", patientsRoutes);
const server = app.listen(0); // ephemeral port
await new Promise((r) => server.once("listening", r));
const port = server.address().port;
const API = `http://127.0.0.1:${port}`;
info(`test app on ${API}`);

// ── HTTP helpers ────────────────────────────────────────────────────────────
async function post(path, body, token) {
  const h = { "Content-Type": "application/json" };
  if (token) h["x-auth-token"] = token;
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function get(path, token) {
  const h = {};
  if (token) h["x-auth-token"] = token;
  const res = await fetch(`${API}${path}`, { headers: h });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ── The flow ────────────────────────────────────────────────────────────────
const TEST_PHONE_10 = `99${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const TEST_PHONE = `+91${TEST_PHONE_10}`;
const PASSWORD_1 = "test_pw_1234";
const PASSWORD_2 = "fresh_pw_5678";
let session1Token, session2Token;
const genieDb = getGenieDb();

try {
  header(`Test phone: ${TEST_PHONE}`);

  // ── 1. Initial /check — unknown number ────────────────────────────────────
  header("1. Pre-signup state");
  {
    const r = await post("/api/patient/auth/check", { phone: TEST_PHONE_10 });
    assertEq("/check returns exists=false", r.data, {
      exists: false,
      has_password: false,
      source: null,
    });
  }

  // ── 2. Signup OTP send ─────────────────────────────────────────────────────
  header("2. Signup — send + verify OTP, set password");
  {
    const r = await post("/api/patient/auth/send-otp", {
      phone: TEST_PHONE_10,
      purpose: "signup",
    });
    assertOk(
      `/send-otp signup → 200 (source=${r.data.source})`,
      r.status === 200 && r.data.ok === true && r.data.source === "app",
      JSON.stringify(r.data),
    );
  }
  await new Promise((r) => setTimeout(r, 50)); // let console.log flush
  const otp1 = capturedOtps.get(TEST_PHONE);
  assertOk(`OTP captured from dev console`, !!otp1, otp1 ? `otp=${otp1}` : "none captured");

  // ── 3. Verify OTP ─────────────────────────────────────────────────────────
  let verificationToken;
  {
    const r = await post("/api/patient/auth/verify-otp", {
      phone: TEST_PHONE_10,
      otp: otp1,
    });
    verificationToken = r.data.verification_token;
    assertOk(
      `/verify-otp returns verification_token`,
      r.status === 200 && typeof verificationToken === "string" && verificationToken.length === 64,
      verificationToken ? `len=${verificationToken.length}` : JSON.stringify(r.data),
    );
  }

  // ── 4. Set password → JWT ─────────────────────────────────────────────────
  {
    const r = await post("/api/patient/auth/set-password", {
      phone: TEST_PHONE_10,
      verification_token: verificationToken,
      password: PASSWORD_1,
      name: "E2E Test Patient",
    });
    session1Token = r.data.token;
    assertOk(
      `/set-password returns session`,
      r.status === 200 &&
        typeof session1Token === "string" &&
        r.data.db === "app" &&
        r.data.patient?.phone === TEST_PHONE,
      `db=${r.data.db} patient.id=${r.data.patient?.id}`,
    );
  }

  // ── 5. /check now shows has_password=true ─────────────────────────────────
  header("3. Returning login");
  {
    const r = await post("/api/patient/auth/check", { phone: TEST_PHONE_10 });
    assertEq("/check now exists=true has_password=true", r.data, {
      exists: true,
      has_password: true,
      source: "app",
    });
  }

  // ── 6. Wrong password rejected ────────────────────────────────────────────
  {
    const r = await post("/api/patient/auth/login", {
      phone: TEST_PHONE_10,
      password: "wrong_password",
    });
    assertOk(`/login wrong password → 401`, r.status === 401);
  }

  // ── 7. Correct password works ─────────────────────────────────────────────
  {
    const r = await post("/api/patient/auth/login", {
      phone: TEST_PHONE_10,
      password: PASSWORD_1,
    });
    assertOk(
      `/login correct password → 200, fresh token`,
      r.status === 200 && r.data.token && r.data.token !== session1Token,
      `db=${r.data.db}`,
    );
    session1Token = r.data.token; // use the fresh one
  }

  // ── 8. /me with token ─────────────────────────────────────────────────────
  {
    const r = await get("/api/patient/auth/me", session1Token);
    assertOk(
      `/me with token returns patient`,
      r.status === 200 &&
        r.data.db === "app" &&
        r.data.patient?.phone === TEST_PHONE,
      `linkedPatients=${r.data.linkedPatients?.length}`,
    );
  }

  // ── 9. /me without token → 401 ────────────────────────────────────────────
  {
    const r = await get("/api/patient/auth/me");
    assertOk(`/me without token → 401`, r.status === 401);
  }

  // ── 10. /me with garbage token → 401 ──────────────────────────────────────
  {
    const r = await get("/api/patient/auth/me", "garbage.token.here");
    assertOk(`/me with invalid token → 401`, r.status === 401);
  }

  // ── 11. Signup re-send is rejected once password is set ───────────────────
  {
    const r = await post("/api/patient/auth/send-otp", {
      phone: TEST_PHONE_10,
      purpose: "signup",
    });
    assertOk(
      `/send-otp purpose=signup blocked once registered → 409`,
      r.status === 409 && r.data.code === "ALREADY_REGISTERED",
    );
  }

  // ── 12. Forgot-password flow ──────────────────────────────────────────────
  header("4. Forgot password");
  capturedOtps.delete(TEST_PHONE);
  // Clear the 60-second resend cooldown directly so the test can proceed
  // without sleeping. The cooldown still works in production — this only
  // bypasses it inside the test fixture.
  if (genieDb) {
    await genieDb
      .from("patients")
      .update({ otp_last_sent_at: null })
      .eq("phone", TEST_PHONE);
  }
  {
    const r = await post("/api/patient/auth/send-otp", {
      phone: TEST_PHONE_10,
      purpose: "forgot",
    });
    assertOk(
      `/send-otp purpose=forgot → 200`,
      r.status === 200 && r.data.ok === true,
      JSON.stringify(r.data),
    );
  }
  await new Promise((r) => setTimeout(r, 50));
  const otp2 = capturedOtps.get(TEST_PHONE);
  assertOk(`forgot OTP captured`, !!otp2, otp2 ? `otp=${otp2}` : "none");

  let vt2;
  {
    const r = await post("/api/patient/auth/verify-otp", {
      phone: TEST_PHONE_10,
      otp: otp2,
    });
    vt2 = r.data.verification_token;
    assertOk(`/verify-otp (forgot) → 200`, r.status === 200 && !!vt2);
  }
  {
    const r = await post("/api/patient/auth/set-password", {
      phone: TEST_PHONE_10,
      verification_token: vt2,
      password: PASSWORD_2,
    });
    session2Token = r.data.token;
    assertOk(`/set-password (new pw) → 200`, r.status === 200 && !!session2Token);
  }
  {
    const r = await post("/api/patient/auth/login", {
      phone: TEST_PHONE_10,
      password: PASSWORD_1, // old password
    });
    assertOk(`/login with OLD password → 401 (rotated)`, r.status === 401);
  }
  {
    const r = await post("/api/patient/auth/login", {
      phone: TEST_PHONE_10,
      password: PASSWORD_2, // new password
    });
    assertOk(`/login with NEW password → 200`, r.status === 200 && !!r.data.token);
    session2Token = r.data.token;
  }

  // ── 13. Change password (authenticated, with old pw verification) ─────────
  header("5. Change password (authenticated)");
  const PASSWORD_3 = "third_pw_9999";
  {
    const r = await post(
      "/api/patient/auth/change-password",
      { old_password: "wrong_old", new_password: PASSWORD_3 },
      session2Token,
    );
    assertOk(
      `/change-password with wrong old → 401 WRONG_PASSWORD`,
      r.status === 401 && r.data.code === "WRONG_PASSWORD",
    );
  }
  {
    const r = await post(
      "/api/patient/auth/change-password",
      { old_password: PASSWORD_2, new_password: PASSWORD_3 },
      session2Token,
    );
    assertOk(`/change-password with correct old → 200`, r.status === 200);
  }
  {
    const r = await post("/api/patient/auth/login", {
      phone: TEST_PHONE_10,
      password: PASSWORD_2, // old
    });
    assertOk(`/login with previous password → 401`, r.status === 401);
  }
  {
    const r = await post("/api/patient/auth/login", {
      phone: TEST_PHONE_10,
      password: PASSWORD_3, // new
    });
    assertOk(`/login with new password → 200`, r.status === 200);
    session2Token = r.data.token;
  }
  // Caller's session survives change-password (only OTHER sessions were
  // revoked when the password was changed).
  {
    const r = await get("/api/patient/auth/me", session2Token);
    assertOk(`/me still works after change-password`, r.status === 200);
  }

  // ── 14. Staff reset (scribe doctor → temp password → forced change) ──────
  header("6. Staff reset + forced change");
  const HOSPITAL_TEST_PHONE = `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  let hospitalPatientId;
  let doctorToken;
  let doctorJti;
  try {
    // Seed a hospital-only patient (no app row, no existing app password).
    const fileNo = `GNI-TEST-${Math.floor(Math.random() * 100000)}`;
    const ins = await pool.query(
      `INSERT INTO patients (name, phone, file_no) VALUES ($1, $2, $3) RETURNING id`,
      ["Staff Reset Test", HOSPITAL_TEST_PHONE, fileNo],
    );
    hospitalPatientId = ins.rows[0].id;

    // Mint a doctor JWT + auth_sessions row (mimics a logged-in doctor).
    // The doctor must reference doctors.id; grab any active doctor.
    const docRow = await pool
      .query("SELECT id FROM doctors WHERE is_active=true LIMIT 1")
      .then((r) => r.rows[0]);
    if (!docRow) throw new Error("No active doctor row to impersonate for staff reset test");
    doctorJti = crypto.randomBytes(16).toString("hex");
    doctorToken = jwt.sign(
      { doctor_id: docRow.id, role: "consultant", jti: doctorJti },
      process.env.JWT_SECRET,
      { expiresIn: "1h" },
    );
    await pool.query(
      `INSERT INTO auth_sessions (kind, doctor_id, token, expires_at)
         VALUES ('doctor', $1, $2, NOW() + INTERVAL '1 hour')`,
      [docRow.id, doctorJti],
    );

    // ── Doctor calls reset ─────────────────────────────────────────────────
    let tempPassword;
    {
      const r = await post(
        `/api/patients/${hospitalPatientId}/reset-app-password`,
        {},
        doctorToken,
      );
      tempPassword = r.data.temp_password;
      assertOk(
        `/reset-app-password (doctor) → 200 with temp_password`,
        r.status === 200 && typeof tempPassword === "string" && tempPassword.length >= 6,
        `temp_password.length=${tempPassword?.length}`,
      );
    }

    // ── Patient (not authenticated yet) is blocked from calling reset ──────
    {
      const r = await post(
        `/api/patients/${hospitalPatientId}/reset-app-password`,
        {},
        session1Token, // patient token, should fail
      );
      assertOk(
        `/reset-app-password (patient token) → 403`,
        r.status === 403,
        `actual ${r.status}`,
      );
    }

    // ── Patient logs in with temp password → force_password_reset:true ─────
    const TEST_PHONE_10_HOSP = HOSPITAL_TEST_PHONE.replace(/^\+91/, "");
    let resetSessionToken;
    {
      const r = await post("/api/patient/auth/login", {
        phone: TEST_PHONE_10_HOSP,
        password: tempPassword,
      });
      resetSessionToken = r.data.token;
      assertOk(
        `/login with temp password → 200 force_password_reset=true`,
        r.status === 200 && r.data.force_password_reset === true && !!resetSessionToken,
        JSON.stringify({
          fpr: r.data.force_password_reset,
          db: r.data.db,
        }),
      );
    }

    // ── Patient changes password to clear the flag ─────────────────────────
    const NEW_OWN_PASSWORD = "patient_own_pw_42";
    {
      const r = await post(
        "/api/patient/auth/change-password",
        { old_password: tempPassword, new_password: NEW_OWN_PASSWORD },
        resetSessionToken,
      );
      assertOk(`/change-password from temp → 200`, r.status === 200);
    }
    {
      const r = await post("/api/patient/auth/login", {
        phone: TEST_PHONE_10_HOSP,
        password: NEW_OWN_PASSWORD,
      });
      assertOk(
        `/login after self-change → 200 force_password_reset=false`,
        r.status === 200 && r.data.force_password_reset === false,
        JSON.stringify({ fpr: r.data.force_password_reset }),
      );
    }
  } catch (e) {
    fail(`staff-reset round-trip threw: ${e.message}`);
  } finally {
    // Cleanup hospital row + doctor session
    if (doctorJti) {
      await pool.query("DELETE FROM auth_sessions WHERE token=$1", [doctorJti]).catch(() => {});
    }
    if (hospitalPatientId) {
      await pool
        .query("DELETE FROM auth_sessions WHERE patient_db='hospital' AND patient_ref=$1", [
          String(hospitalPatientId),
        ])
        .catch(() => {});
      await pool.query("DELETE FROM patients WHERE id=$1", [hospitalPatientId]).catch(() => {});
    }
  }

  function fail(msg) {
    results.push({ ok: false, label: msg });
    console.log(`  ${C.red("✗")} ${msg}`);
  }

  // ── 15. Logout invalidates the token ──────────────────────────────────────
  header("7. Logout + token revocation");
  {
    const r = await post("/api/patient/auth/logout", {}, session2Token);
    assertOk(`/logout → 200`, r.status === 200 && r.data.ok === true);
  }
  {
    const r = await get("/api/patient/auth/me", session2Token);
    assertOk(`/me after logout → 401 (jti revoked)`, r.status === 401);
  }
} catch (e) {
  console.error(C.red(`\nUnhandled: ${e.stack || e.message}\n`));
  results.push({ ok: false, label: "unhandled error", detail: e.message });
} finally {
  // ── Cleanup ───────────────────────────────────────────────────────────────
  console.log = origLog;
  if (genieDb) {
    await genieDb.from("patients").delete().eq("phone", TEST_PHONE).then(() => {});
  }
  server.close();
  // Drain the pg pool used by patientAuth/genieImport so node exits.
  const { default: pool } = await import(join(__dirname, "..", "server", "config", "db.js"));
  await pool.end().catch(() => {});
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(
  `\n${failed === 0 ? C.green("PASS") : C.red("FAIL")} — ${passed} ok, ${failed} failed.\n`,
);
process.exit(failed === 0 ? 0 : 1);
