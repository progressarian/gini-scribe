import { test, expect } from "@playwright/test";
import http from "node:http";
import { query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const storage = { fail: false, uploads: 0 };
const storageStub = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    storage.uploads += 1;
    res.writeHead(storage.fail ? 500 : 200, { "Content-Type": "application/json" });
    res.end(storage.fail ? '{"error":"down"}' : '{"Key":"ok"}');
  });
});
await new Promise((resolve) => storageStub.listen(0, "127.0.0.1", resolve));
process.env.SUPABASE_URL = `http://127.0.0.1:${storageStub.address().port}`;
process.env.SUPABASE_SERVICE_KEY = "e2e-storage-stub";

const storageConfig = await import("../../server/config/storage.js");
const rx = await import("../../server/services/prescriptionAutoSave.js");
const { maybeAutoSavePrescription } = await import("../../server/services/healthray/db.js");

const NOTES = "Follow up visit. Continue Metformin 500 mg twice daily after meals.";
const tag = newTag();
let ids;
let made;
let consultationId;

const scribeRx = async () =>
  (
    await query(
      `SELECT id, storage_path FROM documents
        WHERE patient_id = $1 AND consultation_id = $2
          AND doc_type = 'prescription' AND source = 'visit'
        ORDER BY id`,
      [made.patient, consultationId],
    )
  ).rows;

const save = async () =>
  rx.savePrescriptionForVisit(
    made.patient,
    await rx.buildVisitPayloadFromDb(made.patient, { appointmentId: made.appointment }),
    { appointmentId: made.appointment, consultationId, source: "visit", overwrite: true },
  );

const oldCopy = async () =>
  (
    await query(
      `INSERT INTO documents (patient_id, consultation_id, doc_type, title, file_name, doc_date, source)
       VALUES ($1, $2, 'prescription', 'Prescription — old copy', 'old.pdf', $3::date, 'visit')
       RETURNING id`,
      [made.patient, consultationId, ids.day],
    )
  ).rows[0].id;

test.describe.serial("G133 a visit keeps one Scribe prescription", () => {
  test.setTimeout(180000);

  test.beforeAll(async () => {
    ids = await setUp(tag);
    made = await extraVisit(ids, "RxOneCopy", { healthray: false });
    consultationId = (
      await query(
        `INSERT INTO consultations (patient_id, visit_date, status) VALUES ($1, $2::date, 'completed')
         RETURNING id`,
        [made.patient, ids.day],
      )
    ).rows[0].id;
    await query(
      `UPDATE appointments
          SET status = 'completed', consultation_id = $2, healthray_clinical_notes = $3,
              opd_backfilled_at = NOW(), notes_read_status = 'read', notes_read_hash = md5($3),
              notes_read_at = NOW()
        WHERE id = $1`,
      [made.appointment, consultationId, NOTES],
    );
    await query(
      `INSERT INTO medications (patient_id, consultation_id, name, dose, is_active)
       VALUES ($1, $2, 'Metformin', '500 mg', true)`,
      [made.patient, consultationId],
    );
  });

  test.afterAll(async () => {
    await query(`DELETE FROM documents WHERE patient_id = $1`, [made.patient]);
    await query(`DELETE FROM medications WHERE patient_id = $1`, [made.patient]);
    await query(`UPDATE appointments SET consultation_id = NULL WHERE id = $1`, [made.appointment]);
    await query(`DELETE FROM consultations WHERE id = $1`, [consultationId]);
    await tearDown(ids);
    await new Promise((resolve) => storageStub.close(resolve));
  });

  test("1. the save stores its PDF in the local storage stand-in", async () => {
    expect(storageConfig.SUPABASE_URL).toBe(process.env.SUPABASE_URL);
    const saved = await save();
    expect(saved.document.id).toBeTruthy();
    const rows = await scribeRx();
    expect(rows).toHaveLength(1);
    expect(rows[0].storage_path).toBeTruthy();
  });

  test("2. two saves at the same moment leave one copy, the newest", async () => {
    const results = await Promise.all([save(), save()]);
    const newest = Math.max(...results.map((r) => r.document.id));
    const rows = await scribeRx();
    expect(rows.map((r) => r.id)).toEqual([newest]);
  });

  test("3. older duplicates left by earlier races are removed by the next save", async () => {
    const stale = [await oldCopy(), await oldCopy()];
    const saved = await save();
    const rows = await scribeRx();
    expect(rows.map((r) => r.id)).toEqual([saved.document.id]);
    expect(rows.map((r) => r.id)).not.toContain(stale[0]);
  });

  test("4. a failed upload keeps the stored copy and adds nothing", async () => {
    const before = await scribeRx();
    storage.fail = true;
    try {
      await expect(save()).rejects.toThrow(/Could not store the regenerated prescription/);
    } finally {
      storage.fail = false;
    }
    expect(await scribeRx()).toEqual(before);
  });

  test("5. after-seen saves fired together run one after another and leave one copy", async () => {
    const uploadsBefore = storage.uploads;
    await Promise.all([
      maybeAutoSavePrescription(made.appointment),
      maybeAutoSavePrescription(made.appointment),
      maybeAutoSavePrescription(made.appointment),
    ]);
    const rows = await scribeRx();
    expect(rows).toHaveLength(1);
    expect(rows[0].storage_path).toBeTruthy();
    expect(storage.uploads - uploadsBefore).toBeLessThanOrEqual(2);
  });
});
