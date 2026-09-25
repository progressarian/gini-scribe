import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { newTag, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  mountClaims,
  pensionerBill,
  queryString,
  referralBill,
  setUpClaims,
} from "./p5-claims.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const tag = newTag();
let ids;
let api;

const scope = (extra = {}) => queryString({ payer: `CGHS ${tag}`, ...extra });

async function sheetsOf(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return Object.fromEntries(
    workbook.worksheets.map((ws) => {
      const rows = [];
      ws.eachRow((row) => rows.push(row.values.slice(1)));
      return [ws.name, rows];
    }),
  );
}

const asObjects = ([header, ...rows]) =>
  rows.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? null])));

async function download(tab, extra) {
  const res = await api.call("GET", `/${tab}/export${scope(extra)}`);
  expect(res.status, String(res.body)).toBe(200);
  expect(res.headers.get("content-type")).toContain("spreadsheetml");
  expect(res.headers.get("content-disposition")).toMatch(
    new RegExp(`attachment; filename="cghs-${tab}-\\d{4}-\\d{2}-\\d{2}\\.xlsx"`),
  );
  return { res, sheets: await sheetsOf(res.body) };
}

test.describe.serial("P5-04 register export", () => {
  test.beforeAll(async () => {
    test.setTimeout(120000);
    ids = await setUpClaims(tag);
    api = await mountClaims();
    ids.pens = (await pensionerBill(ids, "ExpA")).bill;
    ids.pens2 = (await pensionerBill(ids, "ExpB")).bill;
    ids.refr = (await referralBill(ids, "ExpC")).bill;
  });

  test.afterAll(async () => {
    await api?.close();
    await tearDown(ids);
  });

  test("1. the Pending file has one row per pending bill and the same total as the screen", async () => {
    const screen = (await api.call("GET", `/pending${scope()}`)).body;
    expect(screen.totals).toEqual({ count: 3, amount: 175000 });
    const { res, sheets } = await download("pending");
    expect(Number(res.headers.get("x-claims-amount"))).toBe(screen.totals.amount);
    const [header, ...body] = sheets["Pending claims"];
    expect(header).toEqual([
      "Bill number",
      "Bill date",
      "Patient",
      "UHID",
      "Sub-category",
      "Doctor",
      "Bill codes",
      "Referral number",
      "Payer",
      "Claim (₹)",
      "Days pending",
    ]);
    const total = body.at(-1);
    const rows = asObjects([header, ...body.slice(0, -1)]);
    expect(rows.map((r) => r["Bill number"]).sort()).toEqual(
      screen.rows.map((r) => r.bill_no).sort(),
    );
    expect(total[0]).toBe("Total");
    expect(total[2]).toBe("3 bills");
    expect(Math.round(total[9] * 100)).toBe(screen.totals.amount);
    expect(Math.round(rows.reduce((sum, r) => sum + r["Claim (₹)"], 0) * 100)).toBe(
      screen.totals.amount,
    );
    const refr = rows.find((r) => r["Bill number"] === ids.refr.bill_no);
    expect(refr).toMatchObject({
      Patient: `P4 ExpC ${tag}`,
      "Sub-category": `P4 CGHS ${tag} › Referral`,
      Doctor: CONSULTANTS.rahul.name,
      "Bill codes": "CC01",
      "Referral number": "XXXX5678",
      "Claim (₹)": 350,
      "Days pending": 0,
    });
  });

  test("2. filters apply to the file exactly as to the screen, with subtotals by sub-category and doctor", async () => {
    const filter = { doctor_id: CONSULTANTS.banshali.id };
    const screen = (await api.call("GET", `/pending${scope(filter)}`)).body;
    const { sheets } = await download("pending", filter);
    const body = sheets["Pending claims"].slice(1);
    expect(body).toHaveLength(screen.rows.length + 1);
    expect(Math.round(body.at(-1)[9] * 100)).toBe(screen.totals.amount);

    const all = (await download("pending")).sheets["By sub-category and doctor"];
    expect(all[0]).toEqual(["Sub-category", "Doctor", "Bills", "Claim (₹)"]);
    const subtotals = all.filter((row) => String(row[0]).endsWith("— subtotal"));
    expect(subtotals.map((row) => [row[0], row[2], row[3]])).toEqual([
      [`P4 CGHS ${tag} › Pensioner — subtotal`, 2, 1400],
      [`P4 CGHS ${tag} › Referral — subtotal`, 1, 350],
    ]);
    const doctorRows = all.filter((row) => row[1]);
    expect(doctorRows.slice(1).map((row) => [row[1], row[2], row[3]])).toEqual([
      [CONSULTANTS.banshali.name, 2, 1400],
      [CONSULTANTS.rahul.name, 1, 350],
    ]);
  });

  test("3. the Cleared file shows the reference and date for each cleared bill", async () => {
    const clear = (billList, reference, amount) =>
      api.call("POST", "/clear", {
        body: {
          bill_ids: billList.map((b) => b.id),
          received_on: ids.day,
          reference,
          amount,
        },
      });
    expect((await clear([ids.pens, ids.refr], `UTR-${tag}-A`, 1050)).status).toBe(201);
    expect((await clear([ids.pens2], `UTR-${tag}-B`, 700)).status).toBe(201);
    const screen = (await api.call("GET", `/cleared${scope()}`)).body;
    expect(screen.totals).toEqual({ count: 3, amount: 175000 });
    const { res, sheets } = await download("cleared");
    expect(Number(res.headers.get("x-claims-count"))).toBe(3);
    const [header, ...body] = sheets["Cleared claims"];
    expect(header.slice(-4)).toEqual(["Days to clear", "Date received", "Reference", "Cleared by"]);
    const rows = asObjects([header, ...body.slice(0, -1)]);
    const reference = Object.fromEntries(rows.map((r) => [r["Bill number"], r.Reference]));
    expect(reference).toEqual({
      [ids.pens.bill_no]: `UTR-${tag}-A`,
      [ids.refr.bill_no]: `UTR-${tag}-A`,
      [ids.pens2.bill_no]: `UTR-${tag}-B`,
    });
    for (const row of rows) {
      expect(row["Date received"]).toBe(ids.day);
      expect(row["Cleared by"]).toBe(USERS.reception_admin.name);
    }
    expect(Math.round(body.at(-1)[9] * 100)).toBe(screen.totals.amount);
    expect(sheets["By sub-category and doctor"]).toBeUndefined();

    const one = await download("cleared", { reference: `${tag}-b` });
    expect(one.sheets["Cleared claims"].slice(1, -1).map((r) => r[0])).toEqual([ids.pens2.bill_no]);
    const pending = await download("pending");
    expect(pending.sheets["Pending claims"]).toHaveLength(2);
    expect(pending.sheets["Pending claims"][1][2]).toBe("0 bills");
  });

  test("4. export needs the claims permission", async () => {
    const res = await api.call("GET", `/pending/export${scope()}`, { as: "reception" });
    expect(res.status).toBe(403);
  });
});
