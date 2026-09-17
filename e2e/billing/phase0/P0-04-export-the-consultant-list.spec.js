import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { getPool, one, query } from "../../helpers/db.mjs";
import { buildTestEnv, repoRoot } from "../../setup/testEnv.mjs";
import {
  CONSULTANT_COLUMNS,
  OTHER_STAFF_COLUMNS,
  RECENT_DAYS,
  UPCOMING_DAYS,
  buildConsultantList,
  collectConsultantList,
  matchDoctorByName,
} from "../../../server/services/billing/consultantListExport.js";

const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");
const SCRIPT = path.join(repoRoot, "server", "scripts", "export-billing-consultant-list.mjs");
const PAST = `appointments_last_${RECENT_DAYS}_days`;
const NEXT = `appointments_next_${UPCOMING_DAYS}_days`;
const TAG = "e2e-p0-04";

const EXTRA = [
  { id: 9151, name: "Dr E2E Retired", role: "consultant", active: false },
  { id: 9152, name: "Dr. Hospital Admin", role: "consultant", active: true },
  { id: 9153, name: "Dr E2E Rahul", role: "consultant", active: true },
  { id: 9154, name: "Dr. E2E Mehtab Singh", short: "Dr. Mehtab", role: "consultant", active: true },
  { id: 9155, name: "Dr. E2E Mehtab Sing", short: null, role: "consultant", active: true },
];

async function readSheets(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const read = (name) => {
    const ws = workbook.getWorksheet(name);
    const headers = ws.getRow(1).values.slice(1);
    const rows = [];
    ws.eachRow((row, n) => {
      if (n > 1)
        rows.push(Object.fromEntries(headers.map((h, i) => [h, row.values[i + 1] ?? null])));
    });
    return { ws, headers, rows };
  };
  return { consultants: read("Consultants to price"), others: read("Other active staff") };
}

const counts = () =>
  one(
    `SELECT (SELECT COUNT(*) FROM doctors)::int AS doctors,
            (SELECT COUNT(*) FROM appointments)::int AS appts`,
  );

test.describe("P0-04 export the consultant list", () => {
  test.beforeAll(async () => {
    for (const d of EXTRA) {
      await query(
        `INSERT INTO doctors (id, name, short_name, role, pin, is_active) VALUES ($1, $2, $3, $4, '4321', $5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name,
                                        role = EXCLUDED.role, is_active = EXCLUDED.is_active`,
        [d.id, d.name, d.short ?? null, d.role, d.active],
      );
    }
    await query(`DELETE FROM appointments WHERE notes = $1`, [TAG]);
    await query(
      `INSERT INTO appointments (doctor_id, doctor_name, appointment_date, status, notes) VALUES
         ($1, 'x', CURRENT_DATE - 5, 'completed', $5),
         ($1, 'x', CURRENT_DATE - 10, 'cancelled', $5),
         ($1, 'x', CURRENT_DATE - 200, 'completed', $5),
         ($1, 'x', CURRENT_DATE + 7, 'scheduled', $5),
         ($1, 'x', CURRENT_DATE + 90, 'scheduled', $5),
         (NULL, $2, CURRENT_DATE - 1, 'completed', $5),
         (NULL, $3, CURRENT_DATE - 2, 'completed', $5),
         (NULL, 'Dr Nobody Known', CURRENT_DATE - 2, 'completed', $5),
         ($4, 'x', CURRENT_DATE - 3, 'completed', $5)`,
      [
        CONSULTANTS.banshali.id,
        CONSULTANTS.rahul.name.toUpperCase(),
        "E2E Beant",
        USERS.admin.id,
        TAG,
      ],
    );
  });

  test.afterAll(async () => {
    await query(`DELETE FROM appointments WHERE notes = $1`, [TAG]);
    await query(`DELETE FROM doctors WHERE id = ANY($1)`, [EXTRA.map((d) => d.id)]);
  });

  test("the script lists every active consultant twice and the other staff separately, read-only", async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-docs-")), "doctors.xlsx");
    const before = await counts();
    const result = spawnSync(process.execPath, [SCRIPT, out], {
      cwd: path.join(repoRoot, "server"),
      env: buildTestEnv(),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("read-only");
    expect(result.stdout).toContain("localhost:5435/gini_scribe_test");
    expect(result.stdout).toContain("matched nobody (last 90 days): 1 across 1 names");
    expect(await counts()).toEqual(before);

    const { consultants, others } = await readSheets(out);
    expect(consultants.headers).toEqual(CONSULTANT_COLUMNS.map((c) => c.header));
    expect(consultants.headers.slice(0, 2)).toEqual(["doctor", "visit_type"]);
    expect(others.headers).toEqual(OTHER_STAFF_COLUMNS.map((c) => c.header));
    expect(others.headers).not.toContain("lab_only");
    expect(consultants.ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });

    for (const doctor of Object.values(CONSULTANTS)) {
      const rows = consultants.rows.filter((r) => r.doctor_id === doctor.id);
      expect(
        rows.map((r) => r.visit_type),
        doctor.name,
      ).toEqual(["New", "Follow Up"]);
      expect(rows.every((r) => r.doctor === doctor.name && r.general_fee === null)).toBe(true);
    }

    const ids = new Set(consultants.rows.map((r) => r.doctor_id));
    expect(ids.has(9151), "inactive consultant left out").toBe(false);
    expect(ids.has(9152), "lab-only provider left out").toBe(false);
    for (const user of Object.values(USERS)) expect(ids.has(user.id), user.role).toBe(false);
    expect(consultants.rows.length).toBe(ids.size * 2);

    const row = (id) => consultants.rows.find((r) => r.doctor_id === id);
    expect(row(CONSULTANTS.banshali.id)[PAST], "past, cancelled kept, 200 days ago left out").toBe(
      2,
    );
    expect(row(CONSULTANTS.banshali.id)[NEXT], "7 days ahead counted, 90 ahead left out").toBe(1);
    expect(row(CONSULTANTS.rahul.id)[PAST], "matched by exact name").toBe(1);
    expect(row(CONSULTANTS.rahul.id).note).toContain("Name shared with another doctor");
    expect(row(CONSULTANTS.beant.id)[PAST], "matched by name without Dr prefix").toBe(1);
    expect(row(CONSULTANTS.beant.id).note).not.toContain("No appointments");
    expect(row(CONSULTANTS.beant.id).note).not.toContain("Name shared");

    expect(row(9154).note).toContain(
      "Possibly the same person as Dr. E2E Mehtab Sing (id 9155, consultant)",
    );
    expect(row(9155).note).toContain(
      "Possibly the same person as Dr. E2E Mehtab Singh (id 9154, consultant)",
    );
    expect(row(9154).note).toContain(
      `No appointments in the last ${RECENT_DAYS} or next ${UPCOMING_DAYS} days`,
    );

    const staff = Object.fromEntries(others.rows.map((r) => [r.doctor_id, r]));
    expect(staff[9152].note).toContain("Lab-only provider");
    expect(staff[USERS.admin.id].note).toContain("Has appointments");
    expect(staff[USERS.admin.id][PAST]).toBe(1);
    expect(staff[USERS.reception.id].note).toBe("");
    expect(staff[9151]).toBeUndefined();
  });

  test("the export runs inside a read-only transaction and only reads", async () => {
    const real = getPool();
    const seen = [];
    const spyPool = {
      connect: async () => {
        const client = await real.connect();
        return {
          query: (text, params) => {
            seen.push(String(text).trim());
            return client.query(text, params);
          },
          release: () => client.release(),
        };
      },
    };
    const list = await collectConsultantList(spyPool);
    expect(list.consultants.length).toBeGreaterThan(0);
    expect(seen[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(seen[seen.length - 1]).toBe("COMMIT");
    for (const text of seen.slice(1, -1)) expect(text).toMatch(/^SELECT\b/i);
  });

  test("a HealthRay name is matched the way the sync matches it, and only when one doctor fits", () => {
    const doctors = [
      { id: 1, name: "Dr. Anil Bhansali", short_name: "Dr. Bhansali" },
      { id: 2, name: "Dr. Simranpreet Kaur", short_name: null },
      { id: 3, name: "Dr. Iqbal Singh", short_name: null },
      { id: 4, name: "Dr. Iqbal Khan", short_name: null },
    ];
    const ids = (name) => matchDoctorByName(doctors, name).map((d) => d.id);
    expect(ids("dr. anil bhansali")).toEqual([1]);
    expect(ids("Dr Anil Bhansali")).toEqual([1]);
    expect(ids("Dr Bhansali")).toEqual([1]);
    expect(ids("Dr Simran")).toEqual([2]);
    expect(ids("Dr. Iqbal")).toEqual([]);
    expect(ids("")).toEqual([]);
  });

  test("possible duplicates: typo or short name, not a longer different name", () => {
    const { consultants, others } = buildConsultantList({
      doctors: [
        { id: 3, name: "Dr. Rahul Katya", short_name: "Dr. Rahul", role: "consultant" },
        { id: 44, name: "Dr. Rahul Katyal", short_name: null, role: "consultant" },
        { id: 51, name: "Dr. Beant Kaur", short_name: "Dr. Beant", role: "mo" },
        { id: 5, name: "Dr. Beant Sidhu", short_name: "Dr. Beant Kaur", role: "consultant" },
        { id: 7, name: "Dr. Raj", short_name: null, role: "consultant" },
        { id: 8, name: "Dr. Rajesh Kumar", short_name: null, role: "consultant" },
      ],
      byId: [],
      byName: [],
    });
    const note = (id) => consultants.find((r) => r.doctor_id === id)?.note ?? "";
    expect(note(3)).toContain("Dr. Rahul Katyal (id 44, consultant)");
    expect(note(44)).toContain("Dr. Rahul Katya (id 3, consultant)");
    expect(note(5)).toContain("Dr. Beant Kaur (id 51, mo)");
    expect(others.find((r) => r.doctor_id === 51).note).toContain(
      "Dr. Beant Sidhu (id 5, consultant)",
    );
    expect(note(7)).not.toContain("Possibly the same person");
    const staff = buildConsultantList({
      doctors: [
        { id: 10, name: "Lab", short_name: null, role: "lab" },
        { id: 11, name: "Lab Admin", short_name: null, role: "lab_admin" },
      ],
      byId: [],
      byName: [],
    }).others;
    expect(staff.map((r) => r.note)).toEqual(["", ""]);
    expect(note(8)).not.toContain("Possibly the same person");
  });

  test("a chief consultant is marked and sorting keeps New before Follow Up", () => {
    const { consultants, others } = buildConsultantList({
      doctors: [
        { id: 2, name: "Dr Zed", role: "consultant", is_chief: true },
        { id: 1, name: "Dr Amar", role: "consultant", is_chief: false },
        { id: 3, name: "Nurse Kaur", role: "nurse", is_chief: false },
      ],
      byId: [{ doctor_id: 2, past: 4, upcoming: 1 }],
      byName: [],
    });
    expect(consultants.map((r) => [r.doctor, r.visit_type, r.chief])).toEqual([
      ["Dr Amar", "New", "no"],
      ["Dr Amar", "Follow Up", "no"],
      ["Dr Zed", "New", "yes"],
      ["Dr Zed", "Follow Up", "yes"],
    ]);
    expect(consultants[2]).toMatchObject({ past: 4, upcoming: 1 });
    expect(others).toEqual([
      {
        doctor_id: 3,
        name: "Nurse Kaur",
        role: "nurse",
        past: 0,
        upcoming: 0,
        lab_only: false,
        note: "",
      },
    ]);
  });
});
