import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { CONSULTANTS, USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const desk = await import("../../server/services/giniflow/referralsStation.js");
const collect = await import("../../server/services/careFollowups/collect.js");

const db = getPool();
const tag = newTag();
let ids;
const patients = [];
const actor = { actorId: USERS.care_coordinator.id };

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function deskReferral(label, specialty = "nephrology", extra = {}) {
  const made = await extraVisit(ids, label, { healthray: false });
  patients.push(made.patient);
  const referral = await desk.createReferral(
    made.visit,
    { specialty, reason: "Please review", actorId: USERS.admin.id, ...extra },
    db,
  );
  return { ...made, referral, name: `P4 ${label} ${tag}` };
}

const itemOf = (referralId) =>
  one(`SELECT * FROM care_followups WHERE source_key = $1`, [`gf:${referralId}`]);

const deskRow = (referralId) =>
  one(
    `SELECT status, appointment_date::text AS day, appointment_note FROM giniflow_referrals WHERE id = $1`,
    [referralId],
  );

const lastDeskEvent = (itemId) =>
  one(
    `SELECT kind, from_status, to_status, note, actor_id FROM care_followup_events
      WHERE followup_id = $1 ORDER BY at DESC, id DESC LIMIT 1`,
    [itemId],
  );

async function ghmBooking(patient, name, day) {
  return (
    await one(
      `INSERT INTO appointments (patient_id, patient_name, appointment_date, doctor_name, status)
       VALUES ($1, $2, $3::date, $4, 'scheduled') RETURNING id`,
      [patient, name, day, CONSULTANTS.banshali.name],
    )
  ).id;
}

test.describe.serial("CF03 the Referrals desk and Care Follow-ups share one referral", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await query(
      `INSERT INTO app_kv (key, value, updated_at) VALUES ('care_followups_since', to_jsonb($1::text), NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [ids.day],
    );
  });

  test.afterAll(async () => {
    await query(`DELETE FROM care_followups WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM giniflow_referrals WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1)`, [patients]).catch(() => {});
    await query(`DELETE FROM app_kv WHERE key = 'care_followups_since'`);
    await tearDown(ids);
  });

  test("1. a desk referral is on Follow-ups at once, without a collector run", async () => {
    const a = await deskReferral("LnkNew");
    const item = await itemOf(a.referral.id);
    expect(item).toMatchObject({ source: "gf_referral", status: "open", patient_id: a.patient });
    expect(item.target).toContain("nephrology");
  });

  test("2. editing the referral on the desk refreshes the item; GHM booking stays offered", async () => {
    const a = await deskReferral("LnkEdit", "endocrinology");
    const before = await itemOf(a.referral.id);
    await desk.createReferral(
      a.visit,
      { specialty: "endocrinology", hospital: "Fortis Mohali", toDoctor: "Dr Outside" },
      db,
    );
    const after = await itemOf(a.referral.id);
    expect(after.id).toBe(before.id);
    expect(after.detail).toContain("At Fortis Mohali");
    expect(after.target).toContain("Dr Outside");
    expect(after.status).toBe("open");
    const api = await apiAs("care_coordinator");
    const list = await (await api.get("/api/care-followups", { params: { q: a.name } })).json();
    const row = list.rows.find((r) => r.id === after.id);
    expect(row.desk).toMatchObject({ hospital: "Fortis Mohali", statusLabel: "Created" });
    await api.dispose();
  });

  test("3. an outside appointment on the desk makes the item 'Booked outside'", async () => {
    const a = await deskReferral("LnkOut");
    const day = addDays(ids.day, 9);
    await desk.bookAppointment(a.referral.id, { date: day, note: "OPD block B", ...actor }, db);
    const item = await itemOf(a.referral.id);
    expect(item.status).toBe("booked_outside");
    expect(await lastDeskEvent(item.id)).toMatchObject({
      kind: "desk",
      from_status: "open",
      to_status: "booked_outside",
      note: `Outside appointment ${day} — OPD block B`,
      actor_id: USERS.care_coordinator.id,
    });
    await collect.collectFollowups({ db });
    expect((await itemOf(a.referral.id)).status).toBe("booked_outside");
  });

  test("4. the specialist's reply or Mark seen on the desk makes the item done", async () => {
    const a = await deskReferral("LnkReply");
    await desk.bookAppointment(a.referral.id, { date: addDays(ids.day, 3) }, db);
    await desk.recordResponse(a.referral.id, { note: "Seen, continue", complete: true }, db);
    expect((await itemOf(a.referral.id)).status).toBe("done");

    const b = await deskReferral("LnkSeen");
    await desk.completeReferral(b.referral.id, db);
    const item = await itemOf(b.referral.id);
    expect(item.status).toBe("done");
    expect((await lastDeskEvent(item.id)).note).toBe("Marked seen on the Referrals desk");
  });

  test("5. booking at GHM from Follow-ups sets the desk to Appointment pending; an outside slot is kept", async () => {
    const a = await deskReferral("LnkGhm");
    const day = addDays(ids.day, 4);
    const appt = await ghmBooking(a.patient, a.name, day);
    const item = await itemOf(a.referral.id);
    const api = await apiAs("care_coordinator");
    expect(
      (
        await api.post(`/api/care-followups/${item.id}/booked`, { data: { appointment_id: appt } })
      ).status(),
    ).toBe(200);
    const row = await deskRow(a.referral.id);
    expect(row).toMatchObject({ status: "appointment_booked", day });
    expect(row.appointment_note).toContain(`Booked at GHM with ${CONSULTANTS.banshali.name}`);

    const b = await deskReferral("LnkKeep");
    const outside = addDays(ids.day, 12);
    await desk.bookAppointment(b.referral.id, { date: outside, note: "Fortis" }, db);
    const bItem = await itemOf(b.referral.id);
    const bAppt = await ghmBooking(b.patient, b.name, day);
    await api.post(`/api/care-followups/${bItem.id}/booked`, { data: { appointment_id: bAppt } });
    expect((await itemOf(b.referral.id)).status).toBe("booked");
    expect(await deskRow(b.referral.id)).toMatchObject({
      status: "appointment_booked",
      day: outside,
      appointment_note: "Fortis",
    });
    await api.dispose();
  });

  test("6. declined on Follow-ups leaves the desk status and shows on the desk card", async () => {
    const a = await deskReferral("LnkDecl");
    const item = await itemOf(a.referral.id);
    const api = await apiAs("care_coordinator");
    await api.post(`/api/care-followups/${item.id}/call`, { data: { call_status: "not_picked" } });
    await api.post(`/api/care-followups/${item.id}/outcome`, {
      data: { status: "declined", reason: "Will go later" },
    });
    expect((await deskRow(a.referral.id)).status).toBe("created");
    const board = await (
      await api.get("/api/giniflow/referrals", { params: { date: ids.day, q: a.name } })
    ).json();
    const card = board.today.find((r) => r.id === a.referral.id);
    expect(card.followup).toMatchObject({
      id: item.id,
      status: "declined",
      statusLabel: "Patient declined",
      attempts: 1,
      lastCall: "not_picked",
      reason: "Will go later",
    });
    await api.dispose();
  });

  test("7. the two screens link to each other", async ({ page }) => {
    const a = await deskReferral("LnkUi");
    const item = await itemOf(a.referral.id);
    await loginAs(page, "care_coordinator");
    await gotoReady(page, `/care-followups?item=${item.id}`, () =>
      page.getByRole("dialog", { name: a.name }),
    );
    const drawer = page.getByRole("dialog", { name: a.name });
    const deskCard = drawer.getByRole("region", { name: "Referrals desk" });
    await expect(deskCard).toContainText("Created");
    await expect(deskCard).toContainText("Not generated yet");
    await expect(deskCard.getByRole("link", { name: "📄 Open letter" })).toHaveAttribute(
      "href",
      new RegExp(`/giniflow/referrals/${a.referral.id}/letter.pdf`),
    );
    await deskCard.getByRole("link", { name: "↗ Open on Referrals desk" }).click();
    await expect(page).toHaveURL(/\/giniflow\/station\/referrals\?q=/);
    await expect(page.getByLabel("Search referrals")).toHaveValue(`F4LnkUi-${tag}`);
    const card = page.locator(".ref-card").filter({ hasText: a.name });
    await expect(card.getByText("🧭 Care coordinator:")).toBeVisible({ timeout: 20000 });
    await card.getByRole("link", { name: "Open follow-up history" }).click();
    await expect(page).toHaveURL(new RegExp(`/care-followups\\?item=${item.id}`));
    await expect(page.getByRole("dialog", { name: a.name })).toBeVisible({ timeout: 20000 });
  });

  test("8. removing the referral closes the item at once; a later collector run adds nothing", async () => {
    const a = await deskReferral("LnkGone");
    const item = await itemOf(a.referral.id);
    await desk.removeReferral(a.referral.id, db, actor);
    const after = await one(`SELECT status, outcome_reason FROM care_followups WHERE id = $1`, [
      item.id,
    ]);
    expect(after).toMatchObject({
      status: "closed",
      outcome_reason: "Referral removed on the Referrals desk",
    });
    await collect.collectFollowups({ db });
    const { n } = await one(`SELECT COUNT(*)::int AS n FROM care_followups WHERE patient_id = $1`, [
      a.patient,
    ]);
    expect(n).toBe(1);
  });

  test("9. before the list has a start date, desk actions still work and create no item", async () => {
    await query(`DELETE FROM app_kv WHERE key = 'care_followups_since'`);
    try {
      const a = await deskReferral("LnkOff");
      await desk.bookAppointment(a.referral.id, { date: addDays(ids.day, 2) }, db);
      expect((await deskRow(a.referral.id)).status).toBe("appointment_booked");
      const { n } = await one(
        `SELECT COUNT(*)::int AS n FROM care_followups WHERE patient_id = $1`,
        [a.patient],
      );
      expect(n).toBe(0);
    } finally {
      await query(
        `INSERT INTO app_kv (key, value, updated_at) VALUES ('care_followups_since', to_jsonb($1::text), NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [ids.day],
      );
    }
  });
});
