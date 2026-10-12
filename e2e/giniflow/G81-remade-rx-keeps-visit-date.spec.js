import { test, expect } from "@playwright/test";

const { buildPrescriptionHtml } = await import("../../server/templates/prescriptionTemplate.js");

const longDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

const html = (extra) =>
  buildPrescriptionHtml({
    patient: { name: "Remade Rx", file_no: "F-RX" },
    doctor: { name: "Dr Remade" },
    summary: { totalVisits: 2 },
    ...extra,
  });

test.describe("G81 a remade prescription keeps the visit's date", () => {
  test("1. a prescription remade later prints the visit date, never the day it was remade", () => {
    const page = html({ rxDate: "2026-09-03" });
    expect(page.match(/3 September 2026/g)).toHaveLength(2);
    expect(page).not.toContain(longDate(new Date().toISOString().slice(0, 10)));
  });

  test("2. a prescription written today still prints today", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(html({}).match(new RegExp(longDate(today), "g"))).toHaveLength(2);
  });
});
