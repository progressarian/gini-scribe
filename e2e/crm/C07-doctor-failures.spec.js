import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, importAll, rowsOf, resetCrm } from "../helpers/crm.mjs";

test.describe("CRM import: rows that fail on the doctor, not the staff name", () => {
  let byRow;
  let api;
  let batchId;

  test.beforeAll(async () => {
    const { users, hospitalId } = await seedCrmStaff();
    const seeded = await seedDoctors(hospitalId, [
      { full_name: "Dr R Singh", area: "Mohali", territory: "Mohali" },
      { full_name: "Dr R Singh", area: "Mohali", territory: "Mohali" },
      { full_name: "Dr Twice", mobile: "9833000001", territory: "Mohali" },
    ]);
    api = await crmApi(users.virender);
    const result = await importAll(api, [
      { "Doctor ID": "", "Full name": "Dr R Singh", Area: "Mohali", "Assigned to": "Rajesh" },
      {
        "Doctor ID": "00000000-0000-0000-0000-000000000000",
        "Full name": "Dr Gone",
        "Assigned to": "Rajesh",
      },
      { "Doctor ID": seeded[2].id, "Full name": "Dr Twice", "Assigned to": "Rajesh" },
      { "Doctor ID": "", "Full name": "Dr Twice", Mobile: "9833000001", "Assigned to": "Virender" },
    ]);
    batchId = result.id;
    byRow = Object.fromEntries((await rowsOf(api, batchId)).map((r) => [r.row_number, r]));
  });

  test.afterAll(resetCrm);

  test("1. ambiguous name, unknown ID and a repeated doctor each fail with a reason", async () => {
    expect(byRow[2].fail_reason).toBe(
      "2 doctors named Dr R Singh in Mohali — add the mobile or Doctor ID",
    );
    expect(byRow[3].fail_reason).toBe("Doctor ID not found — it may have been removed");
    expect(byRow[4].outcome).toBe("assign");
    expect(byRow[5].fail_reason).toBe("Same doctor as row 4");
    for (const n of [2, 3, 5]) expect(byRow[n].doctor_match).toBeNull();
  });

  test("2. doctor-level failures cannot be fixed by picking a staff member", async () => {
    const staff = await (await api.get("/api/crm/import/assignees")).json();
    const rajesh = staff.find((s) => s.full_name === "Rajesh Sharma");
    const res = await api.post(`/api/crm/import/batches/${batchId}/retry`, {
      data: { rows: [{ row_number: 2, assignee_id: rajesh.id }] },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe("Those rows can no longer be retried — refresh the list");
  });

  test("3. no doctors were created for failed rows", async () => {
    const res = await api.get(`/api/crm/import/batches/${batchId}/summary`);
    const { counts } = await res.json();
    expect(counts.created).toBe(0);
    expect(counts.failed).toBe(3);
  });
});
