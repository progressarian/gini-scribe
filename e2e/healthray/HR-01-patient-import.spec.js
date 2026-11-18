import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const importer = await import("../../server/services/healthray/patientImport.js");

const KV = "healthray_patients_checkpoint";
const tag = String(Date.now()).slice(-6);
const uhid = (n) => `P_9${tag}${String(n).padStart(3, "0")}`;
const hid = (n) => `E2EHR${tag}${String(n).padStart(3, "0")}`;
const DAY = Date.parse("2026-11-17T09:00:00+05:30");

const row = (n, { healthId = hid(n), caseId = uhid(n), at = DAY + n * 60_000 } = {}) => ({
  id: n,
  patient_case_id: caseId,
  registration_date: new Date(at).toISOString(),
  mobile_no: `8${tag}${String(n).padStart(3, "0")}`,
  family_member: {
    healthray_id: healthId,
    first_name: `HR Test ${n}`,
    last_name: tag,
    gender: n % 2 ? "male" : "female",
    birth_date: "01-01-1980",
  },
});

const pager = (rows) => {
  const calls = [];
  const fetchList = async ({ page, perPage }) => {
    calls.push(page);
    return rows.slice((page - 1) * perPage, page * perPage);
  };
  return { fetchList, calls };
};

const chartsFor = (healthIdOrUhid) =>
  query(`SELECT id, health_id, file_no, name FROM patients WHERE health_id = $1 OR file_no = $1`, [
    healthIdOrUhid,
  ]).then((r) => r.rows);

const setCheckpoint = (value) =>
  query(
    `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [KV, JSON.stringify(value)],
  );
const checkpoint = async () => (await one(`SELECT value FROM app_kv WHERE key = $1`, [KV]))?.value;

let savedCheckpoint;

test.describe.serial("HR-01 HealthRay patient import: backfill and new-patient sync", () => {
  test.beforeAll(async () => {
    savedCheckpoint = await checkpoint();
    await query(
      `INSERT INTO patients (name, health_id, file_no, sex) VALUES
         ('Known By HealthId', $1, $2, 'Male'),
         ('Legacy Chart', NULL, $3, 'Female'),
         ('Old Owner', $4, $5, 'Male'),
         ('Uhid Only', NULL, $6, 'Male')`,
      [hid(1), uhid(1), uhid(2), hid(900), uhid(3), uhid(6)],
    );
  });

  test.afterAll(async () => {
    await query(`DELETE FROM patients WHERE health_id LIKE $1 OR file_no LIKE $2`, [
      `E2EHR${tag}%`,
      `P_9${tag}%`,
    ]);
    if (savedCheckpoint) await setCheckpoint(savedCheckpoint);
    else await query(`DELETE FROM app_kv WHERE key = $1`, [KV]);
  });

  test("1. only patients Scribe does not hold are reported missing", async () => {
    const rows = [
      row(1),
      row(2),
      row(3),
      row(4),
      row(5, { healthId: "", caseId: "" }),
      row(6, { healthId: "" }),
      row(7, { healthId: "" }),
    ];
    const { present, missing, unusable } = await importer.classifyHealthrayRows(rows);
    const ids = (list) => list.map((r) => r.id).sort((a, b) => a - b);
    expect(ids(present)).toEqual([1, 2, 6]);
    expect(ids(missing)).toEqual([3, 4, 7]);
    expect(ids(unusable)).toEqual([5]);
  });

  test("2. a dry run writes nothing", async () => {
    const { fetchList } = pager([row(3), row(4)]);
    const result = await importer.backfillHealthrayPage({ page: 1, perPage: 100, fetchList });
    expect(result.missing).toHaveLength(2);
    expect(result.imported).toBe(0);
    expect(await chartsFor(hid(4))).toHaveLength(0);
  });

  test("3. apply imports the missing patients once and a reused UHID moves to its new owner", async () => {
    const { fetchList } = pager([row(1), row(3), row(4), row(5, { healthId: "", caseId: "" })]);
    const first = await importer.backfillHealthrayPage({
      page: 1,
      perPage: 100,
      apply: true,
      fetchList,
    });
    expect(first.imported).toBe(2);

    const newOwner = await chartsFor(hid(3));
    expect(newOwner).toHaveLength(1);
    expect(newOwner[0].file_no).toBe(uhid(3));
    const oldOwner = await one(`SELECT file_no FROM patients WHERE health_id = $1`, [hid(900)]);
    expect(oldOwner.file_no).not.toBe(uhid(3));
    expect(await chartsFor(hid(4))).toHaveLength(1);

    const again = await importer.backfillHealthrayPage({
      page: 1,
      perPage: 100,
      apply: true,
      fetchList,
    });
    expect(again.missing).toHaveLength(0);
    expect(again.imported).toBe(0);
    expect(await chartsFor(hid(4))).toHaveLength(1);
  });

  test("4. the live sync catches up across ticks instead of skipping a backlog", async () => {
    const since = DAY + 99 * 60_000;
    await setCheckpoint({ registeredAt: since });
    const backlog = Array.from({ length: 60 }, (_, i) => row(100 + i));
    const older = Array.from({ length: 10 }, (_, i) => row(10 + i));
    const feed = [...backlog].reverse().concat(older.reverse());

    const tick1 = pager(feed);
    const first = await importer.syncNewHealthrayPatients({
      fetchList: tick1.fetchList,
      maxPages: 2,
    });
    expect(tick1.calls).toEqual([1, 2]);
    expect(first.imported).toBe(50);
    expect(first.resumePage).toBe(3);
    expect((await checkpoint()).registeredAt).toBe(since);

    const latecomers = Array.from({ length: 5 }, (_, i) => row(200 + i));
    const shifted = [...latecomers].reverse().concat(feed);
    const tick2 = pager(shifted);
    const second = await importer.syncNewHealthrayPatients({
      fetchList: tick2.fetchList,
      maxPages: 2,
    });
    expect(tick2.calls[0]).toBe(3);
    expect(second.resumePage).toBeNull();
    expect((await checkpoint()).registeredAt).toBe(DAY + 159 * 60_000);

    const tick3 = pager(shifted);
    const third = await importer.syncNewHealthrayPatients({
      fetchList: tick3.fetchList,
      maxPages: 2,
    });
    expect(tick3.calls).toEqual([1]);
    expect(third.imported).toBe(6);
    expect((await checkpoint()).registeredAt).toBe(DAY + 204 * 60_000);

    const { count } = await one(
      `SELECT count(*)::int AS count FROM patients WHERE health_id = ANY($1::text[])`,
      [[...backlog, ...latecomers].map((r) => r.family_member.healthray_id)],
    );
    expect(count).toBe(65);
    const { olderCount } = await one(
      `SELECT count(*)::int AS "olderCount" FROM patients WHERE health_id = ANY($1::text[])`,
      [older.map((r) => r.family_member.healthray_id)],
    );
    expect(olderCount).toBe(0);
  });

  test("5. a HealthRay failure leaves the checkpoint where it was", async () => {
    const before = await checkpoint();
    const failing = async () => {
      throw Object.assign(new Error("blocked"), { healthrayBlocked: true });
    };
    await expect(importer.syncNewHealthrayPatients({ fetchList: failing })).rejects.toThrow(
      "blocked",
    );
    expect(await checkpoint()).toEqual(before);
  });
});
