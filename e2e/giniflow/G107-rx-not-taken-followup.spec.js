import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
const onlineType = `g107-online-${tag}`;
let ids;
let since;
const made = {};

const dayBefore = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

async function visitFor(
  label,
  { status, explained = false, date = ids.day, phone = null, visitType = "New Patient" },
) {
  const v = await extraVisit(ids, label, { healthray: false, visitType });
  await query(`UPDATE patients SET phone = $2 WHERE id = $1`, [v.patient, phone]);
  await query(
    `UPDATE giniflow_visits SET current_status = $2, visit_date = $3::date WHERE id = $1`,
    [v.visit, status, date],
  );
  await query(
    `INSERT INTO consultations (patient_id, visit_date, status) VALUES ($1, $2::date, 'completed')`,
    [v.patient, date],
  );
  if (explained) {
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, meta)
       VALUES ($1, 'pharmacy_pending', 'nurse', '{"source":"rx_station","explained":true}'::jsonb)`,
      [v.visit],
    );
  }
  return v;
}

async function queue() {
  const api = await apiAs("admin");
  try {
    const res = await api.get("/api/giniflow/stations/rx/queue");
    expect(res.status()).toBe(200);
    return await res.json();
  } finally {
    await api.dispose();
  }
}

async function followup(role, visit, body) {
  const api = await apiAs(role);
  try {
    const res = await api.post(`/api/giniflow/stations/rx/${visit}/followup`, { data: body });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
  } finally {
    await api.dispose();
  }
}

const listed = (q, v) => q.notTaken.find((r) => r.visitId === v.visit);

test.describe.serial("G107 prescriptions not given stay at the Rx desk until done", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    const { rows } = await query(`SELECT value FROM app_kv WHERE key = 'rx_followups_since'`);
    since = rows[0]?.value ?? null;
    await query(
      `INSERT INTO app_kv (key, value) VALUES ('rx_followups_since', to_jsonb($1::text))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [dayBefore(dayBefore(ids.day))],
    );
    await query(
      `INSERT INTO flow_visit_types (id, label, max_time_min, for_online) VALUES ($1, 'G107 online', 30, TRUE)`,
      [onlineType],
    );
    made.left = await visitFor("RxLeft", { status: "exited", phone: "9876500107" });
    made.explained = await visitFor("RxDone", { status: "exited", explained: true });
    made.forgot = await visitFor("RxForgot", { status: "exited", explained: true });
    made.yesterday = await visitFor("RxYday", { status: "exited", date: dayBefore(ids.day) });
    made.resolved = await visitFor("RxSent", { status: "exited", date: dayBefore(ids.day) });
    made.old = await visitFor("RxOld", {
      status: "exited",
      date: dayBefore(dayBefore(dayBefore(ids.day))),
    });
    made.online = await visitFor("RxOnline", { status: "exited" });
    await query(`UPDATE giniflow_visits SET visit_type_id = $2 WHERE id = $1`, [
      made.online.visit,
      onlineType,
    ]);
    made.waiting = await visitFor("RxWait", { status: "rx_pending" });
    made.tele = await visitFor("RxTele", { status: "exited", visitType: "Tele Consultation" });
    await query(
      `INSERT INTO giniflow_rx_followups (visit_id, action, remark) VALUES ($1, 'sent_whatsapp', 'sent')`,
      [made.resolved.visit],
    );
  });

  test.afterAll(async () => {
    const patients = Object.values(made).map((v) => v.patient);
    await query(`DELETE FROM consultations WHERE patient_id = ANY($1)`, [patients]);
    await tearDown(ids);
    await query(`DELETE FROM flow_visit_types WHERE id = $1`, [onlineType]);
    if (since === null) await query(`DELETE FROM app_kv WHERE key = 'rx_followups_since'`);
    else
      await query(`UPDATE app_kv SET value = $1::jsonb WHERE key = 'rx_followups_since'`, [
        JSON.stringify(since),
      ]);
  });

  test("1. a patient who left un-explained is listed; Done today marks them Not explained", async () => {
    const q = await queue();
    const row = listed(q, made.left);
    expect(row).toMatchObject({ reason: "not_explained", explained: false, phone: "9876500107" });
    expect(q.explained.find((r) => r.visitId === made.left.visit)?.explained).toBe(false);
  });

  test("2. an explained patient is not listed and is marked Explained", async () => {
    const q = await queue();
    expect(listed(q, made.explained)).toBeUndefined();
    expect(q.explained.find((r) => r.visitId === made.explained.visit)?.explained).toBe(true);
    expect(listed(q, made.waiting)).toBeUndefined();
  });

  test("3. Not taken on an explained patient lists them with the remark", async () => {
    const r = await followup("admin", made.forgot.visit, {
      action: "not_taken",
      remark: "Left the printout at the desk",
    });
    expect(r.status).toBe(200);
    const row = listed(await queue(), made.forgot);
    expect(row).toMatchObject({ reason: "not_taken", explained: true });
    expect(row.lastFollowup).toMatchObject({
      action: "not_taken",
      remark: "Left the printout at the desk",
    });
  });

  test("4. yesterday's unresolved visit carries over; resolved and pre-go-live ones do not", async () => {
    const q = await queue();
    expect(listed(q, made.yesterday)?.visitDate).toBe(dayBefore(ids.day));
    expect(listed(q, made.resolved)).toBeUndefined();
    expect(listed(q, made.old)).toBeUndefined();
    expect(listed(q, made.online)).toBeUndefined();
    expect(listed(q, made.tele)).toBeUndefined();
    const done = (v) => q.explained.find((r) => r.visitId === v.visit);
    expect(done(made.tele)).toMatchObject({ online: true, explained: false });
    expect(done(made.online)).toMatchObject({ online: true, explained: false });
    expect(done(made.left)).toMatchObject({ online: false, explained: false });
  });

  test("4b. the desk can still add an online patient by hand with Not taken", async () => {
    const r = await followup("admin", made.tele.visit, {
      action: "not_taken",
      remark: "Online patient asked for the PDF",
    });
    expect(r.status).toBe(200);
    expect(listed(await queue(), made.tele)).toMatchObject({ reason: "not_taken" });
  });

  test("5. Sent on WhatsApp removes the row and keeps the status; a plain remark does not", async () => {
    expect(
      (await followup("admin", made.yesterday.visit, { action: "note", remark: "Phone off" }))
        .status,
    ).toBe(200);
    expect(listed(await queue(), made.yesterday)?.lastFollowup?.remark).toBe("Phone off");
    const sent = await followup("admin", made.yesterday.visit, {
      action: "sent_whatsapp",
      remark: "Sent PDF on WhatsApp",
    });
    expect(sent.status).toBe(200);
    expect(sent.body.followups.map((f) => f.action)).toEqual(["sent_whatsapp", "note"]);
    expect(listed(await queue(), made.yesterday)).toBeUndefined();
    const { rows } = await query(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
      made.yesterday.visit,
    ]);
    expect(rows[0].current_status).toBe("exited");
  });

  test("6. a remark is required, the action must be known, and other roles are refused", async () => {
    expect(
      (await followup("admin", made.left.visit, { action: "collected", remark: "  " })).status,
    ).toBe(400);
    expect(
      (await followup("admin", made.left.visit, { action: "deleted", remark: "x" })).status,
    ).toBe(400);
    expect(
      (await followup("lab", made.left.visit, { action: "collected", remark: "x" })).status,
    ).toBe(403);
    expect(
      (
        await followup("admin", "00000000-0000-4000-8000-000000000000", {
          action: "note",
          remark: "x",
        })
      ).status,
    ).toBe(404);
  });

  test("7. the station shows the column, and Mark done needs a remark before it saves", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await page.goto("/giniflow/station/rx");
    await expect(page.getByText("📱 Prescription not given")).toBeVisible();
    const name = `P4 RxLeft ${tag}`;
    await expect(
      page.getByRole("link", { name: `Open WhatsApp chat with ${name}` }),
    ).toHaveAttribute("href", /^https:\/\/wa\.me\/919876500107\?text=/);
    await page
      .getByRole("button", { name: `Mark ${name}'s prescription done or add a remark` })
      .click();
    const dialog = page.getByRole("dialog", { name: "Prescription follow-up" });
    await dialog.getByLabel("Collected in person").check();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText("Add a remark — what happened or what was done")).toBeVisible();
    await dialog.getByLabel("Remark (required)").fill("Came back for it");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: `Mark ${name}'s prescription done or add a remark` }),
    ).toHaveCount(0);
  });

  test("7b. Download fetches the file first: a refusal is shown, an image keeps its type", async ({
    page,
  }) => {
    const v = await visitFor("RxDoc", { status: "exited" });
    made.doc = v;
    await query(
      `INSERT INTO documents (patient_id, doc_type, file_url, doc_date, title)
       VALUES ($1, 'prescription', 'https://files.invalid/rx.jpg', $2::date, 'Rx')`,
      [v.patient, ids.day],
    );
    await loginAs(page, "admin");
    await page.goto("/giniflow/station/rx");
    const name = `P4 RxDoc ${tag}`;
    const download = page.getByRole("button", { name: `Download ${name}'s prescription` });
    await page.route("**/print?*", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "No printable copy for this visit" }),
      }),
    );
    await download.click();
    await expect(page.getByText("No printable copy for this visit")).toBeVisible();
    await page.unroute("**/print?*");
    await page.route("**/print?*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: Buffer.from([0xff, 0xd8, 0xff]),
      }),
    );
    const saved = page.waitForEvent("download");
    await download.click();
    expect((await saved).suggestedFilename()).toBe(`Prescription — ${name}.jpeg`);
  });

  test("8. an explained patient opened from Done today can be marked Not taken", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await page.goto("/giniflow/station/rx");
    const name = `P4 RxDone ${tag}`;
    await page
      .getByRole("button", { name: `Open ${name}'s prescription and medicine card` })
      .first()
      .click();
    const pane = page.getByRole("dialog", { name: "Explain the prescription" });
    await expect(pane.getByText("✓ Explained")).toBeVisible();
    await expect(pane.getByRole("button", { name: "Add remark" })).toBeVisible();
    await expect(pane.getByRole("button", { name: "✓ Mark done / remark" })).toHaveCount(0);
    await pane.getByRole("button", { name: "⚠ Not taken" }).click();
    const dialog = page.getByRole("dialog", { name: "Prescription not taken" });
    await dialog.getByLabel("Remark (required)").fill("Forgot it");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(pane.getByText("Forgot it")).toBeVisible();
    await expect(pane.getByRole("button", { name: "✓ Mark done / remark" })).toBeVisible();
    await expect(pane.getByRole("button", { name: "⚠ Not taken" })).toHaveCount(0);
    expect(listed(await queue(), made.explained)?.reason).toBe("not_taken");
  });
});
