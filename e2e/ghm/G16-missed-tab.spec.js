import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

const IST = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

async function visit(patient, { daysAgo, status, doctor = "Dr E2E Banshali", ...extra }) {
  const cols = {
    patient_id: patient.id,
    file_no: patient.file_no,
    patient_name: patient.name,
    phone: patient.phone,
    doctor_name: doctor,
    time_slot: "10:00",
    status,
    visit_type: "Follow-Up",
    ...extra,
  };
  const keys = Object.keys(cols);
  const { id } = await one(
    `INSERT INTO appointments (${keys.join(", ")}, appointment_date, created_at)
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, ${IST} - ${daysAgo},
             ((${IST} - ${daysAgo + 2})::timestamp AT TIME ZONE 'Asia/Kolkata'))
     RETURNING id`,
    Object.values(cols),
  );
  return id;
}

test.describe("GHM: Missed tab", () => {
  const patients = [];
  let api;

  const fresh = async () => {
    const p = await buildPatient();
    patients.push(p);
    return p;
  };

  const missed = async (extra = "") => {
    const res = await api.get(
      `/api/ghm-appointments?mode=missed&limit=100&page=1&calls=all&from=${await day(-30)}&to=${await day(0)}${extra}`,
    );
    expect(res.status()).toBe(200);
    return (await res.json()).data;
  };

  const day = async (offset) => (await one(`SELECT (${IST} + $1::int)::text AS d`, [offset])).d;

  const row = (rows, p) => rows.find((r) => r.file_no === p.file_no);

  test.beforeAll(async () => {
    api = await apiAs("admin");
  });

  test.afterAll(async () => {
    const ids = patients.map((p) => p.id);
    await query(`DELETE FROM giniflow_visits WHERE patient_id = ANY($1::int[])`, [ids]);
    await query(
      `DELETE FROM appointment_change_log WHERE appointment_id IN
         (SELECT id FROM appointments WHERE patient_id = ANY($1::int[]))`,
      [ids],
    );
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [ids]);
    await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
  });

  test("1. a follow-up due yesterday that nobody kept is listed as a missed follow-up", async () => {
    const p = await fresh();
    await visit(p, { daysAgo: 30, status: "completed", follow_up_date: await day(-1) });
    const r = row(await missed(), p);
    expect(r?.missed_kind).toBe("follow_up");
    expect(r?.missed_date).toBe(await day(-1));
  });

  test("2. a patient who came in since is not missed, even if early", async () => {
    const p = await fresh();
    await visit(p, { daysAgo: 30, status: "completed", follow_up_date: await day(-1) });
    await visit(p, { daysAgo: 5, status: "completed" });
    expect(row(await missed(), p)).toBeUndefined();
  });

  test("3. a patient already rebooked with a time slot is not listed", async () => {
    const p = await fresh();
    await visit(p, { daysAgo: 3, status: "no_show" });
    await visit(p, { daysAgo: -4, status: "scheduled", time_slot: "11 AM to 11:30 AM" });
    expect(row(await missed(), p)).toBeUndefined();
  });

  test("3b. a new preferred date and time set on the no-show row itself counts as rebooked", async () => {
    const p = await fresh();
    await visit(p, {
      daysAgo: 3,
      status: "no_show",
      booking_status: "booked",
      preferred_date: await day(2),
      preferred_time_slot: "5 PM to 6 PM",
    });
    expect(row(await missed(), p)).toBeUndefined();
  });

  test("3c. a new preferred date without a time also takes the patient off Missed", async () => {
    const p = await fresh();
    await visit(p, { daysAgo: 30, status: "completed", follow_up_date: await day(-2) });
    await visit(p, { daysAgo: 1, status: "scheduled", preferred_date: await day(5) });
    expect(row(await missed(), p)).toBeUndefined();
  });

  test("3d. a missed in-between visit waits while the doctor's follow-up is still ahead", async () => {
    const p = await fresh();
    await visit(p, { daysAgo: 14, status: "completed", follow_up_date: await day(20) });
    await visit(p, { daysAgo: 12, status: "no_show" });
    expect(row(await missed(), p)).toBeUndefined();
  });

  test("3e. a follow-up dated on or before its own visit is not a missed follow-up", async () => {
    const p = await fresh();
    await visit(p, { daysAgo: 3, status: "completed", follow_up_date: await day(-3) });
    expect(row(await missed(), p)).toBeUndefined();
  });

  test("3f. a visit under the patient's other file number counts as coming in", async () => {
    const p = await fresh();
    await visit(p, { daysAgo: 3, status: "no_show", file_no: `GNI-${p.file_no}` });
    await visit(p, { daysAgo: 2, status: "completed" });
    expect((await missed()).find((r) => r.file_no === `GNI-${p.file_no}`)).toBeUndefined();
  });

  test("3g. the same person seen under a duplicate chart counts as coming in", async () => {
    const p = await fresh();
    const twin = await buildPatient({ name: `Mrs. ${p.name}`, phone: p.phone });
    patients.push(twin);
    await visit(p, { daysAgo: 3, status: "no_show" });
    await visit(twin, { daysAgo: 2, status: "completed" });
    expect(row(await missed(), p)).toBeUndefined();
  });

  test("3h. a family member sharing the phone does not hide the patient", async () => {
    const p = await fresh();
    const relative = await buildPatient({ name: `Relative ${p.name}`, phone: p.phone });
    patients.push(relative);
    await visit(p, { daysAgo: 3, status: "no_show" });
    await visit(relative, { daysAgo: 2, status: "completed" });
    expect(row(await missed(), p)).toBeDefined();
  });

  test("3i. a patient checked in on the floor counts as coming in, even if the day closed as no-show", async () => {
    const p = await fresh();
    const apptId = await visit(p, { daysAgo: 3, status: "no_show" });
    const { id } = await one(
      `INSERT INTO giniflow_visits (patient_id, appointment_id, visit_date, current_status)
       VALUES ($1, $2, ${IST} - 3, 'no_show') RETURNING id`,
      [p.id, apptId],
    );
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role) VALUES ($1, 'checked_in', 'reception')`,
      [id],
    );
    expect(row(await missed(), p)).toBeUndefined();
  });

  test("3j. the same file number in lower case is listed once", async () => {
    const p = await fresh();
    const twin = await buildPatient({
      name: p.name,
      phone: p.phone,
      file_no: p.file_no.toLowerCase(),
      health_id: `HID-${p.file_no.toLowerCase()}-twin`,
    });
    patients.push(twin);
    await visit(p, { daysAgo: 30, status: "completed", follow_up_date: await day(-2) });
    await visit(twin, { daysAgo: 4, status: "no_show", patient_name: "Other Name" });
    const rows = (await missed()).filter(
      (r) => r.file_no.toUpperCase() === p.file_no.toUpperCase(),
    );
    expect(rows).toHaveLength(1);
  });

  test("3k. a GNI lead who came under a P_ chart on the same phone counts as coming in", async () => {
    const lead = await fresh();
    const chart = await buildPatient({ name: `Mr. Other ${lead.name}`, phone: lead.phone });
    patients.push(chart);
    await visit(lead, { daysAgo: 3, status: "no_show", file_no: `GNI-${lead.file_no}` });
    await visit(chart, { daysAgo: 3, status: "completed" });
    expect((await missed()).find((r) => r.file_no === `GNI-${lead.file_no}`)).toBeUndefined();
  });

  test("4. a cancelled appointment is listed so the team can rebook it", async () => {
    const p = await fresh();
    await visit(p, { daysAgo: 2, status: "cancelled" });
    expect(row(await missed(), p)?.missed_kind).toBe("appointment");
  });

  test("5. Not Interested removes the patient; Wrong Number only without an alternate phone", async () => {
    const notInterested = await fresh();
    await visit(notInterested, {
      daysAgo: 2,
      status: "no_show",
      call_status: "not_interested",
      call_date: await day(0),
    });
    const wrongNoAlt = await fresh();
    await visit(wrongNoAlt, {
      daysAgo: 2,
      status: "no_show",
      call_status: "wrong_number",
      call_date: await day(0),
    });
    const wrongWithAlt = await fresh();
    await visit(wrongWithAlt, {
      daysAgo: 2,
      status: "no_show",
      call_status: "wrong_number",
      call_date: await day(0),
      alt_phone: ["9812345678"],
    });
    const rows = await missed();
    expect(row(rows, notInterested)).toBeUndefined();
    expect(row(rows, wrongNoAlt)).toBeUndefined();
    expect(row(rows, wrongWithAlt)).toBeDefined();
  });

  test("6. tests-only bookings and call-sheet rows are not missed visits", async () => {
    const lab = await fresh();
    await visit(lab, { daysAgo: 2, status: "no_show", doctor: "Dr. Hospital Admin" });
    const sheet = await fresh();
    await visit(sheet, { daysAgo: 2, status: "no_show", time_slot: "09. 4-4:30PM" });
    const rows = await missed();
    expect(row(rows, lab)).toBeUndefined();
    expect(row(rows, sheet)).toBeUndefined();
  });

  test("7. today's patients wait until the day is over", async () => {
    const p = await fresh();
    await visit(p, { daysAgo: 0, status: "scheduled" });
    expect(row(await missed(), p)).toBeUndefined();
  });

  test("8. history counts misses a week apart and labels the patient", async () => {
    const p = await fresh();
    for (const daysAgo of [2, 12, 22, 32, 42]) await visit(p, { daysAgo, status: "no_show" });
    await visit(p, { daysAgo: 52, status: "cancelled" });
    await visit(p, { daysAgo: 70, status: "completed" });
    await visit(p, { daysAgo: 90, status: "completed" });
    const r = row(await missed(), p);
    expect(r?.visit_count).toBe(2);
    expect(r?.missed_count).toBe(5);
    expect(r?.cancelled_count).toBe(1);
    expect(r?.miss_risk).toBe("repeatedly");
    const often = row(await missed("&risk=often"), p);
    expect(often).toBeDefined();
  });

  test("8b. the miss a patient is listed for always counts, even right after a visit", async () => {
    const p = await fresh();
    await visit(p, {
      daysAgo: 4,
      status: "completed",
      preferred_date: await day(-2),
      preferred_time_slot: "5 PM to 6 PM",
    });
    const r = row(await missed(), p);
    expect(r?.missed_kind).toBe("preferred");
    expect(r?.missed_count).toBe(1);
    expect(r?.visit_count).toBe(1);
  });

  test("9. misses within a week of each other count once", async () => {
    const p = await fresh();
    for (const daysAgo of [2, 4, 6]) await visit(p, { daysAgo, status: "no_show" });
    const r = row(await missed(), p);
    expect(r?.missed_count).toBe(1);
    expect(r?.miss_risk).toBeNull();
  });

  test("10. the Missed tab shows the range bar, the history column and the label", async ({
    page,
  }) => {
    const p = await fresh();
    for (const daysAgo of [12, 22, 32, 42]) await visit(p, { daysAgo, status: "no_show" });
    await visit(p, { daysAgo: 2, status: "no_show", booking_status: "booked" });
    await loginAs(page, "admin");
    await gotoReady(page, "/ghm?tab=missed", () =>
      page.getByRole("group", { name: "Missed date range" }),
    );
    await expect(page.getByRole("button", { name: "Last 7 days" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByPlaceholder(/Search missed patients/).fill(p.file_no);
    const patientRow = page.locator("tr", { hasText: p.name });
    await expect(patientRow).toContainText("Repeatedly misses");
    await expect(patientRow).toContainText("Visits done 0");
    await expect(patientRow).toContainText("Missed 5");
    await expect(patientRow).not.toContainText("Booked");
    await expect(
      page.getByRole("columnheader", { name: "Missed history & next step" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Yesterday" }).click();
    await expect(page.getByRole("button", { name: "Yesterday" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
