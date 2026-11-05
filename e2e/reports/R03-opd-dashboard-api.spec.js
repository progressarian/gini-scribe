import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { PATIENTS } from "../fixtures/data.mjs";
import { one, query } from "../helpers/db.mjs";
import { newTag, today } from "./opd-fixture.mjs";

const MONTH = "2021-03";
const FROM = `${MONTH}-01`;
const TO = `${MONTH}-31`;
const tag = newTag();
const NOTE = `opd-dashboard-${tag}`;
const docA = `Dr. Dash A ${tag}`;
const docB = `Dr. Dash B ${tag}`;
let admin;
let now;
let weekAgo;
let blocked;

const addDays = (day, count) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);

async function book(patient, doctor, day, visitType, status, timeSlot = null) {
  await query(
    `INSERT INTO appointments (patient_id, patient_name, file_no, phone, doctor_name,
                               appointment_date, time_slot, visit_type, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      patient.id,
      patient.name,
      patient.file_no,
      patient.phone ?? null,
      doctor,
      day,
      timeSlot,
      visitType,
      status,
      NOTE,
    ],
  );
}

const queryString = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of [value].flat()) search.append(key, item);
  }
  return search.toString();
};

const get = async (path, params) => {
  const res = await admin.get(`/api/reports/opd/${path}?${queryString(params)}`);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};

const dashboard = (params) => get("dashboard", params);
const visits = (params) => get("visits", params);

test.describe.serial("R03 OPD dashboard API", () => {
  test.beforeAll(async () => {
    admin = await apiAs("admin");
    now = await today();
    weekAgo = addDays(now, -7);
    blocked = await one(
      `INSERT INTO patients (name, file_no, is_blocked) VALUES ($1, $2, TRUE) RETURNING id, name, file_no`,
      [`E2E Blocked ${tag}`, `E2E-BLK-${tag}`],
    );
    const p = PATIENTS;
    await book(p.general, docA, `${MONTH}-02`, "New Patient", "completed", "09:30");
    await book(p.senior, docA, `${MONTH}-02`, "Follow-Up", "completed", "02:15 PM");
    await book(p.cghsPaid, docA, `${MONTH}-03`, "Follow-Up", "checkedin", "10:00");
    await book(p.cghsReferral, docA, `${MONTH}-03`, "OPD", "completed", "10:30 AM");
    await book(p.pensioner, docA, `${MONTH}-04`, "Tele", "completed", "15:00");
    await book(p.senior, docA, `${MONTH}-05`, "Follow-Up", "no_show");
    await book(p.cghsPaid, docA, `${MONTH}-05`, "Follow-Up", "cancelled");
    await book(p.general, docA, `${MONTH}-06`, "Follow-Up", "cancelled");
    await book(p.general, docA, `${MONTH}-06`, "Follow-Up", "completed", "11:00");
    await book(p.pensioner, docA, `${MONTH}-08`, "Follow-Up", "scheduled");
    await book(
      { id: null, name: `TEST Slot ${tag}`, file_no: `TESTSLOT-${tag}` },
      docA,
      `${MONTH}-08`,
      "Follow-Up",
      "completed",
      "12:00",
    );
    await book(blocked, docA, `${MONTH}-09`, "Follow-Up", "completed", "12:00");
    await book(p.general, docB, `${MONTH}-09`, "Follow-Up", "completed", "16:00");
    await book(p.senior, docA, "2021-02-10", "Follow-Up", "completed", "09:00");
    await book(p.general, docA, now, "Follow-Up", "scheduled", "10:00");
    await book(p.senior, docA, now, "Follow-Up", "checkedin", "10:15");
    await book(p.cghsPaid, docA, weekAgo, "Follow-Up", "completed", "11:00");
  });

  test.afterAll(async () => {
    await query(`DELETE FROM appointments WHERE notes = $1`, [NOTE]);
    if (blocked) await query(`DELETE FROM patients WHERE id = $1`, [blocked.id]);
    await admin?.dispose();
  });

  test("1. each appointment lands in exactly one state; rebooked, blocked and test rows count nowhere", async () => {
    const d = await dashboard({ from: FROM, to: TO, doctor: docA });
    expect(d.totals).toEqual({
      booked: 8,
      came: 5,
      completed: 4,
      inProgress: 0,
      notClosed: 1,
      pending: 0,
      notUpdated: 1,
      noShow: 1,
      cancelled: 1,
      didNotCome: 2,
      uniquePatients: 4,
      repeatPatients: 1,
      new: 1,
      followUp: 3,
      noSlot: 0,
    });
    expect(d.group).toBe("day");
    expect(d.compare).toEqual({ from: "2021-02-01", to: "2021-02-28", kind: "previous" });
    expect(d.previous.came).toBe(1);
    expect(d.includesToday).toBe(false);
    const all = await dashboard({ from: FROM, to: TO, doctor: docA, type: "all" });
    expect(all.totals.came).toBe(6);
  });

  test("2. the dashboard agrees with Monthly summary for the same month", async () => {
    const m = await get("summary", { month: MONTH, doctor: docA });
    const d = await dashboard({ from: FROM, to: TO, doctor: docA });
    expect(m.totals.attended).toBe(d.totals.came);
    expect(m.totals.uniquePatients).toBe(d.totals.uniquePatients);
    expect(m.totals.noShow + m.totals.cancelled).toBe(d.totals.didNotCome);
    expect(m.totals.notUpdated).toBe(d.totals.notUpdated);
    const listed = await visits({ month: MONTH, doctor: docA, status: "all", type: "all" });
    expect(listed.data.some((v) => v.fileNo?.startsWith("TESTSLOT-"))).toBe(false);
    expect(listed.data.some((v) => v.patientName === blocked.name)).toBe(false);
  });

  test("3. week buckets start on Monday and add up to the totals", async () => {
    const d = await dashboard({ from: FROM, to: TO, doctor: docA, group: "week" });
    expect(d.trend[0]).toMatchObject({ bucket: "2021-03-01", start: "2021-03-01" });
    expect(d.trend.at(-1)).toMatchObject({
      bucket: "2021-03-29",
      end: "2021-03-31",
      partial: true,
    });
    const sum = (key) => d.trend.reduce((total, b) => total + b[key], 0);
    for (const key of ["came", "completed", "notClosed", "didNotCome", "notUpdated"]) {
      expect(sum(key), key).toBe(d.totals[key]);
    }
    const month = await dashboard({ from: "2021-01-01", to: TO, doctor: docA, group: "month" });
    expect(month.trend.map((b) => b.bucket)).toEqual(["2021-01-01", "2021-02-01", "2021-03-01"]);
    expect(month.trend.map((b) => b.came)).toEqual([0, 1, 5]);
  });

  test("4. types always show every bucket; consultants and the heatmap follow the filters", async () => {
    const d = await dashboard({ from: FROM, to: TO, doctor: [docA, docB] });
    const tele = d.types.find((t) => t.key === "tele");
    expect(tele).toMatchObject({ came: 1, selected: false });
    expect(d.types.find((t) => t.key === "follow_up")).toMatchObject({ came: 4, selected: true });
    expect(d.consultants.shown.map((c) => c.doctor)).toEqual([docA, docB]);
    expect(d.consultants.shown[0]).toMatchObject({ came: 5, didNotCome: 2 });
    expect(d.consultants.others).toBeNull();
    const cell = (weekday, hour) =>
      d.heatmap.find((c) => c.weekday === weekday && c.hour === hour)?.came ?? 0;
    expect(cell(2, 9)).toBe(1);
    expect(cell(2, 14)).toBe(1);
    expect(cell(3, 10)).toBe(2);
    expect(cell(2, 16)).toBe(1);
    expect(cell(6, 11)).toBe(1);
    expect(d.heatmap.reduce((s, c) => s + c.came, 0)).toBe(d.totals.came);
  });

  test("5. today compares with the same weekday last week and is marked as still open", async () => {
    const d = await dashboard({ from: now, to: now, doctor: docA });
    expect(d.compare).toEqual({ from: weekAgo, to: weekAgo, kind: "same_weekday" });
    expect(d.dayOpen).toBe(true);
    expect(d.totals).toMatchObject({ booked: 2, came: 1, inProgress: 1, pending: 1, notClosed: 0 });
    expect(d.previous.came).toBe(1);
  });

  test("6. every figure lists exactly its visits", async () => {
    const base = { from: FROM, to: TO, doctor: docA };
    const d = await dashboard(base);
    for (const [state, expected] of [
      ["came", d.totals.came],
      ["completed", d.totals.completed],
      ["not_closed", d.totals.notClosed],
      ["did_not_come", d.totals.didNotCome],
      ["not_updated", d.totals.notUpdated],
      ["booked", d.totals.booked],
    ]) {
      expect((await visits({ ...base, state })).total, state).toBe(expected);
    }
    expect((await visits({ ...base, state: "came", weekday: "3", hour: "10" })).total).toBe(2);
    const week = await visits({
      ...base,
      state: "came",
      group: "week",
      bucket_start: "2021-03-01",
    });
    expect(week.total).toBe(5);
    const both = await visits({ ...base, doctor: [docA, docB], state: "came" });
    expect(both.total).toBe(6);
    const today = await visits({ from: now, to: now, doctor: docA, state: "in_progress" });
    expect(today.total).toBe(1);
    expect((await visits({ from: now, to: now, doctor: docA, state: "pending" })).total).toBe(1);
  });

  test("6b. more than 20 consultants are accepted, however the browser sends them", async () => {
    const many = [docA, ...Array.from({ length: 24 }, (_, i) => `Dr. None ${i}`)];
    const plain = await dashboard({ from: FROM, to: TO, doctor: many });
    expect(plain.totals.came).toBe(5);
    const bracket = many.map((d) => `doctor[]=${encodeURIComponent(d)}`).join("&");
    const res = await admin.get(`/api/reports/opd/dashboard?from=${FROM}&to=${TO}&${bracket}`);
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).totals.came).toBe(5);
    const tooMany = Array.from({ length: 51 }, (_, i) => `D${i}`);
    const refused = await admin.get(
      `/api/reports/opd/dashboard?${queryString({ doctor: tooMany })}`,
    );
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toContain("at most 50");
  });

  test("6c. the earlier-period line leaves out part periods", async () => {
    const d = await dashboard({
      from: "2021-03-03",
      to: "2021-03-31",
      doctor: docA,
      group: "week",
    });
    expect(d.trend.every((b) => b.previousCame === null || Number.isInteger(b.previousCame))).toBe(
      true,
    );
    expect(d.trend[0].previousCame).toBeNull();
  });

  test("6d. numbers are cached briefly, and Refresh's fresh=1 skips the cache", async () => {
    const from = "2021-04-01";
    const to = "2021-04-30";
    const first = await dashboard({ from, to, doctor: docA });
    await book(PATIENTS.general, docA, "2021-04-05", "Follow-Up", "completed", "09:30");
    const cached = await dashboard({ from, to, doctor: docA });
    expect(cached.totals.came).toBe(first.totals.came);
    const fresh = await dashboard({ from, to, doctor: docA, fresh: "1" });
    expect(fresh.totals.came).toBe(first.totals.came + 1);
    const after = await dashboard({ from, to, doctor: docA });
    expect(after.totals.came).toBe(first.totals.came + 1);
  });

  test("7. bad filters are refused with a readable message", async () => {
    for (const [path, params, field] of [
      ["dashboard", { to: "2999-01-01" }, "To"],
      ["dashboard", { from: "2021-03-31", to: "2021-03-01" }, "From"],
      ["dashboard", { from: "2020-01-01", to: "2021-03-31" }, "To"],
      ["dashboard", { from: "2021-01-01", to: "2021-06-30", group: "day" }, "Group by"],
      ["dashboard", { group: "year" }, "Group by"],
      ["dashboard", { type: "vip" }, "Visit type"],
      ["visits", { from: FROM }, "To"],
      ["visits", { from: FROM, to: TO, state: "gone" }, "Status"],
      ["visits", { from: FROM, to: TO, hour: "24" }, "Hour"],
      ["visits", { from: FROM, to: TO, group: "week" }, "Period start"],
    ]) {
      const res = await admin.get(`/api/reports/opd/${path}`, { params });
      expect(res.status(), JSON.stringify(params)).toBe(400);
      const body = await res.json();
      expect(body.error).toContain(field);
      expect(body.error).not.toMatch(/select|syntax|relation/i);
    }
  });

  test("8. the doctor list covers a date range, and reception can't see the dashboard", async () => {
    const f = await get("filters", { from: FROM, to: TO });
    const names = f.doctors.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining([docA, docB]));
    const reception = await apiAs("reception");
    try {
      const res = await reception.get("/api/reports/opd/dashboard");
      expect(res.status()).toBe(403);
    } finally {
      await reception.dispose();
    }
  });
});
