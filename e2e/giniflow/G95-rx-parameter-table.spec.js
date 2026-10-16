import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { buildRxParameterTable, DEFAULT_RX_PARAMETERS, RX_PARAMETER_DEFAULTS_KEY } =
  await import("../../server/services/rxParameterTable.js");
const { buildPrescriptionHtml } = await import("../../server/templates/prescriptionTemplate.js");

const tag = newTag();
let ids;
let made;
let defaultsBefore;

const addDays = (ymd, days) => {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

const PAST = [-200, -150, -120, -90, -60, -30];

async function seed() {
  for (const offset of PAST) {
    await query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status, visit_type, doctor_name)
       SELECT id, name, file_no, $2::date, 'completed', 'Follow-Up', 'Dr. G92' FROM patients WHERE id = $1`,
      [made.patient, addDays(ids.day, offset)],
    );
  }
  await query(
    `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status, visit_type, doctor_name)
     SELECT id, name, file_no, $2::date, 'completed', 'Investigation', 'Dr. Hospital Admin' FROM patients WHERE id = $1`,
    [made.patient, addDays(ids.day, -10)],
  );
  const vital = (offset, cols) =>
    query(
      `INSERT INTO vitals (patient_id, recorded_at, weight, height, bp_sys, bp_dia)
       VALUES ($1, ($2::date + time '10:00') AT TIME ZONE 'Asia/Kolkata', $3, $4, $5, $6)`,
      [
        made.patient,
        addDays(ids.day, offset),
        cols.weight,
        cols.height ?? null,
        cols.bp_sys ?? null,
        cols.bp_dia ?? null,
      ],
    );
  await vital(-200, { weight: 99 });
  await vital(-150, { weight: 95, height: 170 });
  await vital(-90, { weight: 92, bp_sys: 140, bp_dia: 90 });
  await vital(0, { weight: 88, bp_sys: 128, bp_dia: 82 });
  const lab = (offset, name, result, resultText = null) =>
    query(
      `INSERT INTO lab_results (patient_id, test_date, test_name, canonical_name, result, result_text)
       VALUES ($1, $2::date, $3, $3, $4, $5)`,
      [made.patient, addDays(ids.day, offset), name, result, resultText],
    );
  await lab(-123, "HbA1c", 8.4);
  await lab(-60, "HbA1c", 7.1);
  await lab(-2, "HbA1c", 6.4);
  await lab(-30, "FBS", 118);
  await lab(-30, "ABI Right", 1.12);
  await lab(-30, "ABI Left", 1.14);
  await lab(-60, "Fundus", null, "No DR");
}

const rowOf = (table, key) => table.rows.find((r) => r.key === key);

test.describe.serial("G95 the prescription parameter table", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    made = await extraVisit(ids, "Rxp", { healthray: false });
    defaultsBefore = (
      await query(`SELECT value FROM app_kv WHERE key = $1`, [RX_PARAMETER_DEFAULTS_KEY])
    ).rows[0]?.value;
    await query(`DELETE FROM app_kv WHERE key = $1`, [RX_PARAMETER_DEFAULTS_KEY]);
    await seed();
  });

  test.afterAll(async () => {
    if (defaultsBefore === undefined) {
      await query(`DELETE FROM app_kv WHERE key = $1`, [RX_PARAMETER_DEFAULTS_KEY]);
    } else {
      await query(`UPDATE app_kv SET value = $2 WHERE key = $1`, [
        RX_PARAMETER_DEFAULTS_KEY,
        JSON.stringify(defaultsBefore),
      ]);
    }
    if (made) {
      for (const t of ["rx_parameter_overrides", "lab_results", "vitals"]) {
        await query(`DELETE FROM ${t} WHERE patient_id = $1`, [made.patient]);
      }
      await query(
        `DELETE FROM appointments WHERE patient_id = $1 AND doctor_name IN ('Dr. G92', 'Dr. Hospital Admin')`,
        [made.patient],
      );
    }
    await tearDown(ids);
  });

  test("1. columns are the last 5 doctor visits plus today; lab-only visits don't count", async () => {
    const table = await buildRxParameterTable(db, { patientId: made.patient, visitDate: ids.day });
    expect(table.columns.map((c) => c.date)).toEqual([
      addDays(ids.day, -150),
      addDays(ids.day, -120),
      addDays(ids.day, -90),
      addDays(ids.day, -60),
      addDays(ids.day, -30),
      ids.day,
    ]);
    expect(table.columns.at(-1).today).toBe(true);
    expect(table.rows.map((r) => r.key)).toEqual(DEFAULT_RX_PARAMETERS.map((p) => p.key));
  });

  test("2. each reading lands on its visit; a lab 3 days before a visit counts for it", async () => {
    const table = await buildRxParameterTable(db, { patientId: made.patient, visitDate: ids.day });
    expect(rowOf(table, "weight").values).toEqual(["95", null, "92", null, null, "88"]);
    expect(rowOf(table, "hba1c").values).toEqual([null, "8.4", null, "7.1", null, "6.4"]);
    expect(rowOf(table, "height").values).toEqual(["170", null, null, null, null, null]);
    expect(rowOf(table, "bp").values).toEqual([null, null, "140/90", null, null, "128/82"]);
    expect(rowOf(table, "fpg").values.at(-2)).toBe("118");
    expect(rowOf(table, "abi").values.at(-2)).toBe("R 1.12 / L 1.14");
    expect(rowOf(table, "fundus").values.at(-3)).toBe("No DR");
  });

  test("2b. vitals stamped at midnight after their visit still land on that visit", async () => {
    const visit = addDays(ids.day, -120);
    const { rows } = await query(
      `INSERT INTO consultations (patient_id, visit_date, status) VALUES ($1, $2::date, 'completed') RETURNING id`,
      [made.patient, visit],
    );
    await query(
      `INSERT INTO vitals (patient_id, consultation_id, recorded_at, weight)
       VALUES ($1, $2, ($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata', 94)`,
      [made.patient, rows[0].id, visit],
    );
    try {
      const table = await buildRxParameterTable(db, {
        patientId: made.patient,
        visitDate: ids.day,
      });
      expect(rowOf(table, "weight").values).toEqual(["95", "94", "92", null, null, "88"]);
    } finally {
      await query(`DELETE FROM vitals WHERE consultation_id = $1`, [rows[0].id]);
      await query(`DELETE FROM consultations WHERE id = $1`, [rows[0].id]);
    }
  });

  test("2c. an empty consultation record is not counted as a visit", async () => {
    const { rows } = await query(
      `INSERT INTO consultations (patient_id, visit_date, status, mo_data)
       VALUES ($1, $2::date, 'completed', '{"follow_up": null, "raw_comment": "", "diet_lifestyle": []}'::jsonb)
       RETURNING id`,
      [made.patient, addDays(ids.day, -45)],
    );
    try {
      const table = await buildRxParameterTable(db, {
        patientId: made.patient,
        visitDate: ids.day,
      });
      expect(table.columns.map((c) => c.date)).not.toContain(addDays(ids.day, -45));
      await query(`UPDATE consultations SET con_name = 'Dr. G92' WHERE id = $1`, [rows[0].id]);
      const counted = await buildRxParameterTable(db, {
        patientId: made.patient,
        visitDate: ids.day,
      });
      expect(counted.columns.map((c) => c.date)).toContain(addDays(ids.day, -45));
    } finally {
      await query(`DELETE FROM consultations WHERE id = $1`, [rows[0].id]);
    }
  });

  test("3. the station edits today, adds, removes and reorders for this prescription only", async () => {
    const api = await apiAs("admin");
    try {
      const path = `/api/giniflow/stations/doctor/${made.visit}/rx-parameters`;
      const res = await api.put(path, {
        data: {
          rows: [
            { key: "weight", value: "87.5" },
            { key: "height", removed: true },
            { key: "vpt", show: true },
            {
              key: "grip",
              custom: true,
              label: "Grip strength",
              unit: "kg",
              value: "24",
              order: 0,
            },
          ],
        },
      });
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();
      expect(body.rows[0]).toMatchObject({ key: "grip", label: "Grip strength", custom: true });
      expect(body.rows[0].values.at(-1)).toBe("24");
      expect(rowOf(body, "weight").values.at(-1)).toBe("87.5");
      expect(rowOf(body, "weight")).toMatchObject({ measuredToday: "88", edited: true });
      expect(rowOf(body, "height")).toBeUndefined();
      expect(body.removed.map((r) => r.key)).toContain("height");
      expect(rowOf(body, "vpt").show).toBe(true);
      expect(body.locked).toBe(false);
      expect(body.catalog.length).toBe(DEFAULT_RX_PARAMETERS.length);

      const again = await (await api.get(path)).json();
      expect(again.rows.map((r) => r.key)).toEqual(body.rows.map((r) => r.key));

      const html = buildPrescriptionHtml({
        patient: { name: "G92", file_no: "G92" },
        doctor: { name: "Dr G92" },
        rxParameters: await buildRxParameterTable(db, {
          patientId: made.patient,
          visitDate: ids.day,
        }),
      });
      expect(html).toContain("Grip strength");
      expect(html).toContain(">87.5<");
      expect(html).toContain(">VPT<");
      expect(html).not.toContain(">Height<");
    } finally {
      await api.dispose();
    }
  });

  test("4. bad input, the wrong role and a finalized visit are refused", async () => {
    const api = await apiAs("admin");
    const reception = await apiAs("reception");
    const path = `/api/giniflow/stations/doctor/${made.visit}/rx-parameters`;
    try {
      for (const data of [
        { rows: [{ key: "Bad Key!" }] },
        { rows: [{ key: "weight", value: "x".repeat(41) }] },
        { rows: [{ key: "nope" }] },
        { rows: [{ key: "newone", custom: true, label: "  " }] },
        { rows: [], extra: 1 },
      ]) {
        const res = await api.put(path, { data });
        expect(res.status(), JSON.stringify(data)).toBe(400);
      }
      expect((await reception.get(path)).status()).toBe(403);
      await query(`UPDATE giniflow_visits SET current_status = 'doctor_done' WHERE id = $1`, [
        made.visit,
      ]);
      const locked = await api.put(path, { data: { rows: [{ key: "weight", value: "80" }] } });
      expect(locked.status()).toBe(409);
      expect((await locked.json()).error).toMatch(/Re-issue/);
      expect((await (await api.get(path)).json()).locked).toBe(true);
    } finally {
      await query(`UPDATE giniflow_visits SET current_status = 'booked' WHERE id = $1`, [
        made.visit,
      ]);
      await api.dispose();
      await reception.dispose();
    }
  });

  test("5. Settings defaults drive new prescriptions; saved edits survive", async () => {
    const api = await apiAs("admin");
    try {
      const custom = [
        { key: "weight", label: "Body weight", unit: "kg", source: { vital: "weight" } },
        { key: "hba1c", label: "HbA1c", unit: "%", source: { labs: ["HbA1c"] } },
      ];
      const saved = await api.put("/api/admin/rx-parameters", { data: { parameters: custom } });
      expect(saved.status(), await saved.text()).toBe(200);
      expect((await (await api.get("/api/admin/rx-parameters")).json()).parameters).toHaveLength(2);
      const table = await buildRxParameterTable(db, {
        patientId: made.patient,
        visitDate: ids.day,
      });
      expect(table.rows.map((r) => r.key)).toEqual(["grip", "weight", "hba1c"]);
      expect(rowOf(table, "weight")).toMatchObject({ label: "Body weight" });
      expect(rowOf(table, "weight").values.at(-1)).toBe("87.5");
      const dup = await api.put("/api/admin/rx-parameters", {
        data: { parameters: [custom[0], custom[0]] },
      });
      expect(dup.status()).toBe(400);
      const reception = await apiAs("reception");
      expect((await reception.get("/api/admin/rx-parameters")).status()).toBe(403);
      await reception.dispose();
    } finally {
      await api.dispose();
    }
  });

  test("6. the print shows Today only once today's visit is completed", async () => {
    const before = await query(
      `SELECT id, status FROM appointments WHERE patient_id = $1 AND appointment_date = $2::date`,
      [made.patient, ids.day],
    );
    await query(`UPDATE appointments SET status = 'scheduled' WHERE id = ANY($1::int[])`, [
      before.rows.map((r) => r.id),
    ]);
    try {
      const open = await buildRxParameterTable(db, {
        patientId: made.patient,
        visitDate: ids.day,
        todayOnlyWhenCompleted: true,
      });
      expect(open.columns.map((c) => c.date)).toEqual(PAST.map((o) => addDays(ids.day, o)));
      expect(open.columns.some((c) => c.today)).toBe(false);
      expect(rowOf(open, "weight").values.at(-1)).toBeNull();
      expect(buildPrescriptionHtml({ patient: { name: "X" }, rxParameters: open })).not.toContain(
        "Today (",
      );

      await query(
        `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status, visit_type, doctor_name)
         SELECT id, name, file_no, $2::date, 'completed', 'Follow-Up', 'Dr. G92' FROM patients WHERE id = $1`,
        [made.patient, ids.day],
      );
      const done = await buildRxParameterTable(db, {
        patientId: made.patient,
        visitDate: ids.day,
        todayOnlyWhenCompleted: true,
      });
      expect(done.columns.at(-1)).toEqual({ date: ids.day, today: true });
      expect(done.columns).toHaveLength(6);
    } finally {
      for (const r of before.rows) {
        await query(`UPDATE appointments SET status = $2 WHERE id = $1`, [r.id, r.status]);
      }
    }
  });
});
