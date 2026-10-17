import { test, expect } from "@playwright/test";
import { seedCrmStaff, crmApi, stageImport, resetCrm } from "../helpers/crm.mjs";

test.describe("CRM import: Assigned to and Doctor ID columns", () => {
  let staff;

  test.beforeAll(async () => {
    staff = (await seedCrmStaff()).users;
  });

  test.afterAll(resetCrm);

  test("1. both columns auto-map from their usual headers", async () => {
    const api = await crmApi(staff.virender);
    const { mapping } = await stageImport(api, [
      {
        "Doctor ID": "",
        "Full name": "Dr A",
        Mobile: "9800000001",
        "Assigned to": "Rajesh Sharma",
      },
    ]);
    expect(mapping["Doctor ID"]).toBe("doctor_id");
    expect(mapping["Assigned to"]).toBe("assigned_to");
    expect(mapping["Full name"]).toBe("full_name");
  });

  test("2. the field list offers both", async () => {
    const api = await crmApi(staff.virender);
    const fields = await (await api.get("/api/crm/import/fields")).json();
    expect(fields.map((f) => f.key)).toEqual(expect.arrayContaining(["doctor_id", "assigned_to"]));
  });
});
