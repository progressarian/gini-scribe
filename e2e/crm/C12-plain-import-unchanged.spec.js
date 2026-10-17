import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, importAll, rowsOf, resetCrm } from "../helpers/crm.mjs";
import { query } from "../helpers/db.mjs";

test.describe("CRM import: a plain doctor list behaves as before", () => {
  let rows;
  let summary;

  test.beforeAll(async () => {
    const { users, hospitalId } = await seedCrmStaff();
    await seedDoctors(hospitalId, [
      { full_name: "Dr Known Mobile", mobile: "9911000001", territory: "Mohali" },
      { full_name: "Dr Same Name", area: "Mohali", territory: "Mohali" },
    ]);
    const api = await crmApi(users.virender);
    const result = await importAll(api, [
      { "Doctor Name": "Dr Known Mobile", Mobile: "9911000001", Territory: "Mohali" },
      { "Doctor Name": "Dr Same Name", Territory: "Mohali" },
      { "Doctor Name": "Dr Clinic One", Mobile: "9911000009", Territory: "Mohali" },
      { "Doctor Name": "Dr Clinic Two", Mobile: "9911000009", Territory: "Mohali" },
      { "Doctor Name": "", Mobile: "9911000003", Territory: "Mohali" },
      { "Doctor Name": "Dr Fresh", Territory: "Kharar" },
    ]);
    rows = Object.fromEntries((await rowsOf(api, result.id)).map((r) => [r.row_number, r]));
    summary = result.summary;
  });

  test.afterAll(resetCrm);

  test("1. dedup outcomes are unchanged", async () => {
    expect(rows[2].outcome).toBe("duplicate");
    expect(rows[3].outcome).toBe("possible_duplicate");
    expect(rows[4].outcome).toBe("create");
    expect(rows[4].flags.join(" ")).toContain("recorded as a clinic line");
    expect(rows[5].outcome).toBe("create");
    expect(rows[6].outcome).toBe("error");
    expect(rows[6].fail_reason).toBe("Doctor name is required");
    expect(rows[7].flags).toContain("No mobile — imports as a skeleton record");
  });

  test("2. commit creates the new and possible-duplicate rows, skips the rest", async () => {
    expect(summary.counts.created).toBe(4);
    expect(summary.counts.assigned).toBe(0);
    const names = (
      await query(
        `SELECT full_name, clinic_phone, mobile FROM crm.doctors WHERE import_batch_id IS NOT NULL ORDER BY full_name`,
      )
    ).rows;
    expect(names.map((n) => n.full_name)).toEqual([
      "Dr Clinic One",
      "Dr Clinic Two",
      "Dr Fresh",
      "Dr Same Name",
    ]);
    expect(names[0]).toMatchObject({ clinic_phone: "9911000009", mobile: null });
    const { rows: assignments } = await query(`SELECT 1 FROM crm.doctor_assignments`);
    expect(assignments).toHaveLength(0);
  });
});
