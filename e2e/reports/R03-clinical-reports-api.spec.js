import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { addVisit, clearClinical, newTag, seedClinical } from "./clinical-fixture.mjs";

const tag = newTag();
let seeded;
let admin;

const get = async (path, params) => {
  const res = await admin.get(path, { params });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};

test.describe.serial("R03 clinical reports API is small and paged", () => {
  test.beforeAll(async () => {
    admin = await apiAs("admin");
    seeded = await seedClinical(tag);
  });

  test.afterAll(async () => {
    await clearClinical(tag);
    await admin?.dispose();
  });

  test("1. the summary carries counts only, no patient lists", async () => {
    const res = await admin.get("/api/reports/today", {
      params: { period: "today", doctor: seeded.doctor },
    });
    const text = await res.text();
    const s = JSON.parse(text);
    expect(s.total).toBe(4);
    expect(s.by_doctor).toEqual({ [seeded.doctor]: 4 });
    expect(s).not.toHaveProperty("patients");
    const hba1c = s.biomarkers.find((b) => b.key === "hba1c");
    expect(hba1c).toMatchObject({
      in_control: 1,
      warning: 1,
      out_control: 1,
      no_data: 1,
      tested: 3,
      total: 4,
      pct: 33,
    });
    expect(hba1c).not.toHaveProperty("patients");
    expect(s.biomarkers.find((b) => b.key === "weight")).toMatchObject({ in_control: 1 });
    expect(text.length).toBeLessThan(5000);
  });

  test("2. a biomarker's patients come worst first, paged, filtered and searchable", async () => {
    const path = "/api/reports/today/biomarker/hba1c";
    const scope = { period: "today", doctor: seeded.doctor };
    const all = await get(path, scope);
    expect(all.total).toBe(3);
    expect(all.data.map((p) => p.status)).toEqual(["out_control", "warning", "in_control"]);
    expect(all.data.map((p) => p.id)).toEqual([seeded.p3, seeded.p2, seeded.p1]);
    expect(all.data[0]).toMatchObject({ display: "9 %", name: `R03 P3 ${tag}` });
    expect((await get(path, { ...scope, status: "out_control" })).total).toBe(1);
    expect((await get(path, { ...scope, status: "no_data" })).data[0].id).toBe(seeded.p4);
    const second = await get(path, { ...scope, limit: 1, page: 2 });
    expect(second).toMatchObject({ total: 3, totalPages: 3, limit: 1 });
    expect(second.data[0].id).toBe(seeded.p2);
    expect((await get(path, { ...scope, q: `R03-${tag}-p1` })).total).toBe(1);
    expect((await get(path, { ...scope, limit: 5000 })).limit).toBe(100);
  });

  test("3. the scorecard is sorted by targets met, paged, with diagnoses on its rows", async () => {
    const scope = { period: "today", doctor: seeded.doctor };
    const card = await get("/api/reports/today/scorecard", scope);
    expect(card.total).toBe(4);
    expect(card.data.map((p) => p.id)).toEqual([seeded.p2, seeded.p3, seeded.p1, seeded.p4]);
    const p1 = card.data.find((p) => p.id === seeded.p1);
    expect(p1).toMatchObject({ targets_met: 3, targets_total: 4, pct: 75 });
    expect(p1.diagnoses.map((d) => d.id)).toEqual(["type_2_diabetes_mellitus"]);
    expect(p1.conditions.hba1c).toMatchObject({ val: 6.5, in_control: true });
    const paged = await get("/api/reports/today/scorecard", { ...scope, limit: 2, page: 2 });
    expect(paged.data.map((p) => p.id)).toEqual([seeded.p1, seeded.p4]);
    expect((await get("/api/reports/today/scorecard", { ...scope, q: "P3" })).total).toBe(1);
  });

  test("4. diagnoses send only the top rows", async () => {
    const top = await get("/api/reports/diagnoses");
    expect(top.length).toBeLessThanOrEqual(12);
    expect((await get("/api/reports/diagnoses", { limit: 3 })).length).toBeLessThanOrEqual(3);
    const doctors = await get("/api/reports/doctors");
    expect(Array.isArray(doctors)).toBe(true);
  });

  test("5. bad input is refused and other roles are kept out", async () => {
    for (const [path, params] of [
      ["/api/reports/today", { period: "decade" }],
      ["/api/reports/today/biomarker/hba1c", { status: "purple" }],
      ["/api/reports/today/scorecard", { page: "0" }],
      ["/api/reports/today/scorecard", { sort: "x" }],
    ]) {
      const res = await admin.get(path, { params });
      expect(res.status(), `${path} ${JSON.stringify(params)}`).toBe(400);
    }
    expect((await admin.get("/api/reports/today/biomarker/nonsense")).status()).toBe(404);
    const reception = await apiAs("reception");
    try {
      for (const path of ["/api/reports/today", "/api/reports/today/scorecard"]) {
        expect((await reception.get(path)).status(), path).toBe(403);
      }
    } finally {
      await reception.dispose();
    }
  });

  test("6. results are reused for a few minutes; Refresh rebuilds them", async () => {
    const scope = { period: "today", doctor: seeded.doctor };
    const before = await get("/api/reports/today", scope);
    const extra = (
      await (
        await import("../helpers/db.mjs")
      ).one(`INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`, [
        `R03 P5 ${tag}`,
        `R03-${tag}-p5`,
      ])
    ).id;
    await addVisit(extra, seeded.doctor);
    expect((await get("/api/reports/today", scope)).total).toBe(before.total);
    expect((await get("/api/reports/today", { ...scope, refresh: "1" })).total).toBe(
      before.total + 1,
    );
    expect((await get("/api/reports/today/scorecard", scope)).total).toBe(before.total + 1);
  });
});
