// Firebase Cloud Messaging wrapper — fans out a notification to every
// registered device for a patient. Stays a no-op until FIREBASE_SERVICE_ACCOUNT
// is set (JSON service account creds), so the rest of the app can call it
// freely. Tokens that come back as unregistered are pruned from the table.

import pool from "../config/db.js";

let firebaseAdmin = null;
let initAttempted = false;

async function getAdmin() {
  if (initAttempted) return firebaseAdmin;
  initAttempted = true;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.log("[pushNotifier] FIREBASE_SERVICE_ACCOUNT not set — push disabled");
    return null;
  }
  try {
    const mod = await import("firebase-admin");
    const admin = mod.default || mod;
    if (!admin.apps?.length) {
      const creds = JSON.parse(raw);
      admin.initializeApp({ credential: admin.credential.cert(creds) });
    }
    firebaseAdmin = admin;
    return admin;
  } catch (e) {
    console.warn("[pushNotifier] init failed:", e.message);
    return null;
  }
}

async function fetchTokens(patientId) {
  const { rows } = await pool.query(
    `SELECT fcm_token FROM patient_push_tokens WHERE patient_id = $1`,
    [patientId],
  );
  return rows.map((r) => r.fcm_token);
}

async function pruneToken(token) {
  await pool.query(`DELETE FROM patient_push_tokens WHERE fcm_token = $1`, [token]);
}

export async function sendToPatient(patientId, { title, body, data = {} }) {
  if (!patientId) return { sent: 0, skipped: true };
  const admin = await getAdmin();
  const tokens = await fetchTokens(patientId);
  if (!admin || tokens.length === 0) {
    return { sent: 0, skipped: true, reason: !admin ? "no-creds" : "no-tokens" };
  }
  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, v == null ? "" : String(v)]),
  );
  const messaging = admin.messaging();
  let sent = 0;
  await Promise.all(
    tokens.map(async (token) => {
      try {
        await messaging.send({
          token,
          notification: { title, body },
          data: stringData,
        });
        sent += 1;
      } catch (e) {
        const code = e?.errorInfo?.code || e?.code || "";
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-argument")
        ) {
          await pruneToken(token).catch(() => {});
        } else {
          console.warn("[pushNotifier] send failed:", code || e.message);
        }
      }
    }),
  );
  return { sent };
}

export async function sendDoseDecisionNotification(patientId, payload) {
  const { kind, medicationName, finalDose, doctorNote, rejectReason, requestId } = payload || {};
  if (!kind) return { sent: 0, skipped: true };
  const title =
    kind === "approved"
      ? "Dose change approved"
      : kind === "rejected"
        ? "Dose change rejected"
        : "Dose change updated";
  const med = medicationName || "your medication";
  const body =
    kind === "approved"
      ? `${med} dose is now ${finalDose}.${doctorNote ? ` ${doctorNote}` : ""}`
      : kind === "rejected"
        ? `${med}: ${rejectReason || "Doctor declined the change."}`
        : `Update on ${med}.`;
  return sendToPatient(patientId, {
    title,
    body,
    data: { kind: "dose_change", status: kind, requestId, medicationName: med },
  });
}
