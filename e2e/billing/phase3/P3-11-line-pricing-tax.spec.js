import { test, expect } from "@playwright/test";
import { paise } from "../../../shared/labPayment.js";

const { lineTax } = await import("../../../server/services/billing/lineTax.js");

const code = (rate_pct, extra = {}) => ({
  id: 7,
  code: `GST${rate_pct}`,
  sac_hsn: "999312",
  rate_pct,
  ...extra,
});
const on = (net, rate, extra = {}) =>
  lineTax({ net, taxCode: rate === null ? null : code(rate), gstEnabled: true, ...extra });
const failure = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};
const untaxed = (net) => ({
  tax_code_id: null,
  tax_code: null,
  sac_hsn: null,
  tax_rate: 0,
  taxable: net,
  cgst: 0,
  sgst: 0,
  tax: 0,
  total: net,
});

test.describe("P3-11 line pricing: tax", () => {
  test("GST off gives no tax code, 0% and 0 tax, even for a taxed item", () => {
    const net = paise(1000);
    expect(lineTax({ net, taxCode: code(18), gstEnabled: false })).toEqual(untaxed(net));
    expect(lineTax({ net, taxCode: code(18), gstEnabled: false, priceIncludesTax: true })).toEqual(
      untaxed(net),
    );
    expect(lineTax({ net, taxCode: null, gstEnabled: false })).toEqual(untaxed(net));
    expect(lineTax({ net })).toEqual(untaxed(net));
  });

  test("GST on at 18% gives 9% CGST + 9% SGST on ₹1,000", () => {
    expect(on(paise(1000), 18)).toEqual({
      tax_code_id: 7,
      tax_code: "GST18",
      sac_hsn: "999312",
      tax_rate: 18,
      taxable: 100000,
      cgst: 9000,
      sgst: 9000,
      tax: 18000,
      total: 118000,
    });
  });

  test("5% and 12% split into equal halves", () => {
    expect(on(paise(1000), 5)).toMatchObject({ cgst: 2500, sgst: 2500, tax: 5000, total: 105000 });
    expect(on(paise(1000), 12)).toMatchObject({
      cgst: 6000,
      sgst: 6000,
      tax: 12000,
      total: 112000,
    });
    expect(on(paise(1000), 2.5)).toMatchObject({ cgst: 1250, sgst: 1250, total: 102500 });
  });

  test("odd paise round each half to the paisa", () => {
    expect(on(paise(99.99), 18)).toMatchObject({
      taxable: 9999,
      cgst: 900,
      sgst: 900,
      tax: 1800,
      total: 11799,
    });
    expect(on(paise(99.99), 5)).toMatchObject({ cgst: 250, sgst: 250, total: 10499 });
    expect(on(1, 18)).toMatchObject({ cgst: 0, sgst: 0, tax: 0, total: 1 });
    expect(on(3, 18)).toMatchObject({ cgst: 0, sgst: 0, total: 3 });
    expect(on(6, 18)).toMatchObject({ cgst: 1, sgst: 1, total: 8 });
  });

  test("a rate stored as NUMERIC text works the same", () => {
    expect(lineTax({ net: paise(1000), taxCode: code("18.00"), gstEnabled: true })).toMatchObject({
      tax_rate: 18,
      cgst: 9000,
      sgst: 9000,
      total: 118000,
    });
  });

  test("inclusive price back-calculates the taxable amount", () => {
    expect(on(paise(1180), 18, { priceIncludesTax: true })).toMatchObject({
      tax_rate: 18,
      taxable: 100000,
      cgst: 9000,
      sgst: 9000,
      tax: 18000,
      total: 118000,
    });
  });

  test("inclusive odd tax keeps CGST equal to SGST and moves the paisa into taxable", () => {
    expect(on(paise(100), 18, { priceIncludesTax: true })).toMatchObject({
      taxable: 8474,
      cgst: 763,
      sgst: 763,
      tax: 1526,
      total: 10000,
    });
    expect(on(paise(100), 5, { priceIncludesTax: true })).toMatchObject({
      taxable: 9524,
      cgst: 238,
      sgst: 238,
      total: 10000,
    });
  });

  test("inclusive halves stay within a paisa of the rate on the taxable amount", () => {
    const off = [];
    for (const rate of [0.25, 2.5, 5, 12, 18, 28]) {
      for (let net = 0; net <= 5000; net += 1) {
        const line = on(net, rate, { priceIncludesTax: true });
        const exact = (line.taxable * rate) / 200;
        if (Math.abs(line.cgst - exact) > 1 || line.cgst !== line.sgst || line.total !== net) {
          off.push(`${net} at ${rate}%`);
        }
      }
    }
    expect(off).toEqual([]);
  });

  test("the largest line is taxed exactly, and a total too large for a bill line is refused", () => {
    const most = 999999999999;
    expect(on(847457627117, 18)).toMatchObject({
      cgst: 76271186441,
      tax: 152542372882,
      total: most,
    });
    expect(on(most, 18, { priceIncludesTax: true })).toMatchObject({
      taxable: 847457627117,
      cgst: 76271186441,
      sgst: 76271186441,
      total: most,
    });
    expect(on(999999998360, 0.03, { priceIncludesTax: true })).toMatchObject({
      taxable: 999700088334,
      cgst: 149955013,
      sgst: 149955013,
      total: 999999998360,
    });
    expect(on(999999998381, 90.23, { priceIncludesTax: true })).toMatchObject({
      taxable: 525679439827,
      cgst: 237160279277,
      sgst: 237160279277,
    });
    for (const [net, includes] of [
      [847457627118, false],
      [most, false],
      [most + 1, true],
      [Number.MAX_SAFE_INTEGER, false],
      [Number.MAX_SAFE_INTEGER, true],
    ]) {
      expect(failure(() => on(net, 18, { priceIncludesTax: includes }))?.status, String(net)).toBe(
        400,
      );
    }
    expect(failure(() => lineTax({ net: most + 1 }))?.status).toBe(400);
  });

  test("a missing, blank, true/false or over-precise rate is refused, not read as 0% or 1%", () => {
    for (const rate of [undefined, "", "  ", true, false, [], {}, 0.125, "18.005"]) {
      expect(failure(() => on(10000, rate))?.status, JSON.stringify(rate)).toBe(400);
    }
    expect(failure(() => lineTax({ net: 10000, taxCode: 5, gstEnabled: true }))?.status).toBe(400);
    expect(on(10000, "0.29")).toMatchObject({ tax_rate: 0.29, cgst: 15, sgst: 15 });
    expect(on(10000, "18.000")).toMatchObject({ tax_rate: 18, cgst: 900 });
  });

  test("the GST switch and the inclusive flag must be real true/false", () => {
    for (const flag of ["false", "true", 0, 1, null]) {
      expect(
        failure(() => lineTax({ net: 10000, taxCode: code(18), gstEnabled: flag }))?.status,
        `gst ${JSON.stringify(flag)}`,
      ).toBe(400);
      expect(
        failure(() => on(10000, 18, { priceIncludesTax: flag }))?.status,
        `incl ${JSON.stringify(flag)}`,
      ).toBe(400);
    }
  });

  test("GST on with no tax code is untaxed", () => {
    expect(on(paise(1000), null)).toEqual(untaxed(100000));
    expect(on(paise(1000), null, { priceIncludesTax: true })).toEqual(untaxed(100000));
  });

  test("an admin-made 0% code is recorded with 0 tax", () => {
    expect(on(paise(1000), 0)).toEqual({
      tax_code_id: 7,
      tax_code: "GST0",
      sac_hsn: "999312",
      tax_rate: 0,
      taxable: 100000,
      cgst: 0,
      sgst: 0,
      tax: 0,
      total: 100000,
    });
    expect(on(paise(1000), 0, { priceIncludesTax: true })).toMatchObject({
      taxable: 100000,
      tax: 0,
      total: 100000,
    });
  });

  test("zero net gives zero tax", () => {
    expect(on(0, 18)).toMatchObject({ taxable: 0, cgst: 0, sgst: 0, tax: 0, total: 0 });
    expect(on(0, 18, { priceIncludesTax: true })).toMatchObject({ taxable: 0, tax: 0, total: 0 });
  });

  test("taxable + tax = total and the halves add up in every case", () => {
    for (const rate of [0, 0.1, 2.5, 5, 12, 18, 28, 100]) {
      for (const net of [0, 1, 2, 3, 7, 99, 9999, 10000, 12345, 118000, 999999]) {
        for (const priceIncludesTax of [false, true]) {
          const line = on(net, rate, { priceIncludesTax });
          const label = `${net} at ${rate}% ${priceIncludesTax ? "incl" : "excl"}`;
          expect(line.taxable + line.tax, label).toBe(line.total);
          expect(line.cgst + line.sgst, label).toBe(line.tax);
          expect(line.cgst, label).toBe(line.sgst);
          for (const key of ["taxable", "cgst", "sgst", "tax", "total"]) {
            expect(Number.isInteger(line[key]), `${label} ${key}`).toBe(true);
            expect(line[key], `${label} ${key}`).toBeGreaterThanOrEqual(0);
          }
          if (priceIncludesTax) expect(line.total, label).toBe(net);
          else expect(line.taxable, label).toBe(net);
        }
      }
    }
  });

  test("bad input is refused", () => {
    for (const net of [-1, 1.5, "100", null, undefined, NaN]) {
      expect(failure(() => on(net, 18))?.status, String(net)).toBe(400);
    }
    for (const rate of [-1, 100.01, 150, "abc"]) {
      expect(failure(() => on(100, rate))?.status, String(rate)).toBe(400);
    }
    expect(failure(() => lineTax({ net: -1, gstEnabled: false }))?.status).toBe(400);
    expect(failure(() => on(100, 100))).toBeNull();
  });
});
