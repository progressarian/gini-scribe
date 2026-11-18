import "../loadEnv.js";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";

const BASE = process.env.PROBE_BASE_URL || "https://scribe.ginihealth.com";
const DEV_PATIENT_ID = 16911;

const {
  rows: [patient],
} = await pool.query(`SELECT id, phone, name FROM patients WHERE id = $1`, [DEV_PATIENT_ID]);
const jti = crypto.randomBytes(16).toString("hex");
const token = jwt.sign(
  {
    kind: "patient",
    db: "hospital",
    patient_id: patient.id,
    phone: patient.phone,
    name: patient.name,
    jti,
  },
  process.env.JWT_SECRET,
  { expiresIn: "5m" },
);
await pool.query(
  `INSERT INTO auth_sessions (kind, patient_db, patient_ref, token, expires_at)
   VALUES ('patient', 'hospital', $1, $2, NOW() + interval '5 minutes')`,
  [String(patient.id), jti],
);

const call = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return {
      status: res.status,
      body: null,
      type: res.headers.get("content-type"),
      text: text.slice(0, 80),
    };
  }
};

try {
  for (const q of ["", "P_180815"]) {
    const { status, body, type, text } = await call(
      `/api/patient/app/dev/patients?limit=30&q=${encodeURIComponent(q)}`,
    );
    const summary = !body
      ? `non-JSON ${type} ${text}`
      : Array.isArray(body.rows)
        ? `rows ${body.rows.length} total ${body.total} hasP_180815 ${body.rows.some((r) => r.file_no === "P_180815")}`
        : `body ${JSON.stringify(body).slice(0, 200)}`;
    console.log(`search ${JSON.stringify(q)} -> ${status} ${summary}`);
  }
  const db = await call("/api/patient/app/gini-db-token");
  console.log(
    `gini-db-token -> ${db.status} enabled ${db.body?.enabled} ids ${db.body?.patient_ids?.length ?? 0}`,
  );
} finally {
  await pool.query(`DELETE FROM auth_sessions WHERE token = $1`, [jti]);
  console.log("test session removed");
  await pool.end();
}
