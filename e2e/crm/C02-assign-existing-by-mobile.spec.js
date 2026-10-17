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
import { one, query } from "../helpers/db.mjs";

test.describe("CRM import: existing doctors are assigned, not skipped", () => {
  let staff;
  let doctors;
  let result;

  test.beforeAll(async () => {
    const seeded = await seedCrmStaff();
    staff = seeded.users;
    doctors = await seedDoctors(seeded.hospitalId, [
      {
        full_name: "Dr Owned By Rajesh",
        mobile: "9811000001",
        territory: "Mohali",
        owner: staff.rajesh.crmId,
      },
      { full_name: "Dr Unowned", mobile: "9811000002", territory: "Mohali" },
      {
        full_name: "Dr Already Sandeep",
        mobile: "9811000003",
        territory: "Mohali",
        owner: staff.sandeep.crmId,
      },
    ]);
    const api = await crmApi(staff.virender);
    result = await importAll(api, [
      { "Full name": "Dr Owned By Rajesh", Mobile: "9811000001", "Assigned to": "Sandeep Sangroy" },
      { "Full name": "Dr Unowned", Mobile: "98110 00002", "Assigned to": "Virender" },
      { "Full name": "Dr Already Sandeep", Mobile: "9811000003", "Assigned to": "Sandeep Sangroy" },
      {
        "Full name": "Dr Brand New",
        Mobile: "9811000004",
        Area: "Mohali",
        "Assigned to": "Rajesh Sharma",
      },
    ]);
    result.rows = await rowsOf(api, result.id);
  });

  test.afterAll(resetCrm);

  test("1. preview classifies each row", async () => {
    const outcome = Object.fromEntries(result.rows.map((r) => [r.values.full_name, r.outcome]));
    expect(outcome).toEqual({
      "Dr Owned By Rajesh": "assign",
      "Dr Unowned": "assign",
      "Dr Already Sandeep": "unchanged",
      "Dr Brand New": "create",
    });
    expect(result.resolved.counts.failed).toBe(0);
  });

  test("2. owners after the import", async () => {
    expect(await openOwner(doctors[0].id)).toBe("Sandeep Sangroy");
    expect(await openOwner(doctors[1].id)).toBe("Virender Satija");
    expect(await openOwner(doctors[2].id)).toBe("Sandeep Sangroy");
    const created = await one(`SELECT id FROM crm.doctors WHERE full_name = 'Dr Brand New'`);
    expect(await openOwner(created.id)).toBe("Rajesh Sharma");
  });

  test("3. the old owner's assignment is closed, not deleted, and reasons name the file", async () => {
    const history = (
      await query(
        `SELECT executive_id, effective_to IS NULL AS open, reason, assigned_by
           FROM crm.doctor_assignments WHERE doctor_id = $1 ORDER BY effective_from`,
        [doctors[0].id],
      )
    ).rows;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ executive_id: staff.rajesh.crmId, open: false });
    expect(history[1]).toMatchObject({ executive_id: staff.sandeep.crmId, open: true });
    expect(history[1].reason).toBe("Import assign.xlsx, row 2");
    expect(history[1].assigned_by).toBe(staff.virender.crmId);
  });

  test("4. an unchanged owner writes no new assignment", async () => {
    const { n } = await one(
      `SELECT count(*)::int AS n FROM crm.doctor_assignments WHERE doctor_id = $1`,
      [doctors[2].id],
    );
    expect(n).toBe(1);
  });

  test("5. assignment changes are in the audit log", async () => {
    const { n } = await one(
      `SELECT count(*)::int AS n FROM crm.audit_log
        WHERE table_name = 'doctor_assignments' AND record_id IN
          (SELECT id::text FROM crm.doctor_assignments WHERE doctor_id = $1)`,
      [doctors[0].id],
    );
    expect(n).toBeGreaterThanOrEqual(2);
  });

  test("6. summary counts per staff member and the batch is completed", async () => {
    const s = result.summary;
    expect(s.counts).toMatchObject({ pending: 0, created: 1, assigned: 3 });
    const per = Object.fromEntries(s.by_assignee.map((a) => [a.full_name, a.assigned]));
    expect(per).toEqual({ "Rajesh Sharma": 1, "Sandeep Sangroy": 1, "Virender Satija": 1 });
    expect(s.batch.status).toBe("completed");
  });
});
