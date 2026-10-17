import { test, expect } from "@playwright/test";
import {
  seedCrmStaff,
  seedDoctors,
  crmApi,
  readXlsx,
  importAll,
  openOwner,
  resetCrm,
} from "../helpers/crm.mjs";

test.describe("CRM import: doctors template round-trip", () => {
  let api;
  let doctors;
  let template;

  test.beforeAll(async () => {
    const seeded = await seedCrmStaff();
    const { users } = seeded;
    doctors = await seedDoctors(seeded.hospitalId, [
      { full_name: "Dr Same Name", territory: "Mohali", area: "Mohali", owner: users.rajesh.crmId },
      { full_name: "Dr Same Name", territory: "Mohali", area: "Mohali" },
      {
        full_name: "Dr Keep",
        mobile: "9866000001",
        territory: "Kharar",
        owner: users.sandeep.crmId,
      },
    ]);
    api = await crmApi(users.virender);
    const res = await api.get("/api/crm/import/template.xlsx");
    expect(res.status()).toBe(200);
    template = await readXlsx(await res.body());
  });

  test.afterAll(resetCrm);

  test("1. the template lists every doctor with ID and current owner, and a staff dropdown", async () => {
    expect(template.headers).toEqual([
      "Doctor ID",
      "Full name",
      "Specialty",
      "Mobile",
      "Area",
      "Territory",
      "Priority",
      "Assigned to",
    ]);
    expect(template.rows).toHaveLength(3);
    const byId = Object.fromEntries(template.rows.map((r) => [r["Doctor ID"], r]));
    expect(byId[doctors[0].id]["Assigned to"]).toBe("Rajesh Sharma");
    expect(byId[doctors[1].id]["Assigned to"]).toBe("");
    expect(template.sheet.getColumn(1).hidden).toBe(true);
    const validation = template.sheet.getRow(2).getCell(8).dataValidation;
    expect(validation.type).toBe("list");
    const staffSheet = template.book.getWorksheet("Staff");
    const names = [];
    staffSheet.eachRow((row) => names.push(row.getCell(1).value));
    expect(names).toEqual([
      "E2E Growth Manager",
      "Rajesh Sharma",
      "Sandeep Sangroy",
      "Virender Satija",
    ]);
  });

  test("2. re-uploading it with edits reassigns only what changed, even same-name doctors", async () => {
    const edited = template.rows.map((r) => {
      if (r["Doctor ID"] === doctors[1].id) return { ...r, "Assigned to": "Virender Satija" };
      return r;
    });
    const { resolved, summary } = await importAll(api, edited, "template.xlsx");
    expect(resolved.counts).toMatchObject({ failed: 0, new: 0, unchanged: 2, assign: 1 });
    expect(summary.counts.assigned).toBe(1);
    expect(await openOwner(doctors[0].id)).toBe("Rajesh Sharma");
    expect(await openOwner(doctors[1].id)).toBe("Virender Satija");
    expect(await openOwner(doctors[2].id)).toBe("Sandeep Sangroy");
  });
});
