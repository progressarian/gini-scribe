import { test, expect } from "@playwright/test";
import { seedCrmStaff, crmApi, stageImport, rowsOf, resetCrm } from "../helpers/crm.mjs";

test.describe("CRM import: typed staff names", () => {
  let rows;
  let assignees;

  test.beforeAll(async () => {
    const { users } = await seedCrmStaff();
    const api = await crmApi(users.virender);
    const typed = [
      "Rajesh Sharma",
      "Sandeep",
      "Sandeep Sangory",
      "virender",
      "Ramesh",
      "Gurjot",
      "E2E Growth Manager",
    ];
    const { body } = await stageImport(
      api,
      typed.map((name, i) => ({
        "Full name": `Dr Name Rule ${i}`,
        Mobile: `98220000${String(i).padStart(2, "0")}`,
        "Assigned to": name,
      })),
    );
    await api.post(`/api/crm/import/batches/${body.batchId}/resolve`);
    rows = Object.fromEntries((await rowsOf(api, body.batchId)).map((r) => [r.assignee_typed, r]));
    assignees = await (await api.get("/api/crm/import/assignees")).json();
  });

  test.afterAll(resetCrm);

  test("1. exact, first-name and near-miss surname match", async () => {
    expect(rows["Rajesh Sharma"].assignee.full_name).toBe("Rajesh Sharma");
    expect(rows["Sandeep"].assignee.full_name).toBe("Sandeep Sangroy");
    expect(rows["Sandeep"].assignee_note).toBe("Matched by first name");
    expect(rows["Sandeep Sangory"].assignee.full_name).toBe("Sandeep Sangroy");
    expect(rows["Sandeep Sangory"].assignee_note).toBe("Check spelling");
    expect(rows["virender"].assignee.full_name).toBe("Virender Satija");
  });

  test("2. a misspelt first name fails with a suggestion", async () => {
    const r = rows["Ramesh"];
    expect(r.outcome).toBe("failed");
    expect(r.assign_status).toBe("failed");
    expect(r.fail_reason).toBe("No staff named Ramesh");
    expect(r.suggestion.full_name).toBe("Rajesh Sharma");
  });

  test("3. a growth manager is assignable; the CEO is never offered", async () => {
    expect(rows["E2E Growth Manager"].assignee.full_name).toBe("E2E Growth Manager");
    expect(assignees.map((a) => a.full_name)).not.toContain("Sandeep");
    expect(assignees.map((a) => a.full_name)).toContain("Sandeep Sangroy");
  });

  test("4. someone who is not a CRM user fails plainly", async () => {
    expect(rows["Gurjot"].outcome).toBe("failed");
    expect(rows["Gurjot"].fail_reason).toBe("No staff named Gurjot");
  });
});
