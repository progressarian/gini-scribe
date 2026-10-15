import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { apiAs } from "../helpers/auth.mjs";
import { PATIENTS } from "../fixtures/data.mjs";
import { query } from "../helpers/db.mjs";
import { MONTH, PREVIOUS, clear, newTag, seed } from "./opd-fixture.mjs";

const tag = newTag();
let plan;
let admin;
let baseline;

const summary = async (params) => {
  const res = await admin.get("/api/reports/opd/summary", { params });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};

const visits = async (params) => {
  const res = await admin.get("/api/reports/opd/visits", { params });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};

const sum = (rows, key) => rows.reduce((total, r) => total + r[key], 0);

test.describe.serial("R01 OPD monthly summary API", () => {
  test.beforeAll(async () => {
    admin = await apiAs("admin");
    baseline = await summary({ month: MONTH, type: "all" });
    plan = await seed(tag);
  });

  test.afterAll(async () => {
    await clear(tag);
    await admin?.dispose();
  });

  test("1. totals for one doctor match the hand count, and buckets add up", async () => {
    const s = await summary({ month: MONTH, doctor: plan.docA });
    expect(s.totals).toEqual({
      attended: 4,
      uniquePatients: 3,
      notClosed: 1,
      new: 1,
      followUp: 2,
      other: 1,
      tele: 1,
      labOnly: 1,
      noShow: 1,
      cancelled: 1,
      notUpdated: 1,
      booked: 0,
      repeatPatients: 1,
      repeatVisits: 1,
    });
    expect(s.totals.new + s.totals.followUp + s.totals.other).toBe(s.totals.attended);
    expect(s.from).toBe(`${MONTH}-01`);
    expect(s.to).toBe(`${MONTH}-30`);
    expect(s.isCurrentMonth).toBe(false);
    expect(s.previousMonth).toEqual({ month: PREVIOUS, attended: 2, uniquePatients: 2 });
  });

  test("2. Hospital Admin and Investigation visits count as lab-only, never as follow-up", async () => {
    const after = await summary({ month: MONTH, type: "all" });
    expect(after.totals.labOnly - baseline.totals.labOnly).toBe(2);
    expect(after.totals.followUp - baseline.totals.followUp).toBe(3);
    const all = await summary({ month: MONTH, doctor: plan.docA, type: "all" });
    expect(all.totals.attended).toBe(6);
    expect(all.totals.uniquePatients).toBe(5);
  });

  test("3. today's bookings count only as booked ahead; lead rows count nowhere", async () => {
    const current = await summary({ month: plan.now.slice(0, 7), doctor: plan.docA });
    expect(current.isCurrentMonth).toBe(true);
    expect(current.totals.booked).toBe(1);
    expect(current.totals.attended).toBe(0);
    expect(current.byDay.every((d) => d.day <= plan.now)).toBe(true);
    const list = await visits({ month: MONTH, doctor: plan.docA, type: "all", status: "all" });
    expect(list.total).toBe(9);
  });

  test("4. by-day and by-doctor rows add up to the totals", async () => {
    const s = await summary({ month: MONTH, doctor: plan.docA });
    for (const key of ["attended", "notClosed", "noShow", "tele", "labOnly"]) {
      expect(sum(s.byDay, key)).toBe(s.totals[key]);
      expect(sum(s.byDoctor, key)).toBe(s.totals[key]);
    }
    expect(s.byDay.map((d) => d.day)).toEqual([...s.byDay.map((d) => d.day)].sort());
    expect(s.byDoctor).toHaveLength(1);
    expect(s.byDoctor[0].doctor).toBe(plan.docA);
  });

  test("4b. patients who came more than once: count, extra visits and their list", async () => {
    const all = await summary({ month: MONTH, doctor: plan.docA, type: "all" });
    expect(all.totals).toMatchObject({ repeatPatients: 1, repeatVisits: 1 });
    const list = await visits({ month: MONTH, doctor: plan.docA, status: "repeat" });
    expect(list.total).toBe(2);
    expect(new Set(list.data.map((v) => v.patientId))).toEqual(new Set([PATIENTS.general.id]));
    const newOnly = await summary({ month: MONTH, doctor: plan.docA, type: "new" });
    expect(newOnly.totals).toMatchObject({ repeatPatients: 0, repeatVisits: 0 });
  });

  test("5. the doctor and visit type filters narrow totals and the list", async () => {
    const b = await summary({ month: MONTH, doctor: plan.docB });
    expect(b.totals.attended).toBe(1);
    const newOnly = await summary({ month: MONTH, doctor: plan.docA, type: "new" });
    expect(newOnly.totals.attended).toBe(1);
    const tele = await visits({ month: MONTH, doctor: plan.docA, type: "tele" });
    expect(tele.total).toBe(1);
    expect(tele.data[0]).toMatchObject({ bucket: "tele", bucketLabel: "Tele" });
    const filters = await (await admin.get("/api/reports/opd/filters", { params: { month: MONTH } })).json();
    const names = filters.doctors.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining([plan.docA, plan.docB]));
  });

  test("6. search, paging, sorting and the page-size cap all run on the server", async () => {
    const base = { month: MONTH, doctor: plan.docA, type: "all", status: "all" };
    expect((await visits({ ...base, q: "E2E Senior" })).total).toBe(2);
    expect((await visits({ ...base, q: "E2E_0003" })).total).toBe(2);
    expect((await visits({ ...base, q: "E2E-HID-9201" })).total).toBe(2);
    expect((await visits({ ...base, q: PATIENTS.pensioner.phone })).total).toBe(1);
    expect((await visits({ ...base, q: "100%_" })).total).toBe(0);

    const came = { month: MONTH, doctor: plan.docA, type: "all", limit: 2 };
    const one = await visits({ ...came, page: 1 });
    const two = await visits({ ...came, page: 2 });
    expect(one.total).toBe(6);
    expect(one.totalPages).toBe(3);
    expect(two.total).toBe(6);
    const ids = new Set(one.data.map((v) => v.id));
    expect(two.data.some((v) => ids.has(v.id))).toBe(false);
    expect((await visits({ ...came, page: 9 })).total).toBe(6);

    const asc = await visits({ ...came, limit: 10, sort: "patient_asc" });
    const names = asc.data.map((v) => v.patientName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    const latest = await visits({ ...came, limit: 10, sort: "date_desc" });
    expect(latest.data[0].day >= latest.data.at(-1).day).toBe(true);

    expect((await visits({ ...came, limit: 5000 })).limit).toBe(100);
    const day = await visits({ ...came, limit: 10, day: `${MONTH}-02` });
    expect(day.total).toBe(2);
  });

  test("7. bad input is refused with a readable message", async () => {
    for (const [params, field] of [
      [{ month: "2021-13" }, "Month"],
      [{ month: "2999-01" }, "Month"],
      [{ month: MONTH, sort: "drop table" }, "Sort"],
      [{ month: MONTH, page: "0" }, "Page"],
      [{ month: MONTH, day: "2021-07-01" }, "Day"],
      [{ month: MONTH, day: "2021-06-31" }, "Day"],
      [{ month: MONTH, extra: "1" }, ""],
    ]) {
      const res = await admin.get("/api/reports/opd/visits", { params });
      expect(res.status(), JSON.stringify(params)).toBe(400);
      const body = await res.json();
      expect(body.error).toContain(field);
      expect(body.error).not.toMatch(/select|syntax|relation/i);
    }
  });

  test("8. a role without the Monthly summary permission is refused", async () => {
    const reception = await apiAs("reception");
    try {
      for (const path of ["summary", "visits", "filters", "export.xlsx"]) {
        const res = await reception.get(`/api/reports/opd/${path}`, { params: { month: MONTH } });
        expect(res.status(), path).toBe(403);
      }
    } finally {
      await reception.dispose();
    }
  });

  test("9. the Excel file matches the summary and the visit list", async () => {
    const params = { month: MONTH, doctor: plan.docA, type: "all" };
    const res = await admin.get("/api/reports/opd/export.xlsx", { params });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toContain(`OPD-summary-${MONTH}.xlsx`);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await res.body());
    expect(book.worksheets.map((w) => w.name)).toEqual(["Summary", "By day", "By doctor", "Visits"]);
    const value = (label) => {
      let found;
      book.getWorksheet("Summary").eachRow((r) => {
        if (r.getCell(1).value === label) found = r.getCell(2).value;
      });
      return found;
    };
    const s = await summary(params);
    expect(value("Visits attended")).toBe(s.totals.attended);
    expect(value("Unique patients (each person counted once)")).toBe(s.totals.uniquePatients);
    expect(value("Patients who came more than once")).toBe(s.totals.repeatPatients);
    let dated = 0;
    book.getWorksheet("Visits").eachRow((r, n) => {
      if (n > 1 && /^\d{4}-\d{2}-\d{2}$/.test(String(r.getCell(1).value))) dated += 1;
    });
    expect(dated).toBe((await visits(params)).total);
  });

  test("10. odd HealthRay statuses, formatted phones and the Excel labels", async () => {
    const docC = `Dr. Gamma ${tag}`;
    for (const [status, phone] of [
      ["in-progress", "+91 98765-43210"],
      ["Completed", null],
    ]) {
      await query(
        `INSERT INTO appointments (patient_id, patient_name, file_no, phone, doctor_name,
                                   appointment_date, visit_type, status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, 'Follow-Up', $7, $8)`,
        [
          PATIENTS.general.id,
          PATIENTS.general.name,
          PATIENTS.general.file_no,
          phone,
          docC,
          `${MONTH}-10`,
          status,
          `opd-summary-${tag}`,
        ],
      );
    }
    const s = await summary({ month: MONTH, doctor: docC });
    expect(s.totals).toMatchObject({ attended: 2, notClosed: 1, notUpdated: 0 });
    const found = await visits({ month: MONTH, doctor: docC, q: "9876543210" });
    expect(found.total).toBe(1);
    expect((await visits({ month: MONTH, doctor: docC, q: "98765 43210" })).total).toBe(1);

    const labels = async (type) => {
      const res = await admin.get("/api/reports/opd/export.xlsx", {
        params: { month: MONTH, doctor: docC, type, day: `${MONTH}-10`, q: "E2E" },
      });
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(await res.body());
      const rows = [];
      book.getWorksheet("Summary").eachRow((r) => rows.push(String(r.getCell(1).value)));
      return rows;
    };
    const opd = await labels("opd");
    expect(opd).toContain("Tele (shown separately)");
    expect(opd).toContain("Visits sheet: day");
    expect(opd).toContain("Visits sheet: search");
    expect(await labels("all")).toContain("Tele (included above)");
  });
});
