import { test, expect } from "@playwright/test";
import {
  seedCrmStaff,
  seedDoctors,
  crmApi,
  loginCrm,
  readXlsx,
  openOwner,
  resetCrm,
} from "../helpers/crm.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one } from "../helpers/db.mjs";

test.describe("CRM home: Assignments tab", () => {
  let users;
  let api;
  let doctors;
  const list = async (params = {}) =>
    (await api.get(`/api/crm/assignments?${new URLSearchParams(params)}`)).json();

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const seeded = await seedCrmStaff();
    users = seeded.users;
    doctors = await seedDoctors(seeded.hospitalId, [
      {
        full_name: "Dr Asg Rajesh",
        mobile: "9933000001",
        territory: "Mohali",
        owner: users.rajesh.crmId,
      },
      {
        full_name: "Dr Asg Sandeep",
        mobile: "9933000002",
        territory: "Kharar",
        owner: users.sandeep.crmId,
      },
      ...Array.from({ length: 58 }, (_, i) => ({
        full_name: `Dr Asg Free ${String(i).padStart(2, "0")}`,
        mobile: `99331${String(i).padStart(5, "0")}`,
        territory: i % 2 ? "Mohali" : "Kharar",
      })),
    ]);
    api = await crmApi(users.virender);
  });

  test.afterAll(resetCrm);

  test("1. counts: unassigned and per owner", async () => {
    const body = await list({ owner: "all" });
    expect(body.counts).toMatchObject({ total: 60, unassigned: 58 });
    expect(Object.fromEntries(body.counts.by_owner.map((o) => [o.full_name, o.n]))).toEqual({
      "Rajesh Sharma": 1,
      "Sandeep Sangroy": 1,
    });
    expect(body.staff.map((s) => s.full_name)).not.toContain("Sandeep");
  });

  test("2. filters and paging run on the server", async () => {
    const unassigned = await list({ owner: "unassigned" });
    expect(unassigned).toMatchObject({ total: 58, pages: 2 });
    expect(unassigned.rows).toHaveLength(50);
    expect((await list({ owner: "unassigned", page: 2 })).rows).toHaveLength(8);
    const rajesh = await list({ owner: users.rajesh.crmId });
    expect(rajesh.rows.map((r) => r.full_name)).toEqual(["Dr Asg Rajesh"]);
    expect((await list({ owner: "all", territory: "Kharar" })).total).toBe(30);
    expect((await list({ owner: "all", q: "9933000002" })).rows[0].full_name).toBe(
      "Dr Asg Sandeep",
    );
  });

  test("3. assign one, reassign, remove — history kept and 'by' recorded", async () => {
    const id = doctors[2].id;
    let r = await api.post("/api/crm/assignments", {
      data: { doctor_ids: [id], executive_id: users.rajesh.crmId },
    });
    expect(await r.json()).toMatchObject({ changed: 1, unchanged: 0, owner: "Rajesh Sharma" });
    r = await api.post("/api/crm/assignments", {
      data: { doctor_ids: [id], executive_id: users.rajesh.crmId },
    });
    expect(await r.json()).toMatchObject({ changed: 0, unchanged: 1 });
    await api.post("/api/crm/assignments", {
      data: { doctor_ids: [id], executive_id: users.sandeep.crmId },
    });
    expect(await openOwner(id)).toBe("Sandeep Sangroy");
    await api.post("/api/crm/assignments", { data: { doctor_ids: [id], executive_id: null } });
    expect(await openOwner(id)).toBeNull();
    const history = await one(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE effective_to IS NULL)::int AS open,
              bool_and(assigned_by = $2) AS by_virender
         FROM crm.doctor_assignments WHERE doctor_id = $1`,
      [id, users.virender.crmId],
    );
    expect(history).toEqual({ n: 2, open: 0, by_virender: true });
    const row = (await list({ owner: "all", q: "Dr Asg Rajesh" })).rows[0];
    expect(row).toMatchObject({ owner: "Rajesh Sharma" });
  });

  test("4. bulk assign, the 100 limit, and bad input", async () => {
    const ids = doctors.slice(10, 20).map((d) => d.id);
    const r = await api.post("/api/crm/assignments", {
      data: { doctor_ids: ids, executive_id: users.virender.crmId },
    });
    expect((await r.json()).changed).toBe(10);
    const tooMany = await api.post("/api/crm/assignments", {
      data: {
        doctor_ids: Array.from({ length: 101 }, () => crypto.randomUUID()),
        executive_id: users.rajesh.crmId,
      },
    });
    expect(tooMany.status()).toBe(400);
    const ceo = await one(`SELECT id FROM crm.users WHERE full_name = 'Sandeep'`);
    const notStaff = await api.post("/api/crm/assignments", {
      data: { doctor_ids: ids, executive_id: ceo.id },
    });
    expect((await notStaff.json()).error).toBe("That staff member cannot be assigned doctors");
  });

  test("5. export follows the filter and re-imports as a template", async () => {
    const res = await api.get(`/api/crm/assignments/export.xlsx?owner=${users.virender.crmId}`);
    expect(res.status()).toBe(200);
    const { headers, rows } = await readXlsx(await res.body());
    expect(headers.slice(0, 7)).toEqual([
      "Doctor ID",
      "Full name",
      "Specialty",
      "Mobile",
      "Area",
      "Territory",
      "Assigned to",
    ]);
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r["Assigned to"] === "Virender Satija")).toBe(true);
  });

  test("6. managers and executives are refused", async () => {
    for (const who of ["manager", "rajesh"]) {
      const other = await crmApi(users[who]);
      expect((await other.get("/api/crm/assignments")).status(), who).toBe(403);
      const post = await other.post("/api/crm/assignments", {
        data: { doctor_ids: [doctors[0].id], executive_id: users.rajesh.crmId },
      });
      expect(post.status(), who).toBe(403);
    }
  });

  test("7. in the browser: tab, row change, bulk change with confirmation", async ({ page }) => {
    await loginCrm(page, api);
    await gotoReady(page, "/crm/home", () => page.getByRole("button", { name: "Assignments" }));
    await page.getByRole("button", { name: "Assignments" }).click();
    const region = page.getByRole("region", { name: "Doctor assignments" });
    await expect(region.getByRole("button", { name: /^Unassigned \d+$/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await region.getByRole("searchbox").fill("Dr Asg Free 30");
    const owner = region.getByRole("combobox", { name: "Owner of Dr Asg Free 30" });
    await owner.selectOption({ label: "Rajesh Sharma" });
    await expect(region.getByRole("status")).toContainText(
      "1 doctor now assigned to Rajesh Sharma",
    );
    expect(await openOwner(doctors[32].id)).toBe("Rajesh Sharma");

    await region.getByRole("searchbox").fill("Dr Asg Free 4");
    await expect(region.getByText(/^\d+ doctors?$/)).toHaveText("10 doctors");
    await region.getByRole("checkbox", { name: "Select this page" }).check();
    await region.getByRole("combobox", { name: "Assign selected to" }).selectOption({
      label: "Sandeep Sangroy",
    });
    await region.getByRole("button", { name: "Apply" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Assign 10 doctors to Sandeep Sangroy?");
    await dialog.getByRole("button", { name: "Assign" }).click();
    await expect(region.getByRole("status")).toContainText(
      "10 doctors now assigned to Sandeep Sangroy",
    );
    expect(await openOwner(doctors[42].id)).toBe("Sandeep Sangroy");
  });

  test("8. growth executives do not see the tab", async ({ page }) => {
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, "/crm/home", () => page.getByRole("button", { name: "My doctors" }));
    await expect(page.getByRole("button", { name: "Assignments" })).toHaveCount(0);
  });
});
