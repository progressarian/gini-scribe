import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, stageImport, resetCrm } from "../helpers/crm.mjs";
import { one } from "../helpers/db.mjs";

const EXISTING = 180;
const NEW = 70;

test.describe("CRM import: commit runs in 100-row chunks and resumes", () => {
  let api;
  let batchId;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const seeded = await seedCrmStaff();
    await seedDoctors(
      seeded.hospitalId,
      Array.from({ length: EXISTING }, (_, i) => ({
        full_name: `Dr Bulk ${i}`,
        mobile: `98880${String(i).padStart(5, "0")}`,
        territory: "Mohali",
      })),
    );
    api = await crmApi(seeded.users.virender);
    const names = ["Virender Satija", "Rajesh Sharma", "Sandeep Sangroy"];
    const rows = [
      ...Array.from({ length: EXISTING }, (_, i) => ({
        "Full name": `Dr Bulk ${i}`,
        Mobile: `98880${String(i).padStart(5, "0")}`,
        "Assigned to": names[i % 3],
      })),
      ...Array.from({ length: NEW }, (_, i) => ({
        "Full name": `Dr Fresh ${i}`,
        Mobile: `98890${String(i).padStart(5, "0")}`,
        Area: "Mohali",
        "Assigned to": names[i % 3],
      })),
    ];
    batchId = (await stageImport(api, rows, "bulk.xlsx")).body.batchId;
    await api.post(`/api/crm/import/batches/${batchId}/resolve`);
  });

  test.afterAll(resetCrm);

  test("1. the first call writes exactly one chunk and stops", async () => {
    const res = await api.post(`/api/crm/import/batches/${batchId}/commit`, { data: {} });
    const s = await res.json();
    expect(s.counts.pending).toBe(EXISTING + NEW - 100);
    expect(s.counts.assigned).toBe(100);
    expect(s.batch.status).toBe("importing");
  });

  test("2. later calls continue from where it stopped and finish", async () => {
    let s;
    for (let i = 0; i < 5; i++) {
      s = await (await api.post(`/api/crm/import/batches/${batchId}/commit`, { data: {} })).json();
      if (s.counts.pending === 0) break;
    }
    expect(s.counts).toMatchObject({ pending: 0, created: NEW, assigned: EXISTING + NEW });
    expect(s.batch.status).toBe("completed");
  });

  test("3. running it again writes nothing more", async () => {
    await api.post(`/api/crm/import/batches/${batchId}/commit`, { data: {} });
    const doctors = await one(`SELECT count(*)::int AS n FROM crm.doctors`);
    expect(doctors.n).toBe(EXISTING + NEW);
    const open = await one(
      `SELECT count(*)::int AS n, count(DISTINCT doctor_id)::int AS d
         FROM crm.doctor_assignments WHERE effective_to IS NULL`,
    );
    expect(open).toEqual({ n: EXISTING + NEW, d: EXISTING + NEW });
  });
});
