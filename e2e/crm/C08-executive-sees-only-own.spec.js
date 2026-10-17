import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, importAll, resetCrm } from "../helpers/crm.mjs";

test.describe("CRM import: after assignment each executive sees only their doctors", () => {
  let users;

  test.beforeAll(async () => {
    const seeded = await seedCrmStaff();
    users = seeded.users;
    await seedDoctors(seeded.hospitalId, [
      { full_name: "Dr For Rajesh", mobile: "9899000001", territory: "Mohali" },
      { full_name: "Dr For Sandeep", mobile: "9899000002", territory: "Mohali" },
      { full_name: "Dr For Virender", mobile: "9899000003", territory: "Mohali" },
    ]);
    await importAll(await crmApi(users.virender), [
      { "Full name": "Dr For Rajesh", Mobile: "9899000001", "Assigned to": "Rajesh Sharma" },
      { "Full name": "Dr For Sandeep", Mobile: "9899000002", "Assigned to": "Sandeep Sangroy" },
      { "Full name": "Dr For Virender", Mobile: "9899000003", "Assigned to": "Virender Satija" },
    ]);
  });

  test.afterAll(resetCrm);

  const homeNames = async (who) => {
    const res = await (await crmApi(users[who])).get("/api/crm/home");
    expect(res.status()).toBe(200);
    return (await res.json()).my_doctors.map((d) => d.full_name).sort();
  };

  test("1. Rajesh sees only his doctor", async () => {
    expect(await homeNames("rajesh")).toEqual(["Dr For Rajesh"]);
  });

  test("2. Sandeep Sangroy sees only his doctor", async () => {
    expect(await homeNames("sandeep")).toEqual(["Dr For Sandeep"]);
  });

  test("3. Virender (head of growth) sees every doctor", async () => {
    expect(await homeNames("virender")).toEqual([
      "Dr For Rajesh",
      "Dr For Sandeep",
      "Dr For Virender",
    ]);
  });
});
