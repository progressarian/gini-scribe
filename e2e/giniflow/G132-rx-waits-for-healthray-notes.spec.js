import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const notes = await import("../../server/services/healthray/notesRead.js");
const rx = await import("../../server/services/giniflow/rxStation.js");
const printRx = await import("../../server/services/giniflow/printRx.js");

const db = getPool();
const tag = newTag();
let ids;
let since;
const made = {};
let hrSeq = Math.floor(Math.random() * 900) * 10;

const NOTES = "TREATMENT\nTAB DAPLO M 10/500MG 30MIN BEFORE BREAKFAST\nTAB TELMA 20MG AT 8PM";

const dayBefore = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

async function rxVisit(label, { healthrayRx = true, hrRxMinutesAgo = 1 } = {}) {
  const v = await extraVisit(ids, label, { healthray: false });
  await query(
    `UPDATE appointments
        SET healthray_id = $2, healthray_clinical_notes = $3, status = 'completed'
      WHERE id = $1`,
    [v.appointment, String(9132000 + ++hrSeq), NOTES],
  );
  await query(`UPDATE giniflow_visits SET current_status = 'rx_pending' WHERE id = $1`, [v.visit]);
  const cons = await one(
    `INSERT INTO consultations (patient_id, visit_date, status)
     VALUES ($1, $2::date, 'completed') RETURNING id`,
    [v.patient, ids.day],
  );
  await query(`UPDATE appointments SET consultation_id = $2 WHERE id = $1`, [
    v.appointment,
    cons.id,
  ]);
  const scribe = await one(
    `INSERT INTO documents (patient_id, consultation_id, doc_type, source, title, doc_date, file_url)
     VALUES ($1, $2, 'prescription', 'visit', 'Prescription — Visit', $3::date,
             'https://example.invalid/scribe.pdf') RETURNING id`,
    [v.patient, cons.id, ids.day],
  );
  const hr = healthrayRx
    ? await one(
        `INSERT INTO documents (patient_id, doc_type, source, title, doc_date, file_url, created_at)
         VALUES ($1, 'prescription', 'healthray', 'Prescription/Rx', $2::date,
                 'https://example.invalid/hr.pdf', NOW() - ($3 || ' minutes')::interval)
         RETURNING id`,
        [v.patient, ids.day, String(hrRxMinutesAgo)],
      )
    : null;
  return { ...v, consultation: cons.id, scribeRx: scribe.id, healthrayRx: hr?.id ?? null };
}

const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { status: error.status, reason: error.reason, message: error.message };
  }
  return null;
};

const WAITING = {
  status: 409,
  reason: "notes_waiting",
  message: "Waiting for today's HealthRay notes — the prescription isn't ready yet",
};

test.describe.serial("G132 the Scribe prescription waits for today's HealthRay notes", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    since = (await query(`SELECT value FROM app_kv WHERE key = 'rx_notes_gate_since'`)).rows[0]
      ?.value;
    await query(
      `INSERT INTO app_kv (key, value) VALUES ('rx_notes_gate_since', to_jsonb($1::text))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [dayBefore(ids.day)],
    );
    made.waiting = await rxVisit("NotesWait");
    made.read = await rxVisit("NotesRead");
    made.failed = await rxVisit("NotesFailed");
    made.late = await rxVisit("NotesLate", { hrRxMinutesAgo: 11 });
    made.scribeOnly = await rxVisit("ScribeOnly", { healthrayRx: false });
  });

  test.afterAll(async () => {
    const patients = Object.values(made).map((v) => v.patient);
    await query(`DELETE FROM documents WHERE patient_id = ANY($1)`, [patients]);
    await query(`UPDATE appointments SET consultation_id = NULL WHERE patient_id = ANY($1)`, [
      patients,
    ]);
    await query(`DELETE FROM consultations WHERE patient_id = ANY($1)`, [patients]);
    await tearDown(ids);
    if (since === undefined) await query(`DELETE FROM app_kv WHERE key = 'rx_notes_gate_since'`);
    else
      await query(`UPDATE app_kv SET value = $1::jsonb WHERE key = 'rx_notes_gate_since'`, [
        JSON.stringify(since),
      ]);
  });

  test("1. HealthRay's Rx is in but today's notes are not read: nothing can be printed or rebuilt", async () => {
    expect(await notes.notesReadFor(made.waiting.appointment, db)).toBe(false);
    const patient = await rx.getRxPatient(made.waiting.visit, db);
    expect(patient.canPrint).toBe(false);
    expect(patient.notesWait).toMatchObject({ unreadable: false, healthrayRxId: null });
    expect(patient.notesWait.since).toBeTruthy();
    expect(await refusal(printRx.getPrintableRx(made.waiting.visit, db))).toEqual(WAITING);
    expect(await refusal(printRx.regenerateRx(made.waiting.visit, db))).toEqual(WAITING);

    const queue = await rx.getRxQueue(ids.day, `NotesWait ${tag}`, new Date(), db);
    const row = queue.waiting.find((r) => r.visitId === made.waiting.visit);
    expect(row).toMatchObject({ canPrint: false, notesWait: { unreadable: false } });

    const api = await apiAs("admin");
    try {
      const card = await api.get(
        `/api/giniflow/stations/rx/${made.waiting.visit}/medicine-card.pdf`,
      );
      expect(card.status()).toBe(409);
      expect((await card.json()).reason).toBe("notes_waiting");
      const print = await api.get(`/api/giniflow/stations/rx/${made.waiting.visit}/print`);
      expect(print.status()).toBe(409);
    } finally {
      await api.dispose();
    }
  });

  test("2. once the current notes are read, the prescription is printable again", async () => {
    await notes.markNotesRead(made.read.appointment, "read", NOTES, db);
    expect(await notes.notesReadFor(made.read.appointment, db)).toBe(true);
    const patient = await rx.getRxPatient(made.read.visit, db);
    expect(patient.notesWait).toBeNull();
    expect(patient.canPrint).toBe(true);
    expect((await printRx.getPrintableRx(made.read.visit, db)).document_id).toBe(
      made.read.scribeRx,
    );
  });

  test("3. notes edited in HealthRay after they were read make it wait again", async () => {
    await query(
      `UPDATE appointments SET healthray_clinical_notes = healthray_clinical_notes || '\nTAB AKTIV D 60K'
        WHERE id = $1`,
      [made.read.appointment],
    );
    expect(await notes.notesReadFor(made.read.appointment, db)).toBe(false);
    expect((await rx.getRxPatient(made.read.visit, db)).canPrint).toBe(false);
  });

  test("4. notes that couldn't be read: the HealthRay prescription is the one printed", async () => {
    await notes.markNotesRead(made.failed.appointment, "failed", NOTES, db);
    const patient = await rx.getRxPatient(made.failed.visit, db);
    expect(patient).toMatchObject({
      canPrint: true,
      rxFromHealthray: true,
      notesWait: { unreadable: true, healthrayRxId: made.failed.healthrayRx },
    });
    expect(await printRx.getPrintableRx(made.failed.visit, db)).toMatchObject({
      document_id: made.failed.healthrayRx,
      doc_source: "healthray",
    });
    expect(await refusal(printRx.regenerateRx(made.failed.visit, db))).toMatchObject({
      status: 409,
      reason: "notes_waiting",
      message: "Today's HealthRay notes couldn't be read — use the HealthRay prescription",
    });
  });

  test("5. after 10 minutes of waiting the HealthRay prescription is the one printed", async () => {
    const patient = await rx.getRxPatient(made.late.visit, db);
    expect(patient).toMatchObject({
      canPrint: true,
      rxFromHealthray: true,
      notesWait: { unreadable: false, healthrayRxId: made.late.healthrayRx },
    });
    expect((await printRx.getPrintableRx(made.late.visit, db)).document_id).toBe(
      made.late.healthrayRx,
    );
    const queue = await rx.getRxQueue(ids.day, `NotesLate ${tag}`, new Date(), db);
    expect(queue.waiting.find((r) => r.visitId === made.late.visit)).toMatchObject({
      canPrint: true,
      rxFromHealthray: true,
    });
  });

  test("6. a prescription written in Scribe, with no HealthRay Rx, never waits", async () => {
    const patient = await rx.getRxPatient(made.scribeOnly.visit, db);
    expect(patient.notesWait).toBeNull();
    expect(patient.canPrint).toBe(true);
  });

  test("7. up to the day this shipped, notes Scribe already read count as read; unread ones still wait", async () => {
    await query(`UPDATE app_kv SET value = to_jsonb($1::text) WHERE key = 'rx_notes_gate_since'`, [
      ids.day,
    ]);
    try {
      expect(await notes.notesReadFor(made.waiting.appointment, db)).toBe(false);
      expect((await rx.getRxPatient(made.waiting.visit, db)).canPrint).toBe(false);
      await query(`UPDATE appointments SET opd_backfilled_at = NOW() WHERE id = $1`, [
        made.waiting.appointment,
      ]);
      expect(await notes.notesReadFor(made.waiting.appointment, db)).toBe(true);
      expect((await rx.getRxPatient(made.waiting.visit, db)).canPrint).toBe(true);
    } finally {
      await query(`UPDATE appointments SET opd_backfilled_at = NULL WHERE id = $1`, [
        made.waiting.appointment,
      ]);
      await query(
        `UPDATE app_kv SET value = to_jsonb($1::text) WHERE key = 'rx_notes_gate_since'`,
        [dayBefore(ids.day)],
      );
    }
  });

  test("8. the Rx desk shows the wait and holds the prescription and the medicine card", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await page.goto("/giniflow/station/rx");
    await page.getByText(`P4 NotesWait ${tag}`).first().click();
    const pane = page.getByRole("dialog", { name: "Explain the prescription" });
    await expect(
      pane.getByRole("status").filter({ hasText: "Waiting for today's HealthRay notes" }),
    ).toBeVisible();
    await expect(
      pane.getByRole("button", { name: /Print prescription|Generate prescription/ }),
    ).toHaveCount(0);
    await expect(pane.getByRole("button", { name: "🖨 Print medicine card" })).toBeDisabled();
    await page.getByRole("button", { name: "← Back" }).click();

    await page.getByText(`P4 NotesFailed ${tag}`).first().click();
    await expect(
      pane
        .getByRole("status")
        .filter({ hasText: "couldn't be read — showing the HealthRay prescription" }),
    ).toBeVisible();
    await expect(pane.getByRole("button", { name: "🖨 Print HealthRay Rx" })).toBeVisible();
    await expect(pane.getByRole("button", { name: "View HealthRay Rx" })).toBeVisible();
    await expect(pane.getByRole("button", { name: "🖨 Print medicine card" })).toBeDisabled();
  });
});
