import express from "express";
import router from "../routes/ghm-appointments.js";

const app = express();
app.use("/api", router);
const srv = app.listen(0);
const port = srv.address().port;

const q = (visit_type) =>
  new URLSearchParams({
    patient_name: "Test Patient",
    doctor_name: "Dr Beant Kaur",
    appointment_date: "2026-08-25",
    time_slot: process.env.SLOT || "11 AM to 11:30 AM",
    ...(visit_type ? { visit_type } : {}),
  }).toString();

for (const vt of ["New", "FU within week", "FU within 3 days", " fu within 3 DAYS "]) {
  const r = await fetch(`http://127.0.0.1:${port}/api/ghm-appointments/whatsapp-preview?${q(vt)}`);
  const j = await r.json();
  console.log("=====", JSON.stringify(vt), r.status);
  console.log(j.whatsapp_message.split("\n").slice(4, 9).join("\n"));
  console.log("additional:", j.additional_whatsapp_msg ? "yes" : "null");
}
srv.close();
