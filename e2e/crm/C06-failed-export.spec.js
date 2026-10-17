import { test, expect } from "@playwright/test";
import { seedCrmStaff, crmApi, importAll, readXlsx, resetCrm } from "../helpers/crm.mjs";

test.describe("CRM import: export of failed rows", () => {
  let api;
  let batchId;

  test.beforeAll(async () => {
    const { users } = await seedCrmStaff();
    api = await crmApi(users.virender);
    batchId = (
      await importAll(
        api,
        [
          { "Full name": "Dr Ok", Mobile: "9855000001", Notes: "keep", "Assigned to": "Rajesh" },
          { "Full name": "Dr Typo", Mobile: "9855000002", Notes: "A, B", "Assigned to": "Ramesh" },
          { "Full name": "", Mobile: "9855000003", Notes: "no name", "Assigned to": "Rajesh" },
        ],
        "field list.xlsx",
      )
    ).id;
  });

  test.afterAll(resetCrm);

  test("1. the file keeps the original columns and adds Reason and Suggested staff", async () => {
    const res = await api.get(`/api/crm/import/batches/${batchId}/failed.xlsx`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toContain("field list-failed-rows.xlsx");
    const { headers, rows } = await readXlsx(await res.body());
    expect(headers).toEqual([
      "Full name",
      "Mobile",
      "Notes",
      "Assigned to",
      "Reason",
      "Suggested staff",
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      "Full name": "Dr Typo",
      Mobile: "9855000002",
      Notes: "A, B",
      "Assigned to": "Ramesh",
      Reason: "No staff named Ramesh",
      "Suggested staff": "Rajesh Sharma",
    });
    expect(rows[1].Reason).toBe("Doctor name is required");
  });
});
