import { request } from "@playwright/test";
import ExcelJS from "exceljs";
import { PIN } from "../fixtures/data.mjs";
import { API_URL } from "../setup/testEnv.mjs";
import { one, query } from "./db.mjs";

export const CRM_STAFF = {
  virender: {
    id: 9301,
    name: "Virender Satija",
    scribeRole: "head_of_growth",
    crmRole: "head_of_growth",
  },
  rajesh: {
    id: 9302,
    name: "Rajesh Sharma",
    scribeRole: "growth_executive",
    crmRole: "growth_executive",
  },
  sandeep: {
    id: 9303,
    name: "Sandeep Sangroy",
    scribeRole: "growth_executive",
    crmRole: "growth_executive",
  },
  ceo: { id: 9304, name: "Sandeep", scribeRole: "admin", crmRole: "ceo_admin" },
  manager: {
    id: 9305,
    name: "E2E Growth Manager",
    scribeRole: "growth_manager",
    crmRole: "growth_manager",
  },
};

export async function resetCrm() {
  await query(
    `TRUNCATE crm.import_rows, crm.import_batches, crm.doctor_assignments, crm.doctor_stage_history,
              crm.doctors, crm.user_hospitals, crm.users CASCADE`,
  );
}

export async function seedCrmStaff() {
  await resetCrm();
  const { pin } = await one(`SELECT pin FROM doctors WHERE id = 9001`);
  const hospital = await one(`SELECT id FROM crm.hospitals WHERE code = 'GACH'`);
  const users = {};
  for (const [key, s] of Object.entries(CRM_STAFF)) {
    await query(
      `INSERT INTO doctors (id, name, short_name, role, pin, is_active)
       VALUES ($1, $2, $2, $3, $4, true)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, short_name = EXCLUDED.name, role = EXCLUDED.role,
             pin = EXCLUDED.pin, is_active = true`,
      [s.id, s.name, s.scribeRole, pin],
    );
    const user = await one(
      `INSERT INTO crm.users (full_name, role, scribe_doctor_id, is_active)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [s.name, s.crmRole, s.id],
    );
    await query(`INSERT INTO crm.user_hospitals (user_id, hospital_id) VALUES ($1, $2)`, [
      user.id,
      hospital.id,
    ]);
    users[key] = { ...s, crmId: user.id };
  }
  return { users, hospitalId: hospital.id };
}

export async function seedDoctors(hospitalId, doctors) {
  const territories = (await query(`SELECT id, name FROM crm.territories`)).rows;
  const territoryId = (name) => territories.find((t) => t.name === name)?.id ?? null;
  const out = [];
  for (const d of doctors) {
    const row = await one(
      `INSERT INTO crm.doctors (hospital_id, full_name, mobile, area, territory_id, specialty)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, full_name`,
      [
        hospitalId,
        d.full_name,
        d.mobile ?? null,
        d.area ?? null,
        territoryId(d.territory),
        d.specialty ?? null,
      ],
    );
    if (d.owner) {
      await query(
        `INSERT INTO crm.doctor_assignments (hospital_id, doctor_id, executive_id, effective_from)
         VALUES ($1, $2, $3, now() - interval '1 day')`,
        [hospitalId, row.id, d.owner],
      );
    }
    out.push(row);
  }
  return out;
}

export async function crmApi(staff) {
  const context = await request.newContext({ baseURL: API_URL });
  const res = await context.post("/api/auth/login", { data: { doctor_id: staff.id, pin: PIN } });
  const body = await res.json();
  await context.dispose();
  if (!res.ok()) throw new Error(`Login as ${staff.name} failed: ${res.status()} ${body.error}`);
  const api = await request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}` },
  });
  api.tokens = { access: body.access_token, refresh: body.refresh_token };
  return api;
}

export async function loginCrm(page, api) {
  await page.addInitScript(
    ([token, refreshToken]) => {
      window.localStorage.setItem("gini_auth_token", token);
      window.localStorage.setItem("gini_refresh_token", refreshToken);
    },
    [api.tokens.access, api.tokens.refresh],
  );
}

export async function xlsxBuffer(rows) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Doctors");
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  sheet.addRow(headers);
  rows.forEach((r) => sheet.addRow(headers.map((h) => r[h] ?? "")));
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function readXlsx(buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const sheet = book.worksheets[0];
  const headers = sheet.getRow(1).values.slice(1);
  const rows = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const values = row.values.slice(1);
    rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""])));
  });
  return { headers, rows, sheet, book };
}

export async function stageImport(api, rows, fileName = "assign.xlsx") {
  const buffer = await xlsxBuffer(rows);
  const parsed = await api.post(`/api/crm/import/parse?name=${fileName}&full=1`, {
    data: buffer,
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!parsed.ok()) throw new Error(`parse failed: ${parsed.status()} ${await parsed.text()}`);
  const p = await parsed.json();
  const batch = await api.post(`/api/crm/import/batches`, {
    data: { file_name: fileName, headers: p.headers, rows: p.rows, mapping: p.suggested_mapping },
  });
  return { res: batch, mapping: p.suggested_mapping, body: batch.ok() ? await batch.json() : null };
}

export async function importAll(api, rows, fileName) {
  const staged = await stageImport(api, rows, fileName);
  if (!staged.res.ok())
    throw new Error(`batch failed: ${staged.res.status()} ${await staged.res.text()}`);
  const id = staged.body.batchId;
  const resolved = await (await api.post(`/api/crm/import/batches/${id}/resolve`)).json();
  let summary = resolved;
  for (let i = 0; i < 50; i++) {
    const res = await api.post(`/api/crm/import/batches/${id}/commit`, { data: {} });
    if (!res.ok()) throw new Error(`commit failed: ${res.status()} ${await res.text()}`);
    summary = await res.json();
    if (summary.counts.pending === 0) break;
  }
  return { id, resolved, summary };
}

export async function rowsOf(api, id, status = "all") {
  const all = [];
  for (let page = 1; page < 100; page++) {
    const res = await api.get(`/api/crm/import/batches/${id}/rows?status=${status}&page=${page}`);
    const body = await res.json();
    all.push(...body.rows);
    if (page >= body.pages) break;
  }
  return all;
}

export async function openOwner(doctorId) {
  const row = await one(
    `SELECT u.full_name FROM crm.doctor_assignments a JOIN crm.users u ON u.id = a.executive_id
      WHERE a.doctor_id = $1 AND a.effective_to IS NULL`,
    [doctorId],
  );
  return row?.full_name ?? null;
}
