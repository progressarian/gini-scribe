import { test, expect } from "@playwright/test";
import {
  seedCrmStaff,
  seedDoctors,
  crmApi,
  importAll,
  rowsOf,
  openOwner,
  resetCrm,
} from "../helpers/crm.mjs";
import { one } from "../helpers/db.mjs";

test.describe("CRM import: fixing failed staff names after the import", () => {
  let api;
  let batchId;
  let doctors;
  let staff;

  test.beforeAll(async () => {
    const seeded = await seedCrmStaff();
    doctors = await seedDoctors(seeded.hospitalId, [
      { full_name: "Dr Retry Existing", mobile: "9844000001", territory: "Mohali" },
    ]);
    api = await crmApi(seeded.users.virender);
    staff = await (await api.get("/api/crm/import/assignees")).json();
    batchId = (
      await importAll(api, [
        { "Full name": "Dr Retry Existing", Mobile: "9844000001", "Assigned to": "Ramesh" },
        {
          "Full name": "Dr Retry New",
          Mobile: "9844000002",
          Area: "Mohali",
          "Assigned to": "Nobody",
        },
        { "Full name": "Dr Fine", Mobile: "9844000003", "Assigned to": "Rajesh Sharma" },
      ])
    ).id;
  });

  test.afterAll(resetCrm);

  test("1. failed rows are listed with their typed name, reason and suggestion", async () => {
    const failed = await rowsOf(api, batchId, "failed");
    expect(failed.map((r) => r.row_number)).toEqual([2, 3]);
    expect(failed[0]).toMatchObject({
      assignee_typed: "Ramesh",
      fail_reason: "No staff named Ramesh",
      row_status: "error",
    });
    expect(failed[0].suggestion.full_name).toBe("Rajesh Sharma");
    expect(failed[1].suggestion).toBeNull();
    expect(await one(`SELECT 1 FROM crm.doctors WHERE full_name = 'Dr Retry New'`)).toBeNull();
  });

  test("2. retry with the chosen staff assigns the existing doctor and creates the new one", async () => {
    const id = (name) => staff.find((s) => s.full_name === name).id;
    const res = await api.post(`/api/crm/import/batches/${batchId}/retry`, {
      data: {
        rows: [
          { row_number: 2, assignee_id: id("Rajesh Sharma") },
          { row_number: 3, assignee_id: id("Sandeep Sangroy") },
        ],
      },
    });
    expect(res.status()).toBe(200);
    const summary = await res.json();
    expect(summary.counts.failed).toBe(0);
    expect(await openOwner(doctors[0].id)).toBe("Rajesh Sharma");
    const created = await one(`SELECT id FROM crm.doctors WHERE full_name = 'Dr Retry New'`);
    expect(await openOwner(created.id)).toBe("Sandeep Sangroy");
    expect(await rowsOf(api, batchId, "failed")).toHaveLength(0);
  });

  test("3. a non-assignable person cannot be chosen", async () => {
    const ceo = await one(`SELECT id FROM crm.users WHERE full_name = 'Sandeep'`);
    const res = await api.post(`/api/crm/import/batches/${batchId}/retry`, {
      data: { rows: [{ row_number: 2, assignee_id: ceo.id }] },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe(
      "One of the chosen staff members cannot be assigned doctors",
    );
  });
});
