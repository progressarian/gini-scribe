import "../loadEnv.js";
import express from "express";
import router from "../routes/ghm-appointments.js";
import pool from "../config/db.js";

const app = express();
app.use(express.json());
app.use("/api", router);
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api`;

const call = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

let failures = 0;
const check = (ok, label, detail) => {
  console.log(
    `${ok ? "PASS " : "FAIL "} ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failures++;
};

const today = new Date().toISOString().split("T")[0];
let leadId = null;
let patient = null;

try {
  const p = await pool.query(
    `SELECT p.id, p.name, p.file_no FROM patients p
      WHERE NOT COALESCE(p.is_blocked, FALSE)
        AND p.name IS NOT NULL AND length(p.name) > 4
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.file_no = p.file_no)
      ORDER BY p.id DESC LIMIT 1`,
  );
  patient = p.rows[0];
  if (!patient) throw new Error("no appointment-less patient to test with");
  console.log(`Using patient #${patient.id} ${patient.name} (${patient.file_no})`);

  const q = encodeURIComponent(patient.name);
  const before = await call("GET", `/ghm-appointments?mode=lookup&q=${q}&date=${today}`);
  const row = before.body.data?.find((r) => r.patient_id === patient.id);
  check(row?.id === -patient.id, "lookup gives the patient a negative id", row?.id);

  const notCall = await call("PATCH", `/ghm-appointments/${-patient.id}`, {
    time_slot: "10:00 AM",
  });
  check(notCall.status === 404, "a non-call field still 404s", notCall.body);

  const noLeadYet = await pool.query(
    "SELECT id FROM appointments WHERE patient_id=$1 AND appointment_date IS NULL",
    [patient.id],
  );
  check(noLeadYet.rows.length === 0, "that 404 opened no lead row");

  const patched = await call("PATCH", `/ghm-appointments/${-patient.id}`, {
    call_status: "not_picked",
    call_date: today,
    call_made_by: "SmokeAgent",
  });
  check(patched.status === 200, "call status saves against no appointment", patched.status);

  const lead = await pool.query(
    `SELECT id, status, appointment_date, call_status, call_made_by, patient_name, file_no
       FROM appointments WHERE patient_id=$1 AND appointment_date IS NULL`,
    [patient.id],
  );
  leadId = lead.rows[0]?.id ?? null;
  check(lead.rows.length === 1, "exactly one lead row exists", lead.rows[0]);
  check(lead.rows[0]?.appointment_date === null, "the lead carries no date");
  check(lead.rows[0]?.status === "lead", "the lead is marked status=lead");
  check(lead.rows[0]?.call_status === "not_picked", "the call outcome landed on it");

  const again = await call("PATCH", `/ghm-appointments/${-patient.id}`, {
    call_status: "not_interested",
  });
  const leads = await pool.query(
    "SELECT COUNT(*)::int n FROM appointments WHERE patient_id=$1 AND appointment_date IS NULL",
    [patient.id],
  );
  check(again.status === 200 && leads.rows[0].n === 1, "a second call reuses the same lead row");

  const attempt = await call("POST", "/call-attempts", {
    appointment_id: -patient.id,
    outcome: "not_interested",
    called_by: "SmokeAgent",
    notes: "smoke test",
  });
  check(attempt.status === 201, "an attempt logs against the lead", attempt.status);

  const counts = await call("POST", "/call-attempts/counts", {
    appointment_ids: [-patient.id, leadId],
  });
  check(
    counts.body[-patient.id] === 1 && counts.body[leadId] === 1,
    "the attempt badge counts by patient, from either id",
    counts.body,
  );

  const history = await call("GET", `/call-attempts?appointment_id=${-patient.id}`);
  check(history.body.length === 1, "history reads back from the negative id", history.body.length);

  const after = await call("GET", `/ghm-appointments?mode=lookup&q=${q}&date=${today}`);
  const row2 = after.body.data?.find((r) => r.patient_id === patient.id);
  check(row2?.id === leadId, "lookup now serves the lead row itself", row2?.id);

  const day = await call("GET", `/ghm-appointments?mode=by_date&date=${today}&q=${q}`);
  const leaked = (day.body.data || []).some((r) => r.id === leadId);
  check(!leaked, "the lead never appears on a day list", day.body.total);

  const claim = await call("POST", `/ghm-appointments/${-patient.id}/calling`);
  check(
    claim.status === 401 || claim.status === 200,
    "calling flag resolves the lead",
    claim.status,
  );
} catch (e) {
  failures++;
  console.error("ERROR", e.message);
} finally {
  if (leadId) {
    await pool.query("DELETE FROM call_attempts WHERE appointment_id=$1", [leadId]);
    await pool.query("DELETE FROM appointments WHERE id=$1 AND appointment_date IS NULL", [leadId]);
    console.log(`Cleaned up lead #${leadId}`);
  }
  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} FAILED` : "\nOK");
  process.exit(failures ? 1 : 0);
}
