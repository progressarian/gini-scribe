import { test, expect } from "@playwright/test";
import { seedCrmStaff, crmApi, stageImport, xlsxBuffer, resetCrm } from "../helpers/crm.mjs";

const FAKE_BATCH = "00000000-0000-0000-0000-000000000000";

const ENDPOINTS = [
  ["get", "/api/crm/import/fields"],
  ["post", "/api/crm/import/parse?name=x.xlsx"],
  ["post", "/api/crm/import/batches"],
  ["get", "/api/crm/import/assignees"],
  ["get", "/api/crm/import/template.xlsx"],
  ["get", `/api/crm/import/batches/${FAKE_BATCH}/preview`],
  ["post", `/api/crm/import/batches/${FAKE_BATCH}/resolve`],
  ["get", `/api/crm/import/batches/${FAKE_BATCH}/summary`],
  ["get", `/api/crm/import/batches/${FAKE_BATCH}/rows`],
  ["post", `/api/crm/import/batches/${FAKE_BATCH}/commit`],
  ["post", `/api/crm/import/batches/${FAKE_BATCH}/pick`],
  ["post", `/api/crm/import/batches/${FAKE_BATCH}/retry`],
  ["get", `/api/crm/import/batches/${FAKE_BATCH}/failed.xlsx`],
];

test.describe("CRM import: only an admin or the head of growth can import", () => {
  let users;

  test.beforeAll(async () => {
    users = (await seedCrmStaff()).users;
  });

  test.afterAll(resetCrm);

  for (const who of ["manager", "rajesh"]) {
    test(`1. ${who} is refused on every import endpoint`, async () => {
      const api = await crmApi(users[who]);
      for (const [method, url] of ENDPOINTS) {
        const res = await api[method](url, method === "post" ? { data: {} } : undefined);
        expect(res.status(), `${method.toUpperCase()} ${url}`).toBe(403);
      }
    });
  }

  test("2. a growth manager cannot import even a plain doctor list", async () => {
    const api = await crmApi(users.manager);
    const res = await api.post("/api/crm/import/parse?name=plain.xlsx&full=1", {
      data: await xlsxBuffer([{ "Full name": "Dr Plain", Mobile: "9877000002" }]),
      headers: { "Content-Type": "application/octet-stream" },
    });
    expect(res.status()).toBe(403);
  });

  test("3. the CEO (ceo_admin) and the head of growth can", async () => {
    for (const who of ["ceo", "virender"]) {
      const api = await crmApi(users[who]);
      const { res } = await stageImport(api, [
        { "Full name": `Dr X ${who}`, Mobile: "9877000001", "Assigned to": "Rajesh" },
      ]);
      expect(res.status(), who).toBe(200);
    }
  });

  test("4. the growth executives' CRM home still works", async () => {
    const res = await (await crmApi(users.rajesh)).get("/api/crm/home");
    expect(res.status()).toBe(200);
  });
});
