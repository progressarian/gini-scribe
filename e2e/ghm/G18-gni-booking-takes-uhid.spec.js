import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { upsertPatient } = await import("../../server/services/healthray/db.js");
const { isLatestFollowUpVisit } = await import("../../server/services/ghmDayWindow.js");

const tag = crypto.randomBytes(3).toString("hex");
const made = [];

const phoneFor = (n) => `98${tag.replace(/\D/g, "7").padEnd(6, "7").slice(0, 6)}${n}${n}`;

async function gniPatient(n, name) {
  const fileNo = `GNI-9${tag.replace(/\D/g, "1").padEnd(4, "1").slice(0, 4)}${n}`;
  const phone = phoneFor(n);
  const { id } = await one(
    `INSERT INTO patients (name, phone, file_no, sex) VALUES ($1, $2, $3, 'Female') RETURNING id`,
    [name, phone, fileNo],
  );
  made.push(id);
  return { id, fileNo, phone, name };
}

async function booking(patient, fileNo, day, extra = {}) {
  const row = {
    visit_type: "New",
    status: "scheduled",
    booking_status: "booked",
    own_follow_up_date: null,
    ...extra,
  };
  const { id } = await one(
    `INSERT INTO appointments (patient_id, patient_name, file_no, phone, appointment_date,
                               visit_type, status, booking_status, own_follow_up_date, doctor_name)
     VALUES ($1, $2, $3, $4, CURRENT_DATE + $5::int, $6, $7, $8, $9, 'Dr. G18')
     RETURNING id`,
    [
      patient.id,
      patient.name,
      fileNo,
      patient.phone,
      day,
      row.visit_type,
      row.status,
      row.booking_status,
      row.own_follow_up_date,
    ],
  );
  return id;
}

const fileNoOf = async (appointmentId) =>
  (await one(`SELECT file_no FROM appointments WHERE id = $1`, [appointmentId])).file_no;

test.describe
  .serial("G18 bookings take the patient's UHID when a GNI patient is registered", () => {
  test.afterAll(async () => {
    if (!made.length) return;
    await query(
      `DELETE FROM appointment_change_log WHERE appointment_id IN (SELECT id FROM appointments WHERE patient_id = ANY($1))`,
      [made],
    );
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1)`, [made]);
    await query(`DELETE FROM patients WHERE id = ANY($1)`, [made]);
  });

  test("1. registering the patient moves every GNI booking to the UHID, with history", async () => {
    const p = await gniPatient(1, `Sunita G18 ${tag}`);
    const past = await booking(p, p.fileNo, -20, { status: "no_show" });
    const future = await booking(p, p.fileNo, 1);
    const uhid = `P_G18${tag}1`;
    const id = await upsertPatient({
      name: p.name,
      phone: p.phone,
      fileNo: uhid,
      sex: "Female",
      healthId: `hid-g18-${tag}-1`,
    });
    expect(id).toBe(p.id);
    expect((await one(`SELECT file_no FROM patients WHERE id = $1`, [p.id])).file_no).toBe(uhid);
    expect(await fileNoOf(past)).toBe(uhid);
    expect(await fileNoOf(future)).toBe(uhid);
    const log = await query(
      `SELECT appointment_id, field_label, old_value, new_value, changed_by
         FROM appointment_change_log WHERE appointment_id = ANY($1) AND field = 'file_no'
        ORDER BY appointment_id`,
      [[past, future]],
    );
    expect(log.rows).toEqual([
      {
        appointment_id: past,
        field_label: "UHID",
        old_value: p.fileNo,
        new_value: uhid,
        changed_by: "HealthRay sync",
      },
      {
        appointment_id: future,
        field_label: "UHID",
        old_value: p.fileNo,
        new_value: uhid,
        changed_by: "HealthRay sync",
      },
    ]);
  });

  test("2. a later sync of the same patient changes nothing more", async () => {
    const p = await gniPatient(2, `Repeat G18 ${tag}`);
    const future = await booking(p, p.fileNo, 2);
    const uhid = `P_G18${tag}2`;
    const args = {
      name: p.name,
      phone: p.phone,
      fileNo: uhid,
      sex: "Female",
      healthId: `hid-g18-${tag}-2`,
    };
    await upsertPatient(args);
    await upsertPatient(args);
    const log = await query(
      `SELECT count(*)::int AS n FROM appointment_change_log WHERE appointment_id = $1 AND field = 'file_no'`,
      [future],
    );
    expect(log.rows[0].n).toBe(1);
    expect(await fileNoOf(future)).toBe(uhid);
  });

  test("3. a booking left stale before this fix heals on the next sync", async () => {
    const p = await gniPatient(3, `Stale G18 ${tag}`);
    const uhid = `P_G18${tag}3`;
    await query(`UPDATE patients SET file_no = $2, health_id = $3 WHERE id = $1`, [
      p.id,
      uhid,
      `hid-g18-${tag}-3`,
    ]);
    const stale = await booking(p, p.fileNo, 3);
    await upsertPatient({
      name: p.name,
      phone: p.phone,
      fileNo: uhid,
      sex: "Female",
      healthId: `hid-g18-${tag}-3`,
    });
    expect(await fileNoOf(stale)).toBe(uhid);
  });

  test("4. a different person on the same phone is not adopted, and keeps their bookings", async () => {
    const p = await gniPatient(4, `Asha G18 ${tag}`);
    const future = await booking(p, p.fileNo, 4);
    const otherId = await upsertPatient({
      name: `Ravinder Kumar ${tag}`,
      phone: p.phone,
      fileNo: `P_G18${tag}4`,
      sex: "Male",
      healthId: `hid-g18-${tag}-4`,
    });
    made.push(otherId);
    expect(otherId).not.toBe(p.id);
    expect(await fileNoOf(future)).toBe(p.fileNo);
  });

  test("5. GHM now links the old booking to the visit under the UHID", async () => {
    const p = await gniPatient(5, `Linked G18 ${tag}`);
    const followUp = await booking(p, p.fileNo, -10, {
      visit_type: "Follow-Up",
      status: "completed",
      own_follow_up_date: new Date().toISOString().slice(0, 10),
    });
    const uhid = `P_G18${tag}5`;
    await upsertPatient({
      name: p.name,
      phone: p.phone,
      fileNo: uhid,
      sex: "Female",
      healthId: `hid-g18-${tag}-5`,
    });
    await booking(p, uhid, -2, { visit_type: "Follow-Up", status: "completed" });
    const { rows } = await query(
      `SELECT ${isLatestFollowUpVisit("a")} AS latest FROM appointments a WHERE a.id = $1`,
      [followUp],
    );
    expect(rows[0].latest).toBe(false);
  });
});
